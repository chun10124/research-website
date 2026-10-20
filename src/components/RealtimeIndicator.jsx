/* src/components/RealtimeIndicator.jsx */

/**
 * navbar 右上的即時報價燈號：最近一次成功取得富邦即時價在 STALE_MS 內才亮綠燈，
 * 否則不顯示（盤後、token 失效、不在有即時價的頁面時自然熄滅）。
 * 與帳號小鈕一起由 NavbarAccount 掛進 navbar，只有登入者看得到。
 */

import React, { useEffect, useState } from 'react';
import { useRealtimeStatus } from '../features/StockAnalysis/api/realtimeQuotes';

const STALE_MS = 25000;

const fmtTime = (t) => (t && t.length >= 6 ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : '');

export default function RealtimeIndicator() {
  const { okAt, time } = useRealtimeStatus();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!okAt) return undefined;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [okAt]);

  if (!okAt || now - okAt > STALE_MS) return null;
  const label = `即時報價中${time ? `（${fmtTime(time)}）` : ''}`;
  return (
    <span
      title={label}
      aria-label={label}
      role="status"
      style={{ display: 'inline-flex', alignItems: 'center', marginRight: 10 }}
    >
      <span className="app-live-dot" />
    </span>
  );
}
