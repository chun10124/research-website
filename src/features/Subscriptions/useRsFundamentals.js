/* src/features/Subscriptions/useRsFundamentals.js */

/**
 * RS 個股視窗「基本面」分頁：單檔的營收／財報／股價／法說／重訊，加上它在訂閱清單裡的項目（筆記、提醒）。
 *
 * 與訂閱頁的差別：
 * - 只抓目前這一檔；各資料抓到就先顯示，不互相等。
 * - 未訂閱的股票只在記憶體快取（本次開頁有效），抓完把該檔的 localStorage 快取清掉——
 *   RS 頁會翻很多檔，每檔股價＋法說＋重訊約數十 KB，全留在 localStorage 會撐爆配額，連帶讓訂閱頁的快取寫不進去。
 * - 寫入前一律重讀 subscriptions/main 再改，避免拿舊清單蓋掉訂閱頁剛存的變更。
 * - 不做「首次載入記為已確認」（item.base）——那由訂閱頁負責；這裡只顯示 base 已建立的來源的提醒，
 *   不會因為在 RS 頁先開而把剛訂閱就成立的條件誤報成提醒。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDoc, setDoc } from 'firebase/firestore';
import { SUBSCRIPTIONS_DOC_REF } from '../../utils/firebaseConfig';
import {
  loadRevenueBatch, loadFinancialsBatch, fetchQuote, fetchConferences, fetchNews,
  computeRevenueStats, computeAlerts, clearSubscriptionCache,
} from './subscriptionApi';
import { MAX_ITEMS, migrate, isDenied, writeLocal } from './subscriptionStore';

const SOURCES = ['rev', 'fin', 'price', 'conf', 'news'];
const ALL_LOADING = { rev: true, fin: true, quote: true, conf: true, news: true };
const sessionCache = new Map(); // 代號 → 已抓完的資料（未訂閱的股票只存這裡）

const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

export function useRsFundamentals(stock) {
  const id = stock?.id ?? null;
  const market = stock?.market ?? null;
  const name = stock?.name ?? '';

  /* ── 訂閱項目 ── */
  const [sub, setSub] = useState({ status: 'loading', item: null }); // loading | ready | denied | error
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const subRef = useRef(sub);
  subRef.current = sub;
  const pendingClearRef = useRef(null); // 資料抓完時訂閱清單還沒讀到 → 等讀到再決定要不要清 localStorage

  // 未訂閱（或讀不到清單）的股票不留 localStorage 快取
  const clearIfUnsubscribed = useCallback((sid) => {
    const cur = subRef.current;
    if (cur.status === 'loading') { pendingClearRef.current = sid; return; }
    if (!cur.item) clearSubscriptionCache(sid);
  }, []);
  useEffect(() => {
    if (sub.status === 'loading' || !pendingClearRef.current) return;
    const sid = pendingClearRef.current;
    pendingClearRef.current = null;
    if (sid === id && !sub.item) clearSubscriptionCache(sid);
  }, [sub, id]);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setSub({ status: 'loading', item: null });
    setErr(null);
    getDoc(SUBSCRIPTIONS_DOC_REF)
      .then((snap) => {
        if (cancelled) return;
        const items = (snap.exists() ? snap.data().items || [] : []).map(migrate);
        setSub({ status: 'ready', item: items.find((x) => x.id === id) || null });
      })
      .catch((e) => {
        if (!cancelled) setSub({ status: isDenied(e) ? 'denied' : 'error', item: null });
      });
    return () => { cancelled = true; };
  }, [id]);

  /** 重讀最新清單 → fn(清單) → 寫回。fn 回傳原陣列＝不需要寫。 */
  const mutate = useCallback(async (fn) => {
    if (!id) return;
    setBusy(true);
    setErr(null);
    try {
      const snap = await getDoc(SUBSCRIPTIONS_DOC_REF);
      const items = (snap.exists() ? snap.data().items || [] : []).map(migrate);
      const next = fn(items);
      if (next === items) return;
      await setDoc(SUBSCRIPTIONS_DOC_REF, { items: next, updatedAt: new Date().toISOString() });
      writeLocal(next); // 與訂閱頁一致：本機留一份
      setSub({ status: 'ready', item: next.find((x) => x.id === id) || null });
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [id]);

  const update = useCallback((patch) => mutate((items) => items.map((it) => (
    it.id === id ? { ...it, ...(typeof patch === 'function' ? patch(it) : patch) } : it
  ))), [id, mutate]);

  const subscribe = useCallback(() => mutate((items) => {
    if (items.some((it) => it.id === id)) return items;
    if (items.length >= MAX_ITEMS) throw new Error(`訂閱上限 ${MAX_ITEMS} 檔`);
    return [...items, {
      id, name: name || id, market, addedAt: todayYmd(),
      revisitDates: [], triggers: {}, triggersV: 2, notes: [], ack: [], base: {},
    }];
  }), [id, name, market, mutate]);

  const unsubscribe = useCallback(() => {
    if (!window.confirm(`取消訂閱 ${id} ${name}？`)) return; // 筆記獨立存放，不受影響
    mutate((items) => items.filter((it) => it.id !== id));
  }, [id, name, mutate]);

  /* ── 基本面資料 ── */
  const [d, setD] = useState(null);
  const reqRef = useRef(0);

  const load = useCallback((force = false) => {
    if (!id) return;
    const req = ++reqRef.current;
    if (!force && sessionCache.has(id)) { setD(sessionCache.get(id)); return; }
    if (force) clearSubscriptionCache(id);
    const s = { id, market, name };
    let acc = { loading: { ...ALL_LOADING } };
    setD(acc);
    let pending = 5;
    const set = (patch) => {
      if (reqRef.current !== req) return;
      acc = { ...acc, ...patch, loading: { ...acc.loading, ...(patch.loading || {}) } };
      setD(acc);
      if (--pending === 0) {
        sessionCache.set(id, acc);
        clearIfUnsubscribed(id);
      }
    };
    loadRevenueBatch([s], { force }).then(
      ({ series, errors }) => set({ rev: series[id]?.length ? series[id] : null, revErr: errors[id] || null, loading: { rev: false } }),
      (e) => set({ revErr: e?.message || '營收抓取失敗', loading: { rev: false } }),
    );
    loadFinancialsBatch([s], { force }).then(
      ({ quarters, errors }) => set({ fin: quarters[id] || [], finErr: errors[id] || null, loading: { fin: false } }),
      (e) => set({ finErr: e?.message || '財報抓取失敗', loading: { fin: false } }),
    );
    const one = (key, p, msg) => p.then(
      (v) => set({ [key]: v, [`${key}Err`]: null, loading: { [key]: false } }),
      (e) => set({ [`${key}Err`]: e?.message || msg, loading: { [key]: false } }),
    );
    one('quote', fetchQuote(id, market, { force }), '股價抓取失敗');
    one('conf', fetchConferences(id, market, { force }), '法說抓取失敗');
    one('news', fetchNews(id, { force }), '重訊抓取失敗');
  }, [id, market, name, clearIfUnsubscribed]);

  useEffect(() => {
    load(false);
    return () => { reqRef.current++; }; // 換股／關閉後，舊請求回來不再寫入
  }, [load]);

  const stats = useMemo(() => (d?.rev ? computeRevenueStats(d.rev) : null), [d]);

  const today = todayYmd();
  const alerts = useMemo(() => {
    const it = sub.item;
    if (!it || !d) return [];
    const ack = new Set(it.ack || []);
    return computeAlerts(it, d, today)
      .filter((a) => !ack.has(a.key))
      .filter((a) => !SOURCES.includes(a.src) || it.base?.[a.src]);
  }, [sub.item, d, today]);

  const ackAlerts = useCallback((keys) => update((cur) => ({
    ack: [...new Set([...(cur.ack || []), ...(keys || alerts.map((a) => a.key))])],
  })), [update, alerts]);

  return {
    d,
    stats,
    item: sub.item,
    status: sub.status,
    canWrite: sub.status === 'ready',
    busy,
    err,
    alerts,
    reload: () => load(true),
    update,
    ack: ackAlerts,
    subscribe,
    unsubscribe,
  };
}
