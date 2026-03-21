/* src/features/StockAnalysis/hooks/useIbdRsData.js */

/**
 * IBD RS Ranking 頁面的資料 hook
 *
 * 同步改由 ibdRsSyncService 單例執行：離開頁面仍會跑完；本 hook 僅訂閱進度與觸發 start。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocs } from 'firebase/firestore';
import { RS_RATINGS_COLLECTION } from '../../../utils/firebaseConfig';
import {
  subscribeIbdRsSync,
  startIbdRsBackgroundSync,
} from '../services/ibdRsSyncService';

async function fetchAllRsRatings() {
  const snapshot = await getDocs(RS_RATINGS_COLLECTION);
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function useIbdRsData() {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const prevRunningRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchAllRsRatings();
      setStocks(data);
    } catch (e) {
      console.error('[useIbdRsData] fetchAllRsRatings 失敗:', e);
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
