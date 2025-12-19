/* src/features/StockAnalysis/api/watchlist.js */
// 🟢 修正導入：移除 onSnapshot，加入 getDocs
import { doc, setDoc, getDocs, query, orderBy } from "firebase/firestore";
import { STOCK_WATCHLIST_COLLECTION } from '../../../utils/firebaseConfig'; 

/**
 * 🔴 修改：從監聽改為單次抓取 (fetchWatchlist)
 * 解決 200 支股票的連線負擔與紅字報錯
 */
export const fetchWatchlist = async () => {
  const q = query(STOCK_WATCHLIST_COLLECTION, orderBy("category", "asc"));
  
  try {
    const snapshot = await getDocs(q); // 🟢 改用 getDocs (一次性請求)
    const data = snapshot.docs.map(doc => ({ 
        id: doc.id, 
        ...doc.data() 
    }));
    console.log(`[讀取] 成功從雲端獲取 ${data.length} 筆資料。`);
    return data;
  } catch (error) {
    console.error("❌ Firebase 讀取失敗:", error);
    return [];
  }
};

/**
 * 更新或新增股票分析資料
 */
export const updateAnalysisField = async (code, data) => {
    try {
        const ref = doc(STOCK_WATCHLIST_COLLECTION, code);
        await setDoc(ref, {
            ...data,
            updatedAt: Date.now()
        }, { merge: true });
        console.log(`[${code}] 更新成功`);
    } catch (error) {
        console.error(`❌ [${code}] Firebase 寫入失敗:`, error.message);
        throw error;
    }
};