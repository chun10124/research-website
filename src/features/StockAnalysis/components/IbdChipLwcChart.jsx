/* src/features/StockAnalysis/components/IbdChipLwcChart.jsx */

import React, { useEffect, useRef, useState } from 'react';
import {
  CHART_INSET_TOP, CHART_INSET_LEFT, readTheme, chartOptions, fmtPrice, subTopMargin,
  isUpBar, timeKeyOf, createBaseChart, legendBaseStyle, withAlpha, solidTint, alignedMainMargins, K_PRICE_FORMAT,
  useVisibleRangeSync, attachWheelHandler,
} from './lwcShared';

/**
 * 個股籌碼圖（lightweight-charts 版，取代舊的 SVG ForeignChipChart；外觀、邊距與股價圖一致）
 * 上區：K 棒（半透明當底）＋外資持股（藍）＋投信累計買賣超（綠，以顯示區第一天為 0）
 *       持股與投信累計各用隱藏的疊加刻度，數值看圖例；兩條線壓在中間約 45% 高度（同舊圖）
 * 下區：三大法人買賣超疊加長條。套件的長條一根只有一種顏色，所以用「累加值由長到短疊畫」做出疊加效果：
 *       買超 外資→投信→自營 往上疊、賣超往下疊，各 3 組長條（共 6 組），零軸保留。
 *       拖曳右側刻度軸可縮放長條高度，雙擊刻度軸還原（取代舊圖在下格上下拖曳）；長條刻度依可見區間、以零軸對稱。
 *
 * data（foreignChartData）：{ dateKey, open, high, low, close, holding, foreign, trust, dealer }（法人單位：張）
 */

const K_ALPHA = 0.65;       // K 棒半透明，讓籌碼線浮在上面（舊圖 --k-chip-opacity 0.65）
const BUY_ALPHA = 0.82;     // 買超長條（舊圖）
const SELL_ALPHA = 0.5;     // 賣超長條（舊圖）
const LINE_MARGIN = 0.275;  // 持股／投信累計線上下各留 27.5% → 線落在中間約 45%（舊圖 padding 0.6）

/** 下區刻度精簡格式（-1,000 → -1k）：刻度字變短，右側軸寬由價格決定、與股價圖相同，K 棒左右才對得齊 */
const fmtAxisLots = (v) => {
  const a = Math.abs(v);
  if (a >= 10000) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(v)}`;
};

const fmtLots = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString()} 張` : '—');
const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

export default function IbdChipLwcChart({
  data, axisWidth = 48, onAxisWidth, active = true, syncHub = null, syncEnabled = true,
}) {
  const hostRef = useRef(null);
  const apiRef = useRef(null);
  const dataRef = useRef(data);
  const legendRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [theme, setTheme] = useState(null);
  const [subPaneTop, setSubPaneTop] = useState(null);
  const [settled, setSettled] = useState(false); // 量好區塊高度前先隱藏，避免切分頁時跳位

  dataRef.current = data;

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
      const estTotal = Math.max(1, hostH - 30); // 扣日期軸約 29px＋分隔線 1px
      const estPane0 = estTotal * (2 / 3);
      const estPane1 = estTotal / 3;
      const estLegendH = legendRef.current?.offsetHeight ?? 16;
      // K 棒對齊股價圖的像素位置（見 alignedMainMargins）
      const estMain = alignedMainMargins(estTotal, estLegendH, estPane0);
      const chart = createBaseChart(lib, hostRef.current, t, {
        mainTop: estMain.top,
        mainBottom: estMain.bottom,
      });

      const candle = chart.addSeries(lib.CandlestickSeries, {
        upColor: withAlpha(t.up, K_ALPHA),
        downColor: withAlpha(t.down, K_ALPHA),
        borderUpColor: withAlpha(t.up, K_ALPHA),
        borderDownColor: withAlpha(t.down, K_ALPHA),
        wickUpColor: withAlpha(t.up, K_ALPHA),
        wickDownColor: withAlpha(t.down, K_ALPHA),
        priceLineStyle: lib.LineStyle.Dashed,
        priceFormat: K_PRICE_FORMAT,
      });
      // LineSeries 線寬 = lineWidth × 螢幕倍率且不取整，小數有效
      const lineBase = { lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
      const holding = chart.addSeries(lib.LineSeries, { ...lineBase, color: t.foreign, priceScaleId: 'hold' });
      const trustCum = chart.addSeries(lib.LineSeries, { ...lineBase, color: t.trust, priceScaleId: 'tcum' });
      ['hold', 'tcum'].forEach((id) => chart.priceScale(id).applyOptions({
        visible: false, scaleMargins: { top: LINE_MARGIN, bottom: LINE_MARGIN },
      }));

      // 下區：先加的畫在下層 → 由長到短：自營層（三者累加）→ 投信層（外資＋投信）→ 外資層
      const barBase = {
        lastValueVisible: false, priceLineVisible: false, priceFormat: { type: 'custom', formatter: fmtAxisLots, minMove: 1 },
        // 以零軸對稱：取可見區間這組長條的最大絕對值（各層都對稱，合起來仍對稱）
        autoscaleInfoProvider: (original) => {
          const r = original();
          if (!r || !r.priceRange) return { priceRange: { minValue: -1000, maxValue: 1000 } };
          const m = Math.max(Math.abs(r.priceRange.minValue), Math.abs(r.priceRange.maxValue), 1) * 1.05;
          return { priceRange: { minValue: -m, maxValue: m } };
        },
      };
      const layer = () => chart.addSeries(lib.HistogramSeries, { ...barBase }, 1);
      const bars = {
        buyDealer: layer(), buyTrust: layer(), buyForeign: layer(),
        sellDealer: layer(), sellTrust: layer(), sellForeign: layer(),
      };
      const zeroLine = bars.buyForeign.createPriceLine({
        price: 0, color: t.border, lineWidth: 1, lineStyle: lib.LineStyle.Solid, axisLabelVisible: false,
      });
      chart.priceScale('right', 1).applyOptions({ tickMarkDensity: 6, scaleMargins: { top: subTopMargin(estPane1), bottom: 0.04 } });

      const panes = chart.panes();
      if (panes[0]) panes[0].setStretchFactor(2);
      if (panes[1]) panes[1].setStretchFactor(1);

      chart.subscribeCrosshairMove((param) => {
        if (!param || param.time == null || !param.point) { setHoverIdx(null); return; }
        const key = timeKeyOf(param.time);
        const i = key ? dataRef.current.findIndex((d) => d.dateKey === key) : -1;
        setHoverIdx(i >= 0 ? i : null);
      });

      const measurePanes = () => {
        rafId = null;
        if (disposed || !apiRef.current || chart.panes().length < 2) return;
        let h0;
        let h1;
        try {
          h0 = chart.paneSize(0)?.height;
          h1 = chart.paneSize(1)?.height;
        } catch {
          return;
        }
        setSubPaneTop(Number.isFinite(h0) && h0 > 0 ? h0 + 1 : null);
        const lh = legendRef.current?.offsetHeight ?? 16;
        if (h0 > 0 && h1 > 0) chart.priceScale('right', 0).applyOptions({ scaleMargins: alignedMainMargins(h0 + h1, lh, h0) });
        if (h1 > 0) chart.priceScale('right', 1).applyOptions({ scaleMargins: { top: subTopMargin(h1), bottom: 0.04 } });
        if (h0 > 0 && h1 > 0) setSettled(true);
        try { onAxisWidthRef.current?.(chart.priceScale('right', 0).width()); } catch { /* 尚未排版 */ }
      };

      apiRef.current = { lib, chart, candle, holding, trustCum, bars, zeroLine, measurePanes: () => measurePanes() };

      detachWheel = attachWheelHandler(chart, hostRef.current, () => dataRef.current.length);
      resizeObserver = new ResizeObserver(() => {
        if (rafId == null) rafId = requestAnimationFrame(measurePanes);
      });
      resizeObserver.observe(hostRef.current);

      themeObserver = new MutationObserver(() => {
        const api = apiRef.current;
        if (!api) return;
        const nt = readTheme();
        setTheme(nt);
        api.chart.applyOptions(chartOptions(nt));
        api.candle.applyOptions({
          upColor: withAlpha(nt.up, K_ALPHA), downColor: withAlpha(nt.down, K_ALPHA),
          borderUpColor: withAlpha(nt.up, K_ALPHA), borderDownColor: withAlpha(nt.down, K_ALPHA),
          wickUpColor: withAlpha(nt.up, K_ALPHA), wickDownColor: withAlpha(nt.down, K_ALPHA),
        });
        api.holding.applyOptions({ color: nt.foreign });
        api.trustCum.applyOptions({ color: nt.trust });
        api.zeroLine.applyOptions({ color: nt.border });
        setChipData(api, dataRef.current, nt);
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

  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return undefined;
    setChipData(api, data, readTheme());
    const raf = requestAnimationFrame(() => api.measurePanes());
    // 套件重排刻度可能晚一拍：稍後再量一次，確保回報的軸寬是新刻度的寬度
    const late = setTimeout(() => api.measurePanes(), 150);
    return () => { cancelAnimationFrame(raf); clearTimeout(late); };
  }, [ready, data]);

  useVisibleRangeSync({ apiRef, ready, data, active, hub: syncHub, syncKey: 'chip', syncEnabled, useRef, useEffect });

  // 右側刻度軸寬度與另一張圖同步（取兩者較大值），切分頁時繪圖區左右才不會位移
  const onAxisWidthRef = useRef(onAxisWidth);
  onAxisWidthRef.current = onAxisWidth;
  useEffect(() => {
    const api = apiRef.current;
    if (!ready || !api) return;
    api.chart.applyOptions({ rightPriceScale: { minimumWidth: Math.max(48, axisWidth || 0) } });
  }, [ready, axisWidth]);

  // 保險：最晚 0.4 秒一定顯示
  useEffect(() => {
    const id = setTimeout(() => setSettled(true), 400);
    return () => clearTimeout(id);
  }, []);

  /* 圖例：滑鼠所在那天，沒有 hover 時顯示最新一天 */
  const n = data.length;
  const li = hoverIdx != null ? hoverIdx : n - 1;
  const d = li >= 0 ? data[li] : null;
  const prev = li > 0 ? data[li - 1] : null;
  const chg = d && prev && Number.isFinite(d.close) && Number.isFinite(prev.close) && prev.close
    ? ((d.close - prev.close) / prev.close) * 100
    : null;
  const t = theme;
  const chgColor = chg == null || !t ? 'var(--app-text-soft)' : chg > 0 ? t.up : chg < 0 ? t.down : 'var(--app-text-soft)';
  // 外資持股：當天尚未公布（晚上 10 點後才更新）→ 顯示最後一筆並標日期
  let holdShown = d && Number.isFinite(d.holding) ? d.holding : null;
  let holdFrom = null;
  if (d && holdShown == null) {
    for (let k = li - 1; k >= 0; k--) {
      if (Number.isFinite(data[k].holding)) { holdShown = data[k].holding; holdFrom = data[k].dateKey; break; }
    }
  }
  let tc = 0;
  for (let k = 0; k <= li; k++) if (Number.isFinite(data[k]?.trust)) tc += data[k].trust;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }}>
      <div
        ref={hostRef}
        className="ibd-lwc-host"
        style={{ position: 'absolute', inset: `${CHART_INSET_TOP}px 0 0 ${CHART_INSET_LEFT}px`, opacity: settled ? 1 : 0 }}
      />
      {d && (
        <div ref={legendRef} style={{ ...legendBaseStyle, top: CHART_INSET_TOP + 2, opacity: settled ? 1 : 0 }}>
          <span>{d.dateKey}</span>
          {Number.isFinite(d.close) && (
            <span>
              收 <b style={{ color: chgColor }}>{fmtPrice(d.close)}</b>
              {chg != null && <b style={{ color: chgColor }}> {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</b>}
            </span>
          )}
          <span style={{ color: t?.foreign }}>
            外資持股 <b>{holdShown != null ? `${Math.round(holdShown).toLocaleString()} 張` : '—'}</b>
            {holdFrom && <span style={{ fontWeight: 400 }}>（{md(holdFrom)}）</span>}
          </span>
          {data.some((x) => Number.isFinite(x.trust)) && <span style={{ color: t?.trust }}>投信累計 <b>{fmtLots(tc)}</b></span>}
        </div>
      )}
      {d && subPaneTop != null && (
        <div style={{ ...legendBaseStyle, top: CHART_INSET_TOP + subPaneTop + 2 }}>
          <span style={{ color: t?.foreign }}>外資 <b>{fmtLots(d.foreign)}</b></span>
          <span style={{ color: t?.trust }}>投信 <b>{fmtLots(d.trust)}</b></span>
          <span style={{ color: t?.dealer }}>自營 <b>{fmtLots(d.dealer)}</b></span>
        </div>
      )}
    </div>
  );
}

function setChipData(api, data, t) {
  const candles = [];
  const holding = [];
  const trustCum = [];
  const L = { buyDealer: [], buyTrust: [], buyForeign: [], sellDealer: [], sellTrust: [], sellForeign: [] };
  // 不透明色：各層互相蓋住而不是混色（半透明會讓下層透上來，顏色變髒、每根看起來都不一樣）
  const C = {
    buyDealer: solidTint(t.dealer, BUY_ALPHA, t.surface), buyTrust: solidTint(t.trust, BUY_ALPHA, t.surface),
    buyForeign: solidTint(t.foreign, BUY_ALPHA, t.surface),
    sellDealer: solidTint(t.dealer, SELL_ALPHA, t.surface), sellTrust: solidTint(t.trust, SELL_ALPHA, t.surface),
    sellForeign: solidTint(t.foreign, SELL_ALPHA, t.surface),
  };
  let tc = 0;
  const hasTrust = data.some((d) => Number.isFinite(d.trust)); // 法人資料還沒抓到時不畫一條 0 的平線
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const time = d.dateKey;
    const prev = i > 0 ? data[i - 1] : null;
    if ([d.open, d.high, d.low, d.close].every(Number.isFinite)) {
      const bar = { time, open: d.open, high: d.high, low: d.low, close: d.close };
      if (d.open === d.close) {
        const c = withAlpha(isUpBar(d, prev) ? t.up : t.down, K_ALPHA);
        bar.color = c; bar.borderColor = c; bar.wickColor = c;
      }
      candles.push(bar);
    } else {
      candles.push({ time });
    }
    holding.push(Number.isFinite(d.holding) ? { time, value: d.holding } : { time });
    if (Number.isFinite(d.trust)) tc += d.trust;
    trustCum.push(hasTrust ? { time, value: tc } : { time });

    // 疊加長條：買超與賣超各自由外資→投信→自營累加
    const f = Number.isFinite(d.foreign) ? d.foreign : 0;
    const tr = Number.isFinite(d.trust) ? d.trust : 0;
    const de = Number.isFinite(d.dealer) ? d.dealer : 0;
    const pf = Math.max(f, 0); const pt = Math.max(tr, 0); const pd = Math.max(de, 0);
    const nf = Math.min(f, 0); const nt = Math.min(tr, 0); const nd = Math.min(de, 0);
    const has = [d.foreign, d.trust, d.dealer].some(Number.isFinite);
    const put = (k, v) => L[k].push(has ? { time, value: v, color: C[k] } : { time });
    put('buyDealer', pf + pt + pd);
    put('buyTrust', pf + pt);
    put('buyForeign', pf);
    put('sellDealer', nf + nt + nd);
    put('sellTrust', nf + nt);
    put('sellForeign', nf);
  }
  api.candle.setData(candles);
  api.holding.setData(holding);
  api.trustCum.setData(trustCum);
  Object.keys(L).forEach((k) => api.bars[k].setData(L[k]));
}
