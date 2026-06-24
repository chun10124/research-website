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

// 量比熱力圖：量縮藍、約 1 中性(透明)、量增黃/琥珀。回傳 { bg, fg }（與 getChangeHeatmap 同構）。
// 中性/缺值用 transparent 融入表格（暗色不再出現整排刺眼白塊，原本量比≈1 是純白）；
// 有色塊永遠淺底、文字固定深色，暗色才不會淺字疊淺底。HSL + gamma 讓小量增/量減也看得出色，
// 且最深仍夠淺、深字可讀。
const getVolumeHeatmap = (ratio) => {
    const v = Number(ratio);
    if (ratio == null || !isFinite(v) || (v >= 0.98 && v <= 1.05)) return { bg: 'transparent', fg: 'var(--app-text-soft)' };
    const lerp = (a, b, t) => a + (b - a) * t;
    if (v < 0.98) { // 量縮（藍）
        const t = Math.pow(Math.min((0.98 - v) / 0.98, 1), 0.62);
        return { bg: `hsl(${lerp(206, 214, t).toFixed(1)}, ${lerp(60, 92, t).toFixed(1)}%, ${lerp(92, 66, t).toFixed(1)}%)`, fg: '#111827' };
    }
    // 量增（黃/琥珀）
    const t = Math.pow(Math.min((v - 1.05) / 2, 1), 0.62);
    return { bg: `hsl(${lerp(46, 40, t).toFixed(1)}, ${lerp(92, 98, t).toFixed(1)}%, ${lerp(93, 64, t).toFixed(1)}%)`, fg: '#111827' };
};

// 漲跌熱力色階（方案A 鮮明）：HSL 插值避免中段發灰，gamma 0.62 讓小漲跌也可見
// 台股慣例：紅漲綠跌。回傳 { bg, fg }，fg 為對應文字色。
const getChangeHeatmap = (changePercent) => {
    const v = Number(changePercent) || 0;
    if (v === 0) return { bg: 'transparent', fg: null };
    const lerp = (a, b, t) => a + (b - a) * t;
    const abs = Math.min(Math.abs(v), 10);
    const t = Math.pow(abs / 10, 0.62);
    // 漲（紅）h 354→352, s 80→66, l 96→47 ; 跌（綠）h 145→150, s 46→52, l 95→36
    const c = v > 0
        ? { h0: 354, h1: 352, s0: 80, s1: 66, l0: 96, l1: 47 }
        : { h0: 145, h1: 150, s0: 46, s1: 52, l0: 95, l1: 36 };
    const h = lerp(c.h0, c.h1, t);
    const s = lerp(c.s0, c.s1, t);
    const l = lerp(c.l0, c.l1, t);
    const bg = `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
    // 背景永遠是淺色階（為亮色設計），文字固定用深色，暗色模式才不會淺字疊淺底而看不見
    const fg = '#111827';
    return { bg, fg };
};

// 相容舊呼叫：只取背景色
const getChangeHeatmapBg = (changePercent) => getChangeHeatmap(changePercent).bg;

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
const IndustryAnalysisTable = ({ stocks = [], updateStockField, refreshData, loading, columnsMode = 'main', bigColumnConfig = {}, columnLabels = [], onColumnLabelChange, onStockNameClick, onFlowDotClick }) => {
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

    const categories = Object.keys(groupedData).sort((a, b) => {
        if (a === '自選') return -1;
        if (b === '自選') return 1;
        return a.localeCompare(b, 'zh-TW');
    });
    const ROW_H = 22;
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

    const thStyle = (extra = {}) => ({ height: rowH, maxHeight: rowH, padding: '2px 4px', border: '1px solid var(--app-border)', boxSizing: 'border-box', verticalAlign: 'middle', overflow: 'hidden', ...extra });
    const tdBase = { height: rowH, maxHeight: rowH, padding: '1px 4px', border: '1px solid var(--app-border)', boxSizing: 'border-box', verticalAlign: 'middle', overflow: 'hidden' };

    // 44+44+50+52+42+42+50+40 = 364px per big column
    const SUB_COL_WIDTHS_PX = [44, 44, 50, 52, 42, 42, 50, 40];
    const SUB_COL_WIDTHS = SUB_COL_WIDTHS_PX.map(w => `${w}px`);
    const BIG_COL_WIDTH_PX = SUB_COL_WIDTHS_PX.reduce((a, b) => a + b, 0);
    const TABLE_TOTAL_WIDTH = NUM_BIG_COLUMNS * BIG_COL_WIDTH_PX;
    const SEP_LINE_WIDTH = 1;

    // 流量累積張數格式化（單位：張）
    const fmtFlow = (cum) => {
        if (cum == null || cum === 0) return '';
        const abs = Math.abs(cum);
        const sign = cum >= 0 ? '+' : '-';
        if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}萬`;
        if (abs >= 1000)  return `${sign}${(abs / 1000).toFixed(1)}k`;
        return `${sign}${abs}`;
    };

    const GROUP_BORDER = '2px solid var(--app-border)';
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
                    <td colSpan={SUB_COL_WIDTHS.length} style={{ ...tdBase, height: '32px', maxHeight: '32px', verticalAlign: 'middle', width: `${BIG_COL_WIDTH_PX}px`, maxWidth: `${BIG_COL_WIDTH_PX}px`, padding: '2px 6px', background: 'var(--app-th-bg)', border: 'none', borderTop: GROUP_BORDER, borderBottom: '1px solid var(--app-border)', fontWeight: 'bold', fontSize: '12.5px', color: 'var(--app-text)', letterSpacing: '0.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.cat}
                    </td>
                </React.Fragment>
            );
        }
        const stock = item;
        return (
            <React.Fragment key={blockIndex}>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[0], minWidth: SUB_COL_WIDTHS[0], maxWidth: SUB_COL_WIDTHS[0], padding: '1px 3px', fontWeight: 'bold' }}>{stock.code ?? stock.id}</td>
                <td
                    style={{
                        ...tdBase,
                                                width: SUB_COL_WIDTHS[1],
                        minWidth: SUB_COL_WIDTHS[1],
                        maxWidth: SUB_COL_WIDTHS[1],
                        padding: '1px 3px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        cursor: onStockNameClick ? 'pointer' : undefined,
                    }}
                    onClick={() => onStockNameClick?.(stock)}
                    title={stock.name || undefined}
                >
                    {stock.name}
                </td>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[2], minWidth: SUB_COL_WIDTHS[2], maxWidth: SUB_COL_WIDTHS[2], textAlign: 'right', whiteSpace: 'nowrap' }}>{stock.displayPrice}</td>
                {(() => { const hm = getChangeHeatmap(stock.DailyChange); return (
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[3], minWidth: SUB_COL_WIDTHS[3], maxWidth: SUB_COL_WIDTHS[3], textAlign: 'center', color: hm.fg ?? '#888', whiteSpace: 'nowrap', backgroundColor: hm.bg }}>{stock.DailyChange != null ? Number(stock.DailyChange).toFixed(1) : '--'}%</td>
                ); })()}
                {(() => { const vh = getVolumeHeatmap(stock.VolumeRatio); return (
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[4], minWidth: SUB_COL_WIDTHS[4], maxWidth: SUB_COL_WIDTHS[4], textAlign: 'center', color: vh.fg, backgroundColor: vh.bg }}>{stock.VolumeRatio != null ? stock.VolumeRatio.toFixed(1) : '--'}</td>
                ); })()}
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[5], minWidth: SUB_COL_WIDTHS[5], maxWidth: SUB_COL_WIDTHS[5], textAlign: 'center', fontWeight: 'bold', padding: 0, ...(stock.foreignSignal === 'B' ? (() => { const n = Math.min(Math.max(1, Number(stock.foreignBCount) || 1), 5); const l = [46, 56, 68, 81, 90][n - 1]; const s = [68, 66, 62, 58, 55][n - 1]; return { backgroundColor: `hsl(354, ${s}%, ${l}%)`, color: l < 58 ? '#fff' : 'hsl(354, 50%, 30%)' }; })() : { backgroundColor: 'transparent', color: 'var(--app-text-soft)' }) }}>
                    <div style={{ height: rowH, overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1.1 }}>
                        <div style={{ fontSize: '12px' }}>{stock.foreignSignal === 'B' ? `B${stock.foreignBCount}` : 'N'}</div>
                        {stock.foreignSignal === 'B' && <div style={{ fontSize: '7px', fontWeight: 'normal', opacity: 0.85 }}>{stock.zScore}x</div>}
                    </div>
                </td>
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[6], minWidth: SUB_COL_WIDTHS[6], maxWidth: SUB_COL_WIDTHS[6], textAlign: 'center', color: stock.HoldingGrowth_M > 0 ? 'hsl(8, 76%, 48%)' : 'hsl(150, 52%, 34%)' }}>{stock.HoldingGrowth_M != null ? Number(stock.HoldingGrowth_M).toFixed(0) : '0'}%</td>
                {/* 流量預警（外資 🟠 + 投信 🟣 合併欄，hover 看細節） */}
                {(() => {
                    // active=實色大點，persist=訊號消退仍持續實色，day1=空心小點，無訊號=不渲染
                    const fActive  = stock.foreignFlowActive;
                    const fPersist = !fActive && (stock.foreignFlowPersist > 0);
                    const fWatch   = !fActive && !fPersist && stock.foreignFlowDays === 1;
                    const tActive  = stock.trustFlowActive;
                    const tPersist = !tActive && (stock.trustFlowPersist > 0);
                    const tWatch   = !tActive && !tPersist && stock.trustFlowDays === 1;
                    const tip = [
                        fActive  ? `外資: ${stock.foreignFlowDays}d ${fmtFlow(stock.foreignFlowCum)}張`
                                 : fPersist ? `外資: 訊號消退中` : null,
                        tActive  ? `投信: ${stock.trustFlowDays}d ${fmtFlow(stock.trustFlowCum)}張`
                                 : tPersist ? `投信: 訊號消退中` : null,
                    ].filter(Boolean).join('\n');
                    const anySignal = fActive || fPersist || fWatch || tActive || tPersist || tWatch;
                    const dot = (active, persist, watch, activeColor, days, cum, persistRemaining, label) => {
                        if (!active && !persist && !watch) return null;
                        const msg = active
                            ? `${label}已連續 ${days} 天大買，累積買超 ${Math.abs(cum).toLocaleString()} 張`
                            : persist
                            ? `${label}訊號消退中`
                            : `${label}今天出現異常大買，若明天持續將觸發預警`;
                        const style = (active || persist)
                            ? { width: 7, height: 7, borderRadius: '50%', backgroundColor: activeColor, display: 'inline-block', flexShrink: 0, cursor: 'pointer' }
                            : { width: 7, height: 7, borderRadius: '50%', border: `2px solid ${activeColor}`, display: 'inline-block', flexShrink: 0, cursor: 'pointer' };
                        return <span style={style} onClick={e => { e.stopPropagation(); onFlowDotClick ? onFlowDotClick(stock, msg) : alert(msg); }} />;
                    };
                    return (
                        <td title={anySignal ? tip : undefined} style={{ ...tdBase, width: SUB_COL_WIDTHS[7], minWidth: SUB_COL_WIDTHS[7], maxWidth: SUB_COL_WIDTHS[7], textAlign: 'center', padding: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '3px', height: rowH }}>
                                {dot(fActive, fPersist, fWatch, '#1565c0', stock.foreignFlowDays, stock.foreignFlowCum, stock.foreignFlowPersist, '外資')}
                                {dot(tActive, tPersist, tWatch, '#16a34a', stock.trustFlowDays,   stock.trustFlowCum,   stock.trustFlowPersist,   '投信')}
                            </div>
                        </td>
                    );
                })()}
            </React.Fragment>
        );
    };

    return (
        <div style={{ padding: '6px', zoom: 0.9 }}>
            
            {/* 籌碼頁：頂部產業標籤；一般頁：多欄並排、無獨立產業列（產業標題在表格內各欄） */}
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
                            backgroundColor: 'var(--app-surface)', cursor: 'pointer', fontSize: '11px', color: 'var(--app-text)'
                        }}
                    >
                        {cat} ({groupedData[cat].length})
                    </button>
                ))}
            </div>
            )}

            {!isChipMode ? (
                <div style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 0 }}>
                    {columnItems.map((items, c) => (
                        <div key={c} style={{ flex: '0 0 auto', marginLeft: c > 0 ? '-2px' : 0, border: '2px solid var(--app-border)' }}>
                            <table style={{ width: `${BIG_COL_WIDTH_PX}px`, borderCollapse: 'collapse', fontSize: '12px', lineHeight: '1.15', tableLayout: 'fixed', fontWeight: 600, display: 'table', overflow: 'visible', margin: 0 }}>
                                <colgroup>
                                    {SUB_COL_WIDTHS_PX.map((w, i) => <col key={i} style={{ width: `${w}px`, minWidth: `${w}px` }} />)}
                                </colgroup>
                                <thead>
                                    <tr style={{ ...trStyle, height: '36px', maxHeight: '36px' }}>
                                        <th colSpan={SUB_COL_WIDTHS.length} style={{ height: '36px', maxHeight: '36px', padding: '2px 8px', border: 'none', borderBottom: '2px solid var(--app-border)', background: 'var(--app-surface)', boxSizing: 'border-box', fontWeight: 700, fontSize: '15px', color: 'var(--app-text)', textAlign: 'left', overflow: 'hidden' }}>
                                            <input
                                                value={columnLabels[c] ?? ''}
                                                onChange={e => onColumnLabelChange?.(c, e.target.value)}
                                                placeholder={`第 ${c + 1} 欄`}
                                                style={{ width: '100%', height: '100%', border: 'none', outline: 'none', background: 'transparent', fontSize: '15px', fontWeight: 700, color: 'var(--app-text)', padding: 0, textAlign: 'left', cursor: 'text', boxSizing: 'border-box' }}
                                            />
                                        </th>
                                    </tr>
                                    <tr style={{ backgroundColor: 'var(--app-surface)', color: '#8a8a8a', fontWeight: 500, ...trStyle }}>
                                        <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[0], minWidth: SUB_COL_WIDTHS[0], maxWidth: SUB_COL_WIDTHS[0] }) }}>代號</th>
                                        <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[1], minWidth: SUB_COL_WIDTHS[1], maxWidth: SUB_COL_WIDTHS[1], whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) }}>名稱</th>
                                        <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[2], minWidth: SUB_COL_WIDTHS[2], maxWidth: SUB_COL_WIDTHS[2] }) }}>現價</th>
                                        <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[3], minWidth: SUB_COL_WIDTHS[3], maxWidth: SUB_COL_WIDTHS[3] }) }}>漲跌</th>
                                        <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[4], minWidth: SUB_COL_WIDTHS[4], maxWidth: SUB_COL_WIDTHS[4] }) }}>量</th>
                                        <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[5], minWidth: SUB_COL_WIDTHS[5], maxWidth: SUB_COL_WIDTHS[5] }) }}>外資</th>
                                        <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[6], minWidth: SUB_COL_WIDTHS[6], maxWidth: SUB_COL_WIDTHS[6] }) }}>月增</th>
                                        <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[7], minWidth: SUB_COL_WIDTHS[7], maxWidth: SUB_COL_WIDTHS[7] }) }}>法人</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {items.map((item, r) => (
                                        <tr key={r} style={item._isHeader ? { ...trStyle, height: '32px', maxHeight: '32px' } : trStyle}>
                                            {renderMainCellBlock(item, c)}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ))}
                </div>
            ) : (
                <div style={{ position: 'relative', display: 'inline-block' }}>
                    <table style={{ borderCollapse: 'collapse', fontSize: '12px', lineHeight: '1.15', tableLayout: 'fixed', fontWeight: 600, display: 'table', overflow: 'visible' }}>
                        <thead>
                            <tr style={{ backgroundColor: 'var(--app-surface)', color: '#8a8a8a', fontWeight: 500, ...trStyle }}>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid var(--app-border)', width:'38px', boxSizing: 'border-box', verticalAlign: 'middle'}}>PE</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid var(--app-border)', width:'48px', boxSizing: 'border-box', verticalAlign: 'middle', backgroundColor: '#f8bc43ff'}}>估EPS</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid var(--app-border)', width:'52px', boxSizing: 'border-box', verticalAlign: 'middle', backgroundColor: '#f8bc43ff'}}>目標價</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid var(--app-border)', width:'52px', boxSizing: 'border-box', verticalAlign: 'middle' }}>潛在漲幅</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid var(--app-border)', width:'48px', boxSizing: 'border-box', verticalAlign: 'middle' }}>前瞻PE</th>
                                <th style={{ minHeight: rowH, height: rowH, padding: '2px 4px', border: '1px solid var(--app-border)', minWidth: '60px', boxSizing: 'border-box', verticalAlign: 'middle'}}>備註</th>
                            </tr>
                        </thead>
                        {categories.map(cat => (
                            <tbody key={cat}>
                                <tr id={`cat-${cat}`} style={{ backgroundColor: 'var(--app-th-bg)', scrollMarginTop: '80px', WebkitScrollMarginTop: '80px'}}>
                                    <td colSpan={9} style={{ minHeight: rowH, height: rowH, padding: '2px 8px', fontWeight: 'bold', textAlign: 'left', borderLeft: '4px solid #37c5e4ff', fontSize: '10.5px', boxSizing: 'border-box', verticalAlign: 'middle' }}>
                                        {cat} (共 {groupedData[cat].length} 檔)
                                    </td>
                                </tr>
                                {groupedData[cat].map(stock => (
                                    <tr key={stock.id}>
                                        <td style={{ minHeight: rowH, height: rowH, padding: '1px 3px', border: '1px solid var(--app-border)', fontWeight: 'bold', boxSizing: 'border-box', verticalAlign: 'middle' }}>{stock.code ?? stock.id}</td>
                                        <td
                                            style={{
                                                minHeight: rowH,
                                                height: rowH,
                                                padding: '1px 3px',
                                                border: '1px solid var(--app-border)',
                                                width:'50px',
                                                maxWidth:'50px',
                                                boxSizing: 'border-box',
                                                verticalAlign: 'middle',
                                                whiteSpace: 'nowrap',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                cursor: onStockNameClick ? 'pointer' : undefined,
                                            }}
                                            onClick={() => onStockNameClick?.(stock)}
                                            title={stock.name || undefined}
                                        >
                                            {stock.name}
                                        </td>
                                        <td style={{ minHeight: rowH, height: rowH, padding: '1px 4px', border: '1px solid var(--app-border)', textAlign: 'right', boxSizing: 'border-box', verticalAlign: 'middle' }}>{stock.displayPrice}</td>
                                        <td style={{ minHeight: rowH, height: rowH, padding: '1px 4px', border: '1px solid var(--app-border)', textAlign: 'center', boxSizing: 'border-box', verticalAlign: 'middle'}}>{stock.realTimePE}</td>
                                        <td style={{ minHeight: rowH, height: rowH, padding: '1px 2px', border: '1px solid var(--app-border)', boxSizing: 'border-box', verticalAlign: 'middle'}}><EditableCell initialValue={stock.displayEPS} onSave={(val) => updateStockField(stock.id, 'estimatedEPS', val)} /></td>
                                        <td style={{ minHeight: rowH, height: rowH, padding: '1px 2px', border: '1px solid var(--app-border)', boxSizing: 'border-box', verticalAlign: 'middle'}}><EditableCell initialValue={stock.displayTarget} onSave={(val) => updateStockField(stock.id, 'targetPrice', val)} /></td>
                                        <td style={{ minHeight: rowH, height: rowH, padding: '1px 4px', border: '1px solid var(--app-border)', textAlign: 'center', fontWeight: 'bold', color: stock.potentialUpside > 0 ? 'red' : 'green', boxSizing: 'border-box', verticalAlign: 'middle' }}>{stock.potentialUpside}%</td>
                                        <td style={{ minHeight: rowH, height: rowH, padding: '1px 4px', border: '1px solid var(--app-border)', textAlign: 'center', boxSizing: 'border-box', verticalAlign: 'middle' }}>{stock.forwardPE}</td>
                                        <td style={{ minHeight: rowH, height: rowH, padding: '1px 2px', border: '1px solid var(--app-border)', boxSizing: 'border-box', verticalAlign: 'middle' }}><EditableCell initialValue={stock.notes} onSave={(val) => updateStockField(stock.id, 'notes', val)} style={{textAlign: 'left'}} /></td>
                                    </tr>
                                ))}
                            </tbody>
                        ))}
                    </table>
                </div>
            )}
        </div>
    );
};

export default IndustryAnalysisTable;