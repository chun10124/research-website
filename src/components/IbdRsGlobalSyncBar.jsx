/* 全站浮動列：RS 背景同步進度（離開 IBD 頁仍顯示） */

import React, { useEffect, useState } from 'react';
import { subscribeIbdRsSync } from '../features/StockAnalysis/services/ibdRsSyncService';

export default function IbdRsGlobalSyncBar() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    return subscribeIbdRsSync((s) => {
      setRunning(s.running);
      setProgress(s.progress);
    });
  }, []);

  if (!running && !progress) return null;

  const phase = progress?.phase;
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const msg = progress?.msg ?? '';
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const label =
    phase === 'list'
      ? 'RS 同步：清單'
      : phase === 'fetch'
        ? 'RS 同步：抓股價'
        : phase === 'rank'
          ? 'RS 同步：算排名'
          : phase === 'write'
            ? 'RS 同步：寫入'
            : phase === 'done'
              ? 'RS 同步：完成'
              : phase === 'error'
                ? 'RS 同步：錯誤'
                : 'RS 同步';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        zIndex: 9999,
        maxWidth: 'min(360px, calc(100vw - 20px))',
        padding: '8px 11px',
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,0.15)',
        background: phase === 'error' ? '#fef2f2' : phase === 'done' ? '#f0fdf4' : '#0f766e',
        color: phase === 'error' ? '#991b1b' : phase === 'done' ? '#166534' : '#fff',
        fontSize: 12,
        lineHeight: 1.35,
        pointerEvents: 'none',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 2, fontSize: 11 }}>{label}</div>
      <div style={{ opacity: 0.95, wordBreak: 'break-word', fontSize: 11 }}>{msg}</div>
      {phase !== 'done' && phase !== 'error' && phase !== 'rank' && total > 0 && (
        <div
          style={{
            marginTop: 8,
            height: 4,
            borderRadius: 2,
            background: 'rgba(255,255,255,0.35)',
            overflow: 'hidden',
          }}
        >
          <div style={{ width: `${pct}%`, height: '100%', background: '#fff', transition: 'width 0.3s' }} />
        </div>
      )}
      <div style={{ marginTop: 4, fontSize: 9, opacity: 0.82 }}>
        可換頁；背景繼續（勿關分頁）
      </div>
    </div>
  );
}
