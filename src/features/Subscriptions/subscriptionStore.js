/* src/features/Subscriptions/subscriptionStore.js */

/**
 * 訂閱清單的儲存層（Firestore subscriptions/main，僅擁有者）＋本機備份。
 * 訂閱頁與 RS 個股視窗「基本面」分頁共用。
 */

export const LOCAL_KEY = 'rw-subscriptions-local';
export const MAX_ITEMS = 50;

export function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')?.items || null; } catch (_) { return null; }
}
export function writeLocal(items) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ items })); } catch (_) {}
}
export const isDenied = (e) => e?.code === 'permission-denied' || /permission/i.test(e?.message || '');

/** 舊版資料轉新格式：thesis 併入筆記、筆記加時間、seen 改成 ack/base。 */
export function migrate(it) {
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
