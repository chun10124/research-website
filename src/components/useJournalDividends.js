import { useEffect, useMemo, useState } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { fetchOfficialDividendEvents } from '../features/StockAnalysis/api/dividendApi';
import { NAV_CACHE_COLLECTION } from '../utils/firebaseConfig';

/** 股利的跨裝置共用快取：Firestore navHistory/dividends */
const SHARED_DIVIDEND_CACHE = {
  load: async () => {
    const snap = await getDoc(doc(NAV_CACHE_COLLECTION, 'dividends'));
    return snap.exists() ? snap.data() : null;
  },
  // 回傳 Promise：成功後 dividendApi 才把本機副本標為已上傳
  save: (entry) => setDoc(doc(NAV_CACHE_COLLECTION, 'dividends'), entry)
    .catch((e) => { console.warn('[股利] 寫入共用快取失敗:', e?.message); throw e; }),
};

/**
 * 各標的的交易區間：code -> { first, last, closed }。
 * closed：各型態淨股數（買 − 賣）≈ 0，視為已出清（last 之後的價格／股利都用不到）。
 */
export function getJournalCodeSpans(entries) {
  const m = {};
  (entries || []).forEach((e) => {
    if ((e.direction !== 'BUY' && e.direction !== 'SELL') || !e.code) return;
    const d = String(e.date || '').slice(0, 10);
    if (!d) return;
    const s = m[e.code] || (m[e.code] = { first: d, last: d, net: 0 });
    if (d < s.first) s.first = d;
    if (d > s.last) s.last = d;
    s.net += (e.direction === 'BUY' ? 1 : -1) * (Number(e.quantity) || 0);
  });
  Object.values(m).forEach((s) => { s.closed = Math.abs(s.net) < 1e-6; });
  return m;
}

/**
 * 交易日誌所有標的、自首次交易日起的除權息事件（供 pnlCalculator / 淨值引擎計入股利）。
 * 來源為證交所＋櫃買除權除息計算結果表（全市場一次查詢，見 dividendApi），不佔 FinMind 額度；
 * 查過的結果存 Firestore navHistory/dividends，所有裝置共用。
 * @returns {{ dividends: Array, dividendsLoading: boolean, failedSources: string[] }}
 *   failedSources：取不到資料的來源（'證交所' / '櫃買'），該市場的股利未計入損益
 */
export default function useJournalDividends(entries) {
  const { codes, firstDate } = useMemo(() => {
    const spans = getJournalCodeSpans(entries);
    const list = Object.keys(spans).sort();
    const first = list.map((c) => spans[c].first).sort()[0] || null;
    return { codes: list, firstDate: first };
  }, [entries]);
  const codesKey = codes.join(',');

  const [dividends, setDividends] = useState([]);
  const [dividendsLoading, setDividendsLoading] = useState(false);
  const [failedSources, setFailedSources] = useState([]);

  useEffect(() => {
    if (codes.length === 0 || !firstDate) {
      setDividends([]);
      setFailedSources([]);
      return undefined;
    }
    let cancelled = false;
    setDividendsLoading(true);
    fetchOfficialDividendEvents(codes, firstDate, SHARED_DIVIDEND_CACHE).then(({ events, failedSources: failed }) => {
      if (cancelled) return;
      setDividends(events);
      setFailedSources(failed);
      setDividendsLoading(false);
    });
    return () => { cancelled = true; };
  }, [codesKey, firstDate]);

  return { dividends, dividendsLoading, failedSources };
}
