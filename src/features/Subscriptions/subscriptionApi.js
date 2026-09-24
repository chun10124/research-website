/* src/features/Subscriptions/subscriptionApi.js */

/**
 * 訂閱頁的資料抓取與訊號計算。全部走 stock-proxy（CORS），不吃 FinMind 配額。
 *
 * 營收：觀測站月營收彙總表 t21sc03（一檔＝一市場一個月的全部公司）。抓近 36 個月的檔，
 *       每檔同時有「去年當月」，所以實際有 48 個月資料。
 * 財報：觀測站綜合損益彙總表 t163sb04（一檔＝一市場一季的全部公司，今年累計數），
 *       相減得單季營收／毛利／EPS。抓近 2 年＋今年。
 * 股價：Yahoo chart 5 年日線（圖用週收盤，疊在 EPS 圖上，只畫財報起點之後）。
 * 法說：觀測站舊版 mopsov「法人說明會一覽」按公司查（也包含受邀券商論壇＝座談）。
 * 重訊：觀測站舊版 mopsov「歷史重大訊息」按公司查，只留近 3 個月；全文點開時才抓。
 *
 * 彙總表是全市場檔，快取三層：記憶體 → localStorage（只存已訂閱的代號）→ Firestore
 * subscriptions/bulk_*（全部公司，所有裝置共用）→ 觀測站。本機先看，Firestore 只在換裝置
 * 或新訂閱的代號本機沒有時才讀，避免每次開頁都讀近百份文件。
 * 舊月份／舊季度不會再變，存了就不再抓；最近兩期可能還在陸續申報，12 小時後重抓。
 */

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../../utils/firebaseConfig';
import { parseMonthlyRevenueHtml, parseIncomeStatementHtml, cumulativeToQuarterly } from './mopsParse';

const PROXY_BASE = 'https://stock-proxy.tzuchun11232004.workers.dev/?url=';
const MOPS_CONF_URL = 'https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1';
const CACHE_PREFIX = 'rw-sub-cache_';
const BULK_PREFIX = 'rw-sub-bulk_';
const VOLATILE_TTL_MS = 12 * 60 * 60 * 1000;
const CONF_TTL_MS = 12 * 60 * 60 * 1000;
const QUOTE_TTL_MS = 30 * 60 * 1000;

export const REVENUE_FILE_MONTHS = 36;
const FIN_YEARS_BACK = 2; // 今年往回 2 年的 Q1 起（2026 → 2024Q1），毛利率與 EPS＋股價圖都從這裡開始

const proxied = (url) => `${PROXY_BASE}${encodeURIComponent(url)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

/**
 * 經 proxy 抓，遇到限流（429）或暫時性錯誤就退避重試：等待 base × 2^n（加一點隨機），
 * 有 Retry-After 就照它。Yahoo 經 proxy 易觸發 429（見 stockApi.js 同樣做法）；
 * 觀測站沒公開限流，被擋時多半是暫時的，也給兩次機會。回傳最後一次的 Response（可能非 ok）。
 */
async function fetchRetry(url, { retries = 2, base = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(proxied(url));
      if (res.ok || !RETRYABLE.has(res.status) || attempt >= retries) return res;
      const ra = Number(res.headers.get('Retry-After'));
      await sleep(Math.max(base * 2 ** attempt + Math.random() * 400, ra > 0 ? ra * 1000 : 0));
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(base * 2 ** attempt + Math.random() * 400);
    }
  }
}
const YAHOO_RETRY = { retries: 5, base: 900 };
const pct = (cur, prev) => (prev > 0 && cur != null ? ((cur - prev) / prev) * 100 : null);
export const ymKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const taipeiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

function lsGet(key, ttl) {
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null');
    if (c && (ttl == null || Date.now() - c.at < ttl)) return c.value;
  } catch (_) {}
  return undefined;
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), value })); } catch (_) {}
}

/** 清掉單檔快取（法說、股價）；彙總表快取是全市場共用，不清。 */
export function clearSubscriptionCache(stockId) {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(CACHE_PREFIX) && (!stockId || k.endsWith(`_${stockId}`)))
      .forEach((k) => localStorage.removeItem(k));
  } catch (_) {}
}

/* ── 彙總表三層快取 ───────────────────────────────────────────────────── */

const memBulk = new Map(); // key → { data, at, final }
let firestoreBulkOk = true; // 規則未發布時第一次 permission-denied 後就不再試

/**
 * 取某個彙總檔（key 如 rev_sii0_2026-08、fin_otc_2026-Q2）。ids＝這次需要的代號。
 * fetcher() 回傳全市場 { 代號: 值 }。volatile＝最近幾期，資料可能還在增加。
 */
async function getBulk(key, ids, { fetcher, volatile, force }) {
  const fresh = (c) => c && (c.final || Date.now() - c.at < VOLATILE_TTL_MS);
  // localStorage 只留需要的代號，50 檔 × 數十期才不會塞爆
  const saveLocal = (entry) => {
    const prev = lsGet(BULK_PREFIX + key);
    const covered = [...new Set([...(prev?.covered || []), ...ids])];
    const subset = {};
    covered.forEach((id) => { if (entry.data[id] !== undefined) subset[id] = entry.data[id]; });
    lsSet(BULK_PREFIX + key, { data: subset, covered, at: entry.at, final: entry.final });
  };
  if (!force) {
    const m = memBulk.get(key);
    if (fresh(m)) return m.data;
    const l = lsGet(BULK_PREFIX + key);
    if (fresh(l) && ids.every((id) => l.covered.includes(id))) return l.data;
    if (firestoreBulkOk) {
      try {
        const snap = await getDoc(doc(db, 'subscriptions', `bulk_${key}`));
        if (snap.exists()) {
          const c = snap.data();
          if (fresh(c)) {
            const e = { data: JSON.parse(c.json || '{}'), at: c.at, final: c.final };
            memBulk.set(key, e);
            saveLocal(e);
            return e.data;
          }
        }
      } catch (_) {
        firestoreBulkOk = false;
      }
    }
  }
  const data = await fetcher();
  const final = !volatile && Object.keys(data).length > 0; // 空檔（尚未公布）不當成定案
  const entry = { data, at: Date.now(), final };
  memBulk.set(key, entry);
  if (firestoreBulkOk) {
    // 存成 JSON 字串：上千家公司若展開成 map 欄位，每個都會被建索引，寫入慢又逼近單文件索引上限
    setDoc(doc(db, 'subscriptions', `bulk_${key}`), { json: JSON.stringify(data), at: entry.at, final })
      .catch(() => { firestoreBulkOk = false; });
  }
  saveLocal(entry);
  return data;
}

/* 市場代碼：TWSE→sii、TPEX→otc；未知就兩邊都查 */
const marketsOf = (market) => (market === 'TWSE' ? ['sii'] : market === 'TPEX' ? ['otc'] : ['sii', 'otc']);
/* 月營收彙總表把外國企業（-KY）放在另一個檔 _1 */
const revVariantOf = (name) => (/KY/i.test(name || '') ? 1 : 0);

/* ── 營收 ─────────────────────────────────────────────────────────────── */

async function fetchBig5(url) {
  const res = await fetchRetry(url);
  if (res.status === 404) return '';
  if (!res.ok) throw new Error(`觀測站 HTTP ${res.status}`);
  return new TextDecoder('big5').decode(await res.arrayBuffer());
}

/** 最新可能已公布的營收月＝台北時間上個月；往回 n 個月。 */
function revenueMonths(n) {
  const [y, m] = taipeiToday().split('-').map(Number);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  }
  return out; // 新→舊
}

/**
 * 一次抓多檔的月營收。stocks = [{ id, market, name }]。
 * 回傳 { series: { id: [{ ym, year, month, revenue(元) }] 舊→新 }, errors: { id: 訊息 } }。
 */
export async function loadRevenueBatch(stocks, { force = false } = {}) {
  const months = revenueMonths(REVENUE_FILE_MONTHS);
  const groups = new Map(); // `${mkt}${v}` → ids
  stocks.forEach((s) => marketsOf(s.market).forEach((mkt) => {
    const g = `${mkt}${revVariantOf(s.name)}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s.id);
  }));
  const tasks = [];
  groups.forEach((ids, g) => months.forEach((mo, idx) => tasks.push({ g, ids, mo, volatile: idx < 2 })));

  const got = new Map(); // `${g}|${ym}` → data
  const failed = new Set();
  await runLimited(tasks, 3, async ({ g, ids, mo, volatile }) => { // 觀測站沒公開限流，保守一點
    const ym = ymKey(mo.y, mo.m);
    try {
      const data = await getBulk(`rev_${g}_${ym}`, ids, {
        volatile, force: force && volatile,
        fetcher: async () => parseMonthlyRevenueHtml(
          await fetchBig5(`https://mopsov.twse.com.tw/nas/t21/${g.slice(0, 3)}/t21sc03_${mo.y - 1911}_${mo.m}_${g.slice(3)}.html`),
        ),
      });
      got.set(`${g}|${ym}`, data);
    } catch (_) {
      failed.add(g);
    }
  });

  const series = {};
  const errors = {};
  stocks.forEach((s) => {
    const byYm = new Map();
    const gs = marketsOf(s.market).map((mkt) => `${mkt}${revVariantOf(s.name)}`);
    months.forEach((mo) => {
      const ym = ymKey(mo.y, mo.m);
      gs.forEach((g) => {
        const v = got.get(`${g}|${ym}`)?.[s.id];
        if (!v) return;
        byYm.set(ym, { ym, year: mo.y, month: mo.m, revenue: v[0] * 1000 });
        const lyYm = ymKey(mo.y - 1, mo.m);
        if (v[1] != null && !byYm.has(lyYm)) byYm.set(lyYm, { ym: lyYm, year: mo.y - 1, month: mo.m, revenue: v[1] * 1000 });
      });
    });
    series[s.id] = [...byYm.values()].sort((a, b) => a.ym.localeCompare(b.ym));
    if (gs.some((g) => failed.has(g))) errors[s.id] = '部分月份營收抓取失敗';
    else if (!series[s.id].length) errors[s.id] = '觀測站查無營收';
  });
  return { series, errors };
}

/**
 * 營收統計：每月 YoY、MoM，以及最新月是否創新高。series 為 loadRevenueBatch 的單檔結果。
 */
export function computeRevenueStats(series) {
  if (!series?.length) return null;
  const byYm = new Map(series.map((r) => [r.ym, r]));
  const prevYearOf = (r) => byYm.get(ymKey(r.year - 1, r.month));

  const rows = series.map((r, i) => {
    const py = prevYearOf(r);
    const prev = series[i - 1];
    return { ...r, yoy: py ? pct(r.revenue, py.revenue) : null, mom: prev ? pct(r.revenue, prev.revenue) : null };
  });

  const latest = rows[rows.length - 1];
  const prior = rows.slice(0, -1);
  const isAth = prior.length > 0 && latest.revenue > Math.max(...prior.map((r) => r.revenue));

  return { rows, latest, isAth, since: series[0].ym };
}

/* ── 財報（毛利率、EPS）─────────────────────────────────────────────── */

/** 需要的季度：近 FIN_YEARS_BACK 年全年＋今年到上一季（相減要同年前一季，所以整年都抓）。 */
function financialQuarters() {
  const [y, m] = taipeiToday().split('-').map(Number);
  const curQ = Math.ceil(m / 3);
  const out = [];
  for (let yy = y - FIN_YEARS_BACK; yy <= y; yy++) {
    for (let q = 1; q <= 4; q++) {
      if (yy === y && q >= curQ) break;
      out.push({ y: yy, q });
    }
  }
  return out; // 舊→新
}

/**
 * 一次抓多檔的季報。回傳 { quarters: { id: [{ q:'2026-Q2', rev, gp, eps, gm }] 舊→新 }, errors }。
 */
export async function loadFinancialsBatch(stocks, { force = false } = {}) {
  const qs = financialQuarters();
  const mkts = new Map();
  stocks.forEach((s) => marketsOf(s.market).forEach((mkt) => {
    if (!mkts.has(mkt)) mkts.set(mkt, []);
    mkts.get(mkt).push(s.id);
  }));
  const tasks = [];
  mkts.forEach((ids, mkt) => qs.forEach((qq, i) => tasks.push({ mkt, ids, qq, volatile: i >= qs.length - 2 })));

  const got = new Map();
  const failed = new Set();
  await runLimited(tasks, 3, async ({ mkt, ids, qq, volatile }) => {
    const k = `${qq.y}-Q${qq.q}`;
    try {
      const data = await getBulk(`fin_${mkt}_${k}`, ids, {
        volatile, force: force && volatile,
        fetcher: async () => {
          const u = `https://mopsov.twse.com.tw/mops/web/ajax_t163sb04?encodeURIComponent=1&step=1&firstin=1&off=1&isQuery=Y&TYPEK=${mkt}&year=${qq.y - 1911}&season=0${qq.q}`;
          const res = await fetchRetry(u);
          if (!res.ok) throw new Error(`觀測站 HTTP ${res.status}`);
          return parseIncomeStatementHtml(await res.text());
        },
      });
      got.set(`${mkt}|${k}`, data);
    } catch (_) {
      failed.add(mkt);
    }
  });

  const quarters = {};
  const errors = {};
  stocks.forEach((s) => {
    const cum = {};
    qs.forEach((qq) => {
      const k = `${qq.y}-Q${qq.q}`;
      marketsOf(s.market).forEach((mkt) => {
        const v = got.get(`${mkt}|${k}`)?.[s.id];
        if (v) cum[k] = v;
      });
    });
    quarters[s.id] = cumulativeToQuarterly(cum);
    if (marketsOf(s.market).some((m) => failed.has(m))) errors[s.id] = '部分季度財報抓取失敗';
  });
  return { quarters, errors };
}

/* ── 股價（Yahoo 日線，圖用週收盤）──────────────────────────────────── */

/**
 * 回傳 { price, change, changePct, date, chg1w, chg1m, series:[{date, close}], recent:[{date, high, low, close}] }。
 * recent＝近 60 個交易日含最高／最低價，給「盤中觸及」價位提醒用。
 * 抓 5 年日線：漲跌用最後兩根日線；series 縮成每週最後一個收盤（疊在 12 季 EPS 圖上夠用，
 * 50 檔存 localStorage 也不會太大），最後一天一定保留。
 * 丟掉週末的 K 棒：Yahoo 偶爾在非交易日多吐一根殘根，會讓漲跌變成 0。
 */
export async function fetchQuote(stockId, market, { force = false } = {}) {
  const key = `${CACHE_PREFIX}quote5y3_${stockId}`; // 5y3：多了 recent（最高／最低價），舊快取不沿用
  if (!force) {
    const hit = lsGet(key, QUOTE_TTL_MS);
    if (hit) return hit;
  }
  const suffixes = market === 'TWSE' ? ['.TW'] : market === 'TPEX' ? ['.TWO'] : ['.TW', '.TWO'];
  for (const sfx of suffixes) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${stockId}${sfx}?interval=1d&range=5y`;
    const res = await fetchRetry(url, YAHOO_RETRY);
    if (!res.ok) continue;
    const r = (await res.json())?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const qd = r?.indicators?.quote?.[0] || {};
    const closes = qd.close || [];
    const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
    const daily = ts
      .map((t, i) => ({ date: new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 10), close: closes[i], high: qd.high?.[i], low: qd.low?.[i] }))
      .filter((b) => b.close != null && ![0, 6].includes(new Date(`${b.date}T00:00:00Z`).getUTCDay()))
      .map((b) => ({ date: b.date, close: r2(b.close), high: r2(b.high ?? b.close), low: r2(b.low ?? b.close) }));
    // Yahoo 偶爾最新一根日線的 close 是 null（2026-09-24 實際遇到），但 meta 仍有最新成交價。
    // meta 日期比最後一根新、且是平日時補上，否則漲跌會退回前一天。
    const mp = Number(r?.meta?.regularMarketPrice);
    const mt = Number(r?.meta?.regularMarketTime);
    if (mp > 0 && mt > 0) {
      const mDate = new Date((mt + 8 * 3600) * 1000).toISOString().slice(0, 10);
      const wd = new Date(`${mDate}T00:00:00Z`).getUTCDay();
      if (wd !== 0 && wd !== 6 && (!daily.length || mDate > daily[daily.length - 1].date)) {
        const hi = Number(r.meta.regularMarketDayHigh) || mp;
        const lo = Number(r.meta.regularMarketDayLow) || mp;
        daily.push({ date: mDate, close: r2(mp), high: r2(hi), low: r2(lo) });
      }
    }
    if (daily.length < 2) continue;
    const weekOf = (ymd) => {
      const d = new Date(`${ymd}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 該週週一
      return d.toISOString().slice(0, 10);
    };
    const byWeek = new Map();
    daily.forEach((b) => byWeek.set(weekOf(b.date), b));
    const series = [...byWeek.values()].map((b) => ({ date: b.date, close: b.close }));
    const last = daily[daily.length - 1];
    const prev = daily[daily.length - 2];
    // 近一週／近一個月漲幅：以最後交易日往回 7 天、1 個月當天或之前最近的收盤為基準（日曆日，遇假日自動往前找）
    const closeOnOrBefore = (ymd) => { for (let i = daily.length - 1; i >= 0; i--) if (daily[i].date <= ymd) return daily[i].close; return null; };
    const back = (days, months) => {
      const d = new Date(`${last.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - days);
      d.setUTCMonth(d.getUTCMonth() - months);
      return d.toISOString().slice(0, 10);
    };
    const value = {
      price: last.close, change: last.close - prev.close, changePct: pct(last.close, prev.close), date: last.date,
      chg1w: pct(last.close, closeOnOrBefore(back(7, 0))), chg1m: pct(last.close, closeOnOrBefore(back(0, 1))),
      series,
      recent: daily.slice(-60),
    };
    lsSet(key, value);
    return value;
  }
  throw new Error('股價抓取失敗');
}

/* ── 法說會／座談 ─────────────────────────────────────────────────────── */

const domText = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const rocToIso = (s) => {
  const m = /(\d{2,3})\/(\d{1,2})\/(\d{1,2})/.exec(s);
  return m ? `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};

async function queryConf(typek, rocYear, stockId) {
  const params = new URLSearchParams({
    encodeURIComponent: 1, step: 1, firstin: 1, off: 1, TYPEK: typek, year: rocYear, month: '', co_id: stockId,
  });
  const res = await fetchRetry(`${MOPS_CONF_URL}?${params}`);
  if (!res.ok) throw new Error(`觀測站 HTTP ${res.status}`);
  const html = await res.text();
  if (!html.includes('data-type') && !html.includes('查無') && !html.includes('查詢無資料')) {
    // WAF 攔截頁或改版：寧可報錯，也不要當成「沒有法說」
    throw new Error('觀測站回應非預期格式');
  }
  const d = new DOMParser().parseFromString(html, 'text/html');
  return [...d.querySelectorAll("tr[data-type='body']")].map((tr) => {
    const td = [...tr.querySelectorAll('td')];
    if (td.length < 6) return null;
    const dates = [...domText(td[2]).matchAll(/\d{2,3}\/\d{1,2}\/\d{1,2}/g)].map((m) => rocToIso(m[0]));
    if (!dates.length) return null;
    const link = td[8]?.querySelector('a[href^="http"]')?.getAttribute('href') || null;
    const file = domText(td[6]);
    return {
      key: [domText(td[0]), domText(td[2]), domText(td[3])].join('|'),
      start: dates[0],
      end: dates[dates.length - 1],
      time: domText(td[3]),
      place: domText(td[4]),
      desc: domText(td[5]),
      file: /\.pdf$/i.test(file) ? file : null,
      link,
    };
  }).filter(Boolean);
}

/** 查今年＋去年（11、12 月再加明年）。回傳依日期新→舊。 */
export async function fetchConferences(stockId, market, { force = false } = {}) {
  const key = `${CACHE_PREFIX}conf_${stockId}`;
  if (!force) {
    const hit = lsGet(key, CONF_TTL_MS);
    if (hit) return hit;
  }
  const now = new Date();
  const roc = now.getFullYear() - 1911;
  const years = [roc - 1, roc];
  if (now.getMonth() >= 10) years.push(roc + 1);
  const markets = marketsOf(market);
  const all = new Map();
  for (const typek of markets) {
    for (const y of years) {
      (await queryConf(typek, y, stockId)).forEach((r) => all.set(r.key, r));
    }
    if (all.size && markets.length > 1) break; // 未知市場：sii 有資料就不必再查 otc
  }
  const out = [...all.values()].sort((a, b) => b.start.localeCompare(a.start));
  lsSet(key, out);
  return out;
}

/* ── 重大訊息 ─────────────────────────────────────────────────────────── */

const MOPS_NEWS_URL = 'https://mopsov.twse.com.tw/mops/web/ajax_t05st01';
const NEWS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 舊版觀測站「歷史重大訊息」按公司查整年（TYPEK=all 上市櫃都行），只留近 3 個月。
 * 1～3 月時近 3 個月會跨年，所以再多查去年。
 * 回傳 [{ key, date, time, subject, detail:{typek, spokeDate, spokeTime, seq} }]，新→舊。
 */
const NEWS_MONTHS = 3;
const newsCutoff = () => {
  const d = new Date(`${taipeiToday()}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - NEWS_MONTHS);
  return d.toISOString().slice(0, 10);
};

export async function fetchNews(stockId, { force = false } = {}) {
  const key = `${CACHE_PREFIX}news_${stockId}`;
  if (!force) {
    const hit = lsGet(key, NEWS_TTL_MS);
    if (hit) return hit.filter((n) => n.date >= newsCutoff());
  }
  const now = new Date();
  const roc = now.getFullYear() - 1911;
  const years = now.getMonth() < 3 ? [roc - 1, roc] : [roc];
  const out = [];
  for (const y of years) {
    const params = new URLSearchParams({ encodeURIComponent: 1, step: 1, firstin: 1, off: 1, TYPEK: 'all', co_id: stockId, year: y });
    const res = await fetchRetry(`${MOPS_NEWS_URL}?${params}`);
    if (!res.ok) throw new Error(`觀測站 HTTP ${res.status}`);
    const html = await res.text();
    if (!html.includes('發言日期') && !html.includes('查無')) throw new Error('觀測站回應非預期格式');
    const d = new DOMParser().parseFromString(html, 'text/html');
    d.querySelectorAll('tr').forEach((tr) => {
      const td = [...tr.querySelectorAll('td')];
      if (td.length < 5 || !/^\d{4}/.test(domText(td[0]).replace(/ /g, ''))) return;
      const t = (el) => domText(el).replace(/ /g, '').trim();
      const date = rocToIso(t(td[2]));
      if (!date) return;
      const onclick = tr.querySelector('input[type=button]')?.getAttribute('onclick') || '';
      const pick = (name) => (new RegExp(`${name}\\.value='([^']*)'`).exec(onclick) || [])[1] || '';
      const detail = { typek: pick('TYPEK'), spokeDate: pick('spoke_date'), spokeTime: pick('spoke_time'), seq: pick('seq_no') };
      out.push({ key: `${date}|${t(td[3])}|${detail.seq}`, date, time: t(td[3]), subject: t(td[4]), detail });
    });
  }
  const cutoff = newsCutoff();
  const recent = out.filter((n) => n.date >= cutoff).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  lsSet(key, recent);
  return recent;
}

const newsDetailMemo = new Map();
/** 單則重大訊息全文（點開時才抓）。回傳純文字。 */
export async function fetchNewsDetail(stockId, n) {
  if (newsDetailMemo.has(n.key)) return newsDetailMemo.get(n.key);
  const { typek, spokeDate, spokeTime, seq } = n.detail || {};
  const params = new URLSearchParams({
    firstin: 'true', off: 1, step: 2, TYPEK: typek || 'all', year: Number(spokeDate.slice(0, 4)) - 1911,
    month: 'all', e_month: 'all', co_id: stockId, spoke_date: spokeDate, spoke_time: spokeTime, seq_no: seq,
  });
  const res = await fetchRetry(`${MOPS_NEWS_URL}?${params}`);
  if (!res.ok) throw new Error(`觀測站 HTTP ${res.status}`);
  const d = new DOMParser().parseFromString(await res.text(), 'text/html');
  d.querySelectorAll('script').forEach((x) => x.remove());
  const cells = [...d.querySelectorAll('td')].map((x) => (x.innerText ?? x.textContent).replace(/ /g, ' ').trim());
  // 表格是「欄名｜內容」成對排列；取「說明」那格，沒有就整理全部
  const iDesc = cells.findIndex((c) => c === '說明');
  const text = (iDesc >= 0 ? cells[iDesc + 1] : cells.join('\n')) || '（查無內容）';
  newsDetailMemo.set(n.key, text);
  return text;
}

/** 依包含／排除關鍵字（、或逗號分隔）篩重大訊息。包含留空＝全部。 */
export function filterNews(list, include, exclude) {
  const words = (s) => (s || '').split(/[、,，\s]+/).map((w) => w.trim()).filter(Boolean);
  const inc = words(include);
  const exc = words(exclude);
  return (list || []).filter((n) => (!inc.length || inc.some((w) => n.subject.includes(w))) && !exc.some((w) => n.subject.includes(w)));
}

/* ── 提醒 ─────────────────────────────────────────────────────────────── */

/**
 * 每個條件 { on, value? }。預設開啟的門檻條件直接帶預設數值，使用者改了就以改的為準。
 * 「達到某水準」類只在「這期達到、上期還沒」時提醒一次（跨過門檻那一期），不會每期重複；
 * 「創新高／較前期增加」類是每期事件，成立就提醒；「公布時提醒」每期新資料出來提醒一次。
 */
export const DEFAULT_TRIGGERS = {
  // 營收（月）
  revNew: { on: true },
  revAth: { on: true },
  revAbove: { on: false, value: '' },              // 單月營收 ≥ X 億
  yoyAbove: { on: true, value: '30' },             // 單月 YoY ≥ X%
  yoyUpPp: { on: true, value: '20' },              // 當月 YoY 較上月 YoY 增加 ≥ X 個百分點
  revMom: { on: false, value: '' },                // 單月 MoM ≥ X%
  // 財報（季）
  finNew: { on: true },
  gmAbove: { on: false, value: '' },               // 毛利率 ≥ X%
  gmUpPp: { on: false, value: '' },                // 毛利率較前季增加 ≥ X 個百分點
  epsAbove: { on: false, value: '' },              // 單季 EPS ≥ X 元
  epsAth: { on: true },                            // 單季 EPS 創新高（資料起點起）
  epsYoy: { on: true, value: '30' },               // 單季 EPS 較去年同季成長 ≥ X%
  epsQoq: { on: false, value: '' },                // 單季 EPS 較上季成長 ≥ X%
  // 股價
  priceAbove: { on: false, value: '', since: '' }, // 盤中觸及即算，只提醒一次；since＝設定門檻的日期
  priceBelow: { on: false, value: '', since: '' },
  priceRun: { on: true, value: '15' },             // 一週（5 個交易日）漲幅 ≥ X%
  priceRunM: { on: true, value: '20' },            // 一個月（對一個月前同日收盤）漲幅 ≥ X%
  priceRun2: { on: false, days: '', value: '' },   // 自訂 N 個交易日漲幅 ≥ X%
  // 事件
  newConf: { on: true },
  newNews: { on: true, include: '', exclude: '' }, // 只有設定關鍵字（include）才會提醒
};

const numOf = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d));
const thresholdOf = (cond, field = 'value') => numOf(cond?.[field]);

/**
 * 目前成立的提醒候選（未扣除已確認）。每筆 { key, src, label }。
 * src 用來在各資料第一次載入時建立基準——剛訂閱時已成立的條件不算新提醒。
 */
export function computeAlerts(item, d, today) {
  const t = { ...DEFAULT_TRIGGERS, ...(item.triggers || {}) };
  const on = (k) => t[k]?.on;
  const out = [];
  const g = (a, b) => (a != null && b != null && b > 0 ? ((a - b) / b) * 100 : null);

  // 營收
  const s = d?.rev ? computeRevenueStats(d.rev) : null;
  if (s) {
    const L = s.latest;
    const P = s.rows[s.rows.length - 2];
    const ym = L.ym;
    const k = (name) => `rev:${name}:${ym}`;
    const yi = L.revenue / 1e8;
    if (on('revNew')) out.push({ key: k('new'), src: 'rev', label: `${L.month} 月營收 ${fmt(yi, yi >= 100 ? 0 : 2)} 億，YoY ${L.yoy == null ? '—' : `${L.yoy > 0 ? '+' : ''}${fmt(L.yoy)}%`}` });
    if (on('revAth') && s.isAth) out.push({ key: k('ath'), src: 'rev', label: `${L.month} 月營收創新高` });
    const ra = thresholdOf(t.revAbove);
    if (on('revAbove') && ra != null && yi >= ra && !(P && P.revenue / 1e8 >= ra)) {
      out.push({ key: k(`above${ra}`), src: 'rev', label: `單月營收達 ${ra} 億` });
    }
    const ya = thresholdOf(t.yoyAbove);
    if (on('yoyAbove') && ya != null && L.yoy != null && L.yoy >= ya && !(P?.yoy != null && P.yoy >= ya)) {
      out.push({ key: k(`yoy${ya}`), src: 'rev', label: `營收 YoY 達 ${ya}%（${fmt(L.yoy)}%）` });
    }
    const yu = thresholdOf(t.yoyUpPp);
    if (on('yoyUpPp') && yu != null && L.yoy != null && P?.yoy != null && L.yoy - P.yoy >= yu) {
      out.push({ key: k('yoyup'), src: 'rev', label: `營收 YoY 較上月 +${fmt(L.yoy - P.yoy)} 個百分點` });
    }
    const rm = thresholdOf(t.revMom);
    if (on('revMom') && rm != null && L.mom != null && L.mom >= rm) {
      out.push({ key: k('mom'), src: 'rev', label: `營收 MoM +${fmt(L.mom)}%` });
    }
  }

  // 財報
  const fin = (d?.fin || []).filter((r) => r.eps != null || r.gm != null);
  if (fin.length) {
    const L = fin[fin.length - 1];
    const P = fin[fin.length - 2];
    const k = (name) => `fin:${name}:${L.q}`;
    const qn = `${L.q.slice(2, 4)}Q${L.q.slice(-1)}`;
    const sameQLastYear = (r) => r && fin.find((x) => x.q === `${Number(r.q.slice(0, 4)) - 1}-Q${r.q.slice(-1)}`);
    if (on('finNew')) out.push({ key: k('new'), src: 'fin', label: `${qn} 財報：EPS ${fmt(L.eps, 2)}${L.gm != null ? `，毛利率 ${fmt(L.gm)}%` : ''}` });
    const ga = thresholdOf(t.gmAbove);
    if (on('gmAbove') && ga != null && L.gm != null && L.gm >= ga && !(P?.gm != null && P.gm >= ga)) {
      out.push({ key: k(`gm${ga}`), src: 'fin', label: `毛利率達 ${ga}%` });
    }
    const gu = thresholdOf(t.gmUpPp);
    if (on('gmUpPp') && gu != null && L.gm != null && P?.gm != null && L.gm - P.gm >= gu) {
      out.push({ key: k('gmup'), src: 'fin', label: `毛利率較前季 +${fmt(L.gm - P.gm)} 個百分點` });
    }
    const ea = thresholdOf(t.epsAbove);
    if (on('epsAbove') && ea != null && L.eps != null && L.eps >= ea && !(P?.eps != null && P.eps >= ea)) {
      out.push({ key: k(`eps${ea}`), src: 'fin', label: `單季 EPS 達 ${ea} 元` });
    }
    const priorEps = fin.slice(0, -1).map((r) => r.eps).filter((v) => v != null);
    if (on('epsAth') && L.eps != null && priorEps.length && L.eps > Math.max(...priorEps)) {
      out.push({ key: k('epsath'), src: 'fin', label: `${qn} EPS 創新高` });
    }
    const ey = thresholdOf(t.epsYoy);
    const gNow = g(L.eps, sameQLastYear(L)?.eps);
    const gPrev = g(P?.eps, sameQLastYear(P)?.eps);
    if (on('epsYoy') && ey != null && gNow != null && gNow >= ey && !(gPrev != null && gPrev >= ey)) {
      out.push({ key: k(`epsyoy${ey}`), src: 'fin', label: `EPS 年增 ${fmt(gNow)}%` });
    }
    const eq = thresholdOf(t.epsQoq);
    const qoq = g(L.eps, P?.eps);
    if (on('epsQoq') && eq != null && qoq != null && qoq >= eq) {
      out.push({ key: k('epsqoq'), src: 'fin', label: `EPS 季增 ${fmt(qoq)}%` });
    }
  }

  // 股價
  const q = d?.quote;
  if (q) {
    const bars = q.recent || [];
    const md = (dt) => dt.slice(5).replace('-', '/');
    // 價位：設定門檻之後任一天盤中最高／最低有摸到就算，只提醒一次
    const above = thresholdOf(t.priceAbove);
    const below = thresholdOf(t.priceBelow);
    if (on('priceAbove') && above != null) {
      const hit = bars.find((b) => b.date >= (t.priceAbove.since || '') && b.high >= above);
      if (hit) out.push({ key: `price:above:${above}`, src: 'price', label: `股價觸及 ${above}（${md(hit.date)}）` });
    }
    if (on('priceBelow') && below != null) {
      const hit = bars.find((b) => b.date >= (t.priceBelow.since || '') && b.low <= below);
      if (hit) out.push({ key: `price:below:${below}`, src: 'price', label: `股價觸及 ${below}（${md(hit.date)}）` });
    }
    // 區間漲幅（收盤對基準日收盤）：只在「跨過門檻」那天提醒，連續幾天都超過不重複。
    // baseOf(i) 回傳第 i 根的基準收盤。
    const run = (name, cond, span, baseOf) => {
      const x = thresholdOf(cond);
      if (!cond?.on || x == null) return;
      const ret = (i) => (i < 0 ? null : g(bars[i].close, baseOf(i)));
      for (let i = bars.length - 1; i >= 1; i--) {
        const r = ret(i);
        if (r != null && r >= x && !((ret(i - 1) ?? -Infinity) >= x)) {
          out.push({ key: `price:${name}:${x}:${bars[i].date}`, src: 'price', label: `${span}漲 ${fmt(r)}%（${md(bars[i].date)}）` });
          return;
        }
      }
    };
    const nBack = (n) => (i) => bars[i - n]?.close;
    // 一個月：對一個月前同日（遇假日往前找最近交易日）的收盤，與卡片「近一月」同一算法
    const monthBack = (i) => {
      const dt = new Date(`${bars[i].date}T00:00:00Z`);
      dt.setUTCMonth(dt.getUTCMonth() - 1);
      const ymd = dt.toISOString().slice(0, 10);
      for (let j = i - 1; j >= 0; j--) if (bars[j].date <= ymd) return bars[j].close;
      return null;
    };
    run('run5', t.priceRun, '一週', nBack(5));
    run('runM', t.priceRunM, '一個月', monthBack);
    const n2 = Math.round(thresholdOf(t.priceRun2, 'days') || 0);
    if (n2 >= 1) run(`run${n2}d`, t.priceRun2, `${n2} 日`, nBack(n2));
  }

  // 事件
  if (on('newConf') && d?.conf) {
    d.conf.forEach((c) => out.push({ key: `conf:${c.key}`, src: 'conf', label: `新申報法說 ${c.start.slice(5).replace('-', '/')}` }));
  }
  // 重訊量大：只有設定關鍵字才提醒
  if (on('newNews') && d?.news && (t.newNews.include || '').trim()) {
    filterNews(d.news, t.newNews.include, t.newNews.exclude)
      .forEach((n) => out.push({ key: `news:${n.key}`, src: 'news', label: `重訊：${n.subject}`, news: true }));
  }

  // 回看日（可多個）
  (item.revisitDates || []).filter((dt) => dt && dt <= today)
    .forEach((dt) => out.push({ key: `revisit:${dt}`, src: 'revisit', label: `到回看日 ${dt}` }));
  return out;
}

/** 同時最多 n 個請求，避免一次打爆 proxy／觀測站。 */
export async function runLimited(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}
