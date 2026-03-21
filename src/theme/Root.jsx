import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import IbdRsGlobalSyncBar from '../components/IbdRsGlobalSyncBar';

/** 全站包一層，讓 RS 背景同步浮動列在任意路由顯示 */
export default function Root({ children }) {
  return (
    <>
      {children}
      <BrowserOnly fallback={null}>
        {() => <IbdRsGlobalSyncBar />}
      </BrowserOnly>
    </>
  );
}
