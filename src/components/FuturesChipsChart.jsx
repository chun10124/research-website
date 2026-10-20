import React, { useEffect, useMemo, useRef, useState } from 'react';
import styles from './FuturesChipsPage.module.css';
import { readTheme, chartOptions, timeKeyOf, attachWheelHandler } from '../features/StockAnalysis/components/lwcShared';

/**
 * 籌碼頁「圖表」分頁：上下兩格。
 * - 上格：加權指數。
 * - 下格：勾選的籌碼折線。同商品多空共用一組刻度（高低可直接比）；勾選的第一組用右軸、第二組用左軸，
 *   其餘用隱藏刻度（圖例只標「左」）。
 * - 月結算日：到期月合約不計入總未平倉，當天口數會掉一截隔天回來（口徑造成、非真實變化）→ 籌碼線跳過結算日直接連線，
 *   兩格都用淡金色直條標出結算日。
 * 數值看左上圖例（十字線所在日，沒有十字線時顯示最新一日）。
 */

const SEL_KEY = 'rw-futchip-lines-v2'; // v2：線的清單縮減過，舊勾選不沿用
const DEFAULT_ON = ['mtxLong', 'mtxShort'];

const fmtNum = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
const fmtSigned = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')}`);

/** 可疊加的折線；color 亮／暗各一。多紅空綠，小台實線、微台虛線（dash）區分。
    同商品的多空共用刻度（scale），兩條線的高低才能直接比；其餘各用自己的刻度 */
export const LINES = [
  { group: '散戶多空', key: 'mtxLong', scale: 'mtx', label: '小台看多', get: (r) => r.mtxRetail?.[0], fmt: fmtNum, color: ['#e53935', '#ff6b5e'] },
  { group: '散戶多空', key: 'mtxShort', scale: 'mtx', label: '小台看空', get: (r) => r.mtxRetail?.[1], fmt: fmtNum, color: ['#1a8a30', '#4ade80'] },
  { group: '散戶多空', key: 'tmfLong', scale: 'tmf', label: '微台看多', get: (r) => r.tmfRetail?.[0], fmt: fmtNum, color: ['#e53935', '#ff6b5e'], dash: true },
  { group: '散戶多空', key: 'tmfShort', scale: 'tmf', label: '微台看空', get: (r) => r.tmfRetail?.[1], fmt: fmtNum, color: ['#1a8a30', '#4ade80'], dash: true },
  { group: '外資選擇權', key: 'callOi', label: 'CALL 淨未平倉口數', get: (r) => r.callNetOi, fmt: fmtSigned, color: ['#d97706', '#fbbf24'] },
  { group: '外資選擇權', key: 'callAmt', label: 'CALL 淨未平倉金額', get: (r) => r.callNetAmt, fmt: fmtSigned, color: ['#7c3aed', '#a78bfa'] },
];
const GROUPS = [...new Set(LINES.map((l) => l.group))];
const scaleOf = (l) => l.scale || l.key;
const SCALE_ORDER = [...new Set(LINES.map(scaleOf))];
const CHIP_PANE = 1;
const CHIP_PANE_RATIO = 0.42; // 下格佔整張圖高度

/** 勾選的刻度組 → 'right'／'left'／自己的隱藏刻度 */
function axisMap(sel) {
  const on = SCALE_ORDER.filter((sc) => LINES.some((l) => scaleOf(l) === sc && sel.has(l.key)));
  return Object.fromEntries(SCALE_ORDER.map((sc) => {
    const i = on.indexOf(sc);
    return [sc, i === 0 ? 'right' : i === 1 ? 'left' : `ov_${sc}`];
  }));
}

/** 下格各刻度的邊距（刻度要有線掛上才存在，所以透過線去取） */
const styleChipScales = (series) => {
  for (const s of Object.values(series)) s.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 }, borderVisible: false });
};

/** 下格刻度精簡：38,085 → 38k */
const fmtAxis = (v) => {
  const a = Math.abs(v);
  if (a >= 10000) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(v)}`;
};

function loadSel() {
  try {
    const v = JSON.parse(localStorage.getItem(SEL_KEY) || 'null');
    if (Array.isArray(v)) return new Set(v);
  } catch (_) {}
  return new Set(DEFAULT_ON);
}

/** 一打開顯示 visibleFrom 起到最新；更早的資料在左邊，可滑過去看 */
function showRange(chart, rows, visibleFrom) {
  const ts = chart.timeScale();
  const first = rows[0]?.date.replace(/\//g, '-');
  const last = rows[rows.length - 1]?.date.replace(/\//g, '-');
  if (!first || !visibleFrom || visibleFrom <= first) { ts.fitContent(); return; }
  ts.setVisibleRange({ from: visibleFrom, to: last });
}

export default function FuturesChipsChart({ rows, visibleFrom }) {
  const hostRef = useRef(null);
  const apiRef = useRef(null);
  const [sel, setSel] = useState(loadSel);
  const [hoverKey, setHoverKey] = useState(null);
  const [dark, setDark] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark');

  const byDate = useMemo(() => Object.fromEntries(rows.map((r) => [r.date.replace(/\//g, '-'), r])), [rows]);
  const lastKey = rows.length ? rows[rows.length - 1].date.replace(/\//g, '-') : null;

  // 跟著網站亮暗切換重畫
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.getAttribute('data-theme') === 'dark'));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    import('lightweight-charts').then((lib) => {
      if (disposed || !hostRef.current) return;
      const t = readTheme();
      const chart = lib.createChart(hostRef.current, {
        ...chartOptions(t),
        autoSize: true,
        localization: { locale: 'zh-TW', dateFormat: 'yyyy-MM-dd' },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
        timeScale: {
          borderVisible: false,
          rightOffset: 2,
          fixLeftEdge: true,
          fixRightEdge: true,
          tickMarkFormatter: (time, type) => {
            const [y, m, d] = (timeKeyOf(time) || '').split('-');
            if (type === lib.TickMarkType.Year) return `${y}年`;
            if (type === lib.TickMarkType.Month) return `${Number(m)}月`;
            return `${Number(m)}/${Number(d)}`;
          },
        },
        // 滾輪／觸控板改由 attachWheelHandler（與個股圖同一套）：兩指左右滑平移、上下滑或捏合縮放；拖曳也可平移
        handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
      });

      const idx = chart.addSeries(lib.LineSeries, {
        color: t.idx,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'custom', formatter: (v) => Math.round(v).toLocaleString('en-US'), minMove: 1 },
      });
      idx.setData(rows.filter((r) => r.close != null).map((r) => ({ time: r.date.replace(/\//g, '-'), value: r.close })));

      // 月結算日淡金色直條：兩格各一組，放在填滿整格高度的隱藏刻度上
      const settleColor = t.dark ? 'rgba(212, 175, 55, 0.14)' : 'rgba(201, 164, 100, 0.18)';
      const settleData = rows.map((r) => {
        const time = r.date.replace(/\//g, '-');
        return r.settleCode === 999 ? { time, value: 1, color: settleColor } : { time };
      });
      for (const pane of [0, CHIP_PANE]) {
        const band = chart.addSeries(lib.HistogramSeries, {
          priceScaleId: 'settle',
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }, pane);
        band.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
        band.setData(settleData);
      }

      const axes = axisMap(sel);
      const series = {};
      for (const l of LINES) {
        const s = chart.addSeries(lib.LineSeries, {
          color: l.color[t.dark ? 1 : 0],
          lineWidth: 2,
          lineStyle: l.dash ? lib.LineStyle.Dashed : lib.LineStyle.Solid,
          priceScaleId: axes[scaleOf(l)],
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerRadius: 3,
          visible: sel.has(l.key),
          priceFormat: { type: 'custom', formatter: fmtAxis, minMove: 1 },
        }, CHIP_PANE);
        // 結算日不畫點，前後兩天直接連線
        s.setData(rows.filter((r) => r.settleCode !== 999).map((r) => {
          const v = l.get(r);
          const time = r.date.replace(/\//g, '-');
          return v == null ? { time } : { time, value: v };
        }));
        series[l.key] = s;
      }
      styleChipScales(series);
      const chipPane = chart.panes()[CHIP_PANE];
      chart.applyOptions({ leftPriceScale: { visible: Object.values(axes).includes('left'), borderVisible: false } });
      chipPane.setHeight(Math.round((hostRef.current.clientHeight || 500) * CHIP_PANE_RATIO));
      showRange(chart, rows, visibleFrom);
      chart.subscribeCrosshairMove((param) => setHoverKey(param?.time ? timeKeyOf(param.time) : null));
      const detachWheel = attachWheelHandler(chart, hostRef.current, () => rows.length);
      apiRef.current = { chart, series, detachWheel, leftOn: Object.values(axes).includes('left') };
    });
    return () => {
      disposed = true;
      apiRef.current?.detachWheel?.();
      apiRef.current?.chart.remove();
      apiRef.current = null;
    };
    // 勾選改變只切 visible（下方 effect），不重建圖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, dark, visibleFrom]);

  useEffect(() => {
    try { localStorage.setItem(SEL_KEY, JSON.stringify([...sel])); } catch (_) {}
    const api = apiRef.current;
    if (!api) return;
    const axes = axisMap(sel);
    for (const l of LINES) api.series[l.key]?.applyOptions({ visible: sel.has(l.key), priceScaleId: axes[scaleOf(l)] });
    styleChipScales(api.series);
    const leftOn = Object.values(axes).includes('left');
    api.chart.applyOptions({ leftPriceScale: { visible: leftOn } });
    // 左軸出現／消失會改變繪圖寬度，時間軸被擠掉最新幾天 → 重新塞滿整段
    if (api.leftOn !== leftOn) { api.leftOn = leftOn; requestAnimationFrame(() => showRange(api.chart, rows, visibleFrom)); }
  }, [sel]);
  const axesNow = useMemo(() => axisMap(sel), [sel]);

  const toggle = (key) => setSel((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const shownKey = hoverKey && byDate[hoverKey] ? hoverKey : lastKey;
  const row = shownKey ? byDate[shownKey] : null;
  const ci = dark ? 1 : 0;

  return (
    <div className={styles.chartCard}>
      <div className={styles.picker}>
        {GROUPS.map((g) => (
          <div key={g} className={styles.pickGroup}>
            <span className={styles.pickTitle}>{g}</span>
            {LINES.filter((l) => l.group === g).map((l) => (
              <button
                key={l.key}
                type="button"
                aria-pressed={sel.has(l.key)}
                className={`${styles.pick} ${sel.has(l.key) ? '' : styles.pickOff}`}
                onClick={() => toggle(l.key)}
              >
                <span className={l.dash ? styles.swatchDash : styles.swatch} style={l.dash ? { borderColor: l.color[ci] } : { background: l.color[ci] }} />
                {l.label}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.chartWrap}>
        {row && (
          <div className={styles.legend}>
            <span className={styles.legendDate}>{shownKey}</span>
            <span className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: readTheme().idx }} />
              加權指數 <b>{row.close == null ? '—' : Math.round(row.close).toLocaleString('en-US')}</b>
            </span>
            {LINES.filter((l) => sel.has(l.key)).map((l) => (
              <span key={l.key} className={styles.legendItem}>
                <span className={l.dash ? styles.swatchDash : styles.swatch} style={l.dash ? { borderColor: l.color[ci] } : { background: l.color[ci] }} />
                {l.label} <b>{l.fmt(l.get(row))}</b>
                {/* 右軸是預設，不標；只標用左軸的線 */}
                {axesNow[scaleOf(l)] === 'left' && <span className={styles.axisTag}>左</span>}
              </span>
            ))}
          </div>
        )}
        <div ref={hostRef} className={styles.chartHost} />
        <a className={styles.tvCredit} href="https://www.tradingview.com/" target="_blank" rel="noreferrer">© TradingView</a>
      </div>
    </div>
  );
}

