import { useEffect, useMemo, useState } from 'react';
import { fetchDividendEvents } from '../features/StockAnalysis/api/stockApi';

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    // 一次全發會被代理／FinMind 節流而部分失敗（股利悄悄漏算），故限制並行數並重試
    const fetchOne = async (code) => {
      const s = spans[code];
      const closed = Math.abs(s.net) < 1e-6;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(RETRY_DELAY_MS * attempt);
        const events = await fetchDividendEvents(code, s.first, { frozenAfter: closed ? s.last : null });
        if (events) return events.map((ev) => ({ ...ev, code }));
      }
      console.warn(`[股利] ${code} 除權息資料取得失敗，損益暫未計入該檔股利`);
      return [];
    };
    const load = async () => {
      const results = [];
      let next = 0;
      const worker = async () => {
        while (next < codes.length && !cancelled) {
          const code = codes[next++];
          results.push(...(await fetchOne(code)));
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (cancelled) return;
      setDividends(results);
      setDividendsLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [spanKey]);

  return { dividends, dividendsLoading };
}
