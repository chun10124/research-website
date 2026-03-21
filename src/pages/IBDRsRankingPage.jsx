/* src/pages/IBDRsRankingPage.jsx */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Layout from '@theme/Layout';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchIndexPriceMap, fetchYahooHistoricalPriceVolumeMaps } from '../features/StockAnalysis/api/stockApi';
import { syncSingleStock, syncTestBatch } from '../features/StockAnalysis/api/rsApi';
import { useIbdRsData } from '../features/StockAnalysis/hooks/useIbdRsData';
import {
  IBDRS_LAST_SYNC_DATE_KEY,
  startIbdRsHistoryBackfill,
  startIbdRsPatchRatingFromHistory,
  stopIbdRsBackgroundTask,
} from '../features/StockAnalysis/services/ibdRsSyncService';
import {
  calcCompositeVcp,
  calcRsDelta,
  calcVcpPriceRatioFromCloseMap,
  calcVcpVolumeRatioFromVolumeMap,
  detectCrossUp,
  isRsKWeeksNewHigh,
  normalizeYmdToTaiwanTradingDay,
  VCP_WEIGHT_PRICE,
  VCP_WEIGHT_VOLUME,
} from '../features/StockAnalysis/utils/rsCalculator';

/** 篩選 input 用 data 屬性，placeholder 顏色用 CSS 選 `input[data-ibd-rs-filter]`（見 custom.css ＋掛載時注入 head） */
const FILTER_INPUT_MARK = { 'data-ibd-rs-filter': '1' };

/** 加強版 CSS：增加多重選擇器確保優先級，並針對 number 類型優化 */
const IBD_RS_PLACEHOLDER_STYLE_ID = 'ibd-rs-filter-placeholder-override';
const IBD_RS_PLACEHOLDER_CSS = `
/* 亮色模式：加強選擇器權重 */
body input.ibd-rs-filter-input[data-ibd-rs-filter]::placeholder {
  color: #a0aec0 !important;
  opacity: 1 !important;
  -webkit-text-fill-color: #a0aec0 !important;
}
body input.ibd-rs-filter-input[data-ibd-rs-filter]::-webkit-input-placeholder {
  color: #a0aec0 !important;
  -webkit-text-fill-color: #a0aec0 !important;
}

/* 深色模式：確保在 dark theme 下生效 */
html[data-theme='dark'] body input.ibd-rs-filter-input[data-ibd-rs-filter]::placeholder {
  color: #718096 !important;
  opacity: 1 !important;
  -webkit-text-fill-color: #718096 !important;
}
html[data-theme='dark'] body input.ibd-rs-filter-input[data-ibd-rs-filter]::-webkit-input-placeholder {
  color: #718096 !important;
  -webkit-text-fill-color: #718096 !important;
}
`;

/**
 * 並排小表：各欄絕對寬度（px）。只改數字即可；表總寬 = 下面加總。
 * 名稱儲存格至少多寬（px，約繁中三字）另見 IBDRS_NAME_COL_MIN_PX。
 */
const IBDRS_QUADRANT_COL_PX = {
  id: 30,
  name: 65,
  rs: 28,
  delta7: 37,
  delta30: 37,
  pct5d: 37,
  pct20d: 37,
  /** 近六個月區間價位 0∼1 */
  pos6m: 34,
};

const IBDRS_QUADRANT_TABLE_WIDTH_PX =
  IBDRS_QUADRANT_COL_PX.id +
  IBDRS_QUADRANT_COL_PX.name +
  IBDRS_QUADRANT_COL_PX.rs +
  IBDRS_QUADRANT_COL_PX.delta7 +
  IBDRS_QUADRANT_COL_PX.delta30 +
  IBDRS_QUADRANT_COL_PX.pct5d +
  IBDRS_QUADRANT_COL_PX.pct20d +
  IBDRS_QUADRANT_COL_PX.pos6m;

/** 名稱欄內容區至少寬度（px）；勿大於 IBDRS_QUADRANT_COL_PX.name */
const IBDRS_NAME_COL_MIN_PX = 34;

/** 今日重點 modal：表格欄寬（px，與 colgroup 一致） */
const MM_FOCUS_COL_PX = {
  id: 46,
  name: 108,
  rs: 40,
  step: 44,
  dShort: 44,
  dLong: 44,
  p5: 42,
  p20: 42,
  hl: 44,
};
const MM_FOCUS_TABLE_MIN_PX =
  MM_FOCUS_COL_PX.id +
  MM_FOCUS_COL_PX.name +
  MM_FOCUS_COL_PX.rs +
  MM_FOCUS_COL_PX.step +
  MM_FOCUS_COL_PX.dShort +
  MM_FOCUS_COL_PX.dLong +
  MM_FOCUS_COL_PX.p5 +
  MM_FOCUS_COL_PX.p20 +
  MM_FOCUS_COL_PX.hl;

/**
 * 視窗寬度 = 表身最小寬 + scrollWrap(左右各 1px) + 內容區左右 padding + dialog 邊框(1+1)。
 * 實際顯示寬度另見 MM_FOCUS_MODAL_WIDTH_FLOOR_PX（大螢幕下限）。
 */
/** 與 MajorMovesModal 內容／標題區左右 padding（各 28px）加總一致 */
const MM_FOCUS_MODAL_CONTENT_PAD_X = 56;
const MM_FOCUS_MODAL_WIDTH_PX = MM_FOCUS_TABLE_MIN_PX + 2 + MM_FOCUS_MODAL_CONTENT_PAD_X + 2;

/** 大螢幕時視窗至少此寬（表格 colgroup 不變，多餘為右側留白；內容靠左） */
const MM_FOCUS_MODAL_WIDTH_FLOOR_PX = 660;

/** 橫向並排幾組「完整欄位」（每組一張表） */
const IBDRS_PARALLEL_GROUPS = 4;

/** 第一段「重大變動」：單日 |ΔRS| 須嚴格大於此值 */
const IBDRS_MAJOR_MOVE_DELTA_GT = 10;
/** 第一段「重大變動」：顯示用 RS 須嚴格大於此值 */
const IBDRS_MAJOR_MOVE_RS_GT = 60;

/** 「突破」門檻：前一歷史點 < 門檻、最後一點 ≥ 門檻（由下向上穿越） */
const IBDRS_RS_BREAK_LEVEL_80 = 80;
const IBDRS_RS_BREAK_LEVEL_90 = 90;

/** 觀察窗第三段：HL（6M 區間價位 0～1）須嚴格大於此值 */
const IBDRS_MODAL_HL_GT = 0.98;
/** 觀察窗第三段：與 HL 條件並用，RS 須嚴格大於此值 */
const IBDRS_MODAL_HL_RS_GT = 75;

/** 每個大欄（一張小表）一頁幾筆；總筆數 = 此值 × 大欄數 */
const IBDRS_ROWS_PER_QUADRANT = 100;

/** 每頁總筆數（各大欄加總） */
const PAGE_SIZE = IBDRS_ROWS_PER_QUADRANT * IBDRS_PARALLEL_GROUPS;

/** 將本頁可見列切成 groupCount 段（由左而右，前幾段多 1 筆） */
function splitIntoColumnChunks(list, groupCount) {
  if (groupCount <= 1) return [list];
  const n = list.length;
  const base = Math.floor(n / groupCount);
  const extra = n % groupCount;
  const chunks = [];
  let from = 0;
  for (let c = 0; c < groupCount; c++) {
    const len = base + (c < extra ? 1 : 0);
    chunks.push(list.slice(from, from + len));
    from += len;
  }
  return chunks;
}

// ─── 工具函式 ────────────────────────────────────────────────────────────────

function getTaiwanYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

/** YYYY-MM-DD → 2025/03/20 */
function formatYmdSlash(ymd) {
  if (!ymd || typeof ymd !== 'string' || ymd.length < 10) return '';
  return `${ymd.slice(0, 4)}/${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
}

/** 台股代碼 → TradingView 圖表（上市 TWSE、上櫃 TPEX） */
function getTradingViewChartUrl(stock) {
  const raw = String(stock?.id ?? '')
    .replace(/\.(TW|TWO)$/i, '')
    .trim();
  if (!raw) return null;
  const ex = stock?.market === 'TPEX' ? 'TPEX' : 'TWSE';
  const symbol = `${ex}:${raw}`;
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
}

/** Firestore market → 顯示文字（個股視窗用） */
function formatIbdMarketLabel(market) {
  if (market === 'TWSE') {
    return { text: '上市', color: '#1565c0', bg: 'rgba(21, 101, 192, 0.1)' };
  }
  if (market === 'TPEX') {
    return { text: '上櫃', color: '#6a1b9a', bg: 'rgba(106, 27, 154, 0.1)' };
  }
  return {
    text: market ? String(market) : '—',
    color: '#888',
    bg: 'rgba(0, 0, 0, 0.06)',
  };
}

function formatRelativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const min = 60000, hr = 3600000, day = 86400000;
  if (diff < min) return '剛剛';
  if (diff < hr) return `${Math.floor(diff / min)} 分鐘前`;
  if (diff < day) return `${Math.floor(diff / hr)} 小時前`;
  return `${Math.floor(diff / day)} 天前`;
}

// ─── 顏色/樣式輔助 ───────────────────────────────────────────────────────────

/** RS 數值 → 背景色 & 文字色（仿熱力圖） */
function getRsStyle(rs) {
  if (rs == null) return { color: '#999', backgroundColor: 'transparent', fontWeight: 400 };

  // 不用透明度，避免「皮膚色/髒髒」的半透明混色感。
  // 目標：
  // - 90+：亮紅
  // - 90~60：淡化到粉紅（更乾淨）
  // - 60~50：粉紅 -> 淺藍（讓 50 以下接到藍系）
  // - 50~0：淺藍 -> 深藍
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
  const pink = hexToRgb('#ffdde6'); // 乾淨的粉紅終點
  const red = hexToRgb('#c0392b'); // 亮紅基準

  const v = Number(rs);
  const tFrom01 = (num, den) => clamp01(num / den);

  let r, g, b;
  if (v >= 90) {
    // 亮紅固定（避免看起來跳）
    ({ r, g, b } = red);
  } else if (v >= 60) {
    // 90 -> 60：red -> pink
    const t = Math.pow(tFrom01(v - 60, 30), 1.0); // 60 -> 0, 90 -> 1
    r = lerp(pink.r, red.r, t);
    g = lerp(pink.g, red.g, t);
    b = lerp(pink.b, red.b, t);
  } else if (v >= 50) {
    // 60 -> 50：pink -> lightBlue
    const t = tFrom01(v - 50, 10); // 50 -> 0, 60 -> 1
    r = lerp(lightBlue.r, pink.r, t);
    g = lerp(lightBlue.g, pink.g, t);
    b = lerp(lightBlue.b, pink.b, t);
  } else {
    // 0 -> 50：deepBlue -> lightBlue
    const t = tFrom01(v, 50); // 0 -> 0, 50 -> 1
    r = lerp(deepBlue.r, lightBlue.r, t);
    g = lerp(deepBlue.g, lightBlue.g, t);
    b = lerp(deepBlue.b, lightBlue.b, t);
  }

  const bg = rgbToCss(r, g, b);
  const lum = luminance(r, g, b);
  const fg = lum > 170 ? '#1b1b1b' : '#fff';

  return { color: fg, backgroundColor: bg, fontWeight: 700 };
}

/** delta → 文字顏色（正紅負綠） */
function getDeltaColor(delta) {
  if (delta == null) return '#bbb';
  if (delta > 0) return '#c0392b';
  if (delta < 0) return '#27ae60';
  return '#666';
}

function fmtDelta(val) {
  if (val == null) return '—';
  return `${val > 0 ? '+' : ''}${val}`;
}

/**
 * ibdRsHistory 依日期排序後最後一筆 r（與折線圖同源）。
 * 回填或舊文件可能只寫歷史、頂層 ibdRsRating 仍為空。
 */
function getLatestHistoryRs(ibdRsHistory) {
  if (!Array.isArray(ibdRsHistory) || ibdRsHistory.length === 0) return null;
  const sorted = [...ibdRsHistory]
    .filter((e) => e?.d && typeof e.r === 'number' && Number.isFinite(e.r))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (sorted.length === 0) return null;
  return sorted[sorted.length - 1].r;
}

/**
 * 歷史排序後「最後一筆 − 前一筆」RS（圖上相鄰兩點，通常為交易日接力）。
 * 用於「今日重點」第一段單日變化。
 */
function getRsHistoryLastStepDelta(ibdRsHistory) {
  if (!Array.isArray(ibdRsHistory) || ibdRsHistory.length < 2) return null;
  const sorted = [...ibdRsHistory]
    .filter((e) => e?.d && typeof e.r === 'number' && Number.isFinite(e.r))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (sorted.length < 2) return null;
  return sorted[sorted.length - 1].r - sorted[sorted.length - 2].r;
}

/** 歷史排序後倒數第二筆與最後一筆的 RS（相鄰兩交易日） */
function getRsHistoryLastTwoRatings(ibdRsHistory) {
  if (!Array.isArray(ibdRsHistory) || ibdRsHistory.length < 2) return null;
  const sorted = [...ibdRsHistory]
    .filter((e) => e?.d && typeof e.r === 'number' && Number.isFinite(e.r))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (sorted.length < 2) return null;
  return {
    prevR: sorted[sorted.length - 2].r,
    lastR: sorted[sorted.length - 1].r,
  };
}

/** 由下方向上穿越門檻：前點 < level 且 最後一點 ≥ level */
function didCrossRsLevelUpward(prevR, lastR, level) {
  return prevR < level && lastR >= level;
}

/** 表格／排序／篩選用：優先今日欄位，否則用歷史最後一筆（與圖表一致） */
function getEffectiveDisplayRs(s) {
  return s.ibdRsRating ?? getLatestHistoryRs(s.ibdRsHistory);
}

/** 篩選／表頭用：1～365，空或無效則 fallback */
function clampIbdDeltaDays(raw, fallback) {
  const x = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(x) || x < 1) return fallback;
  return Math.min(365, Math.max(1, x));
}

/** 依回溯「交易日」數算 RS 變化（見 calcRsDelta：ibdRsHistory 筆數） */
function computeDeltaForLookback(s, days) {
  const curRs = s.ibdRsRating ?? getLatestHistoryRs(s.ibdRsHistory);
  return calcRsDelta(curRs, s.ibdRsHistory, days);
}

// ─── 子元件：篩選條件輸入框 ──────────────────────────────────────────────────
// placeholder 顏色：FILTER_INPUT_MARK + custom.css / IBD_RS_PLACEHOLDER_CSS（行內 style 無法設 ::placeholder）

function FilterInput({ label, value, onChange, placeholder, type = 'number', hint, inline }) {
  const inputStyle = {
    padding: inline ? '6px 10px' : '7px 10px',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    fontSize: 12,
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    background: 'var(--ifm-background-color, #fff)',
    color: 'var(--ifm-font-color-base)',
  };
  if (inline) {
    return (
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: '#444',
          minWidth: 0,
        }}
      >
        <span style={{ flex: '0 0 auto', color: '#555', whiteSpace: 'nowrap', fontWeight: 600 }}>{label}</span>
        <input
          {...FILTER_INPUT_MARK}
          className="ibd-rs-filter-input"
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ ...inputStyle, flex: '0 1 auto', width: 'min(100%, 240px)', maxWidth: 240 }}
        />
      </label>
    );
  }
  return (
    <div style={{ minWidth: 0 }}>
      <label style={{ fontSize: 12, color: '#555', display: 'block', marginBottom: 4, fontWeight: 600 }}>{label}</label>
      <input
        {...FILTER_INPUT_MARK}
        className="ibd-rs-filter-input"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
      {hint && <div style={{ fontSize: 10, color: '#999', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function FilterSectionTitle({ children, first }) {
  return (
    <div
      style={{
        gridColumn: '1 / -1',
        fontSize: 11,
        fontWeight: 800,
        color: '#0d9488',
        letterSpacing: '0.04em',
        marginTop: first ? 0 : 6,
        marginBottom: 4,
        paddingBottom: 4,
        borderBottom: '1px solid #e6f7f4',
        lineHeight: 1.2,
      }}
    >
      {children}
    </div>
  );
}

/** 篩選三明治：數字欄固定寬，勿 flex:1 拉滿整列 */
const FILTER_SANDWICH_INPUT = {
  padding: '6px 10px',
  border: '1px solid #d0d0d0',
  borderRadius: 6,
  fontSize: 12,
  flex: '0 0 auto',
  width: 118,
  minWidth: 80,
  maxWidth: 132,
  boxSizing: 'border-box',
  background: 'var(--ifm-background-color, #fff)',
  color: 'var(--ifm-font-color-base)',
};

/** 篩選「Δ [天數] 日」列：中間小輸入框樣式 */
const FILTER_DELTA_MID_TEXT_STYLE = {
  flex: '0 0 auto',
  fontWeight: 800,
  fontSize: 12,
  color: '#134e4a',
  userSelect: 'none',
};

const FILTER_DELTA_DAYS_INPUT = {
  padding: '6px 8px',
  border: '1px solid #d0d0d0',
  borderRadius: 6,
  fontSize: 12,
  flex: '0 0 auto',
  width: 52,
  minWidth: 44,
  maxWidth: 68,
  textAlign: 'center',
  boxSizing: 'border-box',
  background: 'var(--ifm-background-color, #fff)',
  color: 'var(--ifm-font-color-base)',
};

/** [上限] ≥ 名稱 ≥ [下限]（左格=上限、右格=下限；語意：下限 ≤ 指標 ≤ 上限） */
function FilterSandwichBetween({
  centerLabel,
  centerSlot,
  centerAriaName = '',
  upperValue,
  lowerValue,
  onUpperChange,
  onLowerChange,
  upperPlaceholder,
  lowerPlaceholder,
}) {
  const midStyle = {
    flex: '0 0 auto',
    fontWeight: 800,
    fontSize: 12,
    color: '#134e4a',
    userSelect: 'none',
  };
  const centerKey = centerAriaName || (typeof centerLabel === 'string' ? centerLabel : '指標');
  const mid =
    centerSlot ??
    <span style={{ ...midStyle, minWidth: '2ch', textAlign: 'center' }}>{centerLabel}</span>;
  return (
    <div
      style={{
        gridColumn: '1 / -1',
        justifySelf: 'start',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: 'max-content',
        maxWidth: '100%',
        minWidth: 0,
        flexWrap: 'wrap',
      }}
    >
      <input
        {...FILTER_INPUT_MARK}
        className="ibd-rs-filter-input"
        type="number"
        value={upperValue}
        onChange={(e) => onUpperChange(e.target.value)}
        placeholder={upperPlaceholder ?? '上限'}
        style={FILTER_SANDWICH_INPUT}
        aria-label={`${centerKey} 上限`}
      />
      <span style={midStyle}>≥</span>
      {mid}
      <span style={midStyle}>≥</span>
      <input
        {...FILTER_INPUT_MARK}
        className="ibd-rs-filter-input"
        type="number"
        value={lowerValue}
        onChange={(e) => onLowerChange(e.target.value)}
        placeholder={lowerPlaceholder ?? '下限'}
        style={FILTER_SANDWICH_INPUT}
        aria-label={`${centerKey} 下限`}
      />
    </div>
  );
}

// ─── 進度條元件 ──────────────────────────────────────────────────────────────

function SyncProgressBar({ progress }) {
  if (!progress) return null;
  const { phase, done, total, msg, twseCount, tpexCount, listTotal, validRankedCount } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  let mainTitle = {
    list: '📋 抓取市＋櫃清單…',
    fetch: `⬇ 抓取股價（${done}/${listTotal ?? total}）`,
    rank: '📊 計算全市場百分位排名（今日／7 日／30 日）…',
    write: `💾 寫入 Firestore（${done}/${total}）`,
    patch: `📌 補寫 RS 快照（${done}/${total}）`,
    done: '✅ 同步完成',
    error: '❌ 同步失敗',
  }[phase] || phase;

  if (phase === 'list' && twseCount != null && tpexCount != null && listTotal != null) {
    mainTitle = `📋 清單：市 ${twseCount}、櫃 ${tpexCount}（合計 ${listTotal} 檔）`;
  }

  // 清單階段主標題已含上市／上櫃／合計，不再重複第二行
  const showListBreakdown =
    twseCount != null && tpexCount != null && listTotal != null && phase !== 'list';

  return (
    <div
      style={{
        marginBottom: 8,
        padding: '6px 10px',
        background:
          phase === 'done' && progress.chunkContinues ? '#fffbeb' : phase === 'done' ? '#f0fdf4' : '#f0faf8',
        border: `1px solid ${
          phase === 'done' && progress.chunkContinues ? '#fcd34d' : phase === 'done' ? '#86efac' : '#25c2a0'
        }`,
        borderRadius: 6,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: phase === 'rank' || phase === 'done' ? 0 : showListBreakdown ? 4 : 4,
        }}
      >
        <span style={{ fontWeight: 600, flex: '0 1 auto' }}>{mainTitle}</span>
        <span
          style={{
            color: '#666',
            fontSize: 11,
            flex: '1 1 160px',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'right',
          }}
          title={msg}
        >
          {msg}
        </span>
      </div>
      {showListBreakdown && (
        <div style={{ fontSize: 10, color: '#555', marginTop: 2, lineHeight: 1.35 }}>
          市 <strong>{twseCount}</strong> · 櫃 <strong>{tpexCount}</strong> · 合計 <strong>{listTotal}</strong>
          {phase === 'done' && validRankedCount != null && !progress.chunkContinues && (
            <>
              {' '}
              · 排名 <strong>{validRankedCount}</strong>
            </>
          )}
          {phase === 'done' && progress.chunkContinues && (
            <span style={{ color: '#b45309' }}> · 尚有下一批，請再按「同步今日 RS」</span>
          )}
          {phase === 'write' && <span style={{ color: '#888' }}>（寫入＝有 RS 檔數）</span>}
        </div>
      )}
      {phase !== 'done' && phase !== 'rank' && (
        <div style={{ background: '#ddd', borderRadius: 3, height: 4, marginTop: 4 }}>
          <div
            style={{
              background: '#25c2a0',
              height: '100%',
              borderRadius: 3,
              width: `${pct}%`,
              transition: 'width 0.4s ease',
            }}
          />
        </div>
      )}
    </div>
  );
}

/** 今日重點四段合併為 ←→ 導覽順序（先後：單日ΔRS／突破80／突破90／HL）；同檔多段只出現一次 */
function mergeMajorMovesNavigationList(items, items80, items90, itemsHlHigh) {
  const seen = new Set();
  const out = [];
  for (const s of [...items, ...items80, ...items90, ...itemsHlHigh]) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

function isDomTypingTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return target.closest?.('input, textarea, select, [contenteditable="true"]') != null;
}

/** 個股 RS Rating（1-99 歷史）× 加權指數原始點數 疊圖 modal */
function RsChartModal({ stock, onClose, navigationList, onNavigate }) {
  const [indexMap, setIndexMap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  /** Yahoo 日 K 最近一筆：交易日 + 收盤價 */
  const [closeQuote, setCloseQuote] = useState(null);
  /** VCP：價格項／成交量項／加權合成；error 表示 Yahoo 失敗 */
  const [vcpSnapshot, setVcpSnapshot] = useState(null);

  /** 同一「交易日」只保留一點（台灣曆週六／週日併入週五）；舊資料若同週內多筆則取曆日較新那筆的 r */
  const history = useMemo(() => {
    if (!stock?.ibdRsHistory) return [];
    const raw = [...stock.ibdRsHistory]
      .filter((e) => e?.d && e.r != null)
      .sort((a, b) => (a.d < b.d ? -1 : 1));
    const byAnchor = new Map();
    for (const e of raw) {
      const anchor = normalizeYmdToTaiwanTradingDay(String(e.d).slice(0, 10)) ?? String(e.d).slice(0, 10);
      byAnchor.set(anchor, { d: anchor, r: e.r });
    }
    return [...byAnchor.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
  }, [stock]);

  const earliestHistoryDate = history.length > 0 ? history[0].d : null;

  useEffect(() => {
    if (!stock) return;
    setLoading(true);
    setError(null);
    setIndexMap(null);
    setCloseQuote(null);
    setVcpSnapshot(null);

    const endStr = new Date().toISOString().slice(0, 10);
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 6);
    const startStr = earliestHistoryDate || startDate.toISOString().slice(0, 10);

    let cancelled = false;
    const quoteEnd = getTaiwanYmd();
    const quoteStartBuf = new Date();
    quoteStartBuf.setDate(quoteStartBuf.getDate() - 120);
    const quoteStart = quoteStartBuf.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    void fetchYahooHistoricalPriceVolumeMaps(stock.id, quoteStart, quoteEnd, { market: stock.market })
      .then(({ priceMap, volumeMap }) => {
        if (cancelled) return;
        if (priceMap && typeof priceMap === 'object') {
          const dates = Object.keys(priceMap).sort();
          const lastD = dates[dates.length - 1];
          const p = lastD != null ? priceMap[lastD] : null;
          if (lastD && p != null && Number.isFinite(p)) {
            setCloseQuote({ dateStr: lastD, price: p });
          } else {
            setCloseQuote(null);
          }
          const pr = calcVcpPriceRatioFromCloseMap(priceMap, quoteEnd);
          const vr = calcVcpVolumeRatioFromVolumeMap(volumeMap || {}, quoteEnd);
          const comp = calcCompositeVcp(pr, vr);
          setVcpSnapshot({ composite: comp, priceRatio: pr, volRatio: vr });
        } else {
          setCloseQuote(null);
          setVcpSnapshot({ composite: null, priceRatio: null, volRatio: null });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCloseQuote(null);
          setVcpSnapshot({ error: true });
        }
      });

    fetchIndexPriceMap(startStr, endStr)
      .then((im) => {
        if (!cancelled) setIndexMap(im || {});
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || '載入失敗');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [stock?.id, earliestHistoryDate]);

  const chartData = useMemo(() => {
    if (history.length === 0 || !indexMap) return [];
    const indexDates = Object.keys(indexMap).sort();
    return history.map(({ d, r }) => {
      let closestIdx = null;
      for (const id of indexDates) {
        if (id <= d) closestIdx = indexMap[id];
        else break;
      }
      return {
        date: d.slice(5),
        rs: r,
        idx: closestIdx != null ? Math.round(closestIdx) : null,
      };
    });
  }, [history, indexMap]);

  const noHistory = history.length === 0;
  const indexEmpty = indexMap != null && Object.keys(indexMap).length === 0;
  const isEmpty = !loading && !error && chartData.length === 0;
  const marketBadge = formatIbdMarketLabel(stock?.market);
  const tradingViewUrl = stock ? getTradingViewChartUrl(stock) : null;

  useEffect(() => {
    if (!stock || !onNavigate || !Array.isArray(navigationList) || navigationList.length < 2) return;
    const handleKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (isDomTypingTarget(e.target)) return;
      const idx = navigationList.findIndex((s) => s.id === stock.id);
      if (idx < 0) return;
      if (e.key === 'ArrowLeft' && idx > 0) {
        e.preventDefault();
        onNavigate(navigationList[idx - 1]);
      } else if (e.key === 'ArrowRight' && idx < navigationList.length - 1) {
        e.preventDefault();
        onNavigate(navigationList[idx + 1]);
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [stock, stock?.id, navigationList, onNavigate]);

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 12000,
        background: 'rgba(0,0,0,0.42)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          boxSizing: 'border-box',
          width: '100%',
          maxWidth: 900,
          minHeight: 556,
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 20px 56px rgba(0,0,0,0.28)',
          padding: '18px 20px 12px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
            minHeight: 36,
            flexShrink: 0,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 14 }}>
            {stock.id}
            <span style={{ marginLeft: 6, fontWeight: 500 }}>{stock.name}</span>
            <span
              title={
                stock.market === 'TWSE'
                  ? '臺灣證券交易所'
                  : stock.market === 'TPEX'
                    ? '櫃買中心（上櫃）'
                    : undefined
              }
              style={{
                marginLeft: 8,
                fontSize: 11,
                fontWeight: 700,
                color: marketBadge.color,
                padding: '2px 7px',
                borderRadius: 6,
                background: marketBadge.bg,
                verticalAlign: 'middle',
              }}
            >
              {marketBadge.text}
            </span>
            {closeQuote != null ? (
              <span
                title="Yahoo Finance 日 K 最近一筆；非交易日則為前一交易日收盤"
                style={{ marginLeft: 8, fontSize: 13, color: '#1565c0', fontWeight: 700, verticalAlign: 'middle' }}
              >
                {formatYmdSlash(closeQuote.dateStr)} 收盤 {closeQuote.price.toFixed(2)}
              </span>
            ) : (
              <span
                aria-hidden
                style={{
                  marginLeft: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  verticalAlign: 'middle',
                  visibility: 'hidden',
                  whiteSpace: 'nowrap',
                }}
              >
                0000/00/00 收盤 000.00
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontSize: 20,
              color: '#aaa',
              padding: '0 2px',
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* 固定高度避免切換個股時 VCP 區塊忽有忽無造成跳動 */}
        <div
          style={{
            minHeight: 44,
            marginBottom: 8,
            flexShrink: 0,
            boxSizing: 'border-box',
          }}
        >
          {vcpSnapshot && !vcpSnapshot.error && (
            <div
              style={{
                padding: '0 0 6px',
                fontSize: 12,
                color: '#6b7280',
                lineHeight: 1.45,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
              title="價格項：近10個交易日最大單日|報酬|÷近40個交易日最大（收盤）；成交量項：近10日均量÷近40日均量；各 0～1；加權 70% / 30%"
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: '#9ca3af' }}>VCP</span>{' '}
                {vcpSnapshot.composite != null && Number.isFinite(vcpSnapshot.composite) ? (
                  <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: '#374151' }}>
                    {vcpSnapshot.composite.toFixed(3)}
                  </span>
                ) : (
                  <span style={{ color: '#9ca3af' }}>—</span>
                )}
                <span style={{ marginLeft: 6, fontSize: 11, color: '#9ca3af' }}>
                  價 {vcpSnapshot.priceRatio != null && Number.isFinite(vcpSnapshot.priceRatio)
                    ? vcpSnapshot.priceRatio.toFixed(3)
                    : '—'}
                  ×{Math.round(VCP_WEIGHT_PRICE * 100)}% 量{' '}
                  {vcpSnapshot.volRatio != null && Number.isFinite(vcpSnapshot.volRatio)
                    ? vcpSnapshot.volRatio.toFixed(3)
                    : '—'}
                  ×{Math.round(VCP_WEIGHT_VOLUME * 100)}%
                </span>
              </span>
              {tradingViewUrl && (
                <a
                  href={tradingViewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="TradingView K 線圖（新分頁）"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#1565c0',
                    textDecoration: 'none',
                    borderBottom: '1px solid rgba(21, 101, 192, 0.4)',
                    lineHeight: 1.25,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  K 線圖
                </a>
              )}
            </div>
          )}
          {vcpSnapshot && vcpSnapshot.error && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 11, color: '#b45309' }}>VCP：無法取得 Yahoo 價量</span>
              {tradingViewUrl && (
                <a
                  href={tradingViewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="TradingView K 線圖（新分頁）"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#1565c0',
                    textDecoration: 'none',
                    borderBottom: '1px solid rgba(21, 101, 192, 0.4)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  K 線圖
                </a>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <div
            style={{
              height: 420,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#aaa',
              fontSize: 13,
            }}
          >
            載入近半年資料…
          </div>
        ) : error ? (
          <div
            style={{
              height: 420,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#e74c3c',
              fontSize: 13,
            }}
          >
            載入失敗：{error}
          </div>
        ) : isEmpty ? (
          <div
            style={{
              height: 420,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#aaa',
              fontSize: 13,
              gap: 4,
            }}
          >
            {noHistory
              ? <span>尚無 RS 歷史（每天 sync 一次後會慢慢累積）</span>
              : <span>無資料</span>
            }
            {indexEmpty && <span style={{ fontSize: 11 }}>加權指數（^TWII）回傳空</span>}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={420}>
            {/* margin.right 勿與右側 YAxis width 重複加總，否則右側會空一大塊 */}
            <LineChart data={chartData} margin={{ top: 8, right: 4, left: 6, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
                tickLine={false}
              />
              {/* 左軸：RS Rating 1-99 */}
              <YAxis
                yAxisId="rs"
                orientation="left"
                domain={[1, 99]}
                ticks={[1, 25, 50, 75, 99]}
                tick={{ fontSize: 10, fill: '#c0392b' }}
                tickLine={false}
                axisLine={false}
                width={38}
                tickFormatter={(v) => v}
              />
              {/* 右軸：加權指數原始點數 */}
              <YAxis
                yAxisId="idx"
                orientation="right"
                domain={['auto', 'auto']}
                tick={{ fontSize: 10, fill: '#1565c0' }}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)}
              />
              <Tooltip
                formatter={(val, name) =>
                  name === 'RS Rating'
                    ? [`${val}`, 'RS Rating (1-99)']
                    : [val.toLocaleString(), '加權指數']
                }
                contentStyle={{ fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                yAxisId="rs"
                dataKey="rs"
                name="RS Rating"
                stroke="#c0392b"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                yAxisId="idx"
                dataKey="idx"
                name="加權指數"
                stroke="#1565c0"
                strokeWidth={1.5}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}

        <div style={{ textAlign: 'center', fontSize: 10, color: '#ccc', marginTop: 4 }}>
          RS Rating（左軸）= 每次 sync 算出的 1-99　　加權指數（右軸）= ^TWII 點數　　每天 sync 可累積更多歷史點
        </div>
      </div>
    </div>
  );
}

/** 「今日重點」視窗：四段列表皆與主表同欄（RS、Δ、5D、20D、HL）；點列開啟 RS 折線圖 */
function MajorMovesModal({
  onClose,
  items,
  items80,
  items90,
  itemsHlHigh,
  /** 列表資料基準日（交易日；可能為全庫最後同步日） */
  refYmd,
  /** 曆日今日（台北），用於比對是否已同步 */
  calendarTodayYmd,
  majorDeltaGt,
  majorRsGt,
  deltaShortLabel,
  deltaLongLabel,
  deltaShortTitle,
  deltaLongTitle,
  onPickStock,
}) {
  const refDisplay = refYmd ? normalizeYmdToTaiwanTradingDay(refYmd) ?? refYmd : null;
  const calDisplay = calendarTodayYmd
    ? normalizeYmdToTaiwanTradingDay(calendarTodayYmd) ?? calendarTodayYmd
    : null;

  const fmtPctModal = (v) =>
    v != null && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${Math.round(v)}` : '—';

  /** 突破清單有 majorRsStepDelta；HL 清單沒有則從歷史相鄰兩點算 */
  const stepDeltaForRow = (s) =>
    typeof s.majorRsStepDelta === 'number' && Number.isFinite(s.majorRsStepDelta)
      ? s.majorRsStepDelta
      : getRsHistoryLastStepDelta(s.ibdRsHistory);

  /** 今日重點內表格：字級／間距／數字等寬；數字欄置中 */
  const mm = {
    scrollWrap: {
      overflowX: 'auto',
      WebkitOverflowScrolling: 'touch',
      borderRadius: 10,
      border: '1px solid #e5e7eb',
      background: '#fff',
      boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)',
      /** 貼合表身寬，避免白框撐滿 modal 右側一大塊空白 */
      width: 'max-content',
      maxWidth: '100%',
    },
    table: {
      width: MM_FOCUS_TABLE_MIN_PX,
      minWidth: MM_FOCUS_TABLE_MIN_PX,
      tableLayout: 'fixed',
      borderCollapse: 'collapse',
      fontSize: 12,
      lineHeight: 1.4,
      color: '#111827',
      fontFeatureSettings: '"tnum" 1',
    },
    th: (fg, align) => ({
      padding: '10px 6px',
      fontSize: 11,
      fontWeight: 700,
      color: fg,
      letterSpacing: '0.03em',
      textAlign: align,
      borderBottom: '2px solid rgba(17, 24, 39, 0.1)',
      whiteSpace: 'nowrap',
    }),
    tdId: {
      padding: '8px 6px',
      verticalAlign: 'middle',
      textAlign: 'center',
      fontVariantNumeric: 'tabular-nums',
    },
    tdName: {
      padding: '8px 8px',
      verticalAlign: 'middle',
      textAlign: 'left',
    },
    tdNum: {
      padding: '8px 6px',
      textAlign: 'center',
      verticalAlign: 'middle',
      fontVariantNumeric: 'tabular-nums',
    },
  };

  const majorFocusColgroup = () => (
    <colgroup>
      <col style={{ width: MM_FOCUS_COL_PX.id }} />
      <col style={{ width: MM_FOCUS_COL_PX.name }} />
      <col style={{ width: MM_FOCUS_COL_PX.rs }} />
      <col style={{ width: MM_FOCUS_COL_PX.step }} />
      <col style={{ width: MM_FOCUS_COL_PX.dShort }} />
      <col style={{ width: MM_FOCUS_COL_PX.dLong }} />
      <col style={{ width: MM_FOCUS_COL_PX.p5 }} />
      <col style={{ width: MM_FOCUS_COL_PX.p20 }} />
      <col style={{ width: MM_FOCUS_COL_PX.hl }} />
    </colgroup>
  );

  const mmSecTitle = (color) => ({
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.03em',
    color,
    marginBottom: 8,
    lineHeight: 1.35,
  });

  const majorFocusThead = (bg, fg) => (
    <thead>
      <tr style={{ background: bg, color: fg }}>
        <th style={mm.th(fg, 'center')}>代號</th>
        <th style={mm.th(fg, 'left')}>名稱</th>
        <th style={mm.th(fg, 'center')} title="與主表／折線圖同源">
          RS
        </th>
        <th style={mm.th(fg, 'center')} title="歷史最後一點與前一點之差">
          單日Δ
        </th>
        <th style={mm.th(fg, 'center')} title={deltaShortTitle}>
          {deltaShortLabel}
        </th>
        <th style={mm.th(fg, 'center')} title={deltaLongTitle}>
          {deltaLongLabel}
        </th>
        <th style={mm.th(fg, 'center')} title="近 5 個交易日股價漲跌幅（%）">
          5D
        </th>
        <th style={mm.th(fg, 'center')} title="近 20 個交易日股價漲跌幅（%）">
          20D
        </th>
        <th style={mm.th(fg, 'center')} title="近六個月區間價位 0～1">
          HL
        </th>
      </tr>
    </thead>
  );

  const renderFullMetricRows = (list, sectionKey, rowHoverBg = '#f0fdf9') =>
    list.map((s) => {
      const badge = formatIbdMarketLabel(s.market);
      const rs = getEffectiveDisplayRs(s);
      const step = stepDeltaForRow(s);
      return (
        <tr
          key={`${sectionKey}-${s.id}`}
          onClick={() => onPickStock(s)}
          style={{
            cursor: 'pointer',
            borderBottom: '1px solid #f1f5f9',
            background: '#fff',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = rowHoverBg;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#fff';
          }}
        >
          <td style={{ ...mm.tdId, fontWeight: 700, color: '#374151' }}>{s.id}</td>
          <td style={{ ...mm.tdName, fontWeight: 500, fontSize: 12 }}>
            <span
              style={{
                display: 'inline-block',
                maxWidth: 'calc(100% - 40px)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                verticalAlign: 'middle',
              }}
              title={s.name || undefined}
            >
              {s.name || '—'}
            </span>
            <span
              title={s.market === 'TWSE' ? '臺灣證券交易所' : s.market === 'TPEX' ? '櫃買中心（上櫃）' : ''}
              style={{
                marginLeft: 6,
                fontSize: 11,
                fontWeight: 700,
                color: badge.color,
                padding: '1px 5px',
                borderRadius: 4,
                background: badge.bg,
                verticalAlign: 'middle',
                lineHeight: 1.2,
              }}
            >
              {badge.text}
            </span>
          </td>
          <td style={{ ...mm.tdNum, fontWeight: 700, color: '#111827' }}>{rs ?? '—'}</td>
          <td style={{ ...mm.tdNum, fontWeight: 700, color: getDeltaColor(step) }}>{fmtDelta(step)}</td>
          <td style={{ ...mm.tdNum, fontWeight: 600, color: getDeltaColor(s.delta7d) }}>{fmtDelta(s.delta7d)}</td>
          <td style={{ ...mm.tdNum, fontWeight: 600, color: getDeltaColor(s.delta30d) }}>{fmtDelta(s.delta30d)}</td>
          <td style={{ ...mm.tdNum, fontWeight: 600, color: getDeltaColor(s.pricePct5d) }}>
            {fmtPctModal(s.pricePct5d)}
          </td>
          <td style={{ ...mm.tdNum, fontWeight: 600, color: getDeltaColor(s.pricePct20d) }}>
            {fmtPctModal(s.pricePct20d)}
          </td>
          <td
            style={{
              ...mm.tdNum,
              fontWeight: 600,
              color: '#4b5563',
            }}
            title={
              s.pricePos6m != null && Number.isFinite(s.pricePos6m)
                ? '近六個月區間內價位：0=區間最低、1=區間最高'
                : undefined
            }
          >
            {s.pricePos6m != null && Number.isFinite(s.pricePos6m) ? s.pricePos6m.toFixed(2) : '—'}
          </td>
        </tr>
      );
    });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ibd-rs-today-focus-title"
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 11500,
        background: 'rgba(0,0,0,0.38)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 14,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          boxSizing: 'border-box',
          width: `min(max(${MM_FOCUS_MODAL_WIDTH_PX}px, ${MM_FOCUS_MODAL_WIDTH_FLOOR_PX}px), calc(100vw - 28px))`,
          maxHeight: 'min(90vh, 920px)',
          background: 'var(--ifm-background-surface-color, #fff)',
          border: '1px solid #cfe8e2',
          borderRadius: 12,
          boxShadow: '0 24px 56px rgba(0,0,0,0.22)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 10,
            padding: '14px 28px 10px',
            borderBottom: '1px solid #eee',
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <strong id="ibd-rs-today-focus-title" style={{ fontSize: 16, color: '#134e4a' }}>
              今日重點
            </strong>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 6, lineHeight: 1.45 }}>
              基準日（交易日）{refDisplay ? formatYmdSlash(refDisplay) : '—'} ·{' '}
              {!refDisplay
                ? '無可用資料'
                : calDisplay && refDisplay === calDisplay
                  ? '今日已同步'
                  : '今日尚無新資料，顯示最後一次同步'}
            </div>
          </div>
          <button
            type="button"
            aria-label="關閉"
            onClick={onClose}
            style={{
              flex: '0 0 auto',
              fontSize: 20,
              lineHeight: 1,
              padding: '2px 10px',
              border: '1px solid #ddd',
              borderRadius: 8,
              background: '#fff',
              cursor: 'pointer',
              color: '#666',
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '14px 28px 16px', overflow: 'auto', flex: '1 1 auto', WebkitOverflowScrolling: 'touch' }}>
          <div style={{ marginBottom: 20 }}>
            <div style={mmSecTitle('#0f766e')}>
              單日 |ΔRS| &gt; {majorDeltaGt} 且 RS &gt; {majorRsGt}（{items.length}）
            </div>
            {items.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
                無（需至少 2 筆歷史，且 |ΔRS| &gt; {majorDeltaGt}、RS &gt; {majorRsGt}）
              </div>
            ) : (
              <div style={mm.scrollWrap}>
                <table style={mm.table}>
                  {majorFocusColgroup()}
                  {majorFocusThead('#ecfdf5', '#134e4a')}
                  <tbody>{renderFullMetricRows(items, 'maj')}</tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={mmSecTitle('#c2410c')}>
              向上突破 {IBDRS_RS_BREAK_LEVEL_80}（{items80.length}）
            </div>
            {items80.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>無符合條件股票</div>
            ) : (
              <div style={mm.scrollWrap}>
                <table style={mm.table}>
                  {majorFocusColgroup()}
                  {majorFocusThead('#fff7ed', '#9a3412')}
                  <tbody>{renderFullMetricRows(items80, 'b80')}</tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ marginBottom: 18 }}>
            <div style={mmSecTitle('#b45309')}>
              向上突破 {IBDRS_RS_BREAK_LEVEL_90}（{items90.length}）
            </div>
            {items90.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>無符合條件股票</div>
            ) : (
              <div style={mm.scrollWrap}>
                <table style={mm.table}>
                  {majorFocusColgroup()}
                  {majorFocusThead('#fff7ed', '#9a3412')}
                  <tbody>{renderFullMetricRows(items90, 'b90')}</tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <div style={mmSecTitle('#6d28d9')}>
              HL（6M）&gt; {IBDRS_MODAL_HL_GT} 且 RS &gt; {IBDRS_MODAL_HL_RS_GT}（{itemsHlHigh.length}）
            </div>
            {itemsHlHigh.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
                無（需基準日已同步且 pricePos6m 有值，HL &gt; {IBDRS_MODAL_HL_GT} 且 RS &gt; {IBDRS_MODAL_HL_RS_GT}）
              </div>
            ) : (
              <div style={mm.scrollWrap}>
                <table style={mm.table}>
                  {majorFocusColgroup()}
                  {majorFocusThead('#f5f3ff', '#5b21b6')}
                  <tbody>{renderFullMetricRows(itemsHlHigh, 'hl', '#faf5ff')}</tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 並排區塊：一張含完整欄位的小表 */
function IbdRsQuadrantTable({
  rows,
  tdBase,
  thBase,
  onNameClick,
  deltaShortLabel = 'Δ7',
  deltaLongLabel = 'Δ30',
  deltaShortTitle,
  deltaLongTitle,
}) {
  const colSpan = 8;
  return (
    <div
      style={{
        boxSizing: 'border-box',
        width: IBDRS_QUADRANT_TABLE_WIDTH_PX,
        overflow: 'hidden',
        borderRadius: 6,
        boxShadow: '0 0 0 1px #e8e8e8',
        background: '#fff',
      }}
    >
      <table
        style={{
          width: IBDRS_QUADRANT_TABLE_WIDTH_PX,
          minWidth: IBDRS_QUADRANT_TABLE_WIDTH_PX,
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
          <col style={{ width: IBDRS_QUADRANT_COL_PX.rs }} />
          <col style={{ width: IBDRS_QUADRANT_COL_PX.delta7 }} />
          <col style={{ width: IBDRS_QUADRANT_COL_PX.delta30 }} />
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
                  <td style={{ ...tdBase, textAlign: 'center', ...rsStyle }} title={rsTitle}>
                    {displayRs ?? '—'}
                  </td>
                  <td style={{ ...tdBase, textAlign: 'center', color: getDeltaColor(s.delta7d) }}>
                    {fmtDelta(s.delta7d)}
                  </td>
                  <td style={{ ...tdBase, textAlign: 'center', color: getDeltaColor(s.delta30d) }}>
                    {fmtDelta(s.delta30d)}
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

// ─── 主頁面 ──────────────────────────────────────────────────────────────────

const DEFAULT_FILTERS = {
  rsMin: '',
  rsMax: '',
  /** RS 變化：短／長回溯「交易日」數（ibdRsHistory 筆數；顯示與計算用） */
  deltaShortDays: '7',
  deltaLongDays: '30',
  delta7dMin: '',
  delta7dMax: '',
  delta30dMin: '',
  delta30dMax: '',
  pct5dMin: '',
  pct5dMax: '',
  pct20dMin: '',
  pct20dMax: '',
  hlMin: '',
  hlMax: '',
  /** 近 x 個交易日內 RS 向上突破 y（兩者皆填才套用） */
  crossDays: '',
  crossLevel: '',
  /** 近 K「週」＝ K×5 交易日內 RS 為區間最高；填數字才套用 */
  weeksNewHigh: '',
  query: '',
};

export default function IBDRsRankingPage() {
  const { stocks, loading, syncing, syncProgress, syncRs, lastSyncAt, refresh } = useIbdRsData();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [lastSyncDateLocal, setLastSyncDateLocal] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedStock, setSelectedStock] = useState(null);
  /** 從今日重點開折線圖時：←→ 依此清單；主表點名則為 null */
  const [chartNavOverride, setChartNavOverride] = useState(null);
  const [majorMovesOpen, setMajorMovesOpen] = useState(false);
  const [testMsg, setTestMsg] = useState(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const batchAbortRef = useRef(null);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('ibd-rs-page');
    return () => html.classList.remove('ibd-rs-page');
  }, []);

  useEffect(() => {
    let el = document.getElementById(IBD_RS_PLACEHOLDER_STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = IBD_RS_PLACEHOLDER_STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = IBD_RS_PLACEHOLDER_CSS;
    return () => {
      const x = document.getElementById(IBD_RS_PLACEHOLDER_STYLE_ID);
      if (x) x.remove();
    };
  }, []);

  useEffect(() => {
    setMounted(true);
    try {
      const v = localStorage.getItem(IBDRS_LAST_SYNC_DATE_KEY);
      if (v) setLastSyncDateLocal(v);
    } catch (_) {}
  }, []);


  useEffect(() => {
    if (!lastSyncAt) return;
    try {
      const v = localStorage.getItem(IBDRS_LAST_SYNC_DATE_KEY);
      if (v) setLastSyncDateLocal(v);
    } catch (_) {}
  }, [lastSyncAt]);

  // 今日台北時間
  const todayYmd = mounted ? getTaiwanYmd() : null;

  /** 全庫最後一筆 ibdRsUpdatedDate（取最大後，週末對齊到週五） */
  const latestIbdRsDataYmd = useMemo(() => {
    let max = null;
    for (const s of stocks) {
      const d = s.ibdRsUpdatedDate;
      if (!d || typeof d !== 'string') continue;
      const t = d.trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) continue;
      if (max == null || t > max) max = t;
    }
    if (max == null) return null;
    return normalizeYmdToTaiwanTradingDay(max) ?? max;
  }, [stocks]);

  /** 曆日「今日」對應之台股交易日（週六日→週五） */
  const todayTradingYmd = useMemo(
    () => (todayYmd ? normalizeYmdToTaiwanTradingDay(todayYmd) : null),
    [todayYmd]
  );

  /**
   * 「今日重點」列表：以**交易日**為基準；若曆日今日尚無資料則用全庫最後交易日。
   */
  const focusPanelRefYmd = useMemo(() => {
    if (!todayYmd || !todayTradingYmd) return null;
    const hasAnyToday = stocks.some((s) => {
      const t = String(s.ibdRsUpdatedDate || '').trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
      const sn = normalizeYmdToTaiwanTradingDay(t);
      return sn === todayTradingYmd;
    });
    if (hasAnyToday) return todayTradingYmd;
    return latestIbdRsDataYmd;
  }, [stocks, todayYmd, todayTradingYmd, latestIbdRsDataYmd]);

  // 今日已更新數量（以交易日對齊）
  const updatedTodayCount = useMemo(
    () =>
      stocks.filter((s) => {
        const t = String(s.ibdRsUpdatedDate || '').trim().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
        const sn = normalizeYmdToTaiwanTradingDay(t);
        return sn === todayTradingYmd;
      }).length,
    [stocks, todayTradingYmd]
  );

  /** Firestore 載入資料之上市／上櫃筆數（舊文件無 market 則列入未標註） */
  const marketStats = useMemo(() => {
    let tw = 0;
    let tp = 0;
    let unknown = 0;
    for (const s of stocks) {
      if (s.market === 'TWSE') tw++;
      else if (s.market === 'TPEX') tp++;
      else unknown++;
    }
    return { tw, tp, unknown };
  }, [stocks]);

  // ── Step 1：預先計算每檔兩欄「RS 變化」（回溯**交易日**數由篩選器自訂；預設 7／30）
  const enriched = useMemo(() => {
    const dShort = clampIbdDeltaDays(filters.deltaShortDays, 7);
    const dLong = clampIbdDeltaDays(filters.deltaLongDays, 30);
    return stocks.map((s) => {
      const d7 = computeDeltaForLookback(s, dShort);
      const d30 = computeDeltaForLookback(s, dLong);
      return { ...s, delta7d: d7, delta30d: d30 };
    });
  }, [stocks, filters.deltaShortDays, filters.deltaLongDays]);

  // ── Step 2：依全體 RS 排序（有「顯示用 RS」的在前；含僅歷史有值者）
  const globalSorted = useMemo(() => {
    const withRs = enriched
      .filter((s) => getEffectiveDisplayRs(s) != null)
      .sort((a, b) => getEffectiveDisplayRs(b) - getEffectiveDisplayRs(a));
    const noRs = enriched.filter((s) => getEffectiveDisplayRs(s) == null);
    return [...withRs, ...noRs];
  }, [enriched]);

  // ── Step 3：套用篩選
  const filtered = useMemo(() => {
    const n = (v) => {
      if (v === '' || v == null) return null;
      const x = parseFloat(String(v).trim());
      return Number.isFinite(x) ? x : null;
    };
    const rsMin = n(filters.rsMin);
    const rsMax = n(filters.rsMax);
    const d7min = n(filters.delta7dMin);
    const d7max = n(filters.delta7dMax);
    const d30min = n(filters.delta30dMin);
    const d30max = n(filters.delta30dMax);
    const pct5dMin = n(filters.pct5dMin);
    const pct5dMax = n(filters.pct5dMax);
    const pct20dMin = n(filters.pct20dMin);
    const pct20dMax = n(filters.pct20dMax);
    const hlMin = n(filters.hlMin);
    const hlMax = n(filters.hlMax);
    const q = filters.query.trim().toLowerCase();

    const crossDaysParsed = parseInt(String(filters.crossDays || '').trim(), 10);
    const crossLevelParsed = parseInt(String(filters.crossLevel || '').trim(), 10);
    const crossFilterActive =
      Number.isFinite(crossDaysParsed) &&
      crossDaysParsed > 0 &&
      Number.isFinite(crossLevelParsed) &&
      crossLevelParsed >= 1 &&
      crossLevelParsed <= 99;

    const weeksKParsed = parseInt(String(filters.weeksNewHigh || '').trim(), 10);
    const weeksHighActive = Number.isFinite(weeksKParsed) && weeksKParsed >= 1 && weeksKParsed <= 52;

    return globalSorted.filter((s) => {
      const effRs = getEffectiveDisplayRs(s);
      if (rsMin != null && (effRs == null || effRs < rsMin)) return false;
      if (rsMax != null && (effRs == null || effRs > rsMax)) return false;
      if (d7min != null && (s.delta7d == null || s.delta7d < d7min)) return false;
      if (d7max != null && (s.delta7d == null || s.delta7d > d7max)) return false;
      if (d30min != null && (s.delta30d == null || s.delta30d < d30min)) return false;
      if (d30max != null && (s.delta30d == null || s.delta30d > d30max)) return false;
      if (pct5dMin != null && (s.pricePct5d == null || s.pricePct5d < pct5dMin)) return false;
      if (pct5dMax != null && (s.pricePct5d == null || s.pricePct5d > pct5dMax)) return false;
      if (pct20dMin != null && (s.pricePct20d == null || s.pricePct20d < pct20dMin)) return false;
      if (pct20dMax != null && (s.pricePct20d == null || s.pricePct20d > pct20dMax)) return false;
      if (hlMin != null && (s.pricePos6m == null || !Number.isFinite(s.pricePos6m) || s.pricePos6m < hlMin)) return false;
      if (hlMax != null && (s.pricePos6m == null || !Number.isFinite(s.pricePos6m) || s.pricePos6m > hlMax)) return false;

      if (crossFilterActive) {
        if (
          !detectCrossUp(effRs, s.ibdRsHistory, crossLevelParsed, crossDaysParsed)
        ) {
          return false;
        }
      }
      if (weeksHighActive) {
        if (!isRsKWeeksNewHigh(s.ibdRsHistory, effRs, weeksKParsed)) return false;
      }

      if (q) {
        const idMatch = String(s.id || '').toLowerCase().includes(q);
        const nameMatch = String(s.name || '').toLowerCase().includes(q);
        if (!idMatch && !nameMatch) return false;
      }
      return true;
    });
  }, [globalSorted, filters]);

  /** 折線圖 ←／→：今日重點開啟時用合併清單；否則主表 filtered／globalSorted */
  const chartNavigationList = useMemo(() => {
    if (Array.isArray(chartNavOverride?.list) && chartNavOverride.list.length > 0) {
      return chartNavOverride.list;
    }
    if (!selectedStock) return filtered;
    const inFiltered = filtered.some((s) => s.id === selectedStock.id);
    return inFiltered ? filtered : globalSorted;
  }, [chartNavOverride, selectedStock, filtered, globalSorted]);

  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  /** 篩選／搜尋後筆數變少時，page state 可能大於最後一頁 → 用 safePage 切 slice 與翻頁 */
  const safePage = pageCount > 0 ? Math.min(page, pageCount - 1) : 0;
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  /** 並排小表：只顯示有資料的欄，空欄不 render（篩選後筆數少時不會留空白表） */
  const parallelChunksToShow = useMemo(() => {
    const chunks = splitIntoColumnChunks(visible, IBDRS_PARALLEL_GROUPS);
    return chunks.filter((c) => c.length > 0);
  }, [visible]);

  const hasActiveFilter = Object.entries(filters).some(([k, v]) => v !== '' && v !== DEFAULT_FILTERS[k]);

  const deltaShortDaysResolved = clampIbdDeltaDays(filters.deltaShortDays, 7);
  const deltaLongDaysResolved = clampIbdDeltaDays(filters.deltaLongDays, 30);
  const deltaShortTitle = `今日 RS 減去 ${deltaShortDaysResolved} 個交易日前之 RS（ibdRsHistory 筆數；需足夠歷史）`;
  const deltaLongTitle = `今日 RS 減去 ${deltaLongDaysResolved} 個交易日前之 RS（ibdRsHistory 筆數；需足夠歷史）`;

  /** 基準日已同步：單日 |ΔRS| &gt; 10 且 顯示 RS &gt; 60 */
  const majorMoveStocksToday = useMemo(() => {
    if (!focusPanelRefYmd) return [];
    const list = [];
    for (const s of enriched) {
      const sRef = normalizeYmdToTaiwanTradingDay(String(s.ibdRsUpdatedDate || '').trim().slice(0, 10));
      if (sRef !== focusPanelRefYmd) continue;
      const effRs = getEffectiveDisplayRs(s);
      if (effRs == null || effRs <= IBDRS_MAJOR_MOVE_RS_GT) continue;
      const step = getRsHistoryLastStepDelta(s.ibdRsHistory);
      if (step == null || Math.abs(step) <= IBDRS_MAJOR_MOVE_DELTA_GT) continue;
      list.push({ ...s, majorRsStepDelta: step });
    }
    list.sort((a, b) => Math.abs(b.majorRsStepDelta) - Math.abs(a.majorRsStepDelta));
    return list;
  }, [enriched, focusPanelRefYmd]);

  /** 基準日由下向上突破 RS 80／90（歷史：前點 &lt; 門檻、本點 ≥ 門檻） */
  const rsBreakthrough80Today = useMemo(() => {
    if (!focusPanelRefYmd) return [];
    const out = [];
    for (const s of enriched) {
      const sRef = normalizeYmdToTaiwanTradingDay(String(s.ibdRsUpdatedDate || '').trim().slice(0, 10));
      if (sRef !== focusPanelRefYmd) continue;
      const two = getRsHistoryLastTwoRatings(s.ibdRsHistory);
      if (!two) continue;
      if (!didCrossRsLevelUpward(two.prevR, two.lastR, IBDRS_RS_BREAK_LEVEL_80)) continue;
      if (getEffectiveDisplayRs(s) == null) continue;
      out.push({
        ...s,
        btPrevR: two.prevR,
        btLastR: two.lastR,
        majorRsStepDelta: two.lastR - two.prevR,
      });
    }
    out.sort((a, b) => getEffectiveDisplayRs(b) - getEffectiveDisplayRs(a));
    return out;
  }, [enriched, focusPanelRefYmd]);

  const rsBreakthrough90Today = useMemo(() => {
    if (!focusPanelRefYmd) return [];
    const out = [];
    for (const s of enriched) {
      const sRef = normalizeYmdToTaiwanTradingDay(String(s.ibdRsUpdatedDate || '').trim().slice(0, 10));
      if (sRef !== focusPanelRefYmd) continue;
      const two = getRsHistoryLastTwoRatings(s.ibdRsHistory);
      if (!two) continue;
      if (!didCrossRsLevelUpward(two.prevR, two.lastR, IBDRS_RS_BREAK_LEVEL_90)) continue;
      if (getEffectiveDisplayRs(s) == null) continue;
      out.push({
        ...s,
        btPrevR: two.prevR,
        btLastR: two.lastR,
        majorRsStepDelta: two.lastR - two.prevR,
      });
    }
    out.sort((a, b) => getEffectiveDisplayRs(b) - getEffectiveDisplayRs(a));
    return out;
  }, [enriched, focusPanelRefYmd]);

  /** 基準日已同步且 HL（6M）> IBDRS_MODAL_HL_GT 且 RS > IBDRS_MODAL_HL_RS_GT */
  const hlHighList = useMemo(() => {
    if (!focusPanelRefYmd) return [];
    const out = [];
    for (const s of enriched) {
      const sRef = normalizeYmdToTaiwanTradingDay(String(s.ibdRsUpdatedDate || '').trim().slice(0, 10));
      if (sRef !== focusPanelRefYmd) continue;
      const hl = s.pricePos6m;
      if (hl == null || !Number.isFinite(hl) || hl <= IBDRS_MODAL_HL_GT) continue;
      const rs = getEffectiveDisplayRs(s);
      if (rs == null || !Number.isFinite(rs) || rs <= IBDRS_MODAL_HL_RS_GT) continue;
      out.push(s);
    }
    out.sort((a, b) => (b.pricePos6m ?? 0) - (a.pricePos6m ?? 0));
    return out;
  }, [enriched, focusPanelRefYmd]);

  // ── 同步：按一次跑完全市場（略過已快取）；Shift＝強制重抓
  const handleSync = (e) => {
    if (syncing) return;
    const forceRefresh = e?.shiftKey === true;
    if (forceRefresh) {
      const ok = window.confirm(
        '強制模式：將逐檔重新抓取 Yahoo 股價（忽略今日快取），耗時較久。\n確定？'
      );
      if (!ok) return;
    } else if (stocks.length > 0 && updatedTodayCount > stocks.length * 0.5) {
      const ok = window.confirm(
        `今日已更新 ${updatedTodayCount}/${stocks.length} 檔。\n` +
          '將略過已快取檔案，只補未完成項目；仍可能需數十分鐘以上。\n確定繼續？\n\n（Shift＋同步＝強制全部重抓）'
      );
      if (!ok) return;
    }
    void syncRs({ forceRefresh });
  };

  // ── reset
  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setPage(0);
  };

  // ── 用於 filter panel 的共用輸入更新
  const setFilter = (key) => (val) => {
    setFilters((f) => ({ ...f, [key]: val }));
    setPage(0);
  };

  const handleHistoryBackfillClick = useCallback(() => {
    if (
      window.confirm(
        '【全市場完整回填】\n\n' +
          '· 回溯約 180 個曆日內、有價之「每個交易日」計算 RS，寫入 ibdRsHistory（與每日同步同一套公式）。\n' +
          '· 全市場每檔都會抓長區間股價 → 常需 1～2 小時以上，視網路／限流而定。\n' +
          '· RS 為全市場百分位排名（與「試跑 10 檔」不同）。\n' +
          '· 可切換分頁；任務在背景續跑（勿關閉整個瀏覽器）。\n\n' +
          '確定開始全市場回填？'
      )
    ) {
      startIbdRsHistoryBackfill({
        daysBack: 180,
        onlyFirstTradingWeek: false,
        stockLimit: null,
      });
    }
  }, []);

  /** 試跑：只寫入「回溯區間內最早 7 個交易日」的 RS；抓價仍跑全市場，仍要一段時間 */
  const handleHistoryBackfillFirstWeekClick = useCallback(() => {
    if (
      window.confirm(
        '【試跑】清單前 10 檔 × 最早 7 個交易日：只抓 10 檔股價並寫入 RS。\n\n' +
          '（RS 為這 10 檔內相對排名，與全市場正式 RS 不同。）\n\n確定開始？'
      )
    ) {
      startIbdRsHistoryBackfill({ daysBack: 180, onlyFirstTradingWeek: true, stockLimit: 10 });
    }
  }, []);

  /** 只補 Firestore：ibdRsRating 空、ibdRsHistory 有值 → 寫入快照；不抓 Yahoo、不重算全市場 */
  const handlePatchRatingFromHistoryClick = useCallback(() => {
    if (
      window.confirm(
        '【補寫 RS 快照】\n\n' +
          '僅處理「頂層 ibdRsRating 為空、但 ibdRsHistory 已有點」的股票。\n' +
          '會把歷史最後一筆 RS 寫入 ibdRsRating／ibdRsSnapshotDate。\n\n' +
          '不抓股價、不重跑同步，通常數秒～1 分鐘內完成。\n\n確定執行？'
      )
    ) {
      void startIbdRsPatchRatingFromHistory();
    }
  }, []);

  const handleRepairAllData = useCallback(async () => {
    setTestMsg('載入清單 + 檢查缺失…');
    try {
      const existingIds = new Set(stocks.map((s) => s.id));
      const { fetchTaiwanStockList } = await import('../features/StockAnalysis/api/rsStockList');
      const list = await fetchTaiwanStockList();
      const newTpex = list.filter((s) => s.market === 'TPEX' && !existingIds.has(s.id));
      let newDone = 0;
      if (newTpex.length > 0) {
        setTestMsg(`Phase 1: 新增 ${newTpex.length} 檔上櫃股…`);
        for (const stock of newTpex) {
          setTestMsg(`新增上櫃 (${newDone + 1}/${newTpex.length}) ${stock.id} ${stock.name}…`);
          try {
            await syncSingleStock(stock.id, 'TPEX', (p) => {
              setTestMsg(`新增上櫃 (${newDone + 1}/${newTpex.length}) ${p.msg}`);
            });
          } catch (err) {
            console.warn(`[新增上櫃] ${stock.id} 失敗:`, err.message);
          }
          newDone++;
          if (newDone < newTpex.length) {
            await new Promise((r) => setTimeout(r, 2200 + Math.floor(Math.random() * 600)));
          }
        }
      }
      setTestMsg(`Phase 2: 填補現有股票缺失資料…`);
      const result = await syncTestBatch({
        count: Infinity,
        onProgress: (p) => setTestMsg(`填補缺失 ${p.msg}`),
      });
      setTestMsg(`✅ 新增上櫃 ${newDone} 檔 + 填補 ${result.processed} 檔，重新載入…`);
      await refresh();
    } catch (e) {
      setTestMsg(`❌ ${e.message}`);
    }
    setTimeout(() => setTestMsg(null), 15000);
  }, [refresh, stocks]);

  // ─── Styles ─────────────────────────────
  const btnBase = {
    padding: '6px 12px',
    border: 'none',
    borderRadius: 5,
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: 12,
    transition: 'opacity 0.15s',
  };

  const tdBase = {
    padding: '2px 5px',
    border: '1px solid #f0f0f0',
    verticalAlign: 'middle',
    height: 22,
    boxSizing: 'border-box',
    fontSize: 11.5,
  };

  const thBase = {
    padding: '4px 5px',
    border: '1px solid #ddd',
    textAlign: 'center',
    background: '#dce8f8',
    fontWeight: 700,
    fontSize: 11,
    height: 26,
  };

  const totalWithRs = globalSorted.filter((s) => getEffectiveDisplayRs(s) != null).length;
  /** 篩選後「有 RS」筆數（與分母一致，避免含無 RS 檔時分子 > 分母） */
  const filteredWithRsCount = useMemo(
    () => filtered.filter((s) => getEffectiveDisplayRs(s) != null).length,
    [filtered]
  );

  /** page state 與 safePage 對齊，避免內部狀態長期偏大 */
  useEffect(() => {
    const sp = pageCount > 0 ? Math.min(page, pageCount - 1) : 0;
    if (page !== sp) setPage(sp);
  }, [page, pageCount]);

  return (
    <Layout title="IBD RS Ranking">
      <main className="ibd-rs-ranking-main" style={{ padding: '8px 0 12px', minWidth: 0 }}>
        <div className="ibd-rs-ranking-page-inner" style={{ padding: '0 10px', minWidth: 0 }}>
          {/* ── 頂欄：標題與「搜尋＋翻頁」同一列；統計在下一列 ─────────────── */}
          <div style={{ marginBottom: 8 }}>
            <div
              className="ibd-rs-ranking-topbar-row"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px 12px',
                rowGap: 8,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '8px 10px',
                  flex: '0 1 auto',
                  minWidth: 0,
                }}
              >
                <h2 style={{ margin: 0, fontSize: '1.15rem', lineHeight: 1.2 }}>IBD RS Ranking</h2>
                <button
                  type="button"
                  onClick={() => setMajorMovesOpen(true)}
                  disabled={loading}
                  title={`今日重點：|ΔRS|／突破 80·90／HL(6M)>${IBDRS_MODAL_HL_GT} 且 RS>${IBDRS_MODAL_HL_RS_GT}；點列開折線圖`}
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '5px 10px',
                    borderRadius: 8,
                    border: '1px solid #0d9488',
                    background: '#ecfdf5',
                    color: '#0f766e',
                    cursor: loading ? 'wait' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  今日重點
                </button>
              </div>
              <div
                className="ibd-rs-ranking-topbar-actions"
                style={{
                  display: 'inline-flex',
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  alignContent: 'center',
                  gap: 10,
                  flex: '1 1 auto',
                  justifyContent: 'flex-end',
                  minWidth: 0,
                }}
              >
                {pageCount > 1 && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      alignSelf: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                      flexShrink: 0,
                      minHeight: 28,
                    }}
                  >
                    {[
                      { label: '«', target: 0, disabled: safePage === 0 },
                      { label: '‹', target: safePage - 1, disabled: safePage === 0 },
                    ].map(({ label, target, disabled }) => (
                      <button
                        key={label}
                        type="button"
                        disabled={disabled}
                        onClick={() => setPage(target)}
                        style={{
                          padding: '4px 10px',
                          border: '1px solid #ddd',
                          borderRadius: 4,
                          background: '#fff',
                          cursor: disabled ? 'default' : 'pointer',
                          opacity: disabled ? 0.4 : 1,
                          fontSize: 12,
                        }}
                      >
                        {label}
                      </button>
                    ))}

                    <span style={{ fontSize: 12, color: '#666', margin: '0 4px' }}>
                      第 <strong>{safePage + 1}</strong> / {pageCount}
                    </span>

                    {[
                      { label: '›', target: safePage + 1, disabled: safePage >= pageCount - 1 },
                      { label: '»', target: pageCount - 1, disabled: safePage >= pageCount - 1 },
                    ].map(({ label, target, disabled }) => (
                      <button
                        key={label}
                        type="button"
                        disabled={disabled}
                        onClick={() => setPage(target)}
                        style={{
                          padding: '4px 10px',
                          border: '1px solid #ddd',
                          borderRadius: 4,
                          background: '#fff',
                          cursor: disabled ? 'default' : 'pointer',
                          opacity: disabled ? 0.4 : 1,
                          fontSize: 12,
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  {...FILTER_INPUT_MARK}
                  className="ibd-rs-filter-input ibd-rs-topbar-search"
                  type="search"
                  value={filters.query}
                  onChange={(e) => setFilter('query')(e.target.value)}
                  placeholder="搜尋代號或名稱"
                  aria-label="搜尋代號或名稱"
                  style={{
                    margin: 0,
                    alignSelf: 'center',
                    padding: '4px 8px',
                    border: '1px solid #d0d0d0',
                    borderRadius: 6,
                    fontSize: 12,
                    lineHeight: 1.25,
                    minWidth: 100,
                    width: 'min(100%, 200px)',
                    maxWidth: 220,
                    minHeight: 28,
                    boxSizing: 'border-box',
                    background: 'var(--ifm-background-color, #fff)',
                    color: 'var(--ifm-font-color-base)',
                    verticalAlign: 'middle',
                  }}
                />
              </div>
            </div>
            {mounted && stocks.length > 0 && (
              <div
                style={{
                  fontSize: 11,
                  color: '#555',
                  lineHeight: 1.45,
                  wordBreak: 'break-word',
                  marginTop: 4,
                }}
              >
                <span style={{ color: updatedTodayCount === stocks.length ? '#1e7e34' : '#666' }}>
                  今日 <strong>{updatedTodayCount}</strong>/{stocks.length}
                </span>
                <span style={{ color: '#bbb', margin: '0 6px' }}>|</span>
                <span>
                  市<strong style={{ color: '#1565c0' }}>{marketStats.tw}</strong>
                </span>
                <span style={{ color: '#bbb', margin: '0 4px' }}>·</span>
                <span>
                  櫃<strong style={{ color: '#6a1b9a' }}>{marketStats.tp}</strong>
                </span>
                {marketStats.unknown > 0 && (
                  <span style={{ color: '#999' }}>
                    {' '}
                    · 未標註 <strong>{marketStats.unknown}</strong>
                  </span>
                )}
                {lastSyncDateLocal && (
                  <>
                    <span style={{ color: '#bbb', margin: '0 6px' }}>|</span>
                    同步 {lastSyncDateLocal}
                    {lastSyncAt && <span style={{ color: '#999' }}>（{formatRelativeTime(lastSyncAt)}）</span>}
                  </>
                )}
              </div>
            )}
          </div>

          <SyncProgressBar progress={syncProgress} />

          {testMsg && (
            <div style={{ marginBottom: 8, padding: '6px 10px', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: 6, fontSize: 12, color: '#0d9488' }}>
              {testMsg}
            </div>
          )}

          {/* ── 篩選：懸浮按鈕 + 視窗 ─────────────────────────────────────────── */}
          <button
            type="button"
            onClick={() => setFilterOpen(true)}
            style={{
              position: 'fixed',
              right: 16,
              bottom: 16,
              zIndex: 10000,
              padding: '14px 20px',
              borderRadius: 999,
              border: hasActiveFilter ? '2px solid #c0392b' : '1px solid #ccc',
              background: hasActiveFilter ? '#fff5f5' : '#fff',
              color: hasActiveFilter ? '#c0392b' : '#444',
              cursor: 'pointer',
              boxShadow: '0 10px 28px rgba(0,0,0,0.15)',
              fontSize: 15,
              fontWeight: 800,
            }}
            title="開啟篩選視窗"
          >
            篩選
          </button>

          {filterOpen && (
            <div
              role="dialog"
              aria-modal="true"
              onMouseDown={() => setFilterOpen(false)}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 10001,
                background: 'rgba(0,0,0,0.35)',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                padding: 14,
              }}
            >
              <div
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  width: '100%',
                  maxWidth: 480,
                  background: 'linear-gradient(180deg, #fafdfb 0%, var(--ifm-background-surface-color, #fff) 12%)',
                  border: '1px solid #cfe8e2',
                  borderRadius: 12,
                  boxShadow: '0 24px 56px rgba(0,0,0,0.22)',
                  padding: '16px 20px 14px',
                  minHeight: '78vh',
                  maxHeight: '98vh',
                  overflowY: 'auto',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <strong style={{ fontSize: 15, fontWeight: 800, color: '#134e4a', letterSpacing: '-0.02em' }}>篩選條件</strong>
                  {hasActiveFilter && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      style={{
                        fontSize: 11,
                        padding: '5px 10px',
                        border: '1px solid #ccc',
                        borderRadius: 8,
                        background: '#fff',
                        cursor: 'pointer',
                        color: '#555',
                        fontWeight: 700,
                      }}
                    >
                      清除全部
                    </button>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: '#555' }}>
                    符合{' '}
                    <strong style={{ color: filteredWithRsCount > 0 ? '#c0392b' : '#888', fontSize: 14 }}>{filteredWithRsCount}</strong> / {totalWithRs}
                    <span style={{ color: '#888', fontSize: 11 }}>（有 RS）</span>
                  </span>
                  <button
                    type="button"
                    aria-label="關閉"
                    title="關閉"
                    onClick={() => setFilterOpen(false)}
                    style={{
                      fontSize: 20,
                      lineHeight: 1,
                      padding: '2px 8px',
                      border: '1px solid #ddd',
                      borderRadius: 8,
                      background: '#fff',
                      cursor: 'pointer',
                      color: '#666',
                      fontWeight: 400,
                    }}
                  >
                    ×
                  </button>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, auto))',
                    gap: '6px 16px',
                    alignItems: 'end',
                    justifyItems: 'start',
                  }}
                >
                  <FilterSectionTitle first>RS</FilterSectionTitle>
                  <FilterSandwichBetween
                    centerLabel="RS"
                    upperValue={filters.rsMax}
                    lowerValue={filters.rsMin}
                    onUpperChange={setFilter('rsMax')}
                    onLowerChange={setFilter('rsMin')}
                  />

                  <FilterSectionTitle>RS 變化（Δ）</FilterSectionTitle>
                  <div style={{ gridColumn: '1 / -1', fontSize: 10, color: '#888', marginTop: -6, lineHeight: 1.35 }}>
                    兩列中央可輸入回溯<strong>交易日</strong>數（1～365）；空白或無效時預設 7／30。表頭與數值會隨天數更新。
                  </div>
                  <FilterSandwichBetween
                    centerAriaName={`RS變化·${deltaShortDaysResolved}日`}
                    centerSlot={
                      <>
                        <span style={FILTER_DELTA_MID_TEXT_STYLE}>Δ</span>
                        <input
                          {...FILTER_INPUT_MARK}
                          className="ibd-rs-filter-input"
                          type="number"
                          min={1}
                          max={365}
                          step={1}
                          value={filters.deltaShortDays}
                          onChange={(e) => setFilter('deltaShortDays')(e.target.value)}
                          style={FILTER_DELTA_DAYS_INPUT}
                          aria-label="RS 變化：短區間交易日數"
                        />
                        <span style={FILTER_DELTA_MID_TEXT_STYLE}>日</span>
                      </>
                    }
                    upperValue={filters.delta7dMax}
                    lowerValue={filters.delta7dMin}
                    onUpperChange={setFilter('delta7dMax')}
                    onLowerChange={setFilter('delta7dMin')}
                  />
                  <FilterSandwichBetween
                    centerAriaName={`RS變化·${deltaLongDaysResolved}日`}
                    centerSlot={
                      <>
                        <span style={FILTER_DELTA_MID_TEXT_STYLE}>Δ</span>
                        <input
                          {...FILTER_INPUT_MARK}
                          className="ibd-rs-filter-input"
                          type="number"
                          min={1}
                          max={365}
                          step={1}
                          value={filters.deltaLongDays}
                          onChange={(e) => setFilter('deltaLongDays')(e.target.value)}
                          style={FILTER_DELTA_DAYS_INPUT}
                          aria-label="RS 變化：長區間交易日數"
                        />
                        <span style={FILTER_DELTA_MID_TEXT_STYLE}>日</span>
                      </>
                    }
                    upperValue={filters.delta30dMax}
                    lowerValue={filters.delta30dMin}
                    onUpperChange={setFilter('delta30dMax')}
                    onLowerChange={setFilter('delta30dMin')}
                  />

                  <FilterSectionTitle>5D / 20D 漲跌幅（%）</FilterSectionTitle>
                  <FilterSandwichBetween
                    centerLabel="5D"
                    upperValue={filters.pct5dMax}
                    lowerValue={filters.pct5dMin}
                    onUpperChange={setFilter('pct5dMax')}
                    onLowerChange={setFilter('pct5dMin')}
                  />
                  <FilterSandwichBetween
                    centerLabel="20D"
                    upperValue={filters.pct20dMax}
                    lowerValue={filters.pct20dMin}
                    onUpperChange={setFilter('pct20dMax')}
                    onLowerChange={setFilter('pct20dMin')}
                  />

                  <FilterSectionTitle>HL（6M 區間價位 0～1）</FilterSectionTitle>
                  <FilterSandwichBetween
                    centerLabel="HL"
                    upperValue={filters.hlMax}
                    lowerValue={filters.hlMin}
                    onUpperChange={setFilter('hlMax')}
                    onLowerChange={setFilter('hlMin')}
                    upperPlaceholder="上限 例 0.8"
                    lowerPlaceholder="下限 例 0.3"
                  />

                  <FilterSectionTitle>型態（ibdRsHistory）</FilterSectionTitle>
                  <div
                    style={{
                      gridColumn: '1 / -1',
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: '#444',
                    }}
                  >
                    <span style={{ fontWeight: 700, color: '#134e4a' }}>向上突破</span>
                    <span>近</span>
                    <input
                      {...FILTER_INPUT_MARK}
                      className="ibd-rs-filter-input"
                      type="number"
                      min={1}
                      max={365}
                      value={filters.crossDays}
                      onChange={(e) => setFilter('crossDays')(e.target.value)}
                      placeholder="x"
                      style={{ ...FILTER_DELTA_DAYS_INPUT, width: 52 }}
                      aria-label="突破：視窗交易日數"
                    />
                    <span>個交易日內，RS 自下方穿越</span>
                    <input
                      {...FILTER_INPUT_MARK}
                      className="ibd-rs-filter-input"
                      type="number"
                      min={1}
                      max={99}
                      value={filters.crossLevel}
                      onChange={(e) => setFilter('crossLevel')(e.target.value)}
                      placeholder="y"
                      style={{ ...FILTER_DELTA_DAYS_INPUT, width: 52 }}
                      aria-label="突破：門檻 y"
                    />
                  </div>
                  <div
                    style={{
                      gridColumn: '1 / -1',
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: '#444',
                    }}
                  >
                    <span style={{ fontWeight: 700, color: '#134e4a' }}>區間新高</span>
                    <span>近</span>
                    <input
                      {...FILTER_INPUT_MARK}
                      className="ibd-rs-filter-input"
                      type="number"
                      min={1}
                      max={52}
                      value={filters.weeksNewHigh}
                      onChange={(e) => setFilter('weeksNewHigh')(e.target.value)}
                      placeholder="K"
                      style={{ ...FILTER_DELTA_DAYS_INPUT, width: 52 }}
                      aria-label="近 K 週（K×5 交易日）RS 新高"
                    />
                    <span>週（5 交易日）內 RS 最高</span>
                  </div>

                  <FilterSectionTitle>搜尋</FilterSectionTitle>
                  <div style={{ gridColumn: '1 / -1', minWidth: 0, maxWidth: 440 }}>
                    <FilterInput
                      inline
                      label="關鍵字"
                      value={filters.query}
                      onChange={setFilter('query')}
                      placeholder="代號或名稱"
                      type="text"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── 表格：並排多組（橫向捲在 .ibd-rs-ranking-table-scroll） ── */}
          <div style={{ marginBottom: 8 }}>
            {loading && stocks.length === 0 ? (
              <div style={{ padding: 36, textAlign: 'center', color: '#888', fontSize: 13 }}>載入中...</div>
            ) : visible.length === 0 ? (
              <div
                style={{
                  padding: 32,
                  textAlign: 'center',
                  color: '#888',
                  background: '#fff',
                  border: '1px solid #eee',
                  borderRadius: 6,
                }}
              >
                無符合條件的股票
              </div>
            ) : (
              <div
                className="ibd-rs-ranking-table-scroll"
                role="region"
                aria-label="RS 排名表（可橫向捲動檢視各欄）"
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${parallelChunksToShow.length}, ${IBDRS_QUADRANT_TABLE_WIDTH_PX}px)`,
                    gap: 8,
                    alignItems: 'start',
                    width: 'max-content',
                  }}
                >
                  {parallelChunksToShow.map((chunk, qi) => (
                    <IbdRsQuadrantTable
                      key={qi}
                      rows={chunk}
                      tdBase={tdBase}
                      thBase={thBase}
                      onNameClick={(s) => {
                        setChartNavOverride(null);
                        setSelectedStock(s);
                      }}
                      deltaShortLabel={`Δ${deltaShortDaysResolved}`}
                      deltaLongLabel={`Δ${deltaLongDaysResolved}`}
                      deltaShortTitle={deltaShortTitle}
                      deltaLongTitle={deltaLongTitle}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <details
            style={{
              fontSize: 11,
              color: '#888',
              paddingBottom: 16,
              marginTop: 2,
              borderTop: '1px solid #eee',
              paddingTop: 8,
            }}
          >
            <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 600, color: '#666' }}>
              公式與欄位說明（點開）
            </summary>
            <div style={{ lineHeight: 1.65, marginTop: 8, color: '#777' }}>
              <p style={{ margin: '4px 0' }}>
                <strong>RS 公式</strong>：[(P0−P3)×2 + (P3−P6) + (P6−P9) + (P9−P12)] / P12，
                P0=今日、P3=3個月前、…P12=12個月前（最近交易日收盤插值）。最近一季權重加倍，再對全體百分位排名 → 1∼99。
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>ΔN（兩欄）</strong>：今日 RS 減去 N 個<strong>交易日</strong>前之 RS（以 <code>ibdRsHistory</code> 筆數計，需足夠歷史）。篩選器可自訂兩欄 N（預設 7／30）。
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>RS 欄「—」但圖表有線</strong>：若 Firestore 頂層 <code>ibdRsRating</code> 未寫入、但{' '}
                <code>ibdRsHistory</code> 有資料（例如回填只合併歷史），表格會改以<strong>歷史最後一筆</strong>顯示，與折線圖同源；滑鼠移到 RS 格可看說明。
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>6M</strong>：近六個月（曆月）區間內最高／最低收盤，當前價在區間的位置；低點=0、高點=1（例：區間 100∼200、現價 150 → 0.50）。
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>同步</strong>：全市場一輪可能需數十分鐘；未滿 12 個月無 P12 者不參與排名（RS 顯示 —）。
              </p>
            </div>
          </details>

          <details
            style={{
              fontSize: 12,
              color: '#666',
              width: '100%',
              marginTop: 4,
              paddingTop: 12,
              paddingBottom: 8,
              borderTop: '1px solid #eee',
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                listStyle: 'none',
                fontWeight: 600,
                color: '#888',
              }}
            >
              進階維護（非每日必用）— 回填歷史、補齊清單
            </summary>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                marginTop: 10,
                alignItems: 'center',
              }}
            >
              <button
                type="button"
                onClick={handleHistoryBackfillClick}
                disabled={loading || syncing}
                title="全市場完整回填（約 180 日曆日內有資料的交易日；耗時長）"
                style={{ ...btnBase, background: '#fff', color: '#7c3aed', border: '1px solid #7c3aed', fontWeight: 800 }}
              >
                全市場·回填歷史
              </button>
              <button
                type="button"
                onClick={handleHistoryBackfillFirstWeekClick}
                disabled={loading || syncing}
                title="試跑：清單前 10 檔、最早 7 個交易日；RS 為此 10 檔內排名"
                style={{ ...btnBase, background: '#fff', color: '#9333ea', border: '1px solid #9333ea', fontSize: 11 }}
              >
                試跑·最早一週
              </button>
              <button
                type="button"
                onClick={handlePatchRatingFromHistoryClick}
                disabled={loading || syncing}
                title="僅補 Firestore：有歷史卻缺 ibdRsRating 的檔；不抓價、不重跑全市場同步"
                style={{ ...btnBase, background: '#fff', color: '#0d9488', border: '1px solid #14b8a6', fontSize: 11, fontWeight: 800 }}
              >
                補寫 RS 快照（歷史→頂層）
              </button>
              <button
                type="button"
                onClick={() => void handleRepairAllData()}
                disabled={loading || syncing}
                title="拉上市櫃清單、新增上櫃檔，並批次填補缺失 RS"
                style={{ ...btnBase, background: '#fff', color: '#0d9488', border: '1px solid #0d9488', fontSize: 11 }}
              >
                補齊所有資料
              </button>
              <p
                style={{
                  width: '100%',
                  margin: '4px 0 0',
                  fontSize: 11,
                  color: '#999',
                  lineHeight: 1.45,
                }}
              >
                <strong>畫線流程</strong>：試跑滿意後按<strong>「全市場·回填歷史」</strong>跑正式（通常<strong>做一次</strong>）；之後每天「同步今日 RS」只<strong>追加／更新當日</strong>（歷史最多 180 點）。
                <br />
                每日例行：頁面下方「同步今日 RS」。若<strong>回填後表上 RS 仍「—」但圖表有線</strong>：按<strong>「補寫 RS 快照」</strong>（不重跑同步）。補齊＝新上櫃／缺檔；試跑＝10 檔×7 日僅測流程。
              </p>
            </div>
          </details>

          {/* ── 底欄：同步／重新載入 ─────────────────────────────────────────── */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
              justifyContent: 'flex-end',
              marginTop: 16,
              paddingTop: 14,
              borderTop: '1px solid #eee',
            }}
          >
            <button
              type="button"
              onClick={handleSync}
              disabled={loading || syncing}
              title="按一次跑完全市場同步；Shift＝強制重抓 Yahoo"
              style={{
                ...btnBase,
                backgroundColor: syncing ? '#aaa' : '#25c2a0',
                color: '#fff',
                cursor: syncing ? 'wait' : 'pointer',
                fontSize: 13,
                padding: '7px 14px',
              }}
            >
              {syncing
                ? `同步 ${syncProgress?.done ?? 0}/${syncProgress?.total ?? 0}…`
                : '同步今日 RS'}
            </button>
            <button
              type="button"
              onClick={refresh}
              disabled={loading || syncing}
              title="僅從資料庫重新抓列表，不重新打 Yahoo"
              style={{ ...btnBase, background: '#fff', color: '#555', border: '1px solid #ccc' }}
            >
              重新載入
            </button>
            {syncing && (
              <button
                type="button"
                onClick={() => stopIbdRsBackgroundTask()}
                title="停止目前正在執行的任務"
                style={{ ...btnBase, background: '#fff', color: '#e74c3c', border: '1px solid #e74c3c' }}
              >
                停止
              </button>
            )}
          </div>

        </div>
      </main>

      {majorMovesOpen && (
        <MajorMovesModal
          onClose={() => setMajorMovesOpen(false)}
          items={majorMoveStocksToday}
          items80={rsBreakthrough80Today}
          items90={rsBreakthrough90Today}
          itemsHlHigh={hlHighList}
          refYmd={focusPanelRefYmd}
          calendarTodayYmd={todayYmd}
          majorDeltaGt={IBDRS_MAJOR_MOVE_DELTA_GT}
          majorRsGt={IBDRS_MAJOR_MOVE_RS_GT}
          deltaShortLabel={`Δ${deltaShortDaysResolved}`}
          deltaLongLabel={`Δ${deltaLongDaysResolved}`}
          deltaShortTitle={deltaShortTitle}
          deltaLongTitle={deltaLongTitle}
          onPickStock={(st) => {
            setChartNavOverride({
              list: mergeMajorMovesNavigationList(
                majorMoveStocksToday,
                rsBreakthrough80Today,
                rsBreakthrough90Today,
                hlHighList
              ),
            });
            setSelectedStock(st);
          }}
        />
      )}

      {selectedStock && (
        <RsChartModal
          stock={selectedStock}
          navigationList={chartNavigationList}
          onNavigate={setSelectedStock}
          onClose={() => {
            setSelectedStock(null);
            setChartNavOverride(null);
          }}
        />
      )}
    </Layout>
  );
}
