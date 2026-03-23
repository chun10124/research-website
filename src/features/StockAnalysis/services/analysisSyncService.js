/* 全域追蹤表同步單例：離開 AnalysisPage 仍持續同步 */

import { syncStockSnapshots } from '../api/stockApi';

export const LAST_SYNC_ALL_KEY = 'research-website-lastSyncAllAt';

let running = false;
let runPromise = null;
let lastProgress = null;
let currentAbortController = null;

/** @type {Set<(s: { running: boolean; progress: Record<string, any> | null }) => void>} */
const listeners = new Set();

function emit() {
  const snapshot = { running, progress: lastProgress };
  listeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch (e) {
      console.error('[analysisSyncService] listener', e);
    }
  });
}

export function subscribeAnalysisSync(listener) {
  listeners.add(listener);
  listener({ running, progress: lastProgress });
  return () => listeners.delete(listener);
}

export function stopAnalysisBackgroundSync() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function startAnalysisBackgroundSync({
  stocks,
  concurrency = 3,
  delayMs = 1000,
  delayJitterMs = 400,
  signal = null,
  onProgress = null,
} = {}) {
  if (!Array.isArray(stocks) || stocks.length === 0) {
    lastProgress = { phase: 'done', done: 0, total: 0, msg: '無需同步（清單為空）' };
    emit();
    return Promise.resolve(lastProgress);
  }

  if (running && runPromise != null) return runPromise;

  running = true;
  currentAbortController = new AbortController();

  const abortSignal = signal || currentAbortController.signal;
  lastProgress = { phase: 'list', done: 0, total: stocks.length, msg: '準備同步…' };
  emit();

  const safeStocks = [...stocks];

  runPromise = (async () => {
    try {
      const total = safeStocks.length;
      const batchSize = Math.max(1, Math.floor(Number(concurrency) || 1));
      const jitter = () => Math.floor(Math.random() * Math.max(0, Number(delayJitterMs) || 0));

      let processed = 0;
      let updated = 0;
      let failed = 0;
      let skipped = 0;
      for (let i = 0; i < total; i += batchSize) {
        if (abortSignal?.aborted) throw new Error('已取消');
        const batch = safeStocks.slice(i, i + batchSize);

        if (abortSignal?.aborted) throw new Error('已取消');

        // 並發跑這一批
        await Promise.all(
          batch.map(async (stock) => {
            try {
              const result = await syncStockSnapshots(stock);
              if (result?.updated) updated += 1;
              else if (result?.failed) failed += 1;
              else skipped += 1;
            } catch (e) {
              // syncStockSnapshots 本身有 try/catch，這裡再兜底避免整批被擋住
              console.error('[analysisSyncService] 單檔同步失敗:', e);
              failed += 1;
            }
            processed += 1;
          })
        );

        processed = Math.min(total, processed);
        lastProgress = {
          phase: 'fetch',
          done: updated,
          total,
          processed,
          updated,
          failed,
          skipped,
          msg: `已處理 ${processed}/${total}（更新 ${updated}，略過 ${skipped}，失敗 ${failed}）`,
          batchIndex: Math.floor(i / batchSize) + 1,
          batchTotal: Math.ceil(total / batchSize),
        };
        emit();
        onProgress?.(lastProgress);

        if (processed < total) {
          await sleep((delayMs ?? 0) + jitter());
        }
      }

      lastProgress = {
        phase: 'done',
        done: updated,
        total,
        processed,
        updated,
        failed,
        skipped,
        msg: `同步完成：更新 ${updated}/${total}（略過 ${skipped}，失敗 ${failed}）`,
      };
      emit();
      onProgress?.(lastProgress);

      try {
        localStorage.setItem(LAST_SYNC_ALL_KEY, String(Date.now()));
      } catch (_) {}
      return lastProgress;
    } catch (e) {
      const cancelled = e?.message === '已取消';
      lastProgress = {
        phase: cancelled ? 'done' : 'error',
        done: lastProgress?.done ?? 0,
        total: lastProgress?.total ?? stocks?.length ?? 0,
        msg: cancelled ? '同步已取消' : (e?.message || '同步失敗'),
      };
      emit();
      onProgress?.(lastProgress);
      return lastProgress;
    } finally {
      running = false;
      currentAbortController = null;
      runPromise = null;
    }
  })();

  return runPromise;
}

