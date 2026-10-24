/* 估值資料：FinMind 綜合損益表（單季，Q4 已換算），轉成「列＝科目、欄＝季（或年）」的 Tab 分隔文字，供貼到 Excel */

const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';
const START_DATE = '2023-01-01'; // 年度表從 2023 起
const QUARTER_FROM = '2024-01-01'; // 季表從 1Q24 起

// [FinMind type, 顯示名稱]；金額轉千元，EPS 維持元
const ITEMS = [
  ['Revenue', '營收'],
  ['CostOfGoodsSold', '營業成本'],
  ['OperatingExpenses', '營業費用'],
  ['OperatingIncome', '營業利益'],
  ['TotalNonoperatingIncomeAndExpense', '業外收支淨額'],
  ['PreTaxIncome', '稅前淨利'],
  ['TAX', '所得稅費用'],
  ['IncomeAfterTaxes', '稅後淨利'],
  ['EquityAttributableToOwnersOfParent', '歸屬母公司淨利'],
  ['EPS', '每股盈餘(元)'],
];

// 四捨五入到整數、三位一撇（Excel 貼上仍會辨識為數字）
const thousands = (n) => Math.round(n).toLocaleString('en-US');

// 2024-03-31 → 1Q24
const quarterLabel = (ymd) => `${Math.ceil(Number(ymd.slice(5, 7)) / 3)}Q${ymd.slice(2, 4)}`;

// 純文字不帶字型，貼到 Excel／Numbers 時中文會用對方的預設字型（Mac 上可能被替換成娃娃體），
// 所以剪貼簿另附一份每格指定黑體-簡的 HTML 表格
const CELL_STYLE = "font-family:'Heiti SC','STHeiti',sans-serif";
const escapeHtml = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtmlTable = (lines) => `<table style="${CELL_STYLE}">${lines.map((line) =>
  `<tr>${line.split('\t').map((c) => `<td style="${CELL_STYLE}">${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</table>`;

async function finmind(dataset, id) {
  const params = new URLSearchParams({ dataset, data_id: id, start_date: START_DATE });
  const res = await fetch(`${FINMIND_BASE}?${params}`);
  if (res.status === 402) throw new Error('FinMind 額度用盡，請稍後再試');
  if (!res.ok) throw new Error(`FinMind HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== 200) throw new Error(json.msg || `FinMind ${json.status}`);
  return json.data || [];
}

// mode = 'quarter'：1Q24 起各單季；mode = 'year'：2023 起四季齊全的年度（四季加總）
function buildTable(byDate, dates, mode) {
  // columns: [{ label, v: { type: value } }]
  let columns;
  if (mode === 'year') {
    const byYear = {};
    dates.forEach((d) => (byYear[d.slice(0, 4)] ||= []).push(byDate[d]));
    columns = Object.keys(byYear).sort()
      .filter((y) => byYear[y].length === 4) // 只列四季齊全的年度
      .map((y) => {
        const v = {};
        ITEMS.forEach(([type]) => {
          const vals = byYear[y].map((q) => q[type]);
          // EPS 也用四季加總：FinMind 沒有年度 EPS，與官方年度 EPS 可能差幾分錢
          v[type] = vals.some((x) => x == null) ? null : vals.reduce((a, b) => a + Number(b), 0);
        });
        return { label: y, v };
      });
  } else {
    columns = dates.filter((d) => d >= QUARTER_FROM).map((d) => ({ label: quarterLabel(d), v: byDate[d] }));
  }

  const fmt = (type, v) => {
    if (v == null || !Number.isFinite(Number(v))) return '';
    return type === 'EPS' ? Number(v).toFixed(2) : thousands(Number(v) / 1000);
  };
  const cells = [['科目(千元)', ...columns.map((c) => c.label)]];
  ITEMS.forEach(([type, name]) => {
    cells.push([name, ...columns.map((c) => fmt(type, c.v[type]))]);
  });
  // 加權平均股數：母公司淨利 ÷ EPS 反推（EPS 只到小數兩位，為近似值；Q4 EPS 為全年減前三季，股本變動年度會失真）
  cells.push(['加權平均股數(千股)', ...columns.map(({ v }) => {
    const ni = v.EquityAttributableToOwnersOfParent;
    const eps = v.EPS;
    return ni != null && eps ? thousands(ni / eps / 1000) : '';
  })]);

  const lines = cells.map((row) => row.join('\t'));
  return { cells, text: lines.join('\n'), html: toHtmlTable(lines) };
}

/** 一次抓取，回傳 { quarter, year }，各為 { cells, text, html }；查無資料或 API 失敗時拋錯 */
export async function fetchValuationTables(stockCode) {
  const id = String(stockCode || '').trim().replace(/\.(TW|TWO)$/i, '');
  const data = await finmind('TaiwanStockFinancialStatements', id);
  if (data.length === 0) throw new Error(`${id} 查無損益表資料`);

  const byDate = {};
  data.forEach((r) => { (byDate[r.date] ||= {})[r.type] = r.value; });
  const dates = Object.keys(byDate).sort();
  return { quarter: buildTable(byDate, dates, 'quarter'), year: buildTable(byDate, dates, 'year') };
}
