// 文件: src/pages/completed-notes.js (已完成便利貼頁面入口文件)

import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function CompletedNotesPage() {
  return (
    <Layout
      title="已完成的便利貼"
      description="查看已完成的便利貼"
    >
      <BrowserOnly fallback={<div>載入中...</div>}>
        {() => {
          const CompletedNotesComponent = require('../components/CompletedNotesComponent.jsx').default;
          return <CompletedNotesComponent />;
        }}
      </BrowserOnly>
    </Layout>
  );
}
