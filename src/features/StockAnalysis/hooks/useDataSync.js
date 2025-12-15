import { useEffect } from 'react';
import { fetchCompleteStockData } from '../api/stockApi';
import { updateAnalysisField } from '../api/watchlist';

/**
 * 自動同步 Hook：整合最新 API 資料並更新回 Firebase
 */
export const useDataSync = (stocks) => {
  useEffect(() => {
    // 判斷是否需要更新：若第一檔股票沒有更新時間，或距離上次更新超過 1 小時
    const needsUpdate = () => {
      if (stocks.length === 0) return false;
      const oneHour = 60 * 60 * 1000;
      const lastUpdate = stocks[0].lastUpdate || 0;
      return Date.now() - lastUpdate > oneHour;
    };

    if (stocks.length > 0 && needsUpdate()) {
      const syncAll = async () => {
        console.log("🚀 [數據同步] 開始批次更新全體股票資料...");
        
        for (const stock of stocks) {
          try {
            // 1. 呼叫我們寫好的最終版 API
            const latestData = await fetchCompleteStockData(stock.code, (msg) => console.log(msg));

            if (latestData) {
              // 2. 將 API 抓到的資料更新回 Firebase
              // 這裡會更新 currentPrice, history 陣列, 以及外資比例等
              await updateAnalysisField(stock.id, {
                ...latestData,
                // 保留原本的手動欄位，避免覆蓋
                eps: stock.eps || 0,
                targetPrice: stock.targetPrice || 0,
                memo: stock.memo || "",
                category: stock.category || "未分類"
              });
              
              console.log(`✅ ${stock.name} (${stock.code}) 更新成功`);
            }

            // 3. 節流機制：每抓一檔休息 1 秒，保護 API 額度與 Proxy 穩定
            await new Promise(resolve => setTimeout(resolve, 1000));
            
          } catch (error) {
            console.error(`❌ ${stock.code} 同步失敗:`, error);
          }
        }
        console.log("🏁 [數據同步] 全體更新完成");
      };

      syncAll();
    }
  }, [stocks.length]); // 僅在股票數量變動時重新評估 (或可加入 dependencies 手動觸發)
};