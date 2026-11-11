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

/** 超過此天數沒更新、也沒有新收盤的文件視為已下市／合併（如 2867 三商壽 9/1 後就停在 RS 88） */
const STALE_DOC_DAYS = 14;

/**
 * 排除已下市的殘留文件。ibdRsRatings 不會刪檔，下市股的 RS 會一直停在最後一天，
 * 混在排行裡看起來像有效的高 RS。以全庫最新更新日為基準往回 STALE_DOC_DAYS 天，
 * 「RS 更新日」與「最後收盤日」都早於基準才排除（新上市尚無 RS、但每天有收盤的檔不受影響）。
 */
export function dropDelistedDocs(docs) {
  let latest = '';
  for (const d of docs) {
    const u = String(d.ibdRsUpdatedDate || '').slice(0, 10);
    if (u > latest) latest = u;
  }
  if (!latest) return docs;
  const cutoff = new Date(Date.parse(`${latest}T00:00:00Z`) - STALE_DOC_DAYS * 86400000).toISOString().slice(0, 10);
  return docs.filter((d) => {
    const upd = String(d.ibdRsUpdatedDate || '').slice(0, 10);
    const close = String(d.ibdRsLastCloseDate || '').slice(0, 10);
    return upd >= cutoff || close >= cutoff;
  });
}

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
      setStocks(dropDelistedDocs(data));
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
