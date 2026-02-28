/**
 * 每日淨值 (Daily NAV) 計算引擎
 *
 * 1. 每日時間軸：從「第一次交易」到「今天」，每一天都有索引。
 * 2. 每日狀態：Cash + Holdings；有交易則更新，無交易則承襲前一日。
 * 3. 按日盯市：每日總資產 = Cash + Sum(持股數量 × 當日收盤價)；非交易日用最後一個交易日收盤價（forward-fill）。
 * 4. 單位化：起始 NAV=100, Total_Units=0。入金或資金不足買入時 New_Units = Deposit / Current_NAV，Total_Units += New_Units（不改變當下 NAV）。每日結算 NAV = 當日總資產 / Total_Units。
 */

const EPSILON = 1e-10;
const TRADE_EPSILON = 1e-6;

const INITIAL_NAV = 100;

/** 產生 [startStr, endStr] 間每一天的 YYYY-MM-DD 陣列（含起迄） */
export function getDailyTimeline(startStr, endStr) {
  const start = (startStr || '').slice(0, 10);
  const end = (endStr || '').slice(0, 10);
  if (!start || !end || start > end) return [];
  const out = [];
  const d = new Date(start);
  const endDate = new Date(end);
  while (d <= endDate) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * 取得 dateStr 當日收盤價；若無資料則用該 code 在 dateStr 之前最近一日的收盤價（forward-fill）。
 * priceMapByCode: { [code]: { [dateStr]: number } }（可有缺日）
 */
export function getPriceOnDate(priceMapByCode, code, dateStr) {
  const byDate = priceMapByCode[code];
  if (!byDate) return null;
  if (byDate[dateStr] != null && byDate[dateStr] > 0) return byDate[dateStr];
  const dates = Object.keys(byDate).filter((d) => d <= dateStr).sort();
  if (dates.length === 0) return null;
  return byDate[dates[dates.length - 1]];
}

/**
 * 將交易依日期分組，同一天依 timeId 排序
 */
function getTradesByDate(entries) {
  const list = (entries || [])
    .filter((e) => e.direction === 'BUY' || e.direction === 'SELL')
    .map((e) => ({
      date: (e.date || '').slice(0, 10),
      timeId: e.timeId || 0,
      direction: e.direction,
      code: e.code,
      name: e.name,
      quantity: Number(e.quantity),
      price: Number(e.price),
    }))
    .filter((e) => e.date && e.quantity > TRADE_EPSILON && e.price >= 0.5);
  list.sort((a, b) => a.date.localeCompare(b.date) || a.timeId - b.timeId);

  const byDate = new Map();
  for (const t of list) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }
  return byDate;
}

/**
 * 每日 NAV 曲線（純狀態模擬，不依賴外部價格）
 * 回傳每日 { date, nav, totalAssets, totalUnits, cash, holdings }；需再搭配歷史價做 mark-to-market。
 */
function runDailySimulation(entries, timeline) {
  const tradesByDate = getTradesByDate(entries);
  const result = [];
  let cash = 0;
  const holdings = {}; // code -> { qty, positionCost }
  let totalUnits = 0;
  let nav = INITIAL_NAV;

  for (const dateStr of timeline) {
    const trades = tradesByDate.get(dateStr) || [];

    for (const t of trades) {
      const amount = t.quantity * t.price;
      if (t.direction === 'BUY') {
        if (cash < amount - TRADE_EPSILON) {
          const deposit = amount - cash;
          cash += deposit;
          const currentNAV = totalUnits > EPSILON ? (result.length > 0 ? result[result.length - 1].nav : nav) : INITIAL_NAV;
          totalUnits += deposit / currentNAV;
        }
        cash -= amount;
        if (!holdings[t.code]) holdings[t.code] = { qty: 0, positionCost: 0 };
        const h = holdings[t.code];
        if (h.qty < 0) {
          const closeQty = Math.min(t.quantity, Math.abs(h.qty));
          const avgShort = Math.abs(h.qty) > EPSILON ? h.positionCost / Math.abs(h.qty) : 0;
          h.positionCost -= avgShort * closeQty;
          h.qty += closeQty;
          const remain = t.quantity - closeQty;
          if (remain > EPSILON) {
            h.qty = remain;
            h.positionCost = t.price * remain;
          }
        } else {
          h.qty += t.quantity;
          h.positionCost += amount;
        }
        if (Math.abs(h.qty) < EPSILON) delete holdings[t.code];
      } else {
        cash += amount;
        if (!holdings[t.code]) holdings[t.code] = { qty: 0, positionCost: 0 };
        const h = holdings[t.code];
        if (h.qty > 0) {
          const closeQty = Math.min(t.quantity, h.qty);
          const avgCost = h.qty > EPSILON ? h.positionCost / h.qty : 0;
          h.positionCost -= avgCost * closeQty;
          h.qty -= closeQty;
          const remain = t.quantity - closeQty;
          if (remain > EPSILON) {
            h.qty = -remain;
            h.positionCost = t.price * remain;
          }
        } else {
          h.qty -= t.quantity;
          h.positionCost += amount;
        }
        if (Math.abs(h.qty) < EPSILON) delete holdings[t.code];
      }
    }

    const positionCost = Object.values(holdings).reduce((s, h) => s + h.positionCost, 0);
    const totalAssetsAtCost = cash + positionCost;
    if (totalUnits < EPSILON && totalAssetsAtCost > EPSILON) {
      totalUnits = totalAssetsAtCost / INITIAL_NAV;
      nav = INITIAL_NAV;
    } else if (totalUnits > EPSILON) {
      nav = totalAssetsAtCost / totalUnits;
    }

    result.push({
      date: dateStr,
      nav,
      totalAssets: totalAssetsAtCost,
      totalUnits,
      cash,
      holdings: Object.entries(holdings).reduce((acc, [k, v]) => {
        acc[k] = { qty: v.qty, positionCost: v.positionCost };
        return acc;
      }, {}),
    });
  }

  return result;
}

/**
 * 用歷史收盤價做按日盯市，覆寫每日 totalAssets 與 nav。
 * dailyRows: runDailySimulation 的輸出
 * priceMapByCode: { [code]: { [dateStr]: number } }，缺日會 forward-fill
 */
export function applyMarkToMarket(dailyRows, priceMapByCode) {
  if (!dailyRows.length) return dailyRows;
  const out = [];
  for (let i = 0; i < dailyRows.length; i++) {
    const row = dailyRows[i];
    const dateStr = row.date;
    let totalMarketValue = row.cash;
    for (const [code, h] of Object.entries(row.holdings)) {
      const price = getPriceOnDate(priceMapByCode, code, dateStr);
      const qty = h.qty;
      const cost = h.positionCost;
      if (price != null && price > 0) {
        totalMarketValue += qty > 0 ? price * qty : cost + price * qty;
      } else {
        totalMarketValue += cost;
      }
    }
    const totalAssets = totalMarketValue;
    const totalUnits = row.totalUnits;
    const nav = totalUnits > EPSILON ? totalAssets / totalUnits : (out.length ? out[out.length - 1].nav : INITIAL_NAV);
    out.push({ ...row, totalAssets, nav });
  }
  return out;
}

/**
 * 主入口：建立每日 NAV 陣列（從第一次交易到今天，含按日盯市）。
 * @param {Array} entries 交易日誌
 * @param {string} todayStr 今天 YYYY-MM-DD
 * @param {{ [code]: { [dateStr]: number } }} priceMapByCode 各檔歷史收盤價（缺日會 forward-fill）
 * @returns {{ date, nav, totalAssets, totalUnits, cash, holdings }[]}
 */
export function buildDailyNAVCurve(entries, todayStr, priceMapByCode = {}) {
  const list = (entries || []).filter((e) => e.direction === 'BUY' || e.direction === 'SELL');
  if (list.length === 0) return [];

  const firstDate = list.map((e) => (e.date || '').slice(0, 10)).filter(Boolean).sort()[0];
  if (!firstDate) return [];

  const timeline = getDailyTimeline(firstDate, todayStr);
  if (timeline.length === 0) return [];

  const simulated = runDailySimulation(entries, timeline);
  return applyMarkToMarket(simulated, priceMapByCode);
}
