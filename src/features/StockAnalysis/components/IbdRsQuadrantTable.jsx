import React from 'react';
import {
  IBDRS_QUADRANT_COL_PX,
  IBDRS_QUADRANT_TABLE_WIDTH_PX,
  IBDRS_QUADRANT_TABLE_WIDTH_WITH_LAST_CLOSE_AND_DAY_CHANGE_PX,
  fmtDelta,
  getDeltaColor,
  getEffectiveDisplayRs,
  getRsStyle,
} from '../utils/ibdRsRankingTableUtils';

function fmtLastClosePrice(price) {
  if (price == null || !Number.isFinite(Number(price))) return '—';
  return Number(price).toLocaleString('zh-TW', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtPct1d(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${Math.round(n)}`;
}

function getLimitBgColor(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  // 台股日漲跌幅通常約 ±10%，用 9.5% 做視覺提示容忍值
  // 追蹤表（IndustryAnalysisTable）同系極值色：紅 #D32F2F、綠 #43A047
  if (n >= 9.5) return '#d32f2f';
  if (n <= -9.5) return '#43a047';
  return null;
}

/**
 * 並排區塊：與 RS 首頁相同之小表；可選在 RS 左側顯示收盤（觀察列表頁）。
 */
export default function IbdRsQuadrantTable({
  rows,
  tdBase,
  thBase,
  onNameClick,
  deltaShortLabel = 'Δ5',
  deltaLongLabel = 'Δ20',
  deltaShortTitle,
  deltaLongTitle,
  showLastCloseColumn = false,
}) {
  const tableW = showLastCloseColumn
    ? IBDRS_QUADRANT_TABLE_WIDTH_WITH_LAST_CLOSE_AND_DAY_CHANGE_PX
    : IBDRS_QUADRANT_TABLE_WIDTH_PX;
  const colSpan = showLastCloseColumn ? 10 : 8;

  return (
    <div
      style={{
        boxSizing: 'border-box',
        width: tableW,
        overflow: 'hidden',
        borderRadius: 6,
        boxShadow: '0 0 0 1px #e8e8e8',
        background: '#fff',
      }}
    >
      <table
        style={{
          width: tableW,
          minWidth: tableW,
          borderCollapse: 'collapse',
          fontSize: 11,
          tableLayout: 'fixed',
          lineHeight: 1.25,
          fontWeight: 600,
        }}
      >
        <colgroup>
          <col style={{ width: IBDRS_QUADRANT_COL_PX.id }} />
          <col style={{ width: IBDRS_QUADRANT_COL_PX.name }} />
          {showLastCloseColumn ? <col style={{ width: IBDRS_QUADRANT_COL_PX.lastClose }} /> : null}
          {showLastCloseColumn ? <col style={{ width: IBDRS_QUADRANT_COL_PX.dayChange }} /> : null}
          <col style={{ width: IBDRS_QUADRANT_COL_PX.rs }} />
          <col style={{ width: IBDRS_QUADRANT_COL_PX.delta5 }} />
          <col style={{ width: IBDRS_QUADRANT_COL_PX.delta20 }} />
          <col style={{ width: IBDRS_QUADRANT_COL_PX.pct5d }} />
          <col style={{ width: IBDRS_QUADRANT_COL_PX.pct20d }} />
          <col style={{ width: IBDRS_QUADRANT_COL_PX.pos6m }} />
        </colgroup>
        <thead>
          <tr>
            <th style={{ ...thBase, fontSize: 11 }}>代號</th>
            <th
              style={{
                ...thBase,
                textAlign: 'left',
                paddingLeft: 4,
                maxWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              名稱
            </th>
            {showLastCloseColumn ? (
              <th style={{ ...thBase, fontSize: 10 }} title="來自 RS 同步之最近交易日收盤（ibdRsLastClose）">
                收盤
              </th>
            ) : null}
            {showLastCloseColumn ? (
              <th style={{ ...thBase, fontSize: 10 }} title="近 1 個交易日收盤漲跌幅（%）">
                漲跌
              </th>
            ) : null}
            <th style={{ ...thBase }}>RS</th>
            <th style={{ ...thBase }} title={deltaShortTitle}>
              {deltaShortLabel}
            </th>
            <th style={{ ...thBase }} title={deltaLongTitle}>
              {deltaLongLabel}
            </th>
            <th style={{ ...thBase, fontSize: 11 }}>5D</th>
            <th style={{ ...thBase, fontSize: 11 }}>20D</th>
            <th style={{ ...thBase, fontSize: 11 }} title="近六個月區間：最低=0、最高=1">
              HL
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colSpan} style={{ padding: 12, textAlign: 'center', color: '#ccc', fontSize: 10 }}>
                —
              </td>
            </tr>
          ) : (
            rows.map((s) => {
              const displayRs = getEffectiveDisplayRs(s);
              const rsStyle = getRsStyle(displayRs);
              const rsTitle =
                s.ibdRsRating == null && displayRs != null
                  ? 'ibdRsRating 未寫入；顯示為 ibdRsHistory 最後一筆（與下方折線圖同源）'
                  : undefined;
              const closeTitle =
                s.ibdRsLastCloseDate != null
                  ? `當日收盤價（交易日 ${s.ibdRsLastCloseDate}）`
                  : '當日收盤價';
              const limitBg = getLimitBgColor(s.pricePct1d);
              return (
                <tr key={s.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                  <td style={{ ...tdBase, textAlign: 'center', fontWeight: 700, fontSize: 9 }}>{s.id}</td>
                  <td
                    title={s.name || undefined}
                    onClick={() => onNameClick && onNameClick(s)}
                    style={{
                      ...tdBase,
                      paddingLeft: 4,
                      fontWeight: 400,
                      maxWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      cursor: onNameClick ? 'pointer' : undefined,
                      textDecoration: onNameClick ? 'underline dotted #bbb' : undefined,
                    }}
                  >
                    {s.name}
                  </td>
                  {showLastCloseColumn ? (
                    <td
                      style={{
                        ...tdBase,
                        textAlign: 'right',
                        fontSize: 10,
                        fontVariantNumeric: 'tabular-nums',
                        paddingRight: 4,
                        color: '#333',
                      }}
                      title={closeTitle}
                    >
                      {fmtLastClosePrice(s.ibdRsLastClose)}
                    </td>
                  ) : null}
                  {showLastCloseColumn ? (
                    <td
                      style={{
                        ...tdBase,
                        textAlign: 'center',
                        fontSize: 11,
                        fontVariantNumeric: 'tabular-nums',
                        color: limitBg ? '#fff' : getDeltaColor(s.pricePct1d),
                        background: limitBg || undefined,
                        fontWeight: limitBg ? 700 : 600,
                      }}
                      title={limitBg ? '漲停/跌停（近似判斷）' : '近 1 個交易日收盤漲跌幅（%）'}
                    >
                      {fmtPct1d(s.pricePct1d)}
                    </td>
                  ) : null}
                  <td style={{ ...tdBase, textAlign: 'center', ...rsStyle }} title={rsTitle}>
                    {displayRs ?? '—'}
                  </td>
                  <td style={{ ...tdBase, textAlign: 'center', color: getDeltaColor(s.delta5d) }}>
                    {fmtDelta(s.delta5d)}
                  </td>
                  <td style={{ ...tdBase, textAlign: 'center', color: getDeltaColor(s.delta20d) }}>
                    {fmtDelta(s.delta20d)}
                  </td>
                  <td
                    style={{
                      ...tdBase,
                      textAlign: 'center',
                      fontSize: 11,
                      color: getDeltaColor(s.pricePct5d),
                    }}
                  >
                    {s.pricePct5d != null ? `${s.pricePct5d > 0 ? '+' : ''}${Math.round(s.pricePct5d)}` : '—'}
                  </td>
                  <td
                    style={{
                      ...tdBase,
                      textAlign: 'center',
                      fontSize: 11,
                      color: getDeltaColor(s.pricePct20d),
                    }}
                  >
                    {s.pricePct20d != null ? `${s.pricePct20d > 0 ? '+' : ''}${Math.round(s.pricePct20d)}` : '—'}
                  </td>
                  <td
                    style={{
                      ...tdBase,
                      textAlign: 'center',
                      fontSize: 11,
                      color: '#555',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                    title={
                      s.pricePos6m != null && Number.isFinite(s.pricePos6m)
                        ? `近六個月區間內價位：0=區間最低、1=區間最高`
                        : undefined
                    }
                  >
                    {s.pricePos6m != null && Number.isFinite(s.pricePos6m)
                      ? s.pricePos6m.toFixed(2)
                      : '—'}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
