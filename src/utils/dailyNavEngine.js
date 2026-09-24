/**
 * 每日淨值 (Daily NAV) 計算引擎
 *
 * 1. 每日時間軸：從「第一次交易」到「今天」，每一天都有索引。
 * 2. 每日狀態：Cash + Holdings；有交易則更新，無交易則承襲前一日。
 * 3. 按日盯市：每日總資產 = Cash + Sum(持股數量 × 當日收盤價)；非交易日用最後一個交易日收盤價（forward-fill）。
 * 4. 單位化：起始 NAV=100, Total_Units=0。入金或資金不足買入時 New_Units = Deposit / Current_NAV，Total_Units += New_Units（不改變當下 NAV）。每日結算 NAV = 當日總資產 / Total_Units。
 * 5. 槓桿：融資只出自付 40%（借款 60% 不計入入金），盯市時市值需扣除未償還借款本金；
 *    融券只出保證金 90%，盯市時權益 = 保證金 + 方向損益。⇒ 總資產 = 真實權益，NAV 正確反映槓桿放大。
 * 6. 交易成本：每筆交易當下從現金扣除手續費、證交稅、融資利息、借券費（與 pnlCalculator 同一套規則）。
 *    盯市時再扣「若今日平倉」的預估手續費、證交稅與融資應計利息 ⇒ 總資產 = 可實際拿回的淨值。
 * 7. 除權息：除息日現金股利入帳（空單為補償支出），配股併入現股。盯市價為未還原收盤，除息日價跌由股利補回。
 * 8. 融資借款依先進先出逐批償還（同 pnlCalculator 與券商）。
 */

import {
  MARGIN_LONG_SELF_RATIO,
  MARGIN_LONG_LOAN_RATIO,
  MARGIN_SHORT_DEPOSIT_RATIO,
  MARGIN_LONG_ANNUAL_RATE,
  createLedgerContext,
  calcBrokerFee,
  calcSellTax,
} from './pnlCalculator';

const EPSILON = 1e-10;
const TRADE_EPSILON = 1e-6;

const INITIAL_NAV = 100;
const MS_PER_DAY = 86400000;

/** 融資各批到 dateStr 為止的應計利息 */
function accruedMarginInterest(lots, dateStr) {
  const asOf = new Date(dateStr).getTime();
  return (lots || []).reduce((sum, lot) => {
    const days = Math.max(0, Math.round((asOf - lot.time) / MS_PER_DAY));
    return sum + lot.price * MARGIN_LONG_LOAN_RATIO * lot.qty * MARGIN_LONG_ANNUAL_RATE * days / 365;
  }, 0);
}

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
      tradeType: e.tradeType || 'STOCK',
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
function runDailySimulation(entries, timeline, options = {}) {
  const tradesByDate = getTradesByDate(entries);
  const { tradeCost, dividendEffects } = createLedgerContext(entries, options);
  const dividendsByDate = new Map();
  for (const d of dividendEffects) {
    if (!dividendsByDate.has(d.date)) dividendsByDate.set(d.date, []);
    dividendsByDate.get(d.date).push(d);
  }
  const result = [];
  let cash = 0;
  const stock = {}; // code -> { qty, positionCost }    現股（qty 可負 = 現股空單）
  const mlong = {}; // code -> { qty, cost, lots }       融資多頭（qty >= 0；lots 依先進先出）
  const short = {}; // code -> { qty, cost, deposit }    融券空頭（qty >= 0）
  let totalUnits = 0;
  let nav = INITIAL_NAV;

  // ── 現金進出：出金且現金不足 → 缺口視為外部入金，按當下 NAV 發行單位 ──
  const applyCash = (cashDelta) => {
    if (cashDelta < -TRADE_EPSILON) {
      const need = -cashDelta;
      if (cash < need - TRADE_EPSILON) {
        const deposit = need - cash;
        const currentNAV = totalUnits > EPSILON ? (result.length > 0 ? result[result.length - 1].nav : nav) : INITIAL_NAV;
        cash += deposit;
        totalUnits += deposit / currentNAV;
      }
    }
    cash += cashDelta;
  };

  for (const dateStr of timeline) {
    // ── 除權息（開盤前）：現金股利入帳、配股併入現股 ──
    for (const d of dividendsByDate.get(dateStr) || []) {
      if (d.bonusShares > 0) {
        if (!stock[d.code]) stock[d.code] = { qty: 0, positionCost: 0 };
        stock[d.code].qty += d.bonusShares;
      }
      applyCash(d.cash);
    }

    const trades = tradesByDate.get(dateStr) || [];

    for (const t of trades) {
      const amount = t.quantity * t.price;

      // ── 計算此筆真實現金流（負 = 出金）並更新對應部位池 ──
      let cashDelta = 0;
      if (t.tradeType === 'MARGIN_LONG') {
        if (!mlong[t.code]) mlong[t.code] = { qty: 0, cost: 0, lots: [] };
        const m = mlong[t.code];
        if (t.direction === 'BUY') {
          m.qty += t.quantity;
          m.cost += amount;
          m.lots.push({ qty: t.quantity, price: t.price, time: new Date(dateStr).getTime() });
          cashDelta = -amount * MARGIN_LONG_SELF_RATIO; // 只出自付，借款 60% 非自有資金
        } else {
          // 收價金、依先進先出逐批償還借款本金
          let remain = Math.min(t.quantity, m.qty);
          const closeQty = remain;
          let closedCost = 0;
          while (remain > EPSILON && m.lots.length > 0) {
            const lot = m.lots[0];
            const q = Math.min(remain, lot.qty);
            closedCost += lot.price * q;
            lot.qty -= q;
            remain -= q;
            if (lot.qty <= EPSILON) m.lots.shift();
          }
          if (closeQty > EPSILON) {
            cashDelta = t.price * closeQty - closedCost * MARGIN_LONG_LOAN_RATIO;
            m.cost -= closedCost;
            m.qty -= closeQty;
          }
        }
        if (m.qty < EPSILON) delete mlong[t.code];
      } else if (t.tradeType === 'MARGIN_SHORT') {
        if (!short[t.code]) short[t.code] = { qty: 0, cost: 0, deposit: 0 };
        const sh = short[t.code];
        if (t.direction === 'SELL') {
          sh.qty += t.quantity;
          sh.cost += amount;
          sh.deposit += amount * MARGIN_SHORT_DEPOSIT_RATIO;
          cashDelta = -amount * MARGIN_SHORT_DEPOSIT_RATIO; // 出保證金（賣出價金被鎖）
        } else {
          const closeQty = Math.min(t.quantity, sh.qty);
          if (closeQty > EPSILON) {
            const avgShort = sh.cost / sh.qty;
            const avgDeposit = sh.deposit / sh.qty;
            cashDelta = avgDeposit * closeQty + (avgShort - t.price) * closeQty; // 釋放保證金 + 損益
            sh.cost -= avgShort * closeQty;
            sh.deposit -= avgDeposit * closeQty;
            sh.qty -= closeQty;
          }
        }
        if (sh.qty < EPSILON) delete short[t.code];
      } else {
        // ── 現股：全額換部位（維持原有淨部位邏輯） ──
        cashDelta = t.direction === 'BUY' ? -amount : amount;
        if (!stock[t.code]) stock[t.code] = { qty: 0, positionCost: 0 };
        const h = stock[t.code];
        if (t.direction === 'BUY') {
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
        } else {
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
        }
        if (Math.abs(h.qty) < EPSILON) delete stock[t.code];
      }
      cashDelta -= tradeCost(t);
      applyCash(cashDelta);
    }

    // ── 以成本估計的權益（供單位初始化與無價時 fallback）：
    //    現股=成本、融資=自付部分、融券=保證金 ──
    let positionCostEquity = 0;
    for (const h of Object.values(stock)) positionCostEquity += h.positionCost;
    for (const m of Object.values(mlong)) positionCostEquity += m.cost * MARGIN_LONG_SELF_RATIO;
    for (const sh of Object.values(short)) positionCostEquity += sh.deposit;
    const totalAssetsAtCost = cash + positionCostEquity;

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
      holdings: Object.entries(stock).reduce((acc, [k, v]) => {
        acc[k] = { qty: v.qty, positionCost: v.positionCost };
        return acc;
      }, {}),
      mlong: Object.entries(mlong).reduce((acc, [k, v]) => {
        acc[k] = { qty: v.qty, cost: v.cost, lots: v.lots.map((l) => ({ ...l })) };
        return acc;
      }, {}),
      short: Object.entries(short).reduce((acc, [k, v]) => {
        acc[k] = { qty: v.qty, cost: v.cost, deposit: v.deposit };
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
    // 現股（多單盯市；空單 = 成本 + price×qty，qty 為負）
    for (const [code, h] of Object.entries(row.holdings)) {
      const price = getPriceOnDate(priceMapByCode, code, dateStr);
      const qty = h.qty;
      const cost = h.positionCost;
      if (price != null && price > 0) {
        totalMarketValue += qty > 0 ? price * qty : cost + price * qty;
        // 若今日平倉的預估費用：多單賣出手續費＋證交稅、空單回補手續費
        totalMarketValue -= qty > 0
          ? calcBrokerFee(price, qty) + calcSellTax(code, price, qty)
          : calcBrokerFee(price, -qty);
      } else {
        totalMarketValue += cost;
      }
    }
    // 融資多頭：權益 = 市值 − 未償還借款本金（借款按成本固定，不隨股價變動）
    for (const [code, m] of Object.entries(row.mlong || {})) {
      const price = getPriceOnDate(priceMapByCode, code, dateStr);
      const loan = m.cost * MARGIN_LONG_LOAN_RATIO;
      totalMarketValue -= accruedMarginInterest(m.lots, dateStr);
      if (price != null && price > 0) {
        totalMarketValue += price * m.qty - loan;
        totalMarketValue -= calcBrokerFee(price, m.qty) + calcSellTax(code, price, m.qty);
      } else {
        totalMarketValue += m.cost - loan; // = 自付部分
      }
    }
    // 融券空頭：權益 = 保證金 + 方向損益（放空獲利 = 賣出成本 − 現價市值）
    for (const [code, sh] of Object.entries(row.short || {})) {
      const price = getPriceOnDate(priceMapByCode, code, dateStr);
      if (price != null && price > 0) {
        totalMarketValue += sh.deposit + (sh.cost - price * sh.qty) - calcBrokerFee(price, sh.qty);
      } else {
        totalMarketValue += sh.deposit;
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
 * @param {{ [code]: { [dateStr]: number } }} priceMapByCode 各檔歷史收盤價（未還原；缺日會 forward-fill）
 * @param {{ dividends? }} options 除權息事件（見 pnlCalculator runLedger）
 * @returns {{ date, nav, totalAssets, totalUnits, cash, holdings }[]}
 */
export function buildDailyNAVCurve(entries, todayStr, priceMapByCode = {}, options = {}) {
  const list = (entries || []).filter((e) => e.direction === 'BUY' || e.direction === 'SELL');
  if (list.length === 0) return [];

  const firstDate = list.map((e) => (e.date || '').slice(0, 10)).filter(Boolean).sort()[0];
  if (!firstDate) return [];

  const timeline = getDailyTimeline(firstDate, todayStr);
  if (timeline.length === 0) return [];

  const simulated = runDailySimulation(entries, timeline, { ...options, asOfDate: todayStr });
  return applyMarkToMarket(simulated, priceMapByCode);
}
