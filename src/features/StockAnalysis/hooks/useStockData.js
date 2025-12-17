/* src/features/StockAnalysis/hooks/useStockData.js */

import { useState, useEffect } from 'react';
// ⚠️ 確保路徑和函式名稱正確
import { subscribeWatchlist } from '../api/watchlist'; 
import { db } from '../../../utils/firebaseConfig'; 
import { doc, updateDoc } from 'firebase/firestore';
/**
 * Hook: 從 Firebase 實時獲取股票觀察清單數據
 * 確保這裡使用 const export
 */
export const useStockData = () => { // <--- 這裡必須是 export const
    const [stocks, setStocks] = useState([]);
    const [loading, setLoading] = useState(true);
    
    useEffect(() => {
        if (typeof window === 'undefined') {
            setLoading(false);
            return;
        }

        const unsubscribe = subscribeWatchlist((data) => {
            setStocks(data);
            setLoading(false);
        });

        return () => unsubscribe();
    }, []); 
    
    // 核心功能：更新指定欄位到 Firebase
    const updateStockField = async (stockId, field, value) => {
        try {
            // 修正：將 "stocks" 改為 "stockWatchlist"
            // 並確保 stockId 是字串（例如 "1101"）
            const stockRef = doc(db, "stockWatchlist", String(stockId)); 
            
            await updateDoc(stockRef, {
                [field]: value
            });
            
            console.log(`✅ [${stockId}] 更新成功`);
        } catch (error) {
            // 這裡如果印出 404 代表路徑還是錯的，請檢查 db 的初始化
            console.error("❌ Firebase 更新失敗:", error);
        }
    };

    return { stocks, loading, updateStockField };
};