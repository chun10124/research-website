import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function FuturesChipsRoute() {
  return (
    <Layout title="籌碼" description="台指期留倉、散戶多空與外資選擇權布局">
      <BrowserOnly fallback={<div>載入籌碼中...</div>}>
        {() => {
          const FuturesChipsPage = require('../components/FuturesChipsPage.jsx').default;
          return <FuturesChipsPage />;
        }}
      </BrowserOnly>
    </Layout>
  );
}
