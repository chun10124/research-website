/* src/features/StockAnalysis/hooks/useStockData.js */
import { useState, useEffect } from 'react';
// 🟢 修正導入：改用 fetchWatchlist 與 updateAnalysisField
import { fetchWatchlist, updateAnalysisField } from '../api/watchlist'; 
import { db } from '../../../utils/firebaseConfig'; 
import { doc } from 'firebase/firestore';

export const useStockData = () => {
    const [stocks, setStocks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [lastFetchedAt, setLastFetchedAt] = useState(null);

    // 🟢 封裝刷新邏輯
    const refresh = async () => {
        try {
            const data = await fetchWatchlist();
            setStocks([...data]);
            setLastFetchedAt(Date.now());
            setLoading(false);
            console.log("✅ 數據已平滑同步");
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

    return { stocks, loading, updateStockField, refreshData: refresh, lastFetchedAt };
};