/* src/features/StockAnalysis/hooks/useStockData.js */
import { useState, useEffect } from 'react';
// 🟢 修正導入：改用 fetchWatchlist 與 updateAnalysisField
import { fetchWatchlist, updateAnalysisField } from '../api/watchlist'; 
import { db } from '../../../utils/firebaseConfig'; 
import { doc } from 'firebase/firestore';

export const useStockData = () => {
    const [stocks, setStocks] = useState([]);
    const [loading, setLoading] = useState(true);
    
    // 🟢 封裝刷新邏輯
    const refresh = async () => {
        try {
            const data = await fetchWatchlist();
            // 🟢 直接賦值，不要先 setStocks([])
            // 只要我們傳入的是一個全新的陣列 [...data]，React 就會知道要重算 PE
            setStocks([...data]); 
            setLoading(false);
            console.log("✅ 數據已平滑同步");
            
            console.log("表格數據已成功強制同步");
        } catch (error) {
            console.error("刷新失敗:", error);
            setLoading(false);
        }
    };

    useEffect(() => {
        if (typeof window === 'undefined') return;
        // 🟢 初次進入頁面時抓取一次
        refresh();
    }, []); 
    
    /**
     * 核心功能：更新指定欄位
     * 🟢 修改：存檔後呼叫 refresh()，確保畫面與資料庫同步
     */
    const updateStockField = async (stockId, field, value) => {
        try {
            // 直接使用 api 裡的 updateAnalysisField 比較乾淨
            await updateAnalysisField(stockId, { [field]: value });
            
            // 🟢 自動同步：寫入成功後立刻重新抓取，不需要手動按更新
            await refresh(); 
            
            console.log(`✅ [${stockId}] 畫面已自動刷新`);
        } catch (error) {
            console.error("❌ 更新失敗:", error);
        }
    };

    // 額外導出 refresh，讓你有需要時可以手動刷新
    return { stocks, loading, updateStockField, refreshData: refresh };
};