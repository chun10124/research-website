import React, { useEffect, useRef, useState } from 'react';
import {
  CHART_INSET_TOP, CHART_INSET_LEFT, readTheme, chartOptions, fmtPrice, mainTopMargin, subTopMargin,
  isUpBar, timeKeyOf, createBaseChart, legendBaseStyle, PRICE_PANE_RATIO, PRICE_VOL_BOTTOM, K_PRICE_FORMAT,
  useVisibleRangeSync, attachWheelHandler,
} from './lwcShared';

/**
 * 個股 RS 圖（TradingView lightweight-charts 版）
 * 上區：K 棒＋MA10/MA20＋量能（右側價格軸、最新價標籤）
 * 下區：RS（右軸，依可見區間縮放）＋加權（藍、隱藏刻度，數值看圖例；週線時改用右軸）
 *
 * data 與舊版 IbdRsComboChart 同形：{ dateKey, open, high, low, close, volume, rs, idx, ma10, ma20 }
 * lightweight-charts 在模組載入時用不到 window，但為了 Docusaurus SSR 保險，一律在 effect 內動態 import。
 */

/** RS 刻度：依可見區間自動縮放，但至少 20 分寬、夾在 1–99 內。
 *  強勢股 RS 長期 9x 時不會變成貼頂的一條平線（9x 時約 79–99） */
const RS_MIN_SPAN = 20;
function rsAutoscale(original) {
  const r = original();
  if (!r || !r.priceRange) return { priceRange: { minValue: 1, maxValue: 99 } };
  let lo = r.priceRange.minValue;
  let hi = r.priceRange.maxValue;
  if (hi - lo < RS_MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - RS_MIN_SPAN / 2;
    hi = mid + RS_MIN_SPAN / 2;
  }
  if (hi > 99) { lo -= hi - 99; hi = 99; }
  if (lo < 1) { hi = Math.min(99, hi + (1 - lo)); lo = 1; }
  return { priceRange: { minValue: lo, maxValue: hi } };
}

function fmtVol(v) {
  if (!Number.isFinite(v)) return '—';
  // Yahoo 量能單位為「股」→ 換成張
  const lots = v / 1000;
  if (lots >= 10000) return `${(lots / 10000).toFixed(1)} 萬張`;
  return `${Math.round(lots).toLocaleString()} 張`;
}

export default function IbdRsLwcChart({
  data, showMA = true, showRs = true, axisWidth = 48, onAxisWidth, active = true, syncHub = null, syncEnabled = true,
}) {
  const hostRef = useRef(null);
  const apiRef = useRef(null); // { lib, chart, candle, vol, ma10, ma20, rs, idx }
  const dataRef = useRef(data);
  const legendRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [theme, setTheme] = useState(null);
  const [rsPaneTop, setRsPaneTop] = useState(null);
  // 第一次量好區塊高度、套完邊距前先隱藏，避免切到股價分頁時 K 棒先畫一次再跳位（「彈一下」）
  const [settled, setSettled] = useState(false);

  dataRef.current = data;

  /* 建立圖表（只做一次） */
  useEffect(() => {
    let disposed = false;
    let themeObserver = null;
    let resizeObserver = null;
    let detachWheel = null;
    let rafId = null;
    import('lightweight-charts').then((lib) => {
      if (disposed || !hostRef.current) return;
      const t = readTheme();
      setTheme(t);
      const hostH = hostRef.current.clientHeight || 400;
      const estPane0 = Math.max(1, (hostH - 29) * PRICE_PANE_RATIO);
      const estPane1 = Math.max(1, (hostH - 29) * (1 - PRICE_PANE_RATIO));
      const estLegendH = legendRef.current?.offsetHeight ?? 16;
      const chart = createBaseChart(lib, hostRef.current, t, { mainTop: mainTopMargin(estLegendH, estPane0), mainBottom: PRICE_VOL_BOTTOM });

      const candle = chart.addSeries(lib.CandlestickSeries, {
        upColor: t.up,
        downColor: t.down,
        borderUpColor: t.upStroke,
        borderDownColor: t.downStroke,
        wickUpColor: t.upStroke,
        wickDownColor: t.downStroke,
        priceLineStyle: lib.LineStyle.Dashed,
        priceFormat: K_PRICE_FORMAT,
      });
      const vol = chart.addSeries(lib.HistogramSeries, {
        priceScaleId: 'vol',
        priceFormat: { type: 'volume' },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

      const lineBase = { lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
      // 均線不參與價格刻度縮放：刻度只由 K 棒決定，與籌碼圖一致（開關均線、切分頁時 K 棒都不動）
      const noAutoscale = { autoscaleInfoProvider: () => null };
      const ma10 = chart.addSeries(lib.LineSeries, { ...lineBase, ...noAutoscale, color: t.ma10 });
      const ma20 = chart.addSeries(lib.LineSeries, { ...lineBase, ...noAutoscale, color: t.ma20 });

      // 下區：加權（隱藏刻度的疊加軸）＋ RS（右軸 1–99）
      const idx = chart.addSeries(lib.LineSeries, {
        ...lineBase,
        lineWidth: 1.5, // 與 RS 線同粗
        color: t.idx,
        priceScaleId: 'idx',
      }, 1);
      chart.priceScale('idx', 1).applyOptions({ visible: false, scaleMargins: { top: subTopMargin(estPane1) + 0.04, bottom: 0.08 } });
      const rs = chart.addSeries(lib.LineSeries, {
        color: t.rs,
        lineWidth: 1.5,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'price', precision: 0, minMove: 1 },
        autoscaleInfoProvider: rsAutoscale,
      }, 1);
      chart.priceScale('right', 1).applyOptions({ tickMarkDensity: 6, scaleMargins: { top: subTopMargin(estPane1), bottom: 0.06 } });
      const panes = chart.panes();
      if (panes[0]) panes[0].setStretchFactor(PRICE_PANE_RATIO * 4);
      if (panes[1]) panes[1].setStretchFactor((1 - PRICE_PANE_RATIO) * 4);

      chart.subscribeCrosshairMove((param) => {
        if (!param || param.time == null || !param.point) { setHoverIdx(null); return; }
        const key = timeKeyOf(param.time);
        const i = key ? dataRef.current.findIndex((d) => d.dateKey === key) : -1;
        setHoverIdx(i >= 0 ? i : null);
      });

      apiRef.current = { lib, chart, candle, vol, ma10, ma20, rs, idx, measurePanes: () => measurePanes() };

      // 下區圖例要貼在 RS 區左上角 → 追蹤上區高度（+1px 分隔線）
      // RS 區頂端讓出 ~20px 給圖例，RS 貼 99 時線才不會壓到字
      const measurePanes = () => {
        rafId = null;
        // ResizeObserver 的 rAF 可能在圖表 remove() 之後才跑（關閉視窗／換股），此時 paneSize 會丟錯
        if (disposed || !apiRef.current || chart.panes().length < 2) return;
        // 區塊元件尚未建好或剛被移除時 paneSize 會丟 "Value is undefined"，下次 resize 再量
        let h0;
        let h1;
        try {
          h0 = chart.paneSize(0)?.height;
          h1 = chart.paneSize(1)?.height;
        } catch {
          return;
        }
        setRsPaneTop(Number.isFinite(h0) && h0 > 0 ? h0 + 1 : null);
        // 上區頂端依圖例實際高度讓位（窄螢幕圖例會換成兩行）
        const lh = legendRef.current?.offsetHeight ?? 16;
        if (Number.isFinite(h0) && h0 > 0) {
          chart.priceScale('right', 0).applyOptions({ scaleMargins: { top: mainTopMargin(lh, h0), bottom: PRICE_VOL_BOTTOM } });
        }
        if (Number.isFinite(h1) && h1 > 0) {
          const top = subTopMargin(h1);
          chart.priceScale('right', 1).applyOptions({ scaleMargins: { top, bottom: 0.06 } });
          // 週線時加權改用右軸，'idx' 這把尺不存在，對它設選項會丟錯
          if (idx.options().priceScaleId === 'idx') {
            chart.priceScale('idx', 1).applyOptions({ visible: false, scaleMargins: { top: top + 0.04, bottom: 0.08 } });
          }
        }
        if (h0 > 0 && h1 > 0) setSettled(true);
        try { onAxisWidthRef.current?.(chart.priceScale('right', 0).width()); } catch { /* 尚未排版 */ }
      };
      detachWheel = attachWheelHandler(chart, hostRef.current, () => dataRef.current.length);
      resizeObserver = new ResizeObserver(() => {
        if (rafId == null) rafId = requestAnimationFrame(measurePanes);
      });
      resizeObserver.observe(hostRef.current);

      // 主題切換（Docusaurus 改 html[data-theme]）→ 重讀 CSS 變數套色
      themeObserver = new MutationObserver(() => {
        const api = apiRef.current;
        if (!api) return;
        const nt = readTheme();
        setTheme(nt);
        api.chart.applyOptions(chartOptions(nt));
        api.candle.applyOptions({
          upColor: nt.up, downColor: nt.down,
          borderUpColor: nt.upStroke, borderDownColor: nt.downStroke,
          wickUpColor: nt.upStroke, wickDownColor: nt.downStroke,
        });
        api.rs.applyOptions({ color: nt.rs });
        api.idx.applyOptions({ color: nt.idx });
        api.ma10.applyOptions({ color: nt.ma10 });
        api.ma20.applyOptions({ color: nt.ma20 });
        setData(api, dataRef.current, nt);
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

      setReady(true);
    });
    return () => {
      disposed = true;
      if (themeObserver) themeObserver.disconnect();
      if (resizeObserver) resizeObserver.disconnect();
      if (detachWheel) detachWheel();
      if (rafId != null) cancelAnimationFrame(rafId);
      if (apiRef.current) { apiRef.current.chart.remove(); apiRef.current = null; }
    };
  }, []);

  /* 灌資料 */
  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return;
    setData(api, data, readTheme());
    // 灌完資料再量一次（第一次 ResizeObserver 量測可能早於區塊建好而略過）
    const raf = requestAnimationFrame(() => api.measurePanes());
    // 套件重排刻度可能晚一拍：稍後再量一次，確保回報的軸寬是新刻度的寬度
    const late = setTimeout(() => api.measurePanes(), 150);
    return () => { cancelAnimationFrame(raf); clearTimeout(late); };
  }, [ready, data]);

  useVisibleRangeSync({ apiRef, ready, data, active, hub: syncHub, syncKey: 'rs', syncEnabled, useRef, useEffect });

  // 右側刻度軸寬度與另一張圖同步（取兩者較大值），切分頁時繪圖區左右才不會位移
  const onAxisWidthRef = useRef(onAxisWidth);
  onAxisWidthRef.current = onAxisWidth;
  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return;
    api.chart.applyOptions({ rightPriceScale: { minimumWidth: Math.max(48, axisWidth || 0) } });
  }, [ready, axisWidth]);

  // 保險：不論量測是否成功，最晚 0.4 秒一定顯示，避免圖表一直藏著
  useEffect(() => {
    const id = setTimeout(() => setSettled(true), 400);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return;
    api.ma10.applyOptions({ visible: showMA });
    api.ma20.applyOptions({ visible: showMA });
  }, [ready, showMA]);

  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return;
    api.rs.applyOptions({ visible: showRs });
    // 週線不畫 RS：右軸若沒有可見序列只剩孤立刻度 → 改讓加權用右軸（單獨藏某區右軸會觸發套件版面錯誤）
    api.idx.applyOptions({ priceScaleId: showRs ? 'idx' : 'right' });
    api.measurePanes();
  }, [ready, showRs]);

  /* 圖例：滑鼠所在那根，沒有 hover 時顯示最新一根 */
  const n = data.length;
  const li = hoverIdx != null ? hoverIdx : n - 1;
  const d = li >= 0 ? data[li] : null;
  const prev = li > 0 ? data[li - 1] : null;
  const chg = d && prev && Number.isFinite(d.close) && Number.isFinite(prev.close) && prev.close
    ? ((d.close - prev.close) / prev.close) * 100
    : null;
  const t = theme;
  // 當天 RS 尚未同步（例如收盤後、sync 前）→ 顯示最後一筆並標日期，與右軸最新值標籤一致
  let rsShown = d && Number.isFinite(d.rs) ? d.rs : null;
  let rsFromDate = null;
  if (d && rsShown == null) {
    for (let k = li - 1; k >= 0; k--) {
      if (Number.isFinite(data[k].rs)) { rsShown = data[k].rs; rsFromDate = data[k].dateKey; break; }
    }
  }
  const chgColor = chg == null || !t ? 'var(--app-text-soft)' : chg > 0 ? t.up : chg < 0 ? t.down : 'var(--app-text-soft)';

  const legendBase = legendBaseStyle;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }}>
      <div
        ref={hostRef}
        className="ibd-lwc-host"
        style={{ position: 'absolute', inset: `${CHART_INSET_TOP}px 0 0 ${CHART_INSET_LEFT}px`, opacity: settled ? 1 : 0 }}
      />
      {d && (
        <div ref={legendRef} style={{ ...legendBase, top: CHART_INSET_TOP + 2, opacity: settled ? 1 : 0 }}>
          <span>{d.dateKey}</span>
          {Number.isFinite(d.close) && (
            <>
              <span>開 <b style={{ color: chgColor }}>{fmtPrice(d.open)}</b></span>
              <span>高 <b style={{ color: chgColor }}>{fmtPrice(d.high)}</b></span>
              <span>低 <b style={{ color: chgColor }}>{fmtPrice(d.low)}</b></span>
              <span>收 <b style={{ color: chgColor }}>{fmtPrice(d.close)}</b></span>
              {chg != null && <b style={{ color: chgColor }}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</b>}
              {Number.isFinite(d.volume) && <span>量 {fmtVol(d.volume)}</span>}
            </>
          )}
        </div>
      )}
      {d && rsPaneTop != null && (
        <div style={{ ...legendBase, top: CHART_INSET_TOP + rsPaneTop + 2 }}>
          {showRs && (
            <span style={{ color: t?.rs }}>
              RS <b>{rsShown ?? '—'}</b>
              {rsFromDate && (
                <span style={{ color: 'var(--app-text-soft)', fontWeight: 400 }}>
                  {' '}（{Number(rsFromDate.slice(5, 7))}/{Number(rsFromDate.slice(8, 10))}，當日尚未同步）
                </span>
              )}
            </span>
          )}
          <span style={{ color: t?.idx }}>
            加權 <b>{Number.isFinite(d.idx) ? d.idx.toLocaleString() : '—'}</b>
            {/* Yahoo 當日 ^TWII 收盤常為空 → 沿用前一交易日，標出實際日期 */}
            {d.idxDate && d.idxDate !== d.dateKey && (
              <span style={{ fontWeight: 400 }}>（{Number(d.idxDate.slice(5, 7))}/{Number(d.idxDate.slice(8, 10))}）</span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function setData(api, data, t) {
  const candles = [];
  const vols = [];
  const ma10 = [];
  const ma20 = [];
  const rs = [];
  const idx = [];
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const time = d.dateKey;
    const prev = i > 0 ? data[i - 1] : null;
    const hasOhlc = [d.open, d.high, d.low, d.close].every(Number.isFinite);
    if (hasOhlc) {
      const up = isUpBar(d, prev);
      const bar = { time, open: d.open, high: d.high, low: d.low, close: d.close };
      // open = close（只有收盤價）時依昨收決定顏色，與舊版一致
      if (d.open === d.close) {
        bar.color = up ? t.up : t.down;
        bar.borderColor = up ? t.upStroke : t.downStroke;
        bar.wickColor = up ? t.upStroke : t.downStroke;
      }
      candles.push(bar);
    } else {
      candles.push({ time });
    }
    vols.push(Number.isFinite(d.volume)
      ? { time, value: d.volume, color: (hasOhlc ? isUpBar(d, prev) : true) ? t.volUp : t.volDown }
      : { time });
    ma10.push(Number.isFinite(d.ma10) ? { time, value: d.ma10 } : { time });
    ma20.push(Number.isFinite(d.ma20) ? { time, value: d.ma20 } : { time });
    rs.push(Number.isFinite(d.rs) ? { time, value: d.rs } : { time });
    idx.push(Number.isFinite(d.idx) ? { time, value: d.idx } : { time });
  }
  api.candle.setData(candles);
  api.vol.setData(vols);
  api.ma10.setData(ma10);
  api.ma20.setData(ma20);
  api.rs.setData(rs);
  api.idx.setData(idx);
}
