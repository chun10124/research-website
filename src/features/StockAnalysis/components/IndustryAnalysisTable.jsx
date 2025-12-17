/* src/features/StockAnalysis/components/IndustryAnalysisTable.jsx */
import React, { useState, useEffect } from 'react';
import { useStockData } from '../hooks/useStockData';
import { calculateSingleStockIndicators } from '../utils/analysisUtils';

/* 修改後的 getCurvatureStyle */
const getCurvatureStyle = (val, isShowBg) => {
    // 基礎文字顏色 (始終保持)
    const baseTextColor = val > 0 ? 'red' : val < 0 ? 'green' : '#333';
    
    // 如果不顯示背景，或數值為 0，只回傳文字顏色
    if (!isShowBg || val === 0 || val === null || val === undefined) {
        return { color: baseTextColor, backgroundColor: 'transparent' };
    }
    
    // 計算背景透明度
    const opacity = Math.min(Math.abs(val) * 0.6, 0.6);
    const bgColor = val > 0 ? `rgba(231, 76, 60, ${opacity})` : `rgba(46, 204, 113, ${opacity})`;
    
    return { 
        backgroundColor: bgColor,
        // 關鍵：如果背景太深(opacity > 0.4)，文字變白色；否則維持紅/綠字
        color: Math.abs(val) > 0.4 ? '#fff' : baseTextColor, 
        fontWeight: Math.abs(val) > 0.5 ? 'bold' : 'normal'
    };
};

const EditableCell = ({ initialValue, onSave, type = "text", style = {} }) => {
    const [localValue, setLocalValue] = useState(initialValue || '');
    useEffect(() => { setLocalValue(initialValue || ''); }, [initialValue]);
    
    return (
        <input
            type={type}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onFocus={() => setLocalValue(prev => String(prev).replace(/,/g, ''))}
            onBlur={() => {
                const rawValue = String(localValue).replace(/,/g, '');
                if (rawValue.trim() === '') { onSave(null); return; }
                const num = parseFloat(rawValue);
                if (!isNaN(num)) onSave(num); 
            }}
            style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', textAlign: 'center', padding: '4px', borderRadius: '4px', ...style }}
        />
    );
};

const IndustryAnalysisTable = () => {
    const { stocks, loading, updateStockField } = useStockData();
    const [showColor, setShowColor] = useState(true);

    if (loading) return <p>載入中... 請稍候</p>;
    
    const analysisResults = stocks.map(stock => {
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
            forwardPE,
            potentialUpside,
            calculatedStatus: indicators.calculatedStatus || '計算成功'
        };
    });

    return (
        <div style={{ padding: '10px', maxWidth: '1600px', margin: '0 auto' }}>

            {/* 🔴 2. 調整表格字體與布局 */}
            <table style={{ 
                width: '100%', borderCollapse: 'collapse', 
                fontSize: '0.82rem', // 🔴 讓字體更精緻
                minWidth: '1200px', // 🔴 稍微縮小最小寬度限制
                tableLayout: 'fixed' 
            }}>
                <thead>
                    <tr style={{ backgroundColor: '#f8f9fa' }}>
                        {/* 🔴 3. 重新分配更緊湊的欄寬 */}
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'50px' }}>代號</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'85px'}}>名稱</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px'}}>現價</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px'}}>漲跌</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>MA9</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>MA21</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>營收</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>外資週</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>持股%</th> 
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'65px'}}>EPS</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'65px'}}>目標價</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'65px' }}>漲幅</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'65px' }}>前瞻PE</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'180px' }}>筆記</th>
                        <th style={{ padding: '4px 6px', border: '1px solid #ddd', width:'65px' }}>狀態</th>
                    </tr>
                </thead>
                <tbody>
                    {analysisResults.map(stock => (
                        <tr key={stock.id} style={{ height: '32px' }}> {/* 🔴 固定行高讓表格整齊 */}
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', fontWeight: 'bold' }}>{stock.id}</td>
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stock.name}</td>
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', textAlign: 'right' }}>{stock.displayPrice}</td>
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', textAlign: 'center', color: stock.DailyChange > 0 ? 'red' : 'green' }}>{stock.DailyChange}%</td>
                            
                            {/* 加速度指標 (內容維持原樣，Padding 已縮減) */}
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', textAlign: 'center', ...getCurvatureStyle(stock.MA9Curvature, showColor) }}>{stock.MA9Curvature}</td>
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', textAlign: 'center', ...getCurvatureStyle(stock.MA21Curvature, showColor) }}>{stock.MA21Curvature}</td>
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', textAlign: 'center', ...getCurvatureStyle(stock.RevenueYoYCurvature, showColor) }}>{stock.RevenueYoYCurvature}</td>
                            
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', textAlign: 'right', color: stock.WeeklyChipFlow > 0 ? 'red' : 'green'}}>{stock.displayWeeklyFlow}</td>
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', textAlign: 'right', color: stock.HoldingGrowth_M > 0 ? 'red' : 'green'}}>{stock.HoldingGrowth_M}%</td>

                            <td style={{ padding: '2px', border: '1px solid #ddd' }}>
                                <EditableCell initialValue={stock.displayEPS} onSave={(val) => updateStockField(stock.id, 'estimatedEPS', val)} style={{fontSize:'13px'}}/>
                            </td>
                            <td style={{ padding: '2px', border: '1px solid #ddd' }}>
                                <EditableCell initialValue={stock.displayTarget} onSave={(val) => updateStockField(stock.id, 'targetPrice', val)} style={{fontSize:'13px'}} />
                            </td>
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', textAlign: 'center', fontWeight: 'bold', color: stock.potentialUpside > 0 ? 'red' : 'green' }}>
                                {stock.potentialUpside}%
                            </td>
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', textAlign: 'center' }}>{stock.forwardPE}</td>
                            <td style={{ padding: '2px', border: '1px solid #ddd' }}>
                                <EditableCell initialValue={stock.notes} onSave={(val) => updateStockField(stock.id, 'notes', val)} style={{textAlign: 'left', fontSize:'13px'}} />
                            </td>
                            <td style={{ padding: '4px 6px', border: '1px solid #ddd', fontSize: '13px', color: '#999' }}>{stock.calculatedStatus}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {/* 調整開關 UI 大小 */}
            <div style={{ marginBottom: '10px', display: 'flex', alignItems: 'center' }}>
                <label style={{ 
                    cursor: 'pointer', display: 'flex', alignItems: 'center', 
                    fontSize: '12px', padding: '4px 10px', backgroundColor: showColor ? '#e8f4fd' : '#f5f5f5',
                    borderRadius: '15px'
                }}>
                    <input type="checkbox" checked={showColor} onChange={() => setShowColor(!showColor)} style={{ marginRight: '5px' }}/>
                    熱力圖：{showColor ? '開' : '關'}
                </label>
            </div>

        </div>
    );
};

export default IndustryAnalysisTable;