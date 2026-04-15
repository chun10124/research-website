import { runTransaction, onSnapshot } from 'firebase/firestore';
import { db, IBD_RS_WATCHLIST_DOC_REF } from '../../../utils/firebaseConfig';

/** 從觀察列表頁導向 RS 排名並開啟該檔圖表（讀取後由 IBDRsRankingPage 清除） */
export const RS_OPEN_STOCK_SESSION_KEY = 'research-website-ibdRsOpenStockId';

/**
 * @param {(data: { ids: string[], priorities: Record<string, number> }) => void} onNext
 * @returns {() => void} unsubscribe
 */
export function subscribeIbdRsWatchlistIds(onNext) {
  return onSnapshot(
    IBD_RS_WATCHLIST_DOC_REF,
    (snap) => {
      const d = snap.data();
      const raw = Array.isArray(d?.stockIds) ? d.stockIds : [];
      const ids = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
      const priorities = d?.stockPriorities && typeof d.stockPriorities === 'object'
        ? { ...d.stockPriorities }
        : {};
      onNext({ ids, priorities });
    },
    (err) => {
      console.error('[ibdRsWatchlist] 訂閱失敗:', err?.message);
      onNext({ ids: [], priorities: {} });
    }
  );
}

/**
 * 若已在列表則移除，否則加入（維持陣列尾端＝最後加入順序）。
 * @returns {Promise<boolean>} 交易後是否在列表中
 */
export async function toggleIbdRsWatchlistStockId(stockId) {
  const id = String(stockId ?? '').trim();
  if (!id) return false;

  const inList = await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(IBD_RS_WATCHLIST_DOC_REF);
    const data = snap.exists() ? snap.data() : {};
    let stockIds = Array.isArray(data.stockIds) ? [...data.stockIds].map((x) => String(x).trim()).filter(Boolean) : [];
    stockIds = [...new Set(stockIds)];
    const priorities = data.stockPriorities && typeof data.stockPriorities === 'object' ? { ...data.stockPriorities } : {};
    const idx = stockIds.indexOf(id);
    let nextIn;
    if (idx >= 0) {
      stockIds.splice(idx, 1);
      delete priorities[id];
      nextIn = false;
    } else {
      stockIds.push(id);
      nextIn = true;
    }
    transaction.set(IBD_RS_WATCHLIST_DOC_REF, { stockIds, stockPriorities: priorities, updatedAt: Date.now() }, { merge: true });
    return nextIn;
  });
  return inList;
}

/** 自觀察列表移除（若存在），同時清除優先順序。 */
export async function removeIbdRsWatchlistStockId(stockId) {
  const id = String(stockId ?? '').trim();
  if (!id) return;

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(IBD_RS_WATCHLIST_DOC_REF);
    if (!snap.exists()) return;
    const data = snap.data();
    let stockIds = Array.isArray(data.stockIds) ? [...data.stockIds].map((x) => String(x).trim()).filter(Boolean) : [];
    stockIds = stockIds.filter((x) => x !== id);
    const priorities = data.stockPriorities && typeof data.stockPriorities === 'object' ? { ...data.stockPriorities } : {};
    delete priorities[id];
    transaction.set(IBD_RS_WATCHLIST_DOC_REF, { stockIds, stockPriorities: priorities, updatedAt: Date.now() }, { merge: true });
  });
}

/**
 * 設定個股在觀察列表中的優先順序（1/2/3）；傳 null 或 0 則清除。
 * 股票必須已在觀察列表才有意義，但本函式不強制。
 * @param {string} stockId
 * @param {1|2|3|null} priority
 */
export async function setIbdRsWatchlistStockPriority(stockId, priority) {
  const id = String(stockId ?? '').trim();
  if (!id) return;

  await runTransaction(db, async (transaction) => {
    const snap = await transaction.get(IBD_RS_WATCHLIST_DOC_REF);
    const data = snap.exists() ? snap.data() : {};
    const priorities = data.stockPriorities && typeof data.stockPriorities === 'object' ? { ...data.stockPriorities } : {};
    if (priority == null || priority === 0) {
      delete priorities[id];
    } else {
      priorities[id] = priority;
    }
    transaction.set(IBD_RS_WATCHLIST_DOC_REF, { stockPriorities: priorities, updatedAt: Date.now() }, { merge: true });
  });
}
