/* src/features/StockAnalysis/api/rsApi.js */

/**
 * IBD RS Ranking 同步流程
 *
 * Phase 0：抓上市＋上櫃清單
 * Phase 1：逐檔 Yahoo 股價 → RS_raw（今日／7日／30日錨點）
 * Phase 2：全市場百分位排名
 * Phase 3：寫回 Firestore
 *
 * 預設：chunkMode: false，按一次即全市場抓價 → 排名 → 寫入（較久但不用按多次）。
 * 選用：chunkMode: true 分批（每按一次約 chunkSize 檔，最後一批才寫 RS）。
 *
 * 資料儲存：ibdRsRatings/{stockCode}
 *   - ibdRsPriceFetchedDate: 當日已抓完股價（分批用；finalize 前不代表已更新 RS）
 *   - pricePct1d: 近 1 個交易日收盤漲跌幅（%），與 pricePct5d／20d 同源
 *   - pricePos6m: 近六個月區間內當前價位置 0∼1（低=0、高=1）
 *   - ibdRsLastClose / ibdRsLastCloseDate: 錨定日前最近一筆收盤價與該交易日（Yahoo 歷史價同源）
 *   - 其餘欄位見下方註解
 */

import { doc, setDoc, getDocs, writeBatch } from 'firebase/firestore';
import { db, RS_RATINGS_COLLECTION } from '../../../utils/firebaseConfig';
import { fetchYahooHistoricalPriceMap, fetchHistoricalPriceMap } from './stockApi';
import { fetchTaiwanStockList } from './rsStockList';
import {
  calculateRsRaw,
  assignRsRatings,
  taipeiYmdAddDays,
  calcPriceChangePct,
  calcPricePosition6m,
  normalizeYmdToTaiwanTradingDay,
  getLatestCloseInPriceMap,
} from '../utils/rsCalculator';

/**
 * ibdRsHistory 的日期鍵（台灣曆 YYYY-MM-DD）：週六、週日皆 normalize 到上一個交易日（通常為週五），
 * 避免週五 sync 一筆、週六或週日再 sync 又寫一筆、圖上兩點 RS 卻不同。
 */
function historyAnchorYmd(ymd) {
  return normalizeYmdToTaiwanTradingDay(ymd) ?? String(ymd || '').slice(0, 10);
}

const RS_HISTORY_MAX = 180;

/** 快取可重用：須含 7/30 日 raw、5D/20D 漲跌幅、近 6 月價位指標 */
function hasAllFetchedPriceFields(ex) {
  if (!ex || typeof ex !== 'object') return false;
  return (
    ex.ibdRsRaw7 != null &&
    ex.ibdRsRaw30 != null &&
    ex.pricePct5d != null &&
    ex.pricePct20d != null &&
    typeof ex.pricePos6m === 'number' &&
    Number.isFinite(ex.pricePos6m)
  );
}

/** Yahoo 價格回溯月數：需涵蓋「今日−30 日」錨點的 P12（約 12m+30d），僅 13m 會讓 rsRaw30／Δ30 大量為 null */
const RS_PRICE_LOOKBACK_MONTHS = 15;

const LS_CHUNK_KEY = 'research-website-ibdRsChunkV1';

/** 預設每批檔數（可依 API 限流調整） */
export const DEFAULT_RS_CHUNK_SIZE = 350;

/**
 * 同步內部：每 N 檔為一「超級批次」；超過此門檻後觸發較長的組間休息。
 * 設 0 可停用超級批次休息邏輯。
 */
export const RS_SYNC_SUPER_BATCH_SIZE = 300;
/**
 * 超級批次完成後的休息毫秒數（避免長時間大量請求觸發 Yahoo 限流）。
 * 預設 35s；每批後再加最多 5s jitter。
 */
export const RS_SYNC_INTER_BATCH_REST_MS = 35_000;
/** 超級批次內：每 concurrency 組之間的基礎延遲（ms）；低於全局 delayMs 以加快組內進度 */
export const RS_SYNC_INTRA_DELAY_MS = 400;
/** 超級批次內：預設並發數（同時發出 N 個 Yahoo 請求） */
export const RS_SYNC_DEFAULT_CONCURRENCY = 5;

function getTaiwanYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

function readChunkProgress(todayStr, listTotal) {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(LS_CHUNK_KEY);
    if (!raw) return 0;
    const o = JSON.parse(raw);
    if (o.day !== todayStr || Number(o.listTotal) !== listTotal) return 0;
    const off = Number(o.offset);
    if (!Number.isFinite(off) || off < 0) return 0;
    return Math.min(off, listTotal);
  } catch {
    return 0;
  }
}

function writeChunkProgress(day, offset, listTotal) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_CHUNK_KEY, JSON.stringify({ day, offset, listTotal }));
  } catch (_) {}
}

export function clearIbdrsChunkProgress() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(LS_CHUNK_KEY);
  } catch (_) {}
}

async function readExistingRsData() {
  try {
    const snapshot = await getDocs(RS_RATINGS_COLLECTION);
    const map = {};
    snapshot.docs.forEach((d) => {
      map[d.id] = d.data();
    });
    return map;
  } catch (e) {
    console.warn('[RS] 讀取現有 ibdRsRatings 失敗:', e.message);
    return {};
  }
}

/**
 * 自 ibdRsHistory 取「基準日當天或之前」最後一筆（與前端顯示／折線圖一致）。
 * @returns {{ r: number, d: string } | null}
 */
function pickLastHistoryPointForToday(ibdRsHistory, todayStr) {
  if (!Array.isArray(ibdRsHistory) || ibdRsHistory.length === 0) return null;
  const sorted = [...ibdRsHistory]
    .filter((e) => e?.d && typeof e.r === 'number' && Number.isFinite(e.r))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (sorted.length === 0) return null;
  let last = null;
  for (const e of sorted) {
    if (e.d <= todayStr) last = e;
    else break;
  }
  const pick = last ?? sorted[sorted.length - 1];
  return { r: pick.r, d: pick.d };
}

/**
 * 救濟：只補 Firestore 頂層 ibdRsRating 為空、但 ibdRsHistory 已有點的檔。
 * 不抓 Yahoo、不重算全市場排名；僅把歷史最後一筆 RS 寫成快照（秒級～數十秒）。
 *
 * @param {{ onProgress?: (s: object) => void, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ patched: number }>}
 */
export async function patchIbdrsRatingFromHistory({ onProgress = () => {}, signal } = {}) {
  const todayStr = getTaiwanYmd();
  onProgress({ phase: 'patch', done: 0, total: 0, msg: '讀取 ibdRsRatings…' });
  const snapshot = await getDocs(RS_RATINGS_COLLECTION);
  if (signal?.aborted) throw new Error('已取消');

  const toPatch = [];
  snapshot.docs.forEach((d) => {
    const data = d.data();
    if (data.ibdRsRating != null) return;
    const hist = Array.isArray(data.ibdRsHistory) ? data.ibdRsHistory : [];
    const picked = pickLastHistoryPointForToday(hist, todayStr);
    if (!picked) return;
    toPatch.push({ id: d.id, r: picked.r, d: picked.d });
  });

  const total = toPatch.length;
  onProgress({
    phase: 'patch',
    done: 0,
    total,
    msg: total === 0 ? '無需補寫（無 ibdRsRating 為空且歷史有值之檔）' : `將補寫 ${total} 檔（僅 Firestore）…`,
  });

  if (total === 0) {
    onProgress({ phase: 'done', done: 0, total: 0, msg: '完成 · 0 檔' });
    return { patched: 0 };
  }

  const CHUNK = 400;
  let done = 0;
  for (let i = 0; i < toPatch.length; i += CHUNK) {
    if (signal?.aborted) throw new Error('已取消');
    const chunk = toPatch.slice(i, i + CHUNK);
    const batch = writeBatch(db);
    for (const item of chunk) {
      const ref = doc(RS_RATINGS_COLLECTION, item.id);
      batch.set(
        ref,
        {
          ibdRsRating: item.r,
          ibdRsSnapshotDate: item.d,
          updatedAt: Date.now(),
        },
        { merge: true }
      );
    }
    await batch.commit();
    done += chunk.length;
    onProgress({ phase: 'patch', done, total, msg: `已寫入 ${done}/${total}` });
  }

  onProgress({ phase: 'done', done: total, total, msg: `完成 · 補寫 ${total} 檔 ibdRsRating` });
  return { patched: total };
}

/**
 * 抓單一股票收盤價（Yahoo Finance via proxy）
 * 回溯 {@link RS_PRICE_LOOKBACK_MONTHS} 個月，供今日／7 日／30 日錨點 RS_raw 使用
 */
export async function fetchRsPriceData(stockCode, market) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - RS_PRICE_LOOKBACK_MONTHS);
  return fetchYahooHistoricalPriceMap(
    stockCode,
    startDate.toISOString().slice(0, 10),
    endDate.toISOString().slice(0, 10),
    { market }
  );
}

/**
 * 僅依 Firestore 已存之 ibdRsPriceFetchedDate＝今日 的 raw，重算全市場排名並寫入（救濟用）
 */
export async function finalizeIbdrsRankingFromFirestore({
  onProgress = () => {},
} = {}) {
  const todayStr = getTaiwanYmd();
  onProgress({ phase: 'list', done: 0, total: 0, msg: '載入清單（僅 finalize）…' });
  const stockList = await fetchTaiwanStockList();
  const stockListTotal = stockList.length;
  if (stockListTotal === 0) throw new Error('無法取得台股清單');

  const twseCount = stockList.filter((s) => s.market === 'TWSE').length;
  const tpexCount = stockList.filter((s) => s.market === 'TPEX').length;
  const listMeta = { twseCount, tpexCount, listTotal: stockListTotal };

  const existingMap = await readExistingRsData();
  return runFinalizePhases(stockList, stockListTotal, todayStr, existingMap, onProgress, listMeta, {
    finalizeOnly: true,
  });
}

async function runFinalizePhases(stockList, stockListTotal, todayStr, existingMap, onProgress, listMeta, extraDone = {}) {
  const rawResults = extraDone.rawResultsOverride || stockList.map((s) => {
    const ex = existingMap[s.id];
    const ok = ex?.ibdRsPriceFetchedDate === todayStr;
    if (!ok) {
      return {
        id: s.id, name: s.name, market: s.market,
        rsRaw: null, rsRaw7: null, rsRaw30: null,
        pricePct1d: ex?.pricePct1d ?? null,
        pricePct5d: ex?.pricePct5d ?? null,
        pricePct20d: ex?.pricePct20d ?? null,
        pricePos6m: ex?.pricePos6m ?? null,
        ibdRsLastClose: ex?.ibdRsLastClose ?? null,
        ibdRsLastCloseDate: ex?.ibdRsLastCloseDate ?? null,
      };
    }
    return {
      id: s.id,
      name: s.name,
      market: s.market,
      rsRaw: ex.ibdRsRaw ?? null,
      rsRaw7: ex.ibdRsRaw7 ?? null,
      rsRaw30: ex.ibdRsRaw30 ?? null,
      pricePct1d: ex.pricePct1d ?? null,
      pricePct5d: ex.pricePct5d ?? null,
      pricePct20d: ex.pricePct20d ?? null,
      pricePos6m: ex.pricePos6m ?? null,
      ibdRsLastClose: ex.ibdRsLastClose ?? null,
      ibdRsLastCloseDate: ex.ibdRsLastCloseDate ?? null,
    };
  });

  const missingPrice = rawResults.filter((r) => r.rsRaw == null).length;

  onProgress({
    phase: 'rank',
    done: stockListTotal,
    total: stockListTotal,
    msg: `計算百分位排名…（今日未抓價 ${missingPrice} 檔將無 RS）`,
    ...listMeta,
  });

  const ranked = assignRsRatings(
    rawResults.map(({ id, name, market, rsRaw }) => ({ id, name, market, rsRaw }))
  );
  const ranked7 = assignRsRatings(
    rawResults.map(({ id, name, market, rsRaw7 }) => ({ id, name, market, rsRaw: rsRaw7 }))
  );
  const ranked30 = assignRsRatings(
    rawResults.map(({ id, name, market, rsRaw30 }) => ({ id, name, market, rsRaw: rsRaw30 }))
  );
  const ratingMap = Object.fromEntries(ranked.map((r) => [r.id, r.ibdRsRating]));
  const ratingMap7 = Object.fromEntries(
    ranked7.filter((r) => r.ibdRsRating != null).map((r) => [r.id, r.ibdRsRating])
  );
  const ratingMap30 = Object.fromEntries(
    ranked30.filter((r) => r.ibdRsRating != null).map((r) => [r.id, r.ibdRsRating])
  );
  const rawById = Object.fromEntries(rawResults.map((r) => [r.id, r]));

  const validRanked = ranked.filter((r) => r.ibdRsRating != null);
  let writeDone = 0;
  const WRITE_BATCH = 10;

  for (let i = 0; i < validRanked.length; i += WRITE_BATCH) {
    if (extraDone.signal?.aborted) throw new Error('已取消');
    const batch = validRanked.slice(i, i + WRITE_BATCH);

    await Promise.all(
      batch.map(async (item) => {
        const newRating = ratingMap[item.id];
        if (newRating == null) return;

        const existing = existingMap[item.id] ?? {};
        const prevHistory = Array.isArray(existing.ibdRsHistory) ? existing.ibdRsHistory : [];
        const prevRating = typeof existing.ibdRsRating === 'number' ? existing.ibdRsRating : null;

        const anchorStr = historyAnchorYmd(todayStr);
        const withoutSlot = prevHistory.filter((h) => historyAnchorYmd(h.d) !== anchorStr);
        const newHistory = [...withoutSlot, { d: anchorStr, r: newRating }]
          .sort((a, b) => (a.d < b.d ? -1 : 1))
          .slice(-RS_HISTORY_MAX);

        const r7 = ratingMap7[item.id];
        const r30 = ratingMap30[item.id];
        const ibdRsDelta7d = newRating != null && r7 != null ? newRating - r7 : null;
        const ibdRsDelta30d = newRating != null && r30 != null ? newRating - r30 : null;

        const snap = rawById[item.id];
        const ibdRsRaw = snap ? snap.rsRaw : null;
        const ibdRsRaw7 = snap ? snap.rsRaw7 : null;
        const ibdRsRaw30 = snap ? snap.rsRaw30 : null;
        const pricePct1d = snap?.pricePct1d ?? null;
        const pricePct5d = snap?.pricePct5d ?? null;
        const pricePct20d = snap?.pricePct20d ?? null;
        const pricePos6m = snap?.pricePos6m ?? null;
        const ibdRsLastClose = snap?.ibdRsLastClose ?? null;
        const ibdRsLastCloseDate = snap?.ibdRsLastCloseDate ?? null;

        await setDoc(
          doc(RS_RATINGS_COLLECTION, item.id),
          {
            id: item.id,
            name: item.name,
            market: item.market,
            ibdRsRating: newRating,
            ibdRsUpdatedDate: todayStr,
            ibdRsSnapshotDate: todayStr,
            ibdRsPriceFetchedDate: todayStr,
            ibdRsRaw,
            ibdRsRaw7,
            ibdRsRaw30,
            ibdRsHistory: newHistory,
            ibdRsDelta7d,
            ibdRsDelta30d,
            ibdRsPrevRating: prevRating,
            pricePct1d,
            pricePct5d,
            pricePct20d,
            pricePos6m,
            ibdRsLastClose,
            ibdRsLastCloseDate,
            updatedAt: Date.now(),
          },
          { merge: true }
        );

        writeDone++;
        onProgress({
          phase: 'write',
          done: writeDone,
          total: validRanked.length,
          msg: item.id,
          ...listMeta,
        });
      })
    );

    if (i + WRITE_BATCH < validRanked.length) {
      await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 120)));
    }
  }

  const sk = extraDone.skippedYahooCount ?? 0;
  const defaultMsg =
    `完成 · 有效排名 ${validRanked.length} 檔 · 今日未抓價 ${missingPrice} 檔` +
    (sk > 0 ? ` · 略過 Yahoo ${sk} 次` : '');
  onProgress({
    phase: 'done',
    done: stockListTotal,
    total: stockListTotal,
    msg: extraDone.msg ?? defaultMsg,
    validRankedCount: validRanked.length,
    skippedYahooCount: extraDone.skippedYahooCount ?? 0,
    chunkContinues: false,
    missingPriceFetch: missingPrice,
    ...listMeta,
    ...extraDone,
  });

  return { ranked, chunkContinues: false, missingPriceFetch: missingPrice };
}

/**
 * 判斷「處理到第 endIdx 檔」時是否跨越了超級批次邊界（endIdx 為 1-based 結束位置）。
 * 若跨越，呼叫端應在繼續前插入較長的組間休息。
 */
function crossesSuperBatch(endIdx, size) {
  if (!size || size <= 0) return false;
  // Math.floor((endIdx-1)/size) !== Math.floor(endIdx/size) 等同 endIdx % size === 0
  return endIdx % size === 0;
}

/** 單次模式：一次跑完 Phase1–3，以超級批次策略控制限流 */
async function runMonolithicSync(
  stockList,
  stockListTotal,
  todayStr,
  existingMap,
  anchor7Str,
  anchor30Str,
  onProgress,
  listMeta,
  {
    concurrency,
    delayMs,
    forceRefresh,
    signal,
    superBatchSize = RS_SYNC_SUPER_BATCH_SIZE,
    interBatchRestMs = RS_SYNC_INTER_BATCH_REST_MS,
  }
) {
  const rawResults = [];
  let fetchDone = 0;
  let skippedYahooCount = 0;

  // 預掃：報告需重抓數量
  let needRefetchCount = 0;
  for (const stock of stockList) {
    const ex = existingMap[stock.id];
    const hasAll = hasAllFetchedPriceFields(ex);
    const snap = !forceRefresh && hasAll && ex?.ibdRsSnapshotDate === todayStr && ex?.ibdRsUpdatedDate === todayStr;
    const price = !forceRefresh && !snap && hasAll && ex?.ibdRsPriceFetchedDate === todayStr;
    if (!snap && !price) needRefetchCount++;
  }
  onProgress({
    phase: 'fetch', done: 0, total: stockListTotal,
    msg: `需從 Yahoo 重抓 ${needRefetchCount} 檔，可略過 ${stockListTotal - needRefetchCount} 檔`,
    ...listMeta,
  });

  for (let i = 0; i < stockListTotal; i += concurrency) {
    if (signal?.aborted) throw new Error('已取消');
    const batch = stockList.slice(i, i + concurrency);
    let anyNetworkFetch = false;

    for (const stock of batch) {
      let rsRaw = null;
      let rsRaw7 = null;
      let rsRaw30 = null;
      let pricePct1d = null;
      let pricePct5d = null;
      let pricePct20d = null;
      let pricePos6m = null;
      let ibdRsLastClose = null;
      let ibdRsLastCloseDate = null;
      const ex = existingMap[stock.id];
      const hasAllFields = hasAllFetchedPriceFields(ex);
      const canReuseSnapshot =
        !forceRefresh && hasAllFields && ex?.ibdRsSnapshotDate === todayStr && ex?.ibdRsUpdatedDate === todayStr;
      const canReusePriceOnly =
        !forceRefresh && !canReuseSnapshot && hasAllFields && ex?.ibdRsPriceFetchedDate === todayStr;

      if (canReuseSnapshot) {
        rsRaw = ex.ibdRsRaw ?? null;
        rsRaw7 = ex.ibdRsRaw7 ?? null;
        rsRaw30 = ex.ibdRsRaw30 ?? null;
        pricePct1d = ex.pricePct1d ?? null;
        pricePct5d = ex.pricePct5d ?? null;
        pricePct20d = ex.pricePct20d ?? null;
        pricePos6m = ex.pricePos6m ?? null;
        ibdRsLastClose = ex.ibdRsLastClose ?? null;
        ibdRsLastCloseDate = ex.ibdRsLastCloseDate ?? null;
        skippedYahooCount++;
      } else if (canReusePriceOnly) {
        rsRaw = ex.ibdRsRaw ?? null;
        rsRaw7 = ex.ibdRsRaw7 ?? null;
        rsRaw30 = ex.ibdRsRaw30 ?? null;
        pricePct1d = ex.pricePct1d ?? null;
        pricePct5d = ex.pricePct5d ?? null;
        pricePct20d = ex.pricePct20d ?? null;
        pricePos6m = ex.pricePos6m ?? null;
        ibdRsLastClose = ex.ibdRsLastClose ?? null;
        ibdRsLastCloseDate = ex.ibdRsLastCloseDate ?? null;
        skippedYahooCount++;
      } else {
        anyNetworkFetch = true;
        try {
          const priceMap = await fetchRsPriceData(stock.id, stock.market);
          rsRaw = calculateRsRaw(priceMap, todayStr);
          if (anchor7Str) rsRaw7 = calculateRsRaw(priceMap, anchor7Str);
          if (anchor30Str) rsRaw30 = calculateRsRaw(priceMap, anchor30Str);
          pricePct1d = calcPriceChangePct(priceMap, todayStr, 1);
          pricePct5d = calcPriceChangePct(priceMap, todayStr, 5);
          pricePct20d = calcPriceChangePct(priceMap, todayStr, 20);
          pricePos6m = calcPricePosition6m(priceMap, todayStr);
          const lc = getLatestCloseInPriceMap(priceMap, todayStr);
          ibdRsLastClose = lc.price;
          ibdRsLastCloseDate = lc.dateStr;
        } catch (e) {
          console.warn(`[RS] ${stock.id} 抓取失敗:`, e.message);
        }
      }
      rawResults.push({
        id: stock.id,
        name: stock.name,
        market: stock.market,
        rsRaw,
        rsRaw7,
        rsRaw30,
        pricePct1d,
        pricePct5d,
        pricePct20d,
        pricePos6m,
        ibdRsLastClose,
        ibdRsLastCloseDate,
      });
      fetchDone++;
      const msgHint = canReuseSnapshot
        ? `${stock.id} ·略過(今日已排名)`
        : canReusePriceOnly
          ? `${stock.id} ·略過(今日已抓價)`
          : stock.id;
      onProgress({
        phase: 'fetch',
        done: fetchDone,
        total: stockListTotal,
        msg: msgHint,
        ...listMeta,
      });
    }

    if (i + concurrency < stockListTotal) {
      const batchEnd = i + batch.length;
      const isRestPoint = anyNetworkFetch && crossesSuperBatch(batchEnd, superBatchSize);
      if (isRestPoint) {
        const batchNo = Math.ceil(batchEnd / superBatchSize);
        const batchTotal = Math.ceil(stockListTotal / superBatchSize);
        onProgress({
          phase: 'fetch',
          done: fetchDone,
          total: stockListTotal,
          msg: `第 ${batchNo}/${batchTotal} 批完成（${batchEnd} 檔），休息 ${Math.round(interBatchRestMs / 1000)}s…`,
          ...listMeta,
        });
      }
      const wait = isRestPoint
        ? interBatchRestMs + Math.floor(Math.random() * 5000)
        : anyNetworkFetch
          ? delayMs + Math.floor(Math.random() * 300)
          : 30 + Math.floor(Math.random() * 30);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const existingFresh = await readExistingRsData();
  const fin = await runFinalizePhases(stockList, stockListTotal, todayStr, existingFresh, onProgress, listMeta, {
    skippedYahooCount,
    rawResultsOverride: rawResults,
    signal,
  });
  return { ...fin, skippedYahooCount };
}

/** 處理 [offset, end) 僅寫入股價欄位 */
async function runPriceFetchSlice(
  stockList,
  offset,
  end,
  todayStr,
  existingMap,
  anchor7Str,
  anchor30Str,
  onProgress,
  listMeta,
  {
    concurrency,
    delayMs,
    forceRefresh,
    signal,
    superBatchSize = RS_SYNC_SUPER_BATCH_SIZE,
    interBatchRestMs = RS_SYNC_INTER_BATCH_REST_MS,
  },
  sliceLabel
) {
  const slice = stockList.slice(offset, end);
  const sliceLen = slice.length;
  let localDone = 0;
  let skippedYahooCount = 0;

  for (let i = 0; i < sliceLen; i += concurrency) {
    if (signal?.aborted) throw new Error('已取消');
    const batch = slice.slice(i, i + concurrency);
    let anyNetworkFetch = false;

    for (const stock of batch) {
      let rsRaw = null;
      let rsRaw7 = null;
      let rsRaw30 = null;
      const ex = existingMap[stock.id];
      const hasAllFields = hasAllFetchedPriceFields(ex);
      const canReuseSnapshot =
        !forceRefresh && hasAllFields && ex?.ibdRsSnapshotDate === todayStr && ex?.ibdRsUpdatedDate === todayStr;
      const canReusePriceOnly =
        !forceRefresh && !canReuseSnapshot && hasAllFields && ex?.ibdRsPriceFetchedDate === todayStr;

      let pricePct1d = null;
      let pricePct5d = null;
      let pricePct20d = null;
      let pricePos6m = null;
      let ibdRsLastClose = null;
      let ibdRsLastCloseDate = null;

      if (canReuseSnapshot || canReusePriceOnly) {
        rsRaw = ex.ibdRsRaw ?? null;
        rsRaw7 = ex.ibdRsRaw7 ?? null;
        rsRaw30 = ex.ibdRsRaw30 ?? null;
        pricePct1d = ex?.pricePct1d ?? null;
        pricePct5d = ex?.pricePct5d ?? null;
        pricePct20d = ex?.pricePct20d ?? null;
        pricePos6m = ex?.pricePos6m ?? null;
        ibdRsLastClose = ex?.ibdRsLastClose ?? null;
        ibdRsLastCloseDate = ex?.ibdRsLastCloseDate ?? null;
        skippedYahooCount++;
      } else {
        anyNetworkFetch = true;
        try {
          const priceMap = await fetchRsPriceData(stock.id, stock.market);
          rsRaw = calculateRsRaw(priceMap, todayStr);
          if (anchor7Str) rsRaw7 = calculateRsRaw(priceMap, anchor7Str);
          if (anchor30Str) rsRaw30 = calculateRsRaw(priceMap, anchor30Str);
          pricePct1d = calcPriceChangePct(priceMap, todayStr, 1);
          pricePct5d = calcPriceChangePct(priceMap, todayStr, 5);
          pricePct20d = calcPriceChangePct(priceMap, todayStr, 20);
          pricePos6m = calcPricePosition6m(priceMap, todayStr);
          const lc = getLatestCloseInPriceMap(priceMap, todayStr);
          ibdRsLastClose = lc.price;
          ibdRsLastCloseDate = lc.dateStr;
        } catch (e) {
          console.warn(`[RS] ${stock.id} 抓取失敗:`, e.message);
        }
      }

      await setDoc(
        doc(RS_RATINGS_COLLECTION, stock.id),
        {
          id: stock.id,
          name: stock.name,
          market: stock.market,
          ibdRsRaw: rsRaw,
          ibdRsRaw7: rsRaw7,
          ibdRsRaw30: rsRaw30,
          pricePct1d,
          pricePct5d,
          pricePct20d,
          pricePos6m,
          ibdRsLastClose,
          ibdRsLastCloseDate,
          ibdRsPriceFetchedDate: todayStr,
          updatedAt: Date.now(),
        },
        { merge: true }
      );

      localDone++;
      const msgHint =
        canReuseSnapshot || canReusePriceOnly
          ? `${sliceLabel} ${stock.id} ·略過`
          : `${sliceLabel} ${stock.id}`;
      onProgress({
        phase: 'fetch',
        done: offset + localDone,
        total: listMeta.listTotal,
        msg: msgHint,
        fetchSliceDone: localDone,
        fetchSliceTotal: sliceLen,
        ...listMeta,
      });
    }

    if (i + concurrency < sliceLen) {
      const absEnd = offset + localDone;
      const isRestPoint = anyNetworkFetch && crossesSuperBatch(absEnd, superBatchSize);
      if (isRestPoint) {
        onProgress({
          phase: 'fetch',
          done: absEnd,
          total: listMeta.listTotal,
          msg: `${sliceLabel} 第 ${Math.ceil(absEnd / superBatchSize)} 批完成，休息 ${Math.round(interBatchRestMs / 1000)}s…`,
          fetchSliceDone: localDone,
          fetchSliceTotal: sliceLen,
          ...listMeta,
        });
      }
      const wait = isRestPoint
        ? interBatchRestMs + Math.floor(Math.random() * 5000)
        : anyNetworkFetch
          ? delayMs + Math.floor(Math.random() * 300)
          : 30 + Math.floor(Math.random() * 30);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  return skippedYahooCount;
}

/**
 * 完整 RS 同步
 *
 * @param {boolean} [options.chunkMode=false]        true＝分批（需按多次或 runAllChunks）
 * @param {number}  [options.chunkSize=350]          每批檔數（chunkMode 用）
 * @param {boolean} [options.runAllChunks]           true＝同一輪連續跑完所有批再 finalize
 * @param {boolean} [options.resetChunk]             true＝忽略進度從頭分批
 * @param {boolean} [options.finalizeOnly]           只執行排名寫入（需今日已抓價）
 * @param {number}  [options.superBatchSize=300]     每「超級批次」股票數；達此門檻後休息 interBatchRestMs
 * @param {number}  [options.interBatchRestMs=35000] 超級批次間休息毫秒數
 */
export async function syncAllRsRatings({
  onProgress = () => {},
  concurrency = RS_SYNC_DEFAULT_CONCURRENCY,
  delayMs = RS_SYNC_INTRA_DELAY_MS,
  forceRefresh = false,
  chunkMode = false,
  chunkSize = DEFAULT_RS_CHUNK_SIZE,
  runAllChunks = false,
  resetChunk = false,
  finalizeOnly = false,
  signal = null,
  superBatchSize = RS_SYNC_SUPER_BATCH_SIZE,
  interBatchRestMs = RS_SYNC_INTER_BATCH_REST_MS,
} = {}) {
  const todayStr = getTaiwanYmd();

  if (finalizeOnly) {
    return finalizeIbdrsRankingFromFirestore({ onProgress });
  }

  onProgress({ phase: 'list', done: 0, total: 0, msg: '從 TWSE + TPEX 抓取股票清單...' });

  const stockList = await fetchTaiwanStockList();
  const stockListTotal = stockList.length;

  if (stockListTotal === 0) {
    onProgress({ phase: 'error', done: 0, total: 0, msg: '股票清單抓取失敗，請稍後重試' });
    throw new Error('無法取得台股清單');
  }

  const twseCount = stockList.filter((s) => s.market === 'TWSE').length;
  const tpexCount = stockList.filter((s) => s.market === 'TPEX').length;
  const listMeta = { twseCount, tpexCount, listTotal: stockListTotal };

  onProgress({
    phase: 'list',
    done: stockListTotal,
    total: stockListTotal,
    msg: `市 ${twseCount}、櫃 ${tpexCount}，合計 ${stockListTotal} 檔`,
    ...listMeta,
  });

  let existingMap = await readExistingRsData();
  const anchor7Str = taipeiYmdAddDays(todayStr, -7);
  const anchor30Str = taipeiYmdAddDays(todayStr, -30);

  if (!chunkMode) {
    return runMonolithicSync(
      stockList,
      stockListTotal,
      todayStr,
      existingMap,
      anchor7Str,
      anchor30Str,
      onProgress,
      listMeta,
      { concurrency, delayMs, forceRefresh, signal, superBatchSize, interBatchRestMs }
    ).then((res) => ({ ...res, chunkContinues: false }));
  }

  // ── 分批：價格切片 ────────────────────────────────────────────────
  let offset = resetChunk ? 0 : readChunkProgress(todayStr, stockListTotal);
  const size = Math.max(50, Math.min(2000, Number(chunkSize) || DEFAULT_RS_CHUNK_SIZE));

  const runOneChunk = async (start) => {
    existingMap = await readExistingRsData();
    const end = Math.min(start + size, stockListTotal);
    const batchIndex = Math.floor(start / size) + 1;
    const batchTotal = Math.ceil(stockListTotal / size);
    const label = `第${batchIndex}/${batchTotal}批`;
    const skipped = await runPriceFetchSlice(
      stockList,
      start,
      end,
      todayStr,
      existingMap,
      anchor7Str,
      anchor30Str,
      onProgress,
      listMeta,
      { concurrency, delayMs, forceRefresh, signal, superBatchSize, interBatchRestMs },
      label
    );
    return { end, skipped, batchIndex, batchTotal };
  };

  let totalSkipped = 0;

  if (runAllChunks) {
    while (offset < stockListTotal) {
      if (signal?.aborted) throw new Error('已取消');
      const { end, skipped, batchIndex, batchTotal } = await runOneChunk(offset);
      totalSkipped += skipped;
      offset = end;
      if (offset < stockListTotal) {
        writeChunkProgress(todayStr, offset, stockListTotal);
        await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 500)));
      } else {
        clearIbdrsChunkProgress();
      }
      onProgress({
        phase: 'fetch',
        done: offset,
        total: stockListTotal,
        msg: `本段完成 ${offset}/${stockListTotal}（${batchIndex}/${batchTotal}）`,
        ...listMeta,
      });
    }
  } else {
    const { end, skipped, batchIndex, batchTotal } = await runOneChunk(offset);
    totalSkipped += skipped;
    offset = end;
    if (offset < stockListTotal) {
      writeChunkProgress(todayStr, offset, stockListTotal);
      onProgress({
        phase: 'done',
        done: offset,
        total: stockListTotal,
        msg: `本批完成 ${offset}/${stockListTotal}，請再按「同步」繼續（第 ${batchIndex}/${batchTotal} 批）`,
        validRankedCount: 0,
        skippedYahooCount: totalSkipped,
        chunkContinues: true,
        chunkProgress: { done: offset, total: stockListTotal, batchIndex, batchTotal },
        ...listMeta,
      });
      return { ranked: null, chunkContinues: true, chunkProgress: { done: offset, total: stockListTotal } };
    }
    clearIbdrsChunkProgress();
  }

  existingMap = await readExistingRsData();
  const fin = await runFinalizePhases(stockList, stockListTotal, todayStr, existingMap, onProgress, listMeta, {
    skippedYahooCount: totalSkipped,
    signal,
  });

  return { ...fin, chunkContinues: false, skippedYahooCount: totalSkipped };
}

// ── 歷史 RS 回填 ─────────────────────────────────────────────────────────────

/** 全市場回填預設：單檔串行 + 長間隔，夜間長跑較不易觸發 Yahoo／proxy 限流 */
export const IBDRS_BACKFILL_DEFAULT_CONCURRENCY = 1;
/** 每批（每 concurrency 檔）完成後，到下一批前的基礎等待（毫秒） */
export const IBDRS_BACKFILL_DEFAULT_DELAY_MS = 4500;
/** 上列等待再隨機加 0～此值，打散同步請求節奏 */
export const IBDRS_BACKFILL_DEFAULT_DELAY_JITTER_MS = 1400;
/** Yahoo chart 重試底延遲（回填時拉高） */
export const IBDRS_BACKFILL_YAHOO_BASE_DELAY_MS = 1200;

/**
 * 回填歷史 RS Rating 到每檔股票的 ibdRsHistory。
 *
 * 流程：
 *   Phase 1 (fetch)  每批 concurrency 檔（預設 1 檔串行），Yahoo→Finmind fallback，delay+jitter 防限流
 *   Phase 2 (rank)   純 JS：對每個過去交易日做全市場百分位排名
 *   Phase 3 (write)  合併寫入 Firestore（不覆蓋現有日期，merge=true）
 *
 * @param {boolean} [onlyFirstTradingWeek] 只回填區間內最早 7 個交易日（試跑）
 * @param {number|null} [stockLimit] 只處理清單前 N 檔（試跑；RS 為這 N 檔內相對排名，非全市場）
 * @param {number} [delayJitterMs]  每批間隔額外隨機 0～此值（毫秒）
 * @param {number} [yahooBaseDelayMs]  傳給 Yahoo chart 重試的 baseDelayMs（回填建議較高）
 * @param {AbortSignal} [signal]  傳入 AbortController.signal 可隨時取消
 */
export async function runIbdRsHistoryBackfill({
  onProgress = () => {},
  concurrency = IBDRS_BACKFILL_DEFAULT_CONCURRENCY,
  delayMs = IBDRS_BACKFILL_DEFAULT_DELAY_MS,
  delayJitterMs = IBDRS_BACKFILL_DEFAULT_DELAY_JITTER_MS,
  yahooBaseDelayMs = IBDRS_BACKFILL_YAHOO_BASE_DELAY_MS,
  daysBack = 180,
  onlyFirstTradingWeek = false,
  stockLimit = null,
  signal = null,
} = {}) {
  const todayStr = getTaiwanYmd();

  const checkAbort = () => {
    if (signal?.aborted) throw new Error('已取消');
  };

  // ── Phase 0: 股票清單 ────────────────────────────────────────────────────
  onProgress({ phase: 'list', done: 0, total: 0, msg: '抓取股票清單…' });
  const fullStockList = await fetchTaiwanStockList();
  const fullListCount = fullStockList.length;
  if (fullListCount === 0) {
    onProgress({ phase: 'error', done: 0, total: 0, msg: '無法取得台股清單' });
    throw new Error('無法取得台股清單');
  }

  let stockList = fullStockList;
  if (stockLimit != null && Number.isFinite(stockLimit) && stockLimit > 0) {
    const n = Math.min(Math.floor(stockLimit), fullListCount);
    stockList = fullStockList.slice(0, n);
  }
  const N = stockList.length;

  // 與全市場同步一致：錨點用台北日曆加減「日曆天」再取價（股價序列鍵仍為交易日）
  const backfillStartStr = taipeiYmdAddDays(todayStr, -daysBack) ?? todayStr;

  onProgress({
    phase: 'list',
    done: N,
    total: N,
    msg:
      stockLimit != null && Number.isFinite(stockLimit) && stockLimit > 0
        ? `試跑 ${N} 檔（清單共 ${fullListCount}）· 區間 ${backfillStartStr} ～ ${todayStr}`
        : `共 ${N} 檔，回填區間 ${backfillStartStr} ～ ${todayStr}`,
  });

  // ── Phase 1: 抓股價（Yahoo primary → Finmind fallback） ──────────────────
  // 需要足夠回溯：最早錨點在 daysBack 天前，P12 再往前推 12 個月 → 需 14 個月 + daysBack/30
  const lookbackMonths = 14 + Math.ceil(daysBack / 30);
  const priceEnd = todayStr;
  // 以天數近似「往前 lookbackMonths 個曆月」，避免 setMonth + toISOString 與台北日不一致
  const priceStartDaysApprox = Math.ceil(lookbackMonths * 30.5) + 5;
  const priceStart = taipeiYmdAddDays(todayStr, -priceStartDaysApprox) ?? todayStr;

  const priceMapByStock = {};
  let fetchDone = 0;

  for (let i = 0; i < N; i += concurrency) {
    checkAbort();
    const batch = stockList.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (stock) => {
        try {
          const pm = await fetchYahooHistoricalPriceMap(stock.id, priceStart, priceEnd, {
            market: stock.market,
            yahooBaseDelayMs,
            yahooMaxRetries: 10,
          });
          if (pm && Object.keys(pm).length > 0) {
            priceMapByStock[stock.id] = pm;
          } else {
            await new Promise((r) => setTimeout(r, 450 + Math.floor(Math.random() * 350)));
            const pm2 = await fetchHistoricalPriceMap(stock.id, priceStart, priceEnd);
            if (pm2 && Object.keys(pm2).length > 0) priceMapByStock[stock.id] = pm2;
          }
        } catch (e) {
          console.warn(`[Backfill] ${stock.id} 抓取失敗:`, e.message);
        }
        fetchDone++;
        onProgress({ phase: 'fetch', done: fetchDone, total: N, msg: stock.id });
      })
    );

    if (i + concurrency < N) {
      const jitter = delayJitterMs > 0 ? Math.floor(Math.random() * delayJitterMs) : 0;
      await new Promise((r) => setTimeout(r, delayMs + jitter));
    }
  }

  checkAbort();

  // ── Phase 2: 計算每個交易日的全市場排名 ──────────────────────────────────
  onProgress({ phase: 'rank', done: 0, total: 1, msg: '分析交易日清單…' });

  const tradingDates = new Set();
  for (const pm of Object.values(priceMapByStock)) {
    for (const d of Object.keys(pm)) {
      if (d >= backfillStartStr && d < todayStr) tradingDates.add(d);
    }
  }
  let sortedDates = [...tradingDates].sort();
  if (onlyFirstTradingWeek && sortedDates.length > 7) {
    sortedDates = sortedDates.slice(0, 7);
    onProgress({
      phase: 'rank',
      done: 0,
      total: 1,
      msg: `試跑模式：僅最早 7 個交易日（${sortedDates[0]}～${sortedDates[sortedDates.length - 1]}）`,
    });
  }
  const D = sortedDates.length;

  if (D === 0) {
    onProgress({ phase: 'done', done: N, total: N, msg: '無可回填的交易日（股價資料不足）' });
    return { stockCount: 0, dateCount: 0 };
  }

  onProgress({ phase: 'rank', done: 0, total: D, msg: `${D} 個交易日，開始計算排名…` });

  // historyByStock[id] = [{ d, r }]
  const historyByStock = {};

  for (let di = 0; di < D; di++) {
    checkAbort();
    const dateStr = sortedDates[di];

    const rawItems = stockList
      .filter((s) => priceMapByStock[s.id])
      .map((s) => ({
        id: s.id,
        rsRaw: calculateRsRaw(priceMapByStock[s.id], dateStr),
      }));

    const ranked = assignRsRatings(rawItems);

    for (const { id, ibdRsRating } of ranked) {
      if (ibdRsRating == null) continue;
      if (!historyByStock[id]) historyByStock[id] = [];
      historyByStock[id].push({ d: dateStr, r: ibdRsRating });
    }

    if (di % 20 === 0 || di === D - 1) {
      onProgress({ phase: 'rank', done: di + 1, total: D, msg: dateStr });
      // 讓 event loop 喘口氣（避免 UI 凍結）
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  checkAbort();

  // ── Phase 3: 讀現有資料 → 合併 → 寫入 Firestore ─────────────────────────
  onProgress({ phase: 'write', done: 0, total: N, msg: '讀取現有 Firestore 資料…' });
  const existingMap = await readExistingRsData();

  const stockIds = Object.keys(historyByStock);
  const writeTotal = stockIds.length;
  let writeDone = 0;

  for (let i = 0; i < writeTotal; i += 10) {
    checkAbort();
    const batch = stockIds.slice(i, i + 10);

    await Promise.all(
      batch.map(async (stockId) => {
        const newPoints = historyByStock[stockId] || [];
        if (newPoints.length === 0) { writeDone++; return; }

        const existing = existingMap[stockId] ?? {};
        const prevHistory = Array.isArray(existing.ibdRsHistory)
          ? existing.ibdRsHistory
          : [];
        const existingDates = new Set(prevHistory.map((h) => h.d));
        const toAdd = newPoints.filter((p) => !existingDates.has(p.d));

        if (toAdd.length === 0) { writeDone++; return; }

        const merged = [...prevHistory, ...toAdd]
          .sort((a, b) => (a.d < b.d ? -1 : 1))
          .slice(-RS_HISTORY_MAX);

        await setDoc(
          doc(RS_RATINGS_COLLECTION, stockId),
          { ibdRsHistory: merged },
          { merge: true }
        );
        writeDone++;
      })
    );

    onProgress({ phase: 'write', done: writeDone, total: writeTotal, msg: `寫入 ${writeDone}/${writeTotal}` });

    if (i + 10 < writeTotal) {
      await new Promise((r) => setTimeout(r, 280 + Math.floor(Math.random() * 280)));
    }
  }

  onProgress({
    phase: 'done',
    done: N,
    total: N,
    msg: `回填完成！${stockIds.length} 檔 × ${D} 個交易日`,
  });

  return { stockCount: stockIds.length, dateCount: D };
}

/**
 * 同步單一股票（測試用）：抓價 → 與現有全市場排名 → 寫入 Firestore
 */
export async function syncSingleStock(stockId, market, onProgress = () => {}) {
  const todayStr = getTaiwanYmd();

  onProgress({ phase: 'list', done: 0, total: 1, msg: `查詢 ${stockId}…` });
  const stockList = await fetchTaiwanStockList();
  const info = stockList.find((s) => s.id === stockId);
  const name = info?.name || stockId;
  const mkt = market || info?.market || 'TPEX';

  onProgress({ phase: 'fetch', done: 0, total: 1, msg: `抓取 ${stockId} ${name} 股價…` });
  const priceMap = await fetchRsPriceData(stockId, mkt);
  const rsRaw = calculateRsRaw(priceMap, todayStr);
  const anchor7Str = taipeiYmdAddDays(todayStr, -7);
  const anchor30Str = taipeiYmdAddDays(todayStr, -30);
  const rsRaw7 = anchor7Str ? calculateRsRaw(priceMap, anchor7Str) : null;
  const rsRaw30 = anchor30Str ? calculateRsRaw(priceMap, anchor30Str) : null;
  const pricePct1d = calcPriceChangePct(priceMap, todayStr, 1);
  const pricePct5d = calcPriceChangePct(priceMap, todayStr, 5);
  const pricePct20d = calcPriceChangePct(priceMap, todayStr, 20);
  const pricePos6m = calcPricePosition6m(priceMap, todayStr);
  const { price: ibdRsLastClose, dateStr: ibdRsLastCloseDate } = getLatestCloseInPriceMap(priceMap, todayStr);

  let rating = null;
  const priceDays = Object.keys(priceMap).length;

  if (rsRaw != null) {
    onProgress({ phase: 'rank', done: 0, total: 1, msg: `rsRaw=${rsRaw.toFixed(4)}，與全市場排名…` });
    const existingMap = await readExistingRsData();
    const pool = Object.entries(existingMap)
      .filter(([id]) => id !== stockId)
      .map(([id, ex]) => ({ id, rsRaw: ex.ibdRsRaw ?? null }));
    pool.push({ id: stockId, rsRaw });
    const validCount = pool.filter((s) => s.rsRaw != null && isFinite(s.rsRaw)).length;
    onProgress({ phase: 'rank', done: 0, total: 1, msg: `pool ${pool.length} 檔，有 rsRaw ${validCount} 檔` });
    const ranked = assignRsRatings(pool);
    rating = ranked.find((r) => r.id === stockId)?.ibdRsRating ?? null;
  } else {
    onProgress({ phase: 'rank', done: 0, total: 1, msg: `股價 ${priceDays} 天，不足 12 個月 → RS=—` });
  }

  onProgress({ phase: 'write', done: 0, total: 1, msg: `寫入 ${stockId} RS=${rating ?? '—'}…` });
  const existingDoc = (await readExistingRsData())[stockId] ?? {};
  const prevHistory = Array.isArray(existingDoc.ibdRsHistory) ? existingDoc.ibdRsHistory : [];
  const anchorStr = historyAnchorYmd(todayStr);
  const withoutSlot = prevHistory.filter((h) => historyAnchorYmd(h.d) !== anchorStr);
  const newHistory = rating != null
    ? [...withoutSlot, { d: anchorStr, r: rating }].sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-RS_HISTORY_MAX)
    : prevHistory;

  await setDoc(
    doc(RS_RATINGS_COLLECTION, stockId),
    {
      id: stockId,
      name,
      market: mkt,
      ibdRsRating: rating,
      ibdRsUpdatedDate: todayStr,
      ibdRsSnapshotDate: todayStr,
      ibdRsRaw: rsRaw,
      ibdRsRaw7: rsRaw7,
      ibdRsRaw30: rsRaw30,
      ibdRsHistory: newHistory,
      ibdRsDelta7d: null,
      ibdRsDelta30d: null,
      ibdRsPriceFetchedDate: todayStr,
      pricePct1d,
      pricePct5d,
      pricePct20d,
      pricePos6m,
      ibdRsLastClose,
      ibdRsLastCloseDate,
      updatedAt: Date.now(),
    },
    { merge: true }
  );

  const rsLabel = rating != null ? `RS=${rating}` : `RS=—（股價${priceDays}天）`;
  onProgress({ phase: 'done', done: 1, total: 1, msg: `✅ ${stockId} ${name} ${rsLabel} 已寫入` });
  return { id: stockId, name, market: mkt, ibdRsRating: rating, rsRaw, priceDays };
}

/**
 * 測試用：只抓 count 檔缺資料的股票 → 寫入 Firestore → 全市場 finalize（排名 + delta）
 * 回傳 { processed, needsWorkTotal }
 */
export async function syncTestBatch({ count = 10, onProgress = () => {}, signal } = {}) {
  const todayStr = getTaiwanYmd();
  const anchor7Str = taipeiYmdAddDays(todayStr, -7);
  const anchor30Str = taipeiYmdAddDays(todayStr, -30);

  onProgress({ phase: 'list', done: 0, total: 0, msg: '載入清單…' });
  const stockList = await fetchTaiwanStockList();
  const existingMap = await readExistingRsData();
  const twseCount = stockList.filter((s) => s.market === 'TWSE').length;
  const tpexCount = stockList.filter((s) => s.market === 'TPEX').length;
  const listMeta = { twseCount, tpexCount, listTotal: stockList.length };

  const needsWork = stockList.filter((s) => {
    const ex = existingMap[s.id];
    if (!ex) return true;
    if (ex.ibdRsRaw == null || ex.ibdRsRaw7 == null || ex.ibdRsRaw30 == null) return true;
    if (ex.pricePct5d == null || ex.pricePct20d == null) return true;
    if (typeof ex.pricePos6m !== 'number' || !Number.isFinite(ex.pricePos6m)) return true;
    return false;
  });
  const batch = needsWork.slice(0, count);
  const total = batch.length;
  const needsWorkTotal = needsWork.length;

  onProgress({
    phase: 'list', done: 0, total,
    msg: `需補資料 ${needsWorkTotal} 檔，本次處理 ${total} 檔`,
    ...listMeta,
  });

  let processed = 0;
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new Error('已取消');
    const stock = batch[i];
    onProgress({ phase: 'fetch', done: i, total, msg: `${stock.id} ${stock.name}`, ...listMeta });
    try {
      const priceMap = await fetchRsPriceData(stock.id, stock.market);
      const rsRaw = calculateRsRaw(priceMap, todayStr);
      const rsRaw7 = anchor7Str ? calculateRsRaw(priceMap, anchor7Str) : null;
      const rsRaw30 = anchor30Str ? calculateRsRaw(priceMap, anchor30Str) : null;
      const pricePct1d = calcPriceChangePct(priceMap, todayStr, 1);
      const pricePct5d = calcPriceChangePct(priceMap, todayStr, 5);
      const pricePct20d = calcPriceChangePct(priceMap, todayStr, 20);
      const pricePos6m = calcPricePosition6m(priceMap, todayStr);
      const { price: ibdRsLastClose, dateStr: ibdRsLastCloseDate } = getLatestCloseInPriceMap(priceMap, todayStr);

      const existingDoc = existingMap[stock.id] ?? {};
      const prevHistory = Array.isArray(existingDoc.ibdRsHistory) ? existingDoc.ibdRsHistory : [];

      await setDoc(doc(RS_RATINGS_COLLECTION, stock.id), {
        id: stock.id, name: stock.name, market: stock.market,
        ibdRsRating: existingDoc.ibdRsRating ?? null,
        ibdRsRaw: rsRaw, ibdRsRaw7: rsRaw7, ibdRsRaw30: rsRaw30,
        ibdRsHistory: prevHistory,
        pricePct1d, pricePct5d, pricePct20d,
        pricePos6m,
        ibdRsLastClose,
        ibdRsLastCloseDate,
        ibdRsPriceFetchedDate: todayStr,
        ibdRsUpdatedDate: todayStr,
        ibdRsSnapshotDate: todayStr,
        updatedAt: Date.now(),
      }, { merge: true });
      processed++;
    } catch (e) {
      console.warn(`[RS TestBatch] ${stock.id} 失敗:`, e.message);
    }
    if (i + 1 < total) {
      await new Promise((r) => setTimeout(r, 2200 + Math.floor(Math.random() * 600)));
    }
  }

  onProgress({ phase: 'rank', done: 0, total: 1, msg: '全市場重新排名 + Delta…', ...listMeta });
  const result = await finalizeIbdrsRankingFromFirestore({ onProgress });
  return { ...result, processed, needsWorkTotal };
}
