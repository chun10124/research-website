// research-website/src/pages/index.js

import React from 'react';
import Layout from '@theme/Layout';
// VVVV 確保添加了這一行 VVVV
import StockLinkGenerator from '../components/StockLinkGenerator'; 
// ^^^^ 確保添加了這一行 ^^^^

// 請確保 SITE_TITLE 也在這裡被定義或引入了
const SITE_TITLE = '您的研究與投資主頁'; // 假設 SITE_TITLE 定義在這裡

export default function Home() {
  return (
    <Layout
      title={SITE_TITLE}
      description="研究、投資分析與自製工具的知識庫。"
    >
      {/* 這裡的 <main> 標籤是網頁內容的主體，
          現在它完全是空白的，只依賴 Layout 來顯示 Nav Bar 和 Footer。
      */}
      <main>
        <div style={{ padding: '20px' }}> {/* 增加 padding 以避免貼邊 */}
            <StockLinkGenerator />
        </div>
      </main>
    </Layout>
  );
}