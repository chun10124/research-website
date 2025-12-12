// ========== II. 時間篩選邏輯 ==========
export const getStartDate = (range) => {
    const now = new Date();
    let startDate = null;
    now.setHours(0, 0, 0, 0); 

    switch (range) {
        case 'WEEK':
            startDate = new Date(now.setDate(now.getDate() - now.getDay())); 
            break;
        case 'MONTH':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
        case 'HALFYEAR':
            startDate = new Date(now.setMonth(now.getMonth() - 6));
            break;
        case 'YEAR':
            startDate = new Date(now.setFullYear(now.getFullYear() - 1));
            break;
        case 'ALL':
        default:
            return null;
    }
    return startDate;
};

// ========== I. P&L 計算核心函數 ==========
export const calculatePnlSummary = (entries, filterRange = 'ALL') => {
    if (!entries || entries.length === 0) {
        return {
            byStock: [],
            totalRealizedPnl: 0,
            winRate: 0,
            totalClosedTrades: 0,
        };
    }

    const sortedEntries = [...entries].sort(
        (a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            const dateDiff = dateA - dateB;

            if (dateDiff !== 0) {
                return dateDiff; 
            }
            return (a.timeId || 0) - (b.timeId || 0); 
        }
    );

    const stockMap = {};
    const EPSILON = 1e-6; 

    sortedEntries.forEach((e) => {
        const code = e.code;
        if (!stockMap[code]) {
            stockMap[code] = {
                name: e.name,
                positionQty: 0,      
                positionCost: 0,     
                trades: [],          
            };
        }

        const s = stockMap[code];
        const qty = Number(e.quantity);
        const price = Number(e.price);
        const time = new Date(e.date).getTime();

        if (isNaN(qty) || qty <= EPSILON || isNaN(price) || price < 0.5) return;


        const closeTradeAndRecord = (closedQty, avgPrice, newPrice, isLong) => {
            let realizedPnl = 0;
            const nClosedQty = Number(closedQty);
            const nAvgPrice = Number(avgPrice);
            const nNewPrice = Number(newPrice);
            
            if (isLong) {
                realizedPnl = (nNewPrice * nClosedQty) - (nAvgPrice * nClosedQty);
            } else {
                realizedPnl = (nAvgPrice * nClosedQty) - (nNewPrice * nClosedQty);
            }

            if (Math.abs(realizedPnl) > EPSILON) {
                s.trades.push({ pnl: realizedPnl, closeTime: time });
            }
        };
        
        const isPositionZero = (qty) => Math.abs(qty) < EPSILON;
        const resetPosition = () => { s.positionQty = 0; s.positionCost = 0; }

        if (e.direction === 'BUY') {
            if (s.positionQty < 0) {
                const absShortQty = Math.abs(s.positionQty);
                const avgShortPrice = absShortQty > EPSILON ? Number(s.positionCost) / absShortQty : 0; 
                
                const closedQty = Math.min(qty, absShortQty); 
                const remainingQty = qty - closedQty; 

                if (closedQty > EPSILON) {
                    closeTradeAndRecord(closedQty, avgShortPrice, price, false); 
                    const costToReduce = avgShortPrice * closedQty;
                    s.positionCost = Number(s.positionCost) - costToReduce;
                    s.positionQty = Number(s.positionQty) + closedQty;
                }
                
                if (isPositionZero(s.positionQty) && remainingQty > EPSILON) {
                    s.positionQty = remainingQty;
                    s.positionCost = price * remainingQty;
                } else if (isPositionZero(s.positionQty)) {
                    resetPosition();
                }

            } else {
                s.positionCost = Number(s.positionCost) + (price * qty);
                s.positionQty = Number(s.positionQty) + qty;
            }
        }

        if (e.direction === 'SELL') {
            if (s.positionQty > 0) {
                const longQty = s.positionQty;
                const avgCost = longQty > EPSILON ? Number(s.positionCost) / longQty : 0;
                
                const closedQty = Math.min(qty, longQty);
                const remainingQty = qty - closedQty; 

                if (closedQty > EPSILON) {
                    closeTradeAndRecord(closedQty, avgCost, price, true); 
                    const costToReduce = avgCost * closedQty;
                    s.positionCost = Number(s.positionCost) - costToReduce; 
                    s.positionQty = Number(s.positionQty) - closedQty; 
                }
                
                if (isPositionZero(s.positionQty) && remainingQty > EPSILON) {
                    s.positionQty = -remainingQty;
                    s.positionCost = price * remainingQty;
                } else if (isPositionZero(s.positionQty)) {
                    resetPosition();
                }

            } else {
                s.positionCost = Number(s.positionCost) + (price * qty);
                s.positionQty = Number(s.positionQty) - qty;
            }
        }
    });

    let filterStartTime = null;
    if (filterRange && filterRange !== 'ALL') {
        const startDateObj = getStartDate(filterRange);
        if (startDateObj) filterStartTime = startDateObj.getTime();
    }

    const byStock = [];
    let totalRealizedPnl = 0;
    let totalClosedTrades = 0;
    let winningTrades = 0;

    Object.keys(stockMap).forEach((code) => {
        const s = stockMap[code];
        const netQuantity = s.positionQty;

        const absNetQuantity = Math.abs(netQuantity);
        const avgCost =
            absNetQuantity > EPSILON
                ? Number(s.positionCost) / absNetQuantity
                : 0;

        let realizedInPeriod = 0;

        s.trades.forEach((t) => {
            const inPeriod =
                !filterStartTime || t.closeTime >= filterStartTime;

            if (inPeriod) {
                realizedInPeriod += t.pnl;
                totalRealizedPnl += t.pnl;

                if (t.pnl > 0) {
                    winningTrades++;
                    totalClosedTrades++;
                } else if (t.pnl < 0) {
                    totalClosedTrades++;
                }
            }
        });

        byStock.push({
            code,
            name: s.name,
            netQuantity: Math.round(netQuantity), 
            avgCost,
            realizedPnl: realizedInPeriod,
        });
    });

    const winRate =
        totalClosedTrades > 0
            ? (winningTrades / totalClosedTrades * 100).toFixed(2)
            : 0;

    return {
        byStock,
        totalRealizedPnl: Math.round(totalRealizedPnl), 
        winRate,
        totalClosedTrades,
    };
};