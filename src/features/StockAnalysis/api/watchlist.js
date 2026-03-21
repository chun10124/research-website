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
    const data = snapshot.docs.map((docSnap) => {
      const d = docSnap.data() || {};
      const id = docSnap.id;
      const codeRaw = d.code;
      const code =
        codeRaw != null && String(codeRaw).trim() !== ''
          ? String(codeRaw).trim()
          : id;
      // id 一律以 Firestore 文件 ID 為準，避免舊資料 body 內 id 覆蓋
      return { ...d, id, code };
    });
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
/** @param {string} docId Firestore 文件 ID（可為 UUID，與股票代碼分離） */
export const updateAnalysisField = async (docId, data) => {
    try {
        const ref = doc(STOCK_WATCHLIST_COLLECTION, docId);
        await setDoc(ref, {
            ...data,
            updatedAt: Date.now()
        }, { merge: true });
        console.log(`[${docId}] 更新成功`);
    } catch (error) {
        console.error(`❌ [${docId}] Firebase 寫入失敗:`, error.message);
        throw error;
    }
};