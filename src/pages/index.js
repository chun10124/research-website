// research-website/src/pages/index.js

import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';
import StockLinkGenerator from '../components/StockLinkGenerator';
import WhisperTranscriber from '../components/WhisperTranscriber';

const SITE_TITLE = '研究與投資主頁';

export default function Home() {
  return (
    <Layout
      title={SITE_TITLE}
      description="研究、投資分析與自製工具的知識庫。"
    >
      <main>
        <div style={{ padding: '20px' }}>
          <StockLinkGenerator />
          <BrowserOnly>{() => <WhisperTranscriber />}</BrowserOnly>
        </div>
      </main>
    </Layout>
  );
}
