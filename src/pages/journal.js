// 文件: src/pages/journal.js (頁面入口檔案)

import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function JournalPage() {
  return (
    // <BrowserOnly> 確保只有在瀏覽器環境中才載入交易日誌組件
    <BrowserOnly fallback={<div>載入個人交易日誌中...</div>}>
      {() => {
        // VVVV 修正點：使用正確的相對路徑 VVVV
        // 從 src/pages 跳到 src/components
        const TradeJournalComponent = require('../components/TradeJournalComponent.jsx').default;
        
        return <TradeJournalComponent />;
      }}
    </BrowserOnly>
  );
}