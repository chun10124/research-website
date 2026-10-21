/**
 * 富邦即時報價（經 Cloudflare Worker research-quote 中繼；只開放 Worker 白名單內的登入者）。
 * 盤中每 5 秒輪詢；收盤後到當晚只取「一次」今日收盤（收盤價不會再變；每日同步 14:00 才把今日寫進
 * 資料庫，中間這段若不補，畫面會停在昨天）。週末、未登入、分頁在背景時不打。任何失敗都回 null，呼叫端沿用原本的收盤價。
 */
import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../../../utils/firebaseConfig';

const QUOTE_WORKER_URL = 'https://research-quote.tzuchun11232004.workers.dev';
const POLL_MS = 5000;

/**
 * navbar 燈號訂閱的狀態：
 *   active    目前掛著幾個即時報價 hook（0＝本頁沒有要即時價的東西，不亮燈）
 *   okAt      盤中最後一次成功取得今日即時價；closeOkAt 收盤後成功取得今日收盤
 *   time      富邦資料時間 HHMMSS
 *   waitUntil 開頁等第一筆即時價的截止時間（之前不亮燈，之後還沒成功＝顯示的是資料庫價格→橘燈）
 *   failAt    最後一次失敗（請求失敗、逾時）
 *   holiday   今天富邦快照不是今日（國定假日）→ 不亮燈
 */
let liveStatus = { active: 0, okAt: 0, closeOkAt: 0, time: null, waitUntil: 0, failAt: 0, holiday: null };
const liveListeners = new Set();
const setLiveStatus = (patch) => {
  liveStatus = { ...liveStatus, ...patch };
  liveListeners.forEach((fn) => fn(liveStatus));
};

/** 燈號用的即時報價狀態（見 liveStatus） */
export function useRealtimeStatus() {
  const [st, setSt] = useState(liveStatus);
  useEffect(() => {
    liveListeners.add(setSt);
    return () => liveListeners.delete(setSt);
  }, []);
  return st;
}

const bare = (code) => String(code || '').trim().replace(/\.(TW|TWO)$/i, '');
const taipeiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

/**
 * 本機記住最近一次即時報價（只是本瀏覽器的顯示快取，不是資料來源）：
 * 開頁先顯示上次的即時價，避免「先閃昨天收盤、幾秒後才跳即時」。
 * 盤中只沿用 5 秒內的（使用者要「開頁瞬間就是近 5 秒的即時價」）；收盤後只沿用當日收盤（closed）。
 */
const CACHE_KEY = 'rt-quotes-v1';
const SESSION_CACHE_MAX_AGE_MS = 5000;
/** 開頁等第一筆即時價的上限：超過就放行顯示資料庫價格，避免網路不好時畫面一直空白 */
const FIRST_QUOTE_TIMEOUT_MS = 3000;
function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return c && c.date === taipeiToday() && c.quotes ? c : null;
  } catch (_) {
    return null;
  }
}
function writeCache(res, closed) {
  try {
    const prev = readCache();
    const keepPrev = prev && !!prev.closed === closed;
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      date: taipeiToday(), at: Date.now(), time: res.time || null, closed,
      quotes: { ...(keepPrev ? prev.quotes : {}), ...res.quotes },
    }));
  } catch (_) {}
}
function seedFromCache(ids) {
  const phase = twMarketPhase();
  const c = phase ? readCache() : null;
  if (!c) return null;
  if (phase === 'session' && (c.closed || Date.now() - c.at > SESSION_CACHE_MAX_AGE_MS)) return null;
  if (phase === 'afterClose' && !c.closed) return null;
  const prices = {};
  const quotes = {};
  for (const id of ids) {
    const q = c.quotes[id];
    if (q && q.price > 0 && !q.trial) {
      prices[id] = q.price;
      quotes[id] = q;
    }
  }
  const n = Object.keys(prices).length;
  if (!n) return null;
  // complete：快取涵蓋本頁九成以上代碼才算「已有即時價」（例：績效頁只記了 3 檔持股，追蹤表 200 多檔不能算有）
  return { prices, quotes, time: c.time, closed: !!c.closed, complete: n >= ids.length * 0.9 };
}

/** 台北時間週一～五：'session' 09:00–13:35（含收盤後 5 分鐘拿最終價）、'afterClose' 13:36–23:59；其餘 null */
export function twMarketPhase(now = new Date()) {
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = tw.getDay();
  const hm = tw.getHours() * 100 + tw.getMinutes();
  if (day < 1 || day > 5 || hm < 900) return null;
  return hm <= 1335 ? 'session' : 'afterClose';
}

export function isTwMarketSession(now = new Date()) {
  return twMarketPhase(now) === 'session';
}

/** @returns {Promise<null | { time: string, quotes: Record<string, { price: number, changePct: number }> }>} */
export async function fetchRealtimeQuotes(codes) {
  const user = auth?.currentUser;
  const ids = [...new Set((codes || []).map(bare).filter(Boolean))];
  if (!user || ids.length === 0) return null;
  try {
    const idToken = await user.getIdToken();
    const r = await fetch(`${QUOTE_WORKER_URL}/quotes?ids=${encodeURIComponent(ids.join(','))}`, {
      headers: { authorization: `Bearer ${idToken}` },
    });
    if (!r.ok) {
      setLiveStatus({ failAt: Date.now() });
      return null;
    }
    const data = await r.json();
    if (data?.quotes) {
      if (data.date !== taipeiToday()) setLiveStatus({ holiday: taipeiToday() });
      else if (isTwMarketSession()) setLiveStatus({ okAt: Date.now(), time: data.time || null, holiday: null });
      else setLiveStatus({ closeOkAt: Date.now(), time: data.time || null, holiday: null });
    }
    return data;
  } catch (e) {
    console.warn('[即時報價] 取得失敗:', e?.message || e);
    setLiveStatus({ failAt: Date.now() });
    return null;
  }
}

/**
 * 盤中輪詢即時價、收盤後取今日收盤。回傳
 * { prices: { [bareCode]: price }, quotes: { [bareCode]: 完整報價 }, time: 'HHMMSS' | null, closed: boolean, ready: boolean }；
 * closed＝收盤後的今日收盤價（UI 標「收盤」而非「即時」）。週末與開盤前為空物件。
 * ready＝false 表示「正在等第一筆即時價」：呼叫端應先顯示載入中，不要先秀資料庫（昨日）價格；
 * 拿到即時價、確定未登入、或等滿 FIRST_QUOTE_TIMEOUT_MS 都會變 true。
 */
export function useRealtimeQuotes(codes) {
  const key = [...new Set((codes || []).map(bare).filter(Boolean))].sort().join(',');
  const empty = { prices: {}, quotes: {}, time: null, closed: false };
  const initialSeed = () => (key && typeof window !== 'undefined' && seedFromCache(key.split(','))) || null;
  const [state, setState] = useState(() => initialSeed() || empty);
  const [ready, setReady] = useState(() => typeof window === 'undefined' || !twMarketPhase() || !!initialSeed()?.complete);

  useEffect(() => {
    if (!key || typeof window === 'undefined') return undefined;
    // 換股：先換成本機快取（有的話），沒有就清空，避免沿用上一檔
    const seed = seedFromCache(key.split(','));
    setState(seed || empty);
    setReady(!twMarketPhase() || !!seed?.complete);
    let gotLive = !!seed?.complete;
    setLiveStatus({ active: liveStatus.active + 1, waitUntil: gotLive ? 0 : Date.now() + FIRST_QUOTE_TIMEOUT_MS });
    const giveUp = setTimeout(() => {
      setReady(true);
      if (!gotLive && twMarketPhase() && auth?.currentUser) setLiveStatus({ failAt: Date.now() });
    }, FIRST_QUOTE_TIMEOUT_MS);
    let cancelled = false;
    let closeTried = false; // 收盤後每次開頁只打一次（收盤價不會變；國定假日或失敗也不重打）
    const tick = async () => {
      const phase = twMarketPhase();
      if (!phase || document.visibilityState !== 'visible') return;
      if (!auth?.currentUser) return; // 登入還沒還原：不算一次，等 onAuthStateChanged 立刻補打
      if (phase === 'afterClose') {
        if (closeTried) return;
        closeTried = true;
      }
      const res = await fetchRealtimeQuotes(key.split(','));
      if (cancelled || !res?.quotes) return;
      // 只採用「今天」的快照（國定假日富邦回的是前一交易日，資料庫已有，不必覆蓋、也不算即時）
      if (res.date !== taipeiToday()) {
        setReady(true);
        return;
      }
      gotLive = true;
      writeCache(res, phase === 'afterClose');
      const prices = {};
      const quotes = {};
      for (const [id, q] of Object.entries(res.quotes)) {
        if (q && q.price > 0 && !q.trial) {
          prices[id] = q.price;
          quotes[id] = q;
        }
      }
      setState({ prices, quotes, time: res.time || null, closed: phase === 'afterClose' });
      setReady(true);
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    // 開頁時登入狀態要 100～300ms 才還原：一還原就立刻抓，不必等下一個 5 秒
    // 確定沒登入（朋友）：不會有即時價，直接放行顯示資料庫價格
    const unsub = auth ? onAuthStateChanged(auth, (u) => { if (u) tick(); else setReady(true); }) : () => {};
    return () => {
      cancelled = true;
      clearInterval(t);
      clearTimeout(giveUp);
      unsub();
      setLiveStatus({ active: Math.max(0, liveStatus.active - 1) });
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, ready: ready || !key };
}

/**
 * 把即時報價併入日 K 序列（{ dateStr, open, high, low, close, volume }，舊→新）：
 * 最後一根是今天就以即時開高低收量取代，否則補上今天一根。無有效報價時原樣回傳。
 * 量：富邦快照為「張」，日 K 序列（Yahoo）為「股」→ ×1000。
 */
export function mergeLiveDailyBar(ohlc, q) {
  if (!Array.isArray(ohlc) || !q || !(q.price > 0)) return ohlc;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const last = ohlc[ohlc.length - 1];
  if (last && last.dateStr > today) return ohlc;
  const close = q.price;
  const open = q.open > 0 ? q.open : close;
  const bar = {
    dateStr: today,
    open,
    high: Math.max(q.high > 0 ? q.high : close, open, close),
    low: Math.min(q.low > 0 ? q.low : close, open, close),
    close,
    volume: Number.isFinite(q.volumeLots) ? q.volumeLots * 1000 : (last?.dateStr === today ? last.volume : 0),
    live: true,
  };
  return last?.dateStr === today ? [...ohlc.slice(0, -1), bar] : [...ohlc, bar];
}
