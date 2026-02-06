// 文件: src/pages/mindmap.js (心智圖頁面入口檔案)

import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function MindMapPage() {
  return (
    <Layout
      title="心智圖"
      description="心智圖工具 - 建立和管理你的心智圖"
    >
      <BrowserOnly fallback={<div>載入心智圖中...</div>}>
        {() => {
          const { MindMapList } = require('../components/MindMapComponent.jsx');
          return <MindMapList />;
        }}
      </BrowserOnly>
    </Layout>
  );
}
