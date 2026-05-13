/* src/features/StockAnalysis/api/rsStockList.js */

/**
 * 從 TWSE（上市）+ TPEX（上櫃）Open API 抓取完整台股清單
 *
 * 快取策略（優先順序）：
 *   1. localStorage 當日快取（最快，同一瀏覽器）
 *   2. Firestore ibdRsMeta/stockList（跨裝置/跨瀏覽器）
 *   3. 直接打 TWSE + TPEX OpenAPI（含 retry），成功後同步寫回 1+2
 */

import { getDoc, setDoc } from 'firebase/firestore';
import { STOCK_LIST_DOC_REF } from '../../../utils/firebaseConfig';
import TPEX_FALLBACK from './tpexStockListFallback.json';

const PROXY_BASE = 'https://stock-proxy-zeta.vercel.app/api/proxy?url=';

const TWSE_LIST_URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L';
const TPEX_LIST_URL = 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O';

const LS_STOCK_LIST_KEY = 'research-website-stockList';
const FETCH_TIMEOUT_MS = 15000;

function getTaiwanYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

/** 讀 localStorage 快取；可選擇是否只接受當日 */
function readLsCache({ allowStale = false } = {}) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LS_STOCK_LIST_KEY);
    if (!raw) return null;
    const { date, list } = JSON.parse(raw);
    if (!Array.isArray(list) || list.length < 100) return null;
    if (!allowStale && date !== getTaiwanYmd()) return null;
    return { date, list };
  } catch {
    return null;
  }
}

/** 寫 localStorage 快取 */
function writeLsCache(list) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_STOCK_LIST_KEY, JSON.stringify({ date: getTaiwanYmd(), list }));
  } catch (_) {}
}

/** 讀 Firestore 當日快取；失敗或過期回傳 null */
async function readFirestoreCache({ allowStale = false } = {}) {
  try {
    const snap = await getDoc(STOCK_LIST_DOC_REF);
    if (!snap.exists()) return null;
    const { date, list } = snap.data();
    if (!Array.isArray(list) || list.length < 100) return null;
    if (!allowStale && date !== getTaiwanYmd()) return null;
    return { date, list };
  } catch (e) {
    console.warn('[RS StockList] Firestore 快取讀取失敗:', e.message);
    return null;
  }
}

/** 寫 Firestore 快取（非同步，不擋主流程） */
async function writeFirestoreCache(list) {
  try {
    await setDoc(STOCK_LIST_DOC_REF, { date: getTaiwanYmd(), list, updatedAt: Date.now() });
  } catch (e) {
    console.warn('[RS StockList] Firestore 快取寫入失敗:', e.message);
  }
}

/** Exponential backoff retry */
async function withRetry(fn, { maxRetries = 5, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries) break;
      const wait = baseDelayMs * 2 ** attempt + Math.random() * 500;
      console.warn(`[RS StockList] 第 ${attempt + 1} 次失敗，${Math.round(wait)}ms 後重試：${e.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function fetchTextWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判斷是否為「一般股票/ETF」代碼（4 位純數字）
 * 排除：權證（通常 6 位）、特別股（通常帶英文字母後綴）、牛熊證等
 */
function isRegularCode(code) {
  return /^\d{4}$/.test(String(code || '').trim());
}

/**
 * OpenAPI 回傳可能是頂層陣列，或包在 data / body（字串再 parse）等欄位
 */
function unwrapJsonArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed == null || typeof parsed !== 'object') return null;
  const keys = ['data', 'Data', 'records', 'Records', 'result', 'Result', 'list', 'List', 'items', 'Items'];
  for (const k of keys) {
    const v = parsed[k];
    if (Array.isArray(v)) return v;
  }
  if (typeof parsed.body === 'string') {
    try {
      const inner = JSON.parse(parsed.body);
      const u = unwrapJsonArray(inner);
      if (u) return u;
      if (Array.isArray(inner)) return inner;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

/**
 * 透過 proxy 抓 JSON，回傳列舉陣列（失敗或無法解析為陣列時回傳 []）
 */
async function proxyFetchArray(targetUrl) {
  const full = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
  const res = await fetchTextWithTimeout(full);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${targetUrl}`);
  const text = (await res.text()).replace(/^\uFEFF/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.warn(`[RS StockList] JSON 解析失敗: ${targetUrl.slice(-48)}`, e?.message);
    return [];
  }
  const rows = unwrapJsonArray(parsed);
  if (rows == null) {
    const hint = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 12).join(',') : typeof parsed;
    console.warn(`[RS StockList] 回應非預期格式（無法取得陣列）: ${targetUrl.slice(-48)} keys=${hint}`);
    return [];
  }
  return rows;
}

async function directFetchArray(targetUrl) {
  const res = await fetchTextWithTimeout(targetUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${targetUrl}`);
  const text = (await res.text()).replace(/^\uFEFF/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.warn(`[RS StockList] 直連 JSON 解析失敗: ${targetUrl.slice(-48)}`, e?.message);
    return [];
  }
  const rows = unwrapJsonArray(parsed);
  if (rows == null) return [];
  return rows;
}

async function fetchArrayWithFallback(targetUrl) {
  try {
    return await withRetry(() => proxyFetchArray(targetUrl), { maxRetries: 3, baseDelayMs: 900 });
  } catch (proxyErr) {
    console.warn('[RS StockList] Proxy 失敗，改走直連：', proxyErr.message);
    return withRetry(() => directFetchArray(targetUrl), { maxRetries: 2, baseDelayMs: 700 });
  }
}

/**
 * 從陣列項目中抽取「代號」與「簡稱/名稱」
 * TWSE：中文欄位（公司代號、公司簡稱）
 * TPEX：英文欄位（SecuritiesCompanyCode、CompanyAbbreviation）
 */
function extractFields(item) {
  const rawCode =
    item['公司代號'] ??
    item['SecuritiesCompanyCode'] ??
    item['securitiesCompanyCode'] ??
    item['code'] ??
    item['Code'] ??
    '';
  const code = String(rawCode ?? '').trim();

  const name = String(
    item['公司簡稱'] ??
    item['CompanyAbbreviation'] ??
    item['公司名稱'] ??
    item['CompanyName'] ??
    item['name'] ??
    item['Name'] ??
    ''
  ).trim();

  return { code, name };
}

/**
 * 抓取全台股清單（上市 + 上櫃），回傳：
 * [{ id: '2330', name: '台積電', market: 'TWSE' | 'TPEX' }, ...]
 *
 * 保護機制：
 *   1. localStorage 當日快取：當天已成功拿過就不再打 OpenAPI
 *   2. Exponential backoff retry（各自最多 5 次）
 *   3. Fail-fast：任一段拿不到有效資料（<100 筆）就 throw，不用半套清單繼續跑
 */
export async function fetchTaiwanStockList() {
  // ── 1. localStorage 快取（最快）──────────────────────────────────────
  const lsCached = readLsCache();
  if (lsCached) {
    console.log(`[RS StockList] localStorage 快取：${lsCached.list.length} 檔`);
    return lsCached.list;
  }

  // ── 2. Firestore 快取（跨裝置）───────────────────────────────────────
  const fsCached = await readFirestoreCache();
  if (fsCached) {
    console.log(`[RS StockList] Firestore 快取：${fsCached.list.length} 檔`);
    writeLsCache(fsCached.list); // 順便存進 localStorage 加速下次
    return fsCached.list;
  }

  const all = [];
  const seen = new Set();

  const addStock = (code, name, market) => {
    if (!isRegularCode(code)) return;
    if (seen.has(code)) return;
    seen.add(code);
    all.push({ id: code, name: name || code, market });
  };

  try {
    // ── 3. 線上抓取（先 proxy，失敗自動改直連）────────────────────────────
    const twseData = await fetchArrayWithFallback(TWSE_LIST_URL);
    if (!twseData || twseData.length < 100) {
      throw new Error(`[RS StockList] TWSE 清單不完整（${twseData?.length ?? 0} 筆）`);
    }

    let tpexData = [];
    try {
      tpexData = await fetchArrayWithFallback(TPEX_LIST_URL);
    } catch (tpexErr) {
      console.warn('[RS StockList] TPEX 線上抓取失敗：', tpexErr.message);
    }

    for (const item of twseData) {
      const { code, name } = extractFields(item);
      addStock(code, name, 'TWSE');
    }
    console.log(`[RS StockList] TWSE 上市：${all.length} 檔`);

    if (tpexData.length >= 100) {
      let added = 0;
      for (const item of tpexData) {
        const { code, name } = extractFields(item);
        if (!isRegularCode(code) || seen.has(code)) continue;
        seen.add(code);
        all.push({ id: code, name: name || code, market: 'TPEX' });
        added++;
      }
      console.log(`[RS StockList] TPEX 上櫃：+${added} 檔，合計 ${all.length} 檔`);
    } else {
      console.warn(`[RS StockList] TPEX 清單不完整（${tpexData.length} 筆），改用內建備援清單（${TPEX_FALLBACK.length} 檔）`);
      for (const s of TPEX_FALLBACK) {
        addStock(s.id, s.name, 'TPEX');
      }
      console.log(`[RS StockList] 備援上櫃清單已載入，合計 ${all.length} 檔`);
    }
  } catch (networkErr) {
    // 最後保底：使用「非當日」舊快取，至少讓流程可繼續，不因外部 API 一時故障而中斷
    console.warn('[RS StockList] 線上抓取失敗，嘗試使用舊快取：', networkErr.message);
    const staleLs = readLsCache({ allowStale: true });
    if (staleLs) {
      console.warn(`[RS StockList] 使用 localStorage 舊快取（${staleLs.date}，${staleLs.list.length} 檔）`);
      return staleLs.list;
    }
    const staleFs = await readFirestoreCache({ allowStale: true });
    if (staleFs) {
      console.warn(`[RS StockList] 使用 Firestore 舊快取（${staleFs.date}，${staleFs.list.length} 檔）`);
      writeLsCache(staleFs.list);
      return staleFs.list;
    }
    throw networkErr;
  }

  // ── 4. 寫快取（localStorage 同步 + Firestore 非同步）────────────────
  writeLsCache(all);
  writeFirestoreCache(all); // 不 await，背景跑

  return all;
}

/** 單次頁面連線內共用，避免重複 getDoc */
let _stockListFromDbMemo = null;
let _stockListFromDbInflight = null;

/**
 * 僅從 Firestore `ibdRsMeta/stockList` 讀上市櫃清單，不打 OpenAPI、不讀 localStorage。
 * 清單須先由分析／RS 流程寫入；無資料時回傳 null。
 * @returns {Promise<Array<{ id: string, name: string, market?: string }>|null>}
 */
export async function fetchTaiwanStockListFromDb() {
  if (_stockListFromDbMemo) return _stockListFromDbMemo;
  if (_stockListFromDbInflight) return _stockListFromDbInflight;
  _stockListFromDbInflight = (async () => {
    try {
      const snap = await getDoc(STOCK_LIST_DOC_REF);
      if (!snap.exists()) return null;
      const { list } = snap.data();
      if (!Array.isArray(list) || list.length === 0) return null;
      _stockListFromDbMemo = list;
      return list;
    } catch (e) {
      console.warn('[RS StockList] fetchTaiwanStockListFromDb failed:', e?.message);
      return null;
    } finally {
      _stockListFromDbInflight = null;
    }
  })();
  return _stockListFromDbInflight;
}

/** 強制下次重新 getDoc（例如手動「重新檢查」要比最新清單） */
export function invalidateTaiwanStockListFromDbCache() {
  _stockListFromDbMemo = null;
  _stockListFromDbInflight = null;
}

/**
 * 比對交易日誌與 Firestore 股票清單（不寫入）
 * @returns {{ mismatches: Array, notInDb: Array, skippedNonFour: Array }}
 */
export function buildJournalNameMismatchReport(entries, list) {
  if (!list || !Array.isArray(entries)) {
    return { mismatches: [], notInDb: [], skippedNonFour: [] };
  }
  const idToName = new Map(list.map((s) => [s.id, String(s.name || '').trim()]));
  const mismatches = [];
  const notInDb = [];
  const skippedNonFour = [];
  for (const e of entries) {
    const code = normalizeTaiwanStockCode(e.code);
    if (!/^\d{4}$/.test(code)) {
      skippedNonFour.push({
        id: e.id,
        date: e.date,
        code: e.code,
        name: e.name,
      });
      continue;
    }
    const dbName = idToName.get(code);
    if (!dbName) {
      notInDb.push({
        id: e.id,
        date: e.date,
        code,
        nameInRecord: (e.name || '').trim(),
      });
      continue;
    }
    if ((e.name || '').trim() !== dbName) {
      mismatches.push({
        id: e.id,
        date: e.date,
        code,
        nameInRecord: (e.name || '').trim(),
        nameInDb: dbName,
      });
    }
  }
  return { mismatches, notInDb, skippedNonFour };
}

/** 正規化台股代碼：去空白、移除 .TW / .TWO */
export function normalizeTaiwanStockCode(stockCode) {
  return String(stockCode || '').trim().replace(/\.(TW|TWO)$/i, '');
}

/**
 * 依 Firestore 上市櫃清單查中文簡稱（僅 DB，與 fetchTaiwanStockList 分離）
 * @returns {Promise<string|null>}
 */
export async function getTaiwanStockDisplayName(stockCode) {
  const code = normalizeTaiwanStockCode(stockCode);
  if (!isRegularCode(code)) return null;
  try {
    const list = await fetchTaiwanStockListFromDb();
    if (!list) return null;
    const hit = list.find((s) => s.id === code);
    return hit?.name ? String(hit.name).trim() : null;
  } catch (e) {
    console.warn('[RS StockList] getTaiwanStockDisplayName failed:', e?.message);
    return null;
  }
}
