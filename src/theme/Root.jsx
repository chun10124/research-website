import React, { Suspense, lazy } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';

/**
 * 全站包一層：
 *  - RS 背景同步浮動列在任意路由顯示
 *  - 登入身分小鈕掛到 navbar 右側（未登入時不顯示任何東西）
 *
 * 兩者都用 lazy 載入：直接 import 會把 Firebase、RS 同步邏輯、上櫃清單備援整包塞進
 * 每一頁都要下載的主程式（約 960 KB），連首頁也要等。改成頁面畫完後才載入。
 * 同步服務是模組單例，lazy 載入拿到的是同一個實例，RS 頁啟動的同步仍會顯示在浮動列。
 */
const IbdRsGlobalSyncBar = lazy(() => import('../components/IbdRsGlobalSyncBar'));
const NavbarAccount = lazy(() => import('../components/NavbarAccount'));

export default function Root({ children }) {
  return (
    <>
      {children}
      <BrowserOnly fallback={null}>
        {() => (
          <Suspense fallback={null}>
            <IbdRsGlobalSyncBar />
            <NavbarAccount />
          </Suspense>
        )}
      </BrowserOnly>
    </>
  );
}
