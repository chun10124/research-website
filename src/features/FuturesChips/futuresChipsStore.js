/**
 * 籌碼頁預算資料：每日同步（GitHub Actions，SYNC_MODE=futuresChips）收盤後算好一年份寫進 Firestore，
 * 頁面直接讀，不用等幾十個期交所請求。讀不到或太舊時，頁面退回即時抓取（loadFuturesChipTable）。
 *
 * 存放：ibdRsMeta/futuresChips（該 collection 允許無身分的每日同步寫入，見 firestore.rules）
 * 欄位：{ schema, json: JSON.stringify({ from, through, rows }), through, updatedAt }
 *
 * 增量：期交所原始資料照日曆月切段，過去月份抓過就存進 ibdRsMeta/futuresChipsRaw（永久不變）；
 * 每天只重抓當月（月初 3 天內加上個月）約 6 個請求，其餘從這份讀回，再用完整一年份重算指標。
 */
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../../utils/firebaseConfig';
import { loadFuturesChipTable, exportPermanentChunks, importPermanentChunks, getNetFetchCount } from './taifexApi';

const SCHEMA = 1;
const DOC_REF = () => doc(db, 'ibdRsMeta', 'futuresChips');
const RAW_REF = () => doc(db, 'ibdRsMeta', 'futuresChipsRaw');
const RAW_MAX_BYTES = 900 * 1024; // Firestore 單一文件上限 1 MiB
export const STORE_MONTHS = 12;
const STALE_DAYS = 5; // 最後一列比今天早超過 5 天（含長假）就當作排程沒跑，改即時抓

const taipeiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

export function storeStartDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - STORE_MONTHS);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
}

/** 每日同步呼叫：抓一年份、算好、寫入（dryRun 只算不寫）。有任何區段抓失敗就不寫（避免用殘缺資料蓋掉昨天的好資料） */
export async function buildAndStoreFuturesChips({ log = console.log, dryRun = false } = {}) {
  const from = storeStartDate();
  // 讀回已存的原始月份，只抓缺的
  let saved = {};
  try {
    const snap = await getDoc(RAW_REF());
    if (snap.exists() && snap.data()?.schema === SCHEMA) saved = JSON.parse(snap.data().json || '{}');
  } catch (e) { log(`[futuresChips] 讀原始資料失敗，全部重抓：${e?.message}`); }
  importPermanentChunks(saved);
  log(`[futuresChips] 已存原始區段 ${Object.keys(saved).length} 段`);
  const { rows, warnings } = await loadFuturesChipTable(from, {
    onProgress: (done, total) => { if (done === total) log(`[futuresChips] 區段 ${total} 段處理完，實際向期交所請求 ${getNetFetchCount()} 次`); },
  });
  if (warnings.length) throw new Error(`期交所資料有缺漏，不寫入：${warnings.join('；')}`);
  if (!rows.length) throw new Error('沒有任何資料列，不寫入');
  const through = rows[rows.length - 1].date.replace(/\//g, '-');
  const json = JSON.stringify({ from, through, rows });
  const raw = exportPermanentChunks();
  const rawJson = JSON.stringify(raw);
  const newChunks = Object.keys(raw).filter((k) => !(k in saved)).length;
  if (dryRun) return { count: rows.length, through, bytes: json.length, dryRun: true, sample: rows[rows.length - 1], rawBytes: rawJson.length, newChunks };
  await setDoc(DOC_REF(), { schema: SCHEMA, json, through, updatedAt: Date.now() });
  if (newChunks > 0) {
    if (rawJson.length > RAW_MAX_BYTES) log(`[futuresChips] ⚠️ 原始資料 ${Math.round(rawJson.length / 1024)} KB 超過上限，不存（下次會全部重抓）`);
    else await setDoc(RAW_REF(), { schema: SCHEMA, json: rawJson, updatedAt: Date.now() });
  }
  return { count: rows.length, through, bytes: json.length, rawBytes: rawJson.length, newChunks };
}

/** 頁面呼叫：讀預算資料；沒有、格式不符、或太舊回 null */
export async function readStoredFuturesChips() {
  try {
    const snap = await getDoc(DOC_REF());
    if (!snap.exists() || snap.data()?.schema !== SCHEMA) return null;
    const p = JSON.parse(snap.data().json || 'null');
    if (!p?.rows?.length || daysBetween(p.through, taipeiToday()) > STALE_DAYS) return null;
    return { ...p, updatedAt: snap.data().updatedAt };
  } catch (e) {
    console.warn('futuresChips 預算資料讀取失敗，改即時抓:', e?.message);
    return null;
  }
}
