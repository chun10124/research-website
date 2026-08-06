/* src/components/AuthGate.jsx */

/**
 * 私人頁面的登入閘門。
 *
 * 用法（配合各頁既有的 BrowserOnly 結構）：
 *   <AuthGate><TradeJournalComponent /></AuthGate>
 *
 * 三種狀態：
 *   1. 身分還原中 → 顯示載入字樣，**不 render children**
 *      （關鍵：children 一 mount 就會去讀 Firestore，這時還沒有身分會被拒絕）
 *   2. 未登入     → 顯示登入畫面
 *   3. 已登入     → 直接 render children，不加任何額外版面
 *      （身分顯示與登出在 navbar 右側，見 NavbarAccount.jsx）
 *
 * 只有讀寫私人 collection 的頁面需要包：
 *   交易(trade_journals)、績效(trade_journals)、白板/已完成筆記(whiteboard)、
 *   心智圖(mindmaps)、日曆(investor_calendar)
 * RS、追蹤表用的是開放 collection，不包。
 */

import React from 'react';
import { useAuth } from '../utils/useAuth';

const WRAP = {
  maxWidth: 460,
  margin: '64px auto',
  padding: '28px 24px',
  border: '1px solid var(--app-border)',
  borderRadius: 12,
  background: 'var(--app-surface)',
  textAlign: 'center',
  color: 'var(--app-text)',
};

export default function AuthGate({ children, title = '這是私人資料' }) {
  const { user, ready, error, signIn } = useAuth();

  if (!ready) {
    return (
      <div style={{ ...WRAP, border: 'none', background: 'transparent', color: 'var(--app-text-soft)' }}>
        確認登入狀態中…
      </div>
    );
  }

  if (!user) {
    return (
      <div style={WRAP}>
        <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--app-text-soft)', lineHeight: 1.6, marginBottom: 20 }}>
          請用 Google 登入後檢視。
          <br />
          同一台裝置只需登入一次，之後會自動保持登入。
        </div>
        <button
          type="button"
          onClick={signIn}
          style={{
            padding: '9px 22px',
            fontSize: 14,
            fontWeight: 700,
            borderRadius: 8,
            border: '1px solid var(--app-border)',
            background: 'var(--app-surface-2)',
            color: 'var(--app-text)',
            cursor: 'pointer',
          }}
        >
          使用 Google 登入
        </button>
        {error ? (
          <div style={{ marginTop: 14, fontSize: 12, color: '#e05a4b', lineHeight: 1.5 }}>{error}</div>
        ) : null}
      </div>
    );
  }

  return <>{children}</>;
}
