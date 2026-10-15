/* src/features/StockAnalysis/components/lwcShared.js */

/**
 * 個股視窗兩張 lightweight-charts 圖（股價 IbdRsLwcChart、籌碼 IbdChipLwcChart）共用的設定：
 * 主題色、基本圖表選項、日期刻度、邊距、價格格式。兩張圖的外觀與邊距要一致，改這裡兩邊一起變。
 */

/** 繪圖區距外框的上／左留白；右、下由價格軸（約 48px）與日期軸（28px）撐出 */
export const CHART_INSET_TOP = 4;
export const CHART_INSET_LEFT = 22;

export function readTheme() {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  const dark = root.getAttribute('data-theme') === 'dark';
  return {
    dark,
    text: v('--app-text-soft', dark ? '#b0b4b8' : '#475569'),
    surface: v('--app-surface', dark ? '#242526' : '#ffffff'),
    border: v('--app-border', dark ? '#3a3c3e' : '#e2e8f0'),
    grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)',
    // K 棒用 lightweight-charts 預設色（#ef5350／#26a69a），但維持台股紅漲綠跌；外框、影線同色不另加深
    up: v('--chart-k-up', '#ef5350'),
    down: v('--chart-k-down', '#26a69a'),
    upStroke: v('--chart-k-up', '#ef5350'),
    downStroke: v('--chart-k-down', '#26a69a'),
    volUp: v('--chart-vol-up', 'rgba(239,83,80,0.3)'),
    volDown: v('--chart-vol-down', 'rgba(38,166,154,0.3)'),
    rs: dark ? '#ef5350' : '#c0392b',
    idx: v('--chart-idx', dark ? '#60a5fa' : '#1565c0'),
    ma10: v('--ma10', dark ? '#a5c8ff' : '#6b9cf5'),
    ma20: v('--ma20', dark ? '#4a7bd9' : '#1e3a8a'),
    // 籌碼圖：外資＝藍、投信＝綠、自營＝橘（沿用舊籌碼圖配色；暗色提亮）
    foreign: dark ? '#60a5fa' : '#1565c0',
    trust: dark ? '#4ade80' : '#16a34a',
    dealer: dark ? '#fb923c' : '#f97316',
  };
}

const hexRgb = (c) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * 把「a 透明度的 color 疊在 bg 上」先算成不透明色。
 * 疊加長條各層若用半透明，下層會透上來混成髒色（藍＋綠＋橘 → 灰綠）；先算好實色就不會互相混。
 */
export function solidTint(color, a, bg) {
  const c = hexRgb(color);
  const b = hexRgb(bg) || [255, 255, 255];
  if (!c) return color;
  const mix = c.map((x, i) => Math.round(x * a + b[i] * (1 - a)));
  return `rgb(${mix.join(', ')})`;
}

/** '#rrggbb' → rgba(…, a)；非 hex（例如已是 rgba）原樣回傳 */
export function withAlpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function chartOptions(t) {
  return {
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: t.text,
      fontSize: 11,
      fontFamily: 'inherit',
      panes: { separatorColor: t.grid, separatorHoverColor: t.grid, enableResize: false },
      // 圖上 logo 會擋住下區左下角；改由個股視窗底部「© TradingView」標示並連到 tradingview.com（授權要求）
      attributionLogo: false,
    },
    // 簡約：不畫背景格線與座標軸邊線
    grid: {
      vertLines: { visible: false },
      horzLines: { visible: false },
    },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false },
    // 套件預設會把滑鼠下的序列拉到最上層重畫；籌碼疊加長條是多層互相覆蓋，
    // 滑到最底層（自營，畫的是三者累加高度）會整根變橘 → 關掉，維持固定疊放順序
    hoveredSeriesOnTop: false,
    crosshair: {
      vertLine: { color: t.text, labelBackgroundColor: t.dark ? '#3a3c3e' : '#475569' },
      horzLine: { color: t.text, labelBackgroundColor: t.dark ? '#3a3c3e' : '#475569' },
    },
  };
}

export function fmtPrice(v) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 1 : 2 });
}

/** K 棒序列的價格格式（右側刻度、最新價標籤、十字線價格） */
export const K_PRICE_FORMAT = { type: 'custom', formatter: fmtPrice, minMove: 0.01 };

/**
 * 股價圖版面：上區（K 線）與下區（RS）高度 3:1，K 線區底部 22% 留給量能。
 * 籌碼圖依此換算自己的邊距，讓兩個分頁的 K 棒落在完全相同的像素位置（切分頁不跳）。
 */
export const PRICE_PANE_RATIO = 0.75;
export const PRICE_VOL_BOTTOM = 0.22;

/** 上區頂端讓給 OHLC 圖例、下區頂端讓給該區圖例的比例（依區塊實際像素高度算） */
export const mainTopMargin = (legendH, paneH) => Math.min(0.3, Math.max(0.08, (legendH + 10) / paneH));
export const subTopMargin = (paneH) => Math.min(0.4, 22 / paneH);

/**
 * 籌碼圖 K 線區的上下邊距：換算成與股價圖 K 棒相同的像素帶。
 * totalH＝兩區高度合計（兩張圖相同），legendH＝上方圖例高度，ownPaneH＝籌碼圖自己的上區高度。
 */
export function alignedMainMargins(totalH, legendH, ownPaneH) {
  const pricePane = totalH * PRICE_PANE_RATIO;
  const topPx = mainTopMargin(legendH, pricePane) * pricePane;
  const bottomPx = pricePane * (1 - PRICE_VOL_BOTTOM);
  return {
    top: Math.max(0, Math.min(0.9, topPx / ownPaneH)),
    bottom: Math.max(0, Math.min(0.9, 1 - bottomPx / ownPaneH)),
  };
}

/** 有真實 open（open ≠ close）用 close vs open；否則退回 close vs 昨收（同舊版） */
export function isUpBar(d, prev) {
  if (Number.isFinite(d.open) && d.open !== d.close) return d.close >= d.open;
  if (prev && Number.isFinite(prev.close)) return d.close >= prev.close;
  return true;
}

/** crosshair 回傳的 time（字串或 BusinessDay）→ 'YYYY-MM-DD' */
export function timeKeyOf(tm) {
  if (typeof tm === 'string') return tm;
  if (tm && typeof tm === 'object') return `${tm.year}-${String(tm.month).padStart(2, '0')}-${String(tm.day).padStart(2, '0')}`;
  return null;
}

/**
 * 兩張圖共用的 createChart：日期刻度（年／月／M/D）、右側價格軸、固定視窗（不拖曳平移）。
 * extra 可覆寫，例如籌碼圖開放拖曳價格軸縮放。
 */
export function createBaseChart(lib, host, t, { mainTop, mainBottom = 0.22, extra = {} } = {}) {
  return lib.createChart(host, {
    ...chartOptions(t),
    autoSize: true,
    // 不設整張圖的 priceFormatter：它會蓋掉各序列自己的格式（籌碼下區要用精簡刻度）。
    // K 棒的價格格式改由 K_PRICE_FORMAT 掛在 K 棒序列上
    localization: {
      locale: 'zh-TW',
      dateFormat: 'yyyy-MM-dd',
    },
    timeScale: {
      borderVisible: false,
      rightOffset: 1.5,
      fixLeftEdge: true, // 拖到最早一根就停，不留空白
      lockVisibleTimeRangeOnResize: true,
      tickMarkFormatter: (time, type) => {
        const [y, m, d] = (timeKeyOf(time) || '').split('-');
        if (type === lib.TickMarkType.Year) return `${y}年`;
        if (type === lib.TickMarkType.Month) return `${Number(m)}月`;
        return `${Number(m)}/${Number(d)}`;
      },
    },
    // 價格刻度間距拉大（預設 2.5 太密）；最少 48px 寬，兩張圖右邊距才對得齊
    rightPriceScale: { borderVisible: false, tickMarkDensity: 6, minimumWidth: 48, scaleMargins: { top: mainTop ?? 0.1, bottom: mainBottom } },
    // 滑鼠：按住拖曳平移、拖曳刻度軸縮放（雙擊刻度軸還原）。滾輪／觸控板改由 attachWheelHandler 自己處理
    // （套件內建以 deltaY/100 縮放，觸控板每次只送 2～10，非常鈍；也不做左右滑平移）。
    // 觸控拖曳關閉：手機上橫滑是「快滑換股」，不能被圖表吃掉
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: false, vertTouchDrag: false },
    handleScale: {
      mouseWheel: false,
      pinch: false,
      axisPressedMouseMove: { time: true, price: true },
      axisDoubleClickReset: { time: true, price: true },
    },
    ...extra,
  });
}

/**
 * 滾輪／觸控板手勢（取代套件內建，兩張圖共用）：
 * - 兩指左右滑（deltaX 為主）：平移，手指移多少像素、K 棒就跟著移多少
 * - 兩指上下滑／滑鼠滾輪（deltaY 為主）：以游標為中心縮放時間軸
 * - 觸控板兩指捏合（瀏覽器送 ctrlKey + deltaY）：縮放，靈敏度另調
 * 縮放最少保留 MIN_BARS 根，右側最多留 MAX_RIGHT_PAD 根空白。回傳解除函式。
 */
const MIN_BARS = 10;
const MAX_RIGHT_PAD = 5;
export function attachWheelHandler(chart, host, getBarCount) {
  // 套件的 setVisibleLogicalRange 要到下一個畫面才生效；觸控板一個畫面內常送好幾個 wheel 事件，
  // 若每次都從 getVisibleLogicalRange() 算，前一次的位移會被蓋掉（＝「很鈍」）。
  // 所以手勢進行中自己記住目前範圍，連續累加；停手 120ms 後再回到讀圖表實際範圍。
  let pending = null;
  let idleTimer = null;
  let rafId = 0;
  // 觸控板一個畫面常送好幾個事件：每個畫面只送一次 setVisibleLogicalRange，用這個畫面累積到的最終值
  // （套件本身是後蓋前，不會掉；這裡只是省掉多餘的重算）
  let lastFlushAt = 0;
  const flush = () => {
    rafId = 0;
    if (pending) {
      chart.timeScale().setVisibleLogicalRange(pending);
      lastFlushAt = performance.now();
    }
  };
  // 一次手勢原則上只做一件事：第一個事件決定平移或縮放，不因斜斜的小分量來回切換；
  // 但另一個方向「明顯比較大」（2 倍且超過 3px）時立刻切換——手指離開後 macOS 還會送約半秒～一秒的慣性事件，
  // 若死鎖模式，慣性期間馬上做另一種手勢就會沒反應
  let mode = null; // 'pan' | 'zoom'
  const onWheel = (e) => {
    const ts = chart.timeScale();
    // 對齊圖表實際範圍：送出的範圍若被套件夾住（拉到最左、縮到極限），或被別的操作（滑鼠拖曳）改過，
    // 改以實際範圍為起點，避免繼續累加在被夾住的區域、往回滑要先「抵銷」才會動
    const actual = ts.getVisibleLogicalRange();
    if (pending && !rafId && actual && performance.now() - lastFlushAt > 50
        && (Math.abs(actual.from - pending.from) > 0.5 || Math.abs(actual.to - pending.to) > 0.5)) {
      pending = { from: actual.from, to: actual.to };
    }
    const r = pending || actual;
    if (!r) return;
    e.preventDefault(); // 不讓視窗捲動、也不觸發瀏覽器左右滑「上一頁」
    // deltaMode：0＝像素（觸控板、多數滑鼠）、1＝行（部分滑鼠，一行約 16px）
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    const n = getBarCount();
    const width = ts.width() || host.clientWidth || 1; // 繪圖區寬（不含右側刻度軸）
    const span = r.to - r.from;
    let from = r.from;
    let to = r.to;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (!mode) mode = !e.ctrlKey && ax > ay ? 'pan' : 'zoom';
    else if (mode === 'pan' && ay > 3 && ay > ax * 2) mode = 'zoom';
    else if (mode === 'zoom' && !e.ctrlKey && ax > 3 && ax > ay * 2) mode = 'pan';
    if (e.ctrlKey) mode = 'zoom'; // 捏合一律縮放
    if (mode === 'pan') {
      const shift = (dx / width) * span; // 像素換算成 K 棒數（平移中夾帶的上下分量忽略）
      from += shift;
      to += shift;
    } else {
      // 捏合的 delta 很小、滾輪一格約 100：分開給係數，觸控板上下滑每次約 2～10 也能順順地縮放
      const k = e.ctrlKey ? 0.012 : 0.0025;
      const f = Math.exp((dy || 0) * k);
      const rect = host.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - rect.left, 0), width);
      const c = from + (x / width) * span; // 游標所在的邏輯位置（以手勢中的範圍計，不用圖表尚未更新的刻度）
      const newSpan = Math.max(MIN_BARS, Math.min(n + MAX_RIGHT_PAD, span * f));
      const ratio = span > 0 ? (c - from) / span : 0.5;
      from = c - ratio * newSpan;
      to = from + newSpan;
    }
    // 邊界：左邊不早於第一根、右邊最多留 MAX_RIGHT_PAD 根空白（平移時保持寬度）
    const w = to - from;
    if (from < 0) { from = 0; to = w; }
    if (to > n - 1 + MAX_RIGHT_PAD) { to = n - 1 + MAX_RIGHT_PAD; from = Math.max(0, to - w); }
    pending = { from, to };
    if (!rafId) rafId = requestAnimationFrame(flush);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { flush(); pending = null; mode = null; }, 120);
  };
  host.addEventListener('wheel', onWheel, { passive: false });
  return () => { clearTimeout(idleTimer); cancelAnimationFrame(rafId); host.removeEventListener('wheel', onWheel); };
}

/** 打開時顯示最近幾根（約半年），往左拖可看到一年 */
export const INITIAL_BARS = 110;

/**
 * 兩張圖的時間視窗同步中樞（不經 React state）：
 * 作用中的圖拖曳／縮放時 report 最新範圍；停手 150ms 後直接呼叫其他圖登記的 applier 設定範圍。
 * 以前用 state 同步，每次停手整個個股視窗都會重繪，快速連續滑動時下一下會被擋住（偶發沒反應）。
 */
export function createRangeSyncHub() {
  return {
    latest: null,
    timer: null,
    appliers: {}, // key → (range) => void
    report(fromKey, r) {
      this.latest = r;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        Object.entries(this.appliers).forEach(([k, fn]) => { if (k !== fromKey && this.latest) fn(this.latest); });
      }, 150);
    },
    reset() {
      clearTimeout(this.timer);
      this.latest = null;
    },
  };
}

const sameRange = (a, b) => a && b && Math.abs(a.from - b.from) < 0.01 && Math.abs(a.to - b.to) < 0.01;

/**
 * 時間視窗：資料換了（換股、日／週切換）才回到「最近 INITIAL_BARS 根」；
 * 同一檔只是補資料（例如法人資料晚到）就保留使用者目前拖到的位置。
 * 非作用中的圖透過 hub 跟著作用中的圖同步（兩張圖日期一致，邏輯索引可直接套用），切分頁時位置不跳。
 * syncEnabled=false（例如股價圖切到週線，K 棒數不同）時不回報也不接收。
 */
export function useVisibleRangeSync({
  apiRef, ready, data, active, hub, syncKey, syncEnabled = true, useRef, useEffect,
}) {
  const keyRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const enabledRef = useRef(syncEnabled);
  enabledRef.current = syncEnabled;

  // 初始／換資料時的視窗
  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api || !data.length) return;
    const key = `${data[0]?.dateKey}|${data.at(-1)?.dateKey}`;
    if (keyRef.current === key) return;
    keyRef.current = key;
    const n = data.length;
    const range = { from: Math.max(0, n - INITIAL_BARS), to: n - 1 + 1.5 };
    api.chart.timeScale().setVisibleLogicalRange(range);
    if (activeRef.current && enabledRef.current) hub?.report(syncKey, range);
  }, [ready, data]); // eslint-disable-line react-hooks/exhaustive-deps

  // 作用中的圖：使用者拖曳／縮放時回報；登記 applier 讓 hub 在自己非作用中時設定範圍
  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api || !hub) return undefined;
    const ts = api.chart.timeScale();
    const handler = (r) => {
      if (r && activeRef.current && enabledRef.current) hub.report(syncKey, { from: r.from, to: r.to });
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    hub.appliers[syncKey] = (r) => {
      if (activeRef.current || !enabledRef.current) return;
      if (!sameRange(ts.getVisibleLogicalRange(), r)) ts.setVisibleLogicalRange(r);
    };
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(handler);
      delete hub.appliers[syncKey];
    };
  }, [ready, hub, syncKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 剛切成作用中（或重新啟用同步）：直接套用 hub 的最新範圍
  useEffect(() => {
    const api = apiRef.current;
    const r = hub?.latest;
    if (!ready || !api || !active || !syncEnabled || !r) return;
    const ts = api.chart.timeScale();
    if (!sameRange(ts.getVisibleLogicalRange(), r)) ts.setVisibleLogicalRange(r);
  }, [ready, active, syncEnabled]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** 圖例容器共用樣式（位置由各圖自己給 top） */
export const legendBaseStyle = {
  position: 'absolute',
  left: CHART_INSET_LEFT + 4,
  zIndex: 3,
  pointerEvents: 'none',
  fontSize: 11,
  lineHeight: 1.4,
  color: 'var(--app-text-soft)',
  fontVariantNumeric: 'tabular-nums',
  display: 'flex',
  flexWrap: 'wrap',
  columnGap: 8,
  rowGap: 0,
  // 右側留給價格軸，窄螢幕時圖例自動換行而不是超出畫面
  maxWidth: `calc(100% - ${CHART_INSET_LEFT + 60}px)`,
};
