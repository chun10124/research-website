// ========== 融資／融券常數 ==========
export const MARGIN_LONG_LOAN_RATIO = 0.6;      // 融資：借款六成
export const MARGIN_LONG_SELF_RATIO = 0.4;      // 融資：自付四成
export const MARGIN_LONG_ANNUAL_RATE = 0.0635;  // 融資年利率 6.35%
export const MARGIN_SHORT_DEPOSIT_RATIO = 0.9;  // 融券：保證金九成

// ========== 交易成本常數 ==========
// 已實現損益一律為「淨額」：扣除買賣手續費、證交稅、融資利息、融券借券費。
// 以 2025/09~2026/09 券商已實現損益 150 筆校準：手續費無折扣、每筆無條件捨去。
export const BROKER_FEE_RATE = 0.001425;        // 手續費 0.1425%（買賣各收）
export const BROKER_FEE_MIN_BOARD_LOT = 20;     // 整股最低手續費
export const BROKER_FEE_MIN_ODD_LOT = 1;        // 零股最低手續費
export const STOCK_TAX_RATE = 0.003;            // 證交稅：股票 0.3%（賣方）
export const ETF_TAX_RATE = 0.001;              // 證交稅：ETF（代號 00 開頭）0.1%
export const DAY_TRADE_TAX_RATE = 0.0015;       // 證交稅：現股當沖 0.15%
export const MARGIN_SHORT_BORROW_FEE_RATE = 0.0008; // 融券借券費 0.08%（賣出金額）
const MS_PER_DAY = 86400000;

/** 代碼去掉 .TW / .TWO 後綴（股利資料以純代碼比對） */
const bareCode = (code) => String(code || '').trim().replace(/\.(TW|TWO)$/i, '');

/** 台北時區今日 YYYY-MM-DD */
const taipeiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

/** 融資一批借款到 asOfMs 為止的利息（借款 = 成交價 × 六成） */
const marginLotInterest = (lot, qty, asOfMs) => {
    const days = Math.max(0, Math.round((asOfMs - lot.time) / MS_PER_DAY));
    return lot.price * MARGIN_LONG_LOAN_RATIO * qty * MARGIN_LONG_ANNUAL_RATE * days / 365;
};

/** 單筆手續費（無條件捨去，整股/零股各有最低收費） */
export const calcBrokerFee = (price, qty) => {
    if (!(price > 0) || !(qty > 0)) return 0;
    const min = qty % 1000 === 0 ? BROKER_FEE_MIN_BOARD_LOT : BROKER_FEE_MIN_ODD_LOT;
    return Math.max(Math.floor(price * qty * BROKER_FEE_RATE), min);
};

/** 單筆賣出證交稅（無條件捨去）；dayTradeQty 為本筆屬於現股當沖的股數 */
export const calcSellTax = (code, price, qty, dayTradeQty = 0) => {
    if (!(price > 0) || !(qty > 0)) return 0;
    if (String(code || '').startsWith('00')) return Math.floor(price * qty * ETF_TAX_RATE);
    const dtQty = Math.min(Math.max(dayTradeQty, 0), qty);
    return Math.floor(price * dtQty * DAY_TRADE_TAX_RATE + price * (qty - dtQty) * STOCK_TAX_RATE);
};

// ========== 時間篩選邏輯 ==========
export const getStartDate = (range) => {
    const getNow = () => new Date();
    let startDate = null;

    switch (range) {
        case 'WEEK': {
            const d = getNow();
            const sun = d.getDate() - d.getDay();
            startDate = new Date(d.getFullYear(), d.getMonth(), sun, 0, 0, 0, 0);
            break;
        }
        case 'MONTH': {
            const m = getNow();
            startDate = new Date(m.getFullYear(), m.getMonth(), 1);
            break;
        }
        case 'QUARTER': {
            const q = getNow();
            startDate = new Date(q.setMonth(q.getMonth() - 3));
            break;
        }
        case 'HALFYEAR': {
            const h = getNow();
            startDate = new Date(h.setMonth(h.getMonth() - 6));
            break;
        }
        case 'YEAR': {
            const y = getNow();
            startDate = new Date(y.setFullYear(y.getFullYear() - 1));
            break;
        }
        case 'ALL':
        default:
            startDate = null;
    }
    return startDate;
};

// ========== I. 交易帳重演 ==========
/** 單筆交易的識別鍵（淨值引擎用來查詢該筆交易的現金成本） */
export const tradeCostKey = (e) =>
    `${String(e.date || '').slice(0, 10)}|${e.timeId || 0}|${e.code}|${e.direction}|${e.tradeType || 'STOCK'}|${Number(e.quantity)}|${Number(e.price)}`;

/**
 * 依時間重演全部交易與除權息：各池部位、已實現交易，
 * 以及每筆交易「當下」實際付出的現金成本（手續費、證交稅、融資利息、借券費）。
 *
 * options.dividends: [{ code, exDate: 'YYYY-MM-DD', cash: 每股現金股利, stock: 每股配股數（例 0.05） }]
 *   除息日「開盤前」持有者參與：前一日收盤的部位入帳，除息日當天買進不參與、當天賣出仍參與。
 *   - 現金股利：現股與融資多單的持有成本扣減（同券商做法，賣出時才進已實現）；空單須補償股利。
 *   - 股票股利：配股併入現股（成本 0，攤低均價），零股無條件捨去。
 * options.asOfDate: 只套用除息日 <= 此日的事件（預設台北今日）
 */
const runLedger = (entries, options = {}) => {
    const sortedEntries = [...(entries || [])].sort((a, b) => {
        const dateDiff = new Date(a.date) - new Date(b.date);
        return dateDiff !== 0 ? dateDiff : (a.timeId || 0) - (b.timeId || 0);
    });
    const asOfDate = options.asOfDate || taipeiToday();
    const events = (options.dividends || [])
        .filter((ev) => ev && ev.exDate && ev.exDate <= asOfDate && ((ev.cash || 0) > 0 || (ev.stock || 0) > 0))
        .sort((a, b) => a.exDate.localeCompare(b.exDate));
    let nextEvent = 0;

    const stockMap = {};
    const byBare = {};          // 純代碼 -> stockMap 的 key
    const entryCosts = [];      // { key, cost }，依重演順序
    const dividendEffects = []; // { date, code, cash（入帳為正）, bonusShares }
    const EPSILON = 1e-6;
    const mergeDayBuys = (s) => {
        if (s.dq > EPSILON) { s.sq += s.dq; s.sc += s.dc; s.sFee += s.dFee; }
        s.dq = 0; s.dc = 0; s.dFee = 0; s.dDate = null;
    };

    const applyDividend = (ev) => {
        const code = byBare[bareCode(ev.code)];
        if (!code) return;
        const s = stockMap[code];
        mergeDayBuys(s);
        const cashPs = Number(ev.cash) || 0;
        const stockPs = Number(ev.stock) || 0;
        let cash = 0;
        if (cashPs > 0) {
            // 現股：多單成本扣減（收股利）；空單賣出所得扣減（補償股利）
            if (Math.abs(s.sq) > EPSILON) {
                const q = Math.abs(s.sq);
                s.sc -= cashPs * q;
                cash += s.sq > 0 ? cashPs * q : -cashPs * q;
            }
            s.mlLots.forEach((lot) => { lot.div += cashPs; cash += cashPs * lot.qty; });
            if (s.msq > EPSILON) { s.msc -= cashPs * s.msq; cash -= cashPs * s.msq; }
        }
        let bonusShares = 0;
        if (stockPs > 0 && s.sq >= -EPSILON) {
            bonusShares = Math.floor((Math.max(s.sq, 0) + s.mlq) * stockPs + 1e-9);
            if (bonusShares > 0) s.sq = Math.max(s.sq, 0) + bonusShares;
        }
        if (Math.abs(cash) > EPSILON || bonusShares > 0) {
            dividendEffects.push({ date: ev.exDate, code, cash, bonusShares });
        }
    };
    const applyDividendsUpTo = (dateStr) => {
        while (nextEvent < events.length && events[nextEvent].exDate <= dateStr) {
            applyDividend(events[nextEvent]);
            nextEvent++;
        }
    };

    sortedEntries.forEach((e) => {
        const code = e.code;
        applyDividendsUpTo(String(e.date || '').slice(0, 10));
        if (!stockMap[code]) {
            byBare[bareCode(code)] = code;
            stockMap[code] = {
                name: e.name,
                // 現股池（sq 可為負，代表現股放空）；sFee = 開倉時已付、尚未攤入損益的成本
                sq: 0, sc: 0, sFee: 0,
                // 當日現股買進（尚未併入 sq）：賣出先沖前日庫存，不足才沖當日買進（= 當沖）
                dq: 0, dc: 0, dFee: 0, dDate: null,
                // 融資多頭池（永遠 >= 0）；每筆融資是獨立借款，平倉依先進先出逐批沖銷（同券商）
                mlq: 0, mlc: 0, mlSelfPaid: 0, mlEarliestMs: null, mlLots: [],
                // 融券空頭池（永遠 >= 0，msq > 0 代表有未回補空單）
                msq: 0, msc: 0, msDeposit: 0, msEarliestMs: null, msFee: 0,
                // 已實現交易記錄
                trades: [],
            };
        }

        const s = stockMap[code];
        const qty = Number(e.quantity);
        const price = Number(e.price);
        const time = new Date(String(e.date || '').slice(0, 10)).getTime();
        const tradeType = e.tradeType || 'STOCK';

        if (isNaN(qty) || qty <= EPSILON || isNaN(price) || price < 0.5) return;

        const isPositionZero = (v) => Math.abs(v) < EPSILON;
        const fee = calcBrokerFee(price, qty);
        const payCost = (cost) => { if (cost > 0) entryCosts.push({ key: tradeCostKey(e), cost }); };

        // ---------- 融資多頭 ----------
        if (tradeType === 'MARGIN_LONG') {
            if (e.direction === 'BUY') {
                // 開融資多頭
                s.mlq += qty;
                s.mlc += price * qty;
                s.mlSelfPaid += price * qty * MARGIN_LONG_SELF_RATIO;
                s.mlLots.push({ qty, price, fee, time, div: 0 });
                if (s.mlEarliestMs === null) s.mlEarliestMs = time;
                payCost(fee);
            } else {
                // 融資賣出（平多）：先進先出逐批沖銷；利息 = 該批借款 × 年利率 × 持有天數 / 365
                if (s.mlq > EPSILON) {
                    const closedQty = Math.min(qty, s.mlq);
                    const closeFee = fee * (closedQty / qty);
                    const tax = calcSellTax(code, price, closedQty);
                    let grossPnl = 0, openFee = 0, interest = 0, closedCost = 0;
                    let remain = closedQty;
                    while (remain > EPSILON && s.mlLots.length > 0) {
                        const lot = s.mlLots[0];
                        const q = Math.min(remain, lot.qty);
                        const lotFee = lot.fee * (q / lot.qty);
                        grossPnl += (price - lot.price + lot.div) * q;
                        closedCost += lot.price * q;
                        openFee += lotFee;
                        interest += marginLotInterest(lot, q, time);
                        lot.fee -= lotFee;
                        lot.qty -= q;
                        remain -= q;
                        if (lot.qty <= EPSILON) s.mlLots.shift();
                    }
                    const fees = openFee + closeFee;
                    const realizedPnl = grossPnl - fees - tax - interest;
                    payCost(closeFee + tax + interest);
                    const capitalUsed = closedCost * MARGIN_LONG_SELF_RATIO;
                    if (Math.abs(realizedPnl) > EPSILON) {
                        s.trades.push({ pnl: realizedPnl, closeTime: time, capitalUsed, tradeType: 'MARGIN_LONG', fees, tax, interest });
                    }
                    s.mlc -= closedCost;
                    s.mlSelfPaid -= capitalUsed;
                    s.mlq -= closedQty;
                    if (isPositionZero(s.mlq)) { s.mlq = 0; s.mlc = 0; s.mlSelfPaid = 0; s.mlLots = []; s.mlEarliestMs = null; }
                }
                // 若超賣（mlq 不足），餘量轉入現股空單（罕見，保守處理）
            }
            return;
        }

        // ---------- 融券空頭 ----------
        if (tradeType === 'MARGIN_SHORT') {
            if (e.direction === 'SELL') {
                // 開融券空頭：賣出時即付手續費、證交稅、借券費
                s.msq += qty;
                s.msc += price * qty;
                s.msDeposit += price * qty * MARGIN_SHORT_DEPOSIT_RATIO;
                const openCost = fee + calcSellTax(code, price, qty) + price * qty * MARGIN_SHORT_BORROW_FEE_RATE;
                s.msFee += openCost;
                payCost(openCost);
                if (s.msEarliestMs === null) s.msEarliestMs = time;
            } else {
                // 融券回補（平空）
                if (s.msq > EPSILON) {
                    const avgShortPrice = s.msc / s.msq;
                    const avgDeposit = s.msDeposit / s.msq;
                    const closedQty = Math.min(qty, s.msq);
                    const openCost = s.msFee * (closedQty / s.msq);
                    const closeFee = fee * (closedQty / qty);
                    const realizedPnl = (avgShortPrice - price) * closedQty - openCost - closeFee;
                    const capitalUsed = avgDeposit * closedQty;
                    payCost(closeFee);
                    if (Math.abs(realizedPnl) > EPSILON) {
                        s.trades.push({ pnl: realizedPnl, closeTime: time, capitalUsed, tradeType: 'MARGIN_SHORT', fees: openCost + closeFee, tax: 0, interest: 0 });
                    }
                    s.msc -= avgShortPrice * closedQty;
                    s.msDeposit -= avgDeposit * closedQty;
                    s.msFee -= openCost;
                    s.msq -= closedQty;
                    if (isPositionZero(s.msq)) { s.msq = 0; s.msc = 0; s.msDeposit = 0; s.msFee = 0; s.msEarliestMs = null; }
                }
            }
            return;
        }

        // ---------- 現股（含舊資料的預設行為） ----------
        const dateKey = String(e.date).slice(0, 10);
        if (s.dDate !== dateKey) mergeDayBuys(s); // 換日：前一日的買進併入庫存

        if (e.direction === 'BUY') {
            payCost(fee);
            if (s.sq < 0) {
                // 有現股空單，先平倉
                const absShortQty = Math.abs(s.sq);
                const avgShortPrice = absShortQty > EPSILON ? s.sc / absShortQty : 0;
                const closedQty = Math.min(qty, absShortQty);
                const remainingQty = qty - closedQty;

                if (closedQty > EPSILON) {
                    const openCost = s.sFee * (closedQty / absShortQty);
                    const closeFee = fee * (closedQty / qty);
                    const realizedPnl = (avgShortPrice - price) * closedQty - openCost - closeFee;
                    const capitalUsed = avgShortPrice * closedQty; // 現股空單用全額作資本
                    if (Math.abs(realizedPnl) > EPSILON) {
                        s.trades.push({ pnl: realizedPnl, closeTime: time, capitalUsed, tradeType: 'STOCK', fees: openCost + closeFee, tax: 0, interest: 0 });
                    }
                    s.sc -= avgShortPrice * closedQty;
                    s.sFee -= openCost;
                    s.sq += closedQty;
                }

                if (isPositionZero(s.sq) && remainingQty > EPSILON) {
                    s.sq = remainingQty;
                    s.sc = price * remainingQty;
                    s.sFee = fee * (remainingQty / qty);
                } else if (isPositionZero(s.sq)) {
                    s.sq = 0; s.sc = 0; s.sFee = 0;
                }
            } else {
                // 當日買進先放在當日池，收盤（換日）後才併入庫存
                s.dq += qty;
                s.dc += price * qty;
                s.dFee += fee;
                s.dDate = dateKey;
            }
        }

        if (e.direction === 'SELL') {
            // 先沖前日庫存（一般賣出），不足再沖當日買進（現股當沖，稅率減半）
            let remain = qty;
            let grossPnl = 0, openFee = 0, capitalUsed = 0, dayTradeQty = 0;
            const closeFrom = (qKey, cKey, fKey, isDayTrade) => {
                const poolQty = s[qKey];
                if (remain <= EPSILON || poolQty <= EPSILON) return;
                const q = Math.min(remain, poolQty);
                const avg = s[cKey] / poolQty;
                const f = s[fKey] * (q / poolQty);
                grossPnl += (price - avg) * q;
                openFee += f;
                capitalUsed += avg * q;
                if (isDayTrade) dayTradeQty += q;
                s[cKey] -= avg * q;
                s[fKey] -= f;
                s[qKey] -= q;
                remain -= q;
            };
            if (s.sq > 0) closeFrom('sq', 'sc', 'sFee', false);
            closeFrom('dq', 'dc', 'dFee', true);
            if (isPositionZero(s.sq)) { s.sq = 0; s.sc = 0; s.sFee = 0; }
            if (isPositionZero(s.dq)) { s.dq = 0; s.dc = 0; s.dFee = 0; }

            const closedQty = qty - remain;
            const shortOpenTax = remain > EPSILON ? calcSellTax(code, price, remain) : 0;
            payCost(fee + (closedQty > EPSILON ? calcSellTax(code, price, closedQty, dayTradeQty) : 0) + shortOpenTax);
            if (closedQty > EPSILON) {
                const closeFee = fee * (closedQty / qty);
                const tax = calcSellTax(code, price, closedQty, dayTradeQty);
                const realizedPnl = grossPnl - openFee - closeFee - tax;
                if (Math.abs(realizedPnl) > EPSILON) {
                    s.trades.push({ pnl: realizedPnl, closeTime: time, capitalUsed, tradeType: 'STOCK', fees: openFee + closeFee, tax, interest: 0 });
                }
            }

            if (remain > EPSILON) {
                // 開（加碼）現股空單：賣出當下的手續費與證交稅留到回補時攤入損益
                s.sc += price * remain;
                s.sq -= remain;
                s.sFee += fee * (remain / qty) + shortOpenTax;
            }
        }
    });
    applyDividendsUpTo(asOfDate);
    Object.values(stockMap).forEach(mergeDayBuys);
    return { stockMap, entryCosts, dividendEffects };
};

/**
 * 淨值引擎用的帳務脈絡（與 calculatePnlSummary 同一套規則）：
 *   tradeCost(entry)  該筆交易當下付出的費用；需依日期 → timeId 順序逐筆呼叫，同鍵多筆依序取用。
 *   dividendEffects   各除息日實際入帳的現金股利（空單為負）與配股股數，依日期升序。
 * options 同 runLedger（dividends、asOfDate）。
 */
export const createLedgerContext = (entries, options = {}) => {
    const { entryCosts, dividendEffects } = runLedger(entries, options);
    const queues = new Map();
    entryCosts.forEach(({ key, cost }) => {
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(cost);
    });
    const tradeCost = (e) => {
        const q = queues.get(tradeCostKey(e));
        return q && q.length ? q.shift() : 0;
    };
    return { tradeCost, dividendEffects };
};

/**
 * 今日若全部平倉的淨未實現損益：
 *   市值 − 持有成本（已扣股利）− 開倉時已付費用 − 預估平倉手續費與證交稅 − 融資應計利息。
 * row 為 calculatePnlSummary().byStock 的一列；asOfMs 為計息基準時間（預設現在）。
 */
export const calcUnrealizedPnl = (row, price, asOfMs = Date.now()) => {
    const p = Number(price);
    if (!row || !(p > 0)) return 0;
    const code = row.code;
    let pnl = 0;
    // 現股多單 / 空單
    const sq = row.stockQty || 0;
    if (sq > 0) {
        pnl += (p - row.stockAvgCost) * sq - (row.stockOpenFee || 0)
            - calcBrokerFee(p, sq) - calcSellTax(code, p, sq);
    } else if (sq < 0) {
        const q = -sq;
        pnl += (row.stockAvgCost - p) * q - (row.stockOpenFee || 0) - calcBrokerFee(p, q);
    }
    // 融資多單：逐批計算（成本、股利、已付手續費、應計利息）
    const lots = row.mlLots || [];
    if (lots.length > 0) {
        const mq = lots.reduce((t, l) => t + l.qty, 0);
        lots.forEach((lot) => {
            pnl += (p - lot.price + lot.div) * lot.qty - lot.fee - marginLotInterest(lot, lot.qty, asOfMs);
        });
        pnl -= calcBrokerFee(p, mq) + calcSellTax(code, p, mq);
    }
    // 融券空單
    const msq = row.msQty || 0;
    if (msq > 0) {
        pnl += (row.msAvgCost - p) * msq - (row.msOpenFee || 0) - calcBrokerFee(p, msq);
    }
    return pnl;
};

// ========== II. P&L 計算核心函數 ==========
/**
 * options: { filterStartTime?: number, filterEndTime?: number } 供自訂區間用；
 *          { dividends?, asOfDate? } 除權息事件（見 runLedger）
 */
export const calculatePnlSummary = (entries, filterRange = 'ALL', options = {}) => {
    if (!entries || entries.length === 0) {
        return {
            byStock: [],
            totalRealizedPnl: 0,
            winRate: 0,
            totalClosedTrades: 0,
            totalFees: 0,
            totalTax: 0,
            totalInterest: 0,
        };
    }

    const { stockMap } = runLedger(entries, options);

    // ---------- 時間篩選 ----------
    let filterStartTime = options.filterStartTime ?? null;
    const filterEndTime = options.filterEndTime ?? null;
    if (!filterStartTime && filterRange && filterRange !== 'ALL') {
        const startDateObj = getStartDate(filterRange);
        if (startDateObj) filterStartTime = startDateObj.getTime();
    }

    const byStock = [];
    let totalRealizedPnl = 0;
    let totalClosedTrades = 0;
    let winningTrades = 0;
    let totalFees = 0;
    let totalTax = 0;
    let totalInterest = 0;

    Object.keys(stockMap).forEach((code) => {
        const s = stockMap[code];
        const SMALL = 1e-6;

        // 個別池的持倉數量與均價
        const stockQty   = Math.round(s.sq);   // 現股（負 = 現股空單）
        const mlQty      = Math.round(s.mlq);  // 融資多頭
        const msQty      = Math.round(s.msq);  // 融券空頭

        const stockAvgCost  = Math.abs(s.sq)  > SMALL ? s.sc / Math.abs(s.sq)  : 0;
        const mlAvgCost     = s.mlq > SMALL ? s.mlc / s.mlq                    : 0;
        const mlAvgSelfPaid = s.mlq > SMALL ? s.mlSelfPaid / s.mlq             : 0;
        const msAvgCost     = s.msq > SMALL ? s.msc / s.msq                    : 0;
        const msAvgDeposit  = s.msq > SMALL ? s.msDeposit / s.msq              : 0;

        // 融資未結清借款金額（按成本估計）
        const mlLoanValue = mlQty * mlAvgCost * MARGIN_LONG_LOAN_RATIO;

        // 凈持倉（正 = 多頭，負 = 空頭）── 向後相容
        const netQuantity = stockQty + mlQty - msQty;

        // 混合平均成本（多頭加權平均，供向後相容的顯示）
        const totalLongQty = (s.sq > 0 ? s.sq : 0) + s.mlq;
        const totalLongCost = (s.sq > 0 ? s.sc : 0) + s.mlc;
        const avgCost = totalLongQty > SMALL ? totalLongCost / totalLongQty : 0;

        // 篩選期間內的已實現損益（淨額）
        let realizedInPeriod = 0;
        s.trades.forEach((t) => {
            const afterStart = !filterStartTime || t.closeTime >= filterStartTime;
            const beforeEnd  = !filterEndTime   || t.closeTime <= filterEndTime;
            if (afterStart && beforeEnd) {
                realizedInPeriod += t.pnl;
                totalRealizedPnl += t.pnl;
                totalFees += t.fees || 0;
                totalTax += t.tax || 0;
                totalInterest += t.interest || 0;
                if (t.pnl > 0) { winningTrades++; totalClosedTrades++; }
                else if (t.pnl < 0) { totalClosedTrades++; }
            }
        });

        byStock.push({
            code,
            name: s.name,
            // 向後相容欄位
            netQuantity,
            avgCost,
            realizedPnl: realizedInPeriod,
            // 現股池
            stockQty,
            stockAvgCost,    // 已扣除現金股利
            stockOpenFee: s.sFee, // 未平倉部位開倉時已付的費用
            // 融資池
            mlQty,
            mlAvgCost,
            mlAvgSelfPaid,   // 每股自付成本（= avgCost × 0.4）
            mlLoanValue,     // 未結清融資借款金額
            mlEarliestMs: s.mlEarliestMs,
            // 融券池
            msQty,
            msAvgCost,
            msAvgDeposit,    // 每股保證金
            msEarliestMs: s.msEarliestMs,
            msOpenFee: s.msFee,
            // 融資逐批明細（成本、已收股利、已付手續費、開倉時間），供未實現損益計算
            mlLots: s.mlLots.map((l) => ({ ...l })),
        });
    });

    const winRate = totalClosedTrades > 0
        ? (winningTrades / totalClosedTrades * 100).toFixed(2)
        : 0;

    return {
        byStock,
        totalRealizedPnl: Math.round(totalRealizedPnl),
        winRate,
        totalClosedTrades,
        // 期間內已攤入已實現損益的交易成本（皆已從 totalRealizedPnl 扣除）
        totalFees: Math.round(totalFees),
        totalTax: Math.round(totalTax),
        totalInterest: Math.round(totalInterest),
    };
};
