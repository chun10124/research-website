import React, { useState, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';

// Local Storage Key
const LOCAL_STORAGE_KEY = 'tradeJournalData';

// 樣式常數 (保持不變)
const PNL_COLOR = (pnl) => (pnl > 0 ? 'green' : (pnl < 0 ? 'red' : 'inherit'));
const GOLDEN_BORDER_COLOR = '#deb887'; 

// ========== 格式化輔助函數 (保持不變) ==========
const formatQuantity = (num) => {
    if (num === null || num === undefined || isNaN(num)) return '0';
    return Math.round(num).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

const formatAvgCost = (num) => {
    if (num === null || num === undefined || isNaN(num)) return '0.0';
    return Number(num).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
};

const formatPnl = (pnl) => {
    if (pnl === null || pnl === undefined || isNaN(pnl)) return '0';
    const integerPnl = Math.round(pnl);
    return integerPnl.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

// ========== I. P&L 計算核心函數 (保持與上次修好的版本一致) ==========
const calculatePnlSummary = (entries, filterRange = 'ALL') => {
    if (!entries || entries.length === 0) {
        return {
            byStock: [],
            totalRealizedPnl: 0,
            winRate: 0,
            totalClosedTrades: 0,
        };
    }

    const sortedEntries = [...entries].sort(
        (a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            const dateDiff = dateA - dateB;

            if (dateDiff !== 0) {
                return dateDiff; 
            }
            return (a.timeId || 0) - (b.timeId || 0); 
        }
    );

    const stockMap = {};
    const EPSILON = 1e-6; 

    sortedEntries.forEach((e) => {
        const code = e.code;
        if (!stockMap[code]) {
            stockMap[code] = {
                name: e.name,
                positionQty: 0,      
                positionCost: 0,     
                trades: [],          
            };
        }

        const s = stockMap[code];
        const qty = Number(e.quantity);
        const price = Number(e.price);
        const time = new Date(e.date).getTime();

        if (isNaN(qty) || qty <= EPSILON || isNaN(price) || price < 0.5) return;


        const closeTradeAndRecord = (closedQty, avgPrice, newPrice, isLong) => {
            let realizedPnl = 0;
            const nClosedQty = Number(closedQty);
            const nAvgPrice = Number(avgPrice);
            const nNewPrice = Number(newPrice);
            
            if (isLong) {
                realizedPnl = (nNewPrice * nClosedQty) - (nAvgPrice * nClosedQty);
            } else {
                realizedPnl = (nAvgPrice * nClosedQty) - (nNewPrice * nClosedQty);
            }

            if (Math.abs(realizedPnl) > EPSILON) {
                s.trades.push({ pnl: realizedPnl, closeTime: time });
            }
        };
        
        const isPositionZero = (qty) => Math.abs(qty) < EPSILON;
        const resetPosition = () => { s.positionQty = 0; s.positionCost = 0; }

        if (e.direction === 'BUY') {
            if (s.positionQty < 0) {
                const absShortQty = Math.abs(s.positionQty);
                const avgShortPrice = absShortQty > EPSILON ? Number(s.positionCost) / absShortQty : 0; 
                
                const closedQty = Math.min(qty, absShortQty); 
                const remainingQty = qty - closedQty; 

                if (closedQty > EPSILON) {
                    closeTradeAndRecord(closedQty, avgShortPrice, price, false); 
                    const costToReduce = avgShortPrice * closedQty;
                    s.positionCost = Number(s.positionCost) - costToReduce;
                    s.positionQty = Number(s.positionQty) + closedQty;
                }
                
                if (isPositionZero(s.positionQty) && remainingQty > EPSILON) {
                    s.positionQty = remainingQty;
                    s.positionCost = price * remainingQty;
                } else if (isPositionZero(s.positionQty)) {
                    resetPosition();
                }

            } else {
                s.positionCost = Number(s.positionCost) + (price * qty);
                s.positionQty = Number(s.positionQty) + qty;
            }
        }

        if (e.direction === 'SELL') {
            if (s.positionQty > 0) {
                const longQty = s.positionQty;
                const avgCost = longQty > EPSILON ? Number(s.positionCost) / longQty : 0;
                
                const closedQty = Math.min(qty, longQty);
                const remainingQty = qty - closedQty; 

                if (closedQty > EPSILON) {
                    closeTradeAndRecord(closedQty, avgCost, price, true); 
                    const costToReduce = avgCost * closedQty;
                    s.positionCost = Number(s.positionCost) - costToReduce; 
                    s.positionQty = Number(s.positionQty) - closedQty; 
                }
                
                if (isPositionZero(s.positionQty) && remainingQty > EPSILON) {
                    s.positionQty = -remainingQty;
                    s.positionCost = price * remainingQty;
                } else if (isPositionZero(s.positionQty)) {
                    resetPosition();
                }

            } else {
                s.positionCost = Number(s.positionCost) + (price * qty);
                s.positionQty = Number(s.positionQty) - qty;
            }
        }
    });

    let filterStartTime = null;
    if (filterRange && filterRange !== 'ALL') {
        const startDateObj = getStartDate(filterRange);
        if (startDateObj) filterStartTime = startDateObj.getTime();
    }

    const byStock = [];
    let totalRealizedPnl = 0;
    let totalClosedTrades = 0;
    let winningTrades = 0;

    Object.keys(stockMap).forEach((code) => {
        const s = stockMap[code];
        const netQuantity = s.positionQty;

        const absNetQuantity = Math.abs(netQuantity);
        const avgCost =
            absNetQuantity > EPSILON
                ? Number(s.positionCost) / absNetQuantity
                : 0;

        let realizedInPeriod = 0;

        s.trades.forEach((t) => {
            const inPeriod =
                !filterStartTime || t.closeTime >= filterStartTime;

            if (inPeriod) {
                realizedInPeriod += t.pnl;
                totalRealizedPnl += t.pnl;

                if (t.pnl > 0) {
                    winningTrades++;
                    totalClosedTrades++;
                } else if (t.pnl < 0) {
                    totalClosedTrades++;
                }
            }
        });

        byStock.push({
            code,
            name: s.name,
            netQuantity: Math.round(netQuantity), 
            avgCost,
            realizedPnl: realizedInPeriod,
        });
    });

    const winRate =
        totalClosedTrades > 0
            ? (winningTrades / totalClosedTrades * 100).toFixed(2)
            : 0;

    return {
        byStock,
        totalRealizedPnl: Math.round(totalRealizedPnl), 
        winRate,
        totalClosedTrades,
    };
};


// ========== II. 時間篩選邏輯 (保持不變) ==========
const getStartDate = (range) => {
    const now = new Date();
    let startDate = null;
    now.setHours(0, 0, 0, 0); 

    switch (range) {
        case 'WEEK':
            startDate = new Date(now.setDate(now.getDate() - now.getDay())); 
            break;
        case 'MONTH':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
        case 'HALFYEAR':
            startDate = new Date(now.setMonth(now.getMonth() - 6));
            break;
        case 'YEAR':
            startDate = new Date(now.setFullYear(now.getFullYear() - 1));
            break;
        case 'ALL':
        default:
            return null;
    }
    return startDate;
};


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
  // <<< 修改：historyFilterStock 現在是搜尋字串 >>>
  const [historyFilterStock, setHistoryFilterStock] = useState('');


  // 1. Local Storage 數據加載與儲存邏輯 (保持不變)
  useEffect(() => {
    const storedData = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (storedData) {
      const entries = JSON.parse(storedData).sort((a, b) => {
          const dateA = new Date(a.date);
          const dateB = new Date(b.date);
          const dateDiff = dateB - dateA; 

          if (dateDiff !== 0) {
            return dateDiff; 
          }
          return (b.timeId || 0) - (a.timeId || 0); 
      });
      setJournalEntries(entries);
    }
  }, []);

  const saveToLocalStorage = (entries) => {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(entries));
      
      const sorted = entries.sort((a, b) => {
          const dateA = new Date(a.date);
          const dateB = new Date(b.date);
          const dateDiff = dateB - dateA; 

          if (dateDiff !== 0) {
            return dateDiff; 
          }
          return (b.timeId || 0) - (a.timeId || 0); 
      });
      setJournalEntries(sorted);
  };

  // 2. 歷史記錄列表的過濾數據 (修正：使用搜尋字串過濾代號或名稱)
  const historyFilteredEntries = useMemo(() => {
    let filtered = journalEntries;

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

    return filtered;
  }, [journalEntries, historyFilterRange, historyFilterStock]); 


  // 3. P&L 摘要的計算核心 (保持不變)
  const pnlSummary = useMemo(
    () => calculatePnlSummary(journalEntries, pnlFilterRange),
    [journalEntries, pnlFilterRange]
  );


  // 4. 表單處理 (保持不變)
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prevData => ({ ...prevData, [name]: value }));
  };

  const handleDirectionChange = (direction) => {
      setFormData(prevData => ({ ...prevData, direction }));
  };

  const handleFormSubmit = (e) => {
    e.preventDefault();
    
    const quantity = Number(formData.quantity);
    const price = Number(formData.price);
    
    if (!formData.code || !formData.name || quantity < 1 || price < 0.5) {
        alert("請填寫股票名稱、代號，並確保數量 >= 1 且價格 >= 0.5！");
        return;
    }

    const entryToSave = {
      ...formData,
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

    saveToLocalStorage(updatedEntries);
    
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
  
  // 5. 刪除與編輯功能 (保持不變)
  const handleDelete = (id) => {
      if (window.confirm("確定要刪除這筆交易記錄嗎？")) {
          const updatedEntries = journalEntries.filter(entry => entry.id !== id);
          saveToLocalStorage(updatedEntries);
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
  
  // 6. 渲染 P&L 摘要 (保持不變)
 const renderPnlSummary = () => {
    const { byStock, totalRealizedPnl, winRate } = pnlSummary;

    const sortedByStock = [...byStock].sort((a, b) => {
        const qtyA = Math.abs(a.netQuantity);
        const qtyB = Math.abs(b.netQuantity);
        
        // 1. 主要排序依據：淨持倉絕對值 (由大到小)
        // 確保部位不為零的股票排在最前面
        if (qtyA !== qtyB) {
            return qtyB - qtyA;
        }
        
        // 2. 次要排序依據：如果數量相同，按股票代號排序
        return a.code.localeCompare(b.code);
    });


    const pnlColorStyle = { color: PNL_COLOR(totalRealizedPnl), fontWeight: 'bold' };
    const period = pnlFilterRange === 'ALL' ? '全部記錄' : '篩選期間';

    return (
      <div style={{ 
          marginTop: '30px', 
          border: `1px solid ${GOLDEN_BORDER_COLOR}`, 
          borderRadius: '5px',
          padding: '15px', 
          backgroundColor: '#fff' 
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3>儀表板與盈虧摘要 ({period})</h3>
            <div>
                <select 
                    value={pnlFilterRange} 
                    onChange={(e) => setPnlFilterRange(e.target.value)}
                    style={{ padding: '8px', border: '1px solid #ccc' }}
                >
                    <option value="ALL">全部</option>
                    <option value="WEEK">當週</option>
                    <option value="MONTH">當月</option>
                    <option value="HALFYEAR">近半年</option>
                    <option value="YEAR">近一年</option>
                </select>
            </div>
        </div>
        
        <div style={{ display: 'flex', gap: '15px', marginBottom: '15px' }}>
            
            <div style={{ flex: 1, padding: '12px', border: '1px solid #ccc', borderRadius: '5px', backgroundColor: '#f9f9f9c5' }}> 
                <h4 style={{ margin: '0 0 5px 0' }}>總已實現盈虧</h4>
                <p style={{ margin: 0, fontSize: '1.5em', ...pnlColorStyle }}>
                    {formatPnl(totalRealizedPnl)}
                </p>
            </div>
            
            <div style={{ flex: 1, padding: '15px', border: '1px solid #ccc', borderRadius: '5px', backgroundColor: '#f9f9f9c5' }}> 
                <h4 style={{ margin: '0 0 5px 0' }}>交易勝率</h4>
                <p style={{ margin: 0, fontSize: '1.5em' }}>
                    {winRate}%
                </p>
            </div>
        </div>

        <h4 style={{ marginTop: '20px' }}>個股盈虧與持倉 (淨持倉與成本為全部歷史，盈虧為篩選期間)</h4>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ borderBottom: '1.5px solid #333' }}>
              <th style={{ padding: '8px' }}>股票名稱/代號</th>
              <th style={{ padding: '8px' }}>平均成本</th>
              <th style={{ padding: '8px' }}>淨持倉 (股)</th>
              <th style={{ padding: '8px' }}>已實現盈虧</th>
            </tr>
          </thead>
          <tbody>
            {sortedByStock.length === 0 ? (
                <tr><td colSpan="4" style={{ padding: '10px', textAlign: 'center' }}>無數據</td></tr>
            ) : (
                sortedByStock.map(data => {
                    const avgCostDisplay = data.netQuantity !== 0 ? data.avgCost : 0;
                    
                    return (
                        <tr key={data.code} style={{ borderBottom: '1px solid #eee' }}>
                            <td style={{ padding: '8px', fontWeight: 'bold' }}>{data.name} ({data.code})</td>
                            <td style={{ padding: '8px' }}>{formatAvgCost(avgCostDisplay)}</td>
                            <td style={{ padding: '8px', color: data.netQuantity > 0 ? 'green' : (data.netQuantity < 0 ? 'red' : 'inherit') }}>
                                {formatQuantity(data.netQuantity)}
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
    );
  };

  // 7. 渲染歷史記錄列表 (關鍵修改：將下拉選單替換為搜尋框)
  const renderHistory = () => {
    const entriesToRender = historyFilteredEntries; 

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
        marginLeft: '10px'
    };
    const EDIT_STYLE = {
        ...BUTTON_STYLE,
        marginRight: '7px',
        color:'green',
        borderColor:'green'
    };
    
    return (
        <div style={{ marginTop: '30px',border: `1px solid ${GOLDEN_BORDER_COLOR}`, 
          borderRadius: '5px',
          padding: '15px', }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3>歷史交易記錄 ({entriesToRender.length} 筆)</h3>
                <div style={{ display: 'flex', gap: '10px' }}>
                    {/* <<< 替換：使用搜尋輸入框篩選股票代號/名稱 >>> */}
                    <input
                        type="text"
                        placeholder="搜尋股票代號/名稱"
                        value={historyFilterStock}
                        onChange={(e) => setHistoryFilterStock(e.target.value)}
                        style={{ padding: '8px', border: '1px solid #ccc', minWidth: '150px' }}
                    />

                    {/* 時間篩選器 (保持不變) */}
                    <select 
                        value={historyFilterRange} 
                        onChange={(e) => setHistoryFilterRange(e.target.value)}
                        style={{ padding: '8px', border: '1px solid #ccc' }}
                    >
                        <option value="ALL">全部時間</option>
                        <option value="WEEK">當週</option>
                        <option value="MONTH">當月</option>
                        <option value="HALFYEAR">近半年</option>
                        <option value="YEAR">近一年</option>
                    </select>
                </div>
            </div>

            {entriesToRender.length === 0 ? (
                <p>在選定的篩選條件下沒有交易記錄。</p>
            ) : (
                <ul style={{ listStyleType: 'none', padding: 0 }}>
                    {entriesToRender.map(entry => (
                        <li key={entry.id} style={{ border: '1px solid #ccc', padding: '10px', marginBottom: '10px', borderRadius: '5px' }}>
                          
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                              <div>
                                  <strong>[{entry.date}] {entry.name} ({entry.code})</strong> | 
                                  <span style={{ color: entry.direction === 'BUY' ? 'green' : 'red', fontWeight: 'bold' }}>{entry.direction}</span>: 
                                  {formatQuantity(entry.quantity)} 股 @ {formatAvgCost(entry.price)}
                              </div>
                              <div>
                                  <button onClick={() => handleEdit(entry)} style={EDIT_STYLE}>
                                      編輯
                                  </button>
                                  <button onClick={() => handleDelete(entry.id)} style={DELETE_STYLE}>
                                      刪除
                                  </button>
                              </div>
                          </div>
                          
                          <p style={{ marginTop: '5px', marginBottom: 0, paddingLeft: '10px', borderLeft: '3px solid #ccc', fontSize: '0.9em' }}>
                            交易理由: {entry.reason || '無備註'}
                          </p>
                        </li>
                      ))}
                </ul>
            )}
        </div>
    );
  };
  
  // 8. 最終渲染 (保持不變)
  return (
    <div style={{ maxWidth: '1000px', margin: '20px auto', padding: '20px' }}>
      
      <style jsx="true">{`
        input[type="number"]::-webkit-outer-spin-button,
        input[type="number"]::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }
        input[type="number"] {
            -moz-appearance: textfield; 
        }
        ::placeholder {
            color: #575a5bff; /* 深灰色 */
            opacity: 1; /* 確保在 Firefox 中顏色不會變淡 */
            font-weight: 600;
        }



      `}</style>
      
      <h2>{editingId ? '編輯交易記錄' : '交易日誌記錄'}</h2>

      {/* 交易記錄表單區塊 (保持不變) */}
      <form onSubmit={handleFormSubmit} style={{ marginBottom: '30px',border: `1px solid ${GOLDEN_BORDER_COLOR}`, 
          borderRadius: '5px',
          padding: '15px', }}>
         <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
          <input
            name="name"
            value={formData.name}
            onChange={handleInputChange}
            placeholder="股票名稱 (e.g., 台積電)"
            required
            style={{ flex: 1.5, padding: '8px', border: '1px solid #a4a4a4ff' }}
          />
          <input
            name="code"
            value={formData.code}
            onChange={handleInputChange}
            placeholder="代號 (e.g., 2330)"
            required
            style={{ flex: 1, padding: '8px', border: '1px solid #a4a4a4ff' }}
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
            style={{ flex: 1, padding: '8px', border: '1px solid #a4a4a4ff' }} 
          />
          
          <input
            name="price"
            type="number"
            step="0.5" 
            value={formData.price}
            onChange={handleInputChange}
            placeholder="價格"
            required
            min="0.5" 
            style={{ flex: 1, padding: '8px', border: '1px solid #a4a4a4ff' }} 
          />
          <input
            name="date"
            type="date"
            value={formData.date}
            onChange={handleInputChange}
            required
            style={{ flex: 1, padding: '8px', border: '1px solid #a4a4a4ff' }}
          />
        </div>
        
        <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <button 
                    type="button" 
                    onClick={() => handleDirectionChange('BUY')} 
                    style={{ 
                        padding: '10px', 
                        backgroundColor: formData.direction === 'BUY' ? 'var(--ifm-color-primary)' : 'white', 
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
                    style={{ 
                        padding: '10px', 
                        backgroundColor: formData.direction === 'SELL' ? 'var(--ifm-color-primary)' : 'white', 
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
                    border: 'none', 
                    cursor: 'pointer', 
                    borderRadius: '3px',
                    width: '120px' ,fontWeight: 'bold', fontSize: '13px'
                }}
            >
              {editingId ? '更新記錄' : '儲存交易記錄'}
            </button>
            {editingId && (
                <button type="button" onClick={() => setEditingId(null)} style={{ padding: '10px 20px', backgroundColor: '#6c757d', color: 'white', border: 'none', cursor: 'pointer', borderRadius: '3px' }}>
                    取消編輯
                </button>
            )}
        </div>
      </form>

      {/* II. 儀表板/摘要區塊 */}
      {renderPnlSummary()}
      
      {/* III. 歷史記錄列表區塊 */}
      {renderHistory()}
    </div>
  );
}

export default TradeJournal;