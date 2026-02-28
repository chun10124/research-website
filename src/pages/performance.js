import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function PerformancePageRoute() {
  return (
    <Layout title="績效" description="交易績效與淨值曲線">
      <BrowserOnly fallback={<div>載入績效資料中...</div>}>
        {() => {
          const PerformancePage = require('../components/PerformancePage.jsx').default;
          return <PerformancePage />;
        }}
      </BrowserOnly>
    </Layout>
  );
}
