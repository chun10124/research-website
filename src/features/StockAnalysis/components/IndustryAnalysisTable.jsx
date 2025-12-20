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
                const num = isNaN(parseFloat(rawValue)) ? rawValue : parseFloat(rawValue);
                onSave(num); 
            }}
            style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', textAlign: 'center', padding: '4px', borderRadius: '4px', boxSizing: 'border-box', minWidth: '0', ...style }}
        />
    );
};

const IndustryAnalysisTable = ({ stocks = [], updateStockField, refreshData, loading }) => {
    const [showColor, setShowColor] = useState(true);

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
            displayPrice: formatNumber(price, 1),
            displayWeeklyFlow: formatNumber(indicators.WeeklyChipFlow, 0),
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

    return (
        <div style={{ padding: '10px', maxWidth: '1600px', margin: '0 auto' }}>
            
            {/* 🟢 頂部產業標籤 (點擊可快速跳轉) */}
            <div style={{ marginBottom: '15px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {categories.map(cat => (
                    <button 
                        key={cat}
                        JavaScript
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
                            padding: '4px 12px', borderRadius: '15px', border: '1px solid #64a0ddff',
                            backgroundColor: '#fff', cursor: 'pointer', fontSize: '12px', color: 'black'
                        }}
                    >
                        {cat} ({groupedData[cat].length})
                    </button>
                ))}
            </div>

            <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '11.5px', lineHeight: '1.2', minWidth: '1200px', tableLayout: 'fixed' }}>
                <thead>
                    <tr style={{ backgroundColor: '#739fe6ff' }}>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'50px' }}>代號</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'95px'}}>名稱</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px'}}>產業</th> {/* 🟢 新增欄位 */}
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px'}}>現價</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px'}}>漲跌</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px'}}>PE</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>MA9</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>MA21</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>月營收</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>外資週</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>外資持股</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', backgroundColor: '#f8bc43ff'}}>估EPS</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', backgroundColor: '#f8bc43ff'}}>目標價</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>潛在漲幅</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>前瞻PE</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd'}}>備註</th>
                    </tr>
                </thead>

                {categories.map(cat => (
                    <tbody key={cat}>
                        {/* 🟢 產業分組標題列 */}
                        <tr id={`cat-${cat}`} style={{ backgroundColor: '#afd2f5b0', scrollMarginTop: '80px', WebkitScrollMarginTop: '80px'}}>
                            <td colSpan="16" style={{ padding: '8px 12px', fontWeight: 'bold', textAlign: 'left', borderLeft: '4px solid #37c5e4ff' }}>
                                {cat} (共 {groupedData[cat].length} 檔)
                            </td>
                        </tr>
                        
                        {groupedData[cat].map(stock => (
                            <tr key={stock.id} style={{ height: '22px' }}>
                                <td style={{ padding: '2px 4px', border: '1px solid #ddd', fontWeight: 'bold' }}>{stock.id}</td>
                                <td style={{ padding: '2px 4px', border: '1px solid #ddd' }}>{stock.name}</td>
                                
                                {/* 🟢 產業類別編輯：改完會自動跳到對的分組 */}
                                <td style={{ padding: '2px', border: '1px solid #ddd' }}>
                                    <EditableCell 
                                        initialValue={stock.category} 
                                        onSave={(val) => updateStockField(stock.id, 'category', val)} 
                                        style={{fontSize:'12px', color:'#666'}}
                                    />
                                </td>

                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'right' }}>{stock.displayPrice}</td>
                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'center', color: stock.DailyChange > 0 ? 'red' : 'green' }}>{stock.DailyChange}%</td>
                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'center'}}>{stock.realTimePE}</td>
                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'center', ...getCurvatureStyle(stock.MA9Curvature, showColor) }}>{stock.MA9Curvature}</td>
                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'center', ...getCurvatureStyle(stock.MA21Curvature, showColor) }}>{stock.MA21Curvature}</td>
                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'center', ...getCurvatureStyle(stock.RevenueYoYCurvature, showColor) }}>{stock.RevenueYoYCurvature}</td>
                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'right', color: stock.WeeklyChipFlow > 0 ? 'red' : 'green'}}>{stock.displayWeeklyFlow}</td>
                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'center', color: stock.HoldingGrowth_M > 0 ? 'red' : 'green' }}>
                                    {stock.displayHoldingGrowth}%
                                </td>
                                <td style={{ padding: '2px', border: '1px solid #ddd', width: '65px'}}>
                                    <EditableCell initialValue={stock.displayEPS} onSave={(val) => updateStockField(stock.id, 'estimatedEPS', val)} style={{fontSize:'11.5px'}}/>
                                </td>
                                <td style={{ padding: '2px', border: '1px solid #ddd', width: '65px'}}>
                                    <EditableCell initialValue={stock.displayTarget} onSave={(val) => updateStockField(stock.id, 'targetPrice', val)} style={{fontSize:'11.5px'}} />
                                </td>
                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'center', fontWeight: 'bold', color: stock.potentialUpside > 0 ? 'red' : 'green' }}>{stock.potentialUpside}%</td>
                                <td style={{ padding: '2px 6px', border: '1px solid #ddd', textAlign: 'center' }}>{stock.forwardPE}</td>
                                <td style={{ padding: '2px', border: '1px solid #ddd' }}>
                                    <EditableCell initialValue={stock.notes} onSave={(val) => updateStockField(stock.id, 'notes', val)} style={{textAlign: 'left', fontSize:'11.5px'}} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                ))}
            </table>
        </div>
    );
};

export default IndustryAnalysisTable;