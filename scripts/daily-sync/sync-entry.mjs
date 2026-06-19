/* 每日自動同步 — entry（給 esbuild 打包成 Node 可執行，於 GitHub Actions 排程跑）
   重用前端既有同步邏輯，不改任何核心程式碼。

   環境變數：
     SYNC_MODE  = DRY | priceVolume | holdingsRevenue   （預設 DRY）
     SYNC_LIMIT = N                                       （>0 時只同步前 N 檔，測試用）

   DRY            ：只抓一檔 Yahoo 價量驗證 Node 抓取能力，不寫入任何資料。
   priceVolume    ：抓股價/成交量（Yahoo）→ 更新追蹤表（對應網頁「更新價量」按鈕）。
   holdingsRevenue：抓籌碼/外資/營收 → 更新追蹤表（對應「更新外資/營收」按鈕）。 */

// ── localStorage 記憶體 polyfill（stockApi 內部快取會用；Node 無 localStorage）──
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: (k) => { _ls.delete(k); },
  clear: () => { _ls.clear(); },
};

const MODE = process.env.SYNC_MODE || 'DRY';
const LIMIT = Number(process.env.SYNC_LIMIT) || 0;

if (MODE === 'DRY') {
  const { fetchYahooHistoricalPriceVolumeMaps } = await import('../../src/features/StockAnalysis/api/stockApi.js');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const start = new Date(Date.now() - 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  console.log(`[DRY] 用 Node 抓 2330 台積電 Yahoo 價量 ${start} ~ ${today} …`);
  const r = await fetchYahooHistoricalPriceVolumeMaps('2330', start, today);
  const dates = Object.keys(r.priceMap || {}).sort();
  if (dates.length > 0) {
    const last = dates[dates.length - 1];
    console.log(`[DRY] 取得 ${dates.length} 天；最新 ${last} 收盤 ${r.priceMap[last]}，量 ${r.volumeMap?.[last]}`);
    console.log('[DRY] ✅ Node 環境抓 Yahoo 成功 — 整套自動化可行。');
    process.exit(0);
  }
  console.log('[DRY] ❌ 抓不到資料（可能 Yahoo 限流或代碼問題）。');
  process.exit(1);
}

// ── RS 全市場同步（抓全市場價量 + 算 RS 排名，寫入 ibdRsRatings）──
if (MODE === 'rs') {
  const rsApi = await import('../../src/features/StockAnalysis/api/rsApi.js');
  const { SYNC_STATUS_DOC_REF } = await import('../../src/utils/firebaseConfig.js');
  const { setDoc } = await import('firebase/firestore');
  console.log('[rs] 全市場 RS 同步開始…');
  let lastRs = 0;
  await rsApi.syncAllRsRatings({
    onProgress: (s) => {
      const p = s.done || 0;
      if (s.phase === 'done' || p - lastRs >= 50) { console.log(`[rs] ${s.msg || ''}`); lastRs = p; }
    },
    concurrency: rsApi.RS_SYNC_DEFAULT_CONCURRENCY,
    delayMs: rsApi.RS_SYNC_INTRA_DELAY_MS,
    superBatchSize: rsApi.RS_SYNC_SUPER_BATCH_SIZE,
    interBatchRestMs: rsApi.RS_SYNC_INTER_BATCH_REST_MS,
  });
  const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const ts = Date.now();
  await setDoc(SYNC_STATUS_DOC_REF, { rsLastSyncDate: ymd, rsLastSyncAt: ts, updatedAt: ts }, { merge: true });
  console.log('[rs] 補算近 10 交易日漏點…');
  try {
    await rsApi.quickPatchMissingRsDays({ onProgress: () => {}, daysBack: 10 });
  } catch (e) { console.warn('[rs] 補點略過:', e?.message || e); }
  console.log('[rs] ✅ RS 同步完成');
  process.exit(0);
}

// ── 追蹤表同步（priceVolume：沿用 RS 價量 / holdingsRevenue：抓 FinMind 籌碼）──
const { fetchWatchlist } = await import('../../src/features/StockAnalysis/api/watchlist.js');
const { startAnalysisBackgroundSync } = await import('../../src/features/StockAnalysis/services/analysisSyncService.js');

let stocks = await fetchWatchlist();
if (LIMIT > 0) stocks = stocks.slice(0, LIMIT);
console.log(`[${MODE}] 追蹤表清單 ${stocks.length} 檔，開始同步…`);

let lastLogged = 0;
const result = await startAnalysisBackgroundSync({
  stocks,
  syncMode: MODE,
  onProgress: (s) => {
    const p = s.processed || 0;
    if (s.phase === 'done' || p - lastLogged >= 20) {
      console.log(`[${MODE}] ${s.msg}`);
      lastLogged = p;
    }
  },
});

console.log(`[${MODE}] ✅ 完成：${result?.msg || ''}`);
process.exit(result?.phase === 'error' ? 1 : 0);
