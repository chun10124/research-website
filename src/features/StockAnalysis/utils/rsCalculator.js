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
 * 計算 N 自然日前的 RS delta（今日 RS - 參考日 RS）
 * ibdRsHistory: [{ d: 'YYYY-MM-DD', r: number }]（可任意順序）
 * 找「targetDate（今日−N 日，台北日曆）當天或之前最近一筆」作為參考點
 * 資料不足時回傳 null
 *
 * 注意：若僅同步過 1 天，歷史不足時仍為 null（需累積多日同步）
 */
export function calcRsDelta(ibdRsRating, ibdRsHistory, daysAgo) {
  if (ibdRsRating == null || !Array.isArray(ibdRsHistory) || ibdRsHistory.length === 0) {
    return null;
  }

  const todayStr = getTaipeiYmd();
  const targetStr = taipeiYmdAddDays(todayStr, -daysAgo);
  if (!targetStr) return null;

  const sorted = [...ibdRsHistory]
    .filter((e) => e && e.d && typeof e.r === 'number')
    .sort((a, b) => (a.d < b.d ? -1 : 1));

  let prevEntry = null;
  for (const entry of sorted) {
    if (entry.d <= targetStr) prevEntry = entry;
    else break;
  }

  if (!prevEntry) return null;
  return ibdRsRating - prevEntry.r;
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
 * 偵測在最近 daysAgo 自然日內是否有「向上穿越 level」事件
 * 定義：某筆 RS < level，下一筆（在 window 內）RS >= level
 *
 * 回傳 true / false
 */
export function detectCrossUp(ibdRsRating, ibdRsHistory, level, daysAgo) {
  if (ibdRsRating == null || !Number.isFinite(level)) return false;
  if (!Array.isArray(ibdRsHistory) || ibdRsHistory.length === 0) return false;

  const todayStr = getTaipeiYmd();
  const cutoffStr = taipeiYmdAddDays(todayStr, -daysAgo);
  if (!cutoffStr) return false;

  const sorted = [...ibdRsHistory]
    .filter((e) => e && e.d && typeof e.r === 'number')
    .sort((a, b) => (a.d < b.d ? -1 : 1));

  // 補上今日（若 history 尚未包含今日）
  const sequence = [...sorted];
  if (sequence.length === 0 || sequence[sequence.length - 1].d !== todayStr) {
    sequence.push({ d: todayStr, r: ibdRsRating });
  }

  // 找 window 前第一筆（作為前置參考）
  const firstInWindowIdx = sequence.findIndex((e) => e.d >= cutoffStr);
  const startIdx = Math.max(0, firstInWindowIdx - 1);

  for (let i = Math.max(startIdx, 1); i < sequence.length; i++) {
    const prev = sequence[i - 1].r;
    const cur = sequence[i].r;
    // 只計算 window 內的穿越
    if (sequence[i].d >= cutoffStr && prev < level && cur >= level) return true;
  }

  return false;
}
