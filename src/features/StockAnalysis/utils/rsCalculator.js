/* src/features/StockAnalysis/utils/rsCalculator.js */

/**
 * IBD RS Rating 計算工具
 *
 * 公式：RS_raw = [(P0-P3)*2 + (P3-P6) + (P6-P9) + (P9-P12)] / P12
 * 數學化簡：(2*P0 - P3 - P12) / P12
 *
 * 然後對全體股票做百分位線性排名 → 1..99
 * (rank 1 最低 → RS=1, rank N 最高 → RS=99)
 */

/**
 * 找到 targetDateStr (YYYY-MM-DD) 當天或之前最近的收盤價
 * priceMap: { 'YYYY-MM-DD': number }
 */
export function findClosestPriceBefore(priceMap, targetDateStr) {
  if (!priceMap || typeof priceMap !== 'object') return null;
  const dates = Object.keys(priceMap).sort();
  let result = null;
  for (const d of dates) {
    if (d <= targetDateStr) result = priceMap[d];
    else break;
  }
  return result;
}

/**
 * 計算單一股票的 RS_raw
 * priceMap: { 'YYYY-MM-DD': number }（來自 fetchYahooHistoricalPriceMap）
 * anchorDateStr: YYYY-MM-DD，通常為今天台北時間
 *
 * 缺少任何錨點 (P0/P3/P6/P9/P12) 則回傳 null（此股不參與排名）
 */
export function calculateRsRaw(priceMap, anchorDateStr) {
  const anchor = new Date(anchorDateStr + 'T12:00:00');

  const getMonthsAgo = (months) => {
    const d = new Date(anchor);
    d.setMonth(d.getMonth() - months);
    return d.toISOString().slice(0, 10);
  };

  const P0 = findClosestPriceBefore(priceMap, anchorDateStr);
  const P3 = findClosestPriceBefore(priceMap, getMonthsAgo(3));
  const P6 = findClosestPriceBefore(priceMap, getMonthsAgo(6));
  const P9 = findClosestPriceBefore(priceMap, getMonthsAgo(9));
  const P12 = findClosestPriceBefore(priceMap, getMonthsAgo(12));

  if (P0 == null || P3 == null || P6 == null || P9 == null || P12 == null || P12 === 0) {
    return null;
  }

  return ((P0 - P3) * 2 + (P3 - P6) + (P6 - P9) + (P9 - P12)) / P12;
}

/**
 * 對所有股票分配 RS Rating (1-99)（百分位線性縮放）
 * Input:  [{ id: string, rsRaw: number | null, ...rest }]
 * Output: 同陣列，每個物件加上 ibdRsRating: number | null
 *
 * 平手 (tie) 處理：穩定排序，各自拿到對應線性分數（不強制同分）
 * 上市不滿 12 個月 (rsRaw=null) 的股票 ibdRsRating=null，不出現在排名中
 */
export function assignRsRatings(stocks) {
  const valid = stocks.filter((s) => s.rsRaw != null && isFinite(s.rsRaw));
  const N = valid.length;

  if (N === 0) return stocks.map((s) => ({ ...s, ibdRsRating: null }));
  if (N === 1) return stocks.map((s) => (s.rsRaw != null ? { ...s, ibdRsRating: 50 } : { ...s, ibdRsRating: null }));

  // 升冪排序（rsRaw 最低 → 排名最低 → RS=1）
  const sorted = [...valid].sort((a, b) => a.rsRaw - b.rsRaw);

  const ratingMap = {};
  sorted.forEach((s, i) => {
    // rank 0-based: i=0 → RS=1, i=N-1 → RS=99
    ratingMap[s.id] = Math.max(1, Math.min(99, Math.round(1 + (i / (N - 1)) * 98)));
  });

  return stocks.map((s) => ({
    ...s,
    ibdRsRating: ratingMap[s.id] ?? null,
  }));
}

/** 台北時區今日 YYYY-MM-DD（與 ibdRsUpdatedDate / Firestore 一致） */
export function getTaipeiYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

/**
 * 台北日曆 YYYY-MM-DD 加減自然日（不依賴瀏覽器本地時區）
 */
export function taipeiYmdAddDays(ymd, deltaDays) {
  const [y, m, d] = String(ymd || '')
    .slice(0, 10)
    .split('-')
    .map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 台北日曆該日為週幾（0=日 … 6=六）。
 * 以該日 Asia/Taipei 中午對應之 UTC 時刻計算，避免與 UTC 日界線混淆。
 */
export function getTaipeiWeekdayFromYmd(ymd) {
  const [y, m, d] = String(ymd || '')
    .slice(0, 10)
    .split('-')
    .map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0)).getUTCDay();
}

/**
 * 將 YYYY-MM-DD 對齊到「台股有交易的曆日」：若為週六／週日則回推到上一個週五。
 * （國定假日未排除；僅處理週末。）
 */
export function normalizeYmdToTaiwanTradingDay(ymd) {
  if (!ymd) return null;
  let cur = String(ymd).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cur)) return null;
  for (let i = 0; i < 5; i++) {
    const w = getTaipeiWeekdayFromYmd(cur);
    if (w == null) return null;
    if (w !== 0 && w !== 6) return cur;
    const prev = taipeiYmdAddDays(cur, -1);
    if (!prev) return null;
    cur = prev;
  }
  return cur;
}

/** 台股「一週」在 RS 歷史筆數上視為 5 個交易日（週一～週五） */
export const IBDRS_TRADING_DAYS_PER_WEEK = 5;

/**
 * 計算 N 個**交易日**前的 RS delta（當前 RS − 參考日 RS）
 * ibdRsHistory：依日期排序後，自「今日或之前最近一筆」往前數第 N 筆（不含當前錨點本身則再往前）。
 *
 * 定義：錨點索引 = 最後一筆 d ≤ 今日之索引；參考索引 = 錨點 − N（N≥1）；delta = ibdRsRating − sorted[參考].r
 * 資料不足時回傳 null（歷史筆數須 > N）
 */
export function calcRsDelta(ibdRsRating, ibdRsHistory, tradingDaysAgo) {
  if (ibdRsRating == null || !Array.isArray(ibdRsHistory) || ibdRsHistory.length === 0) {
    return null;
  }
  const n = parseInt(String(tradingDaysAgo), 10);
  if (!Number.isFinite(n) || n < 1) return null;

  const todayStr = getTaipeiYmd();
  const sorted = [...ibdRsHistory]
    .filter((e) => e && e.d && typeof e.r === 'number')
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (sorted.length === 0) return null;

  let anchorIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].d <= todayStr) anchorIdx = i;
    else break;
  }
  if (anchorIdx < 0) return null;

  const refIdx = anchorIdx - n;
  if (refIdx < 0) return null;
  return ibdRsRating - sorted[refIdx].r;
}

/**
 * 計算股票近 nTradingDays 個交易日的價格漲跌幅（%）
 * priceMap: { 'YYYY-MM-DD': number }
 * anchorDateStr: 基準日（通常為今日）
 * nTradingDays: 幾個交易日前的價格作為基準（e.g. 5 or 20）
 */
export function calcPriceChangePct(priceMap, anchorDateStr, nTradingDays) {
  if (!priceMap || typeof priceMap !== 'object') return null;
  const dates = Object.keys(priceMap)
    .filter((d) => d <= anchorDateStr)
    .sort();
  if (dates.length <= nTradingDays) return null;
  const current = priceMap[dates[dates.length - 1]];
  const past = priceMap[dates[dates.length - 1 - nTradingDays]];
  if (current == null || past == null || past === 0) return null;
  return ((current - past) / past) * 100;
}

/**
 * 近六個月（自 anchor 往前推 6 個曆月）區間內之最高／最低收盤，
 * 以及當前價在 [low, high] 的線性位置：低點=0、高點=1。
 * 僅使用 priceMap 內之日期鍵（YYYY-MM-DD）。
 */
export function calcPricePosition6m(priceMap, anchorDateStr) {
  if (!priceMap || typeof priceMap !== 'object') return null;
  const anchor = new Date(`${anchorDateStr}T12:00:00`);
  const start = new Date(anchor);
  start.setMonth(start.getMonth() - 6);
  const startStr = start.toISOString().slice(0, 10);
  const dates = Object.keys(priceMap)
    .filter((d) => d >= startStr && d <= anchorDateStr)
    .sort();
  if (dates.length === 0) return null;
  const inRangePrices = dates
    .map((d) => priceMap[d])
    .filter((p) => p != null && p > 0 && Number.isFinite(p));
  if (inRangePrices.length === 0) return null;
  const high = Math.max(...inRangePrices);
  const low = Math.min(...inRangePrices);
  const current = findClosestPriceBefore(priceMap, anchorDateStr);
  if (current == null || !Number.isFinite(current)) return null;
  if (high === low) return null;
  let pos = (current - low) / (high - low);
  if (pos < 0) pos = 0;
  else if (pos > 1) pos = 1;
  return pos;
}

/**
 * 偵測在最近 `tradingDaysWindow` 個**交易日**（以 ibdRsHistory 筆數計）內是否有「向上穿越 level」
 * 定義：連續兩筆 RS 滿足 前 < level、後 ≥ level，且該段落在最近 tradingDaysWindow 個交易日區間內。
 */
export function detectCrossUp(ibdRsRating, ibdRsHistory, level, tradingDaysWindow) {
  if (ibdRsRating == null || !Number.isFinite(level)) return false;
  if (!Array.isArray(ibdRsHistory) || ibdRsHistory.length === 0) return false;

  const w = parseInt(String(tradingDaysWindow), 10);
  if (!Number.isFinite(w) || w < 1) return false;

  const todayStr = getTaipeiYmd();
  const sorted = [...ibdRsHistory]
    .filter((e) => e && e.d && typeof e.r === 'number')
    .sort((a, b) => (a.d < b.d ? -1 : 1));

  const sequence = [...sorted];
  if (sequence.length === 0 || sequence[sequence.length - 1].d !== todayStr) {
    sequence.push({ d: todayStr, r: ibdRsRating });
  }

  const tail = sequence.slice(-(w + 1));
  if (tail.length < 2) return false;

  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1].r;
    const cur = tail[i].r;
    if (prev < level && cur >= level) return true;
  }
  return false;
}

/**
 * 近 K「週」＝ K × IBDRS_TRADING_DAYS_PER_WEEK（5）個**交易日**（ibdRsHistory 筆數）內 RS 區間統計。
 * @returns {{ maxR: number, gap: number, isNewHigh: boolean, weeksK: number } | null}
 */
export function getRsKWeeksRsHighStats(ibdRsHistory, effectiveRs, weeksK) {
  if (effectiveRs == null || !Number.isFinite(effectiveRs) || weeksK < 1) return null;
  if (!Array.isArray(ibdRsHistory) || ibdRsHistory.length === 0) return null;

  const todayStr = getTaipeiYmd();
  const n = weeksK * IBDRS_TRADING_DAYS_PER_WEEK;

  const sorted = [...ibdRsHistory]
    .filter((e) => e?.d && typeof e.r === 'number' && Number.isFinite(e.r))
    .sort((a, b) => (a.d < b.d ? -1 : 1));

  let anchorIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].d <= todayStr) anchorIdx = i;
    else break;
  }
  if (anchorIdx < 0) return null;

  const startIdx = Math.max(0, anchorIdx - n + 1);
  const window = sorted.slice(startIdx, anchorIdx + 1);
  const rsInWindow = window.map((e) => e.r);
  if (rsInWindow.length === 0) return null;
  rsInWindow[rsInWindow.length - 1] = effectiveRs;

  const maxR = Math.max(...rsInWindow);
  const gap = maxR - effectiveRs;
  return {
    maxR,
    gap,
    isNewHigh: effectiveRs === maxR,
    weeksK,
  };
}

/**
 * 近 K「週」＝ K×5 交易日內，「當前 RS」是否為該區間內 RS 最高（平手亦算新高）。
 * effectiveRs：與頁面一致（ibdRsRating 或歷史最後一筆）。
 */
export function isRsKWeeksNewHigh(ibdRsHistory, effectiveRs, weeksK) {
  const s = getRsKWeeksRsHighStats(ibdRsHistory, effectiveRs, weeksK);
  return s != null && s.isNewHigh;
}

/** VCP 價格項權重（與成交量項互補） */
export const VCP_WEIGHT_PRICE = 0.7;
/** VCP 成交量項權重 */
export const VCP_WEIGHT_VOLUME = 0.3;

/**
 * VCP 價格項：近 10 個交易日最大單日 |報酬| ÷ 近 40 個交易日最大單日 |報酬|（收盤價），0～1。
 */
export function calcVcpPriceRatioFromCloseMap(priceMap, anchorDateStr) {
  if (!priceMap || typeof priceMap !== 'object') return null;
  const dates = Object.keys(priceMap)
    .filter((d) => d <= anchorDateStr)
    .sort();
  if (dates.length < 41) return null;
  const last41 = dates.slice(-41);
  const closes = last41.map((d) => priceMap[d]).filter((p) => p != null && p > 0 && Number.isFinite(p));
  if (closes.length !== 41) return null;
  const dayAmp = (p0, p1) => Math.abs(p1 - p0) / p0;
  const amps40 = [];
  for (let i = 1; i < 41; i++) {
    amps40.push(dayAmp(closes[i - 1], closes[i]));
  }
  const max40 = Math.max(...amps40);
  const last11 = closes.slice(-11);
  const amps10 = [];
  for (let i = 1; i < 11; i++) {
    amps10.push(dayAmp(last11[i - 1], last11[i]));
  }
  const max10 = Math.max(...amps10);
  if (max40 === 0) return max10 === 0 ? 1 : null;
  const ratio = max10 / max40;
  if (!Number.isFinite(ratio)) return null;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * VCP 成交量項：近 10 日均量 ÷ 近 40 日均量（同一 volumeMap 交易日序列），0～1。
 */
export function calcVcpVolumeRatioFromVolumeMap(volumeMap, anchorDateStr) {
  if (!volumeMap || typeof volumeMap !== 'object') return null;
  const dates = Object.keys(volumeMap)
    .filter((d) => d <= anchorDateStr)
    .sort();
  if (dates.length < 40) return null;
  const last40 = dates.slice(-40);
  const vols = last40.map((d) => volumeMap[d]);
  if (vols.some((v) => v == null || !Number.isFinite(v) || v < 0)) return null;
  const last10 = vols.slice(-10);
  const avg10 = last10.reduce((a, b) => a + b, 0) / 10;
  const avg40 = vols.reduce((a, b) => a + b, 0) / 40;
  if (avg40 === 0) return avg10 === 0 ? 1 : null;
  const ratio = avg10 / avg40;
  if (!Number.isFinite(ratio)) return null;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * 加權 VCP：價格項×0.7 + 成交量項×0.3；任一分項為 null 則整體為 null。
 */
export function calcCompositeVcp(priceRatio, volumeRatio, wPrice = VCP_WEIGHT_PRICE, wVolume = VCP_WEIGHT_VOLUME) {
  if (priceRatio == null || volumeRatio == null) return null;
  if (!Number.isFinite(priceRatio) || !Number.isFinite(volumeRatio)) return null;
  return wPrice * priceRatio + wVolume * volumeRatio;
}
