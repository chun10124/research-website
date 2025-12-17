/* src/features/StockAnalysis/api/watchlist.js */

import { doc, setDoc, onSnapshot, query, orderBy } from "firebase/firestore";
// 確保從您的配置檔案中正確導入 STOCK_WATCHLIST_COLLECTION
import { STOCK_WATCHLIST_COLLECTION } from '../../../utils/firebaseConfig'; 

/**
 * 監聽股票觀察清單的變化 (用於表格即時更新)
 * @param {function} callback - 數據更新時回調的函式
 * @returns {function} 取消訂閱函式
 */
export const subscribeWatchlist = (callback) => {
  // 按 category 升序排列
  const q = query(STOCK_WATCHLIST_COLLECTION, orderBy("category", "asc"));
  
  return onSnapshot(q, (snapshot) => {
    try {
        const data = snapshot.docs.map(doc => ({ 
            id: doc.id, 
            ...doc.data() 
        }));
        // 將數據傳遞給 useStockData.js
        callback(data);
        console.log(`📡 [訂閱] 成功接收 ${data.length} 筆股票數據。`);

    } catch (error) {
        console.error("❌ Firebase 讀取 (onSnapshot) 數據處理失敗:", error);
        callback([]);
    }
  });
};

/**
 * 更新或新增股票分析資料 (用於 StockInputForm 和 API 同步)
 * @param {string} code - 股票代碼 (Document ID)
 * @param {object} data - 要更新的欄位數據
 */
export const updateAnalysisField = async (code, data) => {
    try {
        const ref = doc(STOCK_WATCHLIST_COLLECTION, code);
        await setDoc(ref, {
            ...data,
            updatedAt: Date.now()
        }, { merge: true });
        // 成功寫入後，會自動觸發上方的 subscribeWatchlist 讓表格更新
    } catch (error) {
        console.error(`❌ [${code}] Firebase 寫入失敗:`, error.message);
        throw error;
    }
};