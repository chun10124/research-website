/* src/pages/AnalysisPage.jsx */

import React, { useState, useEffect } from 'react';
import { setDoc, onSnapshot } from 'firebase/firestore';
import Layout from '@theme/Layout'; 
import { useStockData } from '../features/StockAnalysis/hooks/useStockData';
import { updateAnalysisField } from '../features/StockAnalysis/api/watchlist';
import IndustryAnalysisTable from '../features/StockAnalysis/components/IndustryAnalysisTable';
import BigColumnDragBoard from '../features/StockAnalysis/components/BigColumnDragBoard';
import { syncStockSnapshots } from '../features/StockAnalysis/api/stockApi';
import { ANALYSIS_LAYOUT_DOC_REF } from '../utils/firebaseConfig';
import {
    startAnalysisBackgroundSync,
    subscribeAnalysisSync,
    LAST_SYNC_ALL_KEY,
} from '../features/StockAnalysis/services/analysisSyncService';

const NUM_BIG_COLUMNS = 8;

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

const TAB_MAIN = 'main';
const TAB_CHIP = 'chip';

const AnalysisPage = () => {
    const [trackingTab, setTrackingTab] = useState(TAB_MAIN);
    const [testCode, setTestCode] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [syncingAll, setSyncingAll] = useState(false);
    const [syncAllProgress, setSyncAllProgress] = useState({ current: 0, total: 0 });
    const [lastSyncAllAt, setLastSyncAllAt] = useState(null);
    const [mounted, setMounted] = useState(false);
    const [bigColumnConfig, setBigColumnConfig] = useState({});
    const [columnLabels, setColumnLabels] = useState(Array(NUM_BIG_COLUMNS).fill(''));

    useEffect(() => {
        setMounted(true);
        try {
            const v = typeof window !== 'undefined' && window.localStorage.getItem(LAST_SYNC_ALL_KEY);
            if (v) setLastSyncAllAt(Number(v));
        } catch (_) {}
    }, []);

    useEffect(() => {
        const unsub = subscribeAnalysisSync((s) => {
            setSyncingAll(Boolean(s.running));
            const p = s.progress;
            if (p?.phase === 'done') {
                setLastSyncAllAt(Date.now());
            }
            if (p?.done != null && p?.total != null) {
                setSyncAllProgress({ current: p.done, total: p.total });
            }
            const processed = Number(p?.processed);
            if (
                p?.phase === 'fetch' &&
                Number.isFinite(processed) &&
                processed > 0 &&
                processed % 30 === 0
            ) {
                // 追蹤表非即時監聽：同步過程中定期刷新 UI，避免使用者誤以為卡住
                void refreshData().catch(() => {});
            }
        });
        return () => {
            unsub?.();
        };
    }, []);

    useEffect(() => {
        const unsub = onSnapshot(ANALYSIS_LAYOUT_DOC_REF, (snap) => {
            if (!snap.exists()) return;
            const d = snap.data();
            if (d.bigColumnConfig && typeof d.bigColumnConfig === 'object') setBigColumnConfig(d.bigColumnConfig);
            if (Array.isArray(d.columnLabels)) {
                const arr = [...d.columnLabels];
                while (arr.length < NUM_BIG_COLUMNS) arr.push('');
                setColumnLabels(arr.slice(0, NUM_BIG_COLUMNS));
            }
        }, (err) => console.error('分析版面 Firestore 監聽失敗:', err));
        return () => unsub();
    }, []);

    const { stocks, loading, refreshData, updateStockField, lastFetchedAt } = useStockData();

    const categoriesFromStocks = [...new Set((stocks || []).map(s => s.category || '未分類'))].sort();

    const saveBigColumnConfig = (next) => {
        setBigColumnConfig(next);
        setDoc(ANALYSIS_LAYOUT_DOC_REF, { bigColumnConfig: next }, { merge: true }).catch((e) => console.error('寫入版面設定失敗:', e));
    };
    const saveColumnLabel = (idx, val) => {
        const next = [...columnLabels];
        next[idx] = val;
        setColumnLabels(next);
        setDoc(ANALYSIS_LAYOUT_DOC_REF, { columnLabels: next }, { merge: true }).catch((e) => console.error('寫入欄位標籤失敗:', e));
    };
    const needReload = lastSyncAllAt != null && lastFetchedAt != null && lastSyncAllAt > lastFetchedAt;

    // 依 startAnalysisBackgroundSync 內的預設並發／延遲估算時間（粗略）
    const SYNC_CONCURRENCY = 3;

    const handleSyncAll = async () => {
        if (syncingAll || stocks.length === 0) return;
        // 追蹤表同步目標：確保切頁仍在背景跑；並在可接受限流風險下提升速度
        // 來源：fetchCompleteStockData 本身會做退避重試；外層只做節奏控流與並行度調整。
        const list = [...stocks];
        try {
            await startAnalysisBackgroundSync({
                stocks: list,
                concurrency: 3,
                delayMs: 1200,
                delayJitterMs: 500,
            });
        } catch (e) {
            console.error('[追蹤表同步] 啟動失敗:', e);
        }
    };

    const handleAddStock = async () => {
        const code = testCode.trim();
        if (!code) {
            setStatusMessage('請輸入股票代碼！');
            return;
        }

        setStatusMessage(`正在初始化 ${code}...`);
        try {
            const docId =
                typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                    ? crypto.randomUUID()
                    : `w_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            // 第一步：先在 Firebase 建立基礎文件 (讓格子先在畫面上跑出來)
            // docId 與 code 分離：同一檔股票可有多筆（不同產業／備註）
            const initialStockObj = {
                id: docId,
                code: code,
                name: `讀取中...`,
                category: '自選',
                lastUpdate: 0,
                history: { priceClose: [], foreignChipFlowNet: [], foreignTotalHolding: [], revenueRaw: [], revenueYoY: [] }
            };

            await updateAnalysisField(docId, initialStockObj);

            setStatusMessage(`正在從 API 抓取 ${code} 的詳細數據...`);
            await syncStockSnapshots(initialStockObj);

            await new Promise((r) => setTimeout(r, 400));
            await refreshData();
            setStatusMessage(`${code} 同步成功！`);
            setTestCode('');
        } catch (error) {
            console.error("同步失敗:", error);
            setStatusMessage(`失敗：${error.message}`);
        }
    };

    return (
        <Layout title="量化分析追蹤表">
            <main style={{ padding: '20px 0', overflowX: 'hidden' }}>
                <div style={{ padding: '0 0 0 20px', maxWidth: '1650px', margin: '0 auto' }}>

                    {/*  1. 表格 */}
                    <div style={{ 
                        overflowX: 'auto',
                        backgroundColor: '#fff', 
                        borderRadius: '8px',
                        boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
                        marginBottom: '30px',
                        marginLeft: '-18px',
                        marginTop: '-8px'
                    }}>
                        <IndustryAnalysisTable
                            stocks={stocks}
                            loading={loading}
                            updateStockField={updateStockField}
                            refreshData={refreshData}
                            columnsMode={trackingTab}
                            bigColumnConfig={bigColumnConfig}
                            columnLabels={columnLabels}
                            onColumnLabelChange={saveColumnLabel}
                        />
                    </div>

                    {/* 一般 / 籌碼 切換 */}
                    <div style={{ marginBottom: '16px', display: 'flex', gap: '4px' }}>
                        <button
                            type="button"
                            onClick={() => setTrackingTab(TAB_MAIN)}
                            style={{
                                padding: '6px 14px',
                                border: `2px solid ${trackingTab === TAB_MAIN ? '#25c2a0' : '#ddd'}`,
                                borderRadius: '8px',
                                background: trackingTab === TAB_MAIN ? '#25c2a0' : '#fff',
                                color: trackingTab === TAB_MAIN ? '#fff' : '#333',
                                fontWeight: 'bold',
                                cursor: 'pointer',
                                fontSize: '13px',
                            }}
                        >
                            一般
                        </button>
                        <button
                            type="button"
                            onClick={() => setTrackingTab(TAB_CHIP)}
                            style={{
                                padding: '6px 14px',
                                border: `2px solid ${trackingTab === TAB_CHIP ? '#25c2a0' : '#ddd'}`,
                                borderRadius: '8px',
                                background: trackingTab === TAB_CHIP ? '#25c2a0' : '#fff',
                                color: trackingTab === TAB_CHIP ? '#fff' : '#333',
                                fontWeight: 'bold',
                                cursor: 'pointer',
                                fontSize: '13px',
                            }}
                        >
                            籌碼
                        </button>
                    </div>

                    {/*  2. 輸入區 */}
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
                            <strong style={{ fontSize: '1.1em', color: '#333' }}>新增股票</strong>
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
                            * 輸入股票代碼後點擊同步，系統將自動從 API 獲取最新的股價、營收與籌碼數據。同一檔可重複新增，請在「設定產業」為各筆設定不同產業（例如同一檔放在多個產業觀察）。
                        </p>

                        <details style={{ marginTop: '12px' }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 'bold', color: '#555', fontSize: '12px' }}>設定產業</summary>
                            <div style={{ marginTop: '6px', padding: '8px', background: '#f8f9fa', borderRadius: '6px', border: '1px solid #eee', fontSize: '11px' }}>
                                {stocks.length === 0 ? (
                                    <p style={{ margin: 0, color: '#888' }}>尚無股票，請先新增。</p>
                                ) : (
                                    <ul style={{ margin: 0, paddingLeft: '12px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                        {stocks.map(s => (
                                            <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', listStyle: 'none', marginLeft: '-12px' }}>
                                                <span style={{ fontWeight: 'bold', minWidth: '42px' }}>{s.code || s.id}</span>
                                                <span style={{ minWidth: '70px', color: '#666' }}>{s.name}</span>
                                                <input
                                                    type="text"
                                                    defaultValue={s.category || ''}
                                                    onBlur={(e) => {
                                                        const v = e.target.value.trim() || null;
                                                        if (v !== (s.category || '')) updateStockField(s.id, 'category', v || '未分類');
                                                    }}
                                                    placeholder="產業"
                                                    style={{ padding: '2px 4px', width: '100px', border: '1px solid #ccc', borderRadius: '3px', fontSize: '11px' }}
                                                />
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </details>

                        <details style={{ marginTop: '12px' }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 'bold', color: '#555', fontSize: '12px' }}>大欄設定</summary>
                            <div style={{ marginTop: '8px', padding: '10px', background: '#f8f9fa', borderRadius: '6px', border: '1px solid #eee', fontSize: '11px' }}>
                                <BigColumnDragBoard
                                    categories={categoriesFromStocks}
                                    bigColumnConfig={bigColumnConfig}
                                    columnLabels={columnLabels}
                                    numColumns={NUM_BIG_COLUMNS}
                                    onCommit={saveBigColumnConfig}
                                />
                            </div>
                        </details>

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
                                {syncingAll ? `同步全部中（更新 ${syncAllProgress.current}/${syncAllProgress.total}）…` : '同步全部'}
                            </button>
                            {stocks.length > 0 && !syncingAll && (
                                <span style={{ fontSize: '0.9em', color: '#666' }}>
                                    共 {stocks.length} 檔，約需 {Math.ceil((stocks.length / SYNC_CONCURRENCY) * 3.5 / 60)} 分鐘
                                </span>
                            )}
                        </div>
                        <div style={{ marginTop: '24px', padding: '16px 20px', backgroundColor: '#f8f9fa', borderRadius: '8px', border: '1px solid #eee' }}>
                            <div style={{ fontSize: '0.85em', color: '#555', marginBottom: '8px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                                <span><strong>上一輪全體更新</strong> {mounted ? formatLastSync(lastSyncAllAt) : '—'}</span>
                                <span><strong>此頁資料載入</strong> {mounted && lastFetchedAt ? formatLastSync(lastFetchedAt) : '—'}</span>
                                {mounted && needReload && (
                                    <span style={{ color: '#c0392b', fontWeight: '500' }}>建議重新載入以顯示最新數據</span>
                                )}
                                {mounted && !needReload && lastFetchedAt != null && (
                                    <span style={{ color: '#27ae60' }}>表格資料已是最新</span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => refreshData()}
                                    disabled={loading}
                                    style={{ marginLeft: '4px', padding: '4px 10px', fontSize: '12px', cursor: loading ? 'wait' : 'pointer', border: '1px solid #ccc', borderRadius: '4px', background: '#fff' }}
                                >
                                    {loading ? '載入中…' : '重新載入'}
                                </button>
                            </div>
                            {mounted && stocks.length > 0 && (() => {
                                const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
                                const formatDate = (str) => str ? `${str.slice(0, 4)}/${Number(str.slice(5, 7))}/${Number(str.slice(8, 10))}` : '';
                                const revenueDates = stocks.map(s => s.latestRevenueDate).filter(Boolean);
                                const latestRevenueDateStr = revenueDates.length ? revenueDates.sort().slice(-1)[0] : null;
                                // 營收 API 常回傳「公告日」（如 2 月初），需轉成「資料所屬月」顯示：當月 1～15 日多為上月營收
                                const toRevenueMonth = (str) => {
                                    if (!str || str.length < 10) return null;
                                    const y = parseInt(str.slice(0, 4), 10);
                                    const m = parseInt(str.slice(5, 7), 10);
                                    const d = parseInt(str.slice(8, 10), 10);
                                    if (d <= 15 && m >= 2) return { y, m: m - 1 };
                                    if (d <= 15 && m === 1) return { y: y - 1, m: 12 };
                                    return { y, m };
                                };
                                const formatRevenueMonth = (str) => {
                                    const r = toRevenueMonth(str);
                                    return r ? `${r.y} 年 ${r.m} 月` : '';
                                };
                                const now = new Date();
                                const lastCompleteMonth = now.getMonth() === 0
                                    ? `${now.getFullYear() - 1}-12`
                                    : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;
                                const priceOk = stocks.filter(s => (s.latestPriceDate || '') === todayStr).length;
                                const holdingsOk = stocks.filter(s => (s.latestHoldingsDate || '') === todayStr).length;
                                const revenueOk = stocks.filter(s => {
                                    const parsed = toRevenueMonth(s.latestRevenueDate || '');
                                    const mStr = parsed ? `${parsed.y}-${String(parsed.m).padStart(2, '0')}` : '';
                                    return mStr === lastCompleteMonth;
                                }).length;
                                const total = stocks.length;
                                const overNine = (ok) => total > 0 && ok / total >= 0.9;
                                const hasPriceAll = overNine(priceOk);
                                const hasHoldingsAll = overNine(holdingsOk);
                                const hasRevenueAll = overNine(revenueOk);
                                const countStr = (n, t) => t > 0 ? `（${n}/${t}）` : '';
                                const fields = [
                                    { label: '股價', has: hasPriceAll, text: (f) => f.has ? `已有新數據（${formatDate(todayStr)}）${countStr(priceOk, total)}` : `尚未提供今日數據${countStr(priceOk, total)}` },
                                    { label: '外資持股（外資指標）', has: hasHoldingsAll, text: (f) => f.has ? `已有新數據（${formatDate(todayStr)}）${countStr(holdingsOk, total)}` : `尚未提供今日數據${countStr(holdingsOk, total)}` },
                                    { label: '營收', has: hasRevenueAll, text: () => latestRevenueDateStr ? `最新：${formatRevenueMonth(latestRevenueDateStr)}${countStr(revenueOk, total)}` : '尚無資料' },
                                ];
                                return (
                                    <div style={{ fontSize: '0.85em', color: '#555' }}>
                                        <strong style={{ display: 'block', marginBottom: '6px' }}>今日 API 資料狀態</strong>
                                        <ul style={{ margin: 0, paddingLeft: '20px', lineHeight: 1.6 }}>
                                            {fields.map(f => (
                                                <li key={f.label}>
                                                    <span style={{ color: f.has ? '#27ae60' : '#888' }}>{f.has ? '✓' : '－'}</span>
                                                    <span style={{ marginLeft: '6px' }}>{f.label}</span>
                                                    <span style={{ marginLeft: '6px', color: '#888', fontSize: '0.95em' }}>
                                                        {f.text(f)}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                );
                            })()}
                        </div>
                    </div>
                </div>
            </main>
        </Layout>
    );
};

export default AnalysisPage;