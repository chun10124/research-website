/**
 * RS 排名主表（IbdRsQuadrantTable）共用：欄寬、RS 熱力、Δ 格式、顯示用 RS。
 * 預設 8 欄；觀察列表可另加「收盤」→ IBDRS_QUADRANT_TABLE_WIDTH_WITH_LAST_CLOSE_PX。
 */

/** 並排小表：各欄絕對寬度（px）；表總寬 = 下面加總 */
export const IBDRS_QUADRANT_COL_PX = {
  id: 30,
  name: 65,
  /** 觀察列表：RS 左側「當日收盤價」 */
  lastClose: 52,
  /** 觀察列表：最右側「當日漲跌」 */
  dayChange: 42,
  rs: 28,
  /** Utility Screen：RS 右側「區間 RS」（大盤修正期窗口重算） */
  utilRs: 30,
  delta5: 37,
  delta20: 37,
  pct5d: 37,
  pct20d: 37,
  pos6m: 34,
};

export const IBDRS_QUADRANT_TABLE_WIDTH_PX =
  IBDRS_QUADRANT_COL_PX.id +
  IBDRS_QUADRANT_COL_PX.name +
  IBDRS_QUADRANT_COL_PX.rs +
  IBDRS_QUADRANT_COL_PX.delta5 +
  IBDRS_QUADRANT_COL_PX.delta20 +
  IBDRS_QUADRANT_COL_PX.pct5d +
  IBDRS_QUADRANT_COL_PX.pct20d +
  IBDRS_QUADRANT_COL_PX.pos6m;

/** 觀察列表：多「收盤」欄（插在名稱與 RS 之間） */
export const IBDRS_QUADRANT_TABLE_WIDTH_WITH_LAST_CLOSE_PX =
  IBDRS_QUADRANT_TABLE_WIDTH_PX + IBDRS_QUADRANT_COL_PX.lastClose;

/** 觀察列表：多「收盤」+「當日漲跌」 */
export const IBDRS_QUADRANT_TABLE_WIDTH_WITH_LAST_CLOSE_AND_DAY_CHANGE_PX =
  IBDRS_QUADRANT_TABLE_WIDTH_WITH_LAST_CLOSE_PX + IBDRS_QUADRANT_COL_PX.dayChange;

/** Utility Screen 生效時多「區RS」欄 */
export const IBDRS_QUADRANT_TABLE_WIDTH_WITH_UTIL_RS_PX =
  IBDRS_QUADRANT_TABLE_WIDTH_PX + IBDRS_QUADRANT_COL_PX.utilRs;

/** 名稱欄內容區至少寬度（px） */
export const IBDRS_NAME_COL_MIN_PX = 34;

/**
 * 將列表切成並排欄位資料。
 * - vertical（預設）：每欄為連續區段（1..25 | 26..50 ...）
 * - horizontal：橫向填滿後換列（第 1 列為 1,2,3,4；各欄資料為 1,5,9... / 2,6,10...）
 */
export function splitIntoColumnChunks(list, groupCount, fillOrder = 'vertical') {
  if (groupCount <= 1) return [list];
  const n = list.length;
  const chunks = Array.from({ length: groupCount }, () => []);

  if (fillOrder === 'horizontal') {
    for (let i = 0; i < n; i++) {
      chunks[i % groupCount].push(list[i]);
    }
    return chunks;
  }

  const base = Math.floor(n / groupCount);
  const extra = n % groupCount;
  let from = 0;
  for (let c = 0; c < groupCount; c++) {
    const len = base + (c < extra ? 1 : 0);
    chunks[c] = list.slice(from, from + len);
    from += len;
  }
  return chunks;
}

/** RS 數值 → 背景色 & 文字色（仿熱力圖） */
export function getRsStyle(rs) {
  if (rs == null) return { color: '#999', backgroundColor: 'transparent', fontWeight: 400 };

  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const lerp = (a, b, t) => a + (b - a) * t;
  const hexToRgb = (hex) => {
    const s = String(hex).replace('#', '').trim();
    const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    const num = parseInt(full, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  };
  const rgbToCss = (r, g, b) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  const deepBlue = hexToRgb('#0b3d91');
  const lightBlue = hexToRgb('#cfe8ff');
  const pink = hexToRgb('#ffdde6');
  const red = hexToRgb('#c0392b');

  const v = Number(rs);
  const tFrom01 = (num, den) => clamp01(num / den);

  let r;
  let g;
  let b;
  if (v >= 90) {
    ({ r, g, b } = red);
  } else if (v >= 60) {
    const t = Math.pow(tFrom01(v - 60, 30), 1.0);
    r = lerp(pink.r, red.r, t);
    g = lerp(pink.g, red.g, t);
    b = lerp(pink.b, red.b, t);
  } else if (v >= 50) {
    const t = tFrom01(v - 50, 10);
    r = lerp(lightBlue.r, pink.r, t);
    g = lerp(lightBlue.g, pink.g, t);
    b = lerp(lightBlue.b, pink.b, t);
  } else {
    const t = tFrom01(v, 50);
    r = lerp(deepBlue.r, lightBlue.r, t);
    g = lerp(deepBlue.g, lightBlue.g, t);
    b = lerp(deepBlue.b, lightBlue.b, t);
  }

  const bg = rgbToCss(r, g, b);
  const lum = luminance(r, g, b);
  const fg = lum > 170 ? '#1b1b1b' : '#fff';

  return { color: fg, backgroundColor: bg, fontWeight: 700 };
}

export function getDeltaColor(delta) {
  if (delta == null) return '#bbb';
  if (delta > 0) return '#c0392b';
  if (delta < 0) return '#27ae60';
  return '#666';
}

export function fmtDelta(val) {
  if (val == null) return '—';
  return `${val > 0 ? '+' : ''}${val}`;
}

export function getLatestHistoryRs(ibdRsHistory) {
  if (!Array.isArray(ibdRsHistory) || ibdRsHistory.length === 0) return null;
  const sorted = [...ibdRsHistory]
    .filter((e) => e?.d && typeof e.r === 'number' && Number.isFinite(e.r))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (sorted.length === 0) return null;
  return sorted[sorted.length - 1].r;
}

export function getEffectiveDisplayRs(s) {
  return s.ibdRsRating ?? getLatestHistoryRs(s.ibdRsHistory);
}
