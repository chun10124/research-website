/* src/components/StockFundamentals.jsx */

/**
 * 個股基本面內容：摘要數字、營收＋YoY、EPS＋股價、毛利率、筆記、法說會、重大訊息、待確認提醒。
 * 由訂閱頁個股視窗抽出，訂閱頁與 RS 個股視窗「基本面」分頁共用。
 * it＝訂閱項目（null＝未訂閱：不畫提醒，頁尾有 onSubscribe 時顯示「訂閱」）。
 * 筆記與訂閱無關：每檔都能寫，存在 subscriptions/notes（見 notesStore.js）。
 * 色票（--sub-*）由外層的 .root（訂閱頁）或 .theme（嵌入別頁）提供。
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, LineChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ReferenceLine,
} from 'recharts';
import { fetchNewsDetail, DEFAULT_TRIGGERS, releaseAck } from '../features/Subscriptions/subscriptionApi';
import { useStockNotes } from '../features/Subscriptions/notesStore';
import styles from './SubscriptionPage.module.css';

export const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const fmtYi = (v) => (v == null ? '—' : (v / 1e8).toLocaleString('zh-TW', { maximumFractionDigits: v / 1e8 >= 100 ? 0 : 1 }));
export const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
export const fmtPrice = (v) => (v == null ? '—' : v.toLocaleString('zh-TW', { maximumFractionDigits: 2 }));
export const signCls = (v) => (v == null ? styles.muted : v > 0 ? styles.up : v < 0 ? styles.down : '');
const ymLabel = (ym) => (ym ? `${ym.slice(2, 4)}/${ym.slice(5)}` : '—');
const qLabel = (q) => (q ? `${q.slice(2, 4)}${q.slice(5)}` : ''); // 2026-Q2 → 26Q2
const addMonths = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/** 重訊提醒可能一次很多則，卡片與標題列合併成一個「新重訊 N 則」 */
export function alertLabels(alerts) {
  const news = alerts.filter((a) => a.news);
  const rest = alerts.filter((a) => !a.news).map((a) => ({ key: a.key, label: a.label, keys: [a.key] }));
  if (news.length) rest.push({ key: 'news', label: `新重訊 ${news.length} 則`, keys: news.map((a) => a.key) });
  return rest;
}

/* 讀 CSS 變數給 recharts（SVG 屬性不吃 var()），暗色切換時重讀 */
export function useThemeColors(ref) {
  const [c, setC] = useState(null);
  useEffect(() => {
    const read = () => {
      if (!ref.current) return;
      const cs = getComputedStyle(ref.current);
      const g = (n) => cs.getPropertyValue(n).trim();
      setC({
        bar: g('--sub-bar'), accent: g('--sub-accent'), line: g('--sub-line'), yoy: g('--sub-yoy'), down: g('--sub-down'),
        grid: g('--sub-grid'), text: g('--app-text-soft'), surface: g('--app-surface'), border: g('--app-border'),
        tipBg: g('--sub-tip-bg'), tipBorder: g('--sub-tip-border'), strong: g('--app-text'),
      });
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [ref]);
  return c;
}

function ChartCard({ title, children, empty, boxRef, info }) {
  return (
    <div className={styles.chartCard}>
      <div className={styles.chartHead}>
        <div className={styles.chartTitle}>{title}</div>
        {info && <div className={styles.chartInfo}>{info}</div>}
      </div>
      <div className={styles.chartBox} ref={boxRef}>{empty ? <div className={styles.chartEmpty}>{empty}</div> : children}</div>
    </div>
  );
}

/** 元素寬度（跟著視窗縮放更新）。時間軸上的長條不會自動算寬度，要自己依圖寬決定。 */
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export default function StockFundamentals({
  stock, it = null, d, stats: s, alerts = [], colors, today, onAck, onReload, onRemove, onSubscribe, onOpenSettings, busy = false,
}) {
  // 長條點選：被選的那根變藍並在標題列顯示該期資訊；沒點過（null）時預設選最新一期
  const [pickRev, setPickRev] = useState(null); // 營收月 x 標籤
  const [pickEps, setPickEps] = useState(null); // 季度 '2026-Q2'
  const [pickGm, setPickGm] = useState(null); // 毛利率季度 x 標籤 '26Q2'
  const [note, setNote] = useState('');
  const noteRef = useRef(null);
  const notes = useStockNotes(stock?.id);
  const [epsBoxRef, epsBoxW] = useWidth();
  const q = d?.quote;
  const loading = d?.loading || {};
  const confs = d?.conf || [];
  const upcoming = confs.filter((c) => c.end >= today).sort((a, b) => a.start.localeCompare(b.start));
  const past = confs.filter((c) => c.end < today).slice(0, 6);
  const newConfKeys = new Set(alerts.filter((a) => a.src === 'conf').map((a) => a.key.slice(5)));

  const addNote = async () => {
    const text = note.trim();
    if (!text || notes.busy) return;
    if (!(await notes.add(text))) return; // 存失敗：保留輸入內容，錯誤顯示在筆記框
    setNote('');
    if (noteRef.current) noteRef.current.style.height = 'auto'; // 自動長高的輸入框縮回一行
  };
  const delNote = (n) => {
    if (!window.confirm('刪除這則筆記？')) return;
    notes.remove(n);
  };

  const tip = colors && {
    // 提示框用獨立底色＋陰影，跟圖表背景分得開
    contentStyle: {
      background: colors.tipBg, border: `1px solid ${colors.tipBorder}`, borderRadius: 6, fontSize: 11, padding: '5px 9px',
      boxShadow: '0 4px 14px rgba(0, 0, 0, 0.25)',
    },
    labelStyle: { color: colors.strong, fontWeight: 700 },
    itemStyle: { color: colors.strong }, // 預設用數列顏色，長條的深鋼藍壓在提示框底上看不見
    cursor: { fill: colors.grid, fillOpacity: 0.5, stroke: colors.grid }, // 預設淺灰底在暗色下很刺眼
  };
  const axis = colors && { tick: { fontSize: 10, fill: colors.text }, tickLine: false };
  // 月營收畫最近 18 個月（與季度圖的 6 季同長度）
  const revRows = (s?.rows || []).slice(-18).map((r) => ({ x: ymLabel(r.ym), rev: r.revenue / 1e8, yoy: r.yoy, mom: r.mom }));
  // 季度圖（EPS、毛利率）只畫最近 6 季；較前季、去年同季的比較仍用完整資料
  const SHOW_QS = 6;
  const finAll = (d?.fin || []).map((r) => ({ x: qLabel(r.q), gm: r.gm, eps: r.eps }));
  const finRows = finAll.slice(-SHOW_QS);
  const hasGm = finRows.some((r) => r.gm != null);
  // EPS＋股價：共用時間軸（毫秒）。EPS 長條放在該季中間（2、5、8、11 月 15 日），股價是週收盤，
  // 只取第一個顯示季度（財報抓取的起點，今年往回 2 年的 Q1）之後的部分，兩者才對得齊。
  const qMid = (k) => { const [y, qq] = k.split('-Q').map(Number); return Date.UTC(y, (qq - 1) * 3 + 1, 15); };
  const qStart = (k) => { const [y, qq] = k.split('-Q').map(Number); return Date.UTC(y, (qq - 1) * 3, 1); };
  const qEnd = (k) => { const [y, qq] = k.split('-Q').map(Number); return Date.UTC(y, qq * 3, 1); };
  const epsQs = (d?.fin || []).slice(-SHOW_QS);
  const epsPrice = (() => {
    if (!epsQs.length) return null;
    const from = qStart(epsQs[0].q);
    const rows = epsQs.map((r) => ({ t: qMid(r.q), eps: r.eps, q: r.q }));
    (q?.series || []).forEach((p) => {
      const t = Date.parse(`${p.date}T00:00:00Z`);
      if (t >= from) rows.push({ t, close: p.close });
    });
    rows.sort((a, b) => a.t - b.t);
    const lastT = Math.max(qEnd(epsQs[epsQs.length - 1].q), rows[rows.length - 1].t);
    // 每季約佔（圖寬 − 兩側軸）/ 12，長條取其一半，限制在 4～22px
    const barSize = Math.max(4, Math.min(22, Math.round(((epsBoxW || 600) - 110) / epsQs.length * 0.5)));
    return { rows, domain: [from, lastT], ticks: epsQs.map((r) => qMid(r.q)), barSize };
  })();
  // 今年（最新一季所在年度）已公布各季 EPS 加總；最近一季 EPS 與其 ×4 年化
  // 今年（最新營收月所在年度）已公布各月營收加總
  const revYtd = s ? { year: s.latest.year, sum: s.rows.filter((r) => r.year === s.latest.year).reduce((a, r) => a + r.revenue, 0) } : null;
  const epsYtd = (() => {
    const fin = d?.fin || [];
    if (!fin.length) return null;
    const year = fin[fin.length - 1].q.slice(0, 4);
    const qs = fin.filter((r) => r.q.startsWith(year) && r.eps != null);
    if (!qs.length) return null;
    return { year, sum: qs.reduce((a, r) => a + r.eps, 0) };
  })();
  const epsLast = [...(d?.fin || [])].reverse().find((r) => r.eps != null) || null;
  const selRev = pickRev || revRows[revRows.length - 1]?.x || null;
  const selEps = pickEps || [...epsQs].reverse().find((r) => r.eps != null)?.q || null;
  const selRevRow = revRows.find((r) => r.x === selRev);
  const revInfo = selRevRow && (
    <>
      {selRevRow.x}　營收 <b>{selRevRow.rev.toFixed(1)} 億</b>
      　YoY <b className={signCls(selRevRow.yoy)}>{fmtPct(selRevRow.yoy)}</b>
      　MoM <b className={signCls(selRevRow.mom)}>{fmtPct(selRevRow.mom)}</b>
    </>
  );
  const selEpsRow = selEps && epsQs.find((r) => r.q === selEps);
  // 毛利率：預設最新一季，標題列顯示該季數值與較前季、去年同季的百分點變化
  const gmIdx = (() => {
    const i = pickGm ? finRows.findIndex((r) => r.x === pickGm) : -1;
    if (i >= 0) return i;
    for (let k = finRows.length - 1; k >= 0; k--) if (finRows[k].gm != null) return k;
    return -1;
  })();
  const gmRow = gmIdx >= 0 ? finRows[gmIdx] : null;
  const gmAt = gmIdx + finAll.length - finRows.length; // 在完整資料中的位置
  const ppDiff = (j) => (gmRow?.gm != null && finAll[j]?.gm != null ? gmRow.gm - finAll[j].gm : null);
  const fmtPp = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}pp`);
  const gmQoq = ppDiff(gmAt - 1);
  const gmYoy = ppDiff(gmAt - 4);
  const gmInfo = gmRow && (
    <>
      {gmRow.x}　毛利率 <b>{gmRow.gm == null ? '—' : `${gmRow.gm.toFixed(1)}%`}</b>
      　QoQ <b className={signCls(gmQoq)}>{fmtPp(gmQoq)}</b>
      　YoY <b className={signCls(gmYoy)}>{fmtPp(gmYoy)}</b>
    </>
  );
  const epsInfo = selEpsRow && (
    <>
      {qLabel(selEpsRow.q)}　EPS <b>{selEpsRow.eps == null ? '—' : selEpsRow.eps.toFixed(2)}</b>
    </>
  );
  const tLabel = (t) => {
    const hit = epsQs.find((r) => qMid(r.q) === t);
    return hit ? qLabel(hit.q) : new Date(t).toISOString().slice(0, 10);
  };

  const confItem = (c) => (
    <div key={c.key} className={`${styles.confItem} ${c.end >= today ? styles.confUpcoming : ''} ${newConfKeys.has(c.key) ? styles.confNew : ''}`}>
      <div><b>{c.start === c.end ? c.start : `${c.start} ～ ${c.end}`}</b> {c.time}</div>
      <div className={styles.confDesc} title={c.desc}>{c.desc}</div>
      <div className={styles.confMeta}>
        {c.place}
        {c.link && <> · <a href={c.link} target="_blank" rel="noreferrer">公司網站</a></>}
      </div>
    </div>
  );

  return (
    <>
    {/* 待確認提醒：標題下方自成一列，一則一個標籤、靠左排；全部清除接在最後 */}
    {it && alerts.length > 0 && (
      <div className={styles.alertStrip}>
        {alertLabels(alerts).map((a) => (
          <span key={a.key} className={styles.alertTag}>
            {a.label}
            <button type="button" className={styles.alertX} onClick={() => onAck(a.keys)} aria-label={`清除提醒：${a.label}`}>×</button>
          </span>
        ))}
        {alerts.length > 1 && <button type="button" className={styles.alertClearAll} onClick={() => onAck()}>全部清除</button>}
      </div>
    )}

    {s && (
      <div className={styles.statGrid}>
        <div><span>{s.latest.ym} 營收</span><b>{fmtYi(s.latest.revenue)} 億</b></div>
        <div><span>YoY</span><b className={signCls(s.latest.yoy)}>{fmtPct(s.latest.yoy)}</b></div>
        <div><span>{revYtd.year} 累計營收</span><b>{fmtYi(revYtd.sum)} 億</b></div>
        <div><span>{epsYtd ? `${epsYtd.year} 累計 EPS` : '累計 EPS'}</span><b>{epsYtd ? epsYtd.sum.toFixed(2) : '—'}</b></div>
        <div><span>{epsLast ? `${qLabel(epsLast.q)} EPS / 年化` : '最近一季 EPS / 年化'}</span><b>{epsLast ? `${epsLast.eps.toFixed(2)} / ${(epsLast.eps * 4).toFixed(2)}` : '—'}</b></div>
      </div>
    )}

    <div className={styles.chartGrid}>
      <ChartCard title="營收" info={revInfo} empty={!revRows.length && (loading.rev ? '抓取中…' : d?.revErr || '沒有營收資料')}>
        {colors && (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={revRows} margin={{ top: 6, right: 4, left: 4, bottom: 0 }} style={{ cursor: 'pointer' }}
              onClick={(st) => { const x = st?.activeLabel; if (x) setPickRev(x); }}
            >
              <CartesianGrid stroke={colors.grid} vertical={false} />
              {/* 從最新月往回每 3 個月標一次，最新月一定有標籤 */}
              <XAxis
                dataKey="x" {...axis} interval={0} axisLine={{ stroke: colors.grid }}
                tickFormatter={(v, i) => ((revRows.length - 1 - i) % 3 ? '' : v)}
              />
              <YAxis yAxisId="rev" {...axis} axisLine={false} width="auto" />
              <YAxis yAxisId="yoy" orientation="right" {...axis} axisLine={false} width="auto" tickFormatter={(v) => `${v}%`} />
              <Tooltip {...tip} formatter={(v, k) => (k === 'rev' ? [`${v.toFixed(1)} 億`, '營收'] : [v == null ? '—' : `${v.toFixed(1)}%`, 'YoY'])} />
              {/* 點選用整張圖的 onClick（點該月那一欄任何位置都算），長條本身會被停留游標蓋住點不到 */}
              <Bar yAxisId="rev" dataKey="rev" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                {revRows.map((r) => <Cell key={r.x} fill={r.x === selRev ? colors.accent : colors.bar} />)}
              </Bar>
              <Line yAxisId="yoy" dataKey="yoy" stroke={colors.yoy} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard
        boxRef={epsBoxRef} title="EPS" info={epsInfo}
        empty={!epsPrice && (loading.fin ? '抓取中…' : d?.finErr || '沒有財報資料')}
      >
        {colors && epsPrice && (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={epsPrice.rows} margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
              <CartesianGrid stroke={colors.grid} vertical={false} />
              <XAxis
                dataKey="t" type="number" scale="time" domain={epsPrice.domain} ticks={epsPrice.ticks} interval={0}
                tickFormatter={tLabel} {...axis} axisLine={{ stroke: colors.grid }}
              />
              <YAxis yAxisId="eps" {...axis} axisLine={false} width="auto" />
              <YAxis yAxisId="px" orientation="right" {...axis} axisLine={false} width="auto" domain={['auto', 'auto']} />
              <ReferenceLine yAxisId="eps" y={0} stroke={colors.grid} />
              <Tooltip
                {...tip} cursor={false} labelFormatter={tLabel}
                formatter={(v, k) => (k === 'eps' ? [v == null ? '—' : v.toFixed(2), 'EPS'] : [fmtPrice(v), '股價'])}
              />
              <Bar
                yAxisId="eps" dataKey="eps" barSize={epsPrice.barSize} radius={[2, 2, 0, 0]} isAnimationActive={false} style={{ cursor: 'pointer' }}
                onClick={(e) => { const qq = e?.payload?.q; if (qq) setPickEps(qq); }}
              >
                {epsPrice.rows.map((r) => (
                  <Cell key={r.t} fill={r.q && r.q === selEps ? colors.accent : colors.bar} />
                ))}
              </Bar>
              <Line yAxisId="px" dataKey="close" stroke={colors.line} strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <ChartCard
        title="毛利率" info={gmInfo}
        empty={!hasGm && (loading.fin ? '抓取中…' : d?.finErr || (finRows.length ? '金融業無毛利率' : '沒有財報資料'))}
      >
        {colors && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={finRows} margin={{ top: 6, right: 16, left: -12, bottom: 0 }} style={{ cursor: 'pointer' }}
              onClick={(st) => { const x = st?.activeLabel; if (x) setPickGm(x); }}
            >
              <CartesianGrid stroke={colors.grid} vertical={false} />
              {/* 每季都標，不讓 recharts 自動略過而缺一格 */}
              <XAxis dataKey="x" {...axis} interval={0} axisLine={{ stroke: colors.grid }} />
              <YAxis {...axis} axisLine={false} width={46} domain={['auto', 'auto']} tickFormatter={(v) => `${Math.round(v)}%`} />
              <Tooltip {...tip} formatter={(v) => [v == null ? '—' : `${v.toFixed(2)}%`, '毛利率']} />
              <Line
                dataKey="gm" stroke={colors.accent} strokeWidth={2} connectNulls isAnimationActive={false}
                dot={({ cx, cy, index, value }) => (value == null ? null : index === gmIdx
                  ? <circle key={index} cx={cx} cy={cy} r={4.5} fill={colors.accent} stroke={colors.surface} strokeWidth={1.5} />
                  : <circle key={index} cx={cx} cy={cy} r={2.5} fill={colors.surface} stroke={colors.accent} strokeWidth={1.5} />)}
                activeDot={{ r: 4, fill: colors.accent, stroke: colors.surface }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <div className={`${styles.box} ${styles.sideBox}`}>
        <div className={styles.boxHead}>
          <div className={styles.boxTitle}>筆記</div>
          {it && <span className={styles.hint}>訂閱於 {it.addedAt}</span>}
        </div>
        {notes.status === 'loading' && <div className={styles.hint}>讀取中…</div>}
        {notes.status === 'denied' && <div className={styles.hint}>登入後才能看筆記</div>}
        {notes.status === 'error' && <div className={styles.errText}>筆記讀取失敗</div>}
        {notes.err && notes.status === 'ready' && <div className={styles.errText}>筆記儲存失敗：{notes.err}</div>}
        {notes.status === 'ready' && (
        <>
        {/* 無框輸入：只留底線，隨內容自動長高；有字才出現「新增」 */}
        <textarea
          ref={noteRef} className={styles.noteInput} value={note} rows={1} placeholder="新增筆記…"
          onChange={(e) => {
            setNote(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && addNote()}
        />
        {note.trim() && (
          <div className={styles.noteActions}>
            <span className={styles.hint}>⌘/Ctrl + Enter</span>
            <button type="button" className={styles.btn} onClick={addNote} disabled={notes.busy}>新增</button>
          </div>
        )}
        {notes.notes.map((n, i) => (
          <div key={`${n.at}-${i}`} className={styles.note}>
            <div className={styles.noteHead}>
              <span className={styles.noteDate}>{n.at.slice(0, 10)}</span>
              <button type="button" className={styles.noteDel} onClick={() => delNote(n)} aria-label="刪除筆記">×</button>
            </div>
            <div className={styles.noteText}>{n.text}</div>
          </div>
        ))}
        </>
        )}
      </div>

      <div className={`${styles.box} ${styles.confCell}`}>
        <div className={styles.boxTitle}>法說會／座談</div>
        {d?.confErr && <div className={styles.errText}>{d.confErr}（不代表沒有法說）</div>}
        {upcoming.length ? upcoming.map(confItem) : (
          <div className={styles.hint} style={{ marginBottom: 8 }}>{loading.conf ? '抓取中…' : '目前沒有已申報的未來場次'}</div>
        )}
        {past.length > 0 && (
          <details>
            <summary className={styles.hint} style={{ cursor: 'pointer', marginBottom: 6 }}>過去場次（{past.length}）</summary>
            {past.map(confItem)}
          </details>
        )}
      </div>

      <NewsBox stockId={stock.id} d={d} loading={loading.news} newKeys={new Set(alerts.filter((a) => a.news).map((a) => a.key.slice(5)))} />
    </div>

      <div className={styles.modalFoot}>
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" className={styles.btn} onClick={onReload} disabled={Object.values(loading).some(Boolean)}>重新抓取</button>
          {it && onOpenSettings && <button type="button" className={styles.btn} onClick={onOpenSettings}>提醒設定</button>}
        </span>
        {it && onRemove && <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={onRemove} disabled={busy}>取消訂閱</button>}
        {!it && onSubscribe && <button type="button" className={styles.addBtn} onClick={onSubscribe} disabled={busy}>訂閱</button>}
      </div>
    </>
  );
}

/* ── 重大訊息 ─────────────────────────────────────────────────────────── */

function NewsBox({ stockId, d, loading, newKeys }) {
  const [showAll, setShowAll] = useState(false);
  const [openKey, setOpenKey] = useState(null);
  const [detail, setDetail] = useState({}); // key → 文字 | 'loading' | { err }
  const list = d?.news || [];
  const shown = showAll ? list : list.slice(0, 6);

  const toggle = async (n) => {
    if (openKey === n.key) { setOpenKey(null); return; }
    setOpenKey(n.key);
    if (detail[n.key]) return;
    setDetail((p) => ({ ...p, [n.key]: 'loading' }));
    try {
      const text = await fetchNewsDetail(stockId, n);
      setDetail((p) => ({ ...p, [n.key]: text }));
    } catch (e) {
      setDetail((p) => ({ ...p, [n.key]: { err: e?.message || '全文抓取失敗' } }));
    }
  };

  return (
    <div className={`${styles.box} ${styles.confCell}`}>
      <div className={styles.boxHead}>
        <div className={styles.boxTitle}>重大訊息</div>
        {list.length > 0 && <span className={styles.hint}>近三個月 {list.length} 則</span>}
      </div>
      {d?.newsErr && <div className={styles.errText}>{d.newsErr}</div>}
      {!list.length && !d?.newsErr && <div className={styles.hint}>{loading ? '抓取中…' : '近三個月沒有重大訊息'}</div>}
      {shown.map((n) => {
        const txt = detail[n.key];
        return (
          <div key={n.key} className={`${styles.newsItem} ${newKeys.has(n.key) ? styles.confNew : ''}`}>
            <button type="button" className={styles.newsHead} onClick={() => toggle(n)} aria-expanded={openKey === n.key}>
              <span className={styles.newsDate}>{n.date.slice(5).replace('-', '/')}</span>
              <span className={styles.newsSubject}>{n.subject}</span>
            </button>
            {openKey === n.key && (
              <div className={styles.newsBody}>
                {txt === 'loading' ? '讀取全文中…' : txt?.err ? <span className={styles.errText}>{txt.err}</span> : txt}
              </div>
            )}
          </div>
        );
      })}
      {list.length > 6 && (
        <button type="button" className={styles.linkBtn} onClick={() => setShowAll(!showAll)}>
          {showAll ? '收合' : `顯示全部（${list.length}）`}
        </button>
      )}
    </div>
  );
}

/* ── 提醒設定視窗 ─────────────────────────────────────────────────────── */

export function AlertSettings({ it, today, onUpdate, onClose, overlayStyle }) {
  const [newDate, setNewDate] = useState('');
  const tg = { ...DEFAULT_TRIGGERS, ...(it.triggers || {}) };
  // 只存改過的那一項，其餘跟著程式預設走
  // 改了哪個條件，就把該條件刪掉過的提醒放回來，符合的話會再出現
  const setTg = (k, patch) => onUpdate({
    triggers: { ...(it.triggers || {}), [k]: { ...tg[k], ...patch } },
    ack: releaseAck(it.ack, [k]),
  });
  const isDefault = !Object.keys(it.triggers || {}).length && !(it.revisitDates || []).length;
  // 回到預設：條件回預設、回看日清空
  const resetTg = () => window.confirm('提醒設定全部回到預設？（回看日會清空）')
    && onUpdate({ triggers: {}, revisitDates: [], ack: releaseAck(it.ack, Object.keys(it.triggers || {})) });
  const dates = it.revisitDates || [];
  const addDate = (dt) => {
    if (!dt) return;
    // 同一天已在清單也照樣放回提醒（刪掉提醒後再設一次同一天，要再跳出來）
    onUpdate({ revisitDates: [...new Set([...dates, dt])].sort(), ack: (it.ack || []).filter((k) => k !== `revisit:${dt}`) });
    setNewDate('');
  };

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const check = (k, label) => (
    <label className={styles.setRow}>
      <input type="checkbox" checked={!!tg[k].on} onChange={(e) => setTg(k, { on: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
  // 勾選＋數值；填了數字就自動勾起來。extra 可帶其他要一起更新的欄位（例如股價門檻的設定日）
  const numInput = (k, field, wide, extra) => (
    <input
      type="number" step="any" className={`${styles.numInput} ${wide ? styles.numWide : ''}`}
      value={tg[k][field] ?? ''}
      onChange={(e) => setTg(k, { [field]: e.target.value, on: e.target.value !== '' ? true : tg[k].on, ...(extra || {}) })}
    />
  );
  const numRow = (k, before, after, { wide, extra } = {}) => (
    <label className={styles.setRow}>
      <input type="checkbox" checked={!!tg[k].on} onChange={(e) => setTg(k, { on: e.target.checked })} />
      <span>{before}</span>
      {numInput(k, 'value', wide, extra)}
      {after && <span>{after}</span>}
    </label>
  );

  return (
    <div className={`${styles.overlay} ${styles.overlayTop}`} style={overlayStyle} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.settings} role="dialog" aria-modal="true" aria-label="提醒設定">
        <div className={styles.modalHead}>
          <div className={styles.modalTitle}>提醒設定 <span className={styles.stockId}>{it.id} {it.name}</span></div>
          <div className={styles.headBtns}>
            <button type="button" className={styles.btn} onClick={resetTg} disabled={isDefault}>回到預設</button>
            <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="關閉">×</button>
          </div>
        </div>

        <div className={styles.setGrid}>
          <div className={styles.setCol}>
            <div className={styles.setGroup}>
              <div className={styles.setTitle}>回看日</div>
              {dates.length > 0 && (
                <div className={styles.dateChips}>
                  {dates.map((dt) => (
                    <span key={dt} className={`${styles.dateChip} ${dt <= today ? styles.dateChipDue : ''}`}>
                      {dt}
                      <button type="button" onClick={() => onUpdate({ revisitDates: dates.filter((x) => x !== dt) })} aria-label={`刪除 ${dt}`}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className={styles.setRow}>
                <input type="date" className={styles.dateInput} value={newDate} onChange={(e) => setNewDate(e.target.value)} />
                <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => addDate(newDate)} disabled={!newDate}>加入</button>
              </div>
              <div className={styles.setRow}>
                {[3, 6, 12].map((n) => (
                  <button key={n} type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => addDate(addMonths(today, n))}>+{n} 月</button>
                ))}
              </div>
            </div>
            <div className={styles.setGroup}>
              <div className={styles.setTitle}>事件</div>
              {check('newConf', '新申報法說會／座談')}
              <div className={styles.setSub}>重大訊息（設定關鍵字才提醒）</div>
              <label className={styles.setRow}>
                <span className={styles.setLabel}>關鍵字</span>
                <input
                  className={`${styles.textInput}`} placeholder="例：擴產、併購、庫藏股" value={tg.newNews.include}
                  onChange={(e) => setTg('newNews', { include: e.target.value })}
                />
              </label>
              <label className={styles.setRow}>
                <span className={styles.setLabel}>排除含</span>
                <input
                  className={`${styles.textInput}`} placeholder="例：代子公司、固定收益證券" value={tg.newNews.exclude}
                  onChange={(e) => setTg('newNews', { exclude: e.target.value })}
                />
              </label>
              <div className={styles.setHint}>多個關鍵字用「、」分隔</div>
            </div>
          </div>

          <div className={styles.setCol}>
            <div className={styles.setGroup}>
              <div className={styles.setTitle}>營收</div>
              {check('revNew', '每月營收公布時')}
              {check('revAth', '單月營收創新高')}
              {numRow('revAbove', '單月營收達', '億', { wide: true })}
              {numRow('yoyAbove', 'YoY 達', '%')}
              {numRow('yoyUpPp', 'YoY 較上月 +', '百分點')}
              {numRow('revMom', 'MoM 達', '%')}
            </div>
          </div>

          <div className={styles.setCol}>
            <div className={styles.setGroup}>
              <div className={styles.setTitle}>財報</div>
              {check('finNew', '每季財報公布時')}
              {numRow('gmAbove', '毛利率達', '%')}
              {numRow('gmUpPp', '毛利率較前季 +', '百分點')}
              {numRow('epsAbove', '單季 EPS 達', '元')}
              {check('epsAth', '單季 EPS 創新高')}
              {numRow('epsYoy', 'EPS 較去年同季成長', '%')}
              {numRow('epsQoq', 'EPS 較上季成長', '%')}
            </div>
            <div className={styles.setGroup}>
              <div className={styles.setTitle}>股價</div>
              {numRow('priceAbove', '漲到', '', { wide: true, extra: { since: today } })}
              {numRow('priceBelow', '跌到', '', { wide: true, extra: { since: today } })}
              <div className={styles.setHint} style={{ margin: '-4px 0 8px' }}>漲到／跌到：盤中摸到就算，只提醒一次</div>
              {numRow('priceRun', '一週漲幅達', '%')}
              {numRow('priceRunM', '一個月漲幅達', '%')}
              <label className={styles.setRow}>
                <input type="checkbox" checked={!!tg.priceRun2.on} onChange={(e) => setTg('priceRun2', { on: e.target.checked })} />
                {numInput('priceRun2', 'days')}
                <span>日漲幅達</span>
                {numInput('priceRun2', 'value')}
                <span>%</span>
              </label>
            </div>
          </div>
        </div>

        <div className={styles.setFoot}>
          <span />
          <button type="button" className={styles.addBtn} onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
