import React from 'react';
import Layout from '@theme/Layout';
// 確保路徑指向正確的組件位置
import TradeJournal from '../components/TradeJournal'; 

function JournalPage() {
  return (
    <Layout
      title="交易日誌"
      description="交易記錄&績效分析"
    >
      <main style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px' }}>
        <TradeJournal />
      </main>
    </Layout>
  );
}

export default JournalPage;