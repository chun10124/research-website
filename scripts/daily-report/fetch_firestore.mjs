/* 每日報告 — 從 Firestore 取資料，輸出 JSON 供 Python 端使用（唯讀，不寫入任何 collection）。
   產出：
     data/universe.json   全市場 RS + 近 300 日 OHLCV + RS 歷史
     data/watchlist.json  追蹤表（產業標籤 category + 法人序列，籌碼報告用）
   用法：node scripts/daily-report/fetch_firestore.mjs <輸出目錄> */
import { initializeApp } from 'firebase/app';
import { initializeFirestore, collection, query, orderBy, startAfter, limit, getDocs } from 'firebase/firestore';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'data';
const KEEP_DAYS = 300;      // 需覆蓋 MA200 暖身 + 120 根顯示 + 60 日 RS 回看
const PAGE = 150;

// 與網站相同的公開設定；ibdRsRatings / stockWatchlist 皆為公開讀取，無需任何憑證
const app = initializeApp({
  apiKey: 'AIzaSyAUDHCT_dtMHQFPcUh6-gFSIFXT6dR9MVg',
  authDomain: 'my-tools-1228.firebaseapp.com',
  projectId: 'my-tools-1228',
  storageBucket: 'my-tools-1228.firebasestorage.app',
  messagingSenderId: '511787460330',
  appId: '1:511787460330:web:2896507029051b666e5993',
});
const db = initializeFirestore(app, { experimentalForceLongPolling: true, useFetchStreams: false });

const tail = (m, dates) => dates.map((d) => (m?.[d] ?? null));

async function fetchUniverse() {
  const RS = collection(db, 'ibdRsRatings');
  const out = [];
  let cursor = null, pages = 0;
  for (;;) {
    const q = cursor
      ? query(RS, orderBy('__name__'), startAfter(cursor), limit(PAGE))
      : query(RS, orderBy('__name__'), limit(PAGE));
    const snap = await getDocs(q);
    if (snap.empty) break;
    for (const s of snap.docs) {
      const d = s.data();
      const dates = Object.keys(d.priceMap || {}).sort().slice(-KEEP_DAYS);
      if (dates.length < 60) continue;                 // 上市過短，無法判斷任何區塊條件
      out.push({
        id: d.id, name: d.name, market: d.market,
        rs: d.ibdRsRating ?? null,
        d5: d.ibdRsDelta7d ?? null, d20: d.ibdRsDelta30d ?? null,
        hl: d.pricePos6m ?? null, vcp: d.vcpScore ?? null,
        p1: d.pricePct1d ?? null, p5: d.pricePct5d ?? null, p20: d.pricePct20d ?? null,
        lastDate: d.ibdRsLastCloseDate ?? null,
        dates,
        open:  tail(d.openMap,   dates),
        close: tail(d.priceMap,  dates),
        high:  tail(d.highMap,   dates),
        low:   tail(d.lowMap,    dates),
        vol:   tail(d.volumeMap, dates),
        rsHist: (d.ibdRsHistory || []).map((h) => ({ d: h.d, r: h.r }))
                  .sort((a, b) => a.d.localeCompare(b.d)),
      });
    }
    cursor = snap.docs[snap.docs.length - 1];
    pages++;
    if (snap.size < PAGE) break;
  }
  console.log(`[fetch] universe ${out.length} 檔 / ${pages} 頁`);
  return out;
}

async function fetchWatchlist() {
  const snap = await getDocs(collection(db, 'stockWatchlist'));
  const out = snap.docs.map((s) => {
    const d = s.data(), h = d.history || {};
    return {
      id: String(d.id), name: d.name, category: d.category ?? null,
      latestInstDate: d.latestInstDate ?? null,
      latestHoldingsDate: d.latestHoldingsDate ?? null,
      // 外資持股動能訊號（analysisUtils.calculateForeignForce 算好後存下來的，
      // 與「連買」是兩套不同訊號，勿混用）
      foreignSignal: d.foreignSignal ?? 'N',
      foreignBCount: d.foreignBCount ?? 0,
      zScore: d.zScore ?? null,
      // newest-first；籌碼報告的連買訊號需要 250 日基準 + 掃描緩衝
      instDates:   (h.instDates   || []).slice(0, 300),
      instForeign: (h.instForeign || []).slice(0, 300),
      instTrust:   (h.instTrust   || []).slice(0, 300),
      instDealer:  (h.instDealer  || []).slice(0, 300),
      // 外資持股張數（newest-first），用來畫持股比例趨勢
      foreignHoldingDates: (h.foreignHoldingDates || []).slice(0, 300),
      foreignTotalHolding: (h.foreignTotalHolding || []).slice(0, 300),
    };
  });
  console.log(`[fetch] watchlist ${out.length} 檔（有產業標籤 ${out.filter((x) => x.category).length}）`);
  return out;
}

mkdirSync(OUT, { recursive: true });
const [u, w] = [await fetchUniverse(), await fetchWatchlist()];
writeFileSync(join(OUT, 'universe.json'), JSON.stringify(u));
writeFileSync(join(OUT, 'watchlist.json'), JSON.stringify(w));
const dates = u.map((s) => s.lastDate).filter(Boolean).sort();
console.log(`[fetch] ✅ 完成，資料最新日 ${dates[dates.length - 1]}`);
process.exit(0);
