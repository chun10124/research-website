/**
 * 籌碼頁預算資料：每日同步（GitHub Actions，SYNC_MODE=futuresChips）收盤後算好一年份寫進 Firestore，
 * 頁面直接讀，不用等幾十個期交所請求。讀不到或太舊時，頁面退回即時抓取（loadFuturesChipTable）。
 *
 * 存放：ibdRsMeta/futuresChips（該 collection 允許無身分的每日同步寫入，見 firestore.rules）
 * 欄位：{ schema, json: JSON.stringify({ from, through, rows }), through, updatedAt }
 */
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../../utils/firebaseConfig';
import { loadFuturesChipTable } from './taifexApi';

const SCHEMA = 1;
const DOC_REF = () => doc(db, 'ibdRsMeta', 'futuresChips');
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
  const { rows, warnings } = await loadFuturesChipTable(from, {
    onProgress: (done, total) => { if (done === total || done % 10 === 0) log(`[futuresChips] 下載 ${done}/${total}`); },
  });
  if (warnings.length) throw new Error(`期交所資料有缺漏，不寫入：${warnings.join('；')}`);
  if (!rows.length) throw new Error('沒有任何資料列，不寫入');
  const through = rows[rows.length - 1].date.replace(/\//g, '-');
  const json = JSON.stringify({ from, through, rows });
  if (dryRun) return { count: rows.length, through, bytes: json.length, dryRun: true, sample: rows[rows.length - 1] };
  await setDoc(DOC_REF(), { schema: SCHEMA, json, through, updatedAt: Date.now() });
  return { count: rows.length, through, bytes: json.length };
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
