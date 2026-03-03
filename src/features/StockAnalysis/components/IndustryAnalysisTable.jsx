import React, { useState, useEffect } from 'react';
import { calculateSingleStockIndicators } from '../utils/analysisUtils';

// --- 輔助函式：熱力圖樣式 ---
const getCurvatureStyle = (val, isShowBg) => {
    // 1. 定義基礎顏色
    const isPositive = val > 0;
    const isNegative = val < 0;
    const absVal = Math.abs(val);
    
    // 基礎文字顏色：紅 (漲/強) / 綠 (跌/弱) / 深灰 (持平)
    let textColor = isPositive ? '#d63031' : isNegative ? '#27ae60' : '#333';
    let bgColor = 'transparent';
    let fontWeight = 'normal';

    if (isShowBg && val !== 0 && val !== null) {
        // 2. 提高背景飽和度 (基礎 0.15 + 數值加成)，讓顏色更紮實
        const opacity = Math.min(0.15 + absVal * 0.5, 0.85);
        bgColor = isPositive 
            ? `rgba(231, 76, 60, ${opacity})`  // 紅色背景
            : `rgba(46, 204, 113, ${opacity})`; // 綠色背景

        // 3. 智慧對比色邏輯
        // 只有當背景透明度超過 0.5 時，才把文字轉為白色，否則維持深紅/深綠字
        if (opacity > 0.5) {
            textColor = '#ffffff';
            fontWeight = 'bold';
        } else {
            // 在淡色背景下，加深文字顏色以利閱讀
            textColor = isPositive ? '#850000' : '#005a00';
        }
    }
    
    return { 
        backgroundColor: bgColor,
        color: textColor, 
        fontWeight: fontWeight,
        transition: 'all 0.2s' // 增加平滑感
    };
};

// 量比熱力圖：量縮藍色階（<1）、約 1 白、量增黃色階（>1）
const getVolumeHeatmapBg = (ratio) => {
    const v = Number(ratio) ?? 0;
    if (v >= 0.98 && v <= 1.05) return '#FFFFFF';
    if (v < 0.98) {
        const t = Math.min((0.98 - v) / 0.98, 1);
        return `rgb(${Math.round(255 - 189 * t)}, ${Math.round(255 - 90 * t)}, ${Math.round(255 - 10 * t)})`;
    }
    const t = Math.min((v - 1.05) / 2, 1);
    return `rgb(255, ${Math.round(255 - 20 * t)}, ${Math.round(255 - 196 * t)})`;
};

// Google Sheets 熱力色階：漲跌背景（黑字），紅漲綠跌、依絕對值插值
const getChangeHeatmapBg = (changePercent) => {
    const v = Number(changePercent) || 0;
    if (v === 0) return 'transparent';
    const abs = Math.min(Math.abs(v), 10);
    const t = abs / 10; // 0~1
    if (v > 0) {
        // 紅：淺 #FFCCC7 → 深 #D32F2F（比原本更深）
        const r = Math.round(255 - 44 * t);
        const g = Math.round(204 - 157 * t);
        const b = Math.round(199 - 152 * t);
        return `rgb(${r}, ${g}, ${b})`;
    }
    // 綠：淺 #C8E6C9 → 深 #43A047
    const r = Math.round(200 - 133 * t);
    const g = Math.round(230 - 70 * t);
    const b = Math.round(201 - 130 * t);
    return `rgb(${r}, ${g}, ${b})`;
};

// --- 輔助函式：可編輯儲存格 ---
const EditableCell = ({ initialValue, onSave, type = "text", style = {} }) => {
    const [localValue, setLocalValue] = useState(initialValue || '');
    useEffect(() => { setLocalValue(initialValue || ''); }, [initialValue]);
    return (
        <input
            type={type}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={() => {
                const rawValue = String(localValue).replace(/,/g, '');
                if (rawValue.trim() === '') { onSave(null); return; }


                const isPureNumber = /^-?\d*\.?\d+$/.test(rawValue);
                const finalValue = isPureNumber ? parseFloat(rawValue) : rawValue;
                
                onSave(finalValue);
            }}
            style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', textAlign: 'center', padding: '1px 2px', borderRadius: '2px', boxSizing: 'border-box', minWidth: '0', fontSize: 'inherit', ...style }}
        />
    );
};

/** @type {'main'|'chip'}  main=一般欄位(不含籌碼)  chip=籌碼欄位 */
const IndustryAnalysisTable = ({ stocks = [], updateStockField, refreshData, loading, columnsMode = 'main', bigColumnConfig = {}, columnLabels = [], onColumnLabelChange }) => {
    const [showColor, setShowColor] = useState(true);
    const isChipMode = columnsMode === 'chip';

    if (loading && stocks.length === 0) return <p>載入中... 請稍候</p>;

    // 🟢 步驟 1: 處理所有股票的數據計算
    const processedStocks = stocks.map(stock => {
        const indicators = calculateSingleStockIndicators(stock);
        const price = parseFloat(stock.currentPrice) || 0;
        const eps = stock.estimatedEPS; 
        const target = stock.targetPrice;

        const forwardPE = (price > 0 && eps && eps > 0) ? (price / eps).toFixed(1) : '--';
        const potentialUpside = (target && target > 0 && price > 0) ? ((target / price - 1) * 100).toFixed(1) : null;

        const formatNumber = (num, digits = 0) => {
            if (num === null || num === undefined || isNaN(num) || num === 0) return ''; 
            return Number(num).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
        };

        return {
            ...stock,
            ...indicators,
            displayPrice: formatNumber(price, 0),
            displayEPS: formatNumber(eps, 1),
            displayTarget: formatNumber(target, 0),
            displayHoldingGrowth: indicators.HoldingGrowth_M ? indicators.HoldingGrowth_M : '0',
            forwardPE,
            potentialUpside
        };
    });

    // 🟢 步驟 2: 把股票按照產業 (category) 分成一組一組
    const groupedData = processedStocks.reduce((groups, stock) => {
        const cat = stock.category || '未分類';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(stock);
        return groups;
    }, {});

    const categories = Object.keys(groupedData).sort();
    const ROW_H = 25;
    const rowH = `${ROW_H}px`;
    const trStyle = { height: rowH, maxHeight: rowH };
    const NUM_BIG_COLUMNS = 8;

    // 依大欄設定組出每欄的項目列表（header + stocks 交錯）
    const getColumnItems = () => {
        const byCol = {};
        for (let c = 0; c < NUM_BIG_COLUMNS; c++) byCol[c] = [];
        categories.forEach(cat => {
            const cfg = bigColumnConfig[cat] ?? { column: 0, order: 0 };
            const col = Math.max(0, Math.min(NUM_BIG_COLUMNS - 1, Number(cfg.column) || 0));
            const order = Number(cfg.order) || 0;
            byCol[col].push({ cat, order, stocks: groupedData[cat] || [] });
        });
        return Array.from({ length: NUM_BIG_COLUMNS }, (_, c) => {
            byCol[c].sort((a, b) => a.order - b.order);
            const items = [];
            byCol[c].forEach(({ cat, stocks }) => {
                items.push({ _isHeader: true, cat });
                stocks.forEach(s => items.push(s));
            });
            return items;
        });
    };
    const columnItems = getColumnItems();
    const maxRows = Math.max(1, ...columnItems.map(arr => arr.length));

    const thStyle = (extra = {}) => ({ height: rowH, maxHeight: rowH, padding: '2px 4px', border: '1px solid #ddd', boxSizing: 'border-box', verticalAlign: 'middle', overflow: 'hidden', ...extra });
    const tdBase = { height: rowH, maxHeight: rowH, padding: '1px 4px', border: '1px solid #ddd', boxSizing: 'border-box', verticalAlign: 'middle', overflow: 'hidden' };

    // 42+50+52+46+46+46+46 = 328px per big column
    const SUB_COL_WIDTHS_PX = [44, 44, 50, 52, 42, 42, 56];
    const SUB_COL_WIDTHS = SUB_COL_WIDTHS_PX.map(w => `${w}px`);
    const BIG_COL_WIDTH_PX = SUB_COL_WIDTHS_PX.reduce((a, b) => a + b, 0);
    const TABLE_TOTAL_WIDTH = NUM_BIG_COLUMNS * BIG_COL_WIDTH_PX;
    const SEP_LINE_WIDTH = 1;

    const renderMainCellBlock = (item, blockIndex) => {
        if (!item) {
            return (
                <React.Fragment key={blockIndex}>
                    {SUB_COL_WIDTHS.map((w, i) => <td key={`e-${blockIndex}-${i}`} style={{ ...tdBase, width: w, minWidth: w, maxWidth: w }} />)}
                </React.Fragment>
            );
        }
        if (item._isHeader) {
            return (
                <React.Fragment key={blockIndex}>
                    <td colSpan={SUB_COL_WIDTHS.length} style={{ ...tdBase, width: `${BIG_COL_WIDTH_PX}px`, maxWidth: `${BIG_COL_WIDTH_PX}px`, padding: '1px 6px', background: '#e8f0fe', fontWeight: 'bold', fontSize: '10px', color: '#1a3a6e', letterSpacing: '0.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.cat}
                    </td>
                </React.Fragment>
            );
        }
        const stock = item;
        return (
            <React.Fragment key={blockIndex}>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[0], minWidth: SUB_COL_WIDTHS[0], maxWidth: SUB_COL_WIDTHS[0], padding: '1px 3px', fontWeight: 'bold' }}>{stock.id}</td>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[1], minWidth: SUB_COL_WIDTHS[1], maxWidth: SUB_COL_WIDTHS[1], padding: '1px 3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stock.name}</td>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[2], minWidth: SUB_COL_WIDTHS[2], maxWidth: SUB_COL_WIDTHS[2], textAlign: 'right' }}>{stock.displayPrice}</td>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[3], minWidth: SUB_COL_WIDTHS[3], maxWidth: SUB_COL_WIDTHS[3], textAlign: 'center', color: '#000', backgroundColor: getChangeHeatmapBg(stock.DailyChange) }}>{stock.DailyChange != null ? Number(stock.DailyChange).toFixed(1) : '--'}%</td>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[4], minWidth: SUB_COL_WIDTHS[4], maxWidth: SUB_COL_WIDTHS[4], textAlign: 'center', backgroundColor: getVolumeHeatmapBg(stock.VolumeRatio) }}>{stock.VolumeRatio != null ? stock.VolumeRatio.toFixed(1) : '--'}</td>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[5], minWidth: SUB_COL_WIDTHS[5], maxWidth: SUB_COL_WIDTHS[5], textAlign: 'center', fontWeight: 'bold', padding: 0, ...(stock.foreignSignal === 'B' ? (() => { const n = Math.min(Math.max(1, Number(stock.foreignBCount) || 1), 5); const bg = ['#E53935', '#EF5350', '#EF9A9A', '#FFCDD2', '#FFEBEE'][n - 1]; return { backgroundColor: bg, color: n <= 2 ? 'white' : '#333' }; })() : { backgroundColor: 'transparent', color: '#636e72' }) }}>
                    <div style={{ height: rowH, overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1.1 }}>
                        <div style={{ fontSize: '12px' }}>{stock.foreignSignal === 'B' ? `B${stock.foreignBCount}` : 'N'}</div>
                        {stock.foreignSignal === 'B' && <div style={{ fontSize: '7px', fontWeight: 'normal', opacity: 0.85 }}>{stock.zScore}x</div>}
                    </div>
                </td>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[6], minWidth: SUB_COL_WIDTHS[6], maxWidth: SUB_COL_WIDTHS[6], textAlign: 'center', color: stock.HoldingGrowth_M > 0 ? 'red' : 'green' }}>{stock.HoldingGrowth_M != null ? Number(stock.HoldingGrowth_M).toFixed(1) : '0'}%</td>
            </React.Fragment>
        );
    };

    return (
        <div style={{ padding: '6px', overflowX: 'auto' }}>
            
            {/* 籌碼頁：頂部產業標籤；一般頁：5 大欄無產業列 */}
            {isChipMode && (
            <div style={{ marginBottom: '10px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {categories.map(cat => (
                    <button 
                        key={cat}
                        onClick={() => {
                            const element = document.getElementById(`cat-${cat}`);
                            if (!element) return;

                            // 🟢 判斷是否為手機版 (寬度小於 768px)
                            const isMobile = window.innerWidth <= 768;

                            if (isMobile) {
                                // --- 手機版邏輯：使用原生 scrollIntoView 確保移動 ---
                                element.scrollIntoView({
                                    behavior: 'smooth',
                                    block: 'start'
                                });
                                
                            } else {
                                // --- 電腦版邏輯：維持你原本最順暢的公式 ---
                                const offset = 85; // 維持原樣
                                const bodyRect = document.body.getBoundingClientRect().top;
                                const elementRect = element.getBoundingClientRect().top;
                                const elementPosition = elementRect - bodyRect;
                                const offsetPosition = elementPosition - offset;

                                window.scrollTo({
                                    top: offsetPosition,
                                    behavior: 'smooth'
                                });
                            }
                        }}
                        style={{ 
                            padding: '2px 8px', borderRadius: '10px', border: '1px solid #64a0ddff',
                            backgroundColor: '#fff', cursor: 'pointer', fontSize: '11px', color: 'black'
                        }}
                    >
                        {cat} ({groupedData[cat].length})
                    </button>
                ))}
            </div>
            )}

            <div style={{ position: 'relative', display: 'inline-block' }}>
                {!isChipMode && Array.from({ length: NUM_BIG_COLUMNS - 1 }, (_, i) => (
                    <div
                        key={i}
                        style={{
                            position: 'absolute',
                            left: `${(i + 1) * BIG_COL_WIDTH_PX - SEP_LINE_WIDTH / 2}px`,
                            top: 0,
                            bottom: 0,
                            width: `${SEP_LINE_WIDTH}px`,
                            background: '#000',
                            pointerEvents: 'none',
                        }}
                    />
                ))}
            <table style={{ width: `${TABLE_TOTAL_WIDTH}px`, borderCollapse: 'collapse', fontSize: '12px', lineHeight: '1.15', tableLayout: 'fixed', fontWeight: 600 }}>
                {!isChipMode && (
                    <colgroup>
                        {Array.from({ length: NUM_BIG_COLUMNS }, (_, blockIndex) => (
                            <React.Fragment key={blockIndex}>
                                {SUB_COL_WIDTHS_PX.map((w, i) => <col key={`${blockIndex}-${i}`} style={{ width: `${w}px`, minWidth: `${w}px` }} />)}
                            </React.Fragment>
                        ))}
                    </colgroup>
                )}
                <thead>
                    {!isChipMode && (
                        <tr style={trStyle}>
                            {Array.from({ length: NUM_BIG_COLUMNS }, (_, i) => (
                                <th key={i} colSpan={SUB_COL_WIDTHS.length} style={{ height: rowH, maxHeight: rowH, padding: '1px 4px', border: '1px solid #b0c4de', background: '#dce8f8', boxSizing: 'border-box', fontWeight: 700, fontSize: '12px', color: '#1a3a6e', textAlign: 'center', overflow: 'hidden' }}>
                                    <input
                                        value={columnLabels[i] ?? ''}
                                        onChange={e => onColumnLabelChange?.(i, e.target.value)}
                                        placeholder={`第 ${i + 1} 欄`}
                                        style={{ width: '100%', height: '100%', border: 'none', outline: 'none', background: 'transparent', fontSize: '12px', fontWeight: 900, color: '#000', padding: 0, textAlign: 'center', cursor: 'text', boxSizing: 'border-box' }}
                                    />
                                </th>
                            ))}
                        </tr>
                    )}
                    <tr style={{ backgroundColor: '#739fe6ff', ...trStyle }}>
                        {!isChipMode && Array.from({ length: NUM_BIG_COLUMNS }, (_, blockIndex) => (
                            <React.Fragment key={blockIndex}>
                                <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[0], minWidth: SUB_COL_WIDTHS[0], maxWidth: SUB_COL_WIDTHS[0] }) }}>代號</th>
                                <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[1], minWidth: SUB_COL_WIDTHS[1], maxWidth: SUB_COL_WIDTHS[1], whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) }}>名稱</th>
                                <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[2], minWidth: SUB_COL_WIDTHS[2], maxWidth: SUB_COL_WIDTHS[2] }) }}>現價</th>
                                <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[3], minWidth: SUB_COL_WIDTHS[3], maxWidth: SUB_COL_WIDTHS[3] }) }}>漲跌</th>
                                <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[4], minWidth: SUB_COL_WIDTHS[4], maxWidth: SUB_COL_WIDTHS[4] }) }}>量</th>
                                <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[5], minWidth: SUB_COL_WIDTHS[5], maxWidth: SUB_COL_WIDTHS[5] }) }}>外資</th>
                                <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[6], minWidth: SUB_COL_WIDTHS[6], maxWidth: SUB_COL_WIDTHS[6] }) }}>月增</th>
                            </React.Fragment>
                        ))}
                        {isChipMode && (
                            <>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid #ddd', width:'38px', boxSizing: 'border-box', verticalAlign: 'middle'}}>PE</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid #ddd', width:'48px', boxSizing: 'border-box', verticalAlign: 'middle', backgroundColor: '#f8bc43ff'}}>估EPS</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid #ddd', width:'52px', boxSizing: 'border-box', verticalAlign: 'middle', backgroundColor: '#f8bc43ff'}}>目標價</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid #ddd', width:'52px', boxSizing: 'border-box', verticalAlign: 'middle' }}>潛在漲幅</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid #ddd', width:'48px', boxSizing: 'border-box', verticalAlign: 'middle' }}>前瞻PE</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid #ddd', minWidth: '60px', boxSizing: 'border-box', verticalAlign: 'middle'}}>備註</th>
                            </>
                        )}
                    </tr>
                </thead>
                {!isChipMode ? (
                    <tbody>
                        {Array.from({ length: maxRows }, (_, r) => (
                            <tr key={r} style={trStyle}>
                                {Array.from({ length: NUM_BIG_COLUMNS }, (_, c) => renderMainCellBlock(columnItems[c][r], c))}
                            </tr>
                        ))}
                    </tbody>

                ) : (
                    categories.map(cat => (
                        <tbody key={cat}>
                            <tr id={`cat-${cat}`} style={{ backgroundColor: '#afd2f5b0', scrollMarginTop: '80px', WebkitScrollMarginTop: '80px'}}>
                                <td colSpan={9} style={{ minHeight: rowH, height: rowH, padding: '2px 8px', fontWeight: 'bold', textAlign: 'left', borderLeft: '4px solid #37c5e4ff', fontSize: '10.5px', boxSizing: 'border-box', verticalAlign: 'middle' }}>
                                    {cat} (共 {groupedData[cat].length} 檔)
                                </td>
                            </tr>
                            {groupedData[cat].map(stock => (
                                <tr key={stock.id}>
                                    <td style={{ minHeight: rowH, height: rowH, padding: '1px 3px', border: '1px solid #ddd', fontWeight: 'bold', boxSizing: 'border-box', verticalAlign: 'middle' }}>{stock.id}</td>
                                    <td style={{ minHeight: rowH, height: rowH, padding: '1px 3px', border: '1px solid #ddd', width:'50px', maxWidth:'50px', boxSizing: 'border-box', verticalAlign: 'middle', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stock.name}</td>
                                    <td style={{ minHeight: rowH, height: rowH, padding: '1px 4px', border: '1px solid #ddd', textAlign: 'right', boxSizing: 'border-box', verticalAlign: 'middle' }}>{stock.displayPrice}</td>
                                    <td style={{ minHeight: rowH, height: rowH, padding: '1px 4px', border: '1px solid #ddd', textAlign: 'center', boxSizing: 'border-box', verticalAlign: 'middle'}}>{stock.realTimePE}</td>
                                    <td style={{ minHeight: rowH, height: rowH, padding: '1px 2px', border: '1px solid #ddd', boxSizing: 'border-box', verticalAlign: 'middle'}}><EditableCell initialValue={stock.displayEPS} onSave={(val) => updateStockField(stock.id, 'estimatedEPS', val)} /></td>
                                    <td style={{ minHeight: rowH, height: rowH, padding: '1px 2px', border: '1px solid #ddd', boxSizing: 'border-box', verticalAlign: 'middle'}}><EditableCell initialValue={stock.displayTarget} onSave={(val) => updateStockField(stock.id, 'targetPrice', val)} /></td>
                                    <td style={{ minHeight: rowH, height: rowH, padding: '1px 4px', border: '1px solid #ddd', textAlign: 'center', fontWeight: 'bold', color: stock.potentialUpside > 0 ? 'red' : 'green', boxSizing: 'border-box', verticalAlign: 'middle' }}>{stock.potentialUpside}%</td>
                                    <td style={{ minHeight: rowH, height: rowH, padding: '1px 4px', border: '1px solid #ddd', textAlign: 'center', boxSizing: 'border-box', verticalAlign: 'middle' }}>{stock.forwardPE}</td>
                                    <td style={{ minHeight: rowH, height: rowH, padding: '1px 2px', border: '1px solid #ddd', boxSizing: 'border-box', verticalAlign: 'middle' }}><EditableCell initialValue={stock.notes} onSave={(val) => updateStockField(stock.id, 'notes', val)} style={{textAlign: 'left'}} /></td>
                                </tr>
                            ))}
                        </tbody>
                    ))
                )}
            </table>
            </div>
        </div>
    );
};

export default IndustryAnalysisTable;