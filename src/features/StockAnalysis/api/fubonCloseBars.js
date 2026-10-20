/**
 * 富邦收盤 K 棒（Mac 收盤後由 temp_scripts/20261020_fubon_close_bars_tmp.py 寫入 ibdRsMeta/fubonCloseBars_YYYYMMDD）。
 *
 * RS 同步用法：每檔「既有 Firestore 歷史 + 今日富邦一根」取代 Yahoo 全段重抓，每日 Yahoo 請求約 2,300 次 → 約 230 次（輪值＋例外檔）。
 * 任一條件不符就回傳 null，呼叫端照舊走 Yahoo：
 *   - 當日文件不存在／格式不對（Mac 沒開、沒跑到）
 *   - 該檔今日無收盤（暫停交易、新上市）或無既有歷史
 *   - 近 15 天有除權（類型含「權」）或股本變動（Yahoo 會追溯調整整段歷史，只接一根會斷層）
 *   - 既有歷史最後一天不是前一交易日（中間漏天），或該日收盤與富邦昨收對不上
 *   - 輪值日：每檔每 10 個交易日輪到一次 Yahoo 全段重抓。富邦除權息資料不完整
 *     （8487、5274 的配股 Yahoo 有追溯調整、富邦查無），靠輪值在兩週內把漏網的調整補回來
 */
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../../../utils/firebaseConfig';

const SCHEMA_VERSION = 2;
/** 富邦快照 tradeVolume 單位為「張」；既有歷史（Yahoo）為「股」 */
const SHARES_PER_LOT = 1000;
const OHLCV_KEEP_DAYS = 120;
/** 每檔每 N 個交易日輪值走一次 Yahoo（約 1/N 市場、每日 ~230 次） */
const YAHOO_ROTATION_DAYS = 10;
/** 既有歷史前一交易日收盤 vs 富邦昨收，允許的相對誤差（Yahoo float 雜訊與四捨五入） */
const PREV_CLOSE_TOLERANCE = 0.002;

/**
 * 讀取當日富邦收盤 K 棒；任何錯誤都回傳 null（讓同步退回 Yahoo，不中斷）。
 * @returns {Promise<null | { date: string, bars: Record<string, number[]>, eventSymbols: Set<string>, prevTradingDay: string|null }>}
 */
export async function loadFubonCloseBars(todayStr) {
  try {
    const snap = await getDoc(doc(db, 'ibdRsMeta', `fubonCloseBars_${todayStr.replace(/-/g, '')}`));
    if (!snap.exists()) return null;
    const payload = JSON.parse(snap.data()?.json || 'null');
    if (!payload || payload.schema !== SCHEMA_VERSION || payload.date !== todayStr) return null;
    if (payload.volumeUnit !== 'lots' || !payload.bars) return null;
    // 股本變動清單抓失敗時無法排除減資股 → 整份不用
    if (payload.capitalChangesOk === false) return null;
    const days = Array.isArray(payload.tradingDays) ? payload.tradingDays : [];
    const idx = days.indexOf(todayStr);
    return {
      date: todayStr,
      bars: payload.bars,
      eventSymbols: new Set(Object.keys(payload.eventSymbols || {})),
      prevTradingDay: idx > 0 ? days[idx - 1] : null,
      rotationSlot: rotationSlotForDate(todayStr),
    };
  } catch (e) {
    console.warn('[RS] 富邦收盤 K 棒讀取失敗，改用 Yahoo:', e?.message || e);
    return null;
  }
}

function rotationSlotForDate(ymd) {
  // 以日曆日序號取模即可（週末不跑同步，各檔仍約每兩週輪到一次）
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86400000) % YAHOO_ROTATION_DAYS;
}

function rotationSlotForStock(stockId) {
  let h = 0;
  for (const ch of String(stockId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % YAHOO_ROTATION_DAYS;
}

function latestDateBefore(map, todayStr) {
  let best = null;
  for (const d of Object.keys(map || {})) {
    if (d < todayStr && (best === null || d > best)) best = d;
  }
  return best;
}

function withTodayTrimmed(map, todayStr, value, keep) {
  const out = { ...(map || {}), [todayStr]: value };
  if (!keep) return out;
  const keys = Object.keys(out).sort();
  if (keys.length <= keep) return out;
  const trimmed = {};
  for (const k of keys.slice(-keep)) trimmed[k] = out[k];
  return trimmed;
}

/**
 * 以既有 ibdRsRatings 文件 + 今日富邦 K 棒組出與 fetchRsPriceData 相同形狀的資料；不適用回傳 null。
 * 價格未四捨五入，由呼叫端統一 roundPriceMap。
 */
export function buildRsPriceDataFromFubon(stockId, existing, ctx) {
  if (!ctx || !existing || !ctx.prevTradingDay) return null;
  if (ctx.eventSymbols.has(stockId)) return null;
  if (ctx.rotationSlot != null && rotationSlotForStock(stockId) === ctx.rotationSlot) return null;
  const bar = ctx.bars[stockId];
  if (!Array.isArray(bar)) return null;
  const [open, high, low, close, lots, prevClose] = bar;
  if (!(close > 0) || !(open > 0) || !(high > 0) || !(low > 0) || !Number.isFinite(lots)) return null;

  const todayStr = ctx.date;
  const maps = {
    priceMap: existing.priceMap,
    volumeMap: existing.volumeMap,
    openMap: existing.openMap,
    highMap: existing.highMap,
    lowMap: existing.lowMap,
  };
  for (const m of Object.values(maps)) {
    if (!m || latestDateBefore(m, todayStr) !== ctx.prevTradingDay) return null;
  }
  // 既有歷史的前一日收盤要與富邦昨收一致（不一致＝歷史已被調整或資料有誤 → 交給 Yahoo 全段重抓）
  const storedPrev = maps.priceMap[ctx.prevTradingDay];
  if (!(prevClose > 0) || !(storedPrev > 0) || Math.abs(storedPrev - prevClose) / prevClose > PREV_CLOSE_TOLERANCE) return null;

  return {
    priceMap: withTodayTrimmed(maps.priceMap, todayStr, close, 0),
    volumeMap: withTodayTrimmed(maps.volumeMap, todayStr, lots * SHARES_PER_LOT, OHLCV_KEEP_DAYS),
    openMap: withTodayTrimmed(maps.openMap, todayStr, open, OHLCV_KEEP_DAYS),
    highMap: withTodayTrimmed(maps.highMap, todayStr, high, OHLCV_KEEP_DAYS),
    lowMap: withTodayTrimmed(maps.lowMap, todayStr, low, OHLCV_KEEP_DAYS),
  };
}
