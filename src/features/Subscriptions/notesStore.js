/* src/features/Subscriptions/notesStore.js */

/**
 * 個股筆記：跟有沒有訂閱無關，所有股票的筆記都存在同一份文件 subscriptions/notes。
 *   { byId: { '4979': [{ at: 'YYYY-MM-DD HH:mm', text }, …新→舊] }, migrated: true, updatedAt }
 * 訂閱頁與 RS 個股視窗「基本面」分頁共用。Firestore 規則沿用 subscriptions/{doc}（僅擁有者），不必另發布。
 *
 * 搬遷：筆記原本存在訂閱項目 item.notes。第一次讀取時把各檔 item.notes「複製」過來並標記 migrated，
 * 之後不再搬（避免刪掉的筆記又被搬回來）。item.notes 原地保留當備份，程式不再讀寫它。
 */

import { useCallback, useEffect, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, SUBSCRIPTIONS_DOC_REF } from '../../utils/firebaseConfig';
import { isDenied, migrate } from './subscriptionStore';

const NOTES_DOC_REF = doc(db, 'subscriptions', 'notes');
const noteKey = (n) => `${n.at}|${n.text}`;
const sortNotes = (list) => [...list].sort((a, b) => b.at.localeCompare(a.at));

let migrating = null; // 同一頁同時開多個視窗時只搬一次

/** 讀整份筆記文件；尚未搬遷就先把訂閱項目裡的筆記複製過來。回傳 byId。 */
async function readAll() {
  const snap = await getDoc(NOTES_DOC_REF);
  const data = snap.exists() ? snap.data() : {};
  if (data.migrated) return data.byId || {};
  if (!migrating) {
    migrating = (async () => {
      const sub = await getDoc(SUBSCRIPTIONS_DOC_REF);
      const items = (sub.exists() ? sub.data().items || [] : []).map(migrate);
      const byId = { ...(data.byId || {}) };
      items.forEach((it) => {
        if (!it.notes?.length) return;
        const cur = byId[it.id] || [];
        const seen = new Set(cur.map(noteKey));
        byId[it.id] = sortNotes([...cur, ...it.notes.filter((n) => n?.text && !seen.has(noteKey(n)))]);
      });
      await setDoc(NOTES_DOC_REF, { byId, migrated: true, updatedAt: new Date().toISOString() }, { merge: true });
      return byId;
    })().finally(() => { migrating = null; });
  }
  return migrating;
}

/** 改一檔的筆記：寫入前重讀，只覆蓋這一檔的陣列（merge 不動其他股票）。 */
async function writeStock(stockId, fn) {
  const byId = await readAll();
  const next = sortNotes(fn(byId[stockId] || []));
  await setDoc(NOTES_DOC_REF, { byId: { [stockId]: next }, updatedAt: new Date().toISOString() }, { merge: true });
  return next;
}

const nowStamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16);

/**
 * 單檔筆記。status：loading | ready | denied（未登入／非擁有者）| error。
 * add(text)、remove(note) 都會先重讀再寫。
 */
export function useStockNotes(stockId) {
  const [state, setState] = useState({ status: 'loading', notes: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!stockId) return undefined;
    let cancelled = false;
    setState({ status: 'loading', notes: [] });
    readAll()
      .then((byId) => { if (!cancelled) setState({ status: 'ready', notes: byId[stockId] || [] }); })
      .catch((e) => { if (!cancelled) setState({ status: isDenied(e) ? 'denied' : 'error', notes: [], err: e?.message }); });
    return () => { cancelled = true; };
  }, [stockId]);

  const run = useCallback(async (fn) => {
    setBusy(true);
    try {
      const notes = await writeStock(stockId, fn);
      setState({ status: 'ready', notes });
      return true;
    } catch (e) {
      setState((p) => ({ ...p, err: e?.message || String(e) }));
      return false;
    } finally {
      setBusy(false);
    }
  }, [stockId]);

  const add = useCallback((text) => run((cur) => [{ at: nowStamp(), text }, ...cur]), [run]);
  const remove = useCallback((note) => run((cur) => cur.filter((n) => noteKey(n) !== noteKey(note))), [run]);

  return { ...state, busy, add, remove };
}
