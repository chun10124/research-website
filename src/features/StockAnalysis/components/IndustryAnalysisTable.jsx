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

// 基準欄色階：跌藍、漲琥珀，與旁邊漲跌欄的紅綠區隔；±30% 到頂。有色塊永遠淺底、文字固定深色，暗色才看得到字
const getBaseHeatmap = (pct) => {
    const v = Number(pct);
    if (pct == null || !isFinite(v) || v === 0) return { bg: 'transparent', fg: 'var(--app-text-soft)' };
    const lerp = (a, b, t) => a + (b - a) * t;
    const t = Math.pow(Math.min(Math.abs(v), 30) / 30, 0.62);
    if (v < 0) return { bg: `hsl(${lerp(206, 214, t).toFixed(1)}, ${lerp(60, 92, t).toFixed(1)}%, ${lerp(92, 66, t).toFixed(1)}%)`, fg: '#111827' };
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

const IndustryAnalysisTable = ({ stocks = [], refreshData, loading, bigColumnConfig = {}, columnLabels = [], onColumnLabelChange, baseDate = '', baseChangeByCode = {}, onStockNameClick, onFlowDotClick }) => {
    const [showColor, setShowColor] = useState(true);

    if (loading && stocks.length === 0) return <p>載入中... 請稍候</p>;

    // 🟢 步驟 1: 處理所有股票的數據計算
    const processedStocks = stocks.map(stock => {
        const indicators = calculateSingleStockIndicators(stock);
        const price = parseFloat(stock.currentPrice) || 0;

        const formatNumber = (num, digits = 0) => {
            if (num === null || num === undefined || isNaN(num) || num === 0) return ''; 
            return Number(num).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
        };

        return {
            ...stock,
            ...indicators,
            displayPrice: formatNumber(price, 0),
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
    const ROW_H = 21;
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

    // 44+44+50+46+46+40 = 270px per big column
    const SUB_COL_WIDTHS_PX = [44, 44, 50, 46, 46, 40];
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
    // 漲跌／基準：只把數字本體置中（漲跌 ±10.0 顯示成 ±10，與 9.9 同寬），負號掛在左邊不佔寬度 → 有沒有負號，數字都在格子正中間
    const numBox = (text) => {
        const t = String(text);
        const neg = t.startsWith('-') && t !== '--';
        return (
            <span style={{ position: 'relative', fontVariantNumeric: 'tabular-nums' }}>
                {neg && <span style={{ position: 'absolute', right: '100%' }}>-</span>}
                {neg ? t.slice(1) : t}
            </span>
        );
    };
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
                <td style={{ ...tdBase, width: SUB_COL_WIDTHS[3], minWidth: SUB_COL_WIDTHS[3], maxWidth: SUB_COL_WIDTHS[3], textAlign: 'center', padding: '1px 0', color: hm.fg ?? '#888', whiteSpace: 'nowrap', backgroundColor: hm.bg }}>{numBox(stock.DailyChange != null ? Number(stock.DailyChange).toFixed(1).replace(/^(-?10)\.0$/, '$1') : '--')}</td>
                ); })()}
                {(() => {
                    const bc = baseChangeByCode[String(stock.code ?? stock.id)];
                    const has = bc != null && isFinite(bc);
                    const hm = getBaseHeatmap(has ? bc : null);
                    return (
                <td title={baseDate ? `${baseDate} 起` : '未設定基準日'} style={{ ...tdBase, width: SUB_COL_WIDTHS[4], minWidth: SUB_COL_WIDTHS[4], maxWidth: SUB_COL_WIDTHS[4], textAlign: 'center', padding: '1px 0', color: hm.fg, whiteSpace: 'nowrap', backgroundColor: hm.bg }}>{has ? numBox(bc.toFixed(Math.abs(bc) >= 100 ? 0 : 1)) : (baseDate ? '--' : '')}</td>
                ); })()}
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
                        <td title={anySignal ? tip : undefined} style={{ ...tdBase, width: SUB_COL_WIDTHS[5], minWidth: SUB_COL_WIDTHS[5], maxWidth: SUB_COL_WIDTHS[5], textAlign: 'center', padding: 0 }}>
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
                                    <th title={baseDate ? `${baseDate} 起漲跌幅` : '在下方設定基準日'} style={{ ...thStyle({ width: SUB_COL_WIDTHS[4], minWidth: SUB_COL_WIDTHS[4], maxWidth: SUB_COL_WIDTHS[4] }) }}>基準</th>
                                    <th style={{ ...thStyle({ width: SUB_COL_WIDTHS[5], minWidth: SUB_COL_WIDTHS[5], maxWidth: SUB_COL_WIDTHS[5] }) }}>法人</th>
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
        </div>
    );
};

export default IndustryAnalysisTable;