/* src/features/StockAnalysis/api/prefetchChipData.js */
// 加入 RS 觀察清單時，背景把該檔的三大法人買賣超 + 外資持股抓好寫進
// Firestore stockWatchlist/{code}，這樣之後開籌碼視窗就直接讀快取、免等 API。
//
// 寫入結構與 IBDRsRankingPage 籌碼視窗懶載入完全一致（history.instDates / instForeign /
// instTrust / instDealer、latestInstDate、history.foreignTotalHolding / foreignHoldingDates、
// latestHoldingsDate），所以視窗開啟時的新鮮度檢查會直接命中快取。

import { doc, getDoc, updateDoc, setDoc } from 'firebase/firestore';
import { db } from '../../../utils/firebaseConfig';
import {
  fetchInstitutionalInvestorsSeries,
  fetchForeignHoldingSeries,
  instArraysToDateMap,
  lastExpectedInstDate,
} from './stockApi';

/** 同一檔正在抓取時不重複觸發（fire-and-forget 去重） */
const inFlight = new Set();

const dayPlusOne = (dateStr) => {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

const eighteenMonthsAgo = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 18);
  return d.toISOString().slice(0, 10);
};

const daysSince = (dateStr) =>
  dateStr ? Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000) : 999;

/**
 * 局部寫入 stockWatchlist/{code}（updateDoc 支援 dot-notation，不覆蓋其他 history 欄位）。
 * doc 不存在時改用 setDoc 建立。與籌碼視窗 saveToFirestore 行為一致。
 */
async function saveToFirestore(docRef, stockCode, fields) {
  try {
    await updateDoc(docRef, fields);
  } catch (e) {
    if (e?.code === 'not-found') {
      const topLevel = {};
      const histFields = {};
      for (const [k, v] of Object.entries(fields)) {
        if (k.startsWith('history.')) histFields[k.slice(8)] = v;
        else topLevel[k] = v;
      }
      await setDoc(docRef, { code: stockCode, history: histFields, ...topLevel }, { merge: true });
    }
  }
}

/**
 * 背景預抓單一檔的籌碼資料（三大法人買賣超 + 外資持股）並寫回 Firestore。
 * fire-and-forget：永不 throw，呼叫端 .catch(() => {}) 即可。
 * @param {string} stockCode 股票代碼（RS 觀察清單的 id 即代碼）
 */
export async function prefetchWatchlistChipData(stockCode) {
  const code = String(stockCode ?? '').trim();
  if (!code || inFlight.has(code)) return;
  inFlight.add(code);

  try {
    const docRef = doc(db, 'stockWatchlist', code);

    // 先讀現有快取，決定是否需要抓、以及增量起始日
    let existing = {};
    try {
      const snap = await getDoc(docRef);
      if (snap.exists()) existing = snap.data() || {};
    } catch (_) { /* 讀不到就當沒有，往下抓 */ }

    const hist = existing.history || {};

    // ── 三大法人買賣超 ──────────────────────────────────────────
    // 新鮮度判定：快取最新日 >= 目前應已公告的最近交易日即為新鮮。
    // 週末/盤前未到 21:00/假日皆無新資料，避免一直空補抓。
    // 需補抓時：沒資料抓 18 個月，有舊資料則自最新日+1 增量。
    const instLd = existing.latestInstDate ?? null;
    const instFresh = hist.instDates?.length > 0 && instLd && instLd >= lastExpectedInstDate();
    if (!instFresh) {
      try {
        const startDate = instLd ? dayPlusOne(instLd) : eighteenMonthsAgo();
        const newMap = await fetchInstitutionalInvestorsSeries(code, startDate);
        const staleMap =
          hist.instDates?.length > 0
            ? instArraysToDateMap(hist.instDates, hist.instForeign, hist.instTrust, hist.instDealer)
            : {};
        const merged = { ...staleMap, ...(newMap || {}) };
        if (Object.keys(merged).length > 0) {
          const dates = Object.keys(merged).sort().reverse();
          await saveToFirestore(docRef, code, {
            'history.instDates':   dates,
            'history.instForeign': dates.map((d) => merged[d].foreign),
            'history.instTrust':   dates.map((d) => merged[d].trust),
            'history.instDealer':  dates.map((d) => merged[d].dealer),
            latestInstDate: dates[0] ?? null,
          });
        }
      } catch (_) { /* 三大法人抓取失敗不影響持股 */ }
    }

    // ── 外資持股序列 ───────────────────────────────────────────
    // 視窗新鮮度判定：持股有出版延遲，3 天內視為新鮮；否則重抓整段（API 無增量）。
    const holdings = hist.foreignTotalHolding;
    const holdingsFresh =
      Array.isArray(holdings) && holdings.length > 100 && daysSince(existing.latestHoldingsDate) <= 3;
    if (!holdingsFresh) {
      try {
        const result = await fetchForeignHoldingSeries(code);
        if (result && Array.isArray(result.holdings) && result.holdings.length > 100) {
          const fields = {
            'history.foreignTotalHolding': result.holdings,
            latestHoldingsDate: result.latestDate,
          };
          if (Array.isArray(result.holdingDates) && result.holdingDates.length > 0) {
            fields['history.foreignHoldingDates'] = result.holdingDates;
          }
          await saveToFirestore(docRef, code, fields);
        }
      } catch (_) { /* 持股抓取失敗忽略 */ }
    }
  } catch (_) {
    /* 整體失敗忽略：預抓是best-effort，視窗開啟時仍會走原本懶載入 */
  } finally {
    inFlight.delete(code);
  }
}
