/**
 * 期貨籌碼表（仿「淡定看台指」）的資料抓取與指標計算。
 * 全部走期交所網站的區間下載（GET 也收），經 stock-proxy 解 CORS，不吃 FinMind 配額。
 *
 * 公式於 2026-10-20 用截圖逐筆反推、以期交所原始資料驗證（temp_scripts/20261020_*_tmp.py）：
 * - 留倉差增減：TX 一般盤「近月 − 次月」未沖銷契約數的日變化（8/8 吻合）
 * - 散戶看多/看空：小台全市場未平倉（含週契約、不含月結算日的到期月合約）− 三大法人多方/空方未平倉（6/6）
 * - 微台散戶：同公式套微台（吻合）
 * - 外資 CALL 未平倉淨口數/淨金額（截圖寫「(買)」＝買權）（5/5）
 * - BC 與結算比：外資 BC 未平倉金額 − 上次月結算日的 BC 金額（5/5）
 * - CALL 結構：外資 BC/SC 未平倉「金額」的 5 日、20 日變化分類（34/34、34/34）
 * - 持倉占比百分位：微台散戶多單比例在上市以來全部歷史中的百分位（平均誤差 0.8pt）
 * - 變化強度百分位：未破解，這裡是自訂近似（見 STRENGTH_WINDOW）
 *
 * 2026-10-22 依粉專貼文的數字反推、以期交所資料驗證（temp_scripts/20261022_*_tmp.py）：
 * - 外資期貨未平倉與結算比：外資淨未平倉 − 上次月結算日的值（2025/3/3、7/4、10/8、2026/10/15 吻合）；
 *   單位未定，大台與「大台＋小台/4＋微台/20」兩種都算
 * - 外資 OP 多單過熱／紫爆：外資 BC 未平倉金額 ≥ 約 10.5 億／20 億（只有幾個轉折點可驗，屬推估）
 * - 波段回測：加權指數波段盤中高點到之後盤中最低（8 例吻合，波段規則見 swingDrawdown）
 *
 * 期交所限制：法人兩張表只能查近 3 年；每日行情單次區間上限約 1 個月，超過回 HTML。
 */

const PROXY_BASE = 'https://stock-proxy.tzuchun11232004.workers.dev/?url=';
const TAIFEX = 'https://www.taifex.com.tw/cht/3/';
const CACHE_PREFIX = 'rw-futchip_';
const TMF_START = '2024/07/01'; // 微台 2024/7 下旬上市；百分位用上市以來全部歷史
const RECENT_TTL_MS = 30 * 60 * 1000;
// 目前使用中的快取種類；匯出永久區段時只帶這些，舊格式（inst、opt）就不會一直留在 Firestore
const CACHE_KINDS = ['oi', 'inst2', 'opt2'];
// 外資 BC 未平倉金額（千元）門檻：過熱 ≈ 10.5 億、紫爆 ≈ 20 億（由貼文日期反推）
const BC_HOT = 1050000;
const BC_PURPLE = 2000000;
// 波段：自波段高點回落 ≥ 5%、再從低點反彈 ≥ 8% → 從反彈那天起算新波段（他的 8 個例子在 3–8% ／ 6–12% 間都吻合，取中間）
const SWING_DROP = 0.05;
const SWING_REBOUND = 0.08;
const SWING_WARMUP_DAYS = 200; // 波段狀態要從更早開始跑，第一天才有正確的高點

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('/').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
/** 月契約（YYYYMM）的到期日＝當月第三個星期三；遇假日順延到下一個交易日，所以只會更晚、用「>=」判斷即可 */
const thirdWednesday = (m) => {
  const first = new Date(+m.slice(0, 4), +m.slice(4) - 1, 1);
  first.setDate(1 + ((3 - first.getDay() + 7) % 7) + 14);
  return ymd(first);
};
/** 月契約 m 最後出現在 d：之後還有資料（已消失），或 d 已到第三個星期三（結算日當天，隔天資料還沒出來）→ d 是它的結算日 */
const isSettleDay = (m, d, end) => d < end || d >= thirdWednesday(m);
const taipeiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).replace(/-/g, '/');
const num = (x) => {
  const s = String(x ?? '').replace(/,/g, '').trim();
  if (!s || s === '-') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

function lsGet(key) {
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null');
    if (c && (c.permanent || Date.now() - c.at < RECENT_TTL_MS)) return c.value;
  } catch (_) {}
  return undefined;
}
function lsSet(key, value, permanent) {
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), permanent, value })); } catch (_) {}
}

/** 經 proxy 抓期交所 CSV（Big5）；回 HTML 代表日期錯誤或區間太長，視為失敗。 */
let netFetches = 0; // 實際向期交所發出的請求數（快取命中不算），每日同步記錄用
export const getNetFetchCount = () => netFetches;

// 保護期交所（避免被 Cloudflare 擋，2026-10-22 曾因測試時請求太密集被擋）：
// 1. 所有請求排隊，間隔至少 MIN_GAP_MS（併發 4 個 worker 也一樣）
// 2. 一遇到 429 立刻停：不重試，之後本次所有請求直接失敗；有缺漏時同步本來就不寫入，隔天再補
const MIN_GAP_MS = 700;
let nextSlot = 0;
let rateLimited = false;
async function throttle() {
  const wait = nextSlot - Date.now();
  nextSlot = Math.max(nextSlot, Date.now()) + MIN_GAP_MS;
  if (wait > 0) await sleep(wait);
}

async function fetchCsv(page, params) {
  const url = `${TAIFEX}${page}?${new URLSearchParams(params).toString()}`;
  for (let attempt = 0; ; attempt++) {
    if (rateLimited) throw new Error(`${page} ${params.queryStartDate}~${params.queryEndDate}: 期交所限流中，本次不再請求`);
    await throttle();
    netFetches++;
    try {
      const res = await fetch(PROXY_BASE + encodeURIComponent(url));
      if (res.status === 429) {
        rateLimited = true;
        throw new Error('HTTP 429（被限流，停止本次所有請求）');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = new TextDecoder('big5').decode(await res.arrayBuffer());
      if (text.trimStart().startsWith('<')) throw new Error('期交所回傳網頁（日期超出可查範圍）');
      return text.split(/\r?\n/).map((l) => l.split(',')).filter((r) => /^\d{4}\//.test(r[0] || ''));
    } catch (e) {
      if (rateLimited || attempt >= 2) throw new Error(`${page} ${params.queryStartDate}~${params.queryEndDate}: ${e.message}`);
      await sleep(1200 * 2 ** attempt);
    }
  }
}

/** 區間抓取＋快取：已過去 3 天以上的區間永久快取，含近期的 30 分鐘 */
/** 匯出／匯入已永久快取的區段（每日同步用：存進 Firestore，下次只抓沒存過的月份） */
export function exportPermanentChunks() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(CACHE_PREFIX)) continue;
      if (!CACHE_KINDS.some((kind) => k.startsWith(`${CACHE_PREFIX}${kind}_`))) continue;
      const c = JSON.parse(localStorage.getItem(k) || 'null');
      if (c?.permanent) out[k.slice(CACHE_PREFIX.length)] = c.value;
    }
  } catch (_) {}
  return out;
}
export function importPermanentChunks(entries) {
  for (const [k, value] of Object.entries(entries || {})) lsSet(CACHE_PREFIX + k, value, true);
}

async function cached(kind, id, a, b, loader) {
  const key = `${CACHE_PREFIX}${kind}_${id}_${a}_${b}`;
  const hit = lsGet(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  lsSet(key, value, b < addDays(taipeiToday(), -3));
  return value;
}

/** 依日曆月切段（每日行情單次上限約一個月；法人表也照月切，區段才固定） */
function monthChunks(start, end) {
  const out = [];
  // 一律從該月 1 號切起（整月），區段鍵固定，過去月份才能永久快取、每天只重抓當月
  let d = parseYmd(start);
  d = new Date(d.getFullYear(), d.getMonth(), 1);
  const e = parseYmd(end);
  while (d <= e) {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const b = last < e ? last : e;
    out.push([ymd(d), ymd(b)]);
    d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
  }
  return out;
}

/** 期貨每日行情 → { date: { 月份: 未沖銷 } }（一般盤、排除價差，含週契約） */
const loadFutOi = (cid, a, b) => cached('oi', cid, a, b, async () => {
  const rows = await fetchCsv('futDataDown', {
    down_type: '1', commodity_id: cid, commodity_id2: '', queryStartDate: a, queryEndDate: b,
  });
  const out = {};
  for (const r of rows) {
    if ((r[1] || '').trim() !== cid || (r[2] || '').includes('/') || (r[17] || '').trim() !== '一般') continue;
    (out[r[0]] ||= {})[r[2].trim()] = num(r[11]) || 0;
  }
  return out;
});

/**
 * 法人兩張表可以一次查一整年（期貨每日行情不行）。月份區段沒快取時先整年抓、再切成每月存進快取，
 * 之後照月份讀；不然一次補十幾個月 × 4 種商品會被限流（HTTP 429）。只預抓已過去 3 天以上的月份（永久快取）
 */
async function prefetchByYear(kind, id, chunks, fetchRange) {
  const missing = chunks.filter(([a, b]) => b < addDays(taipeiToday(), -3)
    && lsGet(`${CACHE_PREFIX}${kind}_${id}_${a}_${b}`) === undefined);
  const years = {};
  for (const c of missing) (years[c[0].slice(0, 4)] ||= []).push(c);
  for (const list of Object.values(years)) {
    const byDate = await fetchRange(list[0][0], list[list.length - 1][1]);
    for (const [a, b] of list) {
      const part = {};
      for (const [d, v] of Object.entries(byDate)) if (d >= a && d <= b) part[d] = v;
      lsSet(`${CACHE_PREFIX}${kind}_${id}_${a}_${b}`, part, true);
    }
  }
}

/** 三大法人期貨 → { date: [三類法人多方未平倉, 空方未平倉, 外資多方未平倉, 外資空方未平倉] }（口） */
const fetchFutInst = async (cid, a, b) => {
  const rows = await fetchCsv('futContractsDateDown', { queryStartDate: a, queryEndDate: b, commodityId: cid });
  const out = {};
  for (const r of rows) {
    if (r.length < 14) continue;
    const x = (out[r[0]] ||= [0, 0, 0, 0]);
    const long = num(r[9]) || 0, short = num(r[11]) || 0;
    x[0] += long;
    x[1] += short;
    if ((r[2] || '').includes('外資')) { x[2] = long; x[3] = short; }
  }
  return out;
};
const loadFutInst = (cid, a, b) => cached('inst2', cid, a, b, () => fetchFutInst(cid, a, b));

/** 外資臺指選擇權 → { date: [CALL 的 BC口, BC金, SC口, SC金, 淨口, 淨金, PUT 的 BP口, BP金, SP口, SP金, 淨口, 淨金] }（金額千元） */
const fetchForeignOpt = async (a, b) => {
  const rows = await fetchCsv('callsAndPutsDateDown', { queryStartDate: a, queryEndDate: b, commodityId: 'TXO' });
  const out = {};
  for (const r of rows) {
    if (r.length < 16 || !(r[3] || '').includes('外資')) continue;
    const cp = (r[2] || '').trim().toUpperCase();
    if (cp !== 'CALL' && cp !== 'PUT') continue;
    const x = (out[r[0]] ||= new Array(12).fill(0));
    r.slice(10, 16).forEach((v, j) => { x[(cp === 'PUT' ? 6 : 0) + j] = num(v) || 0; });
  }
  return out;
};
const loadForeignOpt = (a, b) => cached('opt2', 'TXO', a, b, () => fetchForeignOpt(a, b));

/**
 * 波段回測（加權指數）：days 依日期排序，回傳 { date: { high, highDate, drawdown } }，drawdown＝本波最大回測 %。
 * 波段高點＝盤中最高；創新高那天的盤中低點可能在高點之前，所以當天以收盤當作低點起算。
 * 自高點回落 ≥ SWING_DROP 之後，從低點反彈 ≥ SWING_REBOUND → 從反彈那天起算新波段（新高點可以低於舊高點）
 */
export function swingDrawdown(days, highOf, lowOf, closeOf) {
  const out = {};
  let H = null, Hd = null, L = null;
  for (const d of days) {
    const h = highOf(d), l = lowOf(d), c = closeOf(d);
    if (h == null || l == null || c == null) continue;
    if (H == null || h > H || (1 - L / H >= SWING_DROP && h >= L * (1 + SWING_REBOUND))) {
      H = h; Hd = d; L = c;
    } else {
      L = Math.min(L, l);
    }
    out[d] = { high: H, highDate: Hd, drawdown: 100 * (1 - L / H) };
  }
  return out;
}

/** 有限併發 */
async function pool(tasks, limit, onDone) {
  const results = new Array(tasks.length);
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const k = i++;
      results[k] = await tasks[k]();
      onDone?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
const mergeAll = (parts) => Object.assign({}, ...parts);

/** 百分位（同值算一半），0–100 */
function prank(sortedHist, v) {
  let lo = 0, hi = sortedHist.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedHist[m] < v) lo = m + 1; else hi = m; }
  let eq = lo;
  while (eq < sortedHist.length && sortedHist[eq] === v) eq++;
  return (100 * (lo + 0.5 * (eq - lo))) / sortedHist.length;
}
function insertSorted(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  arr.splice(lo, 0, v);
}

/** 外資 CALL 結構分類（以未平倉金額變化 dBC、dSC） */
export function classifyCall(dBC, dSC) {
  if (dBC - dSC < 0) {
    if (dSC > 0 && dBC < 0) return '雙向強化型淨SC';
    if (dSC > 0) return 'SC主動擴張';
    return 'BC撤退型淨SC';
  }
  if (dBC > 0 && dSC < 0) return '雙向強化型淨BC';
  if (dSC < 0 && (dBC <= 0 || -dSC >= dBC)) return 'SC減少主導收斂';
  return 'BC增加主導收斂';
}

/**
 * 主入口：回傳 { rows, warnings }，rows 依日期由舊到新，只含 [start, today] 期間。
 * onProgress(done, total) 回報下載進度。
 */
export async function loadFuturesChipTable(startYmdDash, { onProgress } = {}) {
  const today = taipeiToday();
  const start = startYmdDash.replace(/-/g, '/');
  const pre = addDays(start, -70); // 前推：月結算日基準、20 日變化、前一日比較
  const warnings = [];

  const tasks = [];
  const addTask = (fn) => { tasks.push(fn); return tasks.length - 1; };
  const txIdx = monthChunks(pre, today).map(([a, b]) => addTask(() => loadFutOi('TX', a, b)));
  const mtxIdx = monthChunks(addDays(start, -10), today).map(([a, b]) => addTask(() => loadFutOi('MTX', a, b)));
  const tmfIdx = monthChunks(TMF_START, today).map(([a, b]) => addTask(() => loadFutOi('TMF', a, b)));
  // 法人期貨從 pre 起抓：外資期貨「較結算日」要上次月結算日的基準
  const txfInstIdx = monthChunks(pre, today).map(([a, b]) => addTask(() => loadFutInst('TXF', a, b)));
  const mxfInstIdx = monthChunks(pre, today).map(([a, b]) => addTask(() => loadFutInst('MXF', a, b)));
  const tmfInstIdx = monthChunks(TMF_START, today).map(([a, b]) => addTask(() => loadFutInst('TMF', a, b)));
  const optIdx = monthChunks(pre, today).map(([a, b]) => addTask(() => loadForeignOpt(a, b)));

  // 法人表缺的過去月份先整年補抓（失敗就留給下面逐月抓）
  const yearly = [
    ...[['TXF', pre], ['MXF', pre], ['TMF', TMF_START]].map(([cid, from]) => () => prefetchByYear(
      'inst2', cid, monthChunks(from, today), (a, b) => fetchFutInst(cid, a, b))),
    () => prefetchByYear('opt2', 'TXO', monthChunks(pre, today), fetchForeignOpt),
  ];
  onProgress?.(0, tasks.length);
  for (const f of yearly) {
    try { await f(); } catch (_) { break; } // 失敗（多半是被限流）就不再試其他整年，直接逐月
  }

  let done = 0;
  const settled = await pool(
    tasks.map((t) => () => t().catch((e) => { warnings.push(e.message); return {}; })),
    4,
    () => onProgress?.(++done, tasks.length),
  );
  const pick = (idx) => mergeAll(idx.map((i) => settled[i]));
  const tx = pick(txIdx), mtx = pick(mtxIdx), tmf = pick(tmfIdx);
  const txfInst = pick(txfInstIdx), mxfInst = pick(mxfInstIdx), tmfInst = pick(tmfInstIdx), opt = pick(optIdx);

  // 加權指數收盤：沿用網站既有來源（富邦 Firestore → Yahoo ^TWII）；波段回測要盤中高低，另抓 Yahoo
  let index = {};
  let ohlc = { highMap: {}, lowMap: {}, priceMap: {} };
  try {
    const { fetchIndexPriceMap, fetchIndexHighLowMaps } = await import('../StockAnalysis/api/stockApi');
    [index, ohlc] = await Promise.all([
      fetchIndexPriceMap(addDays(start, -14).replace(/\//g, '-'), today.replace(/\//g, '-')),
      fetchIndexHighLowMaps(addDays(start, -SWING_WARMUP_DAYS).replace(/\//g, '-'), today.replace(/\//g, '-')),
    ]);
  } catch (e) {
    warnings.push(`加權指數：${e.message}`);
  }

  return { rows: computeChipRows({ start, tx, mtx, tmf, txfInst, mxfInst, tmfInst, opt, index, ohlc }), warnings };
}

/**
 * 由原始資料算出籌碼表各列（期交所即時抓取、FinMind 歷史回補共用，公式只有這一份）。
 * 輸入日期鍵皆 YYYY/MM/DD（index、ohlc 為 YYYY-MM-DD）：
 * - tx／mtx／tmf：{ date: { 月份: 未沖銷 } }（一般盤、不含價差）
 * - txfInst／mxfInst／tmfInst：{ date: [三類法人多方, 空方, 外資多方, 外資空方] }
 * - opt：{ date: [CALL 6 欄, PUT 6 欄] }；index：{ date: 收盤 }；ohlc：{ priceMap, highMap, lowMap }
 * start（YYYY/MM/DD）之前的資料只當基準（結算日、20 日變化、前一日比較），不出列
 */
export function computeChipRows({ start, tx, mtx, tmf, txfInst, mxfInst, tmfInst, opt, index, ohlc }) {
  const call = Object.fromEntries(Object.entries(opt).map(([d, v]) => [d, v.slice(0, 6)]));
  const txDays = Object.keys(tx).sort();
  // 月結算日：月契約最後一次出現的交易日（之後還有資料，或已到第三個星期三＝結算日當天就標）
  const lastSeen = {};
  for (const d of txDays) for (const m of Object.keys(tx[d])) if (/^\d{6}$/.test(m)) lastSeen[m] = d;
  const lastDay = txDays[txDays.length - 1];
  const settleDays = new Set(Object.entries(lastSeen).filter(([m, d]) => isSettleDay(m, d, lastDay)).map(([, d]) => d));

  const spreadOf = (d) => {
    const ms = Object.keys(tx[d] || {}).filter((m) => /^\d{6}$/.test(m) && tx[d][m] > 0).sort();
    return ms.length >= 2 ? tx[d][ms[0]] - tx[d][ms[1]] : null;
  };
  // 全市場未平倉：月結算日當天的到期月合約不計（9/16 差額＝到期月未平倉）；週契約到期日照計（9/23、9/30、10/7 驗證）
  const totals = (oiMap) => {
    const days = Object.keys(oiMap).sort();
    const end = days[days.length - 1];
    const last = {};
    for (const d of days) for (const m of Object.keys(oiMap[d])) last[m] = d;
    const out = {};
    for (const d of days) {
      out[d] = Object.entries(oiMap[d]).reduce((s, [m, v]) => (/^\d{6}$/.test(m) && last[m] === d && isSettleDay(m, d, end) ? s : s + v), 0);
    }
    return out;
  };
  const mtxTot = totals(mtx), tmfTot = totals(tmf);
  const retail = (totMap, instMap, d) => {
    const tot = totMap[d], inst = instMap[d];
    if (tot == null || !inst) return null;
    return [tot - inst[0], tot - inst[1]];
  };

  // 持倉占比百分位：從上市日起逐日累積（擴張視窗；多空比例不受總口數成長影響，且與截圖吻合）
  const tmfDays = Object.keys(tmf).filter((d) => tmfInst[d]).sort();
  const ratioHist = [], dLongHist = [], dShortHist = [];
  // 變化強度（自訂近似）：當日口數「變化率」（÷前一日口數），在最近 STRENGTH_WINDOW 個交易日變化率絕對值中的百分位，
  // 帶增減正負號。用變化率＋滾動視窗，避免口數逐年成長後、跟早期小變化比而永遠偏高。樣本不足 20 天不算
  const STRENGTH_WINDOW = 250; // 約一年
  const rollPct = (hist, v) => {
    hist.push(Math.abs(v));
    if (hist.length > STRENGTH_WINDOW) hist.shift();
    if (hist.length < 20) return null;
    return Math.sign(v || 1) * prank([...hist].sort((a, b) => a - b), Math.abs(v));
  };
  const tmfPos = {};
  let prevR = null;
  for (const d of tmfDays) {
    const r = retail(tmfTot, tmfInst, d);
    if (!r || r[0] + r[1] <= 0) continue;
    const ratio = r[0] / (r[0] + r[1]);
    insertSorted(ratioHist, ratio);
    const longSharePct = prank(ratioHist, ratio);
    let longStr = null, shortStr = null;
    if (prevR) {
      if (prevR[0] > 0) longStr = rollPct(dLongHist, (r[0] - prevR[0]) / prevR[0]);
      if (prevR[1] > 0) shortStr = rollPct(dShortHist, (r[1] - prevR[1]) / prevR[1]);
    }
    const netChg = prevR ? (r[0] - r[1]) - (prevR[0] - prevR[1]) : null;   // 微台散戶淨多空日變化
    tmfPos[d] = { retail: r, netChg, longSharePct, shortSharePct: 100 - longSharePct, longStr, shortStr };
    prevR = r;
  }

  const optDays = Object.keys(call).sort();
  const callLabel = (d, win) => {
    const i = optDays.indexOf(d);
    if (i < win) return null;
    const p = optDays[i - win];
    return classifyCall(call[d][1] - call[p][1], call[d][3] - call[p][3]);
  };
  const settleSorted = [...settleDays].sort();
  const bcVsSettle = (d) => {
    let base = null;
    for (const s of settleSorted) if (s <= d) base = s;
    return base && call[base] && call[d] ? call[d][1] - call[base][1] : null;
  };

  // 外資期貨淨未平倉：大台，以及「大台＋小台/4＋微台/20」（他把三種換算成大台口數）
  const fxNetTx = (d) => (txfInst[d] ? txfInst[d][2] - txfInst[d][3] : null);
  const fxNetAll = (d) => {
    const tx = fxNetTx(d);
    if (tx == null || !mxfInst[d]) return null;
    const tmfNet = tmfInst[d] ? tmfInst[d][2] - tmfInst[d][3] : 0; // 微台上市前沒有
    return tx + (mxfInst[d][2] - mxfInst[d][3]) / 4 + tmfNet / 20;
  };
  const vsSettle = (f, d) => {
    let base = null;
    for (const s of settleSorted) if (s <= d) base = s;
    const v = f(d), b = base ? f(base) : null;
    return v != null && b != null ? v - b : null;
  };

  // 波段回測：從更早開始跑（暖機），只用平日；期交所有資料的區間再以期交所開盤日為準
  // （Yahoo 偶爾在非交易日多一根殘根 K 棒）
  // 某天缺盤中高低時，以收盤代替（回測會略小，但不會整天空白）
  const txDaySet = new Set(txDays);
  const toDash = (d) => d.replace(/\//g, '-');
  const closeOf = (d) => index[toDash(d)] ?? ohlc.priceMap[toDash(d)];
  const swingDays = [...new Set([...Object.keys(ohlc.highMap).map((d) => d.replace(/-/g, '/')), ...txDays])].sort()
    .filter((d) => [1, 2, 3, 4, 5].includes(parseYmd(d).getDay()) && (d < txDays[0] || txDaySet.has(d)));
  const swing = swingDrawdown(
    swingDays,
    (d) => ohlc.highMap[toDash(d)] ?? closeOf(d),
    (d) => ohlc.lowMap[toDash(d)] ?? closeOf(d),
    closeOf,
  );

  const indexDays = Object.keys(index).sort();
  const rows = [];
  for (let i = 0; i < txDays.length; i++) {
    const d = txDays[i];
    if (d < start) continue;
    const dash = d.replace(/\//g, '-');
    const prevD = txDays[i - 1];
    const sp = spreadOf(d), spPrev = prevD ? spreadOf(prevD) : null;
    const close = index[dash] ?? null;
    const prevIdx = indexDays.filter((x) => x < dash).pop();
    const wd = parseYmd(d).getDay();
    const c = call[d];
    const t = tmfPos[d];
    const label5 = callLabel(d, 5), label20 = callLabel(d, 20);
    const mtxR = retail(mtxTot, mxfInst, d);
    const mtxPrev = prevD ? retail(mtxTot, mxfInst, prevD) : null;
    rows.push({
      date: d,
      settleCode: settleDays.has(d) ? 999 : wd,
      spreadChg: sp != null && spPrev != null ? sp - spPrev : null,
      close,
      change: close != null && prevIdx ? close - index[prevIdx] : null,
      mtxRetail: mtxR,
      // 小台散戶淨多空的日變化：(多−空) − 前一日(多−空)；負＝散戶今天整體偏空
      mtxNetChg: mtxR && mtxPrev ? (mtxR[0] - mtxR[1]) - (mtxPrev[0] - mtxPrev[1]) : null,
      tmfRetail: t?.retail ?? null,
      tmfNetChg: t?.netChg ?? null,
      longStr: t?.longStr ?? null,
      shortStr: t?.shortStr ?? null,
      longShare: t?.longSharePct ?? null,
      shortShare: t?.shortSharePct ?? null,
      callNetOi: c ? c[4] : null,
      callNetAmt: c ? c[5] : null,
      bcVsSettle: bcVsSettle(d),
      label5,
      label20: label20 && label20 === label5 ? '同型' : label20,
      // 外資 BC 未平倉金額（千元）與過熱燈號
      bcAmt: c ? c[1] : null,
      heat: c ? (c[1] >= BC_PURPLE ? '紫爆' : c[1] >= BC_HOT ? '過熱' : null) : null,
      // 外資 PUT：BP（買進賣權）、SP（賣出賣權）未平倉金額，及當日 SP 增加減去 BP 增加（正＝SP 增加較多）
      bpAmt: opt[d] ? opt[d][7] : null,
      spAmt: opt[d] ? opt[d][9] : null,
      putNetChg: opt[d] && prevD && opt[prevD] ? (opt[d][9] - opt[prevD][9]) - (opt[d][7] - opt[prevD][7]) : null,
      // 外資期貨淨未平倉（大台）、日增減，與較上次月結算日（大台／大小微合計）
      fxNet: fxNetTx(d),
      fxNetChg: prevD && fxNetTx(d) != null && fxNetTx(prevD) != null ? fxNetTx(d) - fxNetTx(prevD) : null,
      fxSettleTx: vsSettle(fxNetTx, d),
      fxSettleAll: vsSettle(fxNetAll, d),
      // 加權指數本波最大回測（%）與波段高點
      swingDd: swing[d]?.drawdown ?? null,
      swingHigh: swing[d]?.high ?? null,
      swingHighDate: swing[d]?.highDate ?? null,
    });
  }
  return rows;
}
