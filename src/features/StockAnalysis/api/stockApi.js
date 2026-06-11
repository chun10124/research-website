/* src/features/StockAnalysis/api/stockApi.js */

import { updateAnalysisField, deleteAnalysisDoc } from './watchlist';
import { getTaiwanStockDisplayName } from './rsStockList';
import { calculateSingleStockIndicators } from '../utils/analysisUtils';
import { normalizeYmdToTaiwanTradingDay, taipeiYmdAddDays } from '../utils/rsCalculator';
import { getDoc, doc } from 'firebase/firestore';
import { RS_RATINGS_COLLECTION, STOCK_WATCHLIST_COLLECTION } from '../../../utils/firebaseConfig';

// 與 rsApi.js 的 getTaiwanYmd() 相同邏輯：14:00 前取前一交易日，14:00 後取當日
function getLatestTradingYmd() {
  const now = new Date();
  const calendarYmd = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const h = parseInt(now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }), 10);
  if (Number.isFinite(h) && h >= 14) {
    return normalizeYmdToTaiwanTradingDay(calendarYmd) ?? calendarYmd;
  }
  const prev = taipeiYmdAddDays(calendarYmd, -1);
  return normalizeYmdToTaiwanTradingDay(prev) ?? prev;
}
const PROXY_BASE = "https://stock-proxy.tzuchun11232004.workers.dev/?url=";
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJkYXRlIjoiMjAyNS0xMi0xNCAxNzowNzo1MyIsInVzZXJfaWQiOiJjaHVuMTAxMjQiLCJpcCI6IjYxLjIyOC43Ni4yMDYifQ.mSi9H6Lrus7e_wkaNxlYd6OoFmh79NQoQ7pZajx166s";

const getFinmindPriceUrl = (stockCode, startDate, endDate = null) => {
  const params = new URLSearchParams({
    dataset: 'TaiwanStockPrice',
    data_id: String(stockCode).trim(),
    start_date: startDate,
    token: TOKEN,
  });
  if (endDate) params.set('end_date', endDate);
  return `${FINMIND_BASE}?${params.toString()}`;
};

/** 加權報酬指數區間報酬率 %，供績效頁對標用。startStr/endStr YYYY-MM-DD。失敗回傳 null */
export const fetchBenchmarkReturn = async (startStr, endStr) => {
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  if (!start || !end) return null;
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const cacheKey = `rw-benchmark_${start}_${end}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached?.date === todayStr && cached.value != null) return cached.value;
  } catch (_) {}
  const INDEX_ID = 'IR0001';
  try {
    const url = getFinmindPriceUrl(INDEX_ID, start);
    const fullUrl = `${PROXY_BASE}${encodeURIComponent(url)}`;
    const res = await fetch(fullUrl);
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const byDate = {};
    (data || []).forEach((row) => {
      const d = (row.date || row.Date || '').toString().slice(0, 10);
      if (row.close != null) byDate[d] = Number(row.close);
    });
    const dates = Object.keys(byDate).sort();
    let startPrice = null;
    let endPrice = null;
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] <= start) { startPrice = byDate[dates[i]]; break; }
    }
    if (startPrice == null && dates.length) startPrice = byDate[dates[0]];
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] <= end) { endPrice = byDate[dates[i]]; break; }
    }
    if (endPrice == null && dates.length) endPrice = byDate[dates[dates.length - 1]];
    if (startPrice == null || endPrice == null || startPrice <= 0) return null;
    const result = ((endPrice - startPrice) / startPrice) * 100;
    try { localStorage.setItem(cacheKey, JSON.stringify({ date: todayStr, value: result })); } catch (_) {}
    return result;
  } catch (e) {
    console.warn('fetchBenchmarkReturn failed:', e?.message);
    return null;
  }
};

/** Finmind 台股 data_id 用純數字，例如 2330；若傳入 2330.TW 會查不到 */
function toFinmindStockId(stockCode) {
  const s = String(stockCode || '').trim();
  return s.replace(/\.(TW|TWO)$/i, '') || s;
}

/** 某檔股票歷史收盤價 { dateStr: price }，供績效頁每日淨值含未實現用 */
export const fetchHistoricalPriceMap = async (stockCode, startStr, endStr) => {
  const code = toFinmindStockId(String(stockCode || '').trim());
  if (!code) return {};
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  if (!start) return {};
  try {
    const url = getFinmindPriceUrl(code, start, end || undefined);
    const fullUrl = `${PROXY_BASE}${encodeURIComponent(url)}`;
    const res = await fetch(fullUrl);
    if (!res.ok) return {};
    const json = await res.json();
    const data = json?.data;
    if (!Array.isArray(data)) return {};
    const map = {};
    data.forEach((row) => {
      const d = (row.date || row.Date || '').toString().slice(0, 10);
      const c = Number(row.close);
      if (d && c > 0) map[d] = c;
    });
    return map;
  } catch (e) {
    console.warn(`fetchHistoricalPriceMap(${stockCode}) failed:`, e?.message);
    return {};
  }
};

/**
 * 優先從 Firestore ibdRsRatings.priceMap 取歷史收盤價（非除息調整的 quote.close）；
 * 若 Firestore 資料未覆蓋 startStr 起始日（超過 15 個月舊資料），fallback 至 FinMind。
 */
export const fetchHistoricalPriceMapFromDB = async (stockCode, startStr, endStr) => {
  const bare = String(stockCode || '').trim().replace(/\.(TW|tw|TWO|two)$/i, '');
  if (!bare) return {};
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  try {
    const snap = await getDoc(doc(RS_RATINGS_COLLECTION, bare));
    if (snap.exists()) {
      const pm = snap.data()?.priceMap;
      if (pm && typeof pm === 'object') {
        const filtered = {};
        for (const [d, p] of Object.entries(pm)) {
          if ((!start || d >= start) && (!end || d <= end) && Number(p) > 0) {
            filtered[d] = Number(p);
          }
        }
        const dates = Object.keys(filtered).sort();
        if (dates.length > 0) {
          // 若第一筆資料在 start 後 15 天內，視為覆蓋足夠
          const bufDate = new Date(start || dates[0]);
          bufDate.setDate(bufDate.getDate() + 15);
          if (dates[0] <= bufDate.toISOString().slice(0, 10)) return filtered;
        }
      }
    }
  } catch (e) {}
  return fetchHistoricalPriceMap(stockCode, startStr, endStr);
};

/** 台股代碼去掉 .TW / .TWO 後綴，回傳純數字/代碼 */
function toYahooBare(stockCode) {
  return String(stockCode || '').trim().replace(/\.(TW|tw|TWO|two)$/i, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const YAHOO_FETCH_TIMEOUT_MS = 20000;

/**
 * Yahoo 歷史價起算回溯月數（須與 rsApi.js 內 RS_PRICE_LOOKBACK_MONTHS 保持一致）
 */
const YAHOO_TRACKING_LOOKBACK_MONTHS = 15;

/** Yahoo 經 proxy 易觸發 429，對可重試狀態與網路錯誤做指數退避 */
const YAHOO_RETRYABLE_HTTP = new Set([408, 429, 502, 503, 504]);

/**
 * 用指定 symbol（如 2330.TW、1234.TWO）呼叫 Yahoo chart API，回傳 JSON 或 null
 * @param {string} symbol
 * @param {string} range
 * @param {{ maxRetries?: number, baseDelayMs?: number }} [opts]
 */
async function fetchYahooChart(symbol, range = '5d', opts = {}) {
  const maxRetries = opts.maxRetries ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 900;
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || YAHOO_FETCH_TIMEOUT_MS);
  const cacheBust = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}&_cb=${cacheBust}`;
  const fullUrl = `${PROXY_BASE}${encodeURIComponent(url)}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let res;
      try {
        res = await fetch(fullUrl, ctrl ? { signal: ctrl.signal } : undefined);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res.ok) return await res.json();

      if (!YAHOO_RETRYABLE_HTTP.has(res.status) || attempt === maxRetries) {
        return null;
      }

      let waitMs = baseDelayMs * 2 ** attempt + Math.random() * 400;
      const ra = res.headers.get('Retry-After');
      if (ra) {
        const sec = parseInt(ra, 10);
        if (!Number.isNaN(sec) && sec > 0) waitMs = Math.max(waitMs, sec * 1000);
      }
      await sleep(waitMs);
    } catch {
      if (attempt === maxRetries) return null;
      await sleep(baseDelayMs * 2 ** attempt + Math.random() * 400);
    }
  }
  return null;
}

/**
 * 從 Yahoo Finance 抓最新收盤價（透過 proxy）。
 * 先試 .TW（上市/上櫃），無資料再試 .TWO（興櫃）。
 */
export const fetchYahooPrice = async (stockCode) => {
  const bare = toYahooBare(stockCode);
  if (!bare) return null;
  for (const suffix of ['.TW', '.TWO']) {
    const symbol = `${bare}${suffix}`;
    try {
      const json = await fetchYahooChart(symbol, '5d');
      const price = Number(json?.chart?.result?.[0]?.meta?.regularMarketPrice);
      if (price > 0) return price;
    } catch (e) {
      console.warn(`fetchYahooPrice(${symbol}) failed:`, e?.message);
    }
  }
  return null;
};

/** Yahoo chart meta → 顯示名稱（longName 優先，多為英文公司全名） */
function parseYahooChartMetaDisplayName(json) {
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const longN = meta.longName != null ? String(meta.longName).trim() : '';
  const shortN = meta.shortName != null ? String(meta.shortName).trim() : '';
  if (longN) return longN;
  if (shortN) return shortN;
  return null;
}

/** 輕量抓 Yahoo 股票名稱（5 日 chart），suffix 順序與價量 API 一致 */
async function fetchYahooStockDisplayName(stockCode, market) {
  const bare = toYahooBare(stockCode);
  if (!bare) return null;
  const suffixes =
    market === 'TPEX' ? ['.TWO', '.TW'] : market === 'TWSE' ? ['.TW', '.TWO'] : ['.TW', '.TWO'];
  for (let si = 0; si < suffixes.length; si++) {
    if (si > 0) await sleep(400 + Math.floor(Math.random() * 200));
    const json = await fetchYahooChart(`${bare}${suffixes[si]}`, '5d');
    if (!json) continue;
    const name = parseYahooChartMetaDisplayName(json);
    if (name) return name;
  }
  return null;
}

/** 依起迄日數選 Yahoo chart range 參數 */
function yahooRangeForDays(days) {
  if (days <= 0) return '1mo';
  if (days <= 28) return '1mo';
  if (days <= 85) return '3mo';
  if (days <= 175) return '6mo';
  if (days <= 350) return '1y';
  if (days <= 700) return '2y';
  if (days <= 1750) return '5y';
  return 'max';
}

/** 把 Yahoo chart result 解析成 { [dateStr]: price }，只保留 [start, end] 區間 */
function parseChartToPriceMap(json, startStr, endStr) {
  const result = json?.chart?.result?.[0];
  if (!result) return {};
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0];
  const closes = quote?.close || [];
  const map = {};
  for (let i = 0; i < timestamps.length; i++) {
    const d = new Date(timestamps[i] * 1000);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    if (dateStr < start) continue;
    if (end && dateStr > end) break;
    const c = Number(closes[i]);
    if (c > 0) map[dateStr] = c;
  }
  return map;
}

/**
 * 解析 Yahoo chart：收盤價 + 高／低 + 成交量（同日對齊；僅在收盤有效時寫入價；H/L 缺則以收盤補；量可為 0）
 * @returns {{ priceMap: Record<string, number>, highMap: Record<string, number>, lowMap: Record<string, number>, volumeMap: Record<string, number> }}
 */
function parseChartToPriceVolumeMaps(json, startStr, endStr) {
  const result = json?.chart?.result?.[0];
  if (!result) return { priceMap: {}, highMap: {}, lowMap: {}, volumeMap: {} };
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0];
  const closes = quote?.close || result.indicators?.adjclose?.[0]?.adjclose || [];
  const highs = quote?.high || [];
  const lows = quote?.low || [];
  const volumes = quote?.volume || [];
  const priceMap = {};
  const highMap = {};
  const lowMap = {};
  const volumeMap = {};
  for (let i = 0; i < timestamps.length; i++) {
    const d = new Date(timestamps[i] * 1000);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    if (dateStr < start) continue;
    if (end && dateStr > end) break;
    const c = Number(closes[i]);
    if (!(c > 0 && Number.isFinite(c))) continue;
    const hRaw = Number(highs[i]);
    const lRaw = Number(lows[i]);
    let hi = Number.isFinite(hRaw) && hRaw > 0 ? hRaw : c;
    let lo = Number.isFinite(lRaw) && lRaw > 0 ? lRaw : c;
    hi = Math.max(hi, c);
    lo = Math.min(lo, c);
    if (lo > hi) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    priceMap[dateStr] = c;
    highMap[dateStr] = hi;
    lowMap[dateStr] = lo;
    const vol = volumes[i];
    if (vol != null && Number.isFinite(vol) && vol >= 0) {
      volumeMap[dateStr] = vol;
    }
  }
  return { priceMap, highMap, lowMap, volumeMap };
}

/**
 * Yahoo chart → 日 K OHLC 序列（台北日曆日），供 K 線圖用。
 * 與 parseChartToPriceVolumeMaps 一致：收盤優先 quote.close，缺則用 adjclose（同列索引）。
 * Yahoo 在日線上 O/H/L 常為 null（盤中未收盤、或 API 缺欄）— 以當根收盤與合理範圍補齊，避免怪 K。
 * @returns {Array<{ dateStr: string, open: number, high: number, low: number, close: number, volume: number }>}
 */
function parseChartToOhlcSeries(json, startStr, endStr) {
  const result = json?.chart?.result?.[0];
  if (!result) return [];
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0];
  const opens = quote?.open || [];
  const highs = quote?.high || [];
  const lows = quote?.low || [];
  const closes = quote?.close || [];
  const adjcloses = result.indicators?.adjclose?.[0]?.adjclose || [];
  const volumes = quote?.volume || [];

  const pickClose = (i) => {
    const c = Number(closes[i]);
    if (Number.isFinite(c) && c > 0) return c;
    const a = Number(adjcloses[i]);
    if (Number.isFinite(a) && a > 0) return a;
    return null;
  };

  const out = [];
  for (let i = 0; i < timestamps.length; i++) {
    const d = new Date(timestamps[i] * 1000);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    if (dateStr < start) continue;
    if (end && dateStr > end) continue;

    const c = pickClose(i);
    if (c == null) continue;

    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const oN = Number(o);
    const hN = Number(h);
    const lN = Number(l);

    let open = Number.isFinite(oN) && oN > 0 ? oN : c;
    let high = Number.isFinite(hN) && hN > 0 ? hN : c;
    let low = Number.isFinite(lN) && lN > 0 ? lN : c;

    high = Math.max(high, open, c);
    low = Math.min(low, open, c);
    if (low > high) {
      const t = low;
      low = high;
      high = t;
    }

    const vol = volumes[i];
    out.push({
      dateStr,
      open,
      high,
      low,
      close: c,
      volume: vol != null && Number.isFinite(vol) && vol >= 0 ? vol : 0,
    });
  }

  out.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
  const byDate = new Map();
  for (const row of out) {
    byDate.set(row.dateStr, row);
  }
  return Array.from(byDate.values()).sort((a, b) => a.dateStr.localeCompare(b.dateStr));
}

/**
 * 從 Yahoo Finance 抓歷史收盤價（透過 proxy），回傳 { [dateStr]: price }。
 * 先試 .TW（上市/上櫃），無資料再試 .TWO（興櫃）。績效頁每日淨值用。
 */
export const fetchYahooHistoricalPriceMap = async (stockCode, startStr, endStr, opts = {}) => {
  const bare = toYahooBare(stockCode);
  if (!bare) return {};
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  if (!start) return {};
  const startDay = new Date(start).getTime() / (24 * 60 * 60 * 1000);
  const endDay = end ? new Date(end).getTime() / (24 * 60 * 60 * 1000) : startDay + 365;
  const days = Math.ceil(endDay - startDay) + 1;
  const range = yahooRangeForDays(days);

  /** 回填長跑時可拉高，降低 429；預設與舊版 fetchYahooChart 一致 */
  const chartOpts = {
    maxRetries: opts.yahooMaxRetries ?? 8,
    baseDelayMs: opts.yahooBaseDelayMs ?? 900,
  };

  const suffixes = opts.market === 'TPEX' ? ['.TWO', '.TW']
    : opts.market === 'TWSE' ? ['.TW', '.TWO']
    : ['.TW', '.TWO'];
  for (let si = 0; si < suffixes.length; si++) {
    if (si > 0) await sleep(400 + Math.floor(Math.random() * 200));
    const suffix = suffixes[si];
    const symbol = `${bare}${suffix}`;
    try {
      const json = await fetchYahooChart(symbol, range, chartOpts);
      if (!json) continue;
      const map = parseChartToPriceMap(json, start, end);
      if (Object.keys(map).length > 0) return map;
    } catch (e) {
      console.warn(`fetchYahooHistoricalPriceMap(${symbol}) failed:`, e?.message);
    }
  }
  return {};
};

// --- 個股 K 線預取快取（session 層級，TTL 5 分鐘）---
const _klineCache = new Map();
const _KLINE_TTL = 5 * 60 * 1000;

/** 若快取不存在或已過期，靜默發起預取並存入快取。 */
export function prefetchYahooKlineIfAbsent(stockCode, startStr, endStr, opts = {}) {
  const key = `${stockCode}|${startStr}|${endStr}`;
  const cached = _klineCache.get(key);
  if (cached && Date.now() - cached.ts < _KLINE_TTL) return;
  const promise = fetchYahooHistoricalPriceVolumeMaps(stockCode, startStr, endStr, opts);
  _klineCache.set(key, { promise, ts: Date.now() });
  promise.then((result) => {
    const entry = _klineCache.get(key);
    if (entry?.promise === promise) _klineCache.set(key, { result, ts: entry.ts });
  }).catch(() => {
    const entry = _klineCache.get(key);
    if (entry?.promise === promise) _klineCache.delete(key);
  });
}

/** 若快取存在且未過期，回傳 Promise<result>；否則回傳 null。 */
export function getYahooKlineFromCache(stockCode, startStr, endStr) {
  const key = `${stockCode}|${startStr}|${endStr}`;
  const cached = _klineCache.get(key);
  if (!cached || Date.now() - cached.ts > _KLINE_TTL) { _klineCache.delete(key); return null; }
  return cached.result ? Promise.resolve(cached.result) : (cached.promise ?? null);
}

/**
 * 從 Yahoo Finance 抓歷史收盤價與成交量（同一請求），回傳兩個 map。
 */
export const fetchYahooHistoricalPriceVolumeMaps = async (stockCode, startStr, endStr, opts = {}) => {
  const bare = toYahooBare(stockCode);
  if (!bare) {
    return { priceMap: {}, highMap: {}, lowMap: {}, volumeMap: {}, ohlcSeries: [], displayName: null };
  }
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  if (!start) {
    return { priceMap: {}, highMap: {}, lowMap: {}, volumeMap: {}, ohlcSeries: [], displayName: null };
  }
  const startDay = new Date(start).getTime() / (24 * 60 * 60 * 1000);
  const endDay = end ? new Date(end).getTime() / (24 * 60 * 60 * 1000) : startDay + 365;
  const days = Math.ceil(endDay - startDay) + 1;
  const range = yahooRangeForDays(days);
  const chartOpts = {
    maxRetries: opts.yahooMaxRetries ?? 8,
    baseDelayMs: opts.yahooBaseDelayMs ?? 900,
  };
  const suffixes =
    opts.market === 'TPEX' ? ['.TWO', '.TW'] : opts.market === 'TWSE' ? ['.TW', '.TWO'] : ['.TW', '.TWO'];
  for (let si = 0; si < suffixes.length; si++) {
    if (si > 0) await sleep(400 + Math.floor(Math.random() * 200));
    const suffix = suffixes[si];
    const symbol = `${bare}${suffix}`;
    try {
      const json = await fetchYahooChart(symbol, range, chartOpts);
      if (!json) continue;
      const { priceMap, highMap, lowMap, volumeMap } = parseChartToPriceVolumeMaps(json, start, end);
      const ohlcSeries = parseChartToOhlcSeries(json, start, end);
      if (Object.keys(priceMap).length > 0) {
        return {
          priceMap,
          highMap,
          lowMap,
          volumeMap,
          ohlcSeries,
          displayName: parseYahooChartMetaDisplayName(json),
        };
      }
    } catch (e) {
      console.warn(`fetchYahooHistoricalPriceVolumeMaps(${symbol}) failed:`, e?.message);
    }
  }
  return { priceMap: {}, highMap: {}, lowMap: {}, volumeMap: {}, ohlcSeries: [], displayName: null };
};

/**
 * 抓台股加權指數（^TWII）歷史收盤，回傳 { dateStr: price }。
 * 直接用 ^TWII symbol，不加 .TW/.TWO 後綴。
 */
export const fetchIndexPriceMap = async (startStr, endStr) => {
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  if (!start) return {};
  const startDay = new Date(start).getTime() / (24 * 60 * 60 * 1000);
  const endDay = end ? new Date(end).getTime() / (24 * 60 * 60 * 1000) : startDay + 365;
  const days = Math.ceil(endDay - startDay) + 1;
  const range = yahooRangeForDays(days);
  try {
    const json = await fetchYahooChart('^TWII', range);
    if (!json) return {};
    return parseChartToPriceMap(json, start, end);
  } catch (e) {
    console.warn('fetchIndexPriceMap(^TWII) failed:', e?.message);
    return {};
  }
};

/** 僅抓該股票最新收盤價，供績效頁未實現損益用（改走 Yahoo，不依賴 FinMind token） */
export const fetchCurrentPrice = async (stockCode) => {
  const code = String(stockCode || '').trim();
  if (!code || code === 'NaN' || code === 'undefined') return null;
  try {
    const price = await fetchYahooPrice(code);
    return price != null && price > 0 ? { currentPrice: price } : null;
  } catch (e) {
    console.warn(`fetchCurrentPrice(${code}) failed:`, e?.message);
    return null;
  }
};

/** FinMind 陣列列中最新一筆日期 YYYY-MM-DD */
function getLatestDateFromFinmindRows(arr) {
  if (!arr?.length) return null;
  let maxStr = null;
  for (const row of arr) {
    const d = row.date ?? row.Date ?? row.trade_date ?? row.TradeDate;
    const str = d ? String(d).trim().split(' ')[0] : null;
    if (str && /^\d{4}-\d{2}-\d{2}$/.test(str) && (!maxStr || str > maxStr)) maxStr = str;
  }
  return maxStr;
}

/**
 * 追蹤表價量：Yahoo 為主（與 RS 的 fetchRsPriceData 相同：回溯月數 + ISO 起迄日），無資料再 FinMind TaiwanStockPrice。
 */
async function fetchTrackingTablePriceVolumeRows(stockCode, market, chartOpts = {}) {
  const sCode = String(stockCode || '').trim();
  if (!sCode) return null;
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - YAHOO_TRACKING_LOOKBACK_MONTHS);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const yahoo = await fetchYahooHistoricalPriceVolumeMaps(sCode, startStr, endStr, { market, ...chartOpts });
  const pm = yahoo.priceMap || {};
  const vm = yahoo.volumeMap || {};
  const datesAsc = Object.keys(pm).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (datesAsc.length > 0) {
    const datesDesc = [...datesAsc].reverse();
    return {
      priceCloseArray_NewestFirst: datesDesc.map((d) => pm[d]),
      volumeArray_NewestFirst: datesDesc.map((d) => {
        const v = vm[d];
        return v != null && Number.isFinite(v) ? v : 0;
      }),
      latestPriceDate: datesAsc[datesAsc.length - 1],
      currentPrice: pm[datesAsc[datesAsc.length - 1]] ?? 0,
      yesterdayClose: datesAsc.length >= 2 ? pm[datesAsc[datesAsc.length - 2]] : 0,
      yahooDisplayName: yahoo.displayName || null,
    };
  }

  await sleep(400 + Math.floor(Math.random() * 200));
  const finmindId = toFinmindStockId(sCode);
  const finUrl = getFinmindPriceUrl(finmindId, startStr);
  const fin = await safeFetch(finUrl);
  const rows = fin?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const priceData = rows.slice().reverse();
  return {
    priceCloseArray_NewestFirst: priceData.map((d) => Number(d.close)),
    volumeArray_NewestFirst: priceData.map(
      (d) => Number(d.Trading_Volume ?? d.trading_volume ?? d.volume ?? 0) || 0
    ),
    latestPriceDate: getLatestDateFromFinmindRows(rows),
    currentPrice: Number(priceData[0]?.close) || 0,
    yesterdayClose: Number(priceData[1]?.close) || 0,
    yahooDisplayName: null,
  };
}

const safeFetch = async (targetUrl) => {
    try {
        if (!targetUrl) return null;
        const fullUrl = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
        const response = await fetch(fullUrl);
        if (!response.ok) {
            const errorText = await response.text();
            console.warn(`[隧道錯誤 ${response.status}]: ${targetUrl.substring(0, 40)} -> ${errorText}`);
            return null;
        }
        const text = await response.text();
        if (!text || text.trim() === "") return null;
        try {
            return JSON.parse(text);
        } catch (parseError) {
            console.error("Worker 回傳內容非 JSON 格式:", text.substring(0, 100));
            return null;
        }
    } catch (e) {
        console.error("私人隧道請求或連線發生異常:", e.message);
        return null;
    }
};

// ─── 三大法人序列：解析 / 合併工具 ─────────────────────────────
/** FinMind TaiwanStockInstitutionalInvestorsBuySell rows → parallel arrays (newest first)
 *  name 值：Foreign_Investor / Foreign_Dealer_Self / Investment_Trust / Dealer_self / Dealer_Hedging
 */
function parseInstRows(rows) {
  const dateMap = {};
  for (const row of (rows || [])) {
    const d = row.date?.slice(0, 10);
    if (!d) continue;
    if (!dateMap[d]) dateMap[d] = { f: 0, t: 0, d2: 0 };
    const net = Math.round(((Number(row.buy) || 0) - (Number(row.sell) || 0)) / 1000);
    const name = String(row.name || '');
    // 外資 = Foreign_Investor + Foreign_Dealer_Self（累加）
    if (name === 'Foreign_Investor' || name === 'Foreign_Dealer_Self') dateMap[d].f += net;
    // 投信 = Investment_Trust
    else if (name === 'Investment_Trust')                               dateMap[d].t  = net;
    // 自營商 = Dealer_self + Dealer_Hedging（累加）
    else if (name === 'Dealer_self' || name === 'Dealer_Hedging')      dateMap[d].d2 += net;
  }
  const dates = Object.keys(dateMap).sort().reverse(); // newest first
  return {
    instDates:   dates,
    instForeign: dates.map(d => dateMap[d].f),
    instTrust:   dates.map(d => dateMap[d].t),
    instDealer:  dates.map(d => dateMap[d].d2),
  };
}

/** 合併既有 + 新資料（新資料覆蓋同日舊資料，保持 newest-first） */
export function mergeInstArrays(existing, newParsed) {
  const combined = {};
  const { instDates: eD = [], instForeign: eF = [], instTrust: eT = [], instDealer: eDl = [] } = existing || {};
  const { instDates: nD = [], instForeign: nF = [], instTrust: nT = [], instDealer: nDl = [] } = newParsed || {};
  eD.forEach((d, i) => { combined[d] = { f: eF[i] ?? 0, t: eT[i] ?? 0, d2: eDl[i] ?? 0 }; });
  nD.forEach((d, i) => { combined[d] = { f: nF[i] ?? 0, t: nT[i] ?? 0, d2: nDl[i] ?? 0 }; });
  const dates = Object.keys(combined).sort().reverse();
  return {
    instDates:   dates,
    instForeign: dates.map(d => combined[d].f),
    instTrust:   dates.map(d => combined[d].t),
    instDealer:  dates.map(d => combined[d].d2),
  };
}

/** 將 parallel arrays 轉成 { [dateStr]: { foreign, trust, dealer } }，供圖表使用 */
export function instArraysToDateMap(instDates, instForeign, instTrust, instDealer) {
  if (!instDates?.length) return {};
  const map = {};
  instDates.forEach((d, i) => {
    map[d] = { foreign: instForeign?.[i] ?? 0, trust: instTrust?.[i] ?? 0, dealer: instDealer?.[i] ?? 0 };
  });
  return map;
}
// ────────────────────────────────────────────────────────────────

/**
 * 懶載入外資持股序列（供個股視窗二使用，RS 排行頁不存這份資料）
 * 回傳 { holdings: number[], latestDate: string }，newest-first，單位：張
 */
export const fetchForeignHoldingSeries = async (stockId) => {
  try {
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    const startDate = threeYearsAgo.toISOString().split('T')[0];
    const params = new URLSearchParams({
      dataset: 'TaiwanStockShareholding',
      data_id: stockId,
      start_date: startDate,
      token: TOKEN,
    });
    const targetUrl = `${FINMIND_BASE}?${params.toString()}`;
    const fullUrl = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
    const res = await fetch(fullUrl);
    if (!res.ok) return null;
    const json = await res.json();
    const rows = json?.data || [];
    if (!rows.length) return null;
    // reverse：FinMind 原始資料最舊在前，改為最新在前（newest-first）
    const reversedRows = [...rows].reverse();
    const holdings = reversedRows.map(d => Math.round((d.ForeignInvestmentShares || 0) / 1000));
    const holdingDates = reversedRows.map(d => d.date?.slice(0, 10) ?? null);
    const latestDate = holdingDates[0] ?? null;
    return { holdings, holdingDates, latestDate };
  } catch {
    return null;
  }
};

// ─── TWSE 三大法人（上市股票，免 token）────────────────────────────────────
const TWSE_INST_URL = 'https://www.twse.com.tw/fund/T86';

/** T86 row → { foreign, trust, dealer }（股→張）
 *  欄位順序：[0]代號 [1]名稱
 *  [4] 外陸資買賣超(不含外資自營商)  [7] 外資自營商買賣超
 *  [10] 投信買賣超  [11] 自營商買賣超合計
 */
function parseTWSEInstRow(row) {
  const n = (s) => parseInt(String(s || '0').replace(/,/g, ''), 10) || 0;
  return {
    foreign: Math.round((n(row[4]) + n(row[7])) / 1000),
    trust:   Math.round(n(row[10]) / 1000),
    dealer:  Math.round(n(row[11]) / 1000),
  };
}

async function fetchTWSEInstOneDay(stockId, dateStr) {
  try {
    const d = dateStr.replace(/-/g, '');
    const url = `${TWSE_INST_URL}?response=json&date=${d}&selectType=ALL`;
    const res = await fetch(`${PROXY_BASE}${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.stat !== 'OK' || !Array.isArray(json.data)) return null;
    const row = json.data.find((r) => r[0] === stockId);
    if (!row) return null;
    return { date: dateStr, ...parseTWSEInstRow(row) };
  } catch {
    return null;
  }
}

async function fetchInstRangeFromTWSE(stockId, startDate) {
  const today = new Date();
  const start = new Date(startDate);
  const dates = [];
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  if (!dates.length) return {};
  const results = await Promise.all(dates.map((ds) => fetchTWSEInstOneDay(stockId, ds)));
  const dateMap = {};
  for (const r of results) {
    if (r) dateMap[r.date] = { foreign: r.foreign, trust: r.trust, dealer: r.dealer };
  }
  return dateMap;
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 抓取個股三大法人每日買賣超（懶載入，供個股視窗二使用）
 * 回傳 { [dateStr]: { foreign, trust, dealer } }，單位：張（千股）
 * 策略：上市股 ≤60 日範圍優先走 TWSE（免 token）；超出或失敗時用 FinMind 備用
 */
export const fetchInstitutionalInvestorsSeries = async (stockId, startDate) => {
  try {
    const daysDiff = (Date.now() - new Date(startDate).getTime()) / 86400000;
    if (daysDiff <= 60) {
      const twseMap = await fetchInstRangeFromTWSE(stockId, startDate);
      if (twseMap && Object.keys(twseMap).length > 0) return twseMap;
      // TWSE 無資料（可能是上櫃股）→ fall through to FinMind
    }
    // FinMind 備用（大範圍歷史 or 上櫃股）
    const params = new URLSearchParams({
      dataset: 'TaiwanStockInstitutionalInvestorsBuySell',
      data_id: stockId,
      start_date: startDate,
      token: TOKEN,
    });
    const targetUrl = `${FINMIND_BASE}?${params.toString()}`;
    const fullUrl = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
    const res = await fetch(fullUrl);
    if (!res.ok) return {};
    const json = await res.json();
    const rows = json?.data || [];
    const dateMap = {};
    for (const row of rows) {
      const d = row.date?.slice(0, 10);
      if (!d) continue;
      if (!dateMap[d]) dateMap[d] = { foreign: 0, trust: 0, dealer: 0 };
      const net = Math.round(((Number(row.buy) || 0) - (Number(row.sell) || 0)) / 1000);
      const name = String(row.name || '');
      if (name === 'Foreign_Investor' || name === 'Foreign_Dealer_Self') dateMap[d].foreign += net;
      else if (name === 'Investment_Trust')                               dateMap[d].trust   = net;
      else if (name === 'Dealer_self' || name === 'Dealer_Hedging')      dateMap[d].dealer  += net;
    }
    return dateMap;
  } catch {
    return {};
  }
};

// 營收 API 日期轉「資料所屬月」YYYY-MM（公告日 1～15 日視為上月）
const toRevenueMonthStr = (dateStr) => {
  if (!dateStr || dateStr.length < 10) return null;
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);
  if (d <= 15 && m >= 2) return `${y}-${String(m - 1).padStart(2, '0')}`;
  if (d <= 15 && m === 1) return `${y - 1}-12`;
  return `${y}-${String(m).padStart(2, '0')}`;
};

export const fetchCompleteStockData = async (stockCode, onProgress = () => {}, options = {}) => {
  const sCode = String(stockCode || "").trim();
  if (!sCode || sCode === "NaN" || sCode === "undefined") {
      throw new Error("無效的股票代碼");
  }

  const skipRevenue = options.skipRevenue === true && options.existingRevenue != null;
  const skipHoldings = options.skipHoldings === true && options.existingHoldings != null && Array.isArray(options.existingHoldings.foreignTotalHolding) && options.existingHoldings.foreignTotalHolding.length > 0;
  const skipInfo = options.skipInfo === true && options.existingInfo?.name;
  const skipPrice = options.skipPrice === true && options.existingPrice != null && Array.isArray(options.existingPrice.priceClose) && options.existingPrice.priceClose.length > 0;
  const skipInstitutional = options.skipInstitutional === true && Array.isArray(options.existingInstitutional?.instDates) && options.existingInstitutional.instDates.length > 0;
  const today = new Date();
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(today.getFullYear() - 3);
  const THREE_YEARS_START = threeYearsAgo.toISOString().split('T')[0];
  const REVENUE_START_DATE = "2024-01-01";

  const getFinmindUrl = (dataset, start) => {
    const params = new URLSearchParams({ dataset, data_id: sCode, start_date: start, token: TOKEN });
    return `${FINMIND_BASE}?${params.toString()}`;
  };

  // 三大法人增量抓取起始日：有舊資料就從最新日+1天抓，否則抓 18 個月
  // calculateFlowSignal histWindow=250 個交易日，需 274 筆才能完整掃連續訊號 ≈ 14 個月
  // 多留 4 個月 buffer 避免假日稀疏時剛好不足
  const eighteenMonthsAgo = new Date(); eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);
  const ONE_YEAR_START = eighteenMonthsAgo.toISOString().split('T')[0];
  const instStartDate = !skipInstitutional && options.existingInstitutional?.latestInstDate
    ? (() => { const d = new Date(options.existingInstitutional.latestInstDate); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })()
    : ONE_YEAR_START;

  try {
    onProgress(` [${sCode}] 正在抓取三年長線持股數據以計算策略門檻...`);

    const priceBundlePromise = skipPrice
      ? Promise.resolve(null)
      : fetchTrackingTablePriceVolumeRows(sCode, options.market, options.yahooChartOpts);
    const holdingPromise = skipHoldings ? Promise.resolve(null) : safeFetch(getFinmindUrl("TaiwanStockShareholding", THREE_YEARS_START));
    const revenuePromise = skipRevenue ? Promise.resolve(null) : safeFetch(getFinmindUrl("TaiwanStockMonthRevenue", REVENUE_START_DATE));
    const institutionalPromise = skipInstitutional ? Promise.resolve(null) : safeFetch(getFinmindUrl("TaiwanStockInstitutionalInvestorsBuySell", instStartDate));
    const [priceBundle, holdingRes, revenueRes, institutionalRes] = await Promise.all([
      priceBundlePromise,
      holdingPromise,
      revenuePromise,
      institutionalPromise,
    ]);

    if (!skipPrice && !priceBundle) {
      throw new Error("無法取得基礎股價數據，請檢查代碼或隧道狀態");
    }

    const latestPER = '--';
    const latestPERDate = null;

    let priceCloseArray_NewestFirst;
    let volumeArray_NewestFirst;
    let latestPriceDate;
    let currentPrice;
    let yesterdayClose;
    if (skipPrice && options.existingPrice) {
      priceCloseArray_NewestFirst = options.existingPrice.priceClose || [];
      volumeArray_NewestFirst = options.existingPrice.volume || [];
      latestPriceDate = options.existingPrice.latestPriceDate || null;
      currentPrice = options.existingPrice.currentPrice ?? (priceCloseArray_NewestFirst[0] || 0);
      yesterdayClose = options.existingPrice.yesterdayClose ?? (priceCloseArray_NewestFirst[1] || 0);
    } else {
      priceCloseArray_NewestFirst = priceBundle.priceCloseArray_NewestFirst;
      volumeArray_NewestFirst = priceBundle.volumeArray_NewestFirst;
      latestPriceDate = priceBundle.latestPriceDate;
      currentPrice = priceBundle.currentPrice;
      yesterdayClose = priceBundle.yesterdayClose;
    }

    let foreignTotal_NewestFirst;
    let foreignDates_NewestFirst;
    let latestHoldingsDate;
    if (skipHoldings && options.existingHoldings) {
      foreignTotal_NewestFirst = options.existingHoldings.foreignTotalHolding || [];
      foreignDates_NewestFirst = options.existingHoldings.foreignHoldingDates || [];
      latestHoldingsDate = options.existingHoldings.latestHoldingsDate || null;
    } else {
      const rawHoldingData = holdingRes?.data || [];
      // reverse：FinMind 原始資料最舊在前，改為最新在前（newest-first）
      const reversedHoldingData = [...rawHoldingData].reverse();
      foreignTotal_NewestFirst = reversedHoldingData.map(d => Math.round((d.ForeignInvestmentShares || 0) / 1000));
      foreignDates_NewestFirst = reversedHoldingData.map(d => d.date?.slice(0, 10) ?? null);
      latestHoldingsDate = foreignDates_NewestFirst[0] ?? getLatestDateFromFinmindRows(holdingRes?.data);
      // FinMind 查無資料（配額耗盡/暫時失敗）→ 保留現有持股，不用空陣列覆蓋
      if (foreignTotal_NewestFirst.length === 0 && options.existingHoldings?.foreignTotalHolding?.length > 0) {
        foreignTotal_NewestFirst = options.existingHoldings.foreignTotalHolding;
        foreignDates_NewestFirst = options.existingHoldings.foreignHoldingDates || [];
        latestHoldingsDate = options.existingHoldings.latestHoldingsDate ?? latestHoldingsDate;
      }
    }
    
    let revenueArray_OldestFirst;
    let latestRevenueDate;
    let latestRevenueFetchedDate;
    if (skipRevenue && options.existingRevenue) {
      revenueArray_OldestFirst = options.existingRevenue.revenueRaw || [];
      latestRevenueDate = options.existingRevenue.latestRevenueDate || null;
      latestRevenueFetchedDate = options.existingRevenue.latestRevenueFetchedDate || null;
    } else {
      revenueArray_OldestFirst = (revenueRes?.data || []).map(d => Math.round((d.revenue || 0) / 1000));
      latestRevenueDate = revenueRes?.data?.length ? getLatestDateFromFinmindRows(revenueRes.data) : null;
      latestRevenueFetchedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    }
    const revenueYoYArray_OldestFirst = (skipRevenue && Array.isArray(options.existingRevenue?.revenueYoY) && options.existingRevenue.revenueYoY.length > 0)
      ? options.existingRevenue.revenueYoY
      : revenueArray_OldestFirst
          .map((cur, i) => {
            const prev = revenueArray_OldestFirst[i - 12];
            return (prev && prev > 0) ? parseFloat(((cur - prev) / prev * 100).toFixed(2)) : null;
          }).filter(val => val !== null);

    let stockName;
    if (skipInfo) {
      stockName = options.existingInfo.name;
    } else {
      // 1. TWSE/TPEX 官方中文簡稱（最準確）
      const twName = await getTaiwanStockDisplayName(sCode);
      if (twName) {
        stockName = twName;
      } else {
        // 2. Yahoo Finance 股票名稱
        const yahooName = await fetchYahooStockDisplayName(sCode, options.market);
        stockName = yahooName || '未知';
      }
    }

    // 三大法人序列：合併舊資料 + 新增量
    let mergedInst;
    if (skipInstitutional && options.existingInstitutional) {
      mergedInst = {
        instDates:   options.existingInstitutional.instDates   || [],
        instForeign: options.existingInstitutional.instForeign || [],
        instTrust:   options.existingInstitutional.instTrust   || [],
        instDealer:  options.existingInstitutional.instDealer  || [],
      };
    } else {
      const newParsed = parseInstRows(institutionalRes?.data);
      mergedInst = mergeInstArrays(options.existingInstitutional, newParsed);
    }
    const latestInstDate = mergedInst.instDates[0] ?? null;

    return {
      code: sCode,
      name: stockName,
      currentPrice,
      yesterdayClose,
      realTimePE: latestPER,
      lastUpdate: Date.now(),
      latestPriceDate,
      latestPERDate,
      latestHoldingsDate,
      latestRevenueDate,
      latestRevenueFetchedDate,
      latestInstDate,
      history: {
        priceClose: priceCloseArray_NewestFirst,
        volume: volumeArray_NewestFirst,
        foreignTotalHolding: foreignTotal_NewestFirst,
        foreignHoldingDates: foreignDates_NewestFirst,
        revenueRaw: revenueArray_OldestFirst,
        revenueYoY: revenueYoYArray_OldestFirst,
        instDates:   mergedInst.instDates,
        instForeign: mergedInst.instForeign,
        instTrust:   mergedInst.instTrust,
        instDealer:  mergedInst.instDealer,
      }
    };
  } catch (error) {
    onProgress(`❌ 錯誤: ${error.message}`);
    throw error; 
  }
};

// 籌碼面（持股）台灣時間晚上 9 點才更新，9 點前不會有新資料
const isBeforeTaiwan9PM = () => {
  const utcHour = new Date().getUTCHours();
  const taiwanHour = (utcHour + 8) % 24;
  return taiwanHour < 21;
};

/**
 * @param {object} stock - 股票物件
 * @param {object} [syncOptions]
 * @param {'all'|'priceVolume'|'holdingsRevenue'} [syncOptions.syncMode='all']
 *   - 'all': 全部更新（預設）
 *   - 'priceVolume': 僅更新價量（跳過外資持股與營收）
 *   - 'holdingsRevenue': 僅更新外資持股與營收（跳過價量）
 */
export const syncStockSnapshots = async (stock, { syncMode = 'all' } = {}) => {
  const modeLabel = syncMode === 'priceVolume' ? '價量' : syncMode === 'holdingsRevenue' ? '籌碼/營收' : '全部';
  console.log(`🚀 正在同步 ${stock.name || stock.code}（${modeLabel}）...`);
  try {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const lastCompleteMonth = now.getMonth() === 0
      ? `${now.getFullYear() - 1}-12`
      : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;
    // 已有本月資料，或今天已嘗試抓過（資料還沒出來也不再重打）
    const haveLatestRevenue = (stock.latestRevenueFetchedDate === todayStr) || (stock.latestRevenueDate && toRevenueMonthStr(stock.latestRevenueDate) === lastCompleteMonth);
    // 9 點前不抓籌碼（FinMind 尚未更新今日資料），但若 DB 資料已落後超過一天（昨天以前）仍需補抓
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    const holdingsUpToDate = stock.latestHoldingsDate >= yesterdayStr;
    const hasHoldingsData = stock.history?.foreignTotalHolding?.length > 0;
    // 加入 hasHoldingsData 判斷：即使日期夠新，若資料是空陣列也必須重抓（防止空資料卡死）
    const skipHoldingsThisSync = (isBeforeTaiwan9PM() && holdingsUpToDate && hasHoldingsData) || (stock.latestHoldingsDate === todayStr && hasHoldingsData);
    const instUpToDate = stock.latestInstDate >= yesterdayStr;
    const skipInstThisSync = (isBeforeTaiwan9PM() && instUpToDate) || (stock.latestInstDate === todayStr && stock.history?.instDates?.length > 0);
    const havePriceData = stock.latestPriceDate === todayStr && stock.history?.priceClose?.length > 0;
    const haveLatestPrice = havePriceData;
    const opts = {};

    // ── syncMode 強制跳過邏輯 ──
    const forceSkipPrice = syncMode === 'holdingsRevenue';
    const forceSkipHoldings = syncMode === 'priceVolume';
    const forceSkipRevenue = syncMode === 'priceVolume';

    if (haveLatestPrice || forceSkipPrice) {
      opts.skipPrice = true;
      opts.existingPrice = {
        priceClose: stock.history?.priceClose || [],
        volume: stock.history?.volume || [],
        currentPrice: stock.currentPrice,
        yesterdayClose: stock.yesterdayClose,
        latestPriceDate: stock.latestPriceDate,
      };
    }
    if (haveLatestRevenue || forceSkipRevenue) {
      opts.skipRevenue = true;
      opts.existingRevenue = { revenueRaw: stock.history?.revenueRaw, revenueYoY: stock.history?.revenueYoY, latestRevenueDate: stock.latestRevenueDate, latestRevenueFetchedDate: stock.latestRevenueFetchedDate };
    }
    if (skipHoldingsThisSync || forceSkipHoldings) {
      opts.skipHoldings = true;
      opts.existingHoldings = { foreignTotalHolding: stock.history?.foreignTotalHolding || [], foreignHoldingDates: stock.history?.foreignHoldingDates || [], latestHoldingsDate: stock.latestHoldingsDate };
    } else if (stock.history?.foreignTotalHolding?.length > 0) {
      // 需要重抓，但帶入現有資料作 fallback：防止 FinMind 暫時失敗時把 Firestore 覆蓋成空陣列
      opts.existingHoldings = { foreignTotalHolding: stock.history.foreignTotalHolding, foreignHoldingDates: stock.history?.foreignHoldingDates || [], latestHoldingsDate: stock.latestHoldingsDate };
    }
    if (skipInstThisSync || forceSkipHoldings) {
      opts.skipInstitutional = true;
      opts.existingInstitutional = {
        instDates:      stock.history?.instDates   || [],
        instForeign:    stock.history?.instForeign || [],
        instTrust:      stock.history?.instTrust   || [],
        instDealer:     stock.history?.instDealer  || [],
        latestInstDate: stock.latestInstDate       || null,
      };
    } else if (stock.history?.instDates?.length > 0) {
      // 有舊資料但需更新：傳入現有資料供增量合併
      opts.existingInstitutional = {
        instDates:      stock.history.instDates,
        instForeign:    stock.history.instForeign || [],
        instTrust:      stock.history.instTrust   || [],
        instDealer:     stock.history.instDealer  || [],
        latestInstDate: stock.latestInstDate       || null,
      };
    }
    if (stock.name && stock.name !== "讀取中..." && stock.name !== "未知") {
      opts.skipInfo = true;
      opts.existingInfo = { name: stock.name };
    }
    // 若 RS 已同步最新交易日且有 priceMap/volumeMap，直接沿用，跳過 Yahoo 請求
    const latestTradingYmd = getLatestTradingYmd();
    if (!opts.skipPrice) {
      try {
        const rsSnap = await getDoc(doc(RS_RATINGS_COLLECTION, stock.code));
        if (rsSnap.exists()) {
          const rsData = rsSnap.data();
          if (
            rsData?.ibdRsPriceFetchedDate >= latestTradingYmd &&
            rsData?.priceMap && typeof rsData.priceMap === 'object' &&
            Object.keys(rsData.priceMap).length > 0
          ) {
            const pm = rsData.priceMap;
            const vm = (rsData.volumeMap && typeof rsData.volumeMap === 'object') ? rsData.volumeMap : {};
            const datesAsc = Object.keys(pm).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
            const rsLatestDate = datesAsc[datesAsc.length - 1];
            // 只有 RS priceMap 確實含有最新交易日資料時才沿用；
            // 若 RS 同步時 Yahoo 歷史 API 尚未更新當日 K 棒（最新仍為昨日），
            // 則不採用，繼續去 Yahoo 重抓，避免覆蓋已正確寫入的今日資料。
            if (datesAsc.length > 0 && rsLatestDate >= latestTradingYmd) {
              const datesDesc = [...datesAsc].reverse();
              opts.skipPrice = true;
              opts.existingPrice = {
                priceClose: datesDesc.map((d) => pm[d]),
                volume: datesDesc.map((d) => {
                  const v = vm[d];
                  return v != null && Number.isFinite(v) ? v : 0;
                }),
                currentPrice: pm[datesAsc[datesAsc.length - 1]] ?? 0,
                yesterdayClose: datesAsc.length >= 2 ? pm[datesAsc[datesAsc.length - 2]] : 0,
                latestPriceDate: rsLatestDate,
              };
              console.log(`[${stock.code}] 沿用 RS priceMap（最新交易日 ${latestTradingYmd}），跳過 Yahoo`);
            } else if (datesAsc.length > 0) {
              console.log(`[${stock.code}] RS priceMap 最新日 ${rsLatestDate} < 最新交易日 ${latestTradingYmd}，不沿用，重抓 Yahoo`);
            }
          }
        }
      } catch (e) {
        // RS doc 讀取失敗，繼續正常 Yahoo 抓取
      }
    }
    const latestData = await fetchCompleteStockData(stock.code, () => {}, { ...opts, market: stock.market });
    if (!latestData) return { updated: false, skipped: true, failed: false };

    // ── 防止股價日期倒退 ──────────────────────────────
    // 讀取 Firestore 現有的 latestPriceDate，若本次抓到的日期更舊，
    // 則保留 Firestore 中較新的股價資料，只更新非股價欄位（籌碼、營收等）。
    // 這是最終安全網，無論資料來自 RS priceMap / Yahoo / FinMind 都能攔截。
    const targetDocId = stock.code;
    try {
      const existingSnap = await getDoc(doc(STOCK_WATCHLIST_COLLECTION, targetDocId));
      if (existingSnap.exists()) {
        const existingDate = existingSnap.data()?.latestPriceDate;
        if (existingDate && latestData.latestPriceDate && latestData.latestPriceDate < existingDate) {
          console.warn(`⚠️ [${stock.code}] 防止股價倒退：新 ${latestData.latestPriceDate} < 現有 ${existingDate}，保留現有股價`);
          const existingDoc = existingSnap.data();
          latestData.latestPriceDate = existingDate;
          latestData.currentPrice = existingDoc.currentPrice ?? latestData.currentPrice;
          latestData.yesterdayClose = existingDoc.yesterdayClose ?? latestData.yesterdayClose;
          if (Array.isArray(existingDoc.history?.priceClose) && existingDoc.history.priceClose.length > 0) {
            latestData.history.priceClose = existingDoc.history.priceClose;
            latestData.history.volume = existingDoc.history.volume || latestData.history.volume;
          }
        }
      }
    } catch (e) {
      // 讀取失敗不阻擋同步，繼續正常寫入
      console.warn(`[${stock.code}] 日期倒退檢查讀取失敗:`, e?.message);
    }

    // 計算籌碼指標：以 stock（舊的 foreignBCount）延續連續 B 天計數
    const indicators = calculateSingleStockIndicators({ ...stock, ...latestData });
    await updateAnalysisField(targetDocId, {
      ...latestData,
      id: targetDocId,
      code: stock.code,
      estimatedEPS: stock.estimatedEPS || 0,
      targetPrice: stock.targetPrice || 0,
      notes: stock.notes || "",
      foreignSignal: indicators.foreignSignal ?? "N",
      foreignBCount: indicators.foreignBCount ?? 0,
      zScore: indicators.zScore ?? 0,
      lastUpdate: Date.now()
    });
    // 舊文件 ID 是 UUID → 寫入新文件後刪掉舊的
    if (stock.id !== targetDocId) {
      await deleteAnalysisDoc(stock.id);
      console.log(`🗑️ [${stock.code}] 舊 UUID 文件 ${stock.id} 已刪除`);
    }
    console.log(`✅ [${stock.code}] 數據同步成功。`);
    return { updated: true, skipped: false, failed: false };
  } catch (error) {
    console.error(`❌ [${stock.code}] 失敗:`, error.message);
    return { updated: false, skipped: false, failed: true };
  }
};