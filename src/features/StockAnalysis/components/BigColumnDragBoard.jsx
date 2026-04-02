import React, { useMemo, useRef, useState, useCallback } from 'react';

function buildColumnGroups(categories, config, numCols) {
    const groups = Array.from({ length: numCols }, () => []);
    for (const cat of categories) {
        const cfg = config[cat] ?? { column: 0, order: 0 };
        const col = Math.max(0, Math.min(numCols - 1, Number(cfg.column) || 0));
        const raw = cfg.order;
        const order = Number(raw);
        const o = Number.isFinite(order) ? order : 0;
        groups[col].push({ cat, order: o });
    }
    for (let c = 0; c < numCols; c++) {
        groups[c].sort((a, b) => a.order - b.order || String(a.cat).localeCompare(String(b.cat), 'zh-Hant'));
        groups[c] = groups[c].map((x) => x.cat);
    }
    return groups;
}

function moveItem(groups, fromCol, fromIdx, toCol, toIdx) {
    const g = groups.map((col) => [...col]);
    if (fromCol < 0 || fromCol >= g.length) return g;
    if (fromIdx < 0 || fromIdx >= g[fromCol].length) return g;
    const [item] = g[fromCol].splice(fromIdx, 1);
    let idx = toIdx;
    if (fromCol === toCol && idx > fromIdx) idx -= 1;
    idx = Math.max(0, Math.min(g[toCol].length, idx));
    g[toCol].splice(idx, 0, item);
    return g;
}

function groupsToConfig(groups, prevConfig) {
    const next = { ...prevConfig };
    for (let col = 0; col < groups.length; col++) {
        groups[col].forEach((cat, order) => {
            next[cat] = { ...(next[cat] || {}), column: col, order };
        });
    }
    return next;
}

/**
 * 以拖曳設定各產業所屬大欄與欄內順序（寫入與 IndustryAnalysisTable 相同的 bigColumnConfig）
 */
const BigColumnDragBoard = ({
    categories = [],
    bigColumnConfig = {},
    columnLabels = [],
    numColumns = 8,
    onCommit,
}) => {
    const columnGroups = useMemo(
        () => buildColumnGroups(categories, bigColumnConfig, numColumns),
        [categories, bigColumnConfig, numColumns]
    );

    const dragSourceRef = useRef(null);
    const [draggingKey, setDraggingKey] = useState(null);

    const applyMove = useCallback(
        (fromCol, fromIdx, toCol, toIdx) => {
            const nextGroups = moveItem(columnGroups, fromCol, fromIdx, toCol, toIdx);
            const nextConfig = groupsToConfig(nextGroups, bigColumnConfig);
            onCommit?.(nextConfig);
        },
        [columnGroups, bigColumnConfig, onCommit]
    );

    const onDragStart = (e, col, idx, cat) => {
        dragSourceRef.current = { col, idx, cat };
        setDraggingKey(`${col}:${idx}:${cat}`);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', cat);
    };

    const onDragEnd = () => {
        dragSourceRef.current = null;
        setDraggingKey(null);
    };

    if (categories.length === 0) {
        return <p style={{ margin: 0, color: '#888' }}>尚無類別，請先在「設定產業」為股票設定產業。</p>;
    }

    return (
        <div>
            <p style={{ margin: '0 0 10px 0', color: '#666', lineHeight: 1.45 }}>
                拖曳產業標籤到任一大欄（每欄可放任意多個產業）；同一欄內可上下調整順序。放到某張標籤上會插到該標籤<strong>上方</strong>；放到欄底空白處則<strong>接在最下面</strong>。欄內清單過長時可於該欄內捲動。
            </p>
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'row',
                    gap: '8px',
                    alignItems: 'stretch',
                    overflowX: 'auto',
                    paddingBottom: '4px',
                }}
            >
                {Array.from({ length: numColumns }, (_, colIdx) => {
                    const label = columnLabels[colIdx]?.trim() || `第 ${colIdx + 1} 欄`;
                    const list = columnGroups[colIdx] || [];
                    return (
                        <div
                            key={colIdx}
                            style={{
                                flex: '1 1 88px',
                                minWidth: '88px',
                                maxWidth: '120px',
                                display: 'flex',
                                flexDirection: 'column',
                                border: '1px solid #c5d4e8',
                                borderRadius: '8px',
                                background: '#fff',
                                overflow: 'visible',
                                minHeight: 0,
                            }}
                            onDragEnter={(e) => e.preventDefault()}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault();
                                const src = dragSourceRef.current;
                                if (!src) return;
                                applyMove(src.col, src.idx, colIdx, list.length);
                                onDragEnd();
                            }}
                        >
                            <div
                                style={{
                                    padding: '6px 6px',
                                    fontSize: '10px',
                                    fontWeight: 700,
                                    color: '#1a3a6e',
                                    background: '#dce8f8',
                                    borderBottom: '1px solid #c5d4e8',
                                    textAlign: 'center',
                                    lineHeight: 1.2,
                                    minHeight: '32px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                                title={label}
                            >
                                <span
                                    style={{
                                        display: '-webkit-box',
                                        WebkitLineClamp: 2,
                                        WebkitBoxOrient: 'vertical',
                                        overflow: 'hidden',
                                        wordBreak: 'break-word',
                                    }}
                                >
                                    {label}
                                </span>
                            </div>
                            <div
                                style={{
                                    flex: '0 1 auto',
                                    minHeight: '120px',
                                    maxHeight: 'min(520px, 72vh)',
                                    overflowY: 'auto',
                                    padding: '6px 4px',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '4px',
                                    background: '#f8fafc',
                                }}
                                onDragEnter={(e) => e.preventDefault()}
                                onDragOver={(e) => e.preventDefault()}
                            >
                                {list.map((cat, idx) => {
                                    const k = `${colIdx}:${idx}:${cat}`;
                                    const isDrag = draggingKey === k;
                                    return (
                                        <div
                                            key={cat}
                                            draggable
                                            onDragStart={(e) => onDragStart(e, colIdx, idx, cat)}
                                            onDragEnd={onDragEnd}
                                            onDragEnter={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                            onDragOver={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                const src = dragSourceRef.current;
                                                if (!src) return;
                                                applyMove(src.col, src.idx, colIdx, idx);
                                                onDragEnd();
                                            }}
                                            style={{
                                                padding: '5px 6px',
                                                fontSize: '11px',
                                                fontWeight: 600,
                                                borderRadius: '6px',
                                                border: '1px solid #b8c8dc',
                                                background: isDrag ? '#e3edf9' : '#fff',
                                                cursor: 'grab',
                                                boxShadow: isDrag ? 'none' : '0 1px 2px rgba(0,0,0,0.06)',
                                                opacity: isDrag ? 0.85 : 1,
                                                lineHeight: 1.25,
                                                wordBreak: 'break-word',
                                            }}
                                            title="拖曳以移動到其他大欄或調整順序"
                                        >
                                            {cat}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default BigColumnDragBoard;
