import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  subscribeIbdRsWatchlistIds,
  toggleIbdRsWatchlistStockId,
  setIbdRsWatchlistStockPriority,
} from '../api/ibdRsWatchlistFirestore';
import { prefetchWatchlistChipData } from '../api/prefetchChipData';

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
    const added = await toggleIbdRsWatchlistStockId(stockId);
    // 加入觀察清單時，背景預抓籌碼資料（三大法人 + 外資持股）寫進快取，
    // 之後開籌碼視窗就免等 API。fire-and-forget，不阻擋 UI。
    if (added) {
      prefetchWatchlistChipData(stockId).catch(() => {});
    }
    return added;
  }, []);

  const setPriority = useCallback(async (stockId, priority) => {
    return setIbdRsWatchlistStockPriority(stockId, priority);
  }, []);

  return { stockIds, idSet, priorities, ready, toggle, setPriority };
}
