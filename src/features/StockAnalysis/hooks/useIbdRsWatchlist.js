import { useCallback, useEffect, useMemo, useState } from 'react';
import { subscribeIbdRsWatchlistIds, toggleIbdRsWatchlistStockId } from '../api/ibdRsWatchlistFirestore';

export function useIbdRsWatchlist() {
  const [stockIds, setStockIds] = useState([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = subscribeIbdRsWatchlistIds((ids) => {
      setStockIds(ids);
      setReady(true);
    });
    return unsub;
  }, []);

  const idSet = useMemo(() => new Set(stockIds), [stockIds]);

  const toggle = useCallback(async (stockId) => {
    return toggleIbdRsWatchlistStockId(stockId);
  }, []);

  return { stockIds, idSet, ready, toggle };
}
