/**
 * 富邦即時報價（經 Cloudflare Worker research-quote 中繼；只開放 Worker 白名單內的登入者）。
 * 盤中每 10 秒輪詢；收盤後到當晚每分鐘取一次今日收盤（每日同步 15:37 才把今日寫進資料庫，中間這段
 * 若不補，畫面會停在昨天）。週末、未登入、分頁在背景時不打。任何失敗都回 null，呼叫端沿用原本的收盤價。
 */
import { useEffect, useState } from 'react';
import { auth } from '../../../utils/firebaseConfig';

const QUOTE_WORKER_URL = 'https://research-quote.tzuchun11232004.workers.dev';
const POLL_MS = 10000;
const AFTER_CLOSE_POLL_MS = 60000;

/** 最後一次成功取得即時價的時間與富邦資料時間；navbar 燈號訂閱這裡 */
let liveStatus = { okAt: 0, time: null };
const liveListeners = new Set();
const setLiveStatus = (next) => {
  liveStatus = next;
  liveListeners.forEach((fn) => fn(liveStatus));
};

/** 燈號用：{ okAt, time }，okAt 為 0 表示本次開頁尚未成功過 */
export function useRealtimeStatus() {
  const [st, setSt] = useState(liveStatus);
  useEffect(() => {
    liveListeners.add(setSt);
    return () => liveListeners.delete(setSt);
  }, []);
  return st;
}

const bare = (code) => String(code || '').trim().replace(/\.(TW|TWO)$/i, '');

/** 台北時間週一～五：'session' 09:00–13:35（含收盤後 5 分鐘拿最終價）、'afterClose' 13:36–23:59；其餘 null */
export function twMarketPhase(now = new Date()) {
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = tw.getDay();
  const hm = tw.getHours() * 100 + tw.getMinutes();
  if (day < 1 || day > 5 || hm < 900) return null;
  return hm <= 1335 ? 'session' : 'afterClose';
}

export function isTwMarketSession(now = new Date()) {
  return twMarketPhase(now) === 'session';
}

/** @returns {Promise<null | { time: string, quotes: Record<string, { price: number, changePct: number }> }>} */
export async function fetchRealtimeQuotes(codes) {
  const user = auth?.currentUser;
  const ids = [...new Set((codes || []).map(bare).filter(Boolean))];
  if (!user || ids.length === 0) return null;
  try {
    const idToken = await user.getIdToken();
    const r = await fetch(`${QUOTE_WORKER_URL}/quotes?ids=${encodeURIComponent(ids.join(','))}`, {
      headers: { authorization: `Bearer ${idToken}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    // 綠燈只代表「盤中即時」；收盤後拿的是今日收盤，不亮燈
    if (data?.quotes && isTwMarketSession()) setLiveStatus({ okAt: Date.now(), time: data.time || null });
    return data;
  } catch (e) {
    console.warn('[即時報價] 取得失敗:', e?.message || e);
    return null;
  }
}

/**
 * 盤中輪詢即時價、收盤後取今日收盤。回傳
 * { prices: { [bareCode]: price }, quotes: { [bareCode]: 完整報價 }, time: 'HHMMSS' | null, closed: boolean }；
 * closed＝收盤後的今日收盤價（UI 標「收盤」而非「即時」）。週末與開盤前為空物件。
 */
export function useRealtimeQuotes(codes) {
  const key = [...new Set((codes || []).map(bare).filter(Boolean))].sort().join(',');
  const [state, setState] = useState({ prices: {}, quotes: {}, time: null, closed: false });

  useEffect(() => {
    if (!key || typeof window === 'undefined') return undefined;
    let cancelled = false;
    let lastAt = 0;
    const tick = async () => {
      const phase = twMarketPhase();
      if (!phase || document.visibilityState !== 'visible') return;
      if (phase === 'afterClose' && Date.now() - lastAt < AFTER_CLOSE_POLL_MS) return;
      lastAt = Date.now();
      const res = await fetchRealtimeQuotes(key.split(','));
      if (cancelled || !res?.quotes) return;
      // 收盤後只採用「今天」的快照（國定假日富邦回的是前一交易日，資料庫已有，不必覆蓋）
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
      if (phase === 'afterClose' && res.date !== todayStr) return;
      const prices = {};
      const quotes = {};
      for (const [id, q] of Object.entries(res.quotes)) {
        if (q && q.price > 0 && !q.trial) {
          prices[id] = q.price;
          quotes[id] = q;
        }
      }
      setState({ prices, quotes, time: res.time || null, closed: phase === 'afterClose' });
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key]);

  // 換股或盤外：清掉上一檔的即時價，避免沿用
  useEffect(() => {
    setState({ prices: {}, quotes: {}, time: null, closed: false });
  }, [key]);

  return state;
}

/**
 * 把即時報價併入日 K 序列（{ dateStr, open, high, low, close, volume }，舊→新）：
 * 最後一根是今天就以即時開高低收量取代，否則補上今天一根。無有效報價時原樣回傳。
 * 量：富邦快照為「張」，日 K 序列（Yahoo）為「股」→ ×1000。
 */
export function mergeLiveDailyBar(ohlc, q) {
  if (!Array.isArray(ohlc) || !q || !(q.price > 0)) return ohlc;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const last = ohlc[ohlc.length - 1];
  if (last && last.dateStr > today) return ohlc;
  const close = q.price;
  const open = q.open > 0 ? q.open : close;
  const bar = {
    dateStr: today,
    open,
    high: Math.max(q.high > 0 ? q.high : close, open, close),
    low: Math.min(q.low > 0 ? q.low : close, open, close),
    close,
    volume: Number.isFinite(q.volumeLots) ? q.volumeLots * 1000 : (last?.dateStr === today ? last.volume : 0),
    live: true,
  };
  return last?.dateStr === today ? [...ohlc.slice(0, -1), bar] : [...ohlc, bar];
}
