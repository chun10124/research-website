import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import IbdRsGlobalSyncBar from '../components/IbdRsGlobalSyncBar';
import NavbarAccount from '../components/NavbarAccount';

/**
 * 全站包一層：
 *  - RS 背景同步浮動列在任意路由顯示
 *  - 登入身分小鈕掛到 navbar 右側（未登入時不顯示任何東西）
 */
export default function Root({ children }) {
  return (
    <>
      {children}
      <BrowserOnly fallback={null}>
        {() => (
          <>
            <IbdRsGlobalSyncBar />
            <NavbarAccount />
          </>
        )}
      </BrowserOnly>
    </>
  );
}
