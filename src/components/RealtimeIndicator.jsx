/* src/components/RealtimeIndicator.jsx */

/**
 * navbar 右上的即時報價燈號（只有登入者看得到，由 NavbarAccount 掛進 navbar）：
 *   綠燈：盤中，畫面上是即時價（LIVE_FRESH_MS 內成功更新過）
 *   橘燈：本頁要即時價，但等滿開頁上限仍沒拿到、或後來一直更新失敗 → 畫面顯示的是資料庫價格
 *         （盤中；收盤後則是「今日收盤取得失敗」）
 *   不亮：開頁還在等第一筆、本頁沒有即時價、週末／盤前、國定假日
 */

import React, { useEffect, useState } from 'react';
import { useRealtimeStatus, twMarketPhase } from '../features/StockAnalysis/api/realtimeQuotes';

/** 盤中每 5 秒更新；超過 15 秒沒成功（連續失敗約 2 次）就視為不是即時 */
const LIVE_FRESH_MS = 15000;

const fmtTime = (t) => (t && t.length >= 6 ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : '');
const taipeiToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

function lightFor(st, now) {
  const phase = twMarketPhase(new Date(now));
  if (!st.active || !phase || st.holiday === taipeiToday()) return null;
  if (phase === 'session') {
    if (st.okAt && now - st.okAt <= LIVE_FRESH_MS) return 'live';
    return now < st.waitUntil ? null : 'stale';
  }
  // 收盤後：拿到今日收盤就不亮燈（收盤價本來就不會跳動）；拿不到才橘燈
  if (st.closeOkAt && st.closeOkAt >= st.failAt) return null;
  return now < st.waitUntil || !st.failAt ? null : 'stale';
}

export default function RealtimeIndicator() {
  const st = useRealtimeStatus();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!st.active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, [st.active]);

  const light = lightFor(st, Math.max(now, Date.now()));
  if (!light) return null;
  const label = light === 'live'
    ? `即時報價中${st.time ? `（${fmtTime(st.time)}）` : ''}`
    : '未取得即時報價，目前顯示資料庫價格';
  return (
    <span
      title={label}
      aria-label={label}
      role="status"
      style={{ display: 'inline-flex', alignItems: 'center', marginRight: 10 }}
    >
      <span className={light === 'live' ? 'app-live-dot' : 'app-live-dot app-live-dot--stale'} />
    </span>
  );
}
