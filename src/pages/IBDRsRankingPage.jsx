/* src/pages/IBDRsRankingPage.jsx */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getDoc, onSnapshot, setDoc, updateDoc, doc } from 'firebase/firestore';
import { db } from '../utils/firebaseConfig';
import Layout from '@theme/Layout';
import { fetchIndexPriceMap, fetchYahooHistoricalPriceVolumeMaps, prefetchYahooKlineIfAbsent, getYahooKlineFromCache, fetchInstitutionalInvestorsSeries, fetchForeignHoldingSeries, instArraysToDateMap, instFreshnessBound, holdingsFreshnessBound } from '../features/StockAnalysis/api/stockApi';
import { syncSingleStock, syncTestBatch } from '../features/StockAnalysis/api/rsApi';
import { useIbdRsData } from '../features/StockAnalysis/hooks/useIbdRsData';
import {
  IBDRS_LAST_SYNC_DATE_KEY,
  startIbdRsHistoryBackfill,
  startIbdRsPatchRatingFromHistory,
  startIbdRsQuickPatch,
  stopIbdRsBackgroundTask,
} from '../features/StockAnalysis/services/ibdRsSyncService';
import {
  calcCompositeVcp,
  calcVcpPriceRatioFromHighLowMaps,
  calcVcpVolumeRatioFromVolumeMap,
  detectCrossUp,
  isRsKWeeksNewHigh,
  normalizeYmdToTaiwanTradingDay,
  VCP_WEIGHT_PRICE,
  VCP_WEIGHT_VOLUME,
} from '../features/StockAnalysis/utils/rsCalculator';
import IbdRsQuadrantTable from '../features/StockAnalysis/components/IbdRsQuadrantTable';
import {
  splitIntoColumnChunks,
  getDeltaColor,
  fmtDelta,
  getEffectiveDisplayRs,
  IBDRS_QUADRANT_TABLE_WIDTH_PX,
  IBDRS_QUADRANT_TABLE_WIDTH_WITH_UTIL_RS_PX,
} from '../features/StockAnalysis/utils/ibdRsRankingTableUtils';
import { clampIbdDeltaDays, enrichIbdRsRow } from '../features/StockAnalysis/utils/ibdRsRankingEnrich';
import {
  applyUtilityFilters,
  computeUtilityMetrics,
  UTILITY_DEFAULT_PARAMS,
  UTILITY_FAIL_LABELS,
  UTILITY_INDEX_LOOKBACK,
  UTILITY_MIN_DAYS_SINCE_HIGH,
  UTILITY_MAX_DAYS_SINCE_HIGH,
} from '../features/StockAnalysis/utils/utilityScreen';
import { RS_OPEN_STOCK_SESSION_KEY } from '../features/StockAnalysis/api/ibdRsWatchlistFirestore';
import { useIbdRsWatchlist } from '../features/StockAnalysis/hooks/useIbdRsWatchlist';
import { prefetchWatchlistChipData } from '../features/StockAnalysis/api/prefetchChipData';
import { IBD_RS_HOME_FIRST_SEEN_DOC_REF, SYNC_STATUS_DOC_REF } from '../utils/firebaseConfig';

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

/** 籌碼訊號標籤（外資/投信連買）CSS：modal 共用於 3 個頁面，故由 RsChartModal 自行注入。
 *  亮色維持琥珀底深字；暗色改半透明琥珀底＋亮字，避免淺底疊暗頁面。 */
const SIGNAL_NOTE_STYLE_ID = 'ibd-rs-signal-note-style';
const SIGNAL_NOTE_CSS = `
.ibd-rs-signal-note {
  color: #92400e;
  background: #fff8e1;
  border: 1px solid #f59e0b;
}
html[data-theme='dark'] .ibd-rs-signal-note {
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.13);
  border: 1px solid rgba(245, 158, 11, 0.55);
}
`;

/** 今日重點 modal：表格欄寬（px，與 colgroup 一致） */
const MM_FOCUS_COL_PX = {
  id: 46,
  name: 108,
  rs: 40,
  step: 44,
  dShort: 44,
  dLong: 44,
  p1d: 40,
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
  MM_FOCUS_COL_PX.p1d +
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
const MM_FOCUS_MODAL_WIDTH_FLOOR_PX = 700;

/** 首頁卡片：超過 15 檔改用分頁 */
const IBDRS_HOME_CARD_PAGE_SIZE = 15;
/** 首頁卡片：統一內容區高度（表頭 + 15 列） */
const IBDRS_HOME_CARD_TABLE_HEAD_PX = 32;
const IBDRS_HOME_CARD_ROW_PX = 26;
const IBDRS_HOME_CARD_BODY_MIN_PX = IBDRS_HOME_CARD_TABLE_HEAD_PX + IBDRS_HOME_CARD_PAGE_SIZE * IBDRS_HOME_CARD_ROW_PX;
/** 舊版 localStorage key（僅一次性匯入 Firestore 後清除） */
const IBDRS_HOME_FIRST_SEEN_MAP_KEY = 'ibd-rs-home-first-seen-v1';
/** 首頁藍點：首次出現後顯示天數 */
const IBDRS_HOME_DOT_DAYS = 3;
/** 首頁首次出現追蹤僅保留最近 3 個月（約 90 天） */
const IBDRS_HOME_FIRST_SEEN_KEEP_DAYS = 90;
/** 完整排行：每頁固定 4 個大欄 */
const IBDRS_PARALLEL_GROUPS = 4;
/** 手機版切換門檻（與既有樣式一致） */
const IBDRS_MOBILE_MAX_WIDTH_PX = 768;

/** 第一段「重大變動」：單日 |ΔRS| 須嚴格大於此值 */
const IBDRS_MAJOR_MOVE_DELTA_GT = 5;
/** 第一段「重大變動」：顯示用 RS 須嚴格大於此值 */
const IBDRS_MAJOR_MOVE_RS_GT = 80;
/** 「今日重點」：近 1 交易日股價漲跌幅絕對值 |%| 須嚴格大於此值（與 IBDRS_FOCUS_PRICE_RS_GT 並用） */
const IBDRS_FOCUS_PRICE_PCT_ABS_GT = 9;
/** 「今日重點」：漲跌幅段 RS 門檻 */
const IBDRS_FOCUS_PRICE_RS_GT = 85;

/** 「突破」門檻：前一歷史點 < 門檻、最後一點 ≥ 門檻（由下向上穿越） */
const IBDRS_RS_BREAK_LEVEL_80 = 80;
const IBDRS_RS_BREAK_LEVEL_90 = 90;

/** 觀察窗第三段：HL（6M 區間價位 0～1）須嚴格大於此值 */
const IBDRS_MODAL_HL_GT = 0.95;
/** 觀察窗第三段：與 HL 條件並用，RS 須嚴格大於此值 */
const IBDRS_MODAL_HL_RS_GT = 85;

/** 每個大欄（一張小表）一頁幾筆；完整排行固定每欄 25 檔 */
const IBDRS_ROWS_PER_QUADRANT = 25;

/** 第二頁大表：每頁總筆數（4 欄 × 各 25 檔 = 100 檔） */
const PAGE_SIZE = IBDRS_ROWS_PER_QUADRANT * IBDRS_PARALLEL_GROUPS;

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
  /* tw 子網域＝台灣站 UI 繁中；www 預設英文（與 StockLinkGenerator 一致） */
  return `https://tw.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
}

/** 個股名稱點擊：用搜尋引擎查 MoneyDJ + 股號 */
function getMoneyDjSearchUrl(stock) {
  const rawId = String(stock?.id ?? '')
    .replace(/\.(TW|TWO)$/i, '')
    .trim();
  if (!rawId) return null;
  const keyword = [rawId, String(stock?.name ?? '').trim(), '新聞'].filter(Boolean).join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(keyword)}`;
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

function parseYmdToUtcMs(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return null;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return Date.UTC(y, m - 1, d);
}

function dayDiffYmd(fromYmd, toYmd) {
  const a = parseYmdToUtcMs(fromYmd);
  const b = parseYmdToUtcMs(toYmd);
  if (a == null || b == null) return null;
  return Math.floor((b - a) / 86400000);
}

function loadHomeFirstSeenMap() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(IBDRS_HOME_FIRST_SEEN_MAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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

// ─── 子元件：篩選區塊標題 ────────────────────────────────────────────────────
// placeholder 顏色：FILTER_INPUT_MARK + custom.css / IBD_RS_PLACEHOLDER_CSS（行內 style 無法設 ::placeholder）

function FilterSectionTitle({ children }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 800,
        color: 'var(--app-accent)',
        letterSpacing: '0.04em',
        paddingBottom: 6,
        borderBottom: '1px solid var(--app-border)',
        lineHeight: 1.2,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 篩選面板：一個條件群組＝一張卡片。
 * 外層 grid 依面板寬度自動排成 1～3 欄；wide 的卡片（橫向長列）獨佔整行。
 */
function FilterCard({ title, children, wide = false, hint }) {
  return (
    <section
      style={{
        gridColumn: wide ? '1 / -1' : 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px 12px',
        border: '1px solid var(--app-border)',
        borderRadius: 10,
        background: 'var(--app-surface)',
        minWidth: 0,
      }}
    >
      <FilterSectionTitle>{title}</FilterSectionTitle>
      {hint ? (
        <div style={{ fontSize: 11, color: 'var(--app-text-soft)', lineHeight: 1.45 }}>{hint}</div>
      ) : null}
      {children}
    </section>
  );
}

/** 卡片內一列條件（標籤 + 控制項），自動換行 */
const FILTER_ROW_STYLE = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: 'var(--app-text)',
};

/** 卡片內粗體強調標籤（原本寫死 #134e4a） */
const FILTER_ROW_LABEL_STYLE = { fontWeight: 700, color: 'var(--app-accent-strong)' };

/**
 * 「標籤 ……… 控制項」一列：標籤靠左、控制項靠右。
 * 同一欄的多列因此對齊，不會因標籤長短而參差。
 */
function FilterParamRow({ label, title, unit, children }) {
  return (
    <div
      title={title}
      style={{
        display: 'grid',
        // 控制項欄固定 60px、單位欄固定 18px，各列的輸入框／勾選框才會左右對齊。
        // 用 auto 會讓有單位的列被單位文字擠窄、位置全部錯開。
        gridTemplateColumns: 'minmax(0, 1fr) 60px 18px',
        alignItems: 'center',
        gap: 8,
        maxWidth: 260,
        fontSize: 12,
        color: 'var(--app-text)',
      }}
    >
      <span style={FILTER_ROW_LABEL_STYLE}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', minWidth: 0 }}>
        {children}
      </span>
      <span style={{ color: 'var(--app-text-soft)', whiteSpace: 'nowrap' }}>{unit ?? ''}</span>
    </div>
  );
}

/** 篩選三明治：數字欄固定寬，勿 flex:1 拉滿整列 */
const FILTER_SANDWICH_INPUT = {
  padding: '5px 10px',
  border: '1px solid var(--app-border)',
  borderRadius: 6,
  fontSize: 12,
  flex: '0 1 auto',
  width: 106,
  minWidth: 76,
  maxWidth: 118,
  boxSizing: 'border-box',
  background: 'var(--ifm-background-color, #fff)',
  color: 'var(--ifm-font-color-base)',
};

/** 篩選「Δ [天數] 日」列：中間小輸入框樣式 */
const FILTER_DELTA_MID_TEXT_STYLE = {
  flex: '0 0 auto',
  fontWeight: 800,
  fontSize: 12,
  color: 'var(--app-accent-strong)',
  userSelect: 'none',
};

const FILTER_DELTA_DAYS_INPUT = {
  padding: '5px 8px',
  border: '1px solid var(--app-border)',
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

/** FilterParamRow 專用：填滿固定的控制項欄，讓同欄各列的輸入框左右邊界都對齊 */
const FILTER_PARAM_INPUT = {
  ...FILTER_DELTA_DAYS_INPUT,
  width: '100%',
  minWidth: 0,
  maxWidth: 'none',
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
    color: 'var(--app-accent-strong)',
    userSelect: 'none',
  };
  const centerKey = centerAriaName || (typeof centerLabel === 'string' ? centerLabel : '指標');
  const mid =
    centerSlot ??
    <span style={{ ...midStyle, minWidth: '2ch', textAlign: 'center' }}>{centerLabel}</span>;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
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

/** 今日重點各段合併為 ←→ 導覽順序；同檔多段只出現一次 */
function mergeMajorMovesNavigationList(items, itemsPriceBig, items80, items90, itemsHlHigh) {
  const seen = new Set();
  const out = [];
  for (const s of [...items, ...itemsPriceBig, ...items80, ...items90, ...itemsHlHigh]) {
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

/** 左右各 N 根內最高價嚴格較高 → 波段高點 */
function findOhlcSwingHighIndices(series, half) {
  const n = series.length;
  const out = [];
  for (let i = half; i < n - half; i++) {
    const h = series[i].high;
    let ok = true;
    for (let k = 1; k <= half; k++) {
      if (h <= series[i - k].high || h <= series[i + k].high) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** 左右各 N 根內最低價嚴格較低 → 波段低點 */
function findOhlcSwingLowIndices(series, half) {
  const n = series.length;
  const out = [];
  for (let i = half; i < n - half; i++) {
    const lo = series[i].low;
    let ok = true;
    for (let k = 1; k <= half; k++) {
      if (lo >= series[i - k].low || lo >= series[i + k].low) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** 同側轉折若太近（根數）只保留較極端者 */
function dedupeSwingHighsBySeparation(indices, series, minSepBars) {
  const sorted = [...indices].sort((a, b) => a - b);
  const out = [];
  for (const i of sorted) {
    if (out.length === 0) {
      out.push(i);
      continue;
    }
    const prev = out[out.length - 1];
    if (i - prev < minSepBars) {
      if (series[i].high > series[prev].high) out[out.length - 1] = i;
    } else {
      out.push(i);
    }
  }
  return out;
}

function dedupeSwingLowsBySeparation(indices, series, minSepBars) {
  const sorted = [...indices].sort((a, b) => a - b);
  const out = [];
  for (const i of sorted) {
    if (out.length === 0) {
      out.push(i);
      continue;
    }
    const prev = out[out.length - 1];
    if (i - prev < minSepBars) {
      if (series[i].low < series[prev].low) out[out.length - 1] = i;
    } else {
      out.push(i);
    }
  }
  return out;
}

/** 標籤過多時沿時間軸大致均勻抽樣 */
function thinSwingIndicesEvenly(indices, maxKeep) {
  if (indices.length <= maxKeep) return indices;
  const sorted = [...indices].sort((a, b) => a - b);
  const out = [];
  const step = (sorted.length - 1) / Math.max(1, maxKeep - 1);
  for (let k = 0; k < maxKeep; k++) {
    out.push(sorted[Math.round(k * step)]);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * 單一 SVG 把 K 棒、RS 線、大盤線畫在同一套座標系，徹底消除 overlay 對位誤差。
 * - X 軸：每筆資料等寬 slot，K 棒中心 = RS/大盤折線點位，完全一致
 * - Y 軸左：RS 固定 1-99；Y 軸右：大盤指數 auto；K 棒獨立 Y（不影響其他 Y 軸）
 */
function IbdRsComboChart({ data, showMA = true, showRs = true }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 640, h: 320 });
  const [hoverIdx, setHoverIdx] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(200, el.clientWidth || 200);
      const h = Math.max(160, el.clientHeight || 320);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    return () => { if (ro) ro.disconnect(); };
  }, []);

  const PAD_L = 22;
  const PAD_R = 28;
  const PAD_T = 10;
  const PAD_B = 26;

  const { w, h } = size;
  const innerW = Math.max(1, w - PAD_L - PAD_R);
  const innerH = Math.max(1, h - PAD_T - PAD_B);

  const n = data.length;
  const slot = n > 0 ? innerW / n : innerW;
  const xAt = (i) => PAD_L + (i + 0.5) * slot;
  const barW = Math.min(10, Math.max(1.5, slot * 0.62));

  /* RS Y: 固定 1-99 */
  const yRs = (v) => PAD_T + innerH - ((v - 1) / 98) * innerH;

  /* Price Y: 從 OHLC 資料 auto */
  let pMin = Infinity; let pMax = -Infinity;
  for (const d of data) {
    if (Number.isFinite(d.low))  pMin = Math.min(pMin, d.low);
    if (Number.isFinite(d.high)) pMax = Math.max(pMax, d.high);
  }
  const hasOhlc = Number.isFinite(pMin);
  if (hasOhlc) { const pp = (pMax - pMin || pMax * 0.01 || 1) * 0.05; pMin -= pp; pMax += pp; }
  const yPrice = hasOhlc ? (v) => PAD_T + innerH - ((v - pMin) / (pMax - pMin)) * innerH : () => PAD_T;

  /* Index Y: auto */
  let iMin = Infinity; let iMax = -Infinity;
  for (const d of data) {
    if (Number.isFinite(d.idx)) { iMin = Math.min(iMin, d.idx); iMax = Math.max(iMax, d.idx); }
  }
  const hasIdx = Number.isFinite(iMin);
  if (hasIdx) { const ip = (iMax - iMin || iMax * 0.01 || 1) * 0.06; iMin -= ip; iMax += ip; }
  const yIdx = hasIdx ? (v) => PAD_T + innerH - ((v - iMin) / (iMax - iMin)) * innerH : () => PAD_T;

  /* Volume: 疊在主圖底部，最高佔 innerH 的 20%（TradingView 風格） */
  const hasVolData = data.some((d) => Number.isFinite(d.volume) && d.volume > 0);
  const VOL_MAX_H = Math.round(innerH * 0.20);
  let volMax = 0;
  for (const d of data) { if (Number.isFinite(d.volume) && d.volume > volMax) volMax = d.volume; }
  const volBarH = (vol) => (!volMax || !Number.isFinite(vol) || vol <= 0) ? 0 : Math.max(1, (vol / volMax) * VOL_MAX_H);

  /* Polyline segments（處理 null 斷點） */
  const buildSegs = (fn) => {
    const segs = []; let seg = [];
    data.forEach((d, i) => {
      const v = fn(d, i);
      if (Number.isFinite(v)) { seg.push(`${xAt(i).toFixed(2)},${v.toFixed(2)}`); }
      else if (seg.length) { segs.push(seg.join(' ')); seg = []; }
    });
    if (seg.length) segs.push(seg.join(' '));
    return segs;
  };
  const rsSegs  = buildSegs((d) => (Number.isFinite(d.rs)  ? yRs(d.rs)   : null));
  const idxSegs = buildSegs((d) => (Number.isFinite(d.idx) ? yIdx(d.idx) : null));

  /* 均線 MA：由 chartData 預先在「含暖身段」序列上算好（d.ma10/d.ma20），這裡只負責畫，
     所以 MA 能從第一根 K 棒就有值，不再因暖身不足而從中間才出現（價格刻度） */
  // 超出可見價格域（pMin~pMax，已含 5% padding）的 MA 點視為斷點不畫，避免溢出格子，
  // 同時不擴張刻度 → 切換 MA 開關時 K 棒不會跳動
  const inBand = (v) => Number.isFinite(v) && v >= pMin && v <= pMax;
  const ma10Segs = hasOhlc ? buildSegs((d) => (inBand(d.ma10) ? yPrice(d.ma10) : null)) : [];
  const ma20Segs = hasOhlc ? buildSegs((d) => (inBand(d.ma20) ? yPrice(d.ma20) : null)) : [];

  /* X ticks：最多 7 筆 */
  const MAX_X_TICKS = 7;
  const xTickIdxs = n <= MAX_X_TICKS
    ? data.map((_, i) => i)
    : Array.from({ length: MAX_X_TICKS }, (_, k) => Math.round((k * (n - 1)) / (MAX_X_TICKS - 1)));

  /* RS Y ticks */
  const rsTicks = [1, 25, 50, 75, 99];
  /* Index Y ticks */
  const idxTicks = hasIdx
    ? [0, 1, 2, 3].map((t) => iMin + ((iMax - iMin) * t) / 3)
    : [];

  /* Hover（滑鼠 + 觸控；觸控不可 stopPropagation，讓冒泡到 modal 以橫滑換股） */
  const applyHoverClient = (svgEl, clientX, clientY) => {
    if (n === 0) return;
    const rect = svgEl.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const i = Math.round((mx - PAD_L) / slot - 0.5);
    setHoverIdx(Math.max(0, Math.min(n - 1, i)));
    setMousePos({ x: mx, y: my });
  };

  const handleMouseMove = (e) => {
    applyHoverClient(e.currentTarget, e.clientX, e.clientY);
  };

  const handleChartTouchStart = (e) => {
    // 不可 stopPropagation：須冒泡到個股 modal panel 才能偵測橫滑換股
    e.preventDefault();
    const t = e.touches[0];
    if (t) applyHoverClient(e.currentTarget, t.clientX, t.clientY);
  };

  const handleChartTouchMove = (e) => {
    e.preventDefault();
    const t = e.touches[0];
    if (t) applyHoverClient(e.currentTarget, t.clientX, t.clientY);
  };

  const handleChartTouchEnd = (e) => {
    if (e) e.preventDefault();
    setHoverIdx(null);
  };

  const handleChartWheel = (e) => {
    // 防止觸控板/滑鼠滾輪在圖表上誤觸造成 modal 或背景捲動
    e.preventDefault();
    e.stopPropagation();
  };

  const hd = hoverIdx != null ? data[hoverIdx] : null;
  const tooltipHeightEstimate = 140;
  const tooltipTop =
    hoverIdx == null
      ? 0
      : Math.min(
          Math.max(4, h - tooltipHeightEstimate - 4),
          Math.max(4, mousePos.y - 10),
        );

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg
        width={w}
        height={h}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          cursor: 'crosshair',
          touchAction: 'none',
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={handleChartTouchStart}
        onTouchMove={handleChartTouchMove}
        onTouchEnd={handleChartTouchEnd}
        onTouchCancel={handleChartTouchEnd}
        onWheel={handleChartWheel}
      >
        {/* 繪圖區底色 */}
        <rect x={PAD_L} y={PAD_T} width={innerW} height={innerH} fill="var(--app-surface)" />

        {/* 水平 grid */}
        {rsTicks.map((v) => {
          const y = yRs(v);
          return <line key={`g-${v}`} x1={PAD_L} y1={y} x2={PAD_L + innerW} y2={y} stroke="var(--app-border)" strokeWidth={1} strokeDasharray="3 3" />;
        })}

        {/* K 棒（opacity 疊加在折線之下） */}
        {hasOhlc && data.map((d, i) => {
          if (!Number.isFinite(d.open) || !Number.isFinite(d.high) || !Number.isFinite(d.low) || !Number.isFinite(d.close)) return null;
          const xc = xAt(i);
          const prevClose = i > 0 && Number.isFinite(data[i - 1]?.close) ? data[i - 1].close : null;
          // 有真實 open（open ≠ close）用 close vs open；否則退回 close vs 昨收
          const up = (d.open !== d.close)
            ? d.close >= d.open
            : prevClose != null ? d.close >= prevClose : true;
          const fill   = up ? '#e53935' : '#1a8a30';
          const stroke = up ? '#c62828' : '#0f5c1e';
          const yH = yPrice(d.high); const yL = yPrice(d.low);
          const yO = yPrice(d.open); const yC = yPrice(d.close);
          const bodyTop = Math.min(yO, yC);
          const bodyH   = Math.max(Math.abs(yC - yO), 1);
          return (
            <g key={`k-${d.dateKey}`} opacity={0.85}>
              <line x1={xc} y1={yH} x2={xc} y2={yL} stroke={stroke} strokeWidth={0.9} />
              <rect x={xc - barW / 2} y={bodyTop} width={barW} height={bodyH} fill={fill} stroke={stroke} strokeWidth={0.8} />
            </g>
          );
        })}

        {/* 均線 MA10 / MA20（價格刻度，疊在 K 棒之上）；showMA 關閉時不顯示 */}
        {showMA && hasOhlc && ma10Segs.map((pts, i) => (
          <polyline key={`ma10-${i}`} points={pts} fill="none" stroke="#f59e0b" strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {showMA && hasOhlc && ma20Segs.map((pts, i) => (
          <polyline key={`ma20-${i}`} points={pts} fill="none" stroke="#7c3aed" strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* 大盤折線 */}
        {idxSegs.map((pts, i) => (
          <polyline key={`idx-${i}`} points={pts} fill="none" stroke="#1565c0" strokeWidth={1.55} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* RS 折線（週線模式不顯示） */}
        {showRs && rsSegs.map((pts, i) => (
          <polyline key={`rs-${i}`} points={pts} fill="none" stroke="#c0392b" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* 量能柱（疊在主圖底部，TradingView 風格） */}
        {hasVolData && data.map((d, i) => {
          if (!Number.isFinite(d.volume) || d.volume <= 0) return null;
          const bh = volBarH(d.volume);
          const xc = xAt(i);
          const prevClose = i > 0 && Number.isFinite(data[i - 1]?.close) ? data[i - 1].close : null;
          const up = (Number.isFinite(d.open) && d.open !== d.close)
            ? d.close >= d.open
            : prevClose != null ? d.close >= prevClose : true;
          return (
            <rect
              key={`vb-${d.dateKey}`}
              x={xc - barW / 2}
              y={PAD_T + innerH - bh}
              width={barW}
              height={bh}
              fill={up ? 'rgba(229,57,53,0.22)' : 'rgba(46,125,50,0.22)'}
            />
          );
        })}

        {/* Hover 十字線 */}
        {hoverIdx != null && (
          <line x1={xAt(hoverIdx)} y1={PAD_T} x2={xAt(hoverIdx)} y2={PAD_T + innerH} stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 3" />
        )}

        {/* 左軸 RS（週線模式不顯示） */}
        {showRs && rsTicks.map((v) => (
          <text key={`rl-${v}`} x={PAD_L - 3} y={yRs(v) + 4} textAnchor="end" fontSize={10} fill="#c0392b" style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</text>
        ))}

        {/* 右軸 大盤 */}
        {idxTicks.map((v, i) => (
          <text key={`il-${i}`} x={PAD_L + innerW + 3} y={yIdx(v) + 4} textAnchor="start" fontSize={10} fill="#1565c0" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}
          </text>
        ))}

        {/* X 軸日期 */}
        {xTickIdxs.map((i) => (
          <text key={`xl-${i}`} x={xAt(i)} y={PAD_T + innerH + 16} textAnchor="middle" fontSize={10} fill="var(--app-text-soft)">
            {String(data[i]?.dateKey || '').slice(5)}
          </text>
        ))}

        {/* X 軸底線 */}
        <line x1={PAD_L} y1={PAD_T + innerH} x2={PAD_L + innerW} y2={PAD_T + innerH} stroke="var(--app-border)" strokeWidth={1} />
      </svg>

      {/* Tooltip */}
      {hd && (
        <div
          style={{
            position: 'absolute',
            top: tooltipTop,
            left: mousePos.x > w / 2 ? Math.max(4, mousePos.x - 175) : mousePos.x + 14,
            pointerEvents: 'none',
            zIndex: 20,
            fontSize: 12,
            lineHeight: 1.5,
            borderRadius: 8,
            border: '1px solid var(--app-border)',
            backgroundColor: 'var(--app-surface)',
            boxShadow: '0 8px 24px rgba(15,23,42,0.18)',
            padding: '10px 12px',
            minWidth: 148,
          }}
        >
          <div style={{ color: 'var(--app-text-soft)', fontWeight: 700, marginBottom: 6, borderBottom: '1px solid var(--app-border)', paddingBottom: 6 }}>
            {hd.dateKey}
          </div>
          {showRs && hd.rs != null && (
            <div style={{ color: '#c0392b', fontWeight: 600, paddingBottom: 2 }}>RS：{hd.rs}</div>
          )}
          {hd.idx != null && (
            <div style={{ color: '#1565c0', fontWeight: 600, paddingBottom: 2 }}>加權：{Number(hd.idx).toLocaleString()}</div>
          )}
          {Number.isFinite(hd.close) && (
            <div style={{ color: 'var(--app-text-soft)', fontWeight: 700, paddingBottom: 2 }}>收：{Math.round(hd.close)}</div>
          )}
          {Number.isFinite(hd.close) && hoverIdx > 0 && Number.isFinite(data[hoverIdx - 1]?.close) && (() => {
            const pct = (hd.close - data[hoverIdx - 1].close) / data[hoverIdx - 1].close * 100;
            return (
              <div style={{ color: pct > 0 ? '#c0392b' : pct < 0 ? '#2e7d32' : '#666', fontWeight: 700 }}>
                漲跌：{pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/** Yahoo 日 K：SVG 蠟燭（台股 紅漲／綠跌）
 * @param {'default'|'overlay'} [variant] overlay＝無座標、寬度撐滿容器，供疊在折線圖上半透明參考
 */
function IbdRsOhlcChart({ series, height = 232, fillHeight = false, variant = 'default' }) {
  const wrapRef = useRef(null);
  const [box, setBox] = useState({ w: 640, h: height });

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(200, el.clientWidth || 200);
      const h = fillHeight ? Math.max(200, el.clientHeight || height) : height;
      setBox({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fillHeight, height]);

  const svg = useMemo(() => {
    if (!Array.isArray(series) || series.length === 0) return null;
    const cw = box.w;
    const plotH = box.h;
    const n = series.length;
    const MIN_SLOT_PER_BAR = 7.5;
    const isOverlay = variant === 'overlay';
    const padL = isOverlay ? 0 : 54;
    const padR = isOverlay ? 0 : 10;
    const padT = isOverlay ? 2 : 10;
    const padB = isOverlay ? 2 : 22;

    let minP = Infinity;
    let maxP = -Infinity;
    for (const o of series) {
      minP = Math.min(minP, o.low);
      maxP = Math.max(maxP, o.high);
    }
    if (!Number.isFinite(minP) || !Number.isFinite(maxP)) return null;
    const span = maxP - minP || Math.abs(maxP) * 0.01 || 1;
    const padPrice = span * 0.03;
    const yMin = minP - padPrice;
    const yMax = maxP + padPrice;

    const containerInner = Math.max(40, cw - padL - padR);
    const innerW = isOverlay ? containerInner : Math.max(n * MIN_SLOT_PER_BAR, containerInner);
    const svgWidth = padL + innerW + padR;
    const innerH = Math.max(60, plotH - padT - padB);
    const slot = innerW / n;
    const xAt = (i) => padL + (i + 0.5) * slot;
    const barW = Math.min(11, Math.max(1.5, slot * (isOverlay ? 0.52 : 0.55)));
    const yAt = (p) => padT + innerH - ((p - yMin) / (yMax - yMin)) * innerH;

    const candles = series.map((o, i) => {
      const xc = xAt(i);
      const yH = yAt(o.high);
      const yL = yAt(o.low);
      const yO = yAt(o.open);
      const yC = yAt(o.close);
      const up = o.close >= o.open;
      const fill = up ? 'rgba(229,57,53,0.25)' : 'rgba(26,138,48,0.25)';
      const stroke = up ? '#c62828' : '#0f5c1e';
      const bodyTop = Math.min(yO, yC);
      const bodyBot = Math.max(yO, yC);
      const bodyH = Math.max(bodyBot - bodyTop, 1);
      return (
        <g key={o.dateStr + i}>
          <line x1={xc} y1={yH} x2={xc} y2={yL} stroke={stroke} strokeWidth={isOverlay ? 0.9 : 1} />
          <rect
            x={xc - barW / 2}
            y={bodyTop}
            width={barW}
            height={bodyH}
            fill={fill}
            stroke={stroke}
            strokeWidth={1}
          />
        </g>
      );
    });

    const SWING_HALF = 5;
    const SWING_MIN_SEP = 12;
    const SWING_MAX_EACH = 8;
    let swingHighIdx =
      n >= SWING_HALF * 2 + 1
        ? dedupeSwingHighsBySeparation(findOhlcSwingHighIndices(series, SWING_HALF), series, SWING_MIN_SEP)
        : [];
    let swingLowIdx =
      n >= SWING_HALF * 2 + 1
        ? dedupeSwingLowsBySeparation(findOhlcSwingLowIndices(series, SWING_HALF), series, SWING_MIN_SEP)
        : [];
    swingHighIdx = thinSwingIndicesEvenly(swingHighIdx, SWING_MAX_EACH);
    swingLowIdx = thinSwingIndicesEvenly(swingLowIdx, SWING_MAX_EACH);

    const hiFill = '#c62828';
    const loFill = '#1b5e20';
    const labelFontSize = 10;
    const labelTextStroke = 'rgba(255,255,255,0.92)';
    const labelStrokeW = 2.95;

    const swingLabels = (
      <g style={{ pointerEvents: 'none' }}>
        {swingHighIdx.map((i) => {
          const xc = xAt(i);
          const yH = yAt(series[i].high);
          const txt = String(Math.round(series[i].high));
          const placeBelow = yH - 26 < padT + 1;
          const textY = placeBelow ? yH + 15 : yH - 13;
          return (
            <text
              key={`sw-h-${i}`}
              x={xc}
              y={textY}
              textAnchor="middle"
              fontSize={labelFontSize}
              fontWeight={700}
              fill={hiFill}
              stroke={labelTextStroke}
              strokeWidth={labelStrokeW}
              paintOrder="stroke"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {txt}
            </text>
          );
        })}
        {swingLowIdx.map((i) => {
          const xc = xAt(i);
          const yL = yAt(series[i].low);
          const txt = String(Math.round(series[i].low));
          const placeAbove = yL + 24 > plotH - 3;
          const textY = placeAbove ? yL - 9 : yL + 17;
          return (
            <text
              key={`sw-l-${i}`}
              x={xc}
              y={textY}
              textAnchor="middle"
              fontSize={labelFontSize}
              fontWeight={700}
              fill={loFill}
              stroke={labelTextStroke}
              strokeWidth={labelStrokeW}
              paintOrder="stroke"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {txt}
            </text>
          );
        })}
      </g>
    );

    if (isOverlay) {
      return (
        <svg width={svgWidth} height={plotH} style={{ display: 'block', width: '100%' }}>
          <g style={{ opacity: 0.9 }}>{candles}</g>
          {swingLabels}
        </svg>
      );
    }

    const priceTickCount = 4;
    const tickVals = [];
    for (let t = 0; t < priceTickCount; t++) {
      tickVals.push(yMin + ((yMax - yMin) * t) / (priceTickCount - 1));
    }

    const xLabel = series.map((o, i) => {
      if (n <= 8 || i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
        const xc = xAt(i);
        const short = o.dateStr.slice(5);
        return (
          <text key={`xl-${i}`} x={xc} y={plotH - 6} textAnchor="middle" fontSize={10} fill="#64748b">
            {short}
          </text>
        );
      }
      return null;
    });

    return (
      <svg width={svgWidth} height={plotH} style={{ display: 'block', minWidth: svgWidth }}>
        <rect x={padL} y={padT} width={innerW} height={innerH} rx={4} fill="#fff" stroke="#e5e7eb" strokeWidth={1} />
        {tickVals.map((tv, i) => {
          const y = yAt(tv);
          return (
            <g key={`g-${i}`}>
              <line x1={padL} y1={y} x2={padL + innerW} y2={y} stroke="#f1f5f9" strokeWidth={1} />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize={10} fill="#64748b" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {tv.toFixed(2)}
              </text>
            </g>
          );
        })}
        {candles}
        {swingLabels}
        {xLabel}
      </svg>
    );
  }, [series, box.w, box.h, variant]);

  const outerH = fillHeight ? '100%' : height;

  return (
    <div
      ref={wrapRef}
      style={{
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        height: outerH,
        minHeight: fillHeight ? 168 : undefined,
        flex: fillHeight ? '1 1 0' : undefined,
        overflowX: variant === 'overlay' ? 'hidden' : 'auto',
        overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
        overscrollBehaviorX: 'contain',
        borderRadius: variant === 'overlay' ? 0 : 6,
        background: variant === 'overlay' ? 'transparent' : '#f8fafc',
      }}
    >
      {svg || (
        <div
          style={{
            height: fillHeight ? '100%' : height,
            minHeight: 120,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#9ca3af',
            fontSize: 12,
          }}
        >
          無 K 線資料
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────
// 外資視窗輔助：計算歷史 B 訊號（最近 130 個交易日）
// holdings: newest-first 日頻陣列（每日晚上 10 點後更新）
// ─────────────────────────────────────────────────
function computeHistoricalForeignBSignals(holdings) {
  const N = 10;
  if (!holdings || holdings.length < 720) return [];
  const n = holdings.length;
  const rocs = new Array(n).fill(null);
  for (let i = 0; i <= n - N - 1; i++) {
    const prev = holdings[i + N];
    if (prev && prev !== 0) rocs[i] = (holdings[i] - prev) / prev;
  }
  const limit = Math.min(130, n - 705);
  const signals = new Array(limit).fill('N');
  for (let i = 0; i < limit; i++) {
    if (rocs[i] === null) continue;
    const past = [];
    for (let j = i + 1; j <= i + 700 && j < n; j++) {
      if (rocs[j] !== null) past.push(rocs[j]);
    }
    if (past.length < 600) continue;
    const len = past.length;
    const mean = past.reduce((a, b) => a + b, 0) / len;
    const stdDev = Math.sqrt(past.reduce((a, b) => a + (b - mean) ** 2, 0) / len);
    if (stdDev > 0 && rocs[i] > stdDev) signals[i] = 'B';
  }
  return signals; // index 0 = 今天, index 1 = 昨天, ...
}

// ─────────────────────────────────────────────────
// 外資籌碼視窗圖表
// data: [{dateKey, open, high, low, close, holding, bSignal, foreign, trust, dealer}]
// ─────────────────────────────────────────────────
function ForeignChipChart({ data, allHoldings }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 640, h: 320 });
  const [hoverIdx, setHoverIdx] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  /** 三大法人 Y 軸縮放（在下格拖動調整）*/
  const [chipScale, setChipScale] = useState(1.0);
  const chipScaleDragRef = useRef({ active: false, startY: 0, startScale: 1 });

  useEffect(() => {
    const stop = () => { chipScaleDragRef.current.active = false; };
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);
    return () => { window.removeEventListener('mouseup', stop); window.removeEventListener('touchend', stop); };
  }, []);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(200, el.clientWidth || 200);
      const h = Math.max(160, el.clientHeight || 320);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    return () => { if (ro) ro.disconnect(); };
  }, []);

  const PAD_L = 44; const PAD_R = 50; const PAD_T = 10; const PAD_B = 26;
  const { w, h } = size;
  const innerW = Math.max(1, w - PAD_L - PAD_R);
  const innerH = Math.max(1, h - PAD_T - PAD_B);

  // 上格 K 線 + 下格三大法人
  const CHIP_H = Math.round(innerH * 0.34);
  const CHIP_GAP = 5;
  const MAIN_H = innerH - CHIP_H - CHIP_GAP;

  const n = data.length;
  const slot = n > 0 ? innerW / n : innerW;
  const xAt  = (i) => PAD_L + (i + 0.5) * slot;
  const barW = Math.min(10, Math.max(1.5, slot * 0.62));

  // K 線 Y 軸（上格）
  let pMin = Infinity; let pMax = -Infinity;
  for (const d of data) {
    if (Number.isFinite(d.low))  pMin = Math.min(pMin, d.low);
    if (Number.isFinite(d.high)) pMax = Math.max(pMax, d.high);
  }
  const hasOhlc = Number.isFinite(pMin);
  if (hasOhlc) { const pp = (pMax - pMin || pMax * 0.01 || 1) * 0.05; pMin -= pp; pMax += pp; }
  const yPrice = hasOhlc ? (v) => PAD_T + MAIN_H - ((v - pMin) / (pMax - pMin)) * MAIN_H : () => PAD_T;

  // 右軸：外資持股（絕對張數）
  let hMin = Infinity; let hMax = -Infinity;
  for (const d of data) {
    if (Number.isFinite(d.holding)) { hMin = Math.min(hMin, d.holding); hMax = Math.max(hMax, d.holding); }
  }
  const hasHolding = Number.isFinite(hMin);
  // padding 倍率 0.6 → Y 軸範圍是實際波幅的 2.2 倍，金線壓縮在中間約 45% 高度
  if (hasHolding) { const hp = (hMax - hMin || Math.abs(hMax) * 0.01 || 1) * 0.6; hMin -= hp; hMax += hp; }
  const yHolding = hasHolding ? (v) => PAD_T + MAIN_H - ((v - hMin) / (hMax - hMin)) * MAIN_H : () => PAD_T;
  const toPct = () => null; // unused, kept for tooltip compat
  const firstHoldingPct = null;

  // 下格：三大法人，以零軸為中心
  const chipYBase = PAD_T + MAIN_H + CHIP_GAP;
  const chipMid   = chipYBase + CHIP_H / 2;
  let chipAbsMax = 1;
  for (const d of data) {
    if (Number.isFinite(d.foreign)) chipAbsMax = Math.max(chipAbsMax, Math.abs(d.foreign));
    if (Number.isFinite(d.trust))   chipAbsMax = Math.max(chipAbsMax, Math.abs(d.trust));
    if (Number.isFinite(d.dealer))  chipAbsMax = Math.max(chipAbsMax, Math.abs(d.dealer));
  }
  chipAbsMax *= 1.05 * chipScale;
  const yChip    = (v) => { if (!Number.isFinite(v)) return chipMid; return chipMid - (v / chipAbsMax) * (CHIP_H / 2); };
  const chipBarH = (v) => Math.abs(yChip(v) - chipMid);

  // 持股折線段
  const buildSegs = (fn) => {
    const segs = []; let seg = [];
    data.forEach((d, i) => {
      const v = fn(d);
      if (Number.isFinite(v)) { seg.push(`${xAt(i).toFixed(2)},${v.toFixed(2)}`); }
      else if (seg.length) { segs.push(seg.join(' ')); seg = []; }
    });
    if (seg.length) segs.push(seg.join(' '));
    return segs;
  };

  // 持股金線：原始資料，Y 軸已透過 padding 倍率壓縮，不另做平滑
  const holdingSegs = buildSegs((d) => hasHolding && Number.isFinite(d.holding) ? yHolding(d.holding) : null);

  // 投信累積持股折線（以最早日為 0 基準，逐日累加買賣超）
  let tcCum = 0;
  const trustCumVals = data.map((d) => {
    if (Number.isFinite(d.trust)) tcCum += d.trust;
    return tcCum;
  });
  let tcMin = Infinity; let tcMax = -Infinity;
  for (const v of trustCumVals) { tcMin = Math.min(tcMin, v); tcMax = Math.max(tcMax, v); }
  const hasTrustCum = tcMin !== Infinity && tcMax !== tcMin;
  if (hasTrustCum) { const tp = (tcMax - tcMin) * 0.6; tcMin -= tp; tcMax += tp; }
  const yTrustCum = hasTrustCum
    ? (v) => PAD_T + MAIN_H - ((v - tcMin) / (tcMax - tcMin)) * MAIN_H
    : () => PAD_T;
  const trustCumSegs = (() => {
    const segs = []; let seg = [];
    trustCumVals.forEach((v, i) => {
      if (Number.isFinite(v)) seg.push(`${xAt(i).toFixed(2)},${yTrustCum(v).toFixed(2)}`);
      else if (seg.length) { segs.push(seg.join(' ')); seg = []; }
    });
    if (seg.length) segs.push(seg.join(' '));
    return segs;
  })();

  // X 軸 ticks
  const MAX_X_TICKS = 7;
  const xTickIdxs = n <= MAX_X_TICKS
    ? data.map((_, i) => i)
    : Array.from({ length: MAX_X_TICKS }, (_, k) => Math.round((k * (n - 1)) / (MAX_X_TICKS - 1)));

  // 在下格拖動調整縮放
  const applyScaleDrag = (cy) => {
    const { startY, startScale } = chipScaleDragRef.current;
    setChipScale(Math.min(8, Math.max(0.15, startScale * Math.exp((cy - startY) / 120))));
  };
  const applyHover = (svgEl, cx, cy) => {
    if (n === 0) return;
    const rect = svgEl.getBoundingClientRect();
    const mx = cx - rect.left; const my = cy - rect.top;
    setHoverIdx(Math.max(0, Math.min(n - 1, Math.round((mx - PAD_L) / slot - 0.5))));
    setMousePos({ x: mx, y: my });
  };
  const handleMouseDown = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if ((e.clientY - rect.top) >= chipYBase) {
      e.preventDefault();
      chipScaleDragRef.current = { active: true, startY: e.clientY, startScale: chipScale };
    }
  };
  const handleMouseMove = (e) => {
    if (chipScaleDragRef.current.active) { applyScaleDrag(e.clientY); return; }
    applyHover(e.currentTarget, e.clientX, e.clientY);
  };
  const handleTouchStart = (e) => {
    e.preventDefault(); const t = e.touches[0]; if (!t) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if ((t.clientY - rect.top) >= chipYBase) {
      chipScaleDragRef.current = { active: true, startY: t.clientY, startScale: chipScale };
    } else { applyHover(e.currentTarget, t.clientX, t.clientY); }
  };
  const handleTouchMove = (e) => {
    e.preventDefault(); const t = e.touches[0]; if (!t) return;
    if (chipScaleDragRef.current.active) { applyScaleDrag(t.clientY); return; }
    applyHover(e.currentTarget, t.clientX, t.clientY);
  };
  const handleTouchEnd  = (e) => { if (e) e.preventDefault(); chipScaleDragRef.current.active = false; setHoverIdx(null); };
  const handleWheel     = (e) => { e.preventDefault(); e.stopPropagation(); };

  const hd = hoverIdx != null ? data[hoverIdx] : null;
  const tooltipTop = hoverIdx == null ? 0 : Math.min(Math.max(4, h - 180), Math.max(4, mousePos.y - 10));
  const isInChipArea = mousePos.y >= chipYBase;
  const holdingTicks = hasHolding ? [0, 1, 2, 3].map((t) => hMin + ((hMax - hMin) * t) / 3) : [];

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg
        width={w} height={h}
        style={{ display: 'block', width: '100%', height: '100%', cursor: chipScaleDragRef.current.active ? 'ns-resize' : 'crosshair', touchAction: 'none' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { chipScaleDragRef.current.active = false; setHoverIdx(null); }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onWheel={handleWheel}
      >
        {/* 上格底色 */}
        <rect x={PAD_L} y={PAD_T} width={innerW} height={MAIN_H} fill="var(--app-surface)" />
        {/* 下格底色 */}
        <rect x={PAD_L} y={chipYBase} width={innerW} height={CHIP_H} fill="var(--app-surface-2)" />

        {/* 上格 grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <line key={`pg-${t}`} x1={PAD_L} y1={PAD_T + MAIN_H * t} x2={PAD_L + innerW} y2={PAD_T + MAIN_H * t} stroke="var(--app-border)" strokeWidth={1} strokeDasharray="3 3" />
        ))}

        {/* 下格零軸 */}
        <line x1={PAD_L} y1={chipMid} x2={PAD_L + innerW} y2={chipMid} stroke="var(--app-border)" strokeWidth={1} />

        {/* K 棒 */}
        {hasOhlc && data.map((d, i) => {
          if (!Number.isFinite(d.open) || !Number.isFinite(d.high) || !Number.isFinite(d.low) || !Number.isFinite(d.close)) return null;
          const xc = xAt(i);
          const prevClose = i > 0 && Number.isFinite(data[i - 1]?.close) ? data[i - 1].close : null;
          const up = d.open !== d.close ? d.close >= d.open : prevClose != null ? d.close >= prevClose : true;
          const fill = up ? '#e53935' : '#1a8a30'; const stroke = up ? '#c62828' : '#0f5c1e';
          const yH = yPrice(d.high); const yL = yPrice(d.low);
          const yO = yPrice(d.open); const yC = yPrice(d.close);
          return (
            <g key={`k-${d.dateKey}`} opacity={0.65}>
              <line x1={xc} y1={yH} x2={xc} y2={yL} stroke={stroke} strokeWidth={0.9} />
              <rect x={xc - barW / 2} y={Math.min(yO, yC)} width={barW} height={Math.max(Math.abs(yC - yO), 1)} fill={fill} stroke={stroke} strokeWidth={0.8} />
            </g>
          );
        })}

        {/* 外資持股折線（藍色，右軸） */}
        {holdingSegs.map((pts, i) => (
          <polyline key={`h-${i}`} points={pts} fill="none" stroke="#1565c0" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* 投信累積持股折線（綠色實線，獨立 Y 軸） */}
        {hasTrustCum && trustCumSegs.map((pts, i) => (
          <polyline key={`tc-${i}`} points={pts} fill="none" stroke="#16a34a" strokeWidth={1.55} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
        ))}


        {/* B 訊號：亮粉紅圓點 */}
        {data.map((d, i) => {
          if (d.bSignal !== 'B') return null;
          const xc = xAt(i);
          const yTop = Number.isFinite(d.high) ? yPrice(d.high) - 5 : PAD_T + 6;
          return <circle key={`b-${d.dateKey}`} cx={xc} cy={yTop} r={3.2} fill="#ff2d87" stroke="#fff" strokeWidth={0.8} />;
        })}

        {/* 三大法人堆疊柱：正值往上、負值往下 */}
        {data.map((d, i) => {
          const xc = xAt(i);
          const bw = Math.max(1.5, barW * 0.85);
          const vals   = [d.foreign, d.trust, d.dealer];
          const colors = ['#1565c0', '#16a34a', '#f97316'];
          const rects = []; let posOff = 0; let negOff = 0;
          vals.forEach((v, j) => {
            if (!Number.isFinite(v) || v === 0) return;
            const bh = Math.max(1, chipBarH(v));
            if (v > 0) {
              rects.push(<rect key={`c-${d.dateKey}-${j}`} x={xc - bw / 2} y={chipMid - posOff - bh} width={bw} height={bh} fill={colors[j]} opacity={0.82} />);
              posOff += bh;
            } else {
              rects.push(<rect key={`c-${d.dateKey}-${j}`} x={xc - bw / 2} y={chipMid + negOff} width={bw} height={bh} fill={colors[j]} opacity={0.5} />);
              negOff += bh;
            }
          });
          return rects;
        })}


        {/* Hover 十字線 */}
        {hoverIdx != null && (
          <line x1={xAt(hoverIdx)} y1={PAD_T} x2={xAt(hoverIdx)} y2={PAD_T + innerH} stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 3" />
        )}

        {/* 左軸 K 線價格 */}
        {hasOhlc && [pMin + (pMax - pMin) * 0.1, pMin + (pMax - pMin) * 0.9].map((v, i) => (
          <text key={`pl-${i}`} x={PAD_L - 3} y={yPrice(v) + 4} textAnchor="end" fontSize={9} fill="var(--app-text-soft)" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {v >= 100 ? Math.round(v) : v.toFixed(1)}
          </text>
        ))}

        {/* 右軸 外資持股 */}
        {holdingTicks.map((v, i) => (
          <text key={`hl-${i}`} x={PAD_L + innerW + 3} y={yHolding(v) + 4} textAnchor="start" fontSize={9} fill="#1565c0" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {v >= 10000 ? `${Math.round(v / 1000)}k` : Math.round(v)}
          </text>
        ))}

        {/* X 軸日期 */}
        {xTickIdxs.map((i) => (
          <text key={`xl-${i}`} x={xAt(i)} y={PAD_T + innerH + 16} textAnchor="middle" fontSize={10} fill="var(--app-text-soft)">
            {String(data[i]?.dateKey || '').slice(5)}
          </text>
        ))}

        {/* X 軸底線 */}
        <line x1={PAD_L} y1={PAD_T + innerH} x2={PAD_L + innerW} y2={PAD_T + innerH} stroke="var(--app-border)" strokeWidth={1} />
        {/* 上下格分隔線 */}
        <line x1={PAD_L} y1={chipYBase} x2={PAD_L + innerW} y2={chipYBase} stroke="var(--app-border)" strokeWidth={1} />
      </svg>

      {/* Tooltip */}
      {hd && (
        <div style={{
          position: 'absolute', top: tooltipTop,
          left: mousePos.x > w / 2 ? Math.max(4, mousePos.x - 190) : mousePos.x + 14,
          pointerEvents: 'none', zIndex: 20, fontSize: 12, lineHeight: 1.5,
          borderRadius: 8, border: '1px solid var(--app-border)', backgroundColor: 'var(--app-surface)',
          boxShadow: '0 8px 24px rgba(15,23,42,0.18)', padding: '10px 12px', minWidth: 160,
        }}>
          <div style={{ color: 'var(--app-text-soft)', fontWeight: 700, marginBottom: 6, borderBottom: '1px solid var(--app-border)', paddingBottom: 6 }}>
            {hd.dateKey}
            {hd.bSignal === 'B' && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: '#ff2d87', background: '#fff0f7', borderRadius: 4, padding: '1px 5px' }}>B訊號</span>}
          </div>
          {Number.isFinite(hd.close) && (
            <div style={{ color: 'var(--app-text-soft)', fontWeight: 700, paddingBottom: 2 }}>
              收：{hd.close >= 100 ? Math.round(hd.close) : hd.close?.toFixed(1)}
              {hoverIdx > 0 && Number.isFinite(data[hoverIdx - 1]?.close) && (() => {
                const pct = (hd.close - data[hoverIdx - 1].close) / data[hoverIdx - 1].close * 100;
                return <span style={{ marginLeft: 4, color: pct > 0 ? '#c0392b' : '#2e7d32', fontSize: 11 }}>{pct >= 0 ? '+' : ''}{pct.toFixed(1)}%</span>;
              })()}
            </div>
          )}
          {!isInChipArea && Number.isFinite(hd.holding) && (
            <div style={{ color: '#1565c0', fontWeight: 600, paddingBottom: 2 }}>外資持股：{Number(hd.holding).toLocaleString()} 張</div>
          )}
          {isInChipArea && Number.isFinite(hd.foreign) && (
            <div style={{ color: '#1565c0', paddingBottom: 1 }}>外資買賣：{hd.foreign >= 0 ? '+' : ''}{Number(hd.foreign).toLocaleString()} 張</div>
          )}
          {isInChipArea && Number.isFinite(hd.trust) && (
            <div style={{ color: '#16a34a', paddingBottom: 1 }}>投信買賣：{hd.trust >= 0 ? '+' : ''}{Number(hd.trust).toLocaleString()} 張</div>
          )}
          {isInChipArea && Number.isFinite(hd.dealer) && (
            <div style={{ color: '#f97316', paddingBottom: 1 }}>自營商買賣：{hd.dealer >= 0 ? '+' : ''}{Number(hd.dealer).toLocaleString()} 張</div>
          )}
        </div>
      )}
    </div>
  );
}

/** 某曆日所屬「ISO 週」的週一 YYYY-MM-DD（用來把日 K 分組成週 K） */
function startOfIsoWeekYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=日 .. 6=六
  const diff = dow === 0 ? -6 : 1 - dow; // 退回該週週一
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

/**
 * 日 K → 週 K 聚合。
 * 週開盤＝該週首交易日 open，週最高＝high 之 max，週最低＝low 之 min，
 * 週收盤＝該週末交易日 close，週量＝volume 加總。dateStr 用該週最後交易日，
 * 方便與 RS / 加權指數（皆以日對齊）取值。
 */
function aggregateDailyToWeekly(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  const sorted = [...daily].filter((b) => b && b.dateStr).sort((a, b) => (a.dateStr < b.dateStr ? -1 : 1));
  const groups = new Map();
  for (const bar of sorted) {
    const wk = startOfIsoWeekYmd(bar.dateStr);
    if (!groups.has(wk)) groups.set(wk, []);
    groups.get(wk).push(bar);
  }
  const out = [];
  for (const wk of [...groups.keys()].sort()) {
    const bars = groups.get(wk);
    const first = bars[0];
    const last = bars[bars.length - 1];
    let high = -Infinity;
    let low = Infinity;
    let vol = 0;
    for (const b of bars) {
      if (Number.isFinite(b.high)) high = Math.max(high, b.high);
      if (Number.isFinite(b.low)) low = Math.min(low, b.low);
      if (Number.isFinite(b.volume)) vol += b.volume;
    }
    out.push({
      dateStr: last.dateStr,
      open: Number.isFinite(first.open) ? first.open : first.close,
      high: Number.isFinite(high) ? high : last.close,
      low: Number.isFinite(low) ? low : last.close,
      close: last.close,
      volume: vol,
    });
  }
  return out;
}

/**
 * 收盤價滾動均線序列（與圖表內舊邏輯一致：遇缺口 reset，未滿 period 給 null）。
 * 在「含暖身段」的完整序列上計算，之後再裁掉暖身段，MA 才能從第一根顯示 K 棒就有值。
 */
function computeMaSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  const q = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const c = Number.isFinite(bars[i]?.close) ? bars[i].close : null;
    if (c == null) { q.length = 0; sum = 0; continue; }
    q.push(c);
    sum += c;
    if (q.length > period) sum -= q.shift();
    if (q.length === period) out[i] = sum / period;
  }
  return out;
}

/** 個股 RS Rating（1-99 歷史）× 加權指數原始點數 疊圖 modal（觀察列表頁亦共用） */
export function RsChartModal({ stock, onClose, navigationList, onNavigate, inWatchlist, onToggleWatchlist, watchlistPriority, onSetPriority, signalNote, initialView }) {
  const [watchlistBusy, setWatchlistBusy] = useState(false);
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [indexMap, setIndexMap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  /** Yahoo 日 K 最近一筆：交易日 + 收盤價 */
  const [closeQuote, setCloseQuote] = useState(null);
  /** VCP：價格項／成交量項／加權合成；error 表示 Yahoo 失敗 */
  const [vcpSnapshot, setVcpSnapshot] = useState(null);
  /** Yahoo 日 K OHLC，與 VCP 同一請求 */
  const [ohlcSeries, setOhlcSeries] = useState([]);
  /** 視窗切換：'rs' = 預設，'foreign' = 外資籌碼視窗（A 鍵切換） */
  const [activeView, setActiveView] = useState(initialView ?? 'rs');
  /** RS K 線是否顯示均線（MA10/MA20）；按鈕或 Shift 鍵切換，預設不顯示 */
  const [showMA, setShowMA] = useState(false);
  /** K 線週期：'D'=日線（預設，用既有 120 天資料）、'W'=週線（按鍵盤 W 切換，臨時抓 ~2 年聚合） */
  const [chartTf, setChartTf] = useState('D');
  /** 週線聚合資料：null=尚未抓、[]=抓取失敗/無資料、[...]=已聚合的週 K */
  const [weeklyOhlc, setWeeklyOhlc] = useState(null);
  /** 三大法人每日買賣超：{ [dateStr]: { foreign, trust, dealer } }，懶載入 */
  const [institutionalData, setInstitutionalData] = useState(null);
  const [institutionalLoading, setInstitutionalLoading] = useState(false);
  /** 外資持股序列（RS 排行頁 stock 物件不含此資料，切換視窗二時懶載入） */
  const [fetchedHoldings, setFetchedHoldings] = useState(null); // { holdings, latestDate } | false(failed)
  /** 追蹤上一個 stock.id：用來判斷是「modal 新開」還是「左右導航」 */
  const prevStockIdRef = useRef(null);

  // 籌碼訊號標籤的暗色適配 CSS：modal 共用於多頁，於此自行注入一次
  useEffect(() => {
    if (document.getElementById(SIGNAL_NOTE_STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = SIGNAL_NOTE_STYLE_ID;
    el.textContent = SIGNAL_NOTE_CSS;
    document.head.appendChild(el);
  }, []);

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
    if (!stock) {
      prevStockIdRef.current = null; // modal 關閉，重置追蹤
      return;
    }
    // 判斷是「左右導航切換個股」還是「modal 從關閉→新開」
    const isNavigation = prevStockIdRef.current !== null;
    prevStockIdRef.current = stock.id;

    setLoading(true);
    setError(null);
    setIndexMap(null);
    setCloseQuote(null);
    setVcpSnapshot(null);
    setOhlcSeries([]);
    // 初次開啟用 initialView；導航切換個股時保留當前視圖
    if (!isNavigation) setActiveView(initialView ?? 'rs');
    setInstitutionalData(null);
    setFetchedHoldings(null);

    const endStr = new Date().toISOString().slice(0, 10);
    // startStr：取 RS history 最早日期 與 K 棒起始日（quoteStart）兩者較早者，
    // 確保大盤資料能覆蓋整段 K 棒顯示範圍（例如 7822 RS history 較短時不會只顯示局部大盤線）
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 6);
    const fallbackStart = startDate.toISOString().slice(0, 10);

    let cancelled = false;
    const quoteEnd = getTaiwanYmd();
    const quoteStartBuf = new Date();
    quoteStartBuf.setDate(quoteStartBuf.getDate() - 120);
    const quoteStart = quoteStartBuf.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    // K 線/MA 用：顯示視窗 165 曆日，再往前多抓 ~45 曆日（≈30 交易日）暖身段 → 共 210 曆日，
    // 讓 MA20 從第一根顯示 K 棒就有值；暖身段只用於算 MA，chartData 會把它裁掉不畫
    const quoteBufStartD = new Date();
    quoteBufStartD.setDate(quoteBufStartD.getDate() - 210);
    const quoteBufStart = quoteBufStartD.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

    // 優先用 Firestore 已存的 highMap/lowMap，避免 Yahoo proxy 快取問題
    const storedPM = stock.priceMap && typeof stock.priceMap === 'object' ? stock.priceMap : null;
    const storedOM = stock.openMap && typeof stock.openMap === 'object' ? stock.openMap : null;
    const storedHM = stock.highMap && typeof stock.highMap === 'object' ? stock.highMap : null;
    const storedLM = stock.lowMap && typeof stock.lowMap === 'object' ? stock.lowMap : null;
    const storedVM = stock.volumeMap && typeof stock.volumeMap === 'object' ? stock.volumeMap : null;
    // 預期最新交易日：14:00 後看今天，14:00 前看前一交易日（與 rsApi getTaiwanYmd 邏輯一致）
    const _storedExpectedDay = (() => {
      const _h = parseInt(new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }), 10);
      const _today = quoteEnd; // quoteEnd = getTaiwanYmd() = 今日台北曆日
      if (Number.isFinite(_h) && _h >= 14) return normalizeYmdToTaiwanTradingDay(_today) ?? _today;
      const [_y, _m, _d] = _today.split('-').map(Number);
      const _yest = new Date(Date.UTC(_y, _m - 1, _d) - 86400000).toISOString().slice(0, 10);
      return normalizeYmdToTaiwanTradingDay(_yest) ?? _yest;
    })();
    const _storedPMLatest = storedPM
      ? (Object.keys(storedPM).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1) ?? '')
      : '';
    // Firestore 資料過期（未覆蓋預期最新交易日）→ 退回 Yahoo 即時抓，避免忘記按同步時 K 線卡舊資料
    const hasStoredMaps = storedPM && storedHM && storedLM
      && Object.keys(storedHM).length >= 20
      && _storedPMLatest >= _storedExpectedDay;

    if (hasStoredMaps) {
      const dates = Object.keys(storedPM).filter((d) => d >= quoteBufStart && d <= quoteEnd).sort();
      setOhlcSeries(dates.map((d) => {
        const close = storedPM[d];
        return {
          dateStr: d,
          open: storedOM?.[d] ?? close,
          high: storedHM[d] ?? close,
          low: storedLM[d] ?? close,
          close,
          volume: storedVM?.[d] ?? 0,
        };
      }));
      const allDates = Object.keys(storedPM).filter((d) => d <= quoteEnd).sort();
      const lastD = allDates[allDates.length - 1];
      setCloseQuote(lastD && Number.isFinite(storedPM[lastD]) ? { dateStr: lastD, price: storedPM[lastD] } : null);
      const pr = calcVcpPriceRatioFromHighLowMaps(storedHM, storedLM, quoteEnd);
      const vr = calcVcpVolumeRatioFromVolumeMap(storedVM || {}, quoteEnd);
      setVcpSnapshot({ composite: calcCompositeVcp(pr, vr), priceRatio: pr, volRatio: vr });
    } else {
      void (getYahooKlineFromCache(stock.id, quoteBufStart, quoteEnd) ?? fetchYahooHistoricalPriceVolumeMaps(stock.id, quoteBufStart, quoteEnd, { market: stock.market }))
        .then(({ priceMap, highMap, lowMap, volumeMap, ohlcSeries: ohlc }) => {
          if (cancelled) return;
          setOhlcSeries(Array.isArray(ohlc) ? ohlc : []);
          if (priceMap && typeof priceMap === 'object') {
            const dates = Object.keys(priceMap).sort();
            const lastD = dates[dates.length - 1];
            const p = lastD != null ? priceMap[lastD] : null;
            if (lastD && p != null && Number.isFinite(p)) {
              setCloseQuote({ dateStr: lastD, price: p });
            } else {
              setCloseQuote(null);
            }
            const pr = calcVcpPriceRatioFromHighLowMaps(highMap || {}, lowMap || {}, quoteEnd);
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
            setOhlcSeries([]);
          }
        });
    }

    // 大盤起始日：取各來源最早者；並至少回溯 ~930 天，讓週線圖的加權線能覆蓋整個週 K 範圍（顯示 ~770 天）。
    // 加權只是單一 ^TWII 序列且有快取，日線模式多抓的舊段不影響顯示與 Y 軸刻度（刻度只用可見點算）。
    const indexFloorD = new Date();
    indexFloorD.setDate(indexFloorD.getDate() - 930);
    const indexFloor = indexFloorD.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const startStr = [earliestHistoryDate, quoteStart, fallbackStart, indexFloor].filter(Boolean).sort()[0];

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
  }, [stock?.id, earliestHistoryDate, stock?.ibdRsPriceFetchedDate]);

  // 切換到外資視窗時懶載入：三大法人資料 + 外資持股序列（若 stock 物件未帶）
  useEffect(() => {
    if (activeView !== 'foreign' || !stock?.id) return;

    const hasHoldings  = Array.isArray(stock?.history?.foreignTotalHolding) && stock.history.foreignTotalHolding.length > 100;
    const hasInstInObj = stock?.history?.instDates?.length > 0;
    const needHoldings = !hasHoldings && fetchedHoldings === null;
    const needInst     = institutionalData === null && !institutionalLoading;

    if (!needHoldings && !needInst) return; // 兩者都已就緒

    // 三大法人：stock 物件已帶資料直接用
    if (!needHoldings && needInst) {
      if (hasInstInObj) {
        const h = stock.history;
        setInstitutionalData(instArraysToDateMap(h.instDates, h.instForeign, h.instTrust, h.instDealer));
        return;
      }
    }

    // 統一一次讀 Firestore stockWatchlist，同時取外資持股 + 三大法人
    if (needHoldings || (needInst && !hasInstInObj)) {
      if (needHoldings) setFetchedHoldings(undefined); // loading
      if (needInst)     setInstitutionalLoading(true);

      (async () => {
        let fsHoldingsDone = false;
        let fsInstDone     = false;
        let staleInstBase  = null; // Firestore 有舊資料但過期時暫存，供增量合併
        try {
          const snap = await getDoc(doc(db, 'stockWatchlist', stock.id));
          if (snap.exists()) {
            const d = snap.data();

            // 外資持股
            if (needHoldings) {
              const h  = d.history?.foreignTotalHolding;
              const hd = d.history?.foreignHoldingDates ?? null;
              const ld = d.latestHoldingsDate ?? null;
              // 新鮮度基準 = 外資持股應公告交易日(21:00)，封頂在股價最新交易日（與三大法人一致，
              // 避免端午等假日誤判而每次空打 API）。不夠新 → fsHoldingsDone 維持 false →
              // 走下面 fetchForeignHoldingSeries 補抓最新交易日 + 存回 Firestore。
              const holdingsBound = holdingsFreshnessBound(d.latestPriceDate || stock?.latestPriceDate);
              if (Array.isArray(h) && h.length > 100 && ld && ld >= holdingsBound) {
                setFetchedHoldings({ holdings: h, holdingDates: hd, latestDate: ld });
                fsHoldingsDone = true;
              }
            }

            // 三大法人
            if (needInst) {
              const h = d.history;
              const instLd = d.latestInstDate ?? null;
              // 新鮮度基準 = 應公告交易日，封頂在股價最新交易日（避免端午等假日誤判而每次空打 FinMind）
              const instBound = instFreshnessBound(stock?.market, d.latestPriceDate || stock?.latestPriceDate);
              if (h?.instDates?.length > 0 && instLd && instLd >= instBound) {
                // 快取最新日 >= 最近實際交易日即為新鮮（週末/盤前/假日不補抓），直接用
                setInstitutionalData(instArraysToDateMap(h.instDates, h.instForeign, h.instTrust, h.instDealer));
                setInstitutionalLoading(false);
                fsInstDone = true;
              } else if (h?.instDates?.length > 0 && instLd) {
                // 有舊資料但過期：記下來，之後只補缺少的天數
                staleInstBase = {
                  map: instArraysToDateMap(h.instDates, h.instForeign, h.instTrust, h.instDealer),
                  latestInstDate: instLd,
                };
              }
            }
          }
        } catch (_) { /* ignore */ }

        // Firestore 查無 → fallback 到 FinMind，抓完後寫回 Firestore
        const stockCode = stock.code || stock.id;
        const docRef = doc(db, 'stockWatchlist', stockCode);

        /** 局部寫入 Firestore（updateDoc 支援 dot-notation，不覆蓋其他 history 欄位） */
        const saveToFirestore = async (fields) => {
          try {
            await updateDoc(docRef, fields);
          } catch (e) {
            if (e?.code === 'not-found') {
              // doc 尚不存在 → 直接建立
              const topLevel = {};
              const histFields = {};
              for (const [k, v] of Object.entries(fields)) {
                if (k.startsWith('history.')) histFields[k.slice(8)] = v;
                else topLevel[k] = v;
              }
              await setDoc(docRef, { code: stockCode, history: histFields, ...topLevel }, { merge: true });
            }
          }
        };

        if (needHoldings && !fsHoldingsDone) {
          try {
            const result = await fetchForeignHoldingSeries(stockCode);
            if (result && Array.isArray(result.holdings) && result.holdings.length > 100) {
              setFetchedHoldings(result);
              // 非同步存回 Firestore（不阻擋 UI）
              const saveFields = {
                'history.foreignTotalHolding': result.holdings,
                latestHoldingsDate: result.latestDate,
              };
              if (Array.isArray(result.holdingDates) && result.holdingDates.length > 0) {
                saveFields['history.foreignHoldingDates'] = result.holdingDates;
              }
              saveToFirestore(saveFields).catch(() => {});
            } else {
              setFetchedHoldings(false);
            }
          } catch (_) {
            setFetchedHoldings(false);
          }
        }
        if (needInst && !fsInstDone) {
          try {
            // 增量：有舊資料就從最新日+1天開始，否則抓 18 個月（histWindow=250 需 274 筆）
            const baseDate = staleInstBase?.latestInstDate;
            const startDate = baseDate
              ? (() => { const dt = new Date(baseDate); dt.setDate(dt.getDate() + 1); return dt.toISOString().slice(0, 10); })()
              : (() => { const d = new Date(); d.setMonth(d.getMonth() - 18); return d.toISOString().slice(0, 10); })();
            const newResult = await fetchInstitutionalInvestorsSeries(stockCode, startDate);
            // 合併舊資料 + 新增資料
            const mergedRaw = staleInstBase
              ? { ...staleInstBase.map, ...(newResult || {}) }
              : (newResult || {});
            // 防呆：濾掉超過股價最新交易日的幽靈法人資料
            // （端午等非交易日，TWSE 逾時會 fall through 到 FinMind，FinMind 對上市股會多塞一筆幽靈）
            const _instBound = stock?.latestPriceDate || stock?.ibdRsPriceFetchedDate || null;
            const merged = _instBound
              ? Object.fromEntries(Object.entries(mergedRaw).filter(([d]) => d <= _instBound))
              : mergedRaw;
            setInstitutionalData(merged);
            // 存回 Firestore
            if (Object.keys(merged).length > 0) {
              const dates = Object.keys(merged).sort().reverse();
              saveToFirestore({
                'history.instDates':   dates,
                'history.instForeign': dates.map(d => merged[d].foreign),
                'history.instTrust':   dates.map(d => merged[d].trust),
                'history.instDealer':  dates.map(d => merged[d].dealer),
                latestInstDate: dates[0] ?? null,
              }).catch(() => {});
            }
          } catch (_) {
            // API 失敗時仍顯示舊資料
            setInstitutionalData(staleInstBase?.map || {});
          } finally {
            setInstitutionalLoading(false);
          }
        }
      })();
    }
  }, [activeView, stock?.id, institutionalData, institutionalLoading, fetchedHoldings, stock?.history?.foreignTotalHolding, stock?.history?.instDates]);

  // 有效持股資料：優先用 stock 物件，否則用懶載入結果
  const effectiveHoldings = useMemo(() => {
    if (Array.isArray(stock?.history?.foreignTotalHolding) && stock.history.foreignTotalHolding.length > 100)
      return {
        holdings: stock.history.foreignTotalHolding,
        holdingDates: Array.isArray(stock.history.foreignHoldingDates) ? stock.history.foreignHoldingDates : null,
        latestDate: stock.latestHoldingsDate,
      };
    if (fetchedHoldings && fetchedHoldings.holdings?.length > 100)
      return fetchedHoldings; // fetchForeignHoldingSeries 已帶 holdingDates
    return null;
  }, [stock?.history?.foreignTotalHolding, stock?.history?.foreignHoldingDates, stock?.latestHoldingsDate, fetchedHoldings]);

  // 外資視窗：歷史 B 訊號（最近 130 個交易日）
  const foreignBSignals = useMemo(() => {
    if (activeView !== 'foreign') return [];
    return computeHistoricalForeignBSignals(effectiveHoldings?.holdings);
  }, [activeView, effectiveHoldings]);

  // 外資視窗圖表資料：K 線 + 外資持股 + 三大法人
  const foreignChartData = useMemo(() => {
    if (activeView !== 'foreign' || !ohlcSeries.length) return [];
    const holdings    = effectiveHoldings?.holdings;
    const holdingDates = effectiveHoldings?.holdingDates;   // newest-first，與 holdings 等長
    const latestHoldingsDate = effectiveHoldings?.latestDate;

    // 與 RS K 線一致：顯示近 165 曆日（含原暖身段）。前段沒有更早資料暖身，
    // 故最前面約 20 根的 MA20、約 10 根的 MA10 會是空值。
    const dispStartD = new Date();
    dispStartD.setDate(dispStartD.getDate() - 165);
    const displayStart = dispStartD.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

    // 建立 OHLC 日期序列（由舊到新），並裁到顯示視窗起點
    const sortedOhlc = [...ohlcSeries]
      .filter((o) => o.dateStr >= displayStart)
      .sort((a, b) => a.dateStr < b.dateStr ? -1 : 1);

    // ── 新路徑：有日期陣列 → 用 date-based lookup（forward-fill），不用 index 偏移 ──
    const hasDates = Array.isArray(holdingDates)
      && holdingDates.length > 0
      && holdingDates.length === (holdings?.length ?? 0);

    if (hasDates) {
      // holdingDates 是 newest-first → 建立 {date, val, bSig} 並按日期由舊到新排序
      const sortedPairs = holdingDates
        .map((d, i) => ({
          date: d,
          val:  holdings[i],
          bSig: (foreignBSignals && i < foreignBSignals.length) ? foreignBSignals[i] : 'N',
        }))
        .filter(p => p.date)
        .sort((a, b) => (a.date < b.date ? -1 : 1)); // oldest-first

      // 持股資料實際涵蓋的最後日期；晚於此的 K 線日（今日資料尚未發布）一律留空，不 forward-fill
      const lastHoldingDate = sortedPairs.length ? sortedPairs[sortedPairs.length - 1].date : null;

      return sortedOhlc.map((o) => {
        // Binary search：最後一個 holdingDate <= o.dateStr（forward-fill）
        let lo = 0, hi = sortedPairs.length - 1, found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (sortedPairs[mid].date <= o.dateStr) { found = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        // 僅在資料涵蓋範圍內 forward-fill；K 線日晚於最後一筆持股 → null（避免誤導為昨日值）
        const holdingVal = (found >= 0 && lastHoldingDate && o.dateStr <= lastHoldingDate) ? sortedPairs[found].val : null;
        // B 訊號只在持股資料的實際日期顯示，其餘日填 'N'
        const bSignal = (found >= 0 && sortedPairs[found].date === o.dateStr)
          ? sortedPairs[found].bSig
          : 'N';

        const inst = institutionalData?.[o.dateStr] ?? null;
        return {
          dateKey: o.dateStr,
          open: o.open, high: o.high, low: o.low, close: o.close,
          holding: Number.isFinite(holdingVal) ? holdingVal : null,
          bSignal,
          foreign: inst ? inst.foreign : null,
          trust:   inst ? inst.trust   : null,
          dealer:  inst ? inst.dealer  : null,
        };
      });
    }

    // ── 舊路徑 fallback：無 holdingDates（舊版 Firestore 資料），退回 index 偏移 ──
    const n = sortedOhlc.length;
    let anchorIdx = n - 1;
    if (latestHoldingsDate) {
      for (let i = n - 1; i >= 0; i--) {
        if (sortedOhlc[i].dateStr <= latestHoldingsDate) { anchorIdx = i; break; }
      }
    }
    return sortedOhlc.map((o, i) => {
      const hIdx = anchorIdx - i;
      // hIdx < 0 → 此 K 線日期在最後一筆持股之後（今日資料尚未發布）→ 留空，不補昨日值（避免誤導）
      const holding = holdings && hIdx >= 0 && hIdx < holdings.length ? holdings[hIdx] : null;
      const bSignal = (foreignBSignals && hIdx >= 0 && hIdx < foreignBSignals.length) ? foreignBSignals[hIdx] : 'N';
      const inst = institutionalData?.[o.dateStr] ?? null;
      return {
        dateKey: o.dateStr,
        open: o.open, high: o.high, low: o.low, close: o.close,
        holding: Number.isFinite(holding) ? holding : null,
        bSignal,
        foreign: inst ? inst.foreign : null,
        trust:   inst ? inst.trust   : null,
        dealer:  inst ? inst.dealer  : null,
      };
    });
  }, [activeView, ohlcSeries, effectiveHoldings, foreignBSignals, institutionalData]);

  /** 有日 K 時以 Yahoo 交易日為 X（與疊加 K 線逐根對齊）；否則退回 RS 歷史日序 */
  const chartData = useMemo(() => {
    if (!indexMap) return [];
    const indexDates = Object.keys(indexMap).sort();
    const rsMap = new Map(history.map((h) => [h.d, h.r]));

    // 週線模式：用週 K。換股後週 K 尚未抓到（weeklyOhlc === null）時不要退回日 K，
    // 否則切股票會先閃一下日線再跳週線；回傳 [] 維持空圖直到週 K 到位。
    let baseOhlc;
    if (chartTf === 'W') {
      if (weeklyOhlc === null) return [];
      baseOhlc = Array.isArray(weeklyOhlc) ? weeklyOhlc : [];
    } else {
      baseOhlc = ohlcSeries;
    }

    if (baseOhlc.length > 0) {
      // 在完整序列上算 MA（前段無更早資料暖身時，最前面數根 MA 為空值）
      const ma10Arr = computeMaSeries(baseOhlc, 10);
      const ma20Arr = computeMaSeries(baseOhlc, 20);
      // 顯示視窗起點：日線近 165 曆日（~110 交易日）、週線近 770 曆日（~110 週，與日線 K 棒數相當）
      const dispDays = chartTf === 'W' ? 770 : 165;
      const dispStartD = new Date();
      dispStartD.setDate(dispStartD.getDate() - dispDays);
      const displayStart = dispStartD.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

      const points = [];
      for (let i = 0; i < baseOhlc.length; i++) {
        const o = baseOhlc[i];
        if (o.dateStr < displayStart) continue; // 暖身段：只用於算 MA，不畫
        const ymd = o.dateStr;
        const r = rsMap.get(ymd);
        let closestIdx = null;
        for (const id of indexDates) {
          if (id <= ymd) closestIdx = indexMap[id];
          else break;
        }
        points.push({
          dateKey: ymd,
          date: ymd.slice(5),
          rs: r != null && Number.isFinite(r) ? r : null,
          idx: closestIdx != null && Number.isFinite(closestIdx) ? Math.round(closestIdx) : null,
          open: Number.isFinite(o.open) ? o.open : null,
          high: Number.isFinite(o.high) ? o.high : null,
          low: Number.isFinite(o.low) ? o.low : null,
          close: Number.isFinite(o.close) ? o.close : null,
          volume: Number.isFinite(o.volume) && o.volume > 0 ? o.volume : null,
          ma10: Number.isFinite(ma10Arr[i]) ? ma10Arr[i] : null,
          ma20: Number.isFinite(ma20Arr[i]) ? ma20Arr[i] : null,
        });
      }
      return points;
    }

    if (history.length === 0) return [];
    return history.map(({ d, r }) => {
      let closestIdx = null;
      for (const id of indexDates) {
        if (id <= d) closestIdx = indexMap[id];
        else break;
      }
      return {
        dateKey: d,
        date: d.slice(5),
        rs: r,
        idx: closestIdx != null ? Math.round(closestIdx) : null,
      };
    });
  }, [ohlcSeries, history, indexMap, chartTf, weeklyOhlc]);

  const noHistory = history.length === 0;
  const indexEmpty = indexMap != null && Object.keys(indexMap).length === 0;
  // 週線模式但該檔週 K 還沒抓回來（換股時會短暫如此）→ 顯示載入態，而非閃日線或「無資料」
  const weeklyPending = activeView === 'rs' && chartTf === 'W' && weeklyOhlc === null;
  const isEmpty = !loading && !error && !weeklyPending && chartData.length === 0;
  const marketBadge = formatIbdMarketLabel(stock?.market);
  const tradingViewUrl = stock ? getTradingViewChartUrl(stock) : null;
  const moneyDjSearchUrl = stock ? getMoneyDjSearchUrl(stock) : null;

  const swipeTouchRef = useRef({ x0: null, y0: null, id: null, t0: null });

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

  // Shift 鍵切換 RS K 線均線顯示（僅 RS 視圖、開窗時；忽略長按重複與輸入框）
  useEffect(() => {
    if (!stock || activeView !== 'rs') return;
    const handleKey = (e) => {
      if (e.key !== 'Shift' || e.repeat) return;
      if (isDomTypingTarget(e.target)) return;
      setShowMA((v) => !v);
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [stock, stock?.id, activeView]);

  // W 鍵切換日線↔週線（僅 RS 視圖、開窗時；忽略長按重複與輸入框）
  // 用 e.code 判實體鍵位，避免中文等輸入法把 'w' 吃成組字而比對不到 e.key。
  useEffect(() => {
    if (!stock || activeView !== 'rs') return;
    const handleKey = (e) => {
      if (e.code !== 'KeyW' || e.repeat) return;
      if (isDomTypingTarget(e.target)) return;
      setChartTf((v) => (v === 'D' ? 'W' : 'D'));
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [stock, stock?.id, activeView]);

  // 換股時清掉週線快取，下次切到 W 會重抓該檔
  useEffect(() => {
    setWeeklyOhlc(null);
  }, [stock?.id]);

  // 切到週線且尚未抓過 → 臨時抓 ~2 年日 K（Yahoo range 自動選 2y）聚合成週 K
  useEffect(() => {
    if (!stock || chartTf !== 'W' || weeklyOhlc !== null) return;
    let cancelled = false;
    const end = getTaiwanYmd();
    const buf = new Date();
    buf.setDate(buf.getDate() - 930); // ~133 週：顯示 ~110 週 + 約 23 週 MA 暖身段（Yahoo range → 5y）
    const start = buf.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    fetchYahooHistoricalPriceVolumeMaps(stock.id, start, end, { market: stock.market })
      .then(({ ohlcSeries: ohlc }) => {
        if (cancelled) return;
        setWeeklyOhlc(aggregateDailyToWeekly(Array.isArray(ohlc) ? ohlc : []));
      })
      .catch(() => {
        if (!cancelled) setWeeklyOhlc([]);
      });
    return () => { cancelled = true; };
  }, [stock, stock?.id, chartTf, weeklyOhlc]);

  // 預取前後各一檔的 K 線，避免切換時等待
  useEffect(() => {
    if (!stock || !Array.isArray(navigationList) || navigationList.length < 2) return;
    const idx = navigationList.findIndex((s) => s.id === stock.id);
    if (idx < 0) return;
    const quoteEnd = getTaiwanYmd();
    const buf = new Date();
    buf.setDate(buf.getDate() - 210); // 與開窗抓取一致（165 顯示 + 45 MA 暖身段），讓預取命中快取
    const quoteStart = buf.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const neighbours = [
      idx > 0 ? navigationList[idx - 1] : null,
      idx < navigationList.length - 1 ? navigationList[idx + 1] : null,
    ].filter(Boolean);
    for (const s of neighbours) {
      const storedPM = s.priceMap && typeof s.priceMap === 'object' ? s.priceMap : null;
      const storedHM = s.highMap && typeof s.highMap === 'object' ? s.highMap : null;
      const storedLM = s.lowMap && typeof s.lowMap === 'object' ? s.lowMap : null;
      if (storedPM && storedHM && storedLM && Object.keys(storedHM).length >= 20) continue;
      prefetchYahooKlineIfAbsent(s.id, quoteStart, quoteEnd, { market: s.market });
    }
  }, [stock?.id, navigationList]);

  useEffect(() => {
    if (!stock) return;
    const handleKey = (e) => {
      if (isDomTypingTarget(e.target)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveView((v) => v === 'rs' ? 'foreign' : 'rs');
      } else if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
        if (priorityBusy || watchlistBusy) return;
        if (typeof onToggleWatchlist !== 'function' && typeof onSetPriority !== 'function') return;
        e.preventDefault();
        const p = Number(e.code.replace('Digit', ''));
        if (inWatchlist && watchlistPriority === p) {
          // 同一個數字再按 → 移出觀察清單
          setWatchlistBusy(true);
          onToggleWatchlist(stock).catch((err) => console.error('[觀察列表]', err)).finally(() => setWatchlistBusy(false));
        } else if (inWatchlist) {
          // 已在清單，只改分類
          setPriorityBusy(true);
          onSetPriority(stock, p).catch((err) => console.error('[優先順序]', err)).finally(() => setPriorityBusy(false));
        } else {
          // 不在清單 → 加入並設分類
          setWatchlistBusy(true);
          onToggleWatchlist(stock)
            .then(() => onSetPriority(stock, p))
            .catch((err) => console.error('[觀察列表]', err))
            .finally(() => setWatchlistBusy(false));
        }
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [stock, onClose, onToggleWatchlist, watchlistBusy, inWatchlist, onSetPriority, watchlistPriority, priorityBusy]);

  /** 手機橫滑切換個股：須「快滑」；慢慢拖著看 RS tooltip 不觸發（與 ←／→ 方向相同） */
  const handleSwipeTouchStart = useCallback(
    (e) => {
      if (!onNavigate || !Array.isArray(navigationList) || navigationList.length < 2) return;
      const t = e.changedTouches[0];
      if (!t) return;
      swipeTouchRef.current = {
        x0: t.clientX,
        y0: t.clientY,
        id: t.identifier,
        t0: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      };
    },
    [navigationList, onNavigate],
  );

  const handleSwipeTouchEnd = useCallback(
    (e) => {
      const start = swipeTouchRef.current;
      if (start.x0 == null || start.id == null || start.t0 == null) return;
      const t =
        Array.from(e.changedTouches).find((x) => x.identifier === start.id) ?? e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - start.x0;
      const dy = t.clientY - start.y0;
      swipeTouchRef.current = { x0: null, y0: null, id: null, t0: null };

      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const elapsed = now - start.t0;
      /** 超過此時間（手指按下→放開）→ 當成慢慢拖著看 RS／tooltip，不切換 */
      const swipeMaxElapsedMs = 400;
      /** 水平「平均速度」下限（px/ms），避免在時間上限內慢慢磨過門檻距離 */
      const swipeMinPxPerMs = 0.22;
      if (elapsed > swipeMaxElapsedMs) return;
      if (elapsed < 1) return;

      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const minPx = 56;
      const ratio = 1.28;
      if (absDx / elapsed < swipeMinPxPerMs) return;
      if (absDx < minPx || absDx < absDy * ratio) return;
      if (!stock || !onNavigate || !Array.isArray(navigationList) || navigationList.length < 2) return;
      const idx = navigationList.findIndex((s) => s.id === stock.id);
      if (idx < 0) return;
      if (dx < 0 && idx < navigationList.length - 1) {
        onNavigate(navigationList[idx + 1]);
      } else if (dx > 0 && idx > 0) {
        onNavigate(navigationList[idx - 1]);
      }
    },
    [stock, navigationList, onNavigate],
  );

  const handleSwipeTouchCancel = useCallback(() => {
    swipeTouchRef.current = { x0: null, y0: null, id: null, t0: null };
  }, []);

  return (
    <div
      className="ibd-rs-chart-modal-backdrop"
      onMouseDown={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 12000,
        background: 'rgba(0,0,0,0.42)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 'max(12px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom))',
        overflowY: 'auto',
      }}
    >
      <div
        className="ibd-rs-chart-modal-panel"
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={handleSwipeTouchStart}
        onTouchEnd={handleSwipeTouchEnd}
        onTouchCancel={handleSwipeTouchCancel}
        style={{
          boxSizing: 'border-box',
          width: '100%',
          maxWidth: 800,
          height: 'min(90vh, 860px)',
          maxHeight: 'min(90vh, 860px)',
          overflow: 'hidden',
          background: 'var(--app-surface)',
          borderRadius: 12,
          boxShadow: '0 20px 56px rgba(0,0,0,0.28)',
          padding: '12px 14px 8px',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          minHeight: 0,
          touchAction: 'pan-y',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            marginBottom: 8,
            minHeight: 36,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexFlow: 'row wrap',
              alignItems: 'baseline',
              columnGap: 8,
              rowGap: 4,
              minWidth: 0,
              flex: '1 1 auto',
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.2 }}>{stock.id}</span>
            {moneyDjSearchUrl ? (
              <a
                href={moneyDjSearchUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={`搜尋 MoneyDJ：${stock.id} ${stock.name ?? ''}`.trim()}
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontWeight: 500,
                  fontSize: 14,
                  lineHeight: 1.2,
                  color: 'inherit',
                  textDecoration: 'none',
                }}
              >
                {stock.name}
              </a>
            ) : (
              <span style={{ fontWeight: 500, fontSize: 14, lineHeight: 1.2 }}>{stock.name}</span>
            )}
            <span
              title={
                stock.market === 'TWSE'
                  ? '臺灣證券交易所'
                  : stock.market === 'TPEX'
                    ? '櫃買中心（上櫃）'
                    : undefined
              }
              style={{
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1.2,
                color: marketBadge.color,
                padding: '2px 7px',
                borderRadius: 6,
                background: marketBadge.bg,
              }}
            >
              {marketBadge.text}
            </span>
            {closeQuote != null ? (
              <span
                title="Yahoo Finance 日 K 最近一筆；非交易日則為前一交易日收盤"
                style={{ fontSize: 13, color: '#1565c0', fontWeight: 700, lineHeight: 1.2 }}
              >
                {formatYmdSlash(closeQuote.dateStr)} 收盤 {closeQuote.price.toFixed(1)}
              </span>
            ) : (
              <span
                aria-hidden
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  visibility: 'hidden',
                  whiteSpace: 'nowrap',
                }}
              >
                0000/00/00 收盤 000.00
              </span>
            )}
            {/* VCP：與收盤價同一基線；載入中占位避免版面跳動 */}
            <span
style={{
                fontSize: 12,
                fontWeight: 500,
                lineHeight: 1.2,
                color: '#6b7280',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 'min(100%, 52vw)',
                flexShrink: 1,
                ...(vcpSnapshot ? {} : { visibility: 'hidden' }),
              }}
              aria-hidden={!vcpSnapshot}
            >
              {!vcpSnapshot ? (
                <>
                  <span style={{ fontWeight: 600, color: '#9ca3af' }}>VCP</span> — 價 —×{Math.round(VCP_WEIGHT_PRICE * 100)}% 量 —×
                  {Math.round(VCP_WEIGHT_VOLUME * 100)}%
                </>
              ) : vcpSnapshot.error ? (
                <span style={{ color: '#b45309', fontSize: 11 }}>VCP：無法取得 Yahoo 價量</span>
              ) : (
                <>
                  <span style={{ fontWeight: 600, color: '#9ca3af' }}>VCP</span>{' '}
                  {vcpSnapshot.composite != null && Number.isFinite(vcpSnapshot.composite) ? (
                    <span
                      style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--app-text-soft)' }}
                    >
                      {vcpSnapshot.composite.toFixed(2)}
                    </span>
                  ) : (
                    <span style={{ color: '#9ca3af' }}>—</span>
                  )}
                  {'　'}
                  <span style={{ fontWeight: 600, color: '#9ca3af' }}>HL</span>{' '}
                  {stock?.pricePos6m != null && Number.isFinite(stock.pricePos6m) ? (
                    <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--app-text-soft)' }}>
                      {stock.pricePos6m.toFixed(2)}
                    </span>
                  ) : (
                    <span style={{ color: '#9ca3af' }}>—</span>
                  )}
                </>
              )}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
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
                    lineHeight: 1.2,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  K 線圖
                </a>
              )}
              {signalNote && (
                <span className="ibd-rs-signal-note" style={{
                  fontSize: 11,
                  fontWeight: 500,
                  borderRadius: 4,
                  padding: '2px 7px',
                  lineHeight: 1.4,
                  flexShrink: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {signalNote}
                </span>
              )}
            </div>
          </div>
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
            aria-label="關閉"
          >
            ✕
          </button>
        </div>

        {loading || weeklyPending ? (
          <div
            style={{
              flex: '1 1 0px',
              minHeight: 0,
              height: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#aaa',
              fontSize: 13,
            }}
          >
            {weeklyPending ? '載入週線…' : '載入近半年資料…'}
          </div>
        ) : error ? (
          <div
            style={{
              flex: '1 1 0px',
              minHeight: 0,
              height: 0,
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
              flex: '1 1 0px',
              minHeight: 0,
              height: 0,
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
          <div
            style={{
              // height:0 + flex-grow：讓此區在 column flex 裡「真的」吃掉 VCP 下方剩餘高度（否則常只剩內容高、底部空白）
              flex: '1 1 0px',
              minHeight: 0,
              height: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 0,
              width: '100%',
              overflow: 'hidden',
              WebkitOverflowScrolling: 'touch',
            }}
            onWheel={(e) => {
              // 圖表區不應觸發垂直捲動（尤其下半部靠近底部時）
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <section
              className="ibd-rs-chart-modal-chart-wrap"
              style={{
                flex: '1 1 0',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 'max(300px, 46vh)',
                alignSelf: 'center',
                width: '100%',
                maxWidth: 760,
                border: '1px solid var(--app-border)',
                borderRadius: 10,
                padding: '8px 4px 4px',
                background: 'linear-gradient(180deg, var(--app-surface) 0%, var(--app-surface-2) 100%)',
                boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)',
              }}
              onWheel={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <header
                style={{
                  display: 'flex',
                  flexWrap: 'nowrap',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 4,
                  paddingBottom: 6,
                  borderBottom: '1px solid var(--app-border)',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    width: 4,
                    alignSelf: 'stretch',
                    minHeight: 22,
                    borderRadius: 3,
                    background: activeView === 'rs' ? '#c0392b' : '#d97706',
                    flexShrink: 0,
                  }}
                  aria-hidden
                />
                {/* 視窗切換 tabs */}
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {[
                    { key: 'rs',      label: 'RS' },
                    { key: 'foreign', label: '籌碼' },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setActiveView(key)}
                      style={{
                        padding: '2px 9px',
                        fontSize: 12,
                        fontWeight: activeView === key ? 700 : 500,
                        borderRadius: 5,
                        border: `1px solid ${activeView === key ? (key === 'rs' ? 'var(--rs-tab-rs-fg)' : 'var(--rs-tab-chip-fg)') : 'var(--app-border)'}`,
                        background: activeView === key ? (key === 'rs' ? 'var(--rs-tab-rs-bg)' : 'var(--rs-tab-chip-bg)') : 'transparent',
                        color: activeView === key ? (key === 'rs' ? 'var(--rs-tab-rs-fg)' : 'var(--rs-tab-chip-fg)') : '#94a3b8',
                        cursor: 'pointer',
                        lineHeight: 1.4,
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'baseline',
                    flexWrap: 'nowrap',
                    gap: 8,
                    fontSize: 11,
                    lineHeight: 1.35,
                  }}
                >
                  {activeView === 'rs' ? (
                    <>
                      <span
                        className="ibd-rs-chart-legend-text ibd-rs-chart-legend-text--full"
                        style={{ color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}
                      >
                        <span
                          role="button"
                          onClick={() => setChartTf((v) => (v === 'D' ? 'W' : 'D'))}
                          title="點擊切換日線(D)／週線(W)（也可按 W 鍵）"
                          style={{ cursor: 'pointer', userSelect: 'none', color: '#1565c0', fontWeight: 700 }}
                        >
                          {chartTf === 'W' ? 'W' : 'D'}
                        </span>
                        {'　'}
                        <span
                          role="button"
                          onClick={() => setShowMA((v) => !v)}
                          title="點擊切換均線顯示（也可按 Shift 鍵）"
                          style={{ cursor: 'pointer', userSelect: 'none', opacity: showMA ? 1 : 0.4 }}
                        >
                          <strong style={{ color: '#f59e0b' }}>MA10</strong> <strong style={{ color: '#7c3aed' }}>MA20</strong>
                        </span>
                      </span>
                    </>
                  ) : (
                    <span
                      style={{ color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, fontSize: 11 }}
                    >
                      <strong style={{ color: '#1565c0' }}>藍線</strong>＝外資持股
                      {effectiveHoldings === null && fetchedHoldings !== false && <span style={{ color: '#94a3b8' }}> 持股載入中…</span>}
                      {fetchedHoldings === false && effectiveHoldings === null && <span style={{ color: '#f87171' }}> 持股數據不可用</span>}
                      　<strong style={{ color: '#ff2d87' }}>●</strong>＝B訊號
                      {institutionalLoading && <span style={{ color: '#94a3b8' }}>法人載入中…</span>}
                      {!institutionalLoading && institutionalData && Object.keys(institutionalData).length > 0 && (
                        <><span style={{ color: '#1565c0' }}>■</span>外資 <span style={{ color: '#16a34a' }}>■</span>投信 <span style={{ color: '#f97316' }}>■</span>自營</>
                      )}
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 10, color: '#cbd5e1', flexShrink: 0, marginLeft: 4 }}>↑↓ 切換</span>
              </header>
              <div
                className="ibd-rs-chart-modal-svg-bleed"
                style={{
                  flex: '1 1 0',
                  minHeight: 0,
                  width: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {activeView === 'rs' ? (
                  <IbdRsComboChart data={chartData} showMA={showMA} showRs={chartTf !== 'W'} />
                ) : (
                  <ForeignChipChart data={foreignChartData} allHoldings={effectiveHoldings?.holdings} />
                )}
              </div>
            </section>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginTop: 3,
            lineHeight: 1.5,
            padding: '2px 4px 0',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 10, color: '#94a3b8', textAlign: 'left', flex: '1 1 auto', minWidth: 0 }}>
            {activeView === 'rs'
              ? 'RS 歷史隨每日 sync 累積；股價與 VCP 同源（Yahoo）'
              : '外資持股日頻（晚上 10 點後更新）；三大法人即時抓取；B 訊號回溯至近 130 交易日'}
          </span>
          {typeof onToggleWatchlist === 'function' && (
            <div style={{ position: 'relative', flex: '0 0 auto', display: 'inline-flex' }}>
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  if (!stock || watchlistBusy || typeof onToggleWatchlist !== 'function') return;
                  setWatchlistBusy(true);
                  try {
                    await onToggleWatchlist(stock);
                  } catch (err) {
                    console.error('[觀察列表]', err);
                  } finally {
                    setWatchlistBusy(false);
                  }
                }}
                disabled={watchlistBusy}
                aria-label={inWatchlist ? '自觀察列表移除' : '加入觀察列表'}
                title={inWatchlist ? '自觀察列表移除' : '加入觀察列表（鍵盤 1/2/3）'}
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: watchlistBusy ? 'wait' : 'pointer',
                  fontSize: 15,
                  lineHeight: 1,
                  padding: '2px 4px',
                  color: inWatchlist ? '#f59e0b' : '#cbd5e1',
                }}
              >
                {inWatchlist ? '★' : '☆'}
              </button>
              {inWatchlist && watchlistPriority != null && typeof onSetPriority === 'function' && (
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (priorityBusy) return;
                    setPriorityBusy(true);
                    try {
                      await onSetPriority(stock, null);
                    } catch (err) {
                      console.error('[優先順序]', err);
                    } finally {
                      setPriorityBusy(false);
                    }
                  }}
                  disabled={priorityBusy}
                  title={`分類 ${watchlistPriority}（點擊清除，鍵盤 1/2/3 更改）`}
                  aria-label={`分類 ${watchlistPriority}，點擊清除`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: priorityBusy ? 'wait' : 'pointer',
                    fontSize: 10,
                    fontWeight: 700,
                    lineHeight: 1,
                    padding: 0,
                    color: 'var(--app-text)',
                    pointerEvents: 'auto',
                  }}
                >
                  {watchlistPriority}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 讀單一檔的籌碼完整序列（Firestore stockWatchlist/{code}）。
 * 結構與 prefetchChipData/籌碼視窗一致：三大法人每日買賣超 + 外資持股序列。
 * 查無資料或失敗回 null，不阻斷整體匯出。
 */
async function fetchWatchlistChipSeries(code) {
  try {
    const snap = await getDoc(doc(db, 'stockWatchlist', String(code)));
    if (!snap.exists()) return null;
    const d = snap.data() || {};
    const h = d.history || {};
    const hasInst = Array.isArray(h.instDates) && h.instDates.length > 0;
    const hasHolding = Array.isArray(h.foreignTotalHolding) && h.foreignTotalHolding.length > 0;
    if (!hasInst && !hasHolding) return null;

    // 只保留近三個月（兩序列皆 newest-first，依日期過濾；無日期時退回取前 ~63 個交易日）
    const cutoff = (() => {
      const x = new Date();
      x.setMonth(x.getMonth() - 3);
      return x.toISOString().slice(0, 10);
    })();
    const keepIdx = (dates, len) =>
      Array.isArray(dates) && dates.length
        ? dates.map((_, i) => i).filter((i) => (dates[i] || '') >= cutoff)
        : Array.from({ length: Math.min(63, len || 0) }, (_, i) => i);
    const pick = (arr, idx) => (Array.isArray(arr) ? idx.map((i) => arr[i]) : null);

    let inst = null;
    if (hasInst) {
      const idx = keepIdx(h.instDates, h.instDates.length);
      // 三大法人每日買賣超（單位：股，正=買超）。dates 與各陣列同序（由新到舊）。
      inst = {
        latestDate: d.latestInstDate ?? h.instDates[0] ?? null,
        dates: pick(h.instDates, idx),
        foreign: pick(h.instForeign, idx),
        trust: pick(h.instTrust, idx),
        dealer: pick(h.instDealer, idx),
      };
    }

    let foreignHolding = null;
    if (hasHolding) {
      const idx = keepIdx(h.foreignHoldingDates, h.foreignTotalHolding.length);
      // 外資持股張數（單位：張）時間序列。
      foreignHolding = {
        latestDate: d.latestHoldingsDate ?? null,
        dates: pick(h.foreignHoldingDates, idx),
        holdingLots: pick(h.foreignTotalHolding, idx),
      };
    }

    return { inst, foreignHolding };
  } catch (_) {
    return null;
  }
}

async function downloadWatchlistJson(items) {
  // 平行撈每檔籌碼序列（清單僅約數十檔，單檔失敗回 null 不影響其他檔）
  const chipList = await Promise.all(items.map((s) => fetchWatchlistChipSeries(s.id)));
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const timeStr = now.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  const data = {
    exportedAt: `${dateStr} ${timeStr}`,
    total: items.length,
    description:
      'RS 觀察清單匯出，供 AI 分析用。RS=相對強度(0-99)，rsDelta=RS 變化，pricePct=漲跌幅(%)，' +
      'pricePos6m=近六個月高低位置(0=最低,1=最高)。chip=預抓籌碼(僅近三個月)：inst 為三大法人每日買賣超' +
      '(單位:股,正=買超；foreign 外資/trust 投信/dealer 自營商；dates 與各陣列同序,由新到舊)；' +
      'foreignHolding 為外資持股張數(單位:張)時間序列。chip 為 null 表示尚未抓到籌碼。',
    stocks: items.map((s, i) => ({
      code: s.id,
      name: s.name,
      rs: getEffectiveDisplayRs(s) ?? null,
      rsDelta5: s.delta5d ?? null,
      rsDelta20: s.delta20d ?? null,
      pricePct5d: s.pricePct5d ?? null,
      pricePct20d: s.pricePct20d ?? null,
      pricePos6m: s.pricePos6m ?? null,
      chip: chipList[i],
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rs-watchlist-${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function HomeStockSectionCard({ section, onPickStock, newIdSet, uniformHeight, onMeasure, mobileLayout = false, onDownload, pctShortDays = 5, pctLongDays = 20 }) {
  const { key, title, subtitle, items, totalCount, emptyText } = section;
  const cardRef = useRef(null);
  const [cardPage, setCardPage] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const cardPageCount = Math.max(1, Math.ceil(items.length / IBDRS_HOME_CARD_PAGE_SIZE));
  const safeCardPage = Math.min(cardPage, cardPageCount - 1);
  const visibleItems = useMemo(
    () => items.slice(safeCardPage * IBDRS_HOME_CARD_PAGE_SIZE, (safeCardPage + 1) * IBDRS_HOME_CARD_PAGE_SIZE),
    [items, safeCardPage]
  );

  useEffect(() => {
    setCardPage(0);
  }, [key, items]);

  useEffect(() => {
    if (cardPage !== safeCardPage) setCardPage(safeCardPage);
  }, [cardPage, safeCardPage]);

  useLayoutEffect(() => {
    if (typeof onMeasure !== 'function') return;
    const el = cardRef.current;
    if (!el) return;
    onMeasure(key, Math.ceil(el.getBoundingClientRect().height));
  }, [key, items.length, safeCardPage, onMeasure]);
  const th = {
    padding: '5px 4px',
    borderBottom: '1px solid var(--app-border)',
    background: 'var(--app-th-bg)',
    fontSize: 10,
    fontWeight: 800,
    color: 'var(--app-text)',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  };
  const td = {
    padding: '5px 4px',
    borderBottom: '1px solid var(--app-border)',
    fontSize: 10.5,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  };
  const fmtPct = (v) => (v != null && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${Math.round(v)}` : '—');
  const fmtHl = (v) => (v != null && Number.isFinite(v) ? v.toFixed(2) : '—');

  return (
    <section
      ref={cardRef}
      key={key}
      style={{
        background: 'var(--app-surface)',
        border: '1px solid var(--app-border)',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 2px 12px rgba(15, 23, 42, 0.04)',
        minHeight: uniformHeight || undefined,
      }}
    >
      <header
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--app-border)',
          background: 'linear-gradient(180deg, var(--app-surface-2) 0%, var(--app-surface) 100%)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <strong style={{ color: '#0f766e', fontSize: 13 }}>{title}</strong>
        <span style={{ fontSize: 11, color: '#64748b' }}>{totalCount} 檔</span>
        {subtitle ? <span style={{ fontSize: 11, color: '#94a3b8' }}>{subtitle}</span> : null}
        {onDownload ? (
          <button
            type="button"
            onClick={async () => {
              if (downloading || items.length === 0) return;
              setDownloading(true);
              try {
                await onDownload(items);
              } finally {
                setDownloading(false);
              }
            }}
            disabled={items.length === 0 || downloading}
            title="下載清單 JSON（含籌碼完整序列），供 AI 分析用"
            style={{
              padding: '1px 4px',
              background: 'none',
              border: 'none',
              cursor: items.length === 0 || downloading ? 'not-allowed' : 'pointer',
              lineHeight: 1,
              opacity: items.length === 0 ? 0.3 : 0.55,
              display: 'inline-flex',
              alignItems: 'center',
              alignSelf: 'center',
            }}
          >
            {downloading ? (
              <svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
                <circle cx="7" cy="7" r="5" fill="none" stroke="#cbd5e1" strokeWidth="1.5" />
                <path d="M7 2a5 5 0 0 1 5 5" fill="none" stroke="#0f766e" strokeWidth="1.5" strokeLinecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="0.7s" repeatCount="indefinite" />
                </path>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M7 1v7M4.5 5.5L7 8l2.5-2.5" stroke="#555" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <line x1="2" y1="12" x2="12" y2="12" stroke="#555" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        ) : null}
        {cardPageCount > 1 ? (
          <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              onClick={() => setCardPage((p) => Math.max(0, p - 1))}
              disabled={safeCardPage === 0}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--app-text-soft)',
                fontSize: 14,
                lineHeight: 1,
                padding: '0 3px',
                cursor: safeCardPage === 0 ? 'default' : 'pointer',
                opacity: safeCardPage === 0 ? 0.45 : 1,
              }}
            >
              ‹
            </button>
            <span style={{ fontSize: 11, color: '#64748b', minWidth: 40, textAlign: 'center' }}>
              {safeCardPage + 1}/{cardPageCount}
            </span>
            <button
              type="button"
              onClick={() => setCardPage((p) => Math.min(cardPageCount - 1, p + 1))}
              disabled={safeCardPage >= cardPageCount - 1}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--app-text-soft)',
                fontSize: 14,
                lineHeight: 1,
                padding: '0 3px',
                cursor: safeCardPage >= cardPageCount - 1 ? 'default' : 'pointer',
                opacity: safeCardPage >= cardPageCount - 1 ? 0.45 : 1,
              }}
            >
              ›
            </button>
          </div>
        ) : null}
      </header>
      <div
        style={{
          overflowX: 'hidden',
          overflowY: 'visible',
          minHeight: mobileLayout ? undefined : IBDRS_HOME_CARD_BODY_MIN_PX,
          paddingTop: 10,
          paddingLeft: 12,
          paddingRight: 12,
        }}
      >
        {items.length === 0 ? (
          <div style={{ padding: '14px 12px', fontSize: 12, color: '#94a3b8' }}>{emptyText || '今日無符合條件股票'}</div>
        ) : (
          <table style={{ width: '100%', minWidth: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '12%' }} />
              <col style={{ width: '20%' }} />
              <col style={{ width: '11.3333%' }} />
              <col style={{ width: '11.3333%' }} />
              <col style={{ width: '11.3333%' }} />
              <col style={{ width: '11.3333%' }} />
              <col style={{ width: '11.3333%' }} />
              <col style={{ width: '11.3333%' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={th}>代號</th>
                <th style={{ ...th, textAlign: 'left', paddingLeft: 6 }}>名稱</th>
                <th style={th}>RS</th>
                <th style={th}>Δ5</th>
                <th style={th}>Δ20</th>
                <th style={th}>{pctShortDays}D</th>
                <th style={th}>{pctLongDays}D</th>
                <th style={th}>HL</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((s, idx) => {
                const displayRs = getEffectiveDisplayRs(s);
                const isNew = newIdSet?.has(s.id) === true;
                return (
                  <tr
                    key={`${key}-${s.id}-${idx}`}
                    onClick={() => onPickStock?.(s)}
                    title={isNew ? '今日新出現' : undefined}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ ...td, color: 'var(--app-text-soft)' }}>
                      {s.id}
                    </td>
                    <td
                      style={{
                        ...td,
                        textAlign: 'left',
                        paddingLeft: 4,
                        color: 'var(--app-text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      <span>{s.name}</span>
                      {isNew ? (
                        <span
                          aria-label="今日新出現"
                          style={{
                            display: 'inline-block',
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: '#0084ff',
                            marginLeft: 6,
                            verticalAlign: 'middle',
                          }}
                        />
                      ) : null}
                    </td>
                    <td style={{ ...td, color: 'var(--app-text-soft)' }}>{displayRs ?? '—'}</td>
                    <td style={{ ...td, color: getDeltaColor(s.delta5d) }}>{fmtDelta(s.delta5d)}</td>
                    <td style={{ ...td, color: getDeltaColor(s.delta20d) }}>{fmtDelta(s.delta20d)}</td>
                    <td style={{ ...td, color: getDeltaColor(s.pricePctShort ?? s.pricePct5d) }}>{fmtPct(s.pricePctShort ?? s.pricePct5d)}</td>
                    <td style={{ ...td, color: getDeltaColor(s.pricePctLong ?? s.pricePct20d) }}>{fmtPct(s.pricePctLong ?? s.pricePct20d)}</td>
                    <td style={{ ...td, color: 'var(--app-text-soft)' }}>{fmtHl(s.pricePos6m)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

/** 「今日重點」視窗：各段列表含 RS、Δ、1D／5D／20D 漲跌幅、HL；點列開啟 RS 折線圖 */
function MajorMovesModal({
  onClose,
  items,
  itemsPriceBig,
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
      border: '1px solid var(--app-border)',
      background: 'var(--app-surface)',
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
      color: 'var(--app-text)',
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
      <col style={{ width: MM_FOCUS_COL_PX.p1d }} />
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

  const majorFocusThead = (bg, fg, stepHeader = '單日Δ', stepTitle = '歷史最後一點與前一點之差') => (
    <thead>
      <tr style={{ background: bg, color: fg }}>
        <th style={mm.th(fg, 'center')}>代號</th>
        <th style={mm.th(fg, 'left')}>名稱</th>
        <th style={mm.th(fg, 'center')} title="與主表／折線圖同源">
          RS
        </th>
        <th style={mm.th(fg, 'center')} title={stepTitle}>
          {stepHeader}
        </th>
        <th style={mm.th(fg, 'center')} title={deltaShortTitle}>
          {deltaShortLabel}
        </th>
        <th style={mm.th(fg, 'center')} title={deltaLongTitle}>
          {deltaLongLabel}
        </th>
        <th style={mm.th(fg, 'center')} title="近 1 個交易日收盤漲跌幅（%）">
          1D
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

  const renderFullMetricRows = (list, sectionKey, rowHoverBg = '#f0fdf9', stepMode = 'rsStep') =>
    list.map((s) => {
      const badge = formatIbdMarketLabel(s.market);
      const rs = getEffectiveDisplayRs(s);
      const stepIsPct1d = stepMode === 'pct1d';
      const step = stepIsPct1d ? s.pricePct1d : stepDeltaForRow(s);
      return (
        <tr
          key={`${sectionKey}-${s.id}`}
          onClick={() => onPickStock(s)}
          style={{
            cursor: 'pointer',
            borderBottom: '1px solid var(--app-border)',
            background: 'var(--app-surface)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = rowHoverBg;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--app-surface)';
          }}
        >
          <td style={{ ...mm.tdId, fontWeight: 700, color: 'var(--app-text-soft)' }}>{s.id}</td>
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
          <td style={{ ...mm.tdNum, fontWeight: 700, color: 'var(--app-text)' }}>{rs ?? '—'}</td>
          <td style={{ ...mm.tdNum, fontWeight: 700, color: getDeltaColor(step) }}>
            {stepIsPct1d ? fmtPctModal(step) : fmtDelta(step)}
          </td>
          <td style={{ ...mm.tdNum, fontWeight: 600, color: getDeltaColor(s.delta5d) }}>{fmtDelta(s.delta5d)}</td>
          <td style={{ ...mm.tdNum, fontWeight: 600, color: getDeltaColor(s.delta20d) }}>{fmtDelta(s.delta20d)}</td>
          <td style={{ ...mm.tdNum, fontWeight: 600, color: getDeltaColor(s.pricePct1d) }}>
            {fmtPctModal(s.pricePct1d)}
          </td>
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
      className="ibd-rs-major-moves-backdrop"
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
        className="ibd-rs-major-moves-panel"
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
          className="ibd-rs-major-moves-header"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 10,
            padding: '14px 28px 10px',
            borderBottom: '1px solid var(--app-border)',
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
              border: '1px solid var(--app-border)',
              borderRadius: 8,
              background: 'var(--app-surface)',
              cursor: 'pointer',
              color: '#666',
            }}
          >
            ×
          </button>
        </div>

        <div
          className="ibd-rs-major-moves-body"
          style={{ padding: '14px 28px 16px', overflow: 'auto', flex: '1 1 auto', WebkitOverflowScrolling: 'touch' }}
        >
          <div style={{ marginBottom: 20 }}>
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

          <div style={{ marginBottom: 20 }}>
            <div style={mmSecTitle('#b91c1c')}>
              當日股價漲跌幅 |%| &gt; {IBDRS_FOCUS_PRICE_PCT_ABS_GT}% 且 RS &gt; {IBDRS_FOCUS_PRICE_RS_GT}（
              {itemsPriceBig.length}）
            </div>
            {itemsPriceBig.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
                無（需基準日已同步且有 1 交易日漲跌幅資料，且 |漲跌幅| &gt; {IBDRS_FOCUS_PRICE_PCT_ABS_GT}% 與 RS &gt;{' '}
                {IBDRS_FOCUS_PRICE_RS_GT}；尚未寫入 1 日漲跌幅者請執行「同步今日 RS」或 Shift 強制重抓）
              </div>
            ) : (
              <div style={mm.scrollWrap}>
                <table style={mm.table}>
                  {majorFocusColgroup()}
                  {majorFocusThead('#fef2f2', '#991b1b', '漲跌', '近 1 個交易日收盤漲跌幅（%）')}
                  <tbody>{renderFullMetricRows(itemsPriceBig, 'pct', '#fff1f2', 'pct1d')}</tbody>
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
        </div>
      </div>
    </div>
  );
}

// ─── 主頁面 ──────────────────────────────────────────────────────────────────

/**
 * RS／Δ／漲跌幅／HL／型態／搜尋等；不含 VCP（與主表邏輯一致）。
 * 先過此關再決定要對哪些檔抓 Yahoo VCP，可減少請求數。
 */
/** 從 priceMap 取最新收盤與 MA10/MA20/MA60（依日期排序後的最後 N 筆有效收盤平均） */
function priceVsMAFromPriceMap(priceMap) {
  if (!priceMap || typeof priceMap !== 'object') return null;
  const dates = Object.keys(priceMap).sort();
  const closes = [];
  for (const d of dates) {
    const v = Number(priceMap[d]);
    if (Number.isFinite(v) && v > 0) closes.push(v);
  }
  if (closes.length === 0) return null;
  const maOf = (p) => (closes.length >= p ? closes.slice(-p).reduce((a, b) => a + b, 0) / p : null);
  return { close: closes[closes.length - 1], ma10: maOf(10), ma20: maOf(20), ma60: maOf(60) };
}

function stockPassesNonVcpFilters(s, filters) {
  const n = (v) => {
    if (v === '' || v == null) return null;
    const x = parseFloat(String(v).trim());
    return Number.isFinite(x) ? x : null;
  };
  const rsMin = n(filters.rsMin);
  const rsMax = n(filters.rsMax);
  const d5min = n(filters.delta5dMin);
  const d5max = n(filters.delta5dMax);
  const d20min = n(filters.delta20dMin);
  const d20max = n(filters.delta20dMax);
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

  const effRs = getEffectiveDisplayRs(s);
  if (rsMin != null && (effRs == null || effRs < rsMin)) return false;
  if (rsMax != null && (effRs == null || effRs > rsMax)) return false;
  if (d5min != null && (s.delta5d == null || s.delta5d < d5min)) return false;
  if (d5max != null && (s.delta5d == null || s.delta5d > d5max)) return false;
  if (d20min != null && (s.delta20d == null || s.delta20d < d20min)) return false;
  if (d20max != null && (s.delta20d == null || s.delta20d > d20max)) return false;
  if (pct5dMin != null && (s.pricePctShort == null || s.pricePctShort < pct5dMin)) return false;
  if (pct5dMax != null && (s.pricePctShort == null || s.pricePctShort > pct5dMax)) return false;
  if (pct20dMin != null && (s.pricePctLong == null || s.pricePctLong < pct20dMin)) return false;
  if (pct20dMax != null && (s.pricePctLong == null || s.pricePctLong > pct20dMax)) return false;
  if (hlMin != null && (s.pricePos6m == null || !Number.isFinite(s.pricePos6m) || s.pricePos6m < hlMin)) return false;
  if (hlMax != null && (s.pricePos6m == null || !Number.isFinite(s.pricePos6m) || s.pricePos6m > hlMax)) return false;

  const wantMA10 = filters.priceAboveMA10 === '1';
  const wantMA20 = filters.priceAboveMA20 === '1';
  const wantMA60 = filters.priceAboveMA60 === '1';
  if (wantMA10 || wantMA20 || wantMA60) {
    const pv = priceVsMAFromPriceMap(s.priceMap);
    if (!pv || pv.close == null) return false;
    if (wantMA10 && !(pv.ma10 != null && pv.close > pv.ma10)) return false;
    if (wantMA20 && !(pv.ma20 != null && pv.close > pv.ma20)) return false;
    if (wantMA60 && !(pv.ma60 != null && pv.close > pv.ma60)) return false;
  }

  if (crossFilterActive) {
    if (!detectCrossUp(effRs, s.ibdRsHistory, crossLevelParsed, crossDaysParsed)) return false;
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
}

const DEFAULT_FILTERS = {
  rsMin: '',
  rsMax: '',
  /** RS 變化：短／長回溯「交易日」數（ibdRsHistory 筆數；顯示與計算用） */
  deltaShortDays: '5',
  deltaLongDays: '20',
  delta5dMin: '',
  delta5dMax: '',
  delta20dMin: '',
  delta20dMax: '',
  /** 漲跌幅：短／長回溯「交易日」數（priceMap；自選天數） */
  pctShortDays: '5',
  pctLongDays: '20',
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
  /** 價格站上均線：各自勾選（'1' 表要求收盤 > 該均線），可複選＝同時站上 */
  priceAboveMA10: '',
  priceAboveMA20: '',
  priceAboveMA60: '',
  /** VCP 加權合成（0～1）；與圖表區塊相同公式，需即時抓 Yahoo */
  vcpMin: '',
  vcpMax: '',
  /**
   * Utility Screen（大盤修正期領先股）：'1' 才套用。
   * 僅在大盤距 200 日高點 20～200 個交易日之間可用；成交額以「億元」輸入。
   */
  utilityOn: '',
  utilityRsMin: String(UTILITY_DEFAULT_PARAMS.rsMin),
  utilityMaxPctFromHigh: String(UTILITY_DEFAULT_PARAMS.maxPctFromHigh),
  utilityTurnoverMin: '1',
  utilityTurnoverDays: String(UTILITY_DEFAULT_PARAMS.turnoverDays),
  utilityReqMa200: '1',
  utilityReqMaStack: '1',
  query: '',
};

/**
 * 與篩選三明治一致：右欄＝下限、左欄＝上限 → 下限 ≤ 指標 ≤ 上限。
 * 只填一邊時用 ≥／≤，避免「85～—」難讀。
 */
function summarizeMinMaxLine(label, lowerStr, upperStr) {
  const lo = lowerStr !== '' && String(lowerStr).trim() !== '' ? String(lowerStr).trim() : null;
  const hi = upperStr !== '' && String(upperStr).trim() !== '' ? String(upperStr).trim() : null;
  if (lo == null && hi == null) return null;
  if (lo != null && hi != null) return `${lo} ≤ ${label} ≤ ${hi}`;
  if (lo != null) return `${label} ≥ ${lo}`;
  return `${label} ≤ ${hi}`;
}

/**
 * 頂欄用：列出與預設不同的篩選條件（繁中簡述）。
 */
function summarizeIbdRsFilters(filters, deltaShortResolved, deltaLongResolved) {
  const parts = [];
  const f = filters;

  const rsLine = summarizeMinMaxLine('RS', f.rsMin, f.rsMax);
  if (rsLine) parts.push(rsLine);
  if (f.deltaShortDays !== DEFAULT_FILTERS.deltaShortDays) {
    parts.push(`短區間 ${f.deltaShortDays} 交易日`);
  }
  if (f.deltaLongDays !== DEFAULT_FILTERS.deltaLongDays) {
    parts.push(`長區間 ${f.deltaLongDays} 交易日`);
  }
  const dShortLine = summarizeMinMaxLine(`Δ${deltaShortResolved}`, f.delta5dMin, f.delta5dMax);
  if (dShortLine) parts.push(dShortLine);
  const dLongLine = summarizeMinMaxLine(`Δ${deltaLongResolved}`, f.delta20dMin, f.delta20dMax);
  if (dLongLine) parts.push(dLongLine);
  const pct5Line = summarizeMinMaxLine('5D', f.pct5dMin, f.pct5dMax);
  if (pct5Line) parts.push(pct5Line);
  const pct20Line = summarizeMinMaxLine('20D', f.pct20dMin, f.pct20dMax);
  if (pct20Line) parts.push(pct20Line);
  const hlLine = summarizeMinMaxLine('HL', f.hlMin, f.hlMax);
  if (hlLine) parts.push(hlLine);
  const crossDaysParsed = parseInt(String(f.crossDays || '').trim(), 10);
  const crossLevelParsed = parseInt(String(f.crossLevel || '').trim(), 10);
  if (
    Number.isFinite(crossDaysParsed) &&
    crossDaysParsed > 0 &&
    Number.isFinite(crossLevelParsed) &&
    crossLevelParsed >= 1 &&
    crossLevelParsed <= 99
  ) {
    parts.push(`向上突破：近 ${crossDaysParsed} 交易日穿越 ${crossLevelParsed}`);
  }
  const wk = parseInt(String(f.weeksNewHigh || '').trim(), 10);
  if (Number.isFinite(wk) && wk >= 1 && wk <= 52) {
    parts.push(`近 ${wk} 週區間新高`);
  }
  const maOver = [];
  if (f.priceAboveMA10 === '1') maOver.push('MA10');
  if (f.priceAboveMA20 === '1') maOver.push('MA20');
  if (f.priceAboveMA60 === '1') maOver.push('MA60');
  if (maOver.length) parts.push(`價格站上 ${maOver.join('、')}`);
  if (f.query.trim()) {
    parts.push(`搜尋「${f.query.trim()}」`);
  }
  const vcpLine = summarizeMinMaxLine('VCP', f.vcpMin, f.vcpMax);
  if (vcpLine) parts.push(vcpLine);
  if (f.utilityOn === '1') parts.push('Utility Screen');
  return parts;
}

/**
 * Utility Screen 狀態：拆成幾個短數據＋一句話結論，避免一整段長句擠在框裡。
 * 高低點日期與點位放進 tooltip（title），需要時再看。
 */
function describeUtilityState(state) {
  if (!state || state.ok !== true) {
    return { tone: 'muted', badge: '載入中', stats: [], note: '加權指數（^TWII）尚未取得', detail: undefined };
  }
  const d = state.daysSinceHigh;
  const pct = Number.isFinite(state.pctFromHigh) ? state.pctFromHigh.toFixed(2) : '—';
  const fmt = (v) => (v != null ? Math.round(v).toLocaleString() : '—');
  const detail =
    `${UTILITY_INDEX_LOOKBACK} 日高點 ${state.highDate ?? '—'} ${fmt(state.high)}　|　` +
    `最新 ${state.lastDate ?? '—'} ${fmt(state.lastClose)}`;

  const stats = [
    { label: '距高點', value: `${d} 日` },
    { label: '回檔', value: `−${pct}%` },
  ];

  if (state.reason === 'nearHigh') {
    return {
      tone: 'muted',
      badge: '未啟動',
      stats,
      note: `未超過 ${UTILITY_MIN_DAYS_SINCE_HIGH} 日，請用原本 RS 濾網`,
      detail,
    };
  }
  if (state.reason === 'tooLong') {
    return {
      tone: 'muted',
      badge: '停用',
      stats,
      note: `已超過 ${UTILITY_MAX_DAYS_SINCE_HIGH} 日，請用原本 RS 濾網`,
      detail,
    };
  }
  return {
    tone: 'active',
    badge: '可用',
    stats: [...stats, { label: 'RS 窗口', value: `${d} 日` }],
    note: null,
    detail,
  };
}

export default function IBDRsRankingPage() {
  const { stocks, loading, syncing, syncProgress, syncRs, lastSyncAt, refresh } = useIbdRsData();
  const { stockIds: rsWatchlistIds, idSet: rsWatchlistIdSet, priorities: rsWatchlistPriorities, ready: rsWatchlistReady, toggle: toggleRsWatchlist, setPriority: setRsWatchlistPriority } = useIbdRsWatchlist();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [activeView, setActiveView] = useState('home');
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
  const [homeSectionNewMap, setHomeSectionNewMap] = useState(() => new Map());
  /** Firestore `ibdRsMeta/homeFirstSeen`.byId：首次出現於首頁區塊的台北曆日 */
  const [homeFirstSeenById, setHomeFirstSeenById] = useState(() => ({}));
  const homeFirstSeenLocalMigratedRef = useRef(false);
  const [homeCardUniformHeight, setHomeCardUniformHeight] = useState(null);
  /** Utility Screen 用的加權指數（^TWII）收盤序列；null＝尚未載入、{}＝抓取失敗 */
  const [utilIndexMap, setUtilIndexMap] = useState(null);
  const [isMobileLayout, setIsMobileLayout] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(`(max-width: ${IBDRS_MOBILE_MAX_WIDTH_PX}px)`).matches;
  });
  const batchAbortRef = useRef(null);

  // 觀察清單載入後，背景預抓每檔籌碼（三大法人 + 外資持股），讓之後開籌碼視窗時已是最新、免等 API。
  // prefetchWatchlistChipData 已內建新鮮度判斷(holdingsFreshnessBound / instFreshnessBound)與去重：
  // 已到最新交易日者幾乎零成本（只讀 Firestore），只有過期的才打 FinMind 補抓並存回。
  const chipPrefetchedRef = useRef(new Set());
  useEffect(() => {
    if (!rsWatchlistReady || !rsWatchlistIds?.length) return;
    rsWatchlistIds.forEach((id) => {
      if (!id || chipPrefetchedRef.current.has(id)) return;
      chipPrefetchedRef.current.add(id);
      prefetchWatchlistChipData(id).catch(() => {});
    });
  }, [rsWatchlistReady, rsWatchlistIds]);

  /** VCP 篩選：id → 加權合成值；僅在設了 vcp 上下限時向 Yahoo 批次抓取 */
  const [vcpById, setVcpById] = useState(() => new Map());
  const [vcpLoading, setVcpLoading] = useState(false);
  const vcpFetchGenRef = useRef(0);

  const vcpFilterActive = useMemo(() => {
    const pn = (v) => {
      if (v === '' || v == null) return null;
      const x = parseFloat(String(v).trim());
      return Number.isFinite(x) ? x : null;
    };
    return pn(filters.vcpMin) != null || pn(filters.vcpMax) != null;
  }, [filters.vcpMin, filters.vcpMax]);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('ibd-rs-page');
    return () => html.classList.remove('ibd-rs-page');
  }, []);

  /** 自觀察列表頁「開啟圖表」導向時，載入 stocks 後自動開啟該檔 modal */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!Array.isArray(stocks) || stocks.length === 0) return;
    try {
      const id = window.sessionStorage.getItem(RS_OPEN_STOCK_SESSION_KEY);
      if (!id) return;
      window.sessionStorage.removeItem(RS_OPEN_STOCK_SESSION_KEY);
      const found = stocks.find((s) => s.id === id);
      if (found) {
        setChartNavOverride(null);
        setSelectedStock(found);
      }
    } catch (_) {}
  }, [stocks]);

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

  /**
   * Utility Screen 需要加權指數判斷「距 200 日高點幾個交易日」。
   * 抓 2 年（≈480 根）以確保 200 交易日回看有餘裕；每日一次、走既有 proxy 快取。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 24);
    fetchIndexPriceMap(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10))
      .then((m) => {
        if (!cancelled) setUtilIndexMap(m || {});
      })
      .catch(() => {
        if (!cancelled) setUtilIndexMap({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      SYNC_STATUS_DOC_REF,
      (snap) => {
        const data = snap.data();
        const sharedDate = typeof data?.rsLastSyncDate === 'string' ? data.rsLastSyncDate.trim() : '';
        if (sharedDate) {
          setLastSyncDateLocal(sharedDate.slice(0, 10));
          return;
        }
        try {
          const v = localStorage.getItem(IBDRS_LAST_SYNC_DATE_KEY);
          if (v) setLastSyncDateLocal(v);
        } catch (_) {}
      },
      () => {
        try {
          const v = localStorage.getItem(IBDRS_LAST_SYNC_DATE_KEY);
          if (v) setLastSyncDateLocal(v);
        } catch (_) {}
      }
    );
    return () => unsub();
  }, []);


  useEffect(() => {
    if (!lastSyncAt) return;
    try {
      const v = localStorage.getItem(IBDRS_LAST_SYNC_DATE_KEY);
      if (v) setLastSyncDateLocal(v);
    } catch (_) {}
  }, [lastSyncAt]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mql = window.matchMedia(`(max-width: ${IBDRS_MOBILE_MAX_WIDTH_PX}px)`);
    const update = () => setIsMobileLayout(mql.matches);
    update();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', update);
      return () => mql.removeEventListener('change', update);
    }
    mql.addListener(update);
    return () => mql.removeListener(update);
  }, []);

  // 今日台北時間
  const todayYmd = mounted ? getTaiwanYmd() : null;

  /** 全庫最後一筆 ibdRsLastCloseDate（Yahoo 實際回傳的收盤日，代表 RS 是用哪天收盤價算的） */
  const latestIbdRsDataYmd = useMemo(() => {
    let max = null;
    for (const s of stocks) {
      const d = s.ibdRsLastCloseDate;
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

  /** 狀態列顯示「資料基準交易日」：取全庫 ibdRsUpdatedDate 最大值（即資料是用哪天的收盤價算的） */
  const displaySyncDate = latestIbdRsDataYmd || null;

  const deltaShortDaysResolved = useMemo(
    () => clampIbdDeltaDays(filters.deltaShortDays, 5),
    [filters.deltaShortDays]
  );
  const deltaLongDaysResolved = useMemo(
    () => clampIbdDeltaDays(filters.deltaLongDays, 20),
    [filters.deltaLongDays]
  );
  const pctShortDaysResolved = useMemo(
    () => clampIbdDeltaDays(filters.pctShortDays, 5),
    [filters.pctShortDays]
  );
  const pctLongDaysResolved = useMemo(
    () => clampIbdDeltaDays(filters.pctLongDays, 20),
    [filters.pctLongDays]
  );

  // ── Utility Screen：重算階段（只吃 stocks／指數／取樣天數，改門檻不重跑）
  const utilityTurnoverDaysResolved = useMemo(
    () => clampIbdDeltaDays(filters.utilityTurnoverDays, UTILITY_DEFAULT_PARAMS.turnoverDays),
    [filters.utilityTurnoverDays]
  );
  const utilityMetrics = useMemo(
    () => computeUtilityMetrics(stocks, utilIndexMap, { turnoverDays: utilityTurnoverDaysResolved }),
    [stocks, utilIndexMap, utilityTurnoverDaysResolved]
  );

  /** 門檻階段：純比較，改上下限即時重跑 */
  const utilityParams = useMemo(() => {
    const num = (v, fallback) => {
      const x = parseFloat(String(v ?? '').trim());
      return Number.isFinite(x) ? x : fallback;
    };
    const turnoverYi = num(filters.utilityTurnoverMin, 0);
    return {
      rsMin: num(filters.utilityRsMin, UTILITY_DEFAULT_PARAMS.rsMin),
      maxPctFromHigh: num(filters.utilityMaxPctFromHigh, UTILITY_DEFAULT_PARAMS.maxPctFromHigh),
      turnoverMin: turnoverYi > 0 ? turnoverYi * 1e8 : null,
      requirePriceAboveMa200: filters.utilityReqMa200 === '1',
      requireMa50AboveMa200: filters.utilityReqMaStack === '1',
    };
  }, [
    filters.utilityRsMin,
    filters.utilityMaxPctFromHigh,
    filters.utilityTurnoverMin,
    filters.utilityReqMa200,
    filters.utilityReqMaStack,
  ]);

  const utilityResult = useMemo(
    () => applyUtilityFilters(utilityMetrics, utilityParams),
    [utilityMetrics, utilityParams]
  );

  /** Utility Screen 是否實際生效：勾選了、且大盤處於可用區間 */
  const utilityActive = filters.utilityOn === '1' && utilityMetrics.state.active === true;
  const utilityStatus = useMemo(() => describeUtilityState(utilityMetrics.state), [utilityMetrics.state]);

  /** 表格「區RS」欄用：id → 區間 RS */
  const utilityIntervalRsById = useMemo(() => {
    const m = new Map();
    for (const [id, e] of utilityMetrics.byId) {
      if (e.intervalRs != null) m.set(id, e.intervalRs);
    }
    return m;
  }, [utilityMetrics]);

  const utilityRsColumnTitle = utilityMetrics.state.active
    ? `區間 RS：以大盤距 200 日高點的 ${utilityMetrics.windowDays} 個交易日為窗口，` +
      `用與 RS 相同的權重重算後做全市場百分位（四段各 ${utilityMetrics.segmentDays} 日，最近一段權重 ×2）`
    : undefined;

  // ── Step 1：預先計算每檔 RS 變化 + 自選天數漲跌幅
  const enriched = useMemo(() => {
    const deltaFilters = {
      deltaShortDays: deltaShortDaysResolved,
      deltaLongDays:  deltaLongDaysResolved,
      pctShortDays:   pctShortDaysResolved,
      pctLongDays:    pctLongDaysResolved,
    };
    return stocks.map((s) => enrichIbdRsRow(s, deltaFilters));
  }, [stocks, deltaShortDaysResolved, deltaLongDaysResolved, pctShortDaysResolved, pctLongDaysResolved]);

  // ── Step 2：依全體 RS 排序（有「顯示用 RS」的在前；含僅歷史有值者）
  const globalSorted = useMemo(() => {
    const withRs = enriched
      .filter((s) => getEffectiveDisplayRs(s) != null)
      .sort((a, b) => getEffectiveDisplayRs(b) - getEffectiveDisplayRs(a));
    const noRs = enriched.filter((s) => getEffectiveDisplayRs(s) == null);
    return [...withRs, ...noRs];
  }, [enriched]);

  /**
   * 先通過其餘條件後才需抓 VCP 的候選檔。
   * deps 不含 vcpMin／vcpMax：只調整 VCP 上下限時不重算、不重抓 Yahoo。
   */
  const stocksNeedingVcpFetch = useMemo(() => {
    if (!vcpFilterActive) return [];
    return globalSorted.filter((s) => stockPassesNonVcpFilters(s, filters));
  }, [
    globalSorted,
    vcpFilterActive,
    filters.rsMin,
    filters.rsMax,
    filters.deltaShortDays,
    filters.deltaLongDays,
    filters.delta5dMin,
    filters.delta5dMax,
    filters.delta20dMin,
    filters.delta20dMax,
    filters.pct5dMin,
    filters.pct5dMax,
    filters.pct20dMin,
    filters.pct20dMax,
    filters.hlMin,
    filters.hlMax,
    filters.crossDays,
    filters.crossLevel,
    filters.weeksNewHigh,
    filters.priceAboveMA10,
    filters.priceAboveMA20,
    filters.priceAboveMA60,
    filters.query,
  ]);

  useEffect(() => {
    vcpFetchGenRef.current += 1;
    const myGen = vcpFetchGenRef.current;

    if (!vcpFilterActive) {
      setVcpById(new Map());
      setVcpLoading(false);
      return;
    }

    if (stocksNeedingVcpFetch.length === 0) {
      setVcpById(new Map());
      setVcpLoading(false);
      return;
    }

    setVcpLoading(true);

    const quoteEnd = getTaiwanYmd();
    const quoteStartBuf = new Date();
    quoteStartBuf.setDate(quoteStartBuf.getDate() - 120);
    const quoteStart = quoteStartBuf.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

    const list = stocksNeedingVcpFetch.slice();
    const map = new Map();
    const BATCH_UI = 14;
    const CONCURRENCY = 4;
    let cancelled = false;

    // 先同步填入已有 vcpScore 的股票
    const needsAsync = [];
    for (const s of list) {
      if (s.vcpScore != null && Number.isFinite(s.vcpScore)) {
        map.set(s.id, s.vcpScore);
      } else {
        needsAsync.push(s);
      }
    }

    // 全部都有 DB 資料，直接結束
    if (needsAsync.length === 0) {
      setVcpById(new Map(map));
      setVcpLoading(false);
      return;
    }

    // 先把已有的顯示出來，再繼續非同步補剩下的
    setVcpById(new Map(map));

    const pumpUi = () => {
      if (cancelled || vcpFetchGenRef.current !== myGen) return;
      setVcpById(new Map(map));
    };

    const runOne = async (s) => {
      try {
        const storedHM = s.highMap && typeof s.highMap === 'object' ? s.highMap : null;
        const storedLM = s.lowMap && typeof s.lowMap === 'object' ? s.lowMap : null;
        const storedVM = s.volumeMap && typeof s.volumeMap === 'object' ? s.volumeMap : null;
        let highMap, lowMap, volumeMap;
        if (storedHM && storedLM && Object.keys(storedHM).length >= 20) {
          highMap = storedHM;
          lowMap = storedLM;
          volumeMap = storedVM || {};
        } else {
          ({ highMap, lowMap, volumeMap } = await fetchYahooHistoricalPriceVolumeMaps(s.id, quoteStart, quoteEnd, {
            market: s.market,
          }));
        }
        const pr = calcVcpPriceRatioFromHighLowMaps(highMap || {}, lowMap || {}, quoteEnd);
        const vr = calcVcpVolumeRatioFromVolumeMap(volumeMap || {}, quoteEnd);
        return calcCompositeVcp(pr, vr);
      } catch {
        return null;
      }
    };

    void (async () => {
      let index = 0;
      const worker = async () => {
        while (true) {
          if (cancelled || vcpFetchGenRef.current !== myGen) return;
          const i = index++;
          if (i >= needsAsync.length) return;
          const s = needsAsync[i];
          const comp = await runOne(s);
          if (cancelled || vcpFetchGenRef.current !== myGen) return;
          map.set(s.id, comp);
          const sz = map.size;
          if (sz % BATCH_UI === 0 || sz === list.length) pumpUi();
        }
      };

      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

      if (!cancelled && vcpFetchGenRef.current === myGen) {
        setVcpById(new Map(map));
        setVcpLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [stocksNeedingVcpFetch, vcpFilterActive]);

  // ── Step 3：套用篩選
  const filtered = useMemo(() => {
    const n = (v) => {
      if (v === '' || v == null) return null;
      const x = parseFloat(String(v).trim());
      return Number.isFinite(x) ? x : null;
    };
    const vcpLo = n(filters.vcpMin);
    const vcpHi = n(filters.vcpMax);
    const vcpBoundsActive = vcpFilterActive && !vcpLoading;

    const base = globalSorted.filter((s) => {
      if (utilityActive && !utilityResult.passIds.has(s.id)) return false;
      if (!stockPassesNonVcpFilters(s, filters)) return false;
      if (vcpBoundsActive) {
        const comp = vcpById.get(s.id);
        if (comp == null || !Number.isFinite(comp)) return false;
        if (vcpLo != null && comp < vcpLo) return false;
        if (vcpHi != null && comp > vcpHi) return false;
      }
      return true;
    });

    // Utility Screen 生效時改以「區間 RS」由高到低排序：此模式下要看的是修正期間的相對強度
    if (utilityActive) {
      return [...base].sort((a, b) => {
        const ra = utilityMetrics.byId.get(a.id)?.intervalRs ?? -1;
        const rb = utilityMetrics.byId.get(b.id)?.intervalRs ?? -1;
        return rb - ra;
      });
    }
    return base;
  }, [
    globalSorted,
    filters,
    vcpById,
    vcpLoading,
    vcpFilterActive,
    utilityActive,
    utilityResult,
    utilityMetrics,
  ]);

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
  /** 篩選後筆數變少時，page state 可能大於最後一頁 → 用 safePage 切 slice 與翻頁 */
  const safePage = pageCount > 0 ? Math.min(page, pageCount - 1) : 0;
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const parallelChunksToShow = useMemo(() => {
    // 垂直連號：第1欄 1-25、第2欄 26-50、第3欄 51-75、第4欄 76-100
    const chunks = splitIntoColumnChunks(visible, IBDRS_PARALLEL_GROUPS, 'vertical');
    return chunks.filter((c) => c.length > 0);
  }, [visible]);

  const watchlistStocks = useMemo(() => {
    if (!rsWatchlistIdSet || rsWatchlistIdSet.size === 0) return [];
    return globalSorted
      .filter((s) => rsWatchlistIdSet.has(s.id))
      .sort((a, b) => {
        const pa = rsWatchlistPriorities[String(a.id)] ?? 99;
        const pb = rsWatchlistPriorities[String(b.id)] ?? 99;
        return pa - pb;
      });
  }, [globalSorted, rsWatchlistIdSet, rsWatchlistPriorities]);

  /** 觀察清單中評分（分類）為 1 星的股票 */
  const watchlistStar1Stocks = useMemo(
    () => watchlistStocks.filter((s) => (rsWatchlistPriorities[String(s.id)] ?? null) === 1),
    [watchlistStocks, rsWatchlistPriorities]
  );

  const hasActiveFilter = Object.entries(filters).some(([k, v]) => v !== '' && v !== DEFAULT_FILTERS[k]);

  const deltaShortTitle = `今日 RS 減去 ${deltaShortDaysResolved} 個交易日前之 RS（ibdRsHistory 筆數；需足夠歷史）`;
  const deltaLongTitle = `今日 RS 減去 ${deltaLongDaysResolved} 個交易日前之 RS（ibdRsHistory 筆數；需足夠歷史）`;

  const filterSummaryParts = useMemo(
    () =>
      hasActiveFilter
        ? summarizeIbdRsFilters(filters, deltaShortDaysResolved, deltaLongDaysResolved)
        : [],
    [hasActiveFilter, filters, deltaShortDaysResolved, deltaLongDaysResolved]
  );
  const filterSummaryLine = filterSummaryParts.join(', ');

  /** 基準日已同步：單日 |ΔRS| &gt; 5 且 顯示 RS &gt; 80 */
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

  /** 基準日已同步：近 1 交易日股價漲跌幅絕對值 &gt; 門檻 且 RS &gt; IBDRS_FOCUS_PRICE_RS_GT（與 Firestore pricePct1d 同源） */
  const priceBigMoveHighRsToday = useMemo(() => {
    if (!focusPanelRefYmd) return [];
    const out = [];
    const th = IBDRS_FOCUS_PRICE_PCT_ABS_GT;
    for (const s of enriched) {
      const sRef = normalizeYmdToTaiwanTradingDay(String(s.ibdRsUpdatedDate || '').trim().slice(0, 10));
      if (sRef !== focusPanelRefYmd) continue;
      const pct = s.pricePct1d;
      if (pct == null || !Number.isFinite(pct)) continue;
      if (Math.abs(pct) <= th) continue;
      const effRs = getEffectiveDisplayRs(s);
      if (effRs == null || effRs <= IBDRS_FOCUS_PRICE_RS_GT) continue;
      out.push(s);
    }
    out.sort((a, b) => {
      const pa = a.pricePct1d ?? 0;
      const pb = b.pricePct1d ?? 0;
      const aPos = pa >= 0;
      const bPos = pb >= 0;
      if (aPos !== bPos) return aPos ? -1 : 1; // 正的（漲）排上面
      return Math.abs(pb) - Math.abs(pa); // 同號：按 |%| 大小
    });
    return out;
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

  /** 首頁卡片篩選母體：永遠以全市場 filtered 結果為準 */
  const filteredIdSet = useMemo(() => new Set(filtered.map((s) => s.id)), [filtered]);

  const homeSections = useMemo(() => {
    const sections = [
      {
        key: 'watchlist',
        title: 'Universe',
        subtitle: '選股母體',
        items: watchlistStocks.filter((s) => filteredIdSet.has(s.id)),
        totalCount: watchlistStocks.filter((s) => filteredIdSet.has(s.id)).length,
        emptyText: 'Universe 目前沒有股票',
      },
      {
        key: 'watchlistStar1',
        title: '觀察清單',
        subtitle: '',
        items: watchlistStar1Stocks.filter((s) => filteredIdSet.has(s.id)),
        totalCount: watchlistStar1Stocks.filter((s) => filteredIdSet.has(s.id)).length,
        emptyText: '觀察清單目前沒有股票',
      },
      {
        key: 'hlHigh',
        title: `HL（6M）> ${IBDRS_MODAL_HL_GT} 且 RS > ${IBDRS_MODAL_HL_RS_GT}`,
        subtitle: '',
        items: hlHighList.filter((s) => filteredIdSet.has(s.id)),
        totalCount: hlHighList.filter((s) => filteredIdSet.has(s.id)).length,
      },
      {
        key: 'priceBigMove',
        title: `當日漲跌停 且 RS > ${IBDRS_FOCUS_PRICE_RS_GT}`,
        subtitle: '',
        items: priceBigMoveHighRsToday.filter((s) => filteredIdSet.has(s.id)),
        totalCount: priceBigMoveHighRsToday.filter((s) => filteredIdSet.has(s.id)).length,
      },
      {
        key: 'break80',
        title: `向上突破 ${IBDRS_RS_BREAK_LEVEL_80}`,
        subtitle: '由下往上穿越',
        items: rsBreakthrough80Today.filter((s) => filteredIdSet.has(s.id)),
        totalCount: rsBreakthrough80Today.filter((s) => filteredIdSet.has(s.id)).length,
      },
      {
        key: 'break90',
        title: `向上突破 ${IBDRS_RS_BREAK_LEVEL_90}`,
        subtitle: '由下往上穿越',
        items: rsBreakthrough90Today.filter((s) => filteredIdSet.has(s.id)),
        totalCount: rsBreakthrough90Today.filter((s) => filteredIdSet.has(s.id)).length,
      },
    ];
    // 手機版：把「觀察清單」（評分 1）移到最上面
    if (isMobileLayout) {
      const idx = sections.findIndex((s) => s.key === 'watchlistStar1');
      if (idx > 0) sections.unshift(sections.splice(idx, 1)[0]);
    }
    return sections;
  },
    [
      filteredIdSet,
      watchlistStocks,
      watchlistStar1Stocks,
      priceBigMoveHighRsToday,
      rsBreakthrough80Today,
      rsBreakthrough90Today,
      hlHighList,
      isMobileLayout,
    ]
  );

  /** 訂閱 Firestore 首頁首次出現日（跨裝置一致） */
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const unsub = onSnapshot(
      IBD_RS_HOME_FIRST_SEEN_DOC_REF,
      (snap) => {
        const raw = snap.exists() ? snap.data()?.byId : null;
        setHomeFirstSeenById(raw && typeof raw === 'object' ? { ...raw } : {});
      },
      (err) => console.warn('[RS homeFirstSeen] snapshot', err),
    );
    return () => unsub();
  }, []);

  /** 依目前首頁清單合併／寫回 byId，並清舊版 localStorage 一次性匯入 */
  useEffect(() => {
    if (!todayYmd || !Array.isArray(homeSections) || homeSections.length === 0) return;
    const unionIds = new Set();
    for (const sec of homeSections) {
      for (const s of sec.items) {
        const id = String(s.id || '').trim();
        if (id) unionIds.add(id);
      }
    }
    void (async () => {
      try {
        const snap = await getDoc(IBD_RS_HOME_FIRST_SEEN_DOC_REF);
        let byId = snap.exists() && snap.data()?.byId && typeof snap.data().byId === 'object'
          ? { ...snap.data().byId }
          : {};
        let changed = false;
        if (!homeFirstSeenLocalMigratedRef.current) {
          homeFirstSeenLocalMigratedRef.current = true;
          const local = loadHomeFirstSeenMap();
          for (const [id, ymd] of Object.entries(local)) {
            if (!byId[id] && typeof ymd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
              byId[id] = ymd;
              changed = true;
            }
          }
          try {
            window.localStorage.removeItem(IBDRS_HOME_FIRST_SEEN_MAP_KEY);
          } catch (_) {}
        }
        for (const id of Object.keys(byId)) {
          const ymd = byId[id];
          const diff = dayDiffYmd(ymd, todayYmd);
          if (diff == null || diff < 0 || diff > IBDRS_HOME_FIRST_SEEN_KEEP_DAYS) {
            delete byId[id];
            changed = true;
          }
        }
        for (const id of unionIds) {
          if (!byId[id]) {
            byId[id] = todayYmd;
            changed = true;
          }
        }
        if (changed) {
          await setDoc(IBD_RS_HOME_FIRST_SEEN_DOC_REF, { byId }, { merge: true });
        }
      } catch (e) {
        console.warn('[RS homeFirstSeen] merge', e);
      }
    })();
  }, [todayYmd, homeSections]);

  /** 由 Firestore byId 計算各區塊藍點 */
  useEffect(() => {
    if (!todayYmd || !Array.isArray(homeSections) || homeSections.length === 0) return;
    const nextNewMap = new Map();
    for (const sec of homeSections) {
      const dotSet = new Set();
      for (const s of sec.items) {
        const id = String(s.id || '').trim();
        if (!id) continue;
        const ymd = homeFirstSeenById[id];
        if (!ymd) continue;
        const diff = dayDiffYmd(ymd, todayYmd);
        if (diff != null && diff >= 0 && diff < IBDRS_HOME_DOT_DAYS) {
          dotSet.add(id);
        }
      }
      nextNewMap.set(sec.key, dotSet);
    }
    setHomeSectionNewMap(nextNewMap);
  }, [todayYmd, homeSections, homeFirstSeenById]);

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
    void syncRs({
      forceRefresh,
      concurrency: 4,
      delayMs: 800,
      superBatchSize: 300,
      interBatchRestMs: 45_000,
    });
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

  const handleQuickPatchClick = useCallback(() => {
    if (
      window.confirm(
        '【快速補點（漏同步日）】\n\n' +
          '· 用 Firestore 現有 priceMap 補算近 10 個交易日內的缺漏 RS 點。\n' +
          '· 不打 Yahoo API，通常 1～3 分鐘內完成。\n' +
          '· 已有的日期不覆蓋，只補缺漏。\n' +
          '· 需先執行過今日 RS 同步（priceMap 才有資料）。\n\n' +
          '確定執行？'
      )
    ) {
      startIbdRsQuickPatch({ daysBack: 10 });
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
    border: '1px solid var(--app-border)',
    verticalAlign: 'middle',
    height: 22,
    boxSizing: 'border-box',
    fontSize: 11.5,
  };

  const thBase = {
    padding: '4px 5px',
    border: '1px solid var(--app-border)',
    textAlign: 'center',
    background: 'var(--app-th-bg)',
    color: 'var(--app-text)',
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

  const showStatsRow = mounted && stocks.length > 0;
  const handleHomeCardMeasure = useCallback((secKey, height) => {
    if (isMobileLayout) return;
    if (secKey !== 'hlHigh') return;
    if (!Number.isFinite(height) || height <= 0) return;
    setHomeCardUniformHeight((prev) => (prev === height ? prev : height));
  }, [isMobileLayout]);

  return (
    <Layout title="IBD RS Ranking">
      <main className="ibd-rs-ranking-main" style={{ padding: '8px 0 12px', minWidth: 0 }}>
        <div className="ibd-rs-ranking-page-inner" style={{ padding: '0 10px', minWidth: 0 }}>
          {/* ── 頂欄 ─────────────────────────────────────────────────────────── */}
          <div style={{ marginBottom: 8 }}>
            <div
              className="ibd-rs-ranking-topbar-row"
              style={{
                width: '100%',
                alignItems: isMobileLayout ? 'stretch' : 'center',
                flexDirection: isMobileLayout ? 'column' : 'row',
                gap: isMobileLayout ? 6 : undefined,
              }}
            >
              <div style={{ display: 'flex', minWidth: 0 }}>
                <div className="ibd-rs-ranking-topbar-title-cell">
                  <h2 style={{ margin: 0, fontSize: '1.15rem', lineHeight: 1.2 }}>IBD RS Ranking</h2>
                  <div
                    style={{
                      display: 'inline-flex',
                      border: '1px solid var(--app-border)',
                      borderRadius: 8,
                      overflow: 'hidden',
                    }}
                  >
                    {[
                      { key: 'home', label: '首頁總覽' },
                      { key: 'table', label: '完整排行' },
                    ].map((tab) => {
                      const active = activeView === tab.key;
                      return (
                        <button
                          key={tab.key}
                          type="button"
                          onClick={() => {
                            setActiveView(tab.key);
                            if (tab.key === 'table') setPage(0);
                          }}
                          style={{
                            border: 0,
                            padding: '5px 10px',
                            fontSize: 12,
                            fontWeight: 800,
                            cursor: 'pointer',
                            background: active ? '#0f766e' : 'var(--app-surface)',
                            color: active ? '#fff' : 'var(--app-text-soft)',
                          transition: 'background-color 160ms ease, color 160ms ease, box-shadow 160ms ease',
                          boxShadow: active ? 'inset 0 0 0 1px rgba(15,118,110,0.2)' : 'none',
                          }}
                        >
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>
                  {showStatsRow && (
                    <div className="ibd-rs-ranking-topbar-stats" style={{ marginTop: 0 }}>
                      {isMobileLayout ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--app-text-soft)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            lineHeight: 1.35,
                          }}
                        >
                          資料日期 {displaySyncDate || '—'}
                        </div>
                      ) : (
                        <>
                          <span className="ibd-rs-stats-row-today">
                            <span style={{ color: updatedTodayCount === stocks.length ? '#1e7e34' : 'var(--app-text-soft)' }}>
                              今日 <strong>{updatedTodayCount}</strong>/{stocks.length}
                            </span>
                          </span>
                          <span className="ibd-rs-stats-sep ibd-rs-stats-sep-after-today" style={{ color: '#bbb', margin: '0 6px' }}>
                            |
                          </span>
                          <span className="ibd-rs-stats-row-second">
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
                            {displaySyncDate && (
                              <>
                                <span className="ibd-rs-stats-sep ibd-rs-stats-sep-before-sync" style={{ color: '#bbb', margin: '0 6px' }}>
                                  |
                                </span>
                                資料日期 {displaySyncDate}
                              </>
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="ibd-rs-ranking-topbar-filter-summary">
                {hasActiveFilter && (
                  <>
                    <div
                      title={filterSummaryLine || '（篩選中）'}
                      style={{
                        fontSize: 11,
                        color: '#444',
                        lineHeight: 1.35,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        wordBreak: 'break-word',
                        width: '100%',
                      }}
                    >
                      {filterSummaryLine || '（篩選中）'}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#c0392b',
                        marginTop: 2,
                        whiteSpace: 'nowrap',
                        lineHeight: 1.2,
                      }}
                    >
                      {filtered.length} 檔
                    </div>
                  </>
                )}
              </div>
              <div
                className="ibd-rs-ranking-topbar-actions"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: isMobileLayout ? '100%' : undefined,
                  justifyContent: isMobileLayout ? 'flex-start' : undefined,
                }}
              >
                <div
                  className="ibd-rs-ranking-topbar-actions-inner"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: isMobileLayout ? '100%' : undefined,
                    justifyContent: isMobileLayout ? 'space-between' : undefined,
                  }}
                >
                  {activeView === 'table' && pageCount > 1 && (
                    <div className="ibd-rs-topbar-pager-wrap">
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
                            border: '1px solid var(--app-border)',
                            borderRadius: 4,
                            background: 'var(--app-surface)',
                            cursor: disabled ? 'default' : 'pointer',
                            opacity: disabled ? 0.4 : 1,
                            fontSize: 12,
                          }}
                        >
                          {label}
                        </button>
                      ))}

                      <span style={{ fontSize: 12, color: '#666', margin: '0 4px', whiteSpace: 'nowrap' }}>
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
                            border: '1px solid var(--app-border)',
                            borderRadius: 4,
                            background: 'var(--app-surface)',
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
                      flex: '0 1 auto',
                      minWidth: 96,
                      padding: '4px 8px',
                      border: '1px solid var(--app-border)',
                      borderRadius: 6,
                      fontSize: 12,
                      lineHeight: 1.25,
                      width: isMobileLayout ? 'min(100%, 280px)' : 200,
                      maxWidth: 220,
                      minHeight: 28,
                      boxSizing: 'border-box',
                      background: 'var(--ifm-background-color, #fff)',
                      color: 'var(--ifm-font-color-base)',
                    }}
                  />
                </div>
              </div>

            </div>
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
            className="ibd-rs-filter-fab"
            onClick={() => setFilterOpen(true)}
            style={{
              position: 'fixed',
              right: 16,
              bottom: 16,
              zIndex: 10000,
              padding: '14px 20px',
              borderRadius: 999,
              border: hasActiveFilter ? '2px solid #c0392b' : '1px solid var(--app-border)',
              background: hasActiveFilter ? '#fff5f5' : 'var(--app-surface)',
              color: hasActiveFilter ? '#c0392b' : 'var(--app-text)',
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
              className="ibd-rs-filter-dialog-backdrop"
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
                className="ibd-rs-filter-dialog-panel"
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  width: '100%',
                  maxWidth: 800,
                  background: 'var(--ifm-background-surface-color, var(--app-surface))',
                  border: '1px solid var(--app-border)',
                  borderRadius: 12,
                  boxShadow: '0 24px 56px rgba(0,0,0,0.22)',
                  padding: '14px 16px 16px',
                  maxHeight: '92vh',
                  overflowY: 'auto',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 12,
                    paddingBottom: 10,
                    borderBottom: '1px solid var(--app-border)',
                    flexWrap: 'wrap',
                    position: 'sticky',
                    top: -14,
                    zIndex: 1,
                    background: 'var(--ifm-background-surface-color, var(--app-surface))',
                  }}
                >
                  <strong style={{ fontSize: 15, fontWeight: 800, color: 'var(--app-accent-strong)', letterSpacing: '-0.02em' }}>篩選條件</strong>
                  {/* 一律 render、只切換可見性：條件式 render 會讓標題列高度變動，整個面板跟著跳 */}
                  <button
                    type="button"
                    onClick={resetFilters}
                    tabIndex={hasActiveFilter ? 0 : -1}
                    aria-hidden={!hasActiveFilter}
                    style={{
                      fontSize: 11,
                      padding: '5px 10px',
                      border: '1px solid var(--app-border)',
                      borderRadius: 8,
                      background: 'var(--app-surface)',
                      cursor: 'pointer',
                      color: 'var(--app-text-soft)',
                      fontWeight: 700,
                      visibility: hasActiveFilter ? 'visible' : 'hidden',
                      pointerEvents: hasActiveFilter ? 'auto' : 'none',
                    }}
                  >
                    清除全部
                  </button>
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--app-text-soft)' }}>
                    符合{' '}
                    <strong style={{ color: filteredWithRsCount > 0 ? '#e05a4b' : 'var(--app-text-soft)', fontSize: 14 }}>{filteredWithRsCount}</strong> / {totalWithRs}
                    <span style={{ color: 'var(--app-text-soft)', fontSize: 11 }}>（有 RS）</span>
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
                      border: '1px solid var(--app-border)',
                      borderRadius: 8,
                      background: 'var(--app-surface)',
                      cursor: 'pointer',
                      color: 'var(--app-text-soft)',
                      fontWeight: 400,
                    }}
                  >
                    ×
                  </button>
                </div>

                <div
                  className="ibd-rs-filter-fields-grid"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                    gap: 10,
                    alignItems: 'stretch',
                  }}
                >
                  <FilterCard title="RS 與變化（Δ）">
                  <FilterSandwichBetween
                    centerLabel="RS"
                    upperValue={filters.rsMax}
                    lowerValue={filters.rsMin}
                    onUpperChange={setFilter('rsMax')}
                    onLowerChange={setFilter('rsMin')}
                  />
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
                    upperValue={filters.delta5dMax}
                    lowerValue={filters.delta5dMin}
                    onUpperChange={setFilter('delta5dMax')}
                    onLowerChange={setFilter('delta5dMin')}
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
                    upperValue={filters.delta20dMax}
                    lowerValue={filters.delta20dMin}
                    onUpperChange={setFilter('delta20dMax')}
                    onLowerChange={setFilter('delta20dMin')}
                  />
                  </FilterCard>

                  <FilterCard title="漲跌幅（%）與 HL（6M 區間價位）">
                  <FilterSandwichBetween
                    centerAriaName={`漲跌幅·${pctShortDaysResolved}日`}
                    centerSlot={
                      <>
                        <input
                          {...FILTER_INPUT_MARK}
                          className="ibd-rs-filter-input"
                          type="number"
                          min={1}
                          max={365}
                          step={1}
                          value={filters.pctShortDays}
                          onChange={(e) => setFilter('pctShortDays')(e.target.value)}
                          style={FILTER_DELTA_DAYS_INPUT}
                          aria-label="漲跌幅：短區間交易日數"
                        />
                        <span style={FILTER_DELTA_MID_TEXT_STYLE}>日</span>
                      </>
                    }
                    upperValue={filters.pct5dMax}
                    lowerValue={filters.pct5dMin}
                    onUpperChange={setFilter('pct5dMax')}
                    onLowerChange={setFilter('pct5dMin')}
                  />
                  <FilterSandwichBetween
                    centerAriaName={`漲跌幅·${pctLongDaysResolved}日`}
                    centerSlot={
                      <>
                        <input
                          {...FILTER_INPUT_MARK}
                          className="ibd-rs-filter-input"
                          type="number"
                          min={1}
                          max={365}
                          step={1}
                          value={filters.pctLongDays}
                          onChange={(e) => setFilter('pctLongDays')(e.target.value)}
                          style={FILTER_DELTA_DAYS_INPUT}
                          aria-label="漲跌幅：長區間交易日數"
                        />
                        <span style={FILTER_DELTA_MID_TEXT_STYLE}>日</span>
                      </>
                    }
                    upperValue={filters.pct20dMax}
                    lowerValue={filters.pct20dMin}
                    onUpperChange={setFilter('pct20dMax')}
                    onLowerChange={setFilter('pct20dMin')}
                  />
                  <FilterSandwichBetween
                    centerLabel="HL"
                    upperValue={filters.hlMax}
                    lowerValue={filters.hlMin}
                    onUpperChange={setFilter('hlMax')}
                    onLowerChange={setFilter('hlMin')}
                    upperPlaceholder="上限 例 0.8"
                    lowerPlaceholder="下限 例 0.3"
                  />
                  </FilterCard>

                  <FilterCard title="型態（ibdRsHistory）與 VCP" wide>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                      gap: '8px 20px',
                    }}
                  >
                  <div style={FILTER_ROW_STYLE}>
                    <span style={FILTER_ROW_LABEL_STYLE}>向上突破</span>
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
                  <div style={FILTER_ROW_STYLE}>
                    <span style={FILTER_ROW_LABEL_STYLE}>區間新高</span>
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

                  <div style={FILTER_ROW_STYLE}>
                    <span style={FILTER_ROW_LABEL_STYLE}>價格站上均線</span>
                    {[
                      { key: 'priceAboveMA10', label: 'MA10' },
                      { key: 'priceAboveMA20', label: 'MA20' },
                      { key: 'priceAboveMA60', label: 'MA60' },
                    ].map(({ key, label }) => (
                      <label
                        key={key}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}
                      >
                        <input
                          type="checkbox"
                          checked={filters[key] === '1'}
                          onChange={(e) => setFilter(key)(e.target.checked ? '1' : '')}
                          style={{ cursor: 'pointer' }}
                        />
                        {label}
                      </label>
                    ))}
                  </div>

                  <FilterSandwichBetween
                    centerLabel="VCP"
                    upperValue={filters.vcpMax}
                    lowerValue={filters.vcpMin}
                    onUpperChange={setFilter('vcpMax')}
                    onLowerChange={setFilter('vcpMin')}
                    upperPlaceholder="上限 例 0.85"
                    lowerPlaceholder="下限 例 0.25"
                  />
                  </div>
                  </FilterCard>

                  <FilterCard title="Utility Screen（大盤修正期領先股）" wide>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label
                      style={{
                        // 父層是 flex column：不設 alignSelf 會被 stretch 成整張卡片寬，
                        // 導致點空白處也會切換勾選。
                        alignSelf: 'flex-start',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        cursor: utilityMetrics.state.active ? 'pointer' : 'not-allowed',
                        userSelect: 'none',
                        fontSize: 12,
                        fontWeight: 700,
                        color: utilityMetrics.state.active
                          ? 'var(--app-accent-strong)'
                          : 'var(--app-text-soft)',
                      }}
                    >
                      <input
                        type="checkbox"
                        disabled={!utilityMetrics.state.active}
                        checked={filters.utilityOn === '1'}
                        onChange={(e) => setFilter('utilityOn')(e.target.checked ? '1' : '')}
                        style={{ cursor: utilityMetrics.state.active ? 'pointer' : 'not-allowed' }}
                      />
                      {utilityMetrics.state.active
                        ? `套用（區間 RS ＝ ${utilityMetrics.windowDays} 交易日）`
                        : `無法啟用（${utilityStatus.badge}）`}
                    </label>

                    <div
                      title={utilityStatus.detail}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        alignItems: 'baseline',
                        gap: '2px 10px',
                        fontSize: 11,
                        color: 'var(--app-text-soft)',
                      }}
                    >
                      <span>加權指數</span>
                      {utilityStatus.stats.map((s) => (
                        <span key={s.label}>
                          {s.label}{' '}
                          <strong style={{ color: 'var(--app-text)', fontVariantNumeric: 'tabular-nums' }}>
                            {s.value}
                          </strong>
                        </span>
                      ))}
                      {utilityStatus.note ? <span>{utilityStatus.note}</span> : null}
                    </div>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                        gap: '7px 24px',
                        marginTop: 2,
                        opacity: filters.utilityOn === '1' ? 1 : 0.62,
                      }}
                    >
                      <FilterParamRow label="區間 RS ≥">
                        <input
                          style={FILTER_PARAM_INPUT}
                          value={filters.utilityRsMin}
                          onChange={(e) => setFilter('utilityRsMin')(e.target.value)}
                          inputMode="numeric"
                          {...FILTER_INPUT_MARK}
                        />
                      </FilterParamRow>

                      <FilterParamRow
                        label="距 200 日高點 <"
                        unit="%"
                        title="以收盤價計算（Firestore 的 highMap 僅保留 120 天，不足 200）"
                      >
                        <input
                          style={FILTER_PARAM_INPUT}
                          value={filters.utilityMaxPctFromHigh}
                          onChange={(e) => setFilter('utilityMaxPctFromHigh')(e.target.value)}
                          inputMode="decimal"
                          {...FILTER_INPUT_MARK}
                        />
                      </FilterParamRow>

                      <FilterParamRow label="平均成交額 >" unit="億" title="填 0 ＝ 不篩此條件">
                        <input
                          style={FILTER_PARAM_INPUT}
                          value={filters.utilityTurnoverMin}
                          onChange={(e) => setFilter('utilityTurnoverMin')(e.target.value)}
                          inputMode="decimal"
                          {...FILTER_INPUT_MARK}
                        />
                      </FilterParamRow>

                      <FilterParamRow label="成交額取樣" unit="日">
                        <input
                          style={FILTER_PARAM_INPUT}
                          value={filters.utilityTurnoverDays}
                          onChange={(e) => setFilter('utilityTurnoverDays')(e.target.value)}
                          inputMode="numeric"
                          {...FILTER_INPUT_MARK}
                        />
                      </FilterParamRow>

                      <FilterParamRow label="收盤 > MA200">
                        <input
                          type="checkbox"
                          checked={filters.utilityReqMa200 === '1'}
                          onChange={(e) => setFilter('utilityReqMa200')(e.target.checked ? '1' : '')}
                          style={{ cursor: 'pointer', margin: 0 }}
                        />
                      </FilterParamRow>

                      <FilterParamRow label="MA50 > MA200">
                        <input
                          type="checkbox"
                          checked={filters.utilityReqMaStack === '1'}
                          onChange={(e) => setFilter('utilityReqMaStack')(e.target.checked ? '1' : '')}
                          style={{ cursor: 'pointer', margin: 0 }}
                        />
                      </FilterParamRow>
                    </div>

                    {/* 這行一律 render（未套用時顯示提示），否則勾選當下多一行、整個面板高度會跳 */}
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--app-text-soft)',
                        marginTop: 2,
                        height: 16,
                        lineHeight: '16px',
                        overflow: 'hidden',
                      }}
                    >
                      {utilityActive ? (
                        <>
                          母體 {utilityMetrics.rankedCount} 檔 · 通過{' '}
                          <strong style={{ color: 'var(--app-text)' }}>{utilityResult.passIds.size}</strong> 檔 · 主表改依區間 RS 排序
                        </>
                      ) : (
                        '勾選後主表改依區間 RS 由高到低排序'
                      )}
                    </div>
                  </div>
                  </FilterCard>
                </div>
              </div>
            </div>
          )}

          {/* ── 首頁區塊 / 第二頁完整排行 ─────────────────────────────────────── */}
          <div style={{ marginBottom: 8 }}>
            {activeView === 'table' && vcpFilterActive && vcpLoading && stocksNeedingVcpFetch.length > 0 && (
              <div
                style={{
                  marginBottom: 8,
                  padding: '8px 12px',
                  background: '#fffbeb',
                  border: '1px solid #fcd34d',
                  borderRadius: 8,
                  fontSize: 12,
                  color: '#92400e',
                  lineHeight: 1.45,
                }}
              >
                正載入 VCP（Yahoo）… <strong>{vcpById.size}</strong>／{stocksNeedingVcpFetch.length}
                ；完成後才套用 VCP 上下限（載入中其餘條件仍有效）。
              </div>
            )}
            {activeView === 'home' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: isMobileLayout
                    ? 'minmax(0, 1fr)'
                    : 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
                  gap: 8,
                  alignItems: 'start',
                }}
              >
                {homeSections.map((sec) => (
                  <HomeStockSectionCard
                    key={sec.key}
                    section={sec}
                    newIdSet={homeSectionNewMap.get(sec.key)}
                    uniformHeight={isMobileLayout ? null : homeCardUniformHeight}
                    mobileLayout={isMobileLayout}
                    onMeasure={handleHomeCardMeasure}
                    pctShortDays={pctShortDaysResolved}
                    pctLongDays={pctLongDaysResolved}
                    onPickStock={(s) => {
                      setChartNavOverride({
                        list: sec.items,
                      });
                      setSelectedStock(s);
                    }}
                    onDownload={sec.key === 'watchlist' || sec.key === 'watchlistStar1' ? downloadWatchlistJson : undefined}
                  />
                ))}
              </div>
            ) : loading && stocks.length === 0 ? (
              <div style={{ padding: 36, textAlign: 'center', color: '#888', fontSize: 13 }}>載入中...</div>
            ) : visible.length === 0 ? (
              <div
                style={{
                  padding: 32,
                  textAlign: 'center',
                  color: '#888',
                  background: 'var(--app-surface)',
                  border: '1px solid var(--app-border)',
                  borderRadius: 6,
                }}
              >
                無符合條件的股票
              </div>
            ) : (
              <div
                className="ibd-rs-ranking-table-scroll"
                role="region"
                aria-label="RS 排名表（每頁 4 大欄）"
              >
                <div
                  className="ibd-rs-ranking-parallel-tables"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${parallelChunksToShow.length}, ${
                      utilityActive ? IBDRS_QUADRANT_TABLE_WIDTH_WITH_UTIL_RS_PX : IBDRS_QUADRANT_TABLE_WIDTH_PX
                    }px)`,
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
                      showUtilityRsColumn={utilityActive}
                      utilRsById={utilityIntervalRsById}
                      utilRsTitle={utilityRsColumnTitle}
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
              borderTop: '1px solid var(--app-border)',
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
                <strong>ΔN（兩欄）</strong>：今日 RS 減去 N 個<strong>交易日</strong>前之 RS（以 <code>ibdRsHistory</code> 筆數計，需足夠歷史）。篩選器可自訂兩欄 N（預設 5／20）。
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
              borderTop: '1px solid var(--app-border)',
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
                style={{ ...btnBase, background: 'var(--app-surface)', color: '#7c3aed', border: '1px solid #7c3aed', fontWeight: 800 }}
              >
                全市場·回填歷史
              </button>
              <button
                type="button"
                onClick={handleHistoryBackfillFirstWeekClick}
                disabled={loading || syncing}
                title="試跑：清單前 10 檔、最早 7 個交易日；RS 為此 10 檔內排名"
                style={{ ...btnBase, background: 'var(--app-surface)', color: '#9333ea', border: '1px solid #9333ea', fontSize: 11 }}
              >
                試跑·最早一週
              </button>
              <button
                type="button"
                onClick={handlePatchRatingFromHistoryClick}
                disabled={loading || syncing}
                title="僅補 Firestore：有歷史卻缺 ibdRsRating 的檔；不抓價、不重跑全市場同步"
                style={{ ...btnBase, background: 'var(--app-surface)', color: '#0d9488', border: '1px solid #14b8a6', fontSize: 11, fontWeight: 800 }}
              >
                補寫 RS 快照（歷史→頂層）
              </button>
              <button
                type="button"
                onClick={handleQuickPatchClick}
                disabled={loading || syncing}
                title="用 Firestore 現有 priceMap 補算近 10 個交易日缺漏的 RS 點；不打 Yahoo，1~3 分鐘完成"
                style={{ ...btnBase, background: 'var(--app-surface)', color: '#2563eb', border: '1px solid #3b82f6', fontSize: 11, fontWeight: 800 }}
              >
                快速補點（漏同步日）
              </button>
              <button
                type="button"
                onClick={() => void handleRepairAllData()}
                disabled={loading || syncing}
                title="拉上市櫃清單、新增上櫃檔，並批次填補缺失 RS"
                style={{ ...btnBase, background: 'var(--app-surface)', color: '#0d9488', border: '1px solid #0d9488', fontSize: 11 }}
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
                每日例行：頁面下方「同步今日 RS」。若<strong>回填後表上 RS 仍「—」但圖表有線</strong>：按<strong>「補寫 RS 快照」</strong>（不重跑同步）。補齊＝新上櫃／缺檔；試跑＝10 檔×7 日僅測流程。<br />
                <strong>漏同步一兩天</strong>（RS 曲線有斷點）：先跑今日 RS 同步，再按<strong>「快速補點」</strong>即可（用 Firestore priceMap，不打 Yahoo，1～3 分鐘）。超過 10 個交易日缺漏請改用「全市場·回填歷史」。
              </p>
            </div>
          </details>

          {/* ── 底欄：同步／重新載入 ─────────────────────────────────────────── */}
          <div
            className="ibd-rs-ranking-bottom-actions"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
              justifyContent: 'flex-end',
              marginTop: 16,
              paddingTop: 14,
              borderTop: '1px solid var(--app-border)',
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
              style={{ ...btnBase, background: 'var(--app-surface)', color: '#555', border: '1px solid var(--app-border)' }}
            >
              重新載入
            </button>
            {syncing && (
              <button
                type="button"
                onClick={() => stopIbdRsBackgroundTask()}
                title="停止目前正在執行的任務"
                style={{ ...btnBase, background: 'var(--app-surface)', color: '#e74c3c', border: '1px solid #e74c3c' }}
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
          itemsPriceBig={priceBigMoveHighRsToday}
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
                priceBigMoveHighRsToday,
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
          inWatchlist={selectedStock ? rsWatchlistIdSet.has(selectedStock.id) : false}
          onToggleWatchlist={async (st) => {
            await toggleRsWatchlist(st.id);
          }}
          watchlistPriority={selectedStock ? (rsWatchlistPriorities[selectedStock.id] ?? null) : null}
          onSetPriority={async (st, p) => {
            await setRsWatchlistPriority(st.id, p);
          }}
          onClose={() => {
            setSelectedStock(null);
            setChartNavOverride(null);
          }}
        />
      )}
    </Layout>
  );
}
