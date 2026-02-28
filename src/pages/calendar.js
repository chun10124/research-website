import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function CalendarPageRoute() {
  return (
    <Layout title="投資日曆" description="投資事件日曆，可自訂標籤與多維度視圖">
      <BrowserOnly fallback={<div style={{ padding: '2rem', textAlign: 'center' }}>載入日曆中...</div>}>
        {() => {
          const InvestorCalendar = require('../components/InvestorCalendar.jsx').default;
          return <InvestorCalendar />;
        }}
      </BrowserOnly>
    </Layout>
  );
}
