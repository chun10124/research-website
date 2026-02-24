/* src/pages/AnalysisPage.jsx */

import React, { useState, useEffect } from 'react';
import Layout from '@theme/Layout'; 
import { useStockData } from '../features/StockAnalysis/hooks/useStockData';
import { useDataSync } from '../features/StockAnalysis/hooks/useDataSync';
import { updateAnalysisField } from '../features/StockAnalysis/api/watchlist';
import IndustryAnalysisTable from '../features/StockAnalysis/components/IndustryAnalysisTable'; 
import { syncStockSnapshots } from '../features/StockAnalysis/api/stockApi';

const LAST_SYNC_ALL_KEY = 'research-website-lastSyncAllAt';

const formatLastSync = (ts) => {
    if (!ts || ts <= 0) return '尚未執行';
    const diff = Date.now() - ts;
    const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
    if (diff < min) return '剛剛';
    if (diff < hour) return `${Math.floor(diff / min)} 分鐘前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小時前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    if (diff < 30 * day) return `${Math.floor(diff / (7 * day))} 週前`;
    return new Date(ts).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', year: 'numeric' });
};

const AnalysisPage = () => {
    const [testCode, setTestCode] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [syncingAll, setSyncingAll] = useState(false);
    const [syncAllProgress, setSyncAllProgress] = useState({ current: 0, total: 0 });
    const [lastSyncAllAt, setLastSyncAllAt] = useState(null);

    const { stocks, loading, refreshData, updateStockField} = useStockData();

    useEffect(() => {
        try {
            const v = localStorage.getItem(LAST_SYNC_ALL_KEY);
            if (v) setLastSyncAllAt(Number(v));
        } catch (_) {}
    }, []);

    const handleSyncAll = async () => {
        if (syncingAll || stocks.length === 0) return;
        setSyncingAll(true);
        const total = stocks.length;
        for (let i = 0; i < total; i++) {
            setSyncAllProgress({ current: i + 1, total });
            try {
                await syncStockSnapshots(stocks[i]);
            } catch (e) {
                console.error(`[${stocks[i].code}] 同步失敗:`, e);
            }
            if (i < total - 1) await new Promise((r) => setTimeout(r, 2000));
        }
        setSyncAllProgress({ current: 0, total: 0 });
        await refreshData();
        const ts = Date.now();
        setLastSyncAllAt(ts);
        try { localStorage.setItem(LAST_SYNC_ALL_KEY, String(ts)); } catch (_) {}
        setSyncingAll(false);
    };

    useDataSync(stocks); 
    
    const handleAddStock = async () => {
        const code = testCode.trim();
        if (!code) {
            setStatusMessage('請輸入股票代碼！');
            return;
        }

        setStatusMessage(`正在初始化 ${code}...`);
        try {
            // 第一步：先在 Firebase 建立基礎文件 (讓格子先在畫面上跑出來)
            const initialStockObj = { 
                id: code, // 確保 ID 與代碼一致
                code: code,
                name: `讀取中...`,
                category: '自選',
                lastUpdate: 0, 
                history: { priceClose: [], foreignChipFlowNet: [], foreignTotalHolding: [], revenueRaw: [], revenueYoY: [] } 
            };
            
            await updateAnalysisField(code, initialStockObj);
            
            // 🟢 立刻刷一次畫面，讓使用者看到「讀取中」的格子
            await refreshData(); 

            setStatusMessage(`正在從 API 抓取 ${code} 的詳細數據...`);

            // 第二步：🟢 強制觸發單個股票的完整同步 (包含股價、籌碼、營收)
            // 這樣就不需要等 useDataSync 的 6 小時門檻
            await syncStockSnapshots(initialStockObj); 

            // 第三步：🟢 同步完成後，再拍一次照片，把數據填進格子
            await refreshData(); 

            setStatusMessage(`${code} 同步成功！`);
            setTestCode('');
        } catch (error) {
            console.error("同步失敗:", error);
            setStatusMessage(`失敗：${error.message}`);
        }
    };

    return (
        <Layout title="量化分析儀表板">
            <main style={{ padding: '20px 0' }}>
                <div style={{ padding: '0 20px', maxWidth: '1650px', margin: '0 auto' }}>

                    {/*  1. 表格 */}
                    <div style={{ 
                        overflowX: 'auto', 
                        backgroundColor: '#fff', 
                        borderRadius: '8px',
                        boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
                        marginBottom: '30px',
                        marginLeft: '-18px',
                        marginTop: '-25px'
                    }}>
                        <IndustryAnalysisTable stocks={stocks} loading={loading} updateStockField={updateStockField} refreshData={refreshData} />
                    </div>

                    {/*  2. 輸入區移到最下面 (並進行樣式優化) */}
                    <div style={{ 
                        borderTop: '2px solid #eee',
                        paddingTop: '25px',
                        marginTop: '10px'
                    }}>
                        <div style={{ 
                            backgroundColor: '#f8f9fa', 
                            padding: '15px 25px', 
                            borderRadius: '12px',
                            display: 'inline-flex', // 讓它跟內容一樣寬就好
                            alignItems: 'center',
                            gap: '15px'
                        }}>
                            <strong style={{ fontSize: '1.1em', color: '#333' }}>新增/更新股票</strong>
                            <input
                                type="text"
                                value={testCode}
                                onChange={(e) => setTestCode(e.target.value)}
                                placeholder="輸入股票代碼"
                                disabled={loading || syncingAll}
                                style={{ 
                                    padding: '8px 12px', 
                                    border: '1px solid #ccc',
                                    borderRadius: '6px',
                                    width: '140px',
                                    fontSize: '14px'
                                }}
                            />
                            <button 
                                onClick={handleAddStock} 
                                disabled={loading || syncingAll || !testCode}
                                style={{ 
                                    padding: '10px 20px', 
                                    cursor: 'pointer',
                                    backgroundColor: '#25c2a0',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    fontWeight: 'bold',
                                    transition: 'opacity 0.2s'
                                }}
                            >
                                {loading ? '載入中...' : '同步數據'}
                            </button>
                            
                            <span style={{ 
                                marginLeft: '10px',
                                color: statusMessage.startsWith('❌') ? '#e74c3c' : '#27ae60',
                                fontWeight: '500'
                            }}>
                                {statusMessage}
                            </span>
                        </div>
                        <p style={{ fontSize: '0.85em', color: '#888', marginTop: '10px', paddingLeft: '5px' }}>
                            * 輸入股票代碼後點擊同步，系統將自動從 API 獲取最新的股價、營收與籌碼數據。
                        </p>

                        <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <button
                                type="button"
                                onClick={handleSyncAll}
                                disabled={loading || syncingAll || stocks.length === 0}
                                style={{
                                    padding: '10px 20px',
                                    cursor: syncingAll ? 'wait' : 'pointer',
                                    backgroundColor: syncingAll ? '#ccc' : '#25c2a0',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    fontWeight: 'bold',
                                }}
                            >
                                {syncingAll ? `同步全部中 (${syncAllProgress.current}/${syncAllProgress.total})…` : '同步全部自選股'}
                            </button>
                            {stocks.length > 0 && !syncingAll && (
                                <span style={{ fontSize: '0.9em', color: '#666' }}>
                                    共 {stocks.length} 檔，約需 {Math.ceil(stocks.length * 2.5 / 60)} 分鐘
                                </span>
                            )}
                        </div>
                        <p style={{ fontSize: '0.9em', color: '#666', marginTop: '12px', paddingLeft: '5px' }}>
                            上一輪全體更新：{formatLastSync(lastSyncAllAt)}
                        </p>
                        {stocks.length > 0 && (() => {
                            const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
                            const hasPriceToday = stocks.some(s => (s.latestPriceDate || '') === todayStr);
                            const hasHoldingsToday = stocks.some(s => (s.latestHoldingsDate || '') === todayStr);
                            const hasRevenueToday = stocks.some(s => (s.latestRevenueDate || '') === todayStr);
                            const fields = [
                                { key: 'price', label: '股價', has: hasPriceToday },
                                { key: 'holdings', label: '外資持股（外資指標）', has: hasHoldingsToday },
                                { key: 'revenue', label: '營收', has: hasRevenueToday },
                            ];
                            const hasNew = fields.filter(f => f.has);
                            const notYet = fields.filter(f => !f.has);
                            return (
                                <p style={{ fontSize: '0.9em', color: '#666', marginTop: '8px', paddingLeft: '5px' }}>
                                    今日 API 已提供新數據的欄位：{hasNew.length ? hasNew.map(f => f.label).join('、') : '無'}
                                    {notYet.length > 0 && '　｜　今日 API 尚未提供新數據的欄位：' + notYet.map(f => f.label).join('、')}
                                </p>
                            );
                        })()}
                    </div>
                </div>
            </main>
        </Layout>
    );
};

export default AnalysisPage;