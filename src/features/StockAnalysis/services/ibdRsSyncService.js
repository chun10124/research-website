/* src/features/StockAnalysis/services/ibdRsSyncService.js */

/**
 * 全域 RS 同步單例：離開 IBD 頁面後仍繼續跑 fetch／排名／寫入。
 * 透過 subscribe 訂閱進度；全站 Root 可顯示浮動列。
 */

import { setDoc } from 'firebase/firestore';
import {
  syncAllRsRatings,
  DEFAULT_RS_CHUNK_SIZE,
  RS_SYNC_DEFAULT_CONCURRENCY,
  RS_SYNC_INTRA_DELAY_MS,
  RS_SYNC_SUPER_BATCH_SIZE,
  RS_SYNC_INTER_BATCH_REST_MS,
  runIbdRsHistoryBackfill,
  patchIbdrsRatingFromHistory,
  quickPatchMissingRsDays,
  IBDRS_BACKFILL_DEFAULT_CONCURRENCY,
  IBDRS_BACKFILL_DEFAULT_DELAY_MS,
  IBDRS_BACKFILL_DEFAULT_DELAY_JITTER_MS,
  IBDRS_BACKFILL_YAHOO_BASE_DELAY_MS,
} from '../api/rsApi';
import { SYNC_STATUS_DOC_REF } from '../../../utils/firebaseConfig';

/** 與 IBDRsRankingPage 共用，供完成後寫入／讀取 */
export const IBDRS_LAST_SYNC_DATE_KEY = 'research-website-ibdRsLastSyncDate';

function taipeiYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

let running = false;
/** @type {Promise<any> | null} */
let runPromise = null;
/** @type {Record<string, unknown> | null} */
let lastProgress = null;
/** @type {AbortController | null} */
let currentAbortController = null;

/** @type {Set<(s: { running: boolean; progress: Record<string, unknown> | null }) => void>} */
const listeners = new Set();

function emit() {
  const snapshot = { running, progress: lastProgress };
  listeners.forEach((fn) => {
    try {
      fn(snapshot);
    } catch (e) {
      console.error('[ibdRsSyncService] listener', e);
    }
  });
}

export function getIbdRsSyncSnapshot() {
  return { running, progress: lastProgress };
}

/** 回傳 unsubscribe */
export function subscribeIbdRsSync(listener) {
  listeners.add(listener);
  listener(getIbdRsSyncSnapshot());
  return () => listeners.delete(listener);
}

/** 取消目前正在執行的任何背景任務（sync、回填或補寫快照）。 */
export function stopIbdRsBackgroundTask() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

/** 啟動同步；若已在跑則回傳同一個 Promise（可重複 await）。 */
export function startIbdRsBackgroundSync(opts = {}) {
  if (running && runPromise != null) return runPromise;

  running = true;
  currentAbortController = new AbortController();
  lastProgress = { phase: 'list', done: 0, total: 0, msg: '準備中…' };
  emit();

  runPromise = (async () => {
    let chunkContinues = false;
    let result = null;
    try {
      result = await syncAllRsRatings({
        onProgress: (state) => {
          lastProgress = { ...state };
          emit();
        },
        concurrency: opts.concurrency ?? RS_SYNC_DEFAULT_CONCURRENCY,
        delayMs: opts.delayMs ?? RS_SYNC_INTRA_DELAY_MS,
        superBatchSize: opts.superBatchSize ?? RS_SYNC_SUPER_BATCH_SIZE,
        interBatchRestMs: opts.interBatchRestMs ?? RS_SYNC_INTER_BATCH_REST_MS,
        forceRefresh: opts.forceRefresh === true,
        chunkMode: opts.chunkMode === true,
        chunkSize: opts.chunkSize ?? DEFAULT_RS_CHUNK_SIZE,
        runAllChunks: opts.runAllChunks === true,
        resetChunk: opts.resetChunk === true,
        finalizeOnly: opts.finalizeOnly === true,
        signal: currentAbortController.signal,
      });
      chunkContinues = result?.chunkContinues === true;
      if (!chunkContinues) {
        const ymd = taipeiYmd();
        const ts = Date.now();
        try {
          localStorage.setItem(IBDRS_LAST_SYNC_DATE_KEY, ymd);
        } catch (_) {}
        try {
          await setDoc(
            SYNC_STATUS_DOC_REF,
            {
              rsLastSyncDate: ymd,
              rsLastSyncAt: ts,
              updatedAt: ts,
            },
            { merge: true }
          );
        } catch (e) {
          console.warn('[ibdRsSyncService] 寫入共享同步日期失敗:', e?.message || e);
        }
      }
    } catch (e) {
      const cancelled = e?.message === '已取消';
      if (!cancelled) console.error('[ibdRsSyncService] 同步失敗:', e);
      lastProgress = {
        phase: cancelled ? 'done' : 'error',
        done: 0,
        total: 0,
        msg: cancelled ? '同步已取消' : (e?.message || '同步失敗'),
      };
      emit();
    } finally {
      running = false;
      currentAbortController = null;
      emit();
      const clearDelay = chunkContinues ? 10000 : 4000;
      setTimeout(() => {
        lastProgress = null;
        emit();
      }, clearDelay);
      runPromise = null;
    }
    return result;
  })();

  return runPromise;
}

/**
 * 啟動歷史 RS 回填；若已有任務在跑則直接回傳（同一 Promise）。
 * 傳入 opts.daysBack（預設 180）控制回填天數。
 * opts.onlyFirstTradingWeek：只回填區間內最早 7 個交易日（試跑）。
 * opts.stockLimit：只處理清單前 N 檔（試跑，與全市場 RS 不可直接比較）。
 * opts.concurrency / delayMs / delayJitterMs / yahooBaseDelayMs：可覆寫預設（全市場夜間預設偏保守）。
 */
export function startIbdRsHistoryBackfill(opts = {}) {
  if (running && runPromise != null) return runPromise;

  running = true;
  currentAbortController = new AbortController();
  lastProgress = { phase: 'list', done: 0, total: 0, msg: '歷史 RS 回填準備中…' };
  emit();

  runPromise = (async () => {
    try {
      await runIbdRsHistoryBackfill({
        onProgress: (state) => {
          lastProgress = { ...state };
          emit();
        },
        concurrency: opts.concurrency ?? IBDRS_BACKFILL_DEFAULT_CONCURRENCY,
        delayMs: opts.delayMs ?? IBDRS_BACKFILL_DEFAULT_DELAY_MS,
        delayJitterMs: opts.delayJitterMs ?? IBDRS_BACKFILL_DEFAULT_DELAY_JITTER_MS,
        yahooBaseDelayMs: opts.yahooBaseDelayMs ?? IBDRS_BACKFILL_YAHOO_BASE_DELAY_MS,
        daysBack: opts.daysBack ?? 180,
        onlyFirstTradingWeek: opts.onlyFirstTradingWeek === true,
        stockLimit:
          opts.stockLimit != null && Number(opts.stockLimit) > 0 ? Number(opts.stockLimit) : null,
        signal: currentAbortController.signal,
      });
    } catch (e) {
      const cancelled = e?.message === '已取消';
      lastProgress = {
        phase: cancelled ? 'done' : 'error',
        done: 0,
        total: 0,
        msg: cancelled ? '回填已取消' : (e?.message || '回填失敗'),
      };
      emit();
    } finally {
      running = false;
      currentAbortController = null;
      emit();
      setTimeout(() => {
        lastProgress = null;
        emit();
      }, 5000);
      runPromise = null;
    }
  })();

  return runPromise;
}

/**
 * 只補 Firestore：ibdRsRating 為空但 ibdRsHistory 有值時，從歷史寫入快照。
 * 不抓價、不重跑全市場同步；與 sync／回填互斥（同一 running 單例）。
 */
export function startIbdRsPatchRatingFromHistory() {
  if (running && runPromise != null) return runPromise;

  running = true;
  currentAbortController = new AbortController();
  lastProgress = { phase: 'patch', done: 0, total: 0, msg: '準備補寫 RS 快照…' };
  emit();

  runPromise = (async () => {
    try {
      const r = await patchIbdrsRatingFromHistory({
        onProgress: (state) => {
          lastProgress = { ...state };
          emit();
        },
        signal: currentAbortController.signal,
      });
      return r;
    } catch (e) {
      const cancelled = e?.message === '已取消';
      lastProgress = {
        phase: cancelled ? 'done' : 'error',
        done: 0,
        total: 0,
        msg: cancelled ? '已取消' : (e?.message || '補寫失敗'),
      };
      emit();
    } finally {
      running = false;
      currentAbortController = null;
      emit();
      setTimeout(() => {
        lastProgress = null;
        emit();
      }, 5000);
      runPromise = null;
    }
  })();

  return runPromise;
}

/**
 * 快速補點：從 Firestore 現有 priceMap 補算漏同步日的 RS 歷史。
 * 不打 Yahoo，只需今日同步完成後執行即可。
 */
export function startIbdRsQuickPatch(opts = {}) {
  if (running && runPromise != null) return runPromise;

  running = true;
  currentAbortController = new AbortController();
  lastProgress = { phase: 'list', done: 0, total: 0, msg: '快速補點準備中…' };
  emit();

  runPromise = (async () => {
    try {
      await quickPatchMissingRsDays({
        onProgress: (state) => {
          lastProgress = { ...state };
          emit();
        },
        daysBack: opts.daysBack ?? 10,
        signal: currentAbortController.signal,
      });
    } catch (e) {
      const cancelled = e?.message === '已取消';
      lastProgress = {
        phase: cancelled ? 'done' : 'error',
        done: 0,
        total: 0,
        msg: cancelled ? '已取消' : (e?.message || '快速補點失敗'),
      };
      emit();
    } finally {
      running = false;
      currentAbortController = null;
      emit();
      setTimeout(() => {
        lastProgress = null;
        emit();
      }, 5000);
      runPromise = null;
    }
  })();

  return runPromise;
}
