/* src/features/StockAnalysis/hooks/useStockData.js */
import { useState, useEffect, useCallback } from 'react';
// 🟢 修正導入：改用 fetchWatchlist 與 updateAnalysisField
import { fetchWatchlist, updateAnalysisField } from '../api/watchlist'; 
import { db } from '../../../utils/firebaseConfig'; 
import { doc } from 'firebase/firestore';

export const useStockData = () => {
    const [stocks, setStocks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [lastFetchedAt, setLastFetchedAt] = useState(null);

    // 🟢 封裝刷新邏輯（useCallback 確保 deps 穩定，避免 useEffect stale closure）
    const refresh = useCallback(async () => {
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
    }, []);

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

            // 只改本地這一檔：原本存檔後整表重讀（217 檔含完整歷史陣列，單檔 2330 就約 450 KB），
            // 改一個分類要等好幾秒。寫入已成功，本地狀態與資料庫一致。
            setStocks((prev) => prev.map((s) => (s.id === stockId ? { ...s, [field]: value } : s)));
            
            console.log(`✅ [${stockId}] 畫面已自動刷新`);
        } catch (error) {
            console.error("❌ 更新失敗:", error);
        }
    };

    return { stocks, loading, updateStockField, refreshData: refresh, lastFetchedAt };
};