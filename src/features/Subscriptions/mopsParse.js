/* src/features/Subscriptions/mopsParse.js */

/**
 * 觀測站彙總表解析（純函式，不碰瀏覽器 API，可在 node 直接測）。
 *
 * 月營收彙總表 t21sc03（Big5）：一檔＝某市場某月全部公司。
 *   欄位：代號、名稱、當月營收、上月營收、去年當月營收、…（單位千元）
 * 綜合損益彙總表 t163sb04（UTF-8）：一檔＝某市場某季全部公司，**數字是今年累計**。
 *   依產業分成多張表（一般、銀行、證券、金控、保險…），欄位名不同；
 *   只有一般產業有「營業毛利」，金融業毛利留 null。
 */

const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, '').trim();
const num = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (!t || t === '--' || t === '-') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};
const ID_RE = /^\d{4}[0-9A-Z]{0,2}$/;

function rowsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => text(x[1]));
    if (tds.length) out.push(tds);
  }
  return out;
}

/** 月營收：回傳 { [代號]: [當月, 去年當月] }（千元）。 */
export function parseMonthlyRevenueHtml(html) {
  const data = {};
  for (const td of rowsOf(html)) {
    if (td.length < 7 || !ID_RE.test(td[0])) continue;
    const cur = num(td[2]);
    if (cur == null) continue;
    data[td[0]] = [cur, num(td[4])];
  }
  return data;
}

/** 綜合損益：回傳 { [代號]: [營收累計, 毛利累計|null, EPS累計] }（千元、元）。 */
export function parseIncomeStatementHtml(html) {
  const data = {};
  for (const tb of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const ths = [...tb[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((x) => text(x[1]));
    if (!ths.includes('公司代號')) continue;
    const iRev = ths.findIndex((h) => h === '營業收入');
    let iGp = ths.indexOf('營業毛利（毛損）淨額');
    if (iGp < 0) iGp = ths.indexOf('營業毛利（毛損）');
    const iEps = ths.findIndex((h) => h.startsWith('基本每股盈餘'));
    for (const td of rowsOf(tb[1])) {
      if (td.length !== ths.length || !ID_RE.test(td[0])) continue;
      data[td[0]] = [iRev >= 0 ? num(td[iRev]) : null, iGp >= 0 ? num(td[iGp]) : null, iEps >= 0 ? num(td[iEps]) : null];
    }
  }
  return data;
}

/**
 * 累計 → 單季。cumByQ = { 'YYYY-Qn': [rev, gp, eps] }。
 * Q1 即單季；Qn = 累計(Qn) − 累計(Qn−1)，同年前一季缺資料就算不出來（留 null）。
 * EPS 相減是近似值（期間股數變動會有小誤差），與一般看盤軟體做法相同。
 */
export function cumulativeToQuarterly(cumByQ) {
  const out = [];
  Object.keys(cumByQ).sort().forEach((k) => {
    const [y, qs] = k.split('-Q');
    const q = Number(qs);
    const cur = cumByQ[k];
    const prev = q > 1 ? cumByQ[`${y}-Q${q - 1}`] : [0, 0, 0];
    if (!cur || !prev) return;
    const sub = (a, b) => (a == null || b == null ? null : a - b);
    const rev = sub(cur[0], prev[0]);
    const gp = sub(cur[1], prev[1]);
    const eps = cur[2] == null || prev[2] == null ? null : Math.round((cur[2] - prev[2]) * 100) / 100;
    out.push({ q: k, rev, gp, eps, gm: rev > 0 && gp != null ? (gp / rev) * 100 : null });
  });
  return out;
}
