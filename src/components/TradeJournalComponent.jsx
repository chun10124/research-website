import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { setDoc, onSnapshot } from 'firebase/firestore'; // 只需要 setDoc 和 onSnapshot
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer, Legend } from 'recharts';

// 1. 引入 Firebase 配置
import { JOURNAL_DOC_REF } from '../utils/firebaseConfig'; 

// 2. 引入格式化工具
import { PNL_COLOR, GOLDEN_BORDER_COLOR, formatQuantity, formatAvgCost, formatPnl } from '../utils/formatting';

// 3. 引入核心計算邏輯
import { calculatePnlSummary, getStartDate } from '../utils/pnlCalculator';
import { autoDetectCashFlows, getCumulativeCFUpTo } from '../utils/periodReturns';
import { fetchCurrentPrice } from '../features/StockAnalysis/api/stockApi';
import {
  buildJournalNameMismatchReport,
  fetchTaiwanStockListFromDb,
  getTaiwanStockDisplayName,
  invalidateTaiwanStockListFromDbCache,
  normalizeTaiwanStockCode,
} from '../features/StockAnalysis/api/rsStockList';

import styles from './TradeJournal.module.css';

// Local Storage Key (已不再使用，但保留定義)
// const LOCAL_STORAGE_KEY = 'tradeJournalData';


const PIE_STOCK_COLORS = ['#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#10b981', '#f97316', '#ec4899', '#6366f1', '#84cc16', '#14b8a6'];

// ========== III. 主組件 (TradeJournal) ==========
function TradeJournal() {
  const [journalEntries, setJournalEntries] = useState([]);
  const [formData, setFormData] = useState({
    id: '', 
    code: '',
    name: '', 
    direction: 'BUY',
    quantity: '',
    price: '',
    date: new Date().toISOString().substring(0, 10),
    reason: '',
  });
  const [editingId, setEditingId] = useState(null); 
  
  const [pnlFilterRange, setPnlFilterRange] = useState('ALL'); 
  const [historyFilterRange, setHistoryFilterRange] = useState('ALL'); 
  const [historyFilterStock, setHistoryFilterStock] = useState('');
  const [pnlFilterStock, setPnlFilterStock] = useState(''); // 新增：損益區搜尋狀態
  const [positionPrices, setPositionPrices] = useState({}); // code -> currentPrice，供未實現損益
  const [positionPricesLoading, setPositionPricesLoading] = useState(false);
  /** 四位數代碼：API 成功帶入名稱後鎖定；失敗或非四位數則允許手動輸入名稱 */
  const [allowManualName, setAllowManualName] = useState(false);
  const [stockNameLoading, setStockNameLoading] = useState(false);
  /** 歷史紀錄名稱 vs Firestore 股票清單比對結果 */
  const [nameDbCheck, setNameDbCheck] = useState({
    loading: false,
    error: null,
    noDbList: false,
    mismatches: [],
    notInDb: [],
    skippedNonFour: [],
  });
  const [nameDbCheckOpen, setNameDbCheckOpen] = useState(false);
  const [positionLevelDetailOpen, setPositionLevelDetailOpen] = useState(false);
  const [stockTableOpen, setStockTableOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 1. 數據加載與即時同步 (useEffect 區塊)
  useEffect(() => {
    const unsubscribe = onSnapshot(JOURNAL_DOC_REF, (docSnapshot) => {
        if (docSnapshot.exists()) {
            const cloudData = docSnapshot.data();
            const entries = cloudData.entries || []; 
            
            setJournalEntries(entries.sort((a, b) => (b.timeId || 0) - (a.timeId || 0)));
            console.log("數據已從 Firestore 加載並即時同步。");
            
        } else {
            console.log("Firestore 文件不存在，從空日誌開始。");
            setJournalEntries([]);
        }
    }, (error) => {
        console.error("Firestore 監聽失敗:", error);
    });

    return () => unsubscribe();
    
}, []);

  // 2. 數據儲存 (saveJournalToCloud 函數)
  const saveJournalToCloud = useCallback(async (entries) => {
    try {
        // 1. 先在本地更新 UI (確保響應快速)，複製再排序避免 mutate 傳入的陣列
        const sorted = [...entries].sort((a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            const dateDiff = dateB - dateA; 

            if (dateDiff !== 0) {
              return dateDiff; 
            }
            return (b.timeId || 0) - (a.timeId || 0); 
        });
        setJournalEntries(sorted);
        
        // 2. 存儲到 Firestore（merge 保留 cashFlows 等欄位）
        await setDoc(JOURNAL_DOC_REF, { entries: sorted }, { merge: true });
        
        console.log("數據已成功寫入 Firestore。");
        
    } catch (error) {
        console.error("寫入 Firestore 失敗:", error);
        alert("警告：數據寫入雲端失敗，請檢查網路連線。");
    }
  }, []);

  const emptyNameDbCheck = useCallback(
    () => ({
      loading: false,
      error: null,
      noDbList: false,
      mismatches: [],
      notInDb: [],
      skippedNonFour: [],
    }),
    []
  );

  /** 比對 Firestore 股票清單、更新面板；若有四位數代碼與資料庫不一致則寫回修正 */
  const syncJournalNamesWithDb = useCallback(
    async ({ forceRefresh = false, cancelledRef } = {}) => {
      const aborted = () => cancelledRef?.current;
      if (journalEntries.length === 0) {
        if (!aborted()) setNameDbCheck(emptyNameDbCheck());
        return;
      }
      if (forceRefresh) invalidateTaiwanStockListFromDbCache();
      if (!aborted()) setNameDbCheck((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const list = await fetchTaiwanStockListFromDb();
        if (aborted()) return;
        if (!list) {
          setNameDbCheck({
            loading: false,
            error: null,
            noDbList: true,
            mismatches: [],
            notInDb: [],
            skippedNonFour: [],
          });
          return;
        }
        const report = buildJournalNameMismatchReport(journalEntries, list);
        if (aborted()) return;
        setNameDbCheck({
          loading: false,
          error: null,
          noDbList: false,
          ...report,
        });

        const idToName = new Map(list.map((s) => [s.id, String(s.name || '').trim()]));
        const fixed = journalEntries.map((e) => {
          const code = normalizeTaiwanStockCode(e.code);
          if (!/^\d{4}$/.test(code)) return e;
          const apiName = idToName.get(code);
          if (!apiName) return e;
          if ((e.name || '').trim() === apiName) return e;
          return { ...e, name: apiName };
        });
        const changed = fixed.some((e, i) => e.name !== journalEntries[i].name);
        if (!changed || aborted()) return;
        await saveJournalToCloud(fixed);
      } catch (e) {
        console.warn('交易日誌：與上市櫃名稱同步失敗', e?.message);
        if (!aborted()) {
          setNameDbCheck((prev) => ({
            ...prev,
            loading: false,
            error: e?.message || String(e),
          }));
        }
      }
    },
    [journalEntries, saveJournalToCloud, emptyNameDbCheck]
  );

  // 2b. 載入／紀錄變更時：比對並自動修正名稱
  useEffect(() => {
    const cancelledRef = { current: false };
    syncJournalNamesWithDb({ forceRefresh: false, cancelledRef });
    return () => {
      cancelledRef.current = true;
    };
  }, [journalEntries, syncJournalNamesWithDb]);

  // 2c. 輸入代號後自動帶入名稱（四位數上市櫃／ETF）
  useEffect(() => {
    const raw = String(formData.code ?? '').trim();
    if (!raw) {
      setStockNameLoading(false);
      setAllowManualName(true);
      setFormData((prev) => {
        if (!prev.name) return prev;
        return { ...prev, name: '' };
      });
      return;
    }
    const code = normalizeTaiwanStockCode(formData.code);
    if (!/^\d{4}$/.test(code)) {
      setStockNameLoading(false);
      setAllowManualName(true);
      return;
    }
    setAllowManualName(false);
    setStockNameLoading(true);
    const t = setTimeout(async () => {
      try {
        const n = await getTaiwanStockDisplayName(code);
        setFormData((prev) => {
          if (normalizeTaiwanStockCode(prev.code) !== code) return prev;
          if (n) return { ...prev, name: n };
          return { ...prev, name: '' };
        });
        setAllowManualName(!n);
      } finally {
        setStockNameLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [formData.code]);

  // 3. 歷史記錄列表的過濾數據 (保持不變)
  const historyFilteredEntries = useMemo(() => {
    // 建立副本以進行排序，避免影響原始資料
    let filtered = [...journalEntries]; 

    // A. 依時間範圍過濾
    const startDate = getStartDate(historyFilterRange);
    if (startDate) {
        const startTime = startDate.getTime(); 
        filtered = filtered.filter(entry => {
            const entryDate = new Date(entry.date);
            return entryDate.getTime() >= startTime;
        });
    }
    
    // B. 依股票代號或名稱搜尋
    const searchTerm = historyFilterStock.trim().toLowerCase();
    if (searchTerm) {
        filtered = filtered.filter(entry => 
            entry.code.toLowerCase().includes(searchTerm) ||
            entry.name.toLowerCase().includes(searchTerm)
        );
    }

    // C. 核心修正：強制按照日期排序 (由新到舊)
    filtered.sort((a, b) => {
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        if (dateB - dateA !== 0) {
            return dateB - dateA; // 日期新的在前
        }
        // 如果日期相同，則按 timeId (存檔時間) 排序
        return (b.timeId || 0) - (a.timeId || 0); 
    });

    return filtered;
  }, [journalEntries, historyFilterRange, historyFilterStock]);


  // 4. P&L 摘要的計算核心 (保持不變)
  const pnlSummary = useMemo(
    () => calculatePnlSummary(journalEntries, pnlFilterRange),
    [journalEntries, pnlFilterRange]
  );

  // 持倉代碼（有淨部位者）用於拉現價
  const positionCodes = useMemo(
    () => [...new Set(pnlSummary.byStock.filter((s) => s.netQuantity !== 0).map((s) => s.code))],
    [pnlSummary.byStock]
  );

  useEffect(() => {
    if (positionCodes.length === 0) {
      setPositionPrices({});
      setPositionPricesLoading(false);
      return;
    }
    setPositionPricesLoading(true);
    Promise.all(positionCodes.map((code) => fetchCurrentPrice(code)))
      .then((results) => {
        const next = {};
        positionCodes.forEach((code, i) => {
          const res = results[i];
          if (res?.currentPrice != null) next[code] = res.currentPrice;
        });
        setPositionPrices(next);
      })
      .finally(() => setPositionPricesLoading(false));
  }, [positionCodes.join(',')]);

  // 總未實現損益（持倉 × (現價 - 成本)）
  const totalUnrealizedPnl = useMemo(() => {
    return pnlSummary.byStock.reduce((sum, s) => {
      if (s.netQuantity === 0) return sum;
      const price = positionPrices[s.code];
      if (price == null) return sum;
      return sum + (price - s.avgCost) * s.netQuantity;
    }, 0);
  }, [pnlSummary.byStock, positionPrices]);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const autoCashFlows = useMemo(() => autoDetectCashFlows(journalEntries), [journalEntries]);
  /** 交易明細自動識別之累計入金 */
  const totalDeposits = useMemo(
    () => getCumulativeCFUpTo(autoCashFlows, todayStr),
    [autoCashFlows, todayStr]
  );

  /** 全時段已實現損益（淨額） */
  const allTimePnlSummary = useMemo(
    () => calculatePnlSummary(journalEntries, 'ALL'),
    [journalEntries]
  );

  /** 總持倉市值：有現價用現價，否則用平均成本估算 */
  const totalHoldingMarketValue = useMemo(() => {
    return pnlSummary.byStock.reduce((sum, s) => {
      if (s.netQuantity === 0) return sum;
      const px = positionPrices[s.code];
      const usePx = px != null && px > 0 ? px : s.avgCost;
      return sum + Math.abs(s.netQuantity * usePx);
    }, 0);
  }, [pnlSummary.byStock, positionPrices]);

  /**
   * 可用於投資（買股）的總資產（與績效頁一致）：
   * 累計入金 + 已實現損益 + 未實現損益 ≈ 現金 + 持倉市值
   */
  const totalTradingAssets = useMemo(
    () =>
      totalDeposits +
      allTimePnlSummary.totalRealizedPnl +
      totalUnrealizedPnl,
    [totalDeposits, allTimePnlSummary.totalRealizedPnl, totalUnrealizedPnl]
  );

  /** 持倉水位：目前持倉市值 ÷ 上述總資產（持倉佔可投資資產比例） */
  const positionLevelPct =
    totalTradingAssets > 0
      ? (totalHoldingMarketValue / totalTradingAssets) * 100
      : null;

  /** 圓餅圖資料：各持倉市值 + 現金 */
  const portfolioPieData = useMemo(() => {
    const items = pnlSummary.byStock
      .filter(s => s.netQuantity > 0)
      .map(s => {
        const px = positionPrices[s.code];
        const usePx = px != null && px > 0 ? px : s.avgCost;
        return { name: `${s.name}(${s.code})`, value: Math.round(s.netQuantity * usePx) };
      })
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value);
    const cashValue = Math.round(totalTradingAssets - totalHoldingMarketValue);
    if (cashValue > 0) items.push({ name: '現金', value: cashValue, isCash: true });
    return items;
  }, [pnlSummary.byStock, positionPrices, totalTradingAssets, totalHoldingMarketValue]);

  const sortedByStock = useMemo(() => {
    const { byStock } = pnlSummary;
    const filtered = byStock.filter(item =>
      item.code.toLowerCase().includes(pnlFilterStock.toLowerCase()) ||
      item.name.toLowerCase().includes(pnlFilterStock.toLowerCase())
    );
    return [...filtered].sort((a, b) => {
      const tA = Math.abs(a.netQuantity * a.avgCost);
      const tB = Math.abs(b.netQuantity * b.avgCost);
      return tB !== tA ? tB - tA : a.code.localeCompare(b.code);
    });
  }, [pnlSummary, pnlFilterStock]);

  // 5. 表單處理 (保持不變)
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prevData => ({ ...prevData, [name]: value }));
  };

  const handleDirectionChange = (direction) => {
      setFormData(prevData => ({ ...prevData, direction }));
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    
    const quantity = Number(formData.quantity);
    const price = Number(formData.price);
    const codeNorm = normalizeTaiwanStockCode(formData.code);
    let nameToSave = (formData.name || '').trim();

    if (!codeNorm || quantity < 1 || price < 0.1) {
        alert("請填寫股票代號，並確保數量 >= 1 且價格 >= 0.1！");
        return;
    }

    if (!nameToSave && /^\d{4}$/.test(codeNorm)) {
      nameToSave = (await getTaiwanStockDisplayName(codeNorm)) || '';
    }
    if (!nameToSave) {
        alert("請填寫股票名稱，或確認四位數代號於上市櫃清單內可查得簡稱！");
        return;
    }

    const entryToSave = {
      ...formData,
      code: codeNorm,
      name: nameToSave,
      quantity: quantity,
      price: price,
    };

    let updatedEntries;
    if (editingId) {
      updatedEntries = journalEntries.map(entry => 
        entry.id === editingId ? { ...entryToSave, id: editingId } : entry
      );
      setEditingId(null);
    } else {
      const newEntry = { 
        ...entryToSave, 
        id: uuidv4(),
        timeId: Date.now() 
      };
      updatedEntries = [newEntry, ...journalEntries];
    }

    saveJournalToCloud(updatedEntries); // <<< 替換點 >>>
    
    setFormData({
      id: '',
      code: '',
      name: '',
      direction: 'BUY',
      quantity: '',
      price: '',
      date: new Date().toISOString().substring(0, 10),
      reason: '',
    });
  };
  
  // 6. 刪除與編輯功能 (保持不變)
  const handleDelete = (id) => {
      if (window.confirm("確定要刪除這筆交易記錄嗎？")) {
          const updatedEntries = journalEntries.filter(entry => entry.id !== id);
          saveJournalToCloud(updatedEntries); // <<< 替換點 >>>
      }
  };

  const handleEdit = (entry) => {
      setFormData({
          ...entry,
          quantity: String(entry.quantity),
          price: String(entry.price),
      });
      setEditingId(entry.id);
  };
  
  // 7. 渲染 P&L 摘要 (保持不變)
 const renderPnlSummary = () => {
    const { byStock, totalRealizedPnl } = pnlSummary;

    // 圓餅圖標籤渲染（定義在 render 函數內，避免 recharts 時序問題）
    const RADIAN = Math.PI / 180;
    const pieTotalValue = portfolioPieData.reduce((s, d) => s + d.value, 0);
    const renderPieLabel = ({ cx, cy, midAngle, outerRadius, percent, name, index }) => {
      if (percent < 0.04) return null; // 太小的切片不顯示標籤
      const labelOffset = isMobile ? 20 : 28;
      const radius = outerRadius + labelOffset;
      const x = cx + radius * Math.cos(-midAngle * RADIAN);
      const y = cy + radius * Math.sin(-midAngle * RADIAN);
      const fullName = name.replace(/\(.*\)$/, '').trim();
      const shortName = isMobile && fullName.length > 4 ? fullName.slice(0, 4) : fullName;
      const color = portfolioPieData[index]?.isCash ? '#64748b' : PIE_STOCK_COLORS[index % PIE_STOCK_COLORS.length];
      return (
        <text x={x} y={y} textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central"
          fontSize={isMobile ? 10 : 12} fill={color} fontWeight="600">
          {shortName} {(percent * 100).toFixed(1)}%
        </text>
      );
    };

    const pnlColorStyle = { color: PNL_COLOR(totalRealizedPnl), fontWeight: 'bold' };
    const unrealizedColorStyle = { color: PNL_COLOR(totalUnrealizedPnl), fontWeight: 'bold' };
    const period = pnlFilterRange === 'ALL' ? '全部記錄' : '篩選期間';

    return (
      <div style={{ marginTop: '15px', marginBottom: '15px', border: `1px solid ${GOLDEN_BORDER_COLOR}`, borderRadius: '5px', padding: '15px' }}>
        <div className={styles.pnlHeaderRow} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ marginRight: '20px' }}>追蹤表與損益摘要 ({period})</h3>
            
            {/*  3. 加入搜尋框與下拉選單 */}
            <div className={styles.pnlSelectContainer} style={{ display: 'flex', gap: '10px' }}>
                <input
                    type="text"
                    placeholder="搜尋股票代號/名稱"
                    value={pnlFilterStock}
                    onChange={(e) => setPnlFilterStock(e.target.value)}
                    className={styles.pnlSearchInput}
                />
                <select 
                    value={pnlFilterRange} 
                    onChange={(e) => setPnlFilterRange(e.target.value)}
                    style={{ padding: '8px', border: '1px solid #eee', backgroundColor: 'transparent', color: 'inherit' }}
                >
                    <option value="ALL">全部</option>
                    <option value="WEEK">當週</option>
                    <option value="MONTH">當月</option>
                    <option value="QUARTER">近一季</option>
                    <option value="HALFYEAR">近半年</option>
                    <option value="YEAR">近一年</option>
                </select>
            </div>
        </div>
        
        {/* 摘要卡片 */}
        <div
          className={styles.responsiveFlexRow}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '15px',
            marginBottom: '15px',
          }}
        >
            <div className={styles.pnlSummaryCard} style={{ flex: '1 1 160px', minWidth: '140px', padding: '12px', border: '1px solid #ccc', borderRadius: '5px'}}> 
                <h4 style={{ margin: '0 0 5px 0' }}>總已實現損益</h4>
                <p style={{ margin: 0, fontSize: '1.5em', ...pnlColorStyle }}>
                    {formatPnl(totalRealizedPnl)}
                </p>
            </div>
            <div className={styles.pnlSummaryCard} style={{ flex: '1 1 160px', minWidth: '140px', padding: '15px', border: '1px solid #ccc', borderRadius: '5px'}}> 
                <h4 style={{ margin: '0 0 5px 0' }}>未實現損益</h4>
                <p style={{ margin: 0, fontSize: '1.5em', ...(positionPricesLoading ? {} : unrealizedColorStyle) }}>
                    {positionPricesLoading ? '—' : formatPnl(Math.round(totalUnrealizedPnl))}
                </p>
            </div>
            <div className={styles.pnlSummaryCard} style={{ flex: '1 1 160px', minWidth: '140px', padding: '15px', border: '1px solid #ccc', borderRadius: '5px'}}> 
                <h4 style={{ margin: '0 0 5px 0', fontSize: '0.95rem' }}>總持倉金額</h4>
                <p style={{ margin: 0, fontSize: '1.5em', fontWeight: 'bold' }}>
                    {Math.round(totalHoldingMarketValue).toLocaleString()}
                </p>
            </div>
            <div
              className={styles.pnlSummaryCard}
              style={{
                flex: positionLevelDetailOpen ? '1 1 100%' : '1 1 160px',
                minWidth: '140px',
                padding: '15px',
                border: '1px solid #ccc',
                borderRadius: '5px',
              }}
            >
              <button
                type="button"
                onClick={() => setPositionLevelDetailOpen((o) => !o)}
                aria-expanded={positionLevelDetailOpen}
                aria-label={positionLevelDetailOpen ? '收合持倉水位細項' : '展開持倉水位細項'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  width: '100%',
                  margin: '0 0 5px 0',
                  padding: 0,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: 'inherit',
                  textAlign: 'left',
                }}
              >
                <span style={{ margin: 0, fontSize: '0.95rem', fontWeight: 'bold' }}>持倉水位</span>
                <span style={{ fontSize: '0.65rem', color: '#94a3b8', flexShrink: 0 }}>
                  {positionLevelDetailOpen ? '▼' : '▶'}
                </span>
              </button>
              <p style={{ margin: 0, fontSize: '1.5em', fontWeight: 'bold' }}>
                {positionLevelPct != null ? `${positionLevelPct.toFixed(1)}%` : '—'}
              </p>
              {positionLevelDetailOpen && (
                <div
                  style={{
                    marginTop: '12px',
                    paddingTop: '12px',
                    borderTop: '1px solid #e2e8f0',
                    fontSize: '0.82rem',
                    lineHeight: 1.65,
                    color: '#334155',
                  }}
                >
                  <p style={{ margin: '0 0 8px 0', fontWeight: 'bold', color: '#0f172a' }}>分母 · 總可投資資產</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px', alignItems: 'baseline' }}>
                    <span>累計入金（自動識別）</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {Math.round(totalDeposits).toLocaleString()}
                    </span>
                    <span>已實現損益（全時段）</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: PNL_COLOR(allTimePnlSummary.totalRealizedPnl) }}>
                      {formatPnl(allTimePnlSummary.totalRealizedPnl)}
                    </span>
                    <span>未實現損益</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: positionPricesLoading ? '#94a3b8' : PNL_COLOR(totalUnrealizedPnl) }}>
                      {positionPricesLoading ? '—' : formatPnl(Math.round(totalUnrealizedPnl))}
                    </span>
                    <span style={{ fontWeight: 'bold', paddingTop: '6px', borderTop: '1px dashed #cbd5e1' }}>合計（分母）</span>
                    <span style={{ textAlign: 'right', fontWeight: 'bold', paddingTop: '6px', borderTop: '1px dashed #cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                      {Math.round(totalTradingAssets).toLocaleString()}
                    </span>
                  </div>
                  <p style={{ margin: '12px 0 8px 0', fontWeight: 'bold', color: '#0f172a' }}>分子 · 持倉市值</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px' }}>
                    <span>目前持倉市值加總</span>
                    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 'bold' }}>
                      {Math.round(totalHoldingMarketValue).toLocaleString()}
                    </span>
                  </div>
                  <p style={{ margin: '10px 0 0 0', fontSize: '0.78rem', color: '#64748b' }}>
                    水位 % ＝ 持倉市值 ÷ 總可投資資產；入金為交易明細推估，未實現需現價。
                  </p>
                </div>
              )}
            </div>
        </div>

        {/* 持倉圓餅圖 */}
        {portfolioPieData.length > 0 && (
          <div style={{ marginTop: '20px', marginBottom: '10px' }}>
            <h4 style={{ marginBottom: '4px' }}>持倉分佈</h4>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <div style={isMobile ? { width: '100%', height: 200 } : { flex: '0 0 440px', height: 230 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={portfolioPieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={isMobile ? 40 : 52}
                        outerRadius={isMobile ? 65 : 82}
                        paddingAngle={2}
                        dataKey="value"
                        isAnimationActive={false}
                        label={renderPieLabel}
                        labelLine={{ stroke: '#94a3b8', strokeWidth: 1 }}
                      >
                        {portfolioPieData.map((entry, index) => (
                          <Cell
                            key={entry.name}
                            fill={entry.isCash ? '#64748b' : PIE_STOCK_COLORS[index % PIE_STOCK_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <RechartsTooltip
                        formatter={(value, name) => {
                          const pct = pieTotalValue > 0 ? ((value / pieTotalValue) * 100).toFixed(1) : '0.0';
                          return [`${value.toLocaleString()} (${pct}%)`, name];
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        )}

      </div>

    );
  };

  const renderStockTableCard = () => (
    <div
      style={{
        marginTop: '15px',
        marginBottom: '15px',
        border: `1px solid ${GOLDEN_BORDER_COLOR}`,
        borderRadius: '5px',
        padding: '12px 15px',
      }}
    >
      <button
        type="button"
        onClick={() => setStockTableOpen(o => !o)}
        aria-expanded={stockTableOpen}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          width: '100%', padding: 0, border: 'none', background: 'none',
          cursor: 'pointer', color: 'inherit', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '0.7rem', color: '#64748b', width: '1em', flexShrink: 0 }}>
          {stockTableOpen ? '▼' : '▶'}
        </span>
        <h3 style={{ margin: 0, fontSize: '1.1rem' }}>個股損益與持倉 (按持倉金額排序)</h3>
      </button>
      {stockTableOpen && (
        <div style={{ overflowX: 'auto', marginTop: '12px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem', minWidth: '400px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #333' }}>
                <th style={{ padding: '8px' }}>股票名稱/代號</th>
                <th style={{ padding: '8px' }}>平均成本</th>
                <th style={{ padding: '8px' }}>持倉金額</th>
                <th style={{ padding: '8px' }}>已實現損益</th>
              </tr>
            </thead>
            <tbody>
              {sortedByStock.length === 0 ? (
                <tr><td colSpan="4" style={{ padding: '10px', textAlign: 'center' }}>無匹配數據</td></tr>
              ) : (
                sortedByStock.map(data => {
                  const avgCostDisplay = data.netQuantity !== 0 ? data.avgCost : 0;
                  const positionAmount = Math.round(data.netQuantity * data.avgCost);
                  return (
                    <tr key={data.code} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '8px', fontWeight: 'bold' }}>{data.name} ({data.code})</td>
                      <td style={{ padding: '8px' }}>{formatAvgCost(avgCostDisplay)}</td>
                      <td className={styles.pnlAmountCell} style={{ padding: '8px', fontWeight: 'bold' }}>
                        {positionAmount !== 0 ? `${Math.abs(positionAmount).toLocaleString()}` : '--'}
                      </td>
                      <td style={{ padding: '8px', color: PNL_COLOR(data.realizedPnl) }}>
                        {formatPnl(data.realizedPnl)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // 8. 渲染歷史記錄列表 (保持不變)
  const renderHistory = () => {
    const entriesToRender = historyFilteredEntries;
    const PAGE_SIZE = 15;
    const totalPages = Math.max(1, Math.ceil(entriesToRender.length / PAGE_SIZE));
    const safePage = Math.min(historyPage, totalPages - 1);
    const pageEntries = entriesToRender.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

    const BUTTON_STYLE = {
        padding: '5px 10px', 
        backgroundColor: 'white', 
        color: 'var(--ifm-color-primary)',
        border: '1px solid var(--ifm-color-primary)', 
        cursor: 'pointer', 
        borderRadius: '3px'
    };
    const DELETE_STYLE = { 
        ...BUTTON_STYLE, 
        color: 'red', 
        borderColor: 'red', 
    };
    const EDIT_STYLE = {
        ...BUTTON_STYLE,
        color:'orange',
        borderColor:'orange'
    };
    
    return (
    <div style={{ 
        marginTop: '15px',
        marginBottom: '15px',
        border: `1px solid ${GOLDEN_BORDER_COLOR}`,
        borderRadius: '5px',
        padding: '15px',
        /* 核心組合拳：強制撐開且不准收縮 */
        width: '100%',
        minWidth: '100%', 
        flex: '1 0 auto', 
        boxSizing: 'border-box',
        minHeight: '450px'  //加入最小高度，防止沒資料時下方內容直接衝上來
    }}>
            
            <div className={styles.responsiveFilterRow} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3 style={{ minWidth: '220px', margin: 0 }}>歷史交易記錄 ({entriesToRender.length} 筆)</h3>
                <div className={styles.responsiveFilterRowControls} style={{ display: 'flex', gap: '10px' }}>
                    {/* 搜尋輸入框 */}
                    <input
                        type="text"
                        placeholder="搜尋股票代號/名稱"
                        value={historyFilterStock}
                        onChange={(e) => { setHistoryFilterStock(e.target.value); setHistoryPage(0); }}
                        className={styles.pnlSearchInput}
                    />

                    {/* 時間篩選器 */}
                    <select 
                        value={historyFilterRange} 
                        onChange={(e) => { setHistoryFilterRange(e.target.value); setHistoryPage(0); }}
                        style={{ padding: '8px', border: '1px solid #ccc' }}
                    >
                        <option value="ALL">全部時間</option>
                        <option value="WEEK">當週</option>
                        <option value="MONTH">當月</option>
                        <option value="QUARTER">近一季</option>
                        <option value="HALFYEAR">近半年</option>
                        <option value="YEAR">近一年</option>
                    </select>
                </div>
            </div>

            {entriesToRender.length === 0 ? (
            <div style={{ 
                display: 'flex', 
                justifyContent: 'center', 
                alignItems: 'center', 
                width: '100%', 
                padding: '80px 0',
                flex: '1 1 100%' // 🚀 告訴瀏覽器：佔滿剩餘寬度，但不准超過父容器
            }}>
            <p style={{ margin: 0, color: '#888', fontSize: '1.1rem' }}>
            在選定的篩選條件下沒有交易記錄。
                    </p>
                </div>
            ) : (
            <>
            <ul style={{ listStyleType: 'none', padding: 0 }}>
    {pageEntries.map(entry => (
        // VVVV 修正點：將 li 設為主要的容器，並應用類名 VVVV
        <li key={entry.id} className={styles.historyListItem} style={{ border: '1px solid #ccc', padding: '10px', marginBottom: '10px', borderRadius: '5px' }}>

            {/* 左側內容：包含第一行、第二行資訊 */}
        <div className={styles.historyDetailsContainer}>
            <div className={styles.historyInfoRow}>
                <strong>[{entry.date}] {entry.name} ({entry.code})</strong>
            </div>

            <div className={styles.historyTradeRow}>
                <span className={styles.tradeAction}>
                    <span style={{ color: entry.direction === 'BUY' ? 'red' : 'green', fontWeight: 'bold' }}>{entry.direction}</span>:
                    {formatQuantity(entry.quantity)} 股 @ {formatAvgCost(entry.price)}
                </span>
            </div>
        </div>

            {/* 3. 交易理由區塊 (第三行) */}
            <p className={styles.tradeReason} style={{
                paddingLeft: '10px',
                borderLeft: '3px solid #ccc',
                fontSize: '0.9em',
            }}>
                交易理由: {entry.reason || '無備註'}
            </p>

            {/* 4. 按鈕區塊 (右側) */}
            <div className={styles.historyActions}>
                <button onClick={() => handleEdit(entry)} style={EDIT_STYLE}>
                    編輯
                </button>
                <button onClick={() => handleDelete(entry.id)} style={DELETE_STYLE}>
                    刪除
                </button>
            </div>

        </li>
    ))}
</ul>
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #e2e8f0' }}>
                <button
                  onClick={() => setHistoryPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  style={{ ...BUTTON_STYLE, opacity: safePage === 0 ? 0.4 : 1 }}
                >
                  ‹ 上一頁
                </button>
                <span style={{ fontSize: '0.9rem', color: '#64748b' }}>
                  第 {safePage + 1} / {totalPages} 頁
                </span>
                <button
                  onClick={() => setHistoryPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage === totalPages - 1}
                  style={{ ...BUTTON_STYLE, opacity: safePage === totalPages - 1 ? 0.4 : 1 }}
                >
                  下一頁 ›
                </button>
              </div>
            )}
            </>
            )}
        </div>
    );
  };
  
  // 9. 最終渲染 (保持不變)
  return (
    <div className={styles.responsiveContainer} style={{ maxWidth: '800px', margin: '20px auto', padding: '20px' }}>
      
      <h2>{editingId ? '編輯交易記錄' : '交易日誌記錄'}</h2>

      {/* 交易記錄表單區塊 (保持不變) */}
      <form onSubmit={handleFormSubmit} 
        className={styles.tradeFormContainer}
      
        style={{ marginBottom: '15px', border: `1px solid ${GOLDEN_BORDER_COLOR}`, 
          borderRadius: '5px',
          padding: '15px', }}>
         <div className={styles.formInputRow} style={{ display: 'flex', gap: '10px', marginBottom: '15px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            name="code"
            value={formData.code}
            onChange={handleInputChange}
            placeholder="代號"
            required
            autoComplete="off"
            style={{ flex: '1 1 120px', minWidth:'0', padding: '8px', border: '1px solid #a4a4a4ff' }}
          />
          <input
            name="name"
            value={formData.name}
            onChange={handleInputChange}
            placeholder={
              stockNameLoading
                ? '名稱載入中…'
                : allowManualName &&
                    /^\d{4}$/.test(normalizeTaiwanStockCode(formData.code))
                  ? '名稱（請手動輸入）'
                  : '名稱'
            }
            readOnly={
              !allowManualName &&
              /^\d{4}$/.test(normalizeTaiwanStockCode(formData.code)) &&
              !!formData.name.trim()
            }
            required
            style={{
              flex: '1 1 160px',
              minWidth: '0',
              padding: '8px',
              border: '1px solid #a4a4a4ff',
              backgroundColor:
                !allowManualName &&
                /^\d{4}$/.test(normalizeTaiwanStockCode(formData.code)) &&
                !!formData.name.trim()
                  ? 'rgba(0,0,0,0.04)'
                  : undefined,
            }}
          />
          
          <input
            name="quantity"
            type="number"
            value={formData.quantity}
            onChange={handleInputChange}
            placeholder="數量 (股)"
            required
            min="1" 
            step="1"
            style={{ flex: '1 1 auto', minWidth:'0', padding: '8px', border: '1px solid #a4a4a4ff' }} 
          />
          
          <input
            name="price"
            type="number"
            step="0.1" 
            value={formData.price}
            onChange={handleInputChange}
            placeholder="價格"
            required
            min="0.1" 
            style={{ flex: '0 1 auto', padding: '8px', border: '1px solid #a4a4a4ff' }} 
          />
          <input
            name="date"
            type="date"
            value={formData.date}
            onChange={handleInputChange}
            required
            style={{ flex:'3 0 auto', padding: '8px', border: '1px solid #a4a4a4ff' }}
          />
        </div>
        
        <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <button 
                    type="button" 
                    onClick={() => handleDirectionChange('BUY')} 
                    className={`${styles.directionBtn} ${formData.direction === 'BUY' ? styles.activeBuy : ''}`}
                    
                    style={{ 
                        padding: '10px', 
                        color: formData.direction === 'BUY' ? 'white' : 'var(--ifm-color-primary)',
                        border: '1px solid var(--ifm-color-primary)', cursor: 'pointer', borderRadius: '3px',
                        width: '120px' ,fontWeight: 'bold', fontSize: '13px'
                    }}
                >
                    買入 (BUY)
                </button>
                <button 
                    type="button" 
                    onClick={() => handleDirectionChange('SELL')} 
                    className={`${styles.directionBtn} ${formData.direction === 'SELL' ? styles.activeSell : ''}`}
                    style={{ 
                        padding: '10px',  
                        color: formData.direction === 'SELL' ? 'white' : 'var(--ifm-color-primary)',
                        border: '1px solid var(--ifm-color-primary)', cursor: 'pointer', borderRadius: '3px',
                        width: '120px', fontWeight: 'bold', fontSize: '13px'
                    }}
                >
                    賣出 (SELL)
                </button>
            </div>

            <textarea
              name="reason"
              value={formData.reason}
              onChange={handleInputChange}
              placeholder="輸入交易理由或策略"
              rows="6" 
              style={{ flexGrow: 1, resize: 'vertical', padding: '8px', border: '1px solid #a4a4a4ff', minHeight: '100px' }}
            />
        </div>
        
        <div style={{ marginTop: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button 
                type="submit" 
                style={{ 
                    padding: '10px 20px', 
                    backgroundColor: 'var(--ifm-color-primary)', 
                    color: 'white', 
                    border: '1px solid var(--ifm-color-primary)', 
                    cursor: 'pointer', 
                    borderRadius: '3px',
                    width: '120px' ,fontWeight: 'bold', fontSize: '13px'
                }}
            >
              {editingId ? '更新記錄' : '儲存交易記錄'}
            </button>
            {editingId && (
                <button type="button" 
                onClick={() => {
                    setEditingId(null); // 1. 結束編輯狀態
                    // 2. 新增：將輸入框重置為初始狀態
                    setFormData({
                        id: '',
                        code: '',
                        name: '',
                        direction: 'BUY',
                        quantity: '',
                        price: '',
                        date: new Date().toISOString().substring(0, 10),
                        reason: '',
                    });
                }}
                
                style={{ padding: '10px 20px', backgroundColor: '#6c757d', 
                color: 'white', border: '1px solid #6c757d', cursor: 'pointer', 
                borderRadius: '3px' ,width: '120px' ,fontWeight: 'bold', fontSize: '13px'}}>
                    取消編輯
                </button>
            )}
        </div>
      </form>

      {/* II. 追蹤表/摘要區塊 */}
      {renderPnlSummary()}

      {renderStockTableCard()}

      {/* III. 歷史記錄列表區塊 */}
      {renderHistory()}

      {/* 歷史紀錄名稱 vs Firestore 股票清單（折疊） */}
      <div
        style={{
          marginTop: '15px',
          marginBottom: '15px',
          border: `1px solid ${GOLDEN_BORDER_COLOR}`,
          borderRadius: '5px',
          padding: '12px 15px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '10px',
            marginBottom: nameDbCheckOpen ? '10px' : 0,
          }}
        >
          <button
            type="button"
            onClick={() => setNameDbCheckOpen((o) => !o)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flex: '1 1 auto',
              minWidth: 0,
              margin: 0,
              padding: 0,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: 'inherit',
              textAlign: 'left',
            }}
            aria-expanded={nameDbCheckOpen}
          >
            <span style={{ fontSize: '0.7rem', color: '#64748b', width: '1em', flexShrink: 0 }}>
              {nameDbCheckOpen ? '▼' : '▶'}
            </span>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>名稱與資料庫比對</h3>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              syncJournalNamesWithDb({ forceRefresh: true });
            }}
            disabled={nameDbCheck.loading || journalEntries.length === 0}
            style={{
              padding: '8px 14px',
              cursor: journalEntries.length === 0 ? 'not-allowed' : 'pointer',
              borderRadius: '3px',
              border: '1px solid var(--ifm-color-primary)',
              background: 'white',
              color: 'var(--ifm-color-primary)',
              fontWeight: 'bold',
              flexShrink: 0,
            }}
          >
            重新檢查
          </button>
        </div>
        {nameDbCheckOpen && (
          <>
        <p style={{ margin: '0 0 12px 0', fontSize: '0.9rem', color: '#666', lineHeight: 1.55 }}>
          比對來源為 Firestore <code style={{ fontSize: '0.85em' }}>ibdRsMeta/stockList</code>（與代號自動帶入相同）。
          <strong>不會</strong>因紀錄名稱與清單不同而產生程式錯誤；若不一致，載入時會改寫為清單簡稱。此區供你確認是否仍有差異、或代碼不在清單內。
        </p>
        {nameDbCheck.loading && <p style={{ margin: 0, color: '#888' }}>檢查中…</p>}
        {nameDbCheck.error && (
          <p style={{ margin: '8px 0 0 0', color: 'crimson' }}>{nameDbCheck.error}</p>
        )}
        {nameDbCheck.noDbList && (
          <p style={{ margin: '8px 0 0 0', color: '#b45309' }}>
            尚無股票清單文件，請先至分析／RS 相關流程同步全台股清單後再比對。
          </p>
        )}
        {!nameDbCheck.loading && !nameDbCheck.noDbList && journalEntries.length > 0 && (
          <>
            {nameDbCheck.mismatches.length === 0 && nameDbCheck.notInDb.length === 0 ? (
              <p style={{ margin: 0, color: '#15803d', fontWeight: 'bold' }}>
                所有可比對之四位數代碼，名稱皆與資料庫一致。
              </p>
            ) : null}
            {nameDbCheck.mismatches.length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <p style={{ margin: '0 0 8px 0', fontWeight: 'bold', color: '#b45309' }}>
                  名稱與資料庫不同（{nameDbCheck.mismatches.length} 筆）
                </p>
                <div style={{ overflowX: 'auto' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: '0.88rem',
                      minWidth: '420px',
                    }}
                  >
                    <thead>
                      <tr style={{ borderBottom: '1px solid #ccc', textAlign: 'left' }}>
                        <th style={{ padding: '6px 8px' }}>日期</th>
                        <th style={{ padding: '6px 8px' }}>代號</th>
                        <th style={{ padding: '6px 8px' }}>紀錄中的名稱</th>
                        <th style={{ padding: '6px 8px' }}>資料庫簡稱</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nameDbCheck.mismatches.map((row) => (
                        <tr key={row.id} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: '6px 8px' }}>{row.date}</td>
                          <td style={{ padding: '6px 8px' }}>{row.code}</td>
                          <td style={{ padding: '6px 8px' }}>{row.nameInRecord || '—'}</td>
                          <td style={{ padding: '6px 8px', fontWeight: 'bold' }}>{row.nameInDb}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {nameDbCheck.notInDb.length > 0 && (
              <div style={{ marginTop: '14px' }}>
                <p style={{ margin: '0 0 8px 0', fontWeight: 'bold', color: '#b45309' }}>
                  四位數代碼在清單中查無（{nameDbCheck.notInDb.length} 筆）
                </p>
                <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.88rem', lineHeight: 1.6 }}>
                  {nameDbCheck.notInDb.map((row) => (
                    <li key={row.id}>
                      [{row.date}] {row.code} — 紀錄名稱：{row.nameInRecord || '—'}（清單無此代碼，無法自動對名）
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {nameDbCheck.skippedNonFour.length > 0 && (
              <p style={{ margin: '14px 0 0 0', fontSize: '0.88rem', color: '#64748b' }}>
                另有 {nameDbCheck.skippedNonFour.length}{' '}
                筆為非四位數代碼（權證等），未與上市櫃清單比對，屬正常。
              </p>
            )}
          </>
        )}
          </>
        )}
      </div>
    </div>
  );
}


export default TradeJournal;