import { initializeApp } from 'firebase/app';
import { getFirestore, doc, collection } from 'firebase/firestore'; 
import { getAnalytics } from "firebase/analytics";
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

// FireBase 設定
const firebaseConfig = {
    // 您的實際配置
    apiKey: "AIzaSyAUDHCT_dtMHQFPcUh6-gFSIFXT6dR9MVg",
    authDomain: "my-tools-1228.firebaseapp.com",
    projectId: "my-tools-1228",
    storageBucket: "my-tools-1228.firebasestorage.app",
    messagingSenderId: "511787460330",
    appId: "1:511787460330:web:2896507029051b666e5993",
    measurementId: "G-WFF13TV61G"
};

// 初始化 Firebase 應用程式
const app = initializeApp(firebaseConfig);

// 初始化 Firestore 服務
const db = getFirestore(app);

export const STOCK_WATCHLIST_COLLECTION = collection(db, "stockWatchlist");
// 定義我們儲存日誌的文件路徑和 ID。
export const JOURNAL_DOC_REF = doc(db, "trade_journals", "my_only_log");

// 條件式初始化 Analytics (確保部署時不崩潰)
let analytics;
if (ExecutionEnvironment.canUseDOM) {
    analytics = getAnalytics(app);
}

// 導出 db 實例 (如果未來需要其他 Firestore 操作)
export { db, analytics };