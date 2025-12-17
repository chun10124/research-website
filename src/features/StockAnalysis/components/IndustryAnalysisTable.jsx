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
        <div style={{ padding: '20px', maxWidth: '1600px', margin: '0 auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em', minWidth: '1400px', tableLayout: 'fixed' }}>
                <thead>
                    <tr style={{ backgroundColor: '#f2f2f2' }}>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'55px' }}>代號</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'90px'}}>名稱</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'80px'}}>現價</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'80px'}}>漲跌</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'80px' }}>MA9加速</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'80px' }}>MA21加速</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'80px' }}>營收加速</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'80px' }}>外資週買賣</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'80px' }}>持股月增率</th> 
                        <th style={{ padding: '8px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'80px'}}>預估EPS</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'80px'}}>目標價</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'80px' }}>潛在漲幅</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'80px' }}>前瞻PE</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', backgroundColor: '#e8f4fd', width:'200px' }}>筆記</th>
                        <th style={{ padding: '8px', border: '1px solid #ddd', width:'80px' }}>狀態</th>
                    </tr>
                </thead>
                <tbody>
                    {analysisResults.map(stock => (
                        <tr key={stock.id}>
                            <td style={{ padding: '8px', border: '1px solid #ddd', fontWeight: 'bold' }}>{stock.id}</td>
                            <td style={{ padding: '8px', border: '1px solid #ddd' }}>{stock.name || 'N/A'}</td>
                            <td style={{ padding: '8px', border: '1px solid #ddd', textAlign: 'right' }}>{stock.displayPrice}</td>
                            <td style={{ padding: '8px', border: '1px solid #ddd', textAlign: 'center', color: stock.DailyChange > 0 ? 'red' : 'green' }}>
                                {stock.DailyChange !== null ? `${stock.DailyChange}%` : '0.00%'}
                            </td>

                            {/* 3. 根據 showColor 決定是否套用 getCurvatureStyle */}
                            {/* MA9 加速 */}
                            <td style={{ 
                                padding: '8px', border: '1px solid #ddd', textAlign: 'center', 
                                ...getCurvatureStyle(stock.MA9Curvature, showColor) 
                            }}>{stock.MA9Curvature}</td>

                            {/* MA21 加速 */}
                            <td style={{ 
                                padding: '8px', border: '1px solid #ddd', textAlign: 'center', 
                                ...getCurvatureStyle(stock.MA21Curvature, showColor) 
                            }}>{stock.MA21Curvature}</td>

                            {/* 營收加速 */}
                            <td style={{ 
                                padding: '8px', border: '1px solid #ddd', textAlign: 'center', 
                                ...getCurvatureStyle(stock.RevenueYoYCurvature, showColor) 
                            }}>{stock.RevenueYoYCurvature}</td>
                            
                            {/* 外資週買賣 - 永遠維持紅綠字 */}
                            <td style={{ 
                                padding: '8px', border: '1px solid #ddd', textAlign: 'right', 
                                color: stock.WeeklyChipFlow > 0 ? 'red' : stock.WeeklyChipFlow < 0 ? 'green' : '#333'
                            }}>{stock.displayWeeklyFlow}</td>

                            {/* 持股增率 - 永遠維持紅綠字 */}
                            <td style={{ 
                                padding: '8px', border: '1px solid #ddd', textAlign: 'right', 
                                color: stock.HoldingGrowth_M > 0 ? 'red' : stock.HoldingGrowth_M < 0 ? 'green' : '#333'
                            }}>{stock.HoldingGrowth_M}%</td>

                            <td style={{ padding: '4px', border: '1px solid #ddd' }}>
                                <EditableCell initialValue={stock.displayEPS} onSave={(val) => updateStockField(stock.id, 'estimatedEPS', val)} style={{fontSize: '14px'}}/>
                            </td>
                            <td style={{ padding: '4px', border: '1px solid #ddd' }}>
                                <EditableCell initialValue={stock.displayTarget} onSave={(val) => updateStockField(stock.id, 'targetPrice', val)} style={{fontSize: '14px'}} />
                            </td>
                            <td style={{ padding: '8px', border: '1px solid #ddd', textAlign: 'center', fontWeight: 'bold', color: stock.potentialUpside > 0 ? 'red' : 'green' }}>
                                {stock.potentialUpside !== null ? `${stock.potentialUpside}%` : '--'}
                            </td>
                            <td style={{ padding: '8px', border: '1px solid #ddd', textAlign: 'center' }}>{stock.forwardPE}</td>
                            <td style={{ padding: '4px', border: '1px solid #ddd' }}>
                                <EditableCell initialValue={stock.notes} onSave={(val) => updateStockField(stock.id, 'notes', val)} style={{textAlign: 'left',fontSize: '14px'}} />
                            </td>
                            <td style={{ padding: '8px', border: '1px solid #ddd', fontSize: '12px' }}>{stock.calculatedStatus}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {/* 2. 顏色切換開關 UI */}
            <div style={{ marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <label style={{ 
                    cursor: 'pointer', 
                    display: 'flex', 
                    alignItems: 'center', 
                    fontSize: '14px',
                    fontWeight: 'bold',
                    padding: '6px 12px',
                    backgroundColor: showColor ? '#e8f4fd' : '#f5f5f5',
                    borderRadius: '20px',
                    transition: 'all 0.3s'
                }}>
                    <input 
                        type="checkbox" 
                        checked={showColor} 
                        onChange={() => setShowColor(!showColor)} 
                        style={{ marginRight: '8px', cursor: 'pointer' }}
                    />
                    指標熱力圖顯示：{showColor ? '開啟' : '關閉'}
                </label>
            </div>
        </div>
    );
};

export default IndustryAnalysisTable;