/* src/features/StockAnalysis/api/rsRatingsCache.js */

/**
 * ibdRsRatings 全集合讀取 + IndexedDB 快取
 *
 * 全集合約 2000 檔、近 100 MB，直接 getDocs 要 8～37 秒且隨網路大幅波動。
 * 做法：整包存在 IndexedDB，開頁只向 Firestore 查「updatedAt > 游標」的差量＋總檔數，
 * 合併後才回傳 —— 有更新時一定等差量抓完，不會先顯示舊資料。
 *
 * 正確性前提：所有寫入 ibdRsRatings 的路徑都要帶 updatedAt（rsApi.js 已全數補上）。
 * 保險：
 *  - 游標往回退 CURSOR_OVERLAP_MS，避免讀取當下剛好在同步（寫入尚未全落地）或寫入端時鐘略慢而漏檔。
 *  - 合併後檔數與伺服器總數不同（有刪檔／新檔沒帶 updatedAt）→ 放棄快取全量重抓。
 *  - 快取超過 MAX_CACHE_AGE_MS 一律全量重抓。
 *  - IndexedDB 不能用（無痕、iOS 被清）→ 直接全量讀，不影響結果。
 */

import { getCountFromServer, getDocs, query, where } from 'firebase/firestore';
import { RS_RATINGS_COLLECTION } from '../../../utils/firebaseConfig';

const DB_NAME = 'rsRatingsCache';
const STORE = 'kv';
const KEY = 'ibdRsRatings';
const SCHEMA_VERSION = 2; // v2：docs 存成 JSON Blob（v1 直存物件，取出要 2.7 秒；Blob 讀取＋parse 約 0.5 秒）
const CURSOR_LS_KEY = 'rsRatingsCache.cursor';
const CURSOR_OVERLAP_MS = 15 * 60 * 1000;
const MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function idbAvailable() {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbPut(value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function readCache() {
  if (!idbAvailable()) return null;
  try {
    const rec = await idbGet();
    if (!rec || rec.v !== SCHEMA_VERSION || !(rec.blob instanceof Blob) || typeof rec.cursor !== 'number') return null;
    if (Date.now() - rec.savedAt > MAX_CACHE_AGE_MS) return null;
    const docs = JSON.parse(await rec.blob.text());
    return Array.isArray(docs) ? { cursor: rec.cursor, docs } : null;
  } catch (e) {
    console.warn('[rsRatingsCache] 讀取快取失敗，改全量讀取:', e?.message || e);
    return null;
  }
}

function lsGetCursor() {
  try {
    const n = Number(localStorage.getItem(CURSOR_LS_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function computeCursor(docs, fetchStartedAt) {
  let max = 0;
  for (const d of docs) {
    if (typeof d.updatedAt === 'number' && d.updatedAt > max) max = d.updatedAt;
  }
  return Math.min(max, fetchStartedAt - CURSOR_OVERLAP_MS);
}

function saveCacheLater(docs, cursor) {
  if (!idbAvailable()) return;
  // 序列化約 0.2～1 秒會卡主執行緒，延到畫面先畫完再存
  setTimeout(() => {
    // JSON 會把 NaN／Infinity 變成 null；真遇到就不存快取，寧可下次全量讀也不要資料失真
    let lossy = false;
    const json = JSON.stringify(docs, (_k, v) => {
      if (typeof v === 'number' && !Number.isFinite(v)) lossy = true;
      return v;
    });
    if (lossy) {
      console.warn('[rsRatingsCache] 資料含 NaN/Infinity，JSON 無法原樣保存，略過快取');
      return;
    }
    idbPut({ v: SCHEMA_VERSION, savedAt: Date.now(), cursor, blob: new Blob([json], { type: 'application/json' }) })
      .then(() => {
        try { localStorage.setItem(CURSOR_LS_KEY, String(cursor)); } catch (_) {}
      })
      .catch((e) => console.warn('[rsRatingsCache] 寫入快取失敗（不影響顯示）:', e?.message || e));
  }, 1500);
}

function toRows(snapshot) {
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function fetchDelta(cursor) {
  const [deltaSnap, countSnap] = await Promise.all([
    getDocs(query(RS_RATINGS_COLLECTION, where('updatedAt', '>', cursor))),
    getCountFromServer(RS_RATINGS_COLLECTION),
  ]);
  return { delta: toRows(deltaSnap), serverCount: countSnap.data().count };
}

async function fetchFull(fetchStartedAt, reason) {
  const docs = toRows(await getDocs(RS_RATINGS_COLLECTION));
  console.log(`[rsRatingsCache] 全量讀取 ${docs.length} 檔（${reason}），${Date.now() - fetchStartedAt} ms`);
  saveCacheLater(docs, computeCursor(docs, fetchStartedAt));
  return docs;
}

/**
 * 讀取 ibdRsRatings 全部文件（與伺服器一致後才回傳）。
 * @param {{ full?: boolean }} [opts] full=true 略過快取、全量重抓並重建快取
 */
export async function loadAllRsRatings({ full = false } = {}) {
  const fetchStartedAt = Date.now();
  if (full) return fetchFull(fetchStartedAt, '手動重新載入');

  // 游標先從 localStorage 拿，差量查詢與 IndexedDB 讀取並行
  const lsCursor = lsGetCursor();
  const deltaPromise = lsCursor != null ? fetchDelta(lsCursor) : null;
  deltaPromise?.catch(() => {}); // 避免快取不可用時變成 unhandled rejection

  const cached = await readCache();
  if (!cached) return fetchFull(fetchStartedAt, '無可用快取');

  const { delta, serverCount } = await (cached.cursor === lsCursor ? deltaPromise : fetchDelta(cached.cursor));

  const byId = new Map(cached.docs.map((d) => [d.id, d]));
  for (const row of delta) byId.set(row.id, row);
  if (byId.size !== serverCount) {
    return fetchFull(fetchStartedAt, `檔數不符：快取合併 ${byId.size}、伺服器 ${serverCount}`);
  }

  const docs = [...byId.values()];
  const cursor = computeCursor(docs, fetchStartedAt);
  console.log(`[rsRatingsCache] 快取 ${cached.docs.length} 檔 + 差量 ${delta.length} 檔，${Date.now() - fetchStartedAt} ms`);
  if (delta.length > 0 || cursor !== cached.cursor) saveCacheLater(docs, cursor);
  return docs;
}
