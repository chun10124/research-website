import React from 'react';
import Layout from '@theme/Layout';
// 引入我們剛才寫在大資料夾裡的測試組件
import ApiTester from '@site/src/features/StockAnalysis/components/ApiTester';

export default function StockTestPage() {
  return (
    <Layout title="股市 API 測試" description="測試 FinMind 數據抓取與加速度運算">
      <main style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
        <h1>📊 系統核心測試</h1>
        <p>此頁面用於驗證第二階段的 API 串接與數據運算邏輯。</p>
        <hr />
        <ApiTester />
      </main>
    </Layout>
  );
}