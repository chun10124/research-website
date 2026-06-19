/* src/pages/AnalysisPage.jsx */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { setDoc, onSnapshot, updateDoc, doc } from 'firebase/firestore';
import Layout from '@theme/Layout'; 
import { useStockData } from '../features/StockAnalysis/hooks/useStockData';
import { updateAnalysisField } from '../features/StockAnalysis/api/watchlist';
import IndustryAnalysisTable from '../features/StockAnalysis/components/IndustryAnalysisTable';
import BigColumnDragBoard from '../features/StockAnalysis/components/BigColumnDragBoard';
import { syncStockSnapshots, fetchForeignHoldingSeries } from '../features/StockAnalysis/api/stockApi';
import { calculateFlowSignal } from '../features/StockAnalysis/utils/analysisUtils';
import { ANALYSIS_LAYOUT_DOC_REF, SYNC_STATUS_DOC_REF, db } from '../utils/firebaseConfig';
import { useIbdRsData } from '../features/StockAnalysis/hooks/useIbdRsData';
import { useIbdRsWatchlist } from '../features/StockAnalysis/hooks/useIbdRsWatchlist';
import { RsChartModal } from './IBDRsRankingPage';
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
    const [syncingMode, setSyncingMode] = useState(null); // 'priceVolume' | 'holdingsRevenue' | null
    const [syncAllProgress, setSyncAllProgress] = useState({ current: 0, total: 0 });
    const [lastSyncAllAt, setLastSyncAllAt] = useState(null);
    const [mounted, setMounted] = useState(false);
    const [bigColumnConfig, setBigColumnConfig] = useState({});
    const [columnLabels, setColumnLabels] = useState(Array(NUM_BIG_COLUMNS).fill(''));
    const [selectedRsId, setSelectedRsId] = useState(null);
    const [openWithChipView, setOpenWithChipView] = useState(false);

    const { stocks, loading, refreshData, updateStockField, lastFetchedAt } = useStockData();
    const { stocks: rsRatings, loading: rsLoading } = useIbdRsData();
    const { idSet: rsWatchlistIdSet, priorities: rsWatchlistPriorities, toggle: toggleRsWatchlist, setPriority: setRsWatchlistPriority } = useIbdRsWatchlist();

    // ── 追蹤表籌碼懶載入 ──────────────────────────────────────────────
    // 初次載入完成後，對持股資料不足的股票自動背景補抓 FinMind，
    // 確保 calculateForeignForce (需 ≥710 筆) 能正常計算 B/N 訊號。
    const chipAutoFetchDoneRef = useRef(false);
    useEffect(() => {
        if (loading || stocks.length === 0) return;
        if (chipAutoFetchDoneRef.current) return; // 每次掛載只跑一次
        chipAutoFetchDoneRef.current = true;

        const HOLDING_MIN = 710; // calculateForeignForce 門檻
        const incomplete = stocks.filter((s) => {
            const h = s.history?.foreignTotalHolding;
            return !Array.isArray(h) || h.length < HOLDING_MIN;
        });
        if (incomplete.length === 0) return;

        console.log(`[追蹤表] ${incomplete.length} 支股票外資持股不足，背景補抓中…`);
        let cancelled = false;
        (async () => {
            let updated = 0;
            for (const stock of incomplete) {
                if (cancelled) break;
                const code = stock.code || stock.id;
                try {
                    const result = await fetchForeignHoldingSeries(code);
                    if (result?.holdings?.length > 100) {
                        const docRef = doc(db, 'stockWatchlist', stock.id);
                        const saveFields = {
                            'history.foreignTotalHolding': result.holdings,
                            latestHoldingsDate: result.latestDate ?? null,
                        };
                        if (Array.isArray(result.holdingDates) && result.holdingDates.length > 0) {
                            saveFields['history.foreignHoldingDates'] = result.holdingDates;
                        }
                        try {
                            await updateDoc(docRef, saveFields);
                        } catch (e) {
                            if (e?.code === 'not-found') {
                                // 文件不存在（新加的股票）→ setDoc 建立
                                await setDoc(docRef, {
                                    code,
                                    history: {
                                        foreignTotalHolding: result.holdings,
                                        ...(result.holdingDates?.length ? { foreignHoldingDates: result.holdingDates } : {}),
                                    },
                                    latestHoldingsDate: result.latestDate ?? null,
                                }, { merge: true });
                            }
                        }
                        updated++;
                        console.log(`[追蹤表] ${code} 籌碼補抓完成 (${result.holdings.length} 筆)`);
                    }
                } catch (e) {
                    console.warn(`[追蹤表] ${code} 籌碼補抓失敗:`, e?.message);
                }
                if (!cancelled) await new Promise((r) => setTimeout(r, 600)); // 限速，避免 API 過載
            }
            if (!cancelled && updated > 0) {
                console.log(`[追蹤表] 籌碼補抓完畢 (${updated}/${incomplete.length})，重新整理資料`);
                refreshData().catch(() => {});
            }
        })();

        return () => { cancelled = true; };
    }, [loading, stocks, refreshData]);
    // ─────────────────────────────────────────────────────────────────

    useEffect(() => {
        setMounted(true);
        try {
            const v = typeof window !== 'undefined' && window.localStorage.getItem(LAST_SYNC_ALL_KEY);
            if (v) setLastSyncAllAt(Number(v));
        } catch (_) {}
    }, []);

    useEffect(() => {
        const unsub = onSnapshot(
            SYNC_STATUS_DOC_REF,
            (snap) => {
                const data = snap.data();
                const sharedTs = Number(data?.analysisLastSyncAt);
                if (Number.isFinite(sharedTs) && sharedTs > 0) {
                    setLastSyncAllAt(sharedTs);
                    return;
                }
                try {
                    const v = typeof window !== 'undefined' && window.localStorage.getItem(LAST_SYNC_ALL_KEY);
                    if (v) setLastSyncAllAt(Number(v));
                } catch (_) {}
            },
            () => {
                try {
                    const v = typeof window !== 'undefined' && window.localStorage.getItem(LAST_SYNC_ALL_KEY);
                    if (v) setLastSyncAllAt(Number(v));
                } catch (_) {}
            }
        );
        return () => {
            unsub?.();
        };
    }, []);

    useEffect(() => {
        const unsub = subscribeAnalysisSync((s) => {
            setSyncingAll(Boolean(s.running));
            const p = s.progress;
            if (p?.phase === 'done') {
                setLastSyncAllAt(Date.now());
                // 同步完成後強制刷新一次，確保最後幾支股票的資料（含法人訊號）寫入 UI
                void refreshData().catch(() => {});
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
    }, [refreshData]);

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

    const rsById = useMemo(() => Object.fromEntries((rsRatings || []).map((s) => [s.id, s])), [rsRatings]);
    const navigationList = useMemo(() => {
        if (!Array.isArray(stocks) || stocks.length === 0) return [];

        // 複製表格的排序邏輯：依 bigColumnConfig 欄位/順序排，確保方向鍵順序與畫面一致
        const NUM_COLS = 8;
        const grouped = {};
        for (const s of stocks) {
            const cat = s.category || '未分類';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(s);
        }
        const categories = Object.keys(grouped).sort((a, b) => {
            if (a === '自選') return -1;
            if (b === '自選') return 1;
            return a.localeCompare(b, 'zh-TW');
        });
        const byCol = {};
        for (let c = 0; c < NUM_COLS; c++) byCol[c] = [];
        categories.forEach(cat => {
            const cfg = bigColumnConfig[cat] ?? { column: 0, order: 0 };
            const col = Math.max(0, Math.min(NUM_COLS - 1, Number(cfg.column) || 0));
            const order = Number(cfg.order) || 0;
            byCol[col].push({ cat, order, stocks: grouped[cat] });
        });

        const out = [];
        const seen = new Set();
        for (let c = 0; c < NUM_COLS; c++) {
            byCol[c].sort((a, b) => a.order - b.order);
            for (const { stocks: catStocks } of byCol[c]) {
                for (const a of catStocks) {
                    const key = a.code ?? a.id;
                    const rs = rsById[key];
                    if (rs && !seen.has(rs.id)) {
                        out.push(rs);
                        seen.add(rs.id);
                    }
                }
            }
        }
        return out;
    }, [stocks, rsById, bigColumnConfig]);

    const selectedStock = selectedRsId ? rsById[selectedRsId] : null;

    const openStockModal = (st) => {
        const key = st?.code ?? st?.id;
        if (!key) return;
        setOpenWithChipView(false);
        setSelectedRsId(String(key));
    };

    const handleFlowDotClick = (st) => {
        const key = st?.code ?? st?.id;
        if (!key) return;
        setOpenWithChipView(true);
        // 若 modal 已開著（prevStockId 非 null），先關閉再打開
        // 讓 RsChartModal 的 isNavigation 判斷為 false，確保以 initialView='foreign' 開啟
        setSelectedRsId(null);
        requestAnimationFrame(() => setSelectedRsId(String(key)));
    };

    // render 時同步計算，避免切換股票時閃現前一檔訊號
    const flowSignalNote = useMemo(() => {
        if (!selectedRsId) return null;
        const ws = stocks.find(s => String(s.code ?? s.id) === selectedRsId || String(s.id) === selectedRsId);
        if (!ws?.history?.instForeign?.length) return null;
        const flow = calculateFlowSignal(ws.history.instForeign, ws.history?.instTrust || []);
        const parts = [];
        if (flow.foreignFlowActive)           parts.push(`外資連買 ${flow.foreignFlowDays}日`);
        else if (flow.foreignFlowPersist > 0) parts.push(`外資消退中`);
        else if (flow.foreignFlowDays === 1)  parts.push(`外資今日大買`);
        if (flow.trustFlowActive)             parts.push(`投信連買 ${flow.trustFlowDays}日`);
        else if (flow.trustFlowPersist > 0)   parts.push(`投信消退中`);
        else if (flow.trustFlowDays === 1)    parts.push(`投信今日大買`);
        return parts.length > 0 ? parts.join(' / ') : null;
    }, [selectedRsId, stocks]);

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

    const handleSyncAll = async (syncMode = 'all') => {
        if (syncingAll || stocks.length === 0) return;
        setSyncingMode(syncMode);
        const list = [...stocks];
        try {
            await startAnalysisBackgroundSync({ stocks: list, syncMode });
        } catch (e) {
            console.error('[追蹤表同步] 啟動失敗:', e);
        } finally {
            setSyncingMode(null);
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
            const docId = code;
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
            <main style={{ padding: '8px 0 20px', overflowX: 'hidden' }}>
                <div style={{ padding: '0 0 0 20px', maxWidth: '1650px', margin: '0 auto' }}>

                    {/*  1. 表格 */}
                    <div className="ia-table-scroll" style={{
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
                            onStockNameClick={openStockModal}
                            onFlowDotClick={handleFlowDotClick}
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
                                        {[...stocks].sort((a, b) => {
                                            if ((a.category || '') === '自選') return -1;
                                            if ((b.category || '') === '自選') return 1;
                                            return (a.category || '').localeCompare(b.category || '', 'zh-TW');
                                        }).map(s => (
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

                        <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                onClick={() => handleSyncAll('priceVolume')}
                                disabled={loading || syncingAll || stocks.length === 0}
                                style={{
                                    padding: '10px 20px',
                                    cursor: syncingAll ? 'wait' : 'pointer',
                                    backgroundColor: syncingAll ? '#ccc' : '#25c2a0',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    fontWeight: 'bold',
                                    transition: 'opacity 0.2s',
                                }}
                            >
                                {syncingMode === 'priceVolume' ? `更新價量中（${syncAllProgress.current}/${syncAllProgress.total}）…` : '更新價量'}
                            </button>
                            <button
                                type="button"
                                onClick={() => handleSyncAll('holdingsRevenue')}
                                disabled={loading || syncingAll || stocks.length === 0}
                                style={{
                                    padding: '10px 20px',
                                    cursor: syncingAll ? 'wait' : 'pointer',
                                    backgroundColor: syncingAll ? '#ccc' : '#3498db',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    fontWeight: 'bold',
                                    transition: 'opacity 0.2s',
                                }}
                            >
                                {syncingMode === 'holdingsRevenue' ? `更新外資/營收中（${syncAllProgress.current}/${syncAllProgress.total}）…` : '更新外資/營收'}
                            </button>
                            {stocks.length > 0 && !syncingAll && (
                                <span style={{ fontSize: '0.85em', color: '#888' }}>
                                    {stocks.length} 檔
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
                                /** 股價／量能：以全表「價格資料日」眾數為準（曆日換日但尚未開盤時，昨收資料仍算最新，不會變成 0/n） */
                                const latestPriceDateStr = (() => {
                                    const freq = {};
                                    for (const s of stocks) {
                                        const d = s.latestPriceDate;
                                        if (d) freq[d] = (freq[d] || 0) + 1;
                                    }
                                    const entries = Object.entries(freq);
                                    if (!entries.length) return null;
                                    return entries.sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0][0];
                                })();
                                const priceOk = latestPriceDateStr
                                    ? stocks.filter((s) => (s.latestPriceDate || '') === latestPriceDateStr).length
                                    : 0;
                                /** 與股價同日線對齊；追蹤表 Yahoo/FinMind 價量同捆 */
                                const volumeOk = latestPriceDateStr
                                    ? stocks.filter(
                                          (s) =>
                                              (s.latestPriceDate || '') === latestPriceDateStr &&
                                              Array.isArray(s.history?.volume) &&
                                              s.history.volume.length > 0
                                      ).length
                                    : 0;
                                /** 持股：以全表最新持股日為準（與顯示日期一致） */
                                const latestHoldingsDateStr = (() => {
                                    const dates = stocks.map((s) => s.latestHoldingsDate).filter(Boolean);
                                    return dates.length ? dates.sort().at(-1) : null;
                                })();
                                const holdingsOk = latestHoldingsDateStr
                                    ? stocks.filter((s) => (s.latestHoldingsDate || '') === latestHoldingsDateStr).length
                                    : 0;
                                const revenueOk = stocks.filter(s => {
                                    const parsed = toRevenueMonth(s.latestRevenueDate || '');
                                    const mStr = parsed ? `${parsed.y}-${String(parsed.m).padStart(2, '0')}` : '';
                                    return mStr === lastCompleteMonth;
                                }).length;
                                /** 法人買賣超：以全表 latestInstDate（root 欄位）最新值為基準 */
                                const latestInstDateStr = (() => {
                                    const dates = stocks.map((s) => s.latestInstDate).filter(Boolean);
                                    return dates.length ? dates.sort().at(-1) : null;
                                })();
                                const instOk = latestInstDateStr
                                    ? stocks.filter((s) => s.latestInstDate === latestInstDateStr).length
                                    : 0;
                                const total = stocks.length;
                                const overNine = (ok) => total > 0 && ok / total >= 0.9;
                                const hasPriceAll = overNine(priceOk);
                                const hasVolumeAll = overNine(volumeOk);
                                const hasHoldingsAll = overNine(holdingsOk);
                                const hasRevenueAll = overNine(revenueOk);
                                const hasInstAll = overNine(instOk);
                                const countStr = (n, t) => t > 0 ? `（${n}/${t}）` : '';
                                const priceDataLabel = (n, t) =>
                                    latestPriceDateStr
                                        ? `${formatDate(latestPriceDateStr)}${countStr(n, t)}`
                                        : `尚無資料${countStr(n, t)}`;
                                const holdingsDataLabel = (n, t) =>
                                    latestHoldingsDateStr
                                        ? `${formatDate(latestHoldingsDateStr)}${countStr(n, t)}`
                                        : `尚無資料${countStr(n, t)}`;
                                const fields = [
                                    { label: '股價', has: hasPriceAll, text: () => priceDataLabel(priceOk, total) },
                                    { label: '量能', has: hasVolumeAll, text: () => priceDataLabel(volumeOk, total) },
                                    { label: '外資持股（外資指標）', has: hasHoldingsAll, text: () => holdingsDataLabel(holdingsOk, total) },
                                    { label: '法人買賣超', has: hasInstAll, text: () => latestInstDateStr ? `${formatDate(latestInstDateStr)}${countStr(instOk, total)}` : '尚無資料' },
                                    { label: '營收', has: hasRevenueAll, text: () => latestRevenueDateStr ? `最新：${formatRevenueMonth(latestRevenueDateStr)}${countStr(revenueOk, total)}` : '尚無資料' },
                                ];
                                return (
                                    <div style={{ fontSize: '0.85em', color: '#555' }}>
                                        <strong style={{ display: 'block', marginBottom: '6px' }}>API 資料狀態</strong>
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

            {selectedStock && navigationList.length > 0 && (
                <RsChartModal
                    stock={selectedStock}
                    navigationList={navigationList}
                    onNavigate={(st) => setSelectedRsId(st?.id ?? null)}
                    onClose={() => { setSelectedRsId(null); setOpenWithChipView(false); }}
                    inWatchlist={rsWatchlistIdSet.has(selectedStock.id)}
                    onToggleWatchlist={async (st) => { await toggleRsWatchlist(st.id); }}
                    watchlistPriority={rsWatchlistPriorities[selectedStock.id] ?? null}
                    onSetPriority={async (st, p) => { await setRsWatchlistPriority(st.id, p); }}
                    signalNote={flowSignalNote}
                    initialView={openWithChipView ? 'foreign' : 'rs'}
                />
            )}
        </Layout>
    );
};

export default AnalysisPage;