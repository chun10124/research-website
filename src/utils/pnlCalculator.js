// ========== 融資／融券常數 ==========
export const MARGIN_LONG_LOAN_RATIO = 0.6;      // 融資：借款六成
export const MARGIN_LONG_SELF_RATIO = 0.4;      // 融資：自付四成
export const MARGIN_LONG_ANNUAL_RATE = 0.0635;  // 融資年利率 6.35%
export const MARGIN_SHORT_DEPOSIT_RATIO = 0.9;  // 融券：保證金九成

// ========== II. 時間篩選邏輯 ==========
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

// ========== I. P&L 計算核心函數 ==========
/** options: { filterStartTime?: number, filterEndTime?: number } 供自訂區間用 */
export const calculatePnlSummary = (entries, filterRange = 'ALL', options = {}) => {
    if (!entries || entries.length === 0) {
        return {
            byStock: [],
            totalRealizedPnl: 0,
            winRate: 0,
            totalClosedTrades: 0,
        };
    }

    const sortedEntries = [...entries].sort((a, b) => {
        const dateDiff = new Date(a.date) - new Date(b.date);
        return dateDiff !== 0 ? dateDiff : (a.timeId || 0) - (b.timeId || 0);
    });

    const stockMap = {};
    const EPSILON = 1e-6;

    sortedEntries.forEach((e) => {
        const code = e.code;
        if (!stockMap[code]) {
            stockMap[code] = {
                name: e.name,
                // 現股池（sq 可為負，代表現股放空）
                sq: 0, sc: 0,
                // 融資多頭池（永遠 >= 0）
                mlq: 0, mlc: 0, mlSelfPaid: 0, mlEarliestMs: null,
                // 融券空頭池（永遠 >= 0，msq > 0 代表有未回補空單）
                msq: 0, msc: 0, msDeposit: 0, msEarliestMs: null,
                // 已實現交易記錄
                trades: [],
            };
        }

        const s = stockMap[code];
        const qty = Number(e.quantity);
        const price = Number(e.price);
        const time = new Date(e.date).getTime();
        const tradeType = e.tradeType || 'STOCK';

        if (isNaN(qty) || qty <= EPSILON || isNaN(price) || price < 0.5) return;

        const isPositionZero = (v) => Math.abs(v) < EPSILON;

        // ---------- 融資多頭 ----------
        if (tradeType === 'MARGIN_LONG') {
            if (e.direction === 'BUY') {
                // 開融資多頭
                s.mlq += qty;
                s.mlc += price * qty;
                s.mlSelfPaid += price * qty * MARGIN_LONG_SELF_RATIO;
                if (s.mlEarliestMs === null) s.mlEarliestMs = time;
            } else {
                // 融資賣出（平多）
                if (s.mlq > EPSILON) {
                    const avgFullCost = s.mlc / s.mlq;
                    const avgSelfPaid = s.mlSelfPaid / s.mlq;
                    const closedQty = Math.min(qty, s.mlq);
                    const realizedPnl = (price - avgFullCost) * closedQty;
                    const capitalUsed = avgSelfPaid * closedQty;
                    if (Math.abs(realizedPnl) > EPSILON) {
                        s.trades.push({ pnl: realizedPnl, closeTime: time, capitalUsed, tradeType: 'MARGIN_LONG' });
                    }
                    s.mlc -= avgFullCost * closedQty;
                    s.mlSelfPaid -= avgSelfPaid * closedQty;
                    s.mlq -= closedQty;
                    if (isPositionZero(s.mlq)) { s.mlq = 0; s.mlc = 0; s.mlSelfPaid = 0; s.mlEarliestMs = null; }
                }
                // 若超賣（mlq 不足），餘量轉入現股空單（罕見，保守處理）
            }
            return;
        }

        // ---------- 融券空頭 ----------
        if (tradeType === 'MARGIN_SHORT') {
            if (e.direction === 'SELL') {
                // 開融券空頭
                s.msq += qty;
                s.msc += price * qty;
                s.msDeposit += price * qty * MARGIN_SHORT_DEPOSIT_RATIO;
                if (s.msEarliestMs === null) s.msEarliestMs = time;
            } else {
                // 融券回補（平空）
                if (s.msq > EPSILON) {
                    const avgShortPrice = s.msc / s.msq;
                    const avgDeposit = s.msDeposit / s.msq;
                    const closedQty = Math.min(qty, s.msq);
                    const realizedPnl = (avgShortPrice - price) * closedQty;
                    const capitalUsed = avgDeposit * closedQty;
                    if (Math.abs(realizedPnl) > EPSILON) {
                        s.trades.push({ pnl: realizedPnl, closeTime: time, capitalUsed, tradeType: 'MARGIN_SHORT' });
                    }
                    s.msc -= avgShortPrice * closedQty;
                    s.msDeposit -= avgDeposit * closedQty;
                    s.msq -= closedQty;
                    if (isPositionZero(s.msq)) { s.msq = 0; s.msc = 0; s.msDeposit = 0; s.msEarliestMs = null; }
                }
            }
            return;
        }

        // ---------- 現股（含舊資料的預設行為） ----------
        if (e.direction === 'BUY') {
            if (s.sq < 0) {
                // 有現股空單，先平倉
                const absShortQty = Math.abs(s.sq);
                const avgShortPrice = absShortQty > EPSILON ? s.sc / absShortQty : 0;
                const closedQty = Math.min(qty, absShortQty);
                const remainingQty = qty - closedQty;

                if (closedQty > EPSILON) {
                    const realizedPnl = (avgShortPrice - price) * closedQty;
                    const capitalUsed = avgShortPrice * closedQty; // 現股空單用全額作資本
                    if (Math.abs(realizedPnl) > EPSILON) {
                        s.trades.push({ pnl: realizedPnl, closeTime: time, capitalUsed, tradeType: 'STOCK' });
                    }
                    s.sc -= avgShortPrice * closedQty;
                    s.sq += closedQty;
                }

                if (isPositionZero(s.sq) && remainingQty > EPSILON) {
                    s.sq = remainingQty;
                    s.sc = price * remainingQty;
                } else if (isPositionZero(s.sq)) {
                    s.sq = 0; s.sc = 0;
                }
            } else {
                s.sc += price * qty;
                s.sq += qty;
            }
        }

        if (e.direction === 'SELL') {
            if (s.sq > 0) {
                // 有現股多單，先平倉
                const longQty = s.sq;
                const avgCost = longQty > EPSILON ? s.sc / longQty : 0;
                const closedQty = Math.min(qty, longQty);
                const remainingQty = qty - closedQty;

                if (closedQty > EPSILON) {
                    const realizedPnl = (price - avgCost) * closedQty;
                    const capitalUsed = avgCost * closedQty;
                    if (Math.abs(realizedPnl) > EPSILON) {
                        s.trades.push({ pnl: realizedPnl, closeTime: time, capitalUsed, tradeType: 'STOCK' });
                    }
                    s.sc -= avgCost * closedQty;
                    s.sq -= closedQty;
                }

                if (isPositionZero(s.sq) && remainingQty > EPSILON) {
                    s.sq = -remainingQty;
                    s.sc = price * remainingQty;
                } else if (isPositionZero(s.sq)) {
                    s.sq = 0; s.sc = 0;
                }
            } else {
                // 直接開現股空單
                s.sc += price * qty;
                s.sq -= qty;
            }
        }
    });

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

        // 篩選期間內的已實現損益
        let realizedInPeriod = 0;
        s.trades.forEach((t) => {
            const afterStart = !filterStartTime || t.closeTime >= filterStartTime;
            const beforeEnd  = !filterEndTime   || t.closeTime <= filterEndTime;
            if (afterStart && beforeEnd) {
                realizedInPeriod += t.pnl;
                totalRealizedPnl += t.pnl;
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
            stockAvgCost,
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
    };
};
