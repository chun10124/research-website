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
import { SUBSCRIPTIONS_DOC_REF } from '../utils/firebaseConfig';
import { fetchTaiwanStockListFromDb } from '../features/StockAnalysis/api/rsStockList';
import {
  loadRevenueBatch, loadFinancialsBatch, fetchConferences, fetchQuote, fetchNews, computeRevenueStats, computeAlerts,
  runLimited, clearSubscriptionCache,
} from '../features/Subscriptions/subscriptionApi';
import { MAX_ITEMS, readLocal, writeLocal, isDenied, migrate } from '../features/Subscriptions/subscriptionStore';
import StockFundamentals, {
  AlertSettings, alertLabels, useThemeColors, todayYmd, fmtPct, fmtPrice, signCls,
} from './StockFundamentals';
import styles from './SubscriptionPage.module.css';

const SORT_KEY = 'rw-subscriptions-sort';
const SOURCES = ['rev', 'fin', 'price', 'conf', 'news'];

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
  // 卡片排序：週漲幅（預設）／月漲幅／自訂（拖曳卡片決定順序），記在這台裝置
  const [sortBy, setSortBy] = useState(() => {
    try { const v = localStorage.getItem(SORT_KEY); return v === 'm' || v === 'c' ? v : 'w'; } catch (_) { return 'w'; }
  });
  const [drag, setDrag] = useState(null); // 自訂排列拖曳中：{ id, over }（over＝目標格位）
  // 卡片區寬度（算自訂排列一列幾欄用）。卡片區在清單載入後才出現，所以用 callback ref 掛觀察器
  const [gridW, setGridW] = useState(0);
  const gridRo = useRef(null);
  const gridEl = useRef(null);
  const gridRef = useCallback((el) => {
    gridRo.current?.disconnect();
    gridEl.current = el;
    if (!el) return;
    gridRo.current = new ResizeObserver(([e]) => setGridW(e.contentRect.width));
    gridRo.current.observe(el);
  }, []);
  const changeSort = (v) => {
    setSortBy(v);
    try { localStorage.setItem(SORT_KEY, v); } catch (_) {}
  };
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

  // 每種資料抓到就先顯示，不互相等（股價快取有效時不必等法說／重訊）
  const loadOne = (id, key, p, errMsg) => {
    setPart(id, { loading: { [key]: true } });
    return p.then(
      (v) => setPart(id, { [key]: v, [`${key}Err`]: null, loading: { [key]: false } }),
      (e) => setPart(id, { [`${key}Err`]: e?.message || errMsg, loading: { [key]: false } }),
    );
  };
  const loadQuote = useCallback((s, force = false) => loadOne(s.id, 'quote', fetchQuote(s.id, s.market, { force }), '股價抓取失敗'), []);
  const loadMops = useCallback((s, force = false) => Promise.all([
    loadOne(s.id, 'conf', fetchConferences(s.id, s.market, { force }), '法說抓取失敗'),
    loadOne(s.id, 'news', fetchNews(s.id, { force }), '重訊抓取失敗'),
  ]), []);

  const loadedIds = useRef(new Set());
  useEffect(() => {
    if (!items) return;
    const todo = items.filter((it) => !loadedIds.current.has(it.id));
    if (!todo.length) return;
    todo.forEach((it) => loadedIds.current.add(it.id));
    loadBatches(todo);
    // 股價（Yahoo）與法說／重訊（觀測站）各排各的隊：快取命中的股價立刻出來，不被觀測站拖住。
    // 並行數依 2026-09-30 實測（24 檔，全 0 錯誤）：Yahoo 6 檔 1.3s（8 不再變快）；
    // 觀測站每檔法說＋重訊同時打，4 檔 ≈ 同時 8 個請求（實測 8 並行 3.2s，2 並行 9.2s）
    runLimited(todo, 6, (it) => loadQuote(it));
    runLimited(todo, 4, (it) => loadMops(it));
  }, [items, loadBatches, loadQuote, loadMops]);

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
  // 輸入已訂閱的股號：捲到那張卡片並短暫標亮
  const [flashId, setFlashId] = useState(null);
  const jumpTo = (id) => {
    setAddCode('');
    const el = rootRef.current?.querySelector(`[data-stock-id="${id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashId(id);
    setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1600);
  };
  const addStock = () => {
    const id = addCode.trim();
    setAddErr('');
    if (!/^\d{4,6}[A-Z]?$/.test(id)) return setAddErr('代號格式不對');
    if ((items || []).some((it) => it.id === id)) return jumpTo(id);
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
    if (!window.confirm(`取消訂閱 ${id} ${it?.name || ''}？`)) return; // 筆記獨立存放，不受影響
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
    // 自訂：照清單順序（拖曳結果）。週／月：有待確認提醒的排最前面，其餘依漲幅由高到低，還沒有股價的排最後
    .sort((a, b) => {
      if (sortBy === 'c') return a.i - b.i;
      const alertDiff = (b.alerts.length > 0) - (a.alerts.length > 0);
      if (alertDiff) return alertDiff;
      const field = sortBy === 'm' ? 'chg1m' : 'chg1w';
      const va = a.d?.quote?.[field];
      const vb = b.d?.quote?.[field];
      if (va == null && vb == null) return a.i - b.i;
      if (va == null) return 1;
      if (vb == null) return -1;
      return vb - va || a.i - b.i;
    }), [items, data, today, sortBy]);

  // 自訂排列：每張卡片記一個格位（由左到右、由上到下數，空格也算），可以留空位。
  // 欄數跟 CSS 同規則算（卡片最小 170px、間距 10px；手機固定兩欄），視窗變寬變窄時格位照順序重新排。
  const custom = sortBy === 'c';
  const mobile = typeof window !== 'undefined' && window.innerWidth <= 480;
  const cols = mobile ? 2 : Math.max(1, Math.floor((gridW + 10) / 180));
  const slotOf = new Map();
  if (custom) {
    const taken = new Set();
    (items || []).forEach((it) => {
      if (Number.isInteger(it.slot) && it.slot >= 0 && !taken.has(it.slot)) { slotOf.set(it.id, it.slot); taken.add(it.slot); }
    });
    // 沒有格位的（舊資料、新訂閱）接在最後面，照清單順序
    let next = taken.size ? Math.max(...taken) + 1 : 0;
    (items || []).forEach((it) => { if (!slotOf.has(it.id)) slotOf.set(it.id, next++); });
  }
  const idAtSlot = new Map([...slotOf].map(([id, sl]) => [sl, id]));
  const maxSlot = slotOf.size ? Math.max(...slotOf.values()) : -1;
  // 拖曳中空格鋪滿到畫面底部（至少多一列）；拖到最後一列時再往下長兩列，可以一路拖到更下面
  const usedRows = Math.floor(maxSlot / cols) + 1;
  let rows = usedRows;
  if (drag) {
    const rowH = (mobile ? 100 : 110) + (mobile ? 8 : 10);
    const top = gridEl.current ? gridEl.current.getBoundingClientRect().top : 0;
    const fill = Math.ceil((window.innerHeight - top) / rowH);
    rows = Math.max(usedRows + 1, fill, drag.rows || 0);
    if (drag.over != null && Math.floor(drag.over / cols) >= rows - 1) rows += 2;
  }
  const cellCount = rows * cols;
  const placeAt = (sl) => ({ gridRow: Math.floor(sl / cols) + 1, gridColumn: (sl % cols) + 1 });
  // 放到空格＝移過去；放到另一張卡片上＝兩張互換
  const dropTo = (target) => {
    if (!drag || target == null) return;
    const from = slotOf.get(drag.id);
    const other = idAtSlot.get(target);
    const next = new Map(slotOf);
    next.set(drag.id, target);
    if (other && other !== drag.id) next.set(other, from);
    persist((itemsRef.current || []).map((it) => ({ ...it, slot: next.get(it.id) })));
  };
  const dndFor = (target, id) => ({
    onDragOver: (e) => {
      if (!drag) return;
      e.preventDefault();
      if (drag.over !== target) setDrag({ ...drag, over: target, rows });
    },
    onDrop: (e) => { e.preventDefault(); dropTo(target); setDrag(null); },
    ...(id && {
      draggable: true,
      onDragStart: (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); setDrag({ id, over: null }); },
      onDragEnd: () => setDrag(null),
    }),
  });

  // 上方只顯示待確認提醒總數（與卡片右下角數字同算法）
  const alertCount = cards.reduce((n, c) => n + alertLabels(c.alerts).length, 0);
  const alertNames = cards.filter((c) => c.alerts.length > 0).map((c) => c.it.name || c.it.id).join('、');

  if (!items) return <div className={styles.root} ref={rootRef}><div className={styles.empty}>載入訂閱清單中…</div></div>;

  const open = openId && cards.find((c) => c.it.id === openId);

  // 訂閱框（卡片上方一行）
  const existing = (items || []).find((it) => it.id === addCode.trim()) || null;
  const addBox = (
    <div className={styles.addBox}>
      {/* 股名／錯誤提示放在輸入框左邊同一行：原本浮在下方，會伸進卡片區被卡片蓋掉 */}
      {(addErr || addPreview || existing) && (
        <div className={styles.addHint} style={addErr ? { color: 'var(--sub-fire)' } : undefined}>
          {addErr || (existing ? `移動至 ${existing.name || existing.id}` : addPreview.name)}
        </div>
      )}
      <input
        className={styles.codeInput} placeholder="股號" value={addCode} inputMode="numeric" aria-label="股號"
        onChange={(e) => { setAddCode(e.target.value.toUpperCase()); setAddErr(''); }}
        onKeyDown={(e) => e.key === 'Enter' && addStock()}
      />
      <button type="button" className={styles.addBtn} onClick={addStock}>{existing ? '移動' : '訂閱'}</button>
    </div>
  );

  return (
    <div className={styles.root} ref={rootRef}>
      {saveErr && <div className={styles.notice}>{saveErr}</div>}

      {/* 卡片上方一行：左邊有提醒的股名與總則數，右邊排序鈕＋訂閱框 */}
      <div className={styles.addCell}>
        {alertCount > 0 && (
          <div className={styles.alertSummary}>
            <b className={styles.alertCount}>
              <span>提醒：</span><span className={styles.alertNames} title={alertNames}>{alertNames}</span>
              <span>，共</span><span className={styles.cardBadge}>{alertCount}</span><span>則</span>
            </b>
          </div>
        )}
        <div className={styles.sortToggle} role="group" aria-label="排序">
          {[['w', '週漲幅'], ['m', '月漲幅'], ['c', '自訂']].map(([v, label]) => (
            <button key={v} type="button" className={sortBy === v ? styles.sortOn : ''} onClick={() => changeSort(v)} aria-pressed={sortBy === v}>{label}</button>
          ))}
        </div>
        {addBox}
      </div>
      <div
        ref={gridRef}
        className={`${styles.cardGrid} ${custom ? styles.cardGridCustom : ''}`}
        style={custom ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
      >
        {cards.map((c) => {
          const id = c.it.id;
          const sl = slotOf.get(id);
          return (
            <StockCard
              key={id} {...c} flash={flashId === id} onOpen={() => setOpenId(id)}
              style={custom ? placeAt(sl) : undefined}
              dnd={custom ? dndFor(sl, id) : null}
              dragging={drag?.id === id}
              dropTarget={!!drag && drag.over === sl && drag.id !== id}
            />
          );
        })}
        {/* 自訂排列的空格：平常看不見，拖曳時顯示虛線框當放置目標 */}
        {custom && Array.from({ length: cellCount }, (_, sl) => sl).filter((sl) => !idAtSlot.has(sl)).map((sl) => (
          <div
            key={`slot-${sl}`} style={placeAt(sl)} {...dndFor(sl)}
            className={[styles.slotCell, drag && styles.slotCellActive, drag?.over === sl && styles.slotCellOver].filter(Boolean).join(' ')}
          />
        ))}
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
            loadQuote(open.it, true);
            loadMops(open.it, true);
          }}
          onRemove={() => removeStock(open.it.id)}
        />
      )}
    </div>
  );
}

/* ── 卡片 ─────────────────────────────────────────────────────────────── */

function StockCard({ it, d, alerts, flash, onOpen, style, dnd, dragging, dropTarget }) {
  const q = d?.quote;
  const loading = d?.loading?.quote;
  return (
    <button
      type="button" data-stock-id={it.id} onClick={onOpen} style={style} {...(dnd || {})}
      className={[
        styles.card, alerts.length && styles.cardAlert, flash && styles.cardFlash, dnd && styles.cardDraggable,
        dragging && styles.cardDragging, dropTarget && styles.cardDropSwap,
      ].filter(Boolean).join(' ')}
    >
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
      {/* 提醒數量：iPhone 式紅點，壓在卡片右下角外框上，卡片不必為它多留一行 */}
      {alerts.length > 0 && <span className={`${styles.cardBadge} ${styles.cardBadgeCorner}`} aria-label={`${alertLabels(alerts).length} 則提醒`}>{alertLabels(alerts).length}</span>}

    </button>
  );
}

/* ── 個股視窗 ─────────────────────────────────────────────────────────── */

function StockModal({ it, d, stats, alerts, colors, today, onClose, onUpdate, onAck, onReload, onRemove }) {
  const [showSettings, setShowSettings] = useState(false);
  const q = d?.quote;

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
            <button type="button" className={styles.btn} onClick={() => setShowSettings(true)}>提醒設定</button>
            <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="關閉">×</button>
          </div>
        </div>
        <StockFundamentals
          stock={it} it={it} d={d} stats={stats} alerts={alerts} colors={colors} today={today}
          onAck={onAck} onReload={onReload} onRemove={onRemove}
        />
      </div>

      {showSettings && <AlertSettings it={it} today={today} onUpdate={onUpdate} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
