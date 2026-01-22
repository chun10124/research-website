// 文件: src/pages/whiteboard.js (白板頁面入口檔案)

import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function WhiteboardPage() {
  return (
    <Layout
      title="白板"
      description="便利貼白板 - 記錄和管理你的想法"
    >
      <BrowserOnly fallback={<div>載入白板中...</div>}>
        {() => {
          const WhiteboardComponent = require('../components/WhiteboardComponent.jsx').default;
          return <WhiteboardComponent />;
        }}
      </BrowserOnly>
    </Layout>
  );
}
