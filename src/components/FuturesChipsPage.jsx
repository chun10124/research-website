import React, { useEffect, useMemo, useRef, useState } from 'react';
import styles from './FuturesChipsPage.module.css';
import { loadFuturesChipTable } from '../features/FuturesChips/taifexApi';
import { readStoredFuturesChips } from '../features/FuturesChips/futuresChipsStore';
import FuturesChipsChart from './FuturesChipsChart';

const RANGES = [
  { key: '6m', label: '半年', months: 6 },
  { key: '1y', label: '一年', months: 12 },
];
const RANGE_KEY = 'rw-futchip-range';
const VIEW_KEY = 'rw-futchip-view';
const VIEWS = [{ key: 'table', label: '表格' }, { key: 'chart', label: '圖表' }];
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

// 欄寬（表頭與表身是兩張表，靠同一組 colgroup 對齊；日期、結算兩欄寬度要和 CSS 的 sticky left 一致）
const COL_WIDTHS = [42, 34, 104, 72, 64, 90, 90, 90, 90, 90, 90, 84, 84, 84, 84, 104, 104, 104, 320];
const TABLE_WIDTH = COL_WIDTHS.reduce((a, b) => a + b, 0);
const Cols = () => <colgroup>{COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>;

const fmtInt = (v) => (v == null ? '' : Math.round(v).toLocaleString('en-US'));
const fmtSigned = (v) => (v == null ? '' : `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')}`);
const fmtIdx = (v) => (v == null ? '' : Math.round(v).toLocaleString('en-US'));
const fmtPct = (v) => { if (v == null) return ''; const n = Math.round(v); return `${n > 0 ? '+' : ''}${n}%`; };
const fmtDate = (d) => { const [, m, dd] = d.split('/'); return `${+m}/${+dd}`; };

function startFor(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

const BAR_MAX = 0.8; // 長條最多佔格子 80%（正負長條則是半格的 80%）

/** 資料長條墊在數字後面，最多佔 BAR_MAX 格（數字疊在上面，像 Excel 資料橫條）。gs＝分區第一欄（左側粗線）。
    給 min 時改以 [min, max] 區間畫（最短留 6%）：看多／看空這類水位從 0 畫每天都差不多長，看不出變化 */
function BarCell({ value, max, min, color, text, gs, className = '' }) {
  let w = 0;
  if (value != null && max) {
    w = min != null && max > min
      ? 6 + 94 * Math.min(1, Math.max(0, (value - min) / (max - min)))
      : Math.min(100, (Math.abs(value) / max) * 100);
    w *= BAR_MAX;
  }
  return (
    <td className={`${styles.num} ${styles.barCell} ${gs ? styles.gs : ''} ${className}`}>
      <span className={`${styles.bar} ${styles[color]}`} style={{ width: `${w}%` }} />
      <span className={styles.barText}>{text}</span>
    </td>
  );
}

/** 以中線為軸的正負長條：正值往右、負值往左。預設是 ±100 的百分位（正紅負綠，與原表一致）；
    給 max 就依最大絕對值等比，給 up/down 換色、text 換顯示 */
function DivergingCell({ value, gs, max = 100, up = 'barRed', down = 'barGreen', text, className = '' }) {
  const w = value == null || !max ? 0 : Math.min(50, (Math.abs(value) / max) * 50) * BAR_MAX;
  return (
    <td className={`${styles.num} ${styles.barCell} ${styles.diverging} ${gs ? styles.gs : ''} ${className}`}>
      <span className={styles.axis} />
      {value != null && (
        <span
          className={`${styles.bar} ${value < 0 ? styles[down] : styles[up]}`}
          style={value < 0 ? { right: '50%', left: 'auto', width: `${w}%` } : { left: '50%', width: `${w}%` }}
        />
      )}
      <span className={styles.barText}>{text ?? fmtPct(value)}</span>
    </td>
  );
}

/** 原表配色：淨 SC 擴大綠、往 BC 收斂粉紅；主導型深、次要型淺 */
const LABEL_TONE = {
  SC主動擴張: 'pillSc', 雙向強化型淨SC: 'pillSc', BC撤退型淨SC: 'pillScSoft',
  SC減少主導收斂: 'pillConv', BC增加主導收斂: 'pillConvSoft', 雙向強化型淨BC: 'pillConvSoft',
};
function Pill({ label }) {
  if (!label) return <span className={styles.soft}>—</span>;
  if (label === '同型') return <span className={styles.pillSame}>同型</span>;
  return <span className={`${styles.pill} ${styles[LABEL_TONE[label]] || ''}`}>{label}</span>;
}

export default function FuturesChipsPage() {
  const [range, setRange] = useState(() => {
    // 舊版存過 1m／3m，已拿掉 → 改回半年
    try { const v = localStorage.getItem(RANGE_KEY); return v === '1y' ? '1y' : '6m'; } catch (_) { return '6m'; }
  });
  // rows＝所選區間（表格用）；allRows＝手上全部資料（圖表用，可往前滑到一年前）
  const [state, setState] = useState({ loading: true, rows: [], allRows: [], warnings: [], progress: [0, 0], error: null });
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) || 'table'; } catch (_) { return 'table'; }
  });
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch (_) {} }, [view]);
  const headRef = useRef(null);
  const bodyRef = useRef(null);
  // 只用整頁直向捲動；左右捲動在表身，表頭跟著同步
  const syncHead = () => {
    if (headRef.current && bodyRef.current) headRef.current.scrollLeft = bodyRef.current.scrollLeft;
  };

  useEffect(() => {
    let alive = true;
    try { localStorage.setItem(RANGE_KEY, range); } catch (_) {}
    const months = RANGES.find((r) => r.key === range)?.months ?? 6;
    setState((s) => ({ ...s, loading: true, error: null, progress: [0, 0] }));
    const start = startFor(months);
    // 先讀每日同步預算好的資料（秒開）；沒有、太舊或不夠長才即時向期交所抓
    readStoredFuturesChips()
      .then((stored) => {
        if (stored && stored.from <= start) {
          const s0 = start.replace(/-/g, '/');
          return { rows: stored.rows.filter((r) => r.date >= s0), allRows: stored.rows, warnings: [] };
        }
        return loadFuturesChipTable(start, {
          onProgress: (done, total) => alive && setState((s) => ({ ...s, progress: [done, total] })),
        });
      })
      .then(({ rows, allRows, warnings }) => alive && setState({
        loading: false, rows, allRows: allRows || rows, warnings, progress: [0, 0], error: null,
      }))
      .catch((e) => alive && setState((s) => ({ ...s, loading: false, error: e.message })));
    return () => { alive = false; };
  }, [range]);

  // 新在上、舊在下
  const shown = useMemo(() => [...state.rows].reverse(), [state.rows]);

  const max = useMemo(() => {
    const vals = (f) => state.rows.flatMap((r) => [].concat(f(r))).filter((v) => v != null);
    // 滿格基準用 |值| 的第 95 百分位：換月、極端日不會把其他天壓到看不見，超過的頂滿
    const p95 = (f) => {
      const a = vals(f).map(Math.abs).sort((x, y) => x - y);
      return a.length ? a[Math.floor((a.length - 1) * 0.95)] : 0;
    };
    // 水位欄（看多／看空）：同商品多空共用 [min, max]，兩欄長度仍可互比
    const span = (f) => { const a = vals(f); return a.length ? [Math.min(...a), Math.max(...a)] : [0, 0]; };
    const [mtxMin, mtxMax] = span((r) => r.mtxRetail || []);
    const [tmfMin, tmfMax] = span((r) => r.tmfRetail || []);
    return {
      spread: p95((r) => r.spreadChg),
      mtxMin, mtx: mtxMax, tmfMin, tmf: tmfMax,
      mtxNet: p95((r) => r.mtxNetChg),
      tmfNet: p95((r) => r.tmfNetChg),
      callOi: p95((r) => r.callNetOi),
      callAmt: p95((r) => r.callNetAmt),
      bc: p95((r) => r.bcVsSettle),
    };
  }, [state.rows]);

  const { rows, loading, progress, warnings, error } = state;
  const lastDate = rows.length ? rows[rows.length - 1].date.replace(/\//g, '-') : null;

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <h1 className={styles.title}>籌碼</h1>
        <div className={styles.segment}>
          {VIEWS.map((v) => (
            <button key={v.key} type="button" className={v.key === view ? styles.segActive : ''} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
        <div className={styles.right}>
          <div className={styles.rangeTabs}>
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                className={r.key === range ? styles.segActive : ''}
                onClick={() => setRange(r.key)}
                disabled={loading}
              >
                {r.label}
              </button>
            ))}
          </div>
          <span className={styles.meta}>
            {loading
              // 有總數＝資料庫沒資料、正在向期交所下載；沒有＝還在讀資料庫
              ? (progress[1] ? `下載期交所資料中（${progress[0]}/${progress[1]}）` : '讀取中…')
              : lastDate && <>資料日期 <b>{lastDate}</b></>}
          </span>
        </div>
      </div>

      {error && <div className={styles.error}>載入失敗：{error}</div>}
      {!loading && warnings.length > 0 && (
        <div className={styles.error}>部分資料缺漏：{warnings.join('；')}</div>
      )}

      {!loading && rows.length > 0 && view === 'chart' && <FuturesChipsChart rows={state.allRows} visibleFrom={startFor(RANGES.find((r) => r.key === range)?.months ?? 6)} />}

      {!loading && rows.length > 0 && view === 'table' && (
        <div className={styles.card}>
          <div className={styles.headWrap} ref={headRef}>
            <table className={styles.table} style={{ width: TABLE_WIDTH }}>
              <Cols />
              <thead>
                <tr className={styles.groupRow}>
                  <th className={styles.stickyCol} colSpan={2} />
                  <th className={`${styles.gOi} ${styles.gs}`} colSpan={3}>留倉・大盤</th>
                  <th className={`${styles.gRetail} ${styles.gs}`} colSpan={6}>散戶多空（口）</th>
                  <th className={`${styles.gLevel} ${styles.gs}`} colSpan={4}>散戶位階（微台）</th>
                  <th className={`${styles.gForeign} ${styles.gs}`} colSpan={4}>外資選擇權布局</th>
                </tr>
                <tr className={styles.colRow}>
                  <th className={styles.stickyCol}>日期</th>
                  <th className={styles.stickyCol2}>結算</th>
                  <th className={`${styles.tOi} ${styles.gs}`} title="大台一般盤：近月未平倉 − 次月未平倉，取日變化">近月留倉差<br />增減</th>
                  <th className={styles.tOi}>加權指數</th>
                  <th className={styles.tOi}>漲跌</th>
                  <th className={`${styles.tRetail} ${styles.gs}`}>小台<br />看多</th>
                  <th className={styles.tRetail}>小台<br />看空</th>
                  <th className={styles.tRetail} title="（今天看多 − 看空）−（前一日看多 − 看空）；負＝偏空">小台<br />淨增減</th>
                  <th className={styles.tRetail}>微台<br />看多</th>
                  <th className={styles.tRetail}>微台<br />看空</th>
                  <th className={styles.tRetail} title="（今天看多 − 看空）−（前一日看多 − 看空）；負＝偏空">微台<br />淨增減</th>
                  <th className={`${styles.tLevel} ${styles.gs}`} title="自訂近似（原公式未能反推）：當日多單口數變化率，在近一年（250 個交易日）中的百分位，帶增減正負號">多單變化<br />強度</th>
                  <th className={styles.tLevel} title="自訂近似（原公式未能反推）：當日空單口數變化率，在近一年（250 個交易日）中的百分位，帶增減正負號">空單變化<br />強度</th>
                  <th className={styles.tLevel} title="微台散戶多單比例在上市以來全部歷史中的百分位">多單持倉<br />占比</th>
                  <th className={styles.tLevel}>空單持倉<br />占比</th>
                  <th className={`${styles.tForeign} ${styles.gs}`} title="外資臺指選擇權買權（CALL）未平倉淨口數">CALL 淨<br />未平倉口數</th>
                  <th className={styles.tForeign} title="外資臺指選擇權買權（CALL）未平倉淨金額（千元）">CALL 淨<br />未平倉金額</th>
                  <th className={styles.tForeign} title="外資 BC 未平倉金額 − 上次月結算日 BC 金額（千元）">BC 金額<br />較結算日</th>
                  <th className={`${styles.tForeign} ${styles.wide}`}>CALL 淨額結構（5 日 ／ 20 日）</th>
                </tr>
              </thead>
            </table>
          </div>
          <div className={styles.bodyWrap} ref={bodyRef} onScroll={syncHead}>
            <table className={styles.table} style={{ width: TABLE_WIDTH }}>
              <Cols />
              <tbody>
                {shown.map((r) => (
                  <tr key={r.date} className={r.settleCode === 999 ? styles.settleRow : ''}>
                    <td className={`${styles.stickyCol} ${styles.date}`}>{fmtDate(r.date)}</td>
                    <td className={`${styles.stickyCol2} ${styles.center}`}>
                      {r.settleCode === 999
                        ? <span className={styles.settleBadge}>月結</span>
                        : <span className={styles.soft}>{WEEKDAY[r.settleCode]}</span>}
                    </td>
                    <DivergingCell
                      gs
                      value={r.spreadChg}
                      max={max.spread}
                      up="barMagenta"
                      down="barRed"
                      text={fmtSigned(r.spreadChg)}
                    />
                    <td className={styles.num}>{fmtIdx(r.close)}</td>
                    <td className={`${styles.num} ${styles.bold} ${r.change == null ? '' : r.change >= 0 ? styles.up : styles.down}`}>
                      {fmtSigned(r.change)}
                    </td>
                    <BarCell gs value={r.mtxRetail?.[0]} min={max.mtxMin} max={max.mtx} color="barAmber" text={fmtInt(r.mtxRetail?.[0])} />
                    <BarCell value={r.mtxRetail?.[1]} min={max.mtxMin} max={max.mtx} color="barBlue" text={fmtInt(r.mtxRetail?.[1])} />
                    <DivergingCell value={r.mtxNetChg} max={max.mtxNet} up="barRed" down="barGreen" text={fmtSigned(r.mtxNetChg)} />
                    <BarCell value={r.tmfRetail?.[0]} min={max.tmfMin} max={max.tmf} color="barAmber" text={fmtInt(r.tmfRetail?.[0])} />
                    <BarCell value={r.tmfRetail?.[1]} min={max.tmfMin} max={max.tmf} color="barBlue" text={fmtInt(r.tmfRetail?.[1])} />
                    <DivergingCell value={r.tmfNetChg} max={max.tmfNet} up="barRed" down="barGreen" text={fmtSigned(r.tmfNetChg)} />
                    <DivergingCell gs value={r.longStr} />
                    {/* 空單增加＝偏空 → 正值綠、負值紅（與多單相反） */}
                    <DivergingCell value={r.shortStr} up="barGreen" down="barRed" />
                    <BarCell value={r.longShare} max={100} color="barAmber" text={r.longShare == null ? '' : `${Math.round(r.longShare)}%`} />
                    <BarCell value={r.shortShare} max={100} color="barBlue" text={r.longShare == null ? '' : `${100 - Math.round(r.longShare)}%`} />
                    <DivergingCell gs value={r.callNetOi} max={max.callOi} up="barTeal" down="barTeal" text={fmtSigned(r.callNetOi)} />
                    <DivergingCell
                      value={r.callNetAmt}
                      max={max.callAmt}
                      up="barTeal"
                      down="barTeal"
                      text={fmtSigned(r.callNetAmt)}
                    />
                    <BarCell value={r.bcVsSettle} max={max.bc} color="barTeal" text={fmtSigned(r.bcVsSettle)} />
                    <td className={styles.labels}>
                      {r.label5 && <><Pill label={r.label5} /><span className={styles.sep}>／</span><Pill label={r.label20} /></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
