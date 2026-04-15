import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  subscribeIbdRsWatchlistIds,
  toggleIbdRsWatchlistStockId,
  setIbdRsWatchlistStockPriority,
} from '../api/ibdRsWatchlistFirestore';

export function useIbdRsWatchlist() {
  const [stockIds, setStockIds] = useState([]);
  const [priorities, setPriorities] = useState({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = subscribeIbdRsWatchlistIds(({ ids, priorities: p }) => {
      setStockIds(ids);
      setPriorities(p);
      setReady(true);
    });
    return unsub;
  }, []);

  const idSet = useMemo(() => new Set(stockIds), [stockIds]);

  const toggle = useCallback(async (stockId) => {
    return toggleIbdRsWatchlistStockId(stockId);
  }, []);

  const setPriority = useCallback(async (stockId, priority) => {
    return setIbdRsWatchlistStockPriority(stockId, priority);
  }, []);

  return { stockIds, idSet, priorities, ready, toggle, setPriority };
}
