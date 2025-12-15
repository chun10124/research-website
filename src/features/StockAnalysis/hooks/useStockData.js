/* 負責把 Firebase 的數據拿出來，跑完運算後丟給 UI */

import { useState, useEffect } from 'react';
import { subscribeWatchlist } from '../api/watchlist';
import { calculateAllAcc, checkOwnershipAlert } from '../utils/math';

export const useStockData = () => {
  const [stocks, setStocks] = useState([]);

  useEffect(() => {
    const unsubscribe = subscribeWatchlist((data) => {
      // 在數據傳給組件前，先算好加速度與警示
      const processed = data.map(stock => ({
        ...stock,
        acc: calculateAllAcc(stock),
        isOwnershipAlert: checkOwnershipAlert(
          stock.currentForeignOwnership, 
          stock.lastMonthForeignOwnership
        ),
        // 計算 Forward PE
        forwardPE: stock.eps > 0 ? (stock.currentPrice / stock.eps).toFixed(1) : '-',
        // 計算潛在空間
        potential: stock.targetPrice > 0 
          ? (((stock.targetPrice - stock.currentPrice) / stock.currentPrice) * 100).toFixed(1) 
          : '-'
      }));
      setStocks(processed);
    });
    return () => unsubscribe();
  }, []);

  return stocks;
};