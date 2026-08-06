import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function CalendarPageRoute() {
  return (
    <Layout title="日曆" description="事件日曆">
      <main style={{ padding: 0 }}>
        <BrowserOnly fallback={<div style={{ color: 'var(--app-text-soft)' }}>載入日曆中...</div>}>
          {() => {
            const InvestorCalendar = require('@site/src/components/InvestorCalendar').default;
            const AuthGate = require('@site/src/components/AuthGate.jsx').default;
            return (
              <AuthGate title="日曆為私人資料">
                <InvestorCalendar />
              </AuthGate>
            );
          }}
        </BrowserOnly>
      </main>
    </Layout>
  );
}
