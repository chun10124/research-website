import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function SubscriptionsRoute() {
  return (
    <Layout title="訂閱" description="長線觀察股票的營收與法說追蹤">
      <BrowserOnly fallback={<div>載入訂閱清單中...</div>}>
        {() => {
          const SubscriptionPage = require('../components/SubscriptionPage.jsx').default;
          const AuthGate = require('../components/AuthGate.jsx').default;
          return (
            <AuthGate title="訂閱為私人資料">
              <SubscriptionPage />
            </AuthGate>
          );
        }}
      </BrowserOnly>
    </Layout>
  );
}
