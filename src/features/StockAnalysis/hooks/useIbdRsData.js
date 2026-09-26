/* src/features/StockAnalysis/hooks/useIbdRsData.js */

/**
 * IBD RS Ranking 頁面的資料 hook
 *
 * 同步改由 ibdRsSyncService 單例執行：離開頁面仍會跑完；本 hook 僅訂閱進度與觸發 start。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAllRsRatings } from '../api/rsRatingsCache';
import {
  subscribeIbdRsSync,
  startIbdRsBackgroundSync,
} from '../services/ibdRsSyncService';

export function useIbdRsData() {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const prevRunningRef = useRef(false);

  /** opts.full=true：略過 IndexedDB 快取、全量重抓（「重新載入」按鈕用） */
  const refresh = useCallback(async (opts) => {
    setLoading(true);
    try {
      const data = await loadAllRsRatings({ full: opts?.full === true });
      setStocks(data);
    } catch (e) {
      console.error('[useIbdRsData] loadAllRsRatings 失敗:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    return subscribeIbdRsSync((s) => {
      setSyncing(s.running);
      setSyncProgress(s.progress);
      if (prevRunningRef.current && !s.running) {
        void refresh();
        const p = s.progress;
        if (p?.phase !== 'error' && p?.chunkContinues !== true) {
          setLastSyncAt(Date.now());
        }
      }
      prevRunningRef.current = s.running;
    });
  }, [refresh]);

  const syncRs = useCallback((opts = {}) => startIbdRsBackgroundSync(opts), []);

  return { stocks, loading, syncing, syncProgress, syncRs, lastSyncAt, refresh };
}
