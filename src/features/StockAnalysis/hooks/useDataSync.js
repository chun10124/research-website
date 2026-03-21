/* src/features/StockAnalysis/hooks/useDataSync.js */
import { useEffect, useRef } from 'react';
import { fetchCompleteStockData } from '../api/stockApi';
import { updateAnalysisField } from '../api/watchlist';
import { calculateSingleStockIndicators } from '../utils/analysisUtils';
/**
 * 智慧同步 Hook
 * 1. 解決重複啟動問題 (Ref Lock)
 * 2. 解決連線過於密集導致的報錯 (Staggered Delay)
 * 3. 解決效能消耗 (Time-based Check)
 */
export const useDataSync = (stocks) => {
  const isSyncing = useRef(false);

  useEffect(() => {
    // 防禦機制：如果正在同步、或根本沒股票，就直接退出
    if (stocks.length === 0 || isSyncing.current) return;

    const syncAll = async () => {
      console.log("🚀 [數據同步] 啟動智慧檢查...");
      isSyncing.current = true;

      // 設定更新門檻：例如 6 小時
      const UPDATE_THRESHOLD = 6 * 60 * 60 * 1000; 

      for (const stock of stocks) {
        try {
          const now = new Date();
          const lastUpdateTs = stock.lastUpdate || 0;
          const lastUpdateDate = new Date(lastUpdateTs);

          // 1. 基本檢查：超過 6 小時必過期
          let isExpired = (now.getTime() - lastUpdateTs) > UPDATE_THRESHOLD;

          // 2. 智慧檢查：是否跨越收盤點 (13:30)
          // 取得今天的收盤時間點 (13:45 設一點 buffer)
          const todayMarketClose = new Date();
          todayMarketClose.setHours(13, 45, 0, 0);

          // 如果現在已經過收盤了，且「最後更新」是在今天收盤之前，強制更新
          if (now > todayMarketClose && lastUpdateDate < todayMarketClose) {
            console.log(`📌 [${stock.code}] 跨越收盤節點，強制更新最新收盤價。`);
            isExpired = true;
          }

          // 如果沒過期，就跳過
          if (!isExpired) {
            console.log(`⏩ [${stock.code}] ${stock.name} 數據尚在效期內，跳過。`);
            continue;
          }

          console.log(`🔄 [${stock.code}] ${stock.name} 資料過期，開始同步...`);
          
          const latestData = await fetchCompleteStockData(stock.code, (msg) => {
            // 可選：將進度印在控制台方便除錯
            console.log(`   > ${msg}`);
          });

          if (latestData) {
            // 🔴 這裡一定要確保存入的是最新計算出的策略欄位
            const indicators = calculateSingleStockIndicators(latestData);

            await updateAnalysisField(stock.id, {
                ...latestData,
                id: stock.id,
                code: stock.code,
                // 確保這些新欄位被存入 Firebase
                foreignSignal: indicators.foreignSignal,
                foreignBCount: indicators.foreignBCount,
                zScore: indicators.zScore || 0,
                lastUpdate: Date.now()
            });
            console.log(`✅ [${stock.code}] 更新成功。`);
          }

          // 🔴 關鍵優化：增加稍微長一點的延遲 (2秒)
          // 這能解決私人隧道短時間內請求過多導致的 429 或 500 報錯
          await new Promise(r => setTimeout(r, 2000));

        } catch (e) {
          console.error(`❌ [${stock.code}] 同步過程中發生錯誤:`, e);
          // 遇到單一股票錯誤不中斷循環，繼續下一檔
          continue; 
        }
      }

      console.log("🏁 [數據同步] 本輪檢查結束。");
      isSyncing.current = false;
    };

    syncAll();
  }, [stocks.length]); // 僅在股票清單長度變動時觸發，避免頁面重刷就重跑
};