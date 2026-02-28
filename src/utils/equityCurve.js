/**
 * 從交易日誌計算淨值曲線（時間序列）
 * 每個點 = 到該時點為止的「累計已實現損益」+「當時持倉成本」
 * 持倉成本法：不依賴即時市價，僅用交易紀錄即可畫出曲線
 */

const EPSILON = 1e-6;

export function buildEquityCurve(entries) {
  if (!entries || entries.length === 0) {
    return [];
  }

  const sorted = [...entries].sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    if (dateA !== dateB) return dateA - dateB;
    return (a.timeId || 0) - (b.timeId || 0);
  });

  const stockMap = {};
  let cumulativeRealized = 0;
  const curve = [];

  const closeTradeAndRecord = (closedQty, avgPrice, newPrice, isLong) => {
    const nClosedQty = Number(closedQty);
    const nAvgPrice = Number(avgPrice);
    const nNewPrice = Number(newPrice);
    if (isLong) {
      return (nNewPrice * nClosedQty) - (nAvgPrice * nClosedQty);
    }
    return (nAvgPrice * nClosedQty) - (nNewPrice * nClosedQty);
  };

  const getTotalPositionCost = () => {
    return Object.values(stockMap).reduce(
      (sum, s) => sum + (Math.abs(s.positionQty) > EPSILON ? Number(s.positionCost) : 0),
      0
    );
  };

  sorted.forEach((e) => {
    const code = e.code;
    if (!stockMap[code]) {
      stockMap[code] = {
        name: e.name,
        positionQty: 0,
        positionCost: 0,
      };
    }

    const s = stockMap[code];
    const qty = Number(e.quantity);
    const price = Number(e.price);
    const dateStr = e.date;

    if (isNaN(qty) || qty <= EPSILON || isNaN(price) || price < 0.5) return;

    const isPositionZero = (q) => Math.abs(q) < EPSILON;
    const resetPosition = () => {
      s.positionQty = 0;
      s.positionCost = 0;
    };

    if (e.direction === 'BUY') {
      if (s.positionQty < 0) {
        const absShortQty = Math.abs(s.positionQty);
        const avgShortPrice =
          absShortQty > EPSILON ? Number(s.positionCost) / absShortQty : 0;
        const closedQty = Math.min(qty, absShortQty);
        const remainingQty = qty - closedQty;

        if (closedQty > EPSILON) {
          cumulativeRealized += closeTradeAndRecord(
            closedQty,
            avgShortPrice,
            price,
            false
          );
          s.positionCost = Number(s.positionCost) - avgShortPrice * closedQty;
          s.positionQty = Number(s.positionQty) + closedQty;
        }

        if (isPositionZero(s.positionQty) && remainingQty > EPSILON) {
          s.positionQty = remainingQty;
          s.positionCost = price * remainingQty;
        } else if (isPositionZero(s.positionQty)) {
          resetPosition();
        }
      } else {
        s.positionCost = Number(s.positionCost) + price * qty;
        s.positionQty = Number(s.positionQty) + qty;
      }
    }

    if (e.direction === 'SELL') {
      if (s.positionQty > 0) {
        const longQty = s.positionQty;
        const avgCost =
          longQty > EPSILON ? Number(s.positionCost) / longQty : 0;
        const closedQty = Math.min(qty, longQty);
        const remainingQty = qty - closedQty;

        if (closedQty > EPSILON) {
          cumulativeRealized += closeTradeAndRecord(
            closedQty,
            avgCost,
            price,
            true
          );
          s.positionCost = Number(s.positionCost) - avgCost * closedQty;
          s.positionQty = Number(s.positionQty) - closedQty;
        }

        if (isPositionZero(s.positionQty) && remainingQty > EPSILON) {
          s.positionQty = -remainingQty;
          s.positionCost = price * remainingQty;
        } else if (isPositionZero(s.positionQty)) {
          resetPosition();
        }
      } else {
        s.positionCost = Number(s.positionCost) + price * qty;
        s.positionQty = Number(s.positionQty) - qty;
      }
    }

    const positionCost = getTotalPositionCost();
    const positions = Object.entries(stockMap)
      .filter(([, s]) => Math.abs(s.positionQty) > EPSILON)
      .map(([code, s]) => ({
        code,
        name: s.name,
        positionQty: s.positionQty,
        positionCost: s.positionCost,
        avgCost: Math.abs(s.positionQty) > EPSILON ? s.positionCost / Math.abs(s.positionQty) : 0,
      }));
    curve.push({
      date: dateStr,
      cumulativeRealized: Math.round(cumulativeRealized),
      positionCost: Math.round(positionCost),
      netWorth: Math.round(cumulativeRealized + positionCost),
      positions,
    });
  });

  return curve;
}
