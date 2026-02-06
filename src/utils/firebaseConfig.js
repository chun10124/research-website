/* src/utils/firebaseConfig.js */
// 🟢 修正：補上 getApp 與 getApps 的導入
import { initializeApp, getApp, getApps } from 'firebase/app';
import { initializeFirestore, doc, collection } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

const firebaseConfig = {
    apiKey: "AIzaSyAUDHCT_dtMHQFPcUh6-gFSIFXT6dR9MVg",
    authDomain: "my-tools-1228.firebaseapp.com",
    projectId: "my-tools-1228",
    storageBucket: "my-tools-1228.firebasestorage.app",
    messagingSenderId: "511787460330",
    appId: "1:511787460330:web:2896507029051b666e5993",
    measurementId: "G-WFF13TV61G"
};

/**
 * 🟢 修正：檢查是否已有初始化過的應用程式，避免開發環境（Hot Reload）重複連線
 */
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

/**
 * 🔴 關鍵解決方案：
 * 強制使用 Long Polling (長輪詢) 以避開 Listen/channel CORS 報錯。
 * 這是解決 localhost 環境下 XMLHttpRequest access control 錯誤的終極方案。
 */
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  useFetchStreams: false, 
});

// 導出集合與文件路徑
export const STOCK_WATCHLIST_COLLECTION = collection(db, "stockWatchlist");
export const JOURNAL_DOC_REF = doc(db, "trade_journals", "my_only_log");
export const WHITEBOARD_DOC_REF = doc(db, "whiteboard", "my_whiteboard");
export const MINDMAP_DOC_REF = doc(db, "mindmaps", "mindmap_list");

// Analytics 初始化
let analytics;
if (ExecutionEnvironment.canUseDOM) {
    analytics = getAnalytics(app);
}

export { analytics };