/* src/features/StockAnalysis/hooks/useDataSync.js */
import { useEffect, useRef } from 'react';
import { fetchCompleteStockData } from '../api/stockApi';
import { updateAnalysisField } from '../api/watchlist';

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

      // 設定更新門檻：例如 1 小時 (3600000 毫秒)
      const UPDATE_THRESHOLD = 6 * 60 * 60 * 1000; 

      for (const stock of stocks) {
        try {
          const now = Date.now();
          const lastUpdate = stock.lastUpdate || 0;

          // 🔴 關鍵優化：檢查這檔股票是否真的需要更新
          // 如果一小時內更新過，就直接跳過，節省 API 配額與時間
          if (now - lastUpdate < UPDATE_THRESHOLD) {
            console.log(`⏩ [${stock.code}] ${stock.name} 最近已更新，跳過同步。`);
            continue;
          }

          console.log(`🔄 [${stock.code}] ${stock.name} 資料過期，開始同步...`);
          
          const latestData = await fetchCompleteStockData(stock.code, (msg) => {
            // 可選：將進度印在控制台方便除錯
            console.log(`   > ${msg}`);
          });

          if (latestData) {
            // 更新 Firebase
            await updateAnalysisField(stock.id, {
              ...latestData,
              // 保留使用者手動輸入的預估資料，避免被蓋掉
              estimatedEPS: stock.estimatedEPS || 0,
              targetPrice: stock.targetPrice || 0,
              notes: stock.notes || "",
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