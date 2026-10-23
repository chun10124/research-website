// 一次性：用 FinMind（2018/6～2025/10）＋本機已存的期交所微台資料，以籌碼頁同一份公式（computeChipRows）算歷史列。
// 不打期交所、不打 FinMind（全部讀 output/ 已存檔）。
// 1. 與網站現有一年份（Firestore 快照）的重疊日逐欄比對，不一致就停止
// 2. 通過才輸出 output/20261023_chip_history_rows_tmp.json；加 --write 才寫入 Firestore ibdRsMeta/futuresChipsHist_YYYY
import { readFileSync, writeFileSync } from 'node:fs';

const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: (k) => { _ls.delete(k); }, clear: () => { _ls.clear(); }, key: (i) => [..._ls.keys()][i] ?? null,
  get length() { return _ls.size; },
};
const { computeChipRows } = await import('../src/features/FuturesChips/taifexApi.js');

const J = (p) => JSON.parse(readFileSync(p, 'utf8'));
const fm1 = J('output/20261023_finmind_chip_raw_tmp.json');
const fm2 = J('output/20261023_finmind_chip_raw2_tmp.json');
const fm = (k) => [...fm1[k], ...fm2[k]];
const tfFut = J('output/20261022_taifex_foreign_tmp.json').fut; // 微台法人（分身份）
const tfOi = J('output/20261020_taifex_cache.json').oi;         // 微台各月份未平倉
const yahoo = J('output/20261023_taiex_ohlc_9y_tmp.json');
const fubon = J('output/20261023_fubon_index_tmp.json');
const live = J('output/20261023_live_chips_tmp.json');

const END = '2025/10/31';
const START = '2018/07/02';
const s = (d) => d.replace(/-/g, '/');

// 期貨各月份未平倉（一般盤、不含價差）
const oiMap = (fid) => {
  const out = {};
  for (const r of fm(`TaiwanFuturesDaily|${fid}`)) {
    if (r.trading_session !== 'position' || r.contract_date.includes('/')) continue;
    (out[s(r.date)] ||= {})[r.contract_date.trim()] = r.open_interest;
  }
  return out;
};
// 法人期貨 → [三類多, 三類空, 外資多, 外資空]
const instMap = (fid) => {
  const out = {};
  for (const r of fm(`TaiwanFuturesInstitutionalInvestors|${fid}`)) {
    const x = (out[s(r.date)] ||= [0, 0, 0, 0]);
    x[0] += r.long_open_interest_balance_volume;
    x[1] += r.short_open_interest_balance_volume;
    if (r.institutional_investors === '外資') { x[2] = r.long_open_interest_balance_volume; x[3] = r.short_open_interest_balance_volume; }
  }
  return out;
};
// 外資選擇權 → CALL 6 欄 + PUT 6 欄 [買口, 買金, 賣口, 賣金, 淨口, 淨金]
const opt = {};
for (const r of fm('TaiwanOptionInstitutionalInvestors|TXO')) {
  if (r.institutional_investors !== '外資') continue;
  const x = (opt[s(r.date)] ||= new Array(12).fill(0));
  const o = r.call_put === '買權' ? 0 : 6;
  const lv = r.long_open_interest_balance_volume, la = r.long_open_interest_balance_amount;
  const sv = r.short_open_interest_balance_volume, sa = r.short_open_interest_balance_amount;
  [lv, la, sv, sa, lv - sv, la - sa].forEach((v, j) => { x[o + j] = v; });
}
const cut = (m) => Object.fromEntries(Object.entries(m).filter(([d]) => d <= END));
// 微台：期交所本機快取（2024/7 上市後才有）
const tmfInst = {};
for (const [d, who] of Object.entries(tfFut.TMF || {})) {
  const ids = Object.values(who);
  tmfInst[d] = [ids.reduce((a, v) => a + v[0], 0), ids.reduce((a, v) => a + v[2], 0), who.foreign?.[0] ?? 0, who.foreign?.[2] ?? 0];
}
// 加權：收盤優先富邦（與網站相同），高低用 Yahoo
const index = {}, ohlc = { priceMap: {}, highMap: {}, lowMap: {} };
for (const k of yahoo) {
  index[k.date] = k.close; ohlc.priceMap[k.date] = k.close; ohlc.highMap[k.date] = k.high; ohlc.lowMap[k.date] = k.low;
}
for (const [d, c] of Object.entries(fubon.closes)) index[d] = c;

const rows = computeChipRows({
  start: START,
  tx: cut(oiMap('TX')), mtx: cut(oiMap('MTX')), tmf: cut(tfOi.TMF),
  txfInst: cut(instMap('TX')), mxfInst: cut(instMap('MTX')), tmfInst: cut(tmfInst), opt: cut(opt),
  index, ohlc,
});

// 與網站現有一年份比對重疊日
const liveBy = Object.fromEntries(live.rows.map((r) => [r.date, r]));
let checked = 0; const diffs = [];
for (const r of rows) {
  const l = liveBy[r.date];
  if (!l) continue;
  checked++;
  for (const k of Object.keys(l)) {
    const a = r[k], b = l[k];
    const same = JSON.stringify(a) === JSON.stringify(b) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6);
    if (!same) diffs.push(`${r.date} ${k}: 歷史 ${JSON.stringify(a)} ／ 網站 ${JSON.stringify(b)}`);
  }
}
console.log(`歷史 ${rows.length} 列（${rows[0]?.date} ~ ${rows[rows.length - 1]?.date}）；重疊 ${checked} 天比對，差異 ${diffs.length} 處`);
diffs.slice(0, 40).forEach((x) => console.log('  ', x));
writeFileSync('output/20261023_chip_history_rows_tmp.json', JSON.stringify(rows));
if (process.argv.includes('--write')) {
  if (diffs.length) { console.log('有差異，不寫入'); process.exit(1); }
  const { doc, setDoc } = await import('firebase/firestore');
  const { db } = await import('../src/utils/firebaseConfig.js');
  const years = [...new Set(rows.map((r) => r.date.slice(0, 4)))];
  for (const y of years) {
    const part = rows.filter((r) => r.date.startsWith(y));
    const json = JSON.stringify({ from: part[0].date.replace(/\//g, '-'), through: part[part.length - 1].date.replace(/\//g, '-'), rows: part });
    await setDoc(doc(db, 'ibdRsMeta', `futuresChipsHist_${y}`), { schema: 2, json, updatedAt: Date.now() });
    console.log(`寫入 futuresChipsHist_${y}：${part.length} 列、${Math.round(json.length / 1024)} KB`);
  }
  process.exit(0);
}
