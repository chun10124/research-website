/* src/components/SubscriptionPage.jsx */

/**
 * 訂閱：等半年～一年後才可能有機會的股票，定期看營收、財報、法說。
 * 與「追蹤表」(stockWatchlist) 完全分開——不進每日同步，只在開頁時抓（有快取）。
 *
 * 版面：主頁只有個股卡片，「訂閱」輸入框佔卡片格線的右上格。
 *       點卡片開個股視窗（營收｜EPS＋股價，左下毛利率、法說，右下筆記縱跨兩列）；提醒設定是視窗裡另開的小視窗。
 *
 * 提醒：computeAlerts 算出目前成立的條件，扣掉 item.ack（已確認）就是待確認提醒。
 *       有提醒的卡片排最前面並發光，要在個股視窗按「確認」才會熄。
 *       各資料第一次載入時（item.base[src] 為 false）把當下成立的條件直接記為已確認，
 *       所以剛訂閱時就成立的條件不會跳提醒。
 *
 * 儲存：Firestore subscriptions/main（僅擁有者）。規則尚未發布時會 permission-denied，
 *       此時退回 localStorage；規則發布後第一次開頁會把本機資料搬上去。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDoc, setDoc } from 'firebase/firestore';
import {
  ResponsiveContainer, ComposedChart, LineChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ReferenceLine,
} from 'recharts';
import { SUBSCRIPTIONS_DOC_REF } from '../utils/firebaseConfig';
import { fetchTaiwanStockListFromDb } from '../features/StockAnalysis/api/rsStockList';
import {
  loadRevenueBatch, loadFinancialsBatch, fetchConferences, fetchQuote, fetchNews, fetchNewsDetail, computeRevenueStats, computeAlerts,
  runLimited, clearSubscriptionCache, DEFAULT_TRIGGERS,
} from '../features/Subscriptions/subscriptionApi';
import styles from './SubscriptionPage.module.css';

const LOCAL_KEY = 'rw-subscriptions-local';
const MAX_ITEMS = 50;
const SOURCES = ['rev', 'fin', 'price', 'conf', 'news'];

const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const nowStamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16);
const fmtYi = (v) => (v == null ? '—' : (v / 1e8).toLocaleString('zh-TW', { maximumFractionDigits: v / 1e8 >= 100 ? 0 : 2 }));
const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const fmtPrice = (v) => (v == null ? '—' : v.toLocaleString('zh-TW', { maximumFractionDigits: 2 }));
const signCls = (v) => (v == null ? styles.muted : v > 0 ? styles.up : v < 0 ? styles.down : '');
const ymLabel = (ym) => (ym ? `${ym.slice(2, 4)}/${ym.slice(5)}` : '—');
const qLabel = (q) => (q ? `${q.slice(2, 4)}${q.slice(5)}` : ''); // 2026-Q2 → 26Q2
const addMonths = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/* ── 儲存層 ─────────────────────────────────────────────────────────── */

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')?.items || null; } catch (_) { return null; }
}
function writeLocal(items) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ items })); } catch (_) {}
}
const isDenied = (e) => e?.code === 'permission-denied' || /permission/i.test(e?.message || '');

/** 舊版資料轉新格式：thesis 併入筆記、筆記加時間、seen 改成 ack/base。 */
function migrate(it) {
  let out = it;
  if (!out.ack) {
    const notes = (out.notes || []).map((n) => ({ at: n.at || `${n.date} 00:00`, text: n.text }));
    if (out.thesis) notes.push({ at: `${out.addedAt} 00:00`, text: out.thesis });
    const { thesis, seen, ...rest } = out; // eslint-disable-line no-unused-vars
    out = { ...rest, notes: notes.sort((a, b) => b.at.localeCompare(a.at)), ack: [], base: {} };
  }
  if (!Array.isArray(out.revisitDates)) {
    // 回看日由單一 revisitDate 改成可多個
    const { revisitDate, ...rest } = out;
    out = { ...rest, revisitDates: revisitDate ? [revisitDate] : [] };
  }
  if (out.triggersV !== 2) {
    // v2：triggers 只存使用者改過的條件，其餘跟著程式預設走（預設會調整，例如 EPS 創新高改為預設開）。
    // 舊資料整包存了當時的預設值，這裡只留有填數字或關鍵字的條件
    const kept = Object.fromEntries(Object.entries(out.triggers || {}).filter(([, c]) =>
      c && ['value', 'include', 'exclude', 'days'].some((f) => c[f] != null && String(c[f]).trim() !== '')));
    out = { ...out, triggers: kept, triggersV: 2 };
  }
  return out;
}

/**
 * 已確認清單瘦身：營收／財報／區間漲幅這類 key 帶期別，超過 13 個月的不可能再出現，刪掉；
 * 價位門檻與回看日若已不在目前設定裡也刪掉。法說／重訊另外依來源清單清。
 */
function pruneAck(ack, it, today) {
  const cut = new Date(`${today}T00:00:00Z`);
  cut.setUTCMonth(cut.getUTCMonth() - 13);
  const cutDate = cut.toISOString().slice(0, 10);
  const cutYm = cutDate.slice(0, 7);
  const t = it.triggers || {};
  const levels = new Set([`price:above:${Number(t.priceAbove?.value)}`, `price:below:${Number(t.priceBelow?.value)}`]);
  const dates = new Set(it.revisitDates || []);
  return ack.filter((k) => {
    const last = k.slice(k.lastIndexOf(':') + 1);
    if (k.startsWith('rev:')) return last >= cutYm;
    if (k.startsWith('fin:')) {
      const [y, q] = last.split('-Q');
      return `${y}-${String(Number(q) * 3).padStart(2, '0')}` >= cutYm;
    }
    if (k.startsWith('price:above:') || k.startsWith('price:below:')) return levels.has(k);
    if (k.startsWith('price:')) return last >= cutDate;
    if (k.startsWith('revisit:')) return dates.has(last);
    return true;
  });
}

/** 重訊提醒可能一次很多則，卡片與標題列合併成一個「新重訊 N 則」 */
function alertLabels(alerts) {
  const news = alerts.filter((a) => a.news);
  const rest = alerts.filter((a) => !a.news).map((a) => ({ key: a.key, label: a.label, keys: [a.key] }));
  if (news.length) rest.push({ key: 'news', label: `新重訊 ${news.length} 則`, keys: news.map((a) => a.key) });
  return rest;
}

/* 讀 CSS 變數給 recharts（SVG 屬性不吃 var()），暗色切換時重讀 */
function useThemeColors(ref) {
  const [c, setC] = useState(null);
  useEffect(() => {
    const read = () => {
      if (!ref.current) return;
      const cs = getComputedStyle(ref.current);
      const g = (n) => cs.getPropertyValue(n).trim();
      setC({
        bar: g('--sub-bar'), accent: g('--sub-accent'), line: g('--sub-line'), yoy: g('--sub-yoy'), down: g('--sub-down'),
        grid: g('--sub-grid'), text: g('--app-text-soft'), surface: g('--app-surface'), border: g('--app-border'),
      });
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [ref]);
  return c;
}

/* ── 頁面 ─────────────────────────────────────────────────────────────── */

export default function SubscriptionPage() {
  const rootRef = useRef(null);
  const colors = useThemeColors(rootRef);
  const [items, setItems] = useState(null);
  const [mode, setMode] = useState('firestore'); // 'firestore' | 'local'
  const [saveErr, setSaveErr] = useState(null);
  const [data, setData] = useState({}); // id → { rev, fin, conf, quote, *Err, loading: {src: bool} }
  const [stockList, setStockList] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [addCode, setAddCode] = useState('');
  const [addErr, setAddErr] = useState('');
  const today = todayYmd();
  const itemsRef = useRef(null);
  itemsRef.current = items;

  // 載入清單
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(SUBSCRIPTIONS_DOC_REF);
        let list = snap.exists() ? (snap.data().items || []) : [];
        const local = readLocal();
        if (!list.length && local?.length) {
          // 規則剛發布：把先前暫存在本機的清單搬上 Firestore
          await setDoc(SUBSCRIPTIONS_DOC_REF, { items: local, updatedAt: new Date().toISOString() });
          list = local;
        }
        if (!cancelled) { setItems(list.map(migrate)); setMode('firestore'); }
      } catch (e) {
        if (!cancelled) {
          setItems((readLocal() || []).map(migrate));
          setMode('local');
          if (!isDenied(e)) setSaveErr(`讀取 Firestore 失敗：${e?.message || e}`);
        }
      }
    })();
    fetchTaiwanStockListFromDb().then((l) => !cancelled && setStockList(l || []));
    return () => { cancelled = true; };
  }, []);

  const persist = useCallback(async (next) => {
    setItems(next);
    writeLocal(next); // 本機永遠留一份，Firestore 失敗時不丟資料
    if (mode !== 'firestore') return;
    try {
      await setDoc(SUBSCRIPTIONS_DOC_REF, { items: next, updatedAt: new Date().toISOString() });
      setSaveErr(null);
    } catch (e) {
      if (isDenied(e)) setMode('local');
      else setSaveErr(`儲存失敗（已暫存本機）：${e?.message || e}`);
    }
  }, [mode]);

  const updateItem = useCallback((id, patch) => {
    const cur = itemsRef.current || [];
    persist(cur.map((it) => (it.id === id ? { ...it, ...(typeof patch === 'function' ? patch(it) : patch) } : it)));
  }, [persist]);

  // 抓資料
  const setPart = (id, patch) => setData((p) => {
    const cur = p[id] || { loading: {} };
    return { ...p, [id]: { ...cur, ...patch, loading: { ...cur.loading, ...(patch.loading || {}) } } };
  });

  const loadBatches = useCallback(async (stocks, force = false) => {
    stocks.forEach((s) => setPart(s.id, { loading: { rev: true, fin: true } }));
    const revP = loadRevenueBatch(stocks, { force }).then(({ series, errors }) => {
      stocks.forEach((s) => setPart(s.id, { rev: series[s.id]?.length ? series[s.id] : null, revErr: errors[s.id] || null, loading: { rev: false } }));
    }).catch((e) => stocks.forEach((s) => setPart(s.id, { revErr: e?.message || '營收抓取失敗', loading: { rev: false } })));
    const finP = loadFinancialsBatch(stocks, { force }).then(({ quarters, errors }) => {
      stocks.forEach((s) => setPart(s.id, { fin: quarters[s.id] || [], finErr: errors[s.id] || null, loading: { fin: false } }));
    }).catch((e) => stocks.forEach((s) => setPart(s.id, { finErr: e?.message || '財報抓取失敗', loading: { fin: false } })));
    await Promise.all([revP, finP]);
  }, []);

  const loadSingles = useCallback(async (s, force = false) => {
    setPart(s.id, { loading: { conf: true, quote: true, news: true } });
    const [conf, quote, news] = await Promise.allSettled([
      fetchConferences(s.id, s.market, { force }),
      fetchQuote(s.id, s.market, { force }),
      fetchNews(s.id, { force }),
    ]);
    setPart(s.id, {
      ...(conf.status === 'fulfilled' ? { conf: conf.value, confErr: null } : { confErr: conf.reason?.message || '法說抓取失敗' }),
      ...(quote.status === 'fulfilled' ? { quote: quote.value, quoteErr: null } : { quoteErr: quote.reason?.message || '股價抓取失敗' }),
      ...(news.status === 'fulfilled' ? { news: news.value, newsErr: null } : { newsErr: news.reason?.message || '重訊抓取失敗' }),
      loading: { conf: false, quote: false, news: false },
    });
  }, []);

  const loadedIds = useRef(new Set());
  useEffect(() => {
    if (!items) return;
    const todo = items.filter((it) => !loadedIds.current.has(it.id));
    if (!todo.length) return;
    todo.forEach((it) => loadedIds.current.add(it.id));
    loadBatches(todo);
    runLimited(todo, 2, (it) => loadSingles(it)); // 每檔同時打法說／股價／重訊 3 個請求，總並行約 6
  }, [items, loadBatches, loadSingles]);

  // 各資料第一次載入 → 當下成立的條件記為已確認；並清掉已不存在的法說 key
  useEffect(() => {
    if (!items?.length) return;
    let changed = false;
    const next = items.map((it) => {
      const d = data[it.id];
      if (!d) return it;
      const loaded = { rev: !!d.rev, fin: !!d.fin, price: !!d.quote, conf: !!d.conf, news: !!d.news };
      const newSrc = SOURCES.filter((s) => loaded[s] && !it.base?.[s]);
      let ack = it.ack || [];
      // 已不在來源清單裡的法說／重訊 key 從已確認清掉，其餘過期的也清，避免 ack 無限長大
      const trimmed = pruneAck(ack, it, today);
      if (trimmed.length !== ack.length) ack = trimmed;
      [['conf', d.conf], ['news', d.news]].forEach(([pre, list]) => {
        if (!list) return;
        const live = new Set(list.map((c) => `${pre}:${c.key}`));
        const pruned = ack.filter((k) => !k.startsWith(`${pre}:`) || live.has(k));
        if (pruned.length !== ack.length) ack = pruned;
      });
      if (!newSrc.length && ack === it.ack) return it;
      const cand = computeAlerts(it, d, today).filter((a) => newSrc.includes(a.src)).map((a) => a.key);
      changed = true;
      return {
        ...it,
        ack: [...new Set([...ack, ...cand])],
        base: { ...(it.base || {}), ...Object.fromEntries(newSrc.map((s) => [s, true])) },
      };
    });
    if (changed) persist(next);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // 新增
  const stockMap = useMemo(() => new Map((stockList || []).map((s) => [String(s.id), s])), [stockList]);
  const addPreview = stockMap.get(addCode.trim());
  const addStock = () => {
    const id = addCode.trim();
    setAddErr('');
    if (!/^\d{4,6}[A-Z]?$/.test(id)) return setAddErr('代號格式不對');
    if ((items || []).some((it) => it.id === id)) return setAddErr('已經訂閱了');
    if ((items || []).length >= MAX_ITEMS) return setAddErr(`上限 ${MAX_ITEMS} 檔`);
    const s = stockMap.get(id);
    const item = {
      id, name: s?.name || id, market: s?.market || null, addedAt: today,
      revisitDates: [], triggers: {}, triggersV: 2, notes: [], ack: [], base: {},
    };
    persist([...(items || []), item]);
    setAddCode('');
  };

  const removeStock = (id) => {
    const it = items.find((x) => x.id === id);
    if (!window.confirm(`取消訂閱 ${id} ${it?.name || ''}？筆記會一起刪除。`)) return;
    loadedIds.current.delete(id);
    setOpenId(null);
    persist(items.filter((x) => x.id !== id));
  };

  // 有待確認提醒的排最前面，其餘照訂閱順序
  const cards = useMemo(() => (items || [])
    .map((it, i) => {
      const d = data[it.id];
      const ack = new Set(it.ack || []);
      const alerts = computeAlerts(it, d, today).filter((a) => !ack.has(a.key));
      return { it, i, d, alerts, stats: d?.rev ? computeRevenueStats(d.rev) : null };
    })
    .sort((a, b) => (b.alerts.length > 0) - (a.alerts.length > 0) || a.i - b.i), [items, data, today]);

  if (!items) return <div className={styles.root} ref={rootRef}><div className={styles.empty}>載入訂閱清單中…</div></div>;

  const open = openId && cards.find((c) => c.it.id === openId);

  return (
    <div className={styles.root} ref={rootRef}>
      {saveErr && <div className={styles.notice}>{saveErr}</div>}

      {/* 訂閱框放在卡片格線的右上格，和第一排卡片同一列，不另佔一排 */}
      <div className={styles.cardGrid}>
        {cards.map((c) => <StockCard key={c.it.id} {...c} onOpen={() => setOpenId(c.it.id)} />)}
        <div className={styles.addCell}>
          <div className={styles.addBox}>
            <input
              className={styles.codeInput} placeholder="股號" value={addCode} inputMode="numeric" aria-label="股號"
              onChange={(e) => { setAddCode(e.target.value.toUpperCase()); setAddErr(''); }}
              onKeyDown={(e) => e.key === 'Enter' && addStock()}
            />
            <button type="button" className={styles.addBtn} onClick={addStock}>訂閱</button>
            {(addErr || addPreview) && (
              <div className={styles.addHint} style={addErr ? { color: 'var(--sub-fire)' } : undefined}>{addErr || addPreview.name}</div>
            )}
          </div>
        </div>
      </div>
      {!cards.length && <div className={styles.empty}>還沒有訂閱任何股票，從右上角輸入股號</div>}

      {open && (
        <StockModal
          key={open.it.id}
          it={open.it} d={open.d} stats={open.stats} alerts={open.alerts} colors={colors} today={today}
          onClose={() => setOpenId(null)}
          onUpdate={(patch) => updateItem(open.it.id, patch)}
          onAck={(keys) => updateItem(open.it.id, (cur) => ({ ack: [...new Set([...(cur.ack || []), ...(keys || open.alerts.map((a) => a.key))])] }))}
          onReload={() => {
            clearSubscriptionCache(open.it.id);
            loadBatches([open.it], true);
            loadSingles(open.it, true);
          }}
          onRemove={() => removeStock(open.it.id)}
        />
      )}
    </div>
  );
}

/* ── 卡片 ─────────────────────────────────────────────────────────────── */

function StockCard({ it, d, alerts, onOpen }) {
  const q = d?.quote;
  const loading = d?.loading?.quote;
  return (
    <button type="button" className={`${styles.card} ${alerts.length ? styles.cardAlert : ''}`} onClick={onOpen}>
      <div className={styles.cardTop}>
        <div className={styles.cardName}>
          <span className={styles.stockName}>{it.name}</span>
          <span className={styles.stockId}>{it.id}</span>
        </div>
      </div>

      <div className={styles.cardPrice}>
        <span className={styles.priceNum}>{!q && loading ? '…' : fmtPrice(q?.price)}</span>
        {q && <span className={`${styles.priceChg} ${signCls(q.changePct)}`}>{fmtPct(q.changePct)}</span>}
      </div>

      <div className={styles.cardStats}>
        <div className={styles.statLine}><span className={styles.muted}>近一週</span><span className={signCls(q?.chg1w)}>{fmtPct(q?.chg1w)}</span></div>
        <div className={styles.statLine}><span className={styles.muted}>近一月</span><span className={signCls(q?.chg1m)}>{fmtPct(q?.chg1m)}</span></div>
      </div>

      {alerts.length > 0 && (
        <div className={styles.cardAlerts}>{alertLabels(alerts).map((a) => <span key={a.key}>{a.label}</span>)}</div>
      )}
    </button>
  );
}

/* ── 個股視窗 ─────────────────────────────────────────────────────────── */

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

function StockModal({ it, d, stats: s, alerts, colors, today, onClose, onUpdate, onAck, onReload, onRemove }) {
  const [showSettings, setShowSettings] = useState(false);
  // 長條點選：被選的那根變藍並在標題列顯示該期資訊；沒點過（null）時預設選最新一期
  const [pickRev, setPickRev] = useState(null); // 營收月 x 標籤
  const [pickEps, setPickEps] = useState(null); // 季度 '2026-Q2'
  const [note, setNote] = useState('');
  const noteRef = useRef(null);
  const [epsBoxRef, epsBoxW] = useWidth();
  const q = d?.quote;
  const loading = d?.loading || {};
  const confs = d?.conf || [];
  const upcoming = confs.filter((c) => c.end >= today).sort((a, b) => a.start.localeCompare(b.start));
  const past = confs.filter((c) => c.end < today).slice(0, 6);
  const newConfKeys = new Set(alerts.filter((a) => a.src === 'conf').map((a) => a.key.slice(5)));

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !showSettings) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, showSettings]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const addNote = () => {
    const text = note.trim();
    if (!text) return;
    onUpdate((cur) => ({ notes: [{ at: nowStamp(), text }, ...(cur.notes || [])] }));
    setNote('');
    if (noteRef.current) noteRef.current.style.height = 'auto'; // 自動長高的輸入框縮回一行
  };
  const delNote = (i) => {
    if (!window.confirm('刪除這則筆記？')) return;
    onUpdate((cur) => ({ notes: (cur.notes || []).filter((_, j) => j !== i) }));
  };

  const tip = colors && {
    contentStyle: { background: colors.surface, border: `1px solid ${colors.border}`, fontSize: 11, padding: '4px 8px' },
    labelStyle: { color: colors.text },
    cursor: { fill: colors.grid, fillOpacity: 0.5, stroke: colors.grid }, // 預設淺灰底在暗色下很刺眼
  };
  const axis = colors && { tick: { fontSize: 10, fill: colors.text }, tickLine: false };
  const revRows = (s?.rows || []).slice(-24).map((r) => ({ x: ymLabel(r.ym), rev: r.revenue / 1e8, yoy: r.yoy, mom: r.mom }));
  const finRows = (d?.fin || []).slice(-12).map((r) => ({ x: qLabel(r.q), gm: r.gm, eps: r.eps }));
  const hasGm = finRows.some((r) => r.gm != null);
  // EPS＋股價：共用時間軸（毫秒）。EPS 長條放在該季中間（2、5、8、11 月 15 日），股價是週收盤，
  // 只取第一個顯示季度（財報抓取的起點，今年往回 2 年的 Q1）之後的部分，兩者才對得齊。
  const qMid = (k) => { const [y, qq] = k.split('-Q').map(Number); return Date.UTC(y, (qq - 1) * 3 + 1, 15); };
  const qStart = (k) => { const [y, qq] = k.split('-Q').map(Number); return Date.UTC(y, (qq - 1) * 3, 1); };
  const qEnd = (k) => { const [y, qq] = k.split('-Q').map(Number); return Date.UTC(y, qq * 3, 1); };
  const epsQs = d?.fin || [];
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
      {selRevRow.x}　營收 <b>{selRevRow.rev.toFixed(2)} 億</b>
      　YoY <b className={signCls(selRevRow.yoy)}>{fmtPct(selRevRow.yoy)}</b>
      　MoM <b className={signCls(selRevRow.mom)}>{fmtPct(selRevRow.mom)}</b>
    </>
  );
  const selEpsRow = selEps && epsQs.find((r) => r.q === selEps);
  const epsInfo = selEpsRow && (() => {
    // 該季最後一個週收盤當作季末股價
    const end = new Date(qEnd(selEpsRow.q) - 86400000).toISOString().slice(0, 10);
    const px = [...(q?.series || [])].reverse().find((p) => p.date <= end);
    return (
      <>
        {qLabel(selEpsRow.q)}　EPS <b>{selEpsRow.eps == null ? '—' : selEpsRow.eps.toFixed(2)}</b>
        {selEpsRow.eps != null && <>（年化 {(selEpsRow.eps * 4).toFixed(2)}）</>}
        {px && <>　季末股價 <b>{fmtPrice(px.close)}</b></>}
      </>
    );
  })();
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
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={`${it.id} ${it.name}`}>
        <div className={styles.modalHead}>
          <div>
            <div className={styles.modalTitle}>{it.name} <span className={styles.stockId}>{it.id}</span></div>
            <div className={styles.modalPrice}>
              <span className={styles.priceNum}>{fmtPrice(q?.price)}</span>
              {q && <span className={signCls(q.changePct)}>{q.change > 0 ? '+' : ''}{fmtPrice(q.change)}（{fmtPct(q.changePct)}）</span>}
              {q && <span className={styles.hint}>{q.date} 收盤</span>}
            </div>
          </div>
          <div className={styles.headBtns}>
            {/* 待確認提醒：標籤＋確認，擠在標題列右側，不另佔一整列 */}
            {alerts.length > 0 && (
              <div className={styles.alertInline}>
                {alertLabels(alerts).map((a) => (
                  <span key={a.key} className={styles.alertTag}>
                    {a.label}
                    <button type="button" className={styles.alertX} onClick={() => onAck(a.keys)} aria-label={`清除提醒：${a.label}`}>×</button>
                  </span>
                ))}
                {alerts.length > 1 && <button type="button" className={styles.ackBtn} onClick={() => onAck()}>全部清除</button>}
              </div>
            )}
            <button type="button" className={styles.btn} onClick={() => setShowSettings(true)}>提醒設定</button>
            <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="關閉">×</button>
          </div>
        </div>

        {s && (
          <div className={styles.statGrid}>
            <div><span>{s.latest.ym} 營收</span><b>{fmtYi(s.latest.revenue)} 億</b></div>
            <div><span>YoY</span><b className={signCls(s.latest.yoy)}>{fmtPct(s.latest.yoy)}</b></div>
            <div><span>{epsYtd ? `${epsYtd.year} 累計 EPS` : '累計 EPS'}</span><b>{epsYtd ? epsYtd.sum.toFixed(2) : '—'}</b></div>
            <div><span>{epsLast ? `${qLabel(epsLast.q)} EPS / 年化` : '最近一季 EPS / 年化'}</span><b>{epsLast ? `${epsLast.eps.toFixed(2)} / ${(epsLast.eps * 4).toFixed(2)}` : '—'}</b></div>
          </div>
        )}

        <div className={styles.chartGrid}>
          <ChartCard title="營收 ＋ YoY" info={revInfo} empty={!revRows.length && (loading.rev ? '抓取中…' : d?.revErr || '沒有營收資料')}>
            {colors && (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={revRows} margin={{ top: 6, right: 0, left: -12, bottom: 0 }} style={{ cursor: 'pointer' }}
                  onClick={(st) => { const x = st?.activeLabel; if (x) setPickRev(x); }}
                >
                  <CartesianGrid stroke={colors.grid} vertical={false} />
                  <XAxis dataKey="x" {...axis} interval={3} axisLine={{ stroke: colors.grid }} />
                  <YAxis yAxisId="rev" {...axis} axisLine={false} width={48} />
                  <YAxis yAxisId="yoy" orientation="right" {...axis} axisLine={false} width={42} tickFormatter={(v) => `${v}%`} />
                  <Tooltip {...tip} formatter={(v, k) => (k === 'rev' ? [`${v.toFixed(2)} 億`, '營收'] : [v == null ? '—' : `${v.toFixed(1)}%`, 'YoY'])} />
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
            boxRef={epsBoxRef} title="EPS ＋ 股價" info={epsInfo}
            empty={!epsPrice && (loading.fin ? '抓取中…' : d?.finErr || '沒有財報資料')}
          >
            {colors && epsPrice && (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={epsPrice.rows} margin={{ top: 6, right: 0, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke={colors.grid} vertical={false} />
                  <XAxis
                    dataKey="t" type="number" scale="time" domain={epsPrice.domain} ticks={epsPrice.ticks}
                    tickFormatter={tLabel} {...axis} axisLine={{ stroke: colors.grid }}
                  />
                  <YAxis yAxisId="eps" {...axis} axisLine={false} width={46} />
                  <YAxis yAxisId="px" orientation="right" {...axis} axisLine={false} width={52} domain={['auto', 'auto']} />
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
            title="毛利率"
            empty={!hasGm && (loading.fin ? '抓取中…' : d?.finErr || (finRows.length ? '金融業無毛利率' : '沒有財報資料'))}
          >
            {colors && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={finRows} margin={{ top: 6, right: 4, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke={colors.grid} vertical={false} />
                  <XAxis dataKey="x" {...axis} axisLine={{ stroke: colors.grid }} />
                  <YAxis {...axis} axisLine={false} width={46} domain={['auto', 'auto']} tickFormatter={(v) => `${Math.round(v)}%`} />
                  <Tooltip {...tip} formatter={(v) => [v == null ? '—' : `${v.toFixed(2)}%`, '毛利率']} />
                  <Line dataKey="gm" stroke={colors.accent} strokeWidth={2} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <div className={`${styles.box} ${styles.sideBox}`}>
            <div className={styles.boxHead}>
              <div className={styles.boxTitle}>筆記</div>
              <span className={styles.hint}>訂閱於 {it.addedAt}</span>
            </div>
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
                <button type="button" className={styles.btn} onClick={addNote}>新增</button>
              </div>
            )}
            {(it.notes || []).map((n, i) => (
              <div key={`${n.at}-${i}`} className={styles.note}>
                <div className={styles.noteHead}>
                  <span className={styles.noteDate}>{n.at.slice(0, 10)}</span>
                  <button type="button" className={styles.noteDel} onClick={() => delNote(i)} aria-label="刪除筆記">×</button>
                </div>
                <div className={styles.noteText}>{n.text}</div>
              </div>
            ))}
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

          <NewsBox it={it} d={d} loading={loading.news} newKeys={new Set(alerts.filter((a) => a.news).map((a) => a.key.slice(5)))} />
        </div>

        <div className={styles.modalFoot}>
          <button type="button" className={styles.btn} onClick={onReload} disabled={Object.values(loading).some(Boolean)}>重新抓取</button>
          <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={onRemove}>取消訂閱</button>
        </div>
      </div>

      {showSettings && <AlertSettings it={it} today={today} onUpdate={onUpdate} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

/* ── 重大訊息 ─────────────────────────────────────────────────────────── */

function NewsBox({ it, d, loading, newKeys }) {
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
      const text = await fetchNewsDetail(it.id, n);
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

function AlertSettings({ it, today, onUpdate, onClose }) {
  const [newDate, setNewDate] = useState('');
  const tg = { ...DEFAULT_TRIGGERS, ...(it.triggers || {}) };
  const setTg = (k, patch) => onUpdate({ triggers: { ...tg, [k]: { ...tg[k], ...patch } } });
  const dates = it.revisitDates || [];
  const addDate = (dt) => {
    if (!dt || dates.includes(dt)) return;
    onUpdate({ revisitDates: [...dates, dt].sort() });
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
    <div className={`${styles.overlay} ${styles.overlayTop}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.settings} role="dialog" aria-modal="true" aria-label="提醒設定">
        <div className={styles.modalHead}>
          <div className={styles.modalTitle}>提醒設定 <span className={styles.stockId}>{it.id} {it.name}</span></div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="關閉">×</button>
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
