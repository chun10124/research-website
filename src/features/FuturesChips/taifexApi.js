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
 * 期交所限制：法人兩張表只能查近 3 年；每日行情單次區間上限約 1 個月，超過回 HTML。
 */

const PROXY_BASE = 'https://stock-proxy.tzuchun11232004.workers.dev/?url=';
const TAIFEX = 'https://www.taifex.com.tw/cht/3/';
const CACHE_PREFIX = 'rw-futchip_';
const TMF_START = '2024/07/01'; // 微台 2024/7 下旬上市；百分位用上市以來全部歷史
const RECENT_TTL_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('/').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
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
async function fetchCsv(page, params) {
  const url = `${TAIFEX}${page}?${new URLSearchParams(params).toString()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(PROXY_BASE + encodeURIComponent(url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = new TextDecoder('big5').decode(await res.arrayBuffer());
      if (text.trimStart().startsWith('<')) throw new Error('期交所回傳網頁（日期超出可查範圍）');
      return text.split(/\r?\n/).map((l) => l.split(',')).filter((r) => /^\d{4}\//.test(r[0] || ''));
    } catch (e) {
      if (attempt >= 2) throw new Error(`${page} ${params.queryStartDate}~${params.queryEndDate}: ${e.message}`);
      await sleep(1200 * 2 ** attempt);
    }
  }
}

/** 區間抓取＋快取：已過去 3 天以上的區間永久快取，含近期的 30 分鐘 */
async function cached(kind, id, a, b, loader) {
  const key = `${CACHE_PREFIX}${kind}_${id}_${a}_${b}`;
  const hit = lsGet(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  lsSet(key, value, b < addDays(taipeiToday(), -3));
  return value;
}

/** 依月切段（每日行情單次上限約一個月） */
function monthChunks(start, end) {
  const out = [];
  let d = parseYmd(start);
  const e = parseYmd(end);
  while (d <= e) {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const b = last < e ? last : e;
    out.push([ymd(d), ymd(b)]);
    d = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
  }
  return out;
}
/** 依年切段（法人表） */
function yearChunks(start, end) {
  const out = [];
  let a = start;
  while (a <= end) {
    const b0 = addDays(addDays(a, 365), -1);
    const b = b0 < end ? b0 : end;
    out.push([a, b]);
    a = addDays(b, 1);
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

/** 三大法人期貨 → { date: [多方未平倉, 空方未平倉] }（三類法人加總） */
const loadFutInst = (cid, a, b) => cached('inst', cid, a, b, async () => {
  const rows = await fetchCsv('futContractsDateDown', { queryStartDate: a, queryEndDate: b, commodityId: cid });
  const out = {};
  for (const r of rows) {
    if (r.length < 14) continue;
    const x = (out[r[0]] ||= [0, 0]);
    x[0] += num(r[9]) || 0;
    x[1] += num(r[11]) || 0;
  }
  return out;
});

/** 外資臺指選擇權 CALL → { date: [BC口, BC金, SC口, SC金, 淨口, 淨金] }（金額千元） */
const loadForeignCall = (a, b) => cached('opt', 'TXO', a, b, async () => {
  const rows = await fetchCsv('callsAndPutsDateDown', { queryStartDate: a, queryEndDate: b, commodityId: 'TXO' });
  const out = {};
  for (const r of rows) {
    if (r.length < 16 || !(r[3] || '').includes('外資') || (r[2] || '').trim().toUpperCase() !== 'CALL') continue;
    out[r[0]] = r.slice(10, 16).map((v) => num(v) || 0);
  }
  return out;
});

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
  const mxfInstIdx = yearChunks(addDays(start, -10), today).map(([a, b]) => addTask(() => loadFutInst('MXF', a, b)));
  const tmfInstIdx = yearChunks(TMF_START, today).map(([a, b]) => addTask(() => loadFutInst('TMF', a, b)));
  const optIdx = yearChunks(pre, today).map(([a, b]) => addTask(() => loadForeignCall(a, b)));

  let done = 0;
  onProgress?.(0, tasks.length);
  const settled = await pool(
    tasks.map((t) => () => t().catch((e) => { warnings.push(e.message); return {}; })),
    4,
    () => onProgress?.(++done, tasks.length),
  );
  const pick = (idx) => mergeAll(idx.map((i) => settled[i]));
  const tx = pick(txIdx), mtx = pick(mtxIdx), tmf = pick(tmfIdx);
  const mxfInst = pick(mxfInstIdx), tmfInst = pick(tmfInstIdx), call = pick(optIdx);

  // 加權指數：沿用網站既有來源（富邦 Firestore → Yahoo ^TWII）
  let index = {};
  try {
    const { fetchIndexPriceMap } = await import('../StockAnalysis/api/stockApi');
    index = await fetchIndexPriceMap(addDays(start, -14).replace(/\//g, '-'), today.replace(/\//g, '-'));
  } catch (e) {
    warnings.push(`加權指數：${e.message}`);
  }

  const txDays = Object.keys(tx).sort();
  // 月結算日：月契約最後一次出現的交易日（且之後還有資料，代表已到期）
  const lastSeen = {};
  for (const d of txDays) for (const m of Object.keys(tx[d])) if (/^\d{6}$/.test(m)) lastSeen[m] = d;
  const lastDay = txDays[txDays.length - 1];
  const settleDays = new Set(Object.values(lastSeen).filter((d) => d < lastDay));

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
      out[d] = Object.entries(oiMap[d]).reduce((s, [m, v]) => (/^\d{6}$/.test(m) && last[m] === d && d < end ? s : s + v), 0);
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
    });
  }
  return { rows, warnings };
}
