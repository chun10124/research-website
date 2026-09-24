import { useEffect, useMemo, useState } from 'react';
import { fetchDividendEvents } from '../features/StockAnalysis/api/stockApi';

/**
 * 交易日誌所有標的、自首次交易日起的除權息事件（供 pnlCalculator / 淨值引擎計入股利）。
 * 已出清的標的把最後交易日傳給 fetchDividendEvents 當 frozenAfter，快取定案後不再重抓。
 * @returns {{ dividends: Array, dividendsLoading: boolean }}
 */
export default function useJournalDividends(entries) {
  // code -> { first, last, net }；net 為各型態淨股數（買 − 賣），≈ 0 視為已出清
  const spans = useMemo(() => {
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
    return m;
  }, [entries]);

  const spanKey = useMemo(
    () => Object.entries(spans)
      .map(([c, s]) => `${c}:${s.first}:${Math.abs(s.net) < 1e-6 ? s.last : ''}`)
      .sort()
      .join(','),
    [spans]
  );

  const [dividends, setDividends] = useState([]);
  const [dividendsLoading, setDividendsLoading] = useState(false);

  useEffect(() => {
    const codes = Object.keys(spans);
    if (codes.length === 0) {
      setDividends([]);
      return undefined;
    }
    let cancelled = false;
    setDividendsLoading(true);
    Promise.all(
      codes.map((code) => {
        const s = spans[code];
        const closed = Math.abs(s.net) < 1e-6;
        return fetchDividendEvents(code, s.first, { frozenAfter: closed ? s.last : null })
          .then((events) => (events || []).map((ev) => ({ ...ev, code })));
      })
    ).then((lists) => {
      if (cancelled) return;
      setDividends(lists.flat());
      setDividendsLoading(false);
    });
    return () => { cancelled = true; };
  }, [spanKey]);

  return { dividends, dividendsLoading };
}
