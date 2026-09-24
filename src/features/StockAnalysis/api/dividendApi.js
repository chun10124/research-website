/**
 * 除權息事件：證交所 TWT49U（上市）＋ 櫃買 exDailyQ（上櫃）「除權除息計算結果表」。
 * 一次請求即涵蓋整段期間的全市場，只保留交易日誌出現過的代碼；不佔 FinMind 額度。
 *
 * 回傳事件格式（供 pnlCalculator 的 dividends）：{ code, exDate: 'YYYY-MM-DD', cash?: 每股現金股利, stock?: 每股配股數 }
 *   - 上櫃：現金股利、每仟股無償配股分欄提供；現金增資（除權但非配股）不列為事件。
 *   - 上市：「息」的權值+息值即現金股利；含「權」者另查 TWT49UDetail 拆出現金與無償配股。
 */

// 櫃買擋 Cloudflare Worker 的出口（會轉址到 /errors），故先走 Vercel 代理，失敗再退回 Worker
const PROXIES = [
  'https://stock-proxy-zeta.vercel.app/api/proxy?url=',
  'https://stock-proxy.tzuchun11232004.workers.dev/?url=',
];
const FETCH_TIMEOUT_MS = 15000;
const CACHE_KEY = 'rw-divoff_v1';
const REFETCH_OVERLAP_DAYS = 7; // 每日補抓時往回重疊幾天，避免漏掉當日稍晚才公布的資料

const taipeiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const bare = (code) => String(code || '').trim().replace(/\.(TW|TWO)$/i, '');
const num = (v) => Number(String(v ?? '').replace(/[^0-9.\-]/g, '')) || 0;

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 民國日期（115/06/09、114年09月16日）→ YYYY-MM-DD */
function rocToIso(s) {
  const m = String(s || '').match(/(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

async function fetchJsonViaProxy(url) {
  for (const proxy of PROXIES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${proxy}${encodeURIComponent(url)}`, { signal: controller.signal });
      if (res.ok) return await res.json();
    } catch (_) {
      // 換下一個代理
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** 起訖切成不超過一年的區段（官方查詢期間上限未確認，保守切分） */
function yearChunks(start, end) {
  const out = [];
  let s = start;
  while (s <= end) {
    const e = addDays(addDays(s, 365), -1) < end ? addDays(addDays(s, 365), -1) : end;
    out.push([s, e]);
    s = addDays(e, 1);
  }
  return out;
}

async function fetchTpexEvents(start, end, codeSet) {
  const events = [];
  for (const [s, e] of yearChunks(start, end)) {
    const url = `https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ?startDate=${s.replace(/-/g, '/')}&endDate=${e.replace(/-/g, '/')}&response=json`;
    const json = await fetchJsonViaProxy(url);
    const table = json?.tables?.[0];
    if (!table || !Array.isArray(table.data)) return null;
    const f = table.fields || [];
    const idx = (name) => f.findIndex((x) => String(x).replace(/\s/g, '') === name);
    const iDate = idx('除權息日期'), iCode = idx('代號'), iCash = idx('現金股利'), iStock = idx('每仟股無償配股');
    if ([iDate, iCode, iCash, iStock].some((i) => i < 0)) return null;
    table.data.forEach((r) => {
      const code = bare(r[iCode]);
      if (!codeSet.has(code)) return;
      const exDate = rocToIso(r[iDate]);
      const cash = num(r[iCash]);
      const stock = num(r[iStock]) / 1000;
      if (!exDate) return;
      if (cash > 0) events.push({ code, exDate, cash });
      if (stock > 0) events.push({ code, exDate, stock });
    });
  }
  return events;
}

async function fetchTwseDetail(code, exDate) {
  const url = `https://www.twse.com.tw/rwd/zh/exRight/TWT49UDetail?STK_NO=${code}&T1=${exDate.replace(/-/g, '')}&response=json`;
  const json = await fetchJsonViaProxy(url);
  const f = json?.fields || [];
  const row = json?.data?.[0];
  if (!row) return null;
  const at = (pred) => { const i = f.findIndex(pred); return i >= 0 ? row[i] : ''; };
  return {
    cash: num(at((x) => String(x).includes('現金股利'))),
    stock: num(at((x) => String(x).includes('無償配股'))) / 1000,
  };
}

async function fetchTwseEvents(start, end, codeSet) {
  const events = [];
  for (const [s, e] of yearChunks(start, end)) {
    const url = `https://www.twse.com.tw/rwd/zh/exRight/TWT49U?startDate=${s.replace(/-/g, '')}&endDate=${e.replace(/-/g, '')}&response=json`;
    const json = await fetchJsonViaProxy(url);
    if (!json || !Array.isArray(json.data)) return null;
    const f = json.fields || [];
    const iDate = f.indexOf('資料日期'), iCode = f.indexOf('股票代號'), iVal = f.indexOf('權值+息值'), iType = f.indexOf('權/息');
    if ([iDate, iCode, iVal, iType].some((i) => i < 0)) return null;
    for (const r of json.data) {
      const code = bare(r[iCode]);
      if (!codeSet.has(code)) continue;
      const exDate = rocToIso(r[iDate]);
      if (!exDate) continue;
      if (String(r[iType]).trim() === '息') {
        const cash = num(r[iVal]);
        if (cash > 0) events.push({ code, exDate, cash });
        continue;
      }
      // 含「權」：查明細拆出現金股利與無償配股（現金增資不算股利）
      const d = await fetchTwseDetail(code, exDate);
      if (!d) return null;
      if (d.cash > 0) events.push({ code, exDate, cash: d.cash });
      if (d.stock > 0) events.push({ code, exDate, stock: d.stock });
    }
  }
  return events;
}

const eventKey = (ev) => `${ev.code}|${ev.exDate}|${ev.cash != null ? 'c' : 's'}`;

/**
 * 交易日誌代碼自 startStr 起的除權息事件，localStorage 快取（只存篩選後的事件）：
 *   - 首次（或新增代碼、起始日提前）：整段查詢。
 *   - 之後每天：只查「上次查到的日期 − 7 天」到今天，合併去重。
 * 回傳 { events, failedSources }：failedSources 為取不到資料的來源（'證交所' / '櫃買'）；
 *   補抓失敗但有快取時沿用快取，不列為失敗。
 */
export async function fetchOfficialDividendEvents(codes, startStr) {
  const codeSet = new Set((codes || []).map(bare).filter(Boolean));
  const start = String(startStr || '').slice(0, 10);
  if (codeSet.size === 0 || !start) return { events: [], failedSources: [] };
  const today = taipeiToday();

  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (_) {}
  const cacheUsable = cached && Array.isArray(cached.events) && cached.start <= start
    && [...codeSet].every((c) => (cached.codes || []).includes(c));
  if (cacheUsable && cached.through === today) {
    return { events: cached.events.filter((ev) => codeSet.has(ev.code)), failedSources: [] };
  }

  const from = cacheUsable ? addDays(cached.through, -REFETCH_OVERLAP_DAYS) : start;
  const [twse, tpex] = await Promise.all([
    fetchTwseEvents(from, today, codeSet),
    fetchTpexEvents(from, today, codeSet),
  ]);
  const failedSources = [];
  if (!twse) failedSources.push('證交所');
  if (!tpex) failedSources.push('櫃買');

  const merged = new Map();
  if (cacheUsable) cached.events.forEach((ev) => merged.set(eventKey(ev), ev));
  [...(twse || []), ...(tpex || [])].forEach((ev) => merged.set(eventKey(ev), ev));
  const events = [...merged.values()].sort((a, b) => a.exDate.localeCompare(b.exDate));

  if (failedSources.length === 0) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ start, through: today, codes: [...codeSet], events }));
    } catch (_) {}
    return { events, failedSources };
  }
  // 部分來源失敗：有快取就沿用快取（只是少了最近幾天），不寫入，下次重試
  if (cacheUsable) {
    return { events: events.filter((ev) => codeSet.has(ev.code)), failedSources: [] };
  }
  return { events, failedSources };
}
