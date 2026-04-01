/**
 * 績效計算核心
 *
 * 入金自動識別：BUY 時現金不足則缺口記為入金；SELL 收益加回。僅能推估「最少」入金。
 *
 * 正確資產定義：
 *   Account_Assets(date) = cumAutoDeposit(date) + cumulativeRealized(date)
 *   - 買股票：現金換部位，資產總額不變
 *   - 賣股票：資產變動 = realized P&L
 *
 * NAV（單位淨值）：
 *   NAV = Account_Assets / totalUnits
 *   - 入金 → 按當下 NAV 發新單位（NAV 不變）
 *   - 交易獲利 → Assets 增、Units 不變 → NAV 上升
 *   - 報酬率 = (End_NAV / Start_NAV) - 1，完全不受入金影響。
 */

const EPSILON = 1e-10;
const TRADE_EPSILON = 1e-6;

// ─── 自動入金識別 ────────────────────────────────────────────

/**
 * 從交易明細自動識別「外部入金」。
 * 掃描所有 BUY/SELL（時間升序），維護 cashBalance：
 *   BUY：cashBalance < cost → 缺口視為外部入金
 *   SELL：proceeds 加回 cashBalance
 *
 * @param {Array} entries 交易日誌 entries（同 Firestore 格式）
 * @returns {{ id, date, amount, type: 'deposit' }[]}  自動識別的入金清單
 */
export function autoDetectCashFlows(entries) {
  const sorted = [...(entries || [])].sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    if (da !== db) return da - db;
    return (a.timeId || 0) - (b.timeId || 0);
  });

  let cashBalance = 0;
  const deposits = [];

  for (const e of sorted) {
    if (e.direction !== 'BUY' && e.direction !== 'SELL') continue;
    const qty = Number(e.quantity);
    const price = Number(e.price);
    if (isNaN(qty) || qty <= TRADE_EPSILON || isNaN(price) || price < 0.5) continue;

    const amount = qty * price;
    const dateStr = (e.date || '').slice(0, 10);

    if (e.direction === 'BUY') {
      if (cashBalance < amount - TRADE_EPSILON) {
        const missing = amount - cashBalance;
        deposits.push({
          id: `auto-${dateStr}-${deposits.length}`,
          date: dateStr,
          amount: Math.round(missing * 100) / 100,
          type: 'deposit',
        });
        cashBalance += missing;
      }
      cashBalance -= amount;
      cashBalance = Math.max(0, cashBalance); // 浮點數保護
    } else {
      // SELL（含做空開倉）：現金流入
      cashBalance += amount;
    }
  }

  return deposits;
}

// ─── 基礎工具 ───────────────────────────────────────────────

/** 累計淨入金（<= dateStr 的所有 deposit - withdrawal） */
export function getCumulativeCFUpTo(cashFlows, dateStr) {
  if (!cashFlows || !cashFlows.length) return 0;
  const end = (dateStr || '').slice(0, 10);
  let cum = 0;
  for (const cf of cashFlows) {
    const d = (cf.date || '').slice(0, 10);
    if (d <= end) {
      cum += cf.type === 'withdrawal' ? -Number(cf.amount || 0) : Number(cf.amount || 0);
    }
  }
  return cum;
}

/** 前一日 YYYY-MM-DD，無效日期回傳 null */
export function previousDay(dateStr) {
  const d = new Date((dateStr || '').slice(0, 10));
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 某月最後一天 YYYY-MM-DD（month 為 1–12） */
export function lastDayOfMonth(year, month) {
  // Date.UTC(year, month, 0)：month 為 1-12；下個月第 0 天 = 本月最後一天
  // 使用 UTC 避免本地時區（台灣 UTC+8）午夜 00:00 被 toISOString 轉成前一天
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

// ─── 從 equityCurve 取 cumulativeRealized ───────────────────

/** 取該日或之前最後一個 cumulativeRealized 值（來自 buildEquityCurve 結果） */
function getCumRealizedAt(curveData, dateStr) {
  if (!curveData || curveData.length === 0) return 0;
  const d = (dateStr || '').slice(0, 10);
  let result = 0;
  for (const pt of curveData) {
    if ((pt.date || '').slice(0, 10) <= d) {
      result = pt.cumulativeRealized ?? 0;
    } else {
      break; // curveData 已按日期升序
    }
  }
  return result;
}

// ─── NAV 曲線 ────────────────────────────────────────────────

/**
 * buildNAVCurve：建立單位淨值時序曲線。
 *
 * 每個時間點：
 *   totalAssets = getCumulativeCFUpTo(cashFlows, date) + getCumRealizedAt(curveData, date)
 *   totalUnits  = 隨入金/出金動態調整（入金按當時 NAV 發單位）
 *   nav         = totalAssets / totalUnits
 *
 * @param {Array} curveData  buildEquityCurve 的結果，需含 date、cumulativeRealized
 * @param {Array} cashFlows  { date, amount, type: 'deposit'|'withdrawal' }[]
 * @returns {{ date, totalAssets, totalUnits, nav }[]}
 */
export function buildNAVCurve(curveData, cashFlows) {
  // 建立 cashflows 依日期分組
  const cfByDate = new Map();
  (cashFlows || []).forEach((cf) => {
    const d = (cf.date || '').slice(0, 10);
    if (!cfByDate.has(d)) cfByDate.set(d, []);
    cfByDate.get(d).push({ amount: Number(cf.amount) || 0, type: cf.type || 'deposit' });
  });

  const curveDates = (curveData || []).map((p) => (p.date || '').slice(0, 10));
  const allDates = [...new Set([...curveDates, ...cfByDate.keys()])].sort();
  if (allDates.length === 0) return [];

  // curveData 已按日期升序（buildEquityCurve 有 sort），確保 getCumRealizedAt 的 break 有效
  const sortedCurve = [...(curveData || [])].sort((a, b) =>
    (a.date || '').localeCompare(b.date || '')
  );

  let totalUnits = 0;
  const result = [];

  for (const dateStr of allDates) {
    // 今日之前（含）的資產：入金累計 + 已實現損益
    // 使用「昨日」的 cumCF 來計算入金前的資產，以便正確定價新單位
    const prevDay = previousDay(dateStr) || dateStr;
    const cumCFBeforeToday = getCumulativeCFUpTo(cashFlows, prevDay);
    const cumRealized = getCumRealizedAt(sortedCurve, dateStr);

    // 入金之前的 NAV（用於定價新單位）
    const assetsBeforeCF = cumCFBeforeToday + cumRealized;
    const navBeforeCF = totalUnits > EPSILON ? assetsBeforeCF / totalUnits : 1;

    // 處理今日入金/出金：按入金前 NAV 發/贖單位
    const cfs = cfByDate.get(dateStr) || [];
    for (const cf of cfs) {
      if (cf.amount <= 0) continue;
      if (cf.type === 'withdrawal') {
        const unitsOut = cf.amount / navBeforeCF;
        totalUnits = Math.max(EPSILON, totalUnits - unitsOut);
      } else {
        totalUnits += cf.amount / navBeforeCF;
      }
    }

    // 今日收盤資產（含今日入金/出金）
    const totalAssets = getCumulativeCFUpTo(cashFlows, dateStr) + cumRealized;
    const nav = totalUnits > EPSILON ? totalAssets / totalUnits : (totalAssets > 0 ? totalAssets : navBeforeCF);

    result.push({ date: dateStr, totalAssets, totalUnits, nav });
  }

  return result;
}

/** 從 NAV 曲線取得某日或之前的最後一筆 NAV */
export function getNAVAt(navCurve, dateStr) {
  if (!navCurve || navCurve.length === 0) return null;
  const d = (dateStr || '').slice(0, 10);
  let last = null;
  for (const pt of navCurve) {
    if ((pt.date || '').slice(0, 10) <= d) last = pt.nav;
    else break;
  }
  return last;
}

/** 報酬率 % = (End_NAV / Start_NAV - 1) * 100 */
export function navReturnPercent(startNAV, endNAV) {
  if (startNAV == null || endNAV == null || startNAV <= EPSILON) return null;
  return ((endNAV / startNAV) - 1) * 100;
}

// ─── 期間定義 ────────────────────────────────────────────────

/** 台北時區今日 YYYY-MM-DD */
function getTaipeiToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

export function getDefaultPeriods() {
  const today = getTaipeiToday();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)); // 1-12
  const pad = (n) => String(n).padStart(2, '0');

  const monthStart = `${y}-${pad(m)}-01`;
  const threeMoAgo = new Date(Date.UTC(y, m - 1 - 3, Number(today.slice(8, 10))));
  const sixMoAgo   = new Date(Date.UTC(y, m - 1 - 6, Number(today.slice(8, 10))));
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear  = m === 1 ? y - 1 : y;
  const prevMonthStart = `${prevYear}-${pad(prevMonth)}-01`;
  const prevMonthEnd = lastDayOfMonth(prevYear, prevMonth);

  return [
    { key: 'thisMonth', label: '本月至今',   startStr: monthStart,                          endStr: today },
    { key: 'prevMonth', label: '前一月',     startStr: prevMonthStart,                      endStr: prevMonthEnd },
    { key: 'past3m',   label: '近三個月',   startStr: threeMoAgo.toISOString().slice(0, 10), endStr: today },
    { key: 'past6m',   label: '近半年',     startStr: sixMoAgo.toISOString().slice(0, 10), endStr: today },
    { key: 'ytd',      label: '今年至今',   startStr: `${y}-01-01`,                         endStr: today },
    { key: 'lastYear', label: '去年',       startStr: `${y - 1}-01-01`,                    endStr: `${y - 1}-12-31` },
  ];
}

// ─── 月度報酬熱力圖 ──────────────────────────────────────────

/**
 * 月度報酬矩陣（基於 NAV 曲線）。
 * 僅計算「已結束」的月份（monthEnd <= today）。
 */
export function getMonthlyReturnsMatrix(navCurve, todayStr) {
  if (!navCurve || navCurve.length === 0) return [];
  const today = (todayStr || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const firstDate = (navCurve[0].date || '').slice(0, 10);
  const lastDate = (navCurve[navCurve.length - 1].date || '').slice(0, 10);

  const firstYear = Number(firstDate.slice(0, 4));
  const lastYear = Number(lastDate.slice(0, 4));
  const result = [];

  for (let yr = firstYear; yr <= lastYear; yr++) {
    for (let mo = 1; mo <= 12; mo++) {
      const monthEnd = lastDayOfMonth(yr, mo);
      const prevMonthEnd = lastDayOfMonth(mo === 1 ? yr - 1 : yr, mo === 1 ? 12 : mo - 1);

      // 只計算已結束且有資料的月份
      if (monthEnd > today) continue;
      if (monthEnd < firstDate) continue;

      const startNAV = getNAVAt(navCurve, prevMonthEnd);
      const endNAV = getNAVAt(navCurve, monthEnd);
      const pct = navReturnPercent(startNAV, endNAV);
      result.push({ year: yr, month: mo, returnPct: pct });
    }
  }
  return result;
}
