/* src/features/StockAnalysis/utils/utilityScreen.js */

/**
 * Utility Screen（Minervini 修正期領先股篩選）
 *
 * 概念：大盤修正時多數股票同步下跌，但下一波的領先股在修正期就已展現異常抗跌。
 * 用「距大盤高點的天數」當窗口長度重算區間 RS，就能只看修正期間的相對強度，
 * 不被一年前的漲幅稀釋（現行 12 個月 RS 化簡後為 (2·P0 − P3 − P12)/P12，
 * P12 權重極重，8 個月前噴過、現在走弱的股票仍會掛在高分）。
 *
 * 啟動條件（以加權指數 ^TWII 收盤計）：
 *   D = 指數距「近 200 交易日最高收盤」的交易日數
 *   D ≤ 20   → 不啟動（剛創高或才剛回檔，樣本太短無意義）
 *   20 < D ≤ 200 → 啟動，區間 RS 窗口 = D（每過一個交易日 D 自動 +1）
 *   D > 200  → 不啟動（修正已久，回頭用原本 12 個月 RS 濾網）
 *
 * 區間 RS 採與現行 RS 相同的公式與權重，只把「季」換成 D/4：
 *   Q = max(1, round(D / 4))
 *   raw = [(P0−PQ)×2 + (PQ−P2Q) + (P2Q−P3Q) + (P3Q−PD)] / PD
 * 錨點一律用「交易日索引」往回數（priceMap 排序後的位置），
 * 不用曆月推算，因此沒有 setMonth 在月底的日期漂移問題。
 * （四段展開後 P2Q／P3Q 會telescoping抵銷，等價於 (2·P0 − PQ − PD)/PD；
 *   此處保留完整式以對應規格，數值兩者相同。）
 *
 * 全部指標都由 Firestore 既有的 priceMap（15 個月 ≈ 315 交易日）與
 * volumeMap（120 天）在前端即時算出：不新增任何 Firestore 欄位，也不多打 Yahoo。
 */

import { assignRsRatings } from './rsCalculator';

/** 判斷大盤高點所用的回看交易日數 */
export const UTILITY_INDEX_LOOKBACK = 200;
/** D 需「超過」此天數才啟動 */
export const UTILITY_MIN_DAYS_SINCE_HIGH = 20;
/** D 超過此天數即停用，回到原本 RS 濾網 */
export const UTILITY_MAX_DAYS_SINCE_HIGH = 200;

/** 個股指標的回看窗口（MA200 與 200 日高點共用） */
export const UTILITY_STOCK_LOOKBACK = 200;

export const UTILITY_DEFAULT_PARAMS = {
  /** 區間 RS 下限（含） */
  rsMin: 85,
  /** 收盤價須站上 MA200 */
  requirePriceAboveMa200: true,
  /** MA50 須在 MA200 之上 */
  requireMa50AboveMa200: true,
  /** 平均日成交額下限（新台幣元）；null＝不篩 */
  turnoverMin: 1e8,
  /** 平均成交額的取樣交易日數 */
  turnoverDays: 20,
  /** 距 200 日高點的最大回檔（%）；null＝不篩 */
  maxPctFromHigh: 25,
  /** priceMap 落後大盤最新交易日超過此曆日數即視為過期、不參與排名 */
  maxStaleDays: 10,
};

/** priceMap → 依日期升冪的 { dates, closes }（濾掉非正值與格式錯誤的鍵） */
export function priceMapToSeries(priceMap) {
  if (!priceMap || typeof priceMap !== 'object') return { dates: [], closes: [] };
  const dates = Object.keys(priceMap)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const outDates = [];
  const outCloses = [];
  for (const d of dates) {
    const v = Number(priceMap[d]);
    if (Number.isFinite(v) && v > 0) {
      outDates.push(d);
      outCloses.push(v);
    }
  }
  return { dates: outDates, closes: outCloses };
}

/**
 * 大盤狀態：近 lookback 交易日最高收盤、距今幾個交易日、是否啟動。
 * @returns {{ ok: boolean, reason: string, high: number|null, highDate: string|null,
 *             lastClose: number|null, lastDate: string|null, daysSinceHigh: number|null,
 *             pctFromHigh: number|null, active: boolean, barsAvailable: number }}
 */
export function calcIndexHighState(indexPriceMap, opts = {}) {
  const lookback = opts.lookback ?? UTILITY_INDEX_LOOKBACK;
  const minD = opts.minDays ?? UTILITY_MIN_DAYS_SINCE_HIGH;
  const maxD = opts.maxDays ?? UTILITY_MAX_DAYS_SINCE_HIGH;

  const empty = {
    ok: false,
    reason: 'noData',
    high: null,
    highDate: null,
    lastClose: null,
    lastDate: null,
    daysSinceHigh: null,
    pctFromHigh: null,
    active: false,
    barsAvailable: 0,
  };

  const { dates, closes } = priceMapToSeries(indexPriceMap);
  const n = closes.length;
  if (n < 2) return empty;

  const start = Math.max(0, n - lookback);
  let high = -Infinity;
  let hiIdx = -1;
  for (let i = start; i < n; i++) {
    if (closes[i] > high) {
      high = closes[i];
      hiIdx = i;
    }
  }
  if (hiIdx < 0) return empty;

  const lastClose = closes[n - 1];
  const daysSinceHigh = n - 1 - hiIdx;
  const pctFromHigh = high > 0 ? ((high - lastClose) / high) * 100 : null;

  let reason = 'active';
  if (daysSinceHigh <= minD) reason = 'nearHigh';
  else if (daysSinceHigh > maxD) reason = 'tooLong';

  return {
    ok: true,
    reason,
    high,
    highDate: dates[hiIdx],
    lastClose,
    lastDate: dates[n - 1],
    daysSinceHigh,
    pctFromHigh,
    active: reason === 'active',
    barsAvailable: n,
  };
}

/**
 * 區間 RS raw：與現行 RS 同公式同權重，窗口長度改為 D 個交易日。
 * closes 須為依日期升冪的收盤陣列。資料不足 D+1 根回傳 null（不參與排名）。
 */
export function calcIntervalRsRaw(closes, D) {
  if (!Array.isArray(closes)) return null;
  const d = Math.floor(Number(D));
  if (!Number.isFinite(d) || d < 4) return null;
  const n = closes.length;
  if (n < d + 1) return null;

  const Q = Math.max(1, Math.round(d / 4));
  const at = (back) => closes[n - 1 - Math.min(back, d)];
  const P0 = at(0);
  const PQ = at(Q);
  const P2Q = at(2 * Q);
  const P3Q = at(3 * Q);
  const PD = at(d);
  if (!(PD > 0)) return null;

  const raw = ((P0 - PQ) * 2 + (PQ - P2Q) + (P2Q - P3Q) + (P3Q - PD)) / PD;
  return Number.isFinite(raw) ? raw : null;
}

/** 區間 RS 的分段長度（供 UI 顯示錨點用） */
export function intervalRsSegmentDays(D) {
  const d = Math.floor(Number(D));
  if (!Number.isFinite(d) || d < 4) return null;
  return Math.max(1, Math.round(d / 4));
}

/** 末 period 根收盤的簡單移動平均；不足回傳 null */
export function simpleMa(closes, period) {
  if (!Array.isArray(closes) || closes.length < period || period < 1) return null;
  const seg = closes.slice(-period);
  return seg.reduce((a, b) => a + b, 0) / period;
}

/**
 * 距近 lookback 交易日最高「收盤」的回檔（%）。
 * 註：用收盤而非盤中高，因 Firestore 的 highMap 只保留 120 天、不足 200。
 * 影響是算出來的回檔會略小於看盤軟體（濾網略鬆）。
 */
export function calcPctFromNdHigh(closes, lookback = UTILITY_STOCK_LOOKBACK) {
  if (!Array.isArray(closes) || closes.length === 0) return null;
  const seg = closes.slice(-lookback);
  const high = Math.max(...seg);
  const last = closes[closes.length - 1];
  if (!(high > 0) || !Number.isFinite(last)) return null;
  return ((high - last) / high) * 100;
}

/**
 * 近 days 個交易日的平均日成交額（元）＝ mean(收盤 × 成交量)。
 * Yahoo 台股 quote.volume 單位為「股」（已實證：2330 單日 5,714 萬股＝5.7 萬張，
 * 若為張則超過流通股數），故成交額直接為 close × volume。
 * volumeMap 只存最近 120 天，取樣不足 days 時，至少要 5 筆才回傳。
 */
export function calcAvgTurnover(priceMap, volumeMap, days = 20) {
  if (!priceMap || !volumeMap || typeof priceMap !== 'object' || typeof volumeMap !== 'object') {
    return null;
  }
  const dates = Object.keys(volumeMap)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && priceMap[d] != null)
    .sort();
  const tail = dates.slice(-Math.max(1, days));
  const vals = [];
  for (const d of tail) {
    const c = Number(priceMap[d]);
    const v = Number(volumeMap[d]);
    if (Number.isFinite(c) && c > 0 && Number.isFinite(v) && v >= 0) vals.push(c * v);
  }
  if (vals.length < Math.min(5, days)) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** 兩個 YYYY-MM-DD 相差的曆日數（b − a）；格式錯誤回傳 null */
function calendarDayGap(aYmd, bYmd) {
  const a = Date.parse(`${String(aYmd || '').slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(bYmd || '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** 未通過條件的中文標籤（供 UI 顯示原因） */
export const UTILITY_FAIL_LABELS = {
  noPrice: '無足夠價格資料',
  stale: '價格資料過期',
  noRs: '區間 RS 無法計算',
  rs: '區間 RS 未達門檻',
  ma200: '收盤未站上 MA200',
  maStack: 'MA50 未在 MA200 之上',
  turnover: '成交額不足',
  fromHigh: '距 200 日高點過遠',
};

/**
 * 重計算階段：算出每檔的區間 RS 與各項指標，不套任何門檻。
 *
 * 這一段是 O(檔數 × priceMap 長度)（約 1900 × 315），改門檻不該重跑，
 * 所以與 applyUtilityFilters 分開，讓呼叫端可各自 memo。
 *
 * @param {Array<{id: string, priceMap?: object, volumeMap?: object}>} stocks 全市場（含 priceMap）
 * @param {object} indexPriceMap ^TWII 收盤 map
 * @param {{ turnoverDays?: number, maxStaleDays?: number|null, lookback?: number,
 *           minDays?: number, maxDays?: number }} opts
 * @returns {{
 *   state: ReturnType<typeof calcIndexHighState>,
 *   windowDays: number|null,
 *   segmentDays: number|null,
 *   rankedCount: number,
 *   byId: Map<string, object>,
 * }}
 */
export function computeUtilityMetrics(stocks, indexPriceMap, opts = {}) {
  const turnoverDays = opts.turnoverDays ?? UTILITY_DEFAULT_PARAMS.turnoverDays;
  const maxStaleDays =
    opts.maxStaleDays === undefined ? UTILITY_DEFAULT_PARAMS.maxStaleDays : opts.maxStaleDays;

  const state = calcIndexHighState(indexPriceMap, opts);
  const byId = new Map();

  if (!state.active || !Array.isArray(stocks) || stocks.length === 0) {
    return { state, windowDays: null, segmentDays: null, rankedCount: 0, byId };
  }

  const D = state.daysSinceHigh;
  const Q = intervalRsSegmentDays(D);
  const marketLastDate = state.lastDate;

  const rawItems = [];
  for (const s of stocks) {
    const { dates, closes } = priceMapToSeries(s.priceMap);
    const entry = {
      id: s.id,
      intervalRsRaw: null,
      intervalRs: null,
      close: closes.length ? closes[closes.length - 1] : null,
      lastDate: dates.length ? dates[dates.length - 1] : null,
      ma50: null,
      ma200: null,
      pctFromHigh: null,
      avgTurnover: null,
      /** 計算階段就確定不可用的原因（無價／過期）；門檻類原因在 applyUtilityFilters 產生 */
      blockedReason: null,
    };

    if (closes.length === 0) {
      entry.blockedReason = 'noPrice';
      byId.set(s.id, entry);
      continue;
    }

    const gap = maxStaleDays != null ? calendarDayGap(entry.lastDate, marketLastDate) : null;
    if (gap != null && gap > maxStaleDays) {
      entry.blockedReason = 'stale';
      byId.set(s.id, entry);
      continue;
    }

    entry.intervalRsRaw = calcIntervalRsRaw(closes, D);
    entry.ma50 = simpleMa(closes, 50);
    entry.ma200 = simpleMa(closes, 200);
    entry.pctFromHigh = calcPctFromNdHigh(closes, UTILITY_STOCK_LOOKBACK);
    entry.avgTurnover = calcAvgTurnover(s.priceMap, s.volumeMap, turnoverDays);

    byId.set(s.id, entry);
    rawItems.push({ id: s.id, rsRaw: entry.intervalRsRaw });
  }

  // 全市場百分位 → 1..99（沿用現行 assignRsRatings，母體＝算得出 raw 的檔）
  const ranked = assignRsRatings(rawItems);
  let rankedCount = 0;
  for (const r of ranked) {
    const entry = byId.get(r.id);
    if (!entry) continue;
    entry.intervalRs = r.ibdRsRating ?? null;
    if (entry.intervalRs != null) rankedCount++;
  }

  return { state, windowDays: D, segmentDays: Q, rankedCount, byId };
}

/**
 * 門檻階段：對 computeUtilityMetrics 的結果套濾網。純比較，改參數重跑很便宜。
 * @returns {{ passIds: Set<string>, failById: Map<string, string[]> }}
 */
export function applyUtilityFilters(metrics, params = {}) {
  const p = { ...UTILITY_DEFAULT_PARAMS, ...params };
  const passIds = new Set();
  const failById = new Map();

  if (!metrics?.state?.active) return { passIds, failById };

  for (const entry of metrics.byId.values()) {
    if (entry.blockedReason) {
      failById.set(entry.id, [entry.blockedReason]);
      continue;
    }
    const fails = [];

    if (entry.intervalRs == null) fails.push('noRs');
    else if (p.rsMin != null && entry.intervalRs < p.rsMin) fails.push('rs');

    if (p.requirePriceAboveMa200) {
      if (entry.ma200 == null || entry.close == null || !(entry.close > entry.ma200)) {
        fails.push('ma200');
      }
    }
    if (p.requireMa50AboveMa200) {
      if (entry.ma50 == null || entry.ma200 == null || !(entry.ma50 > entry.ma200)) {
        fails.push('maStack');
      }
    }
    if (p.turnoverMin != null) {
      if (entry.avgTurnover == null || !(entry.avgTurnover > p.turnoverMin)) {
        fails.push('turnover');
      }
    }
    if (p.maxPctFromHigh != null) {
      if (entry.pctFromHigh == null || !(entry.pctFromHigh < p.maxPctFromHigh)) {
        fails.push('fromHigh');
      }
    }

    if (fails.length === 0) passIds.add(entry.id);
    else failById.set(entry.id, fails);
  }

  return { passIds, failById };
}

/** 一次跑完（腳本／測試用）；頁面請分開 memo 兩階段。 */
export function runUtilityScreen(stocks, indexPriceMap, params = {}) {
  const metrics = computeUtilityMetrics(stocks, indexPriceMap, params);
  const { passIds, failById } = applyUtilityFilters(metrics, params);
  return { ...metrics, passIds, failById };
}
