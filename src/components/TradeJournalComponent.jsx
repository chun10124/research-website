import React, { useState, useEffect, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { setDoc, onSnapshot } from 'firebase/firestore'; // 只需要 setDoc 和 onSnapshot

// 1. 引入 Firebase 配置
import { JOURNAL_DOC_REF } from '../utils/firebaseConfig'; 

// 2. 引入格式化工具
import { PNL_COLOR, GOLDEN_BORDER_COLOR, formatQuantity, formatAvgCost, formatPnl } from '../utils/formatting';

// 3. 引入核心計算邏輯
import { calculatePnlSummary, getStartDate } from '../utils/pnlCalculator';

import styles from './TradeJournal.module.css';

// Local Storage Key (已不再使用，但保留定義)
// const LOCAL_STORAGE_KEY = 'tradeJournalData';


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
const saveJournalToCloud = async (entries) => {
    try {
        // 1. 先在本地更新 UI (確保響應快速)
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
        
        // 2. 存儲到 Firestore
        await setDoc(JOURNAL_DOC_REF, { entries: entries });
        
        console.log("數據已成功寫入 Firestore。");
        
    } catch (error) {
        console.error("寫入 Firestore 失敗:", error);
        alert("警告：數據寫入雲端失敗，請檢查網路連線。");
    }
};

  // 3. 歷史記錄列表的過濾數據 (保持不變)
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


  // 4. P&L 摘要的計算核心 (保持不變)
  const pnlSummary = useMemo(
    () => calculatePnlSummary(journalEntries, pnlFilterRange),
    [journalEntries, pnlFilterRange]
  );


  // 5. 表單處理 (保持不變)
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
    
    if (!formData.code || !formData.name || quantity < 1 || price < 0.1) {
        alert("請填寫股票名稱、代號，並確保數量 >= 1 且價格 >= 0.1！");
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
    const { byStock, totalRealizedPnl, winRate } = pnlSummary;

    //  1. 新增過濾邏輯：根據代號或名稱篩選
    const filteredByStock = byStock.filter(item => 
        item.code.toLowerCase().includes(pnlFilterStock.toLowerCase()) ||
        item.name.toLowerCase().includes(pnlFilterStock.toLowerCase())
    );

    //  2. 排序邏輯：按持倉金額大小排序 (使用過濾後的結果)
    const sortedByStock = [...filteredByStock].sort((a, b) => {
        const totalCostA = Math.abs(a.netQuantity * a.avgCost);
        const totalCostB = Math.abs(b.netQuantity * b.avgCost);
        if (totalCostB !== totalCostA) return totalCostB - totalCostA;
        return a.code.localeCompare(b.code);
    });

    const pnlColorStyle = { color: PNL_COLOR(totalRealizedPnl), fontWeight: 'bold' };
    const period = pnlFilterRange === 'ALL' ? '全部記錄' : '篩選期間';

    return (
      <div style={{ marginTop: '30px', border: `1px solid ${GOLDEN_BORDER_COLOR}`, borderRadius: '5px', padding: '15px' }}>
        <div className={styles.pnlHeaderRow} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ marginRight: '20px' }}>儀表板與損益摘要 ({period})</h3>
            
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
                    style={{ padding: '8px', border: '1px solid #ccc', backgroundColor: 'transparent', color: 'inherit' }}
                >
                    <option value="ALL">全部</option>
                    <option value="WEEK">當週</option>
                    <option value="MONTH">當月</option>
                    <option value="HALFYEAR">近半年</option>
                    <option value="YEAR">近一年</option>
                </select>
            </div>
        </div>
        
        {/* 保留原本的卡片區塊 */}
        <div className={styles.responsiveFlexRow} style={{ display: 'flex', gap: '15px', marginBottom: '15px' }}>
            <div className={styles.pnlSummaryCard} style={{ flex: 1, padding: '12px', border: '1px solid #ccc', borderRadius: '5px'}}> 
                <h4 style={{ margin: '0 0 5px 0' }}>總已實現損益</h4>
                <p style={{ margin: 0, fontSize: '1.5em', ...pnlColorStyle }}>
                    {formatPnl(totalRealizedPnl)}
                </p>
            </div>
            <div className={styles.pnlSummaryCard} style={{ flex: 1, padding: '15px', border: '1px solid #ccc', borderRadius: '5px'}}> 
                <h4 style={{ margin: '0 0 5px 0' }}>交易勝率</h4>
                <p style={{ margin: 0, fontSize: '1.5em' }}>
                    {winRate}%
                </p>
            </div>
        </div>

        <h4 style={{ marginTop: '20px' }}>個股損益與持倉 (按持倉金額排序)</h4>
        <div style={{ overflowX: 'auto' }}>
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
                        //  4. 計算持倉金額 (股數 * 平均成本)
                        const positionAmount = Math.round(data.netQuantity * data.avgCost);

                        return (
                            <tr key={data.code} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '8px', fontWeight: 'bold' }}>{data.name} ({data.code})</td>
                                <td style={{ padding: '8px' }}>{formatAvgCost(avgCostDisplay)}</td>
                                <td style={{ 
                                    padding: '8px', 
                                    color: data.netQuantity > 0 ? '#eee' : (data.netQuantity < 0 ? '#eee' : 'inherit') 
                                }}>
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
      </div>
    );
  };

  // 8. 渲染歷史記錄列表 (保持不變)
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
        color:'orange',
        borderColor:'orange'
    };
    
    return (
        <div style={{ marginTop: '30px',border: `1px solid ${GOLDEN_BORDER_COLOR}`, 
          borderRadius: '5px',
          padding: '15px', }}>
            
            <div className={styles.responsiveFilterRow} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <h3>歷史交易記錄 ({entriesToRender.length} 筆)</h3>
                <div className={styles.responsiveFilterRowControls} style={{ display: 'flex', gap: '10px' }}>
                    {/* 搜尋輸入框 */}
                    <input
                        type="text"
                        placeholder="搜尋股票代號/名稱"
                        value={historyFilterStock}
                        onChange={(e) => setHistoryFilterStock(e.target.value)}
                        className={styles.pnlSearchInput}
                    />

                    {/* 時間篩選器 */}
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
        // VVVV 修正點：將 li 設為主要的容器，並應用類名 VVVV
        <li key={entry.id} className={styles.historyListItem} style={{ border: '1px solid #ccc', padding: '10px', marginBottom: '10px', borderRadius: '5px' }}>
            
            {/* 左側內容：包含第一行與第二行資訊 */}
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
            )}
        </div>
    );
  };
  
  // 9. 最終渲染 (保持不變)
  return (
    <div className={styles.responsiveContainer} style={{ maxWidth: '1000px', margin: '20px auto', padding: '20px' }}>
      
      <h2>{editingId ? '編輯交易記錄' : '交易日誌記錄'}</h2>

      {/* 交易記錄表單區塊 (保持不變) */}
      <form onSubmit={handleFormSubmit} 
        className={styles.tradeFormContainer}
      
        style={{ marginBottom: '30px',border: `1px solid ${GOLDEN_BORDER_COLOR}`, 
          borderRadius: '5px',
          padding: '15px', }}>
         <div className={styles.formInputRow} style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
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
            step="0.1" 
            value={formData.price}
            onChange={handleInputChange}
            placeholder="價格"
            required
            min="0.1" 
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
                <button type="button" onClick={() => setEditingId(null)} 
                style={{ padding: '10px 20px', backgroundColor: '#6c757d', 
                color: 'white', border: '1px solid #6c757d', cursor: 'pointer', 
                borderRadius: '3px' ,width: '120px' ,fontWeight: 'bold', fontSize: '13px'}}>
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