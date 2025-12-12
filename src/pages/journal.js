// 文件: src/pages/journal.js (頁面入口檔案)

import React from 'react';
import Layout from '@theme/Layout'; // <<< 引入 Layout 組件
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function JournalPage() {
  return (
    // VVVV 修正點：使用 Layout 組件包裝 VVVV
    <Layout
      title="交易日誌" // 設置頁面標題
      description="跨裝置同步的個人交易日誌"
    >
      <BrowserOnly fallback={<div>載入個人交易日誌中...</div>}>
        {() => {
          // 確保路徑指向您的組件
          const TradeJournalComponent = require('../components/TradeJournalComponent.jsx').default;
          
          return <TradeJournalComponent />;
        }}
      </BrowserOnly>
    </Layout>
    // ^^^^ 修正點結束 ^^^^
  );
}