/* src/components/AccountChip.jsx */

/**
 * 身分小鈕：平常只是一顆 24px 的圓（Google 頭像，或 email 首字），
 * 點一下才在下方展開 email 與登出。登出很少用，不該常駐佔空間。
 *
 * 掛在 navbar 右側（見 NavbarAccount.jsx），與深色模式切換鈕並排。
 */

import React, { useEffect, useRef, useState } from 'react';

export default function AccountChip({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  const label = user.email || user.displayName || '已登入';
  const initial = String(label).trim().charAt(0).toUpperCase() || '·';

  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button
        type="button"
        title={`${label}（點擊可登出）`}
        aria-label="帳號"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          // 一律給底色與較高不透明度：先前頭像載入失敗時會變成看不見的透明圓圈
          width: 24,
          height: 24,
          padding: 0,
          overflow: 'hidden',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          border: '1px solid var(--app-border)',
          background: 'var(--app-surface-2)',
          color: 'var(--app-text)',
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1,
          cursor: 'pointer',
          opacity: open ? 1 : 0.85,
          transition: 'opacity 120ms',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = '1';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = open ? '1' : '0.85';
        }}
      >
        {user.photoURL && !avatarFailed ? (
          <img
            src={user.photoURL}
            alt=""
            // Google 頭像常因 referrer 檢查被擋；no-referrer 是標準解法。
            // 仍失敗就退回顯示首字，不會留下空白圓圈。
            referrerPolicy="no-referrer"
            onError={() => setAvatarFailed(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          initial
        )}
      </button>

      {open ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            borderRadius: 8,
            border: '1px solid var(--app-border)',
            background: 'var(--app-surface)',
            boxShadow: '0 8px 22px rgba(0,0,0,0.22)',
            fontSize: 11,
            color: 'var(--app-text-soft)',
            whiteSpace: 'nowrap',
            zIndex: 300,
          }}
        >
          <span>{label}</span>
          <button
            type="button"
            onClick={onLogout}
            style={{
              padding: '3px 9px',
              fontSize: 11,
              borderRadius: 6,
              border: '1px solid var(--app-border)',
              background: 'var(--app-surface-2)',
              color: 'var(--app-text)',
              cursor: 'pointer',
            }}
          >
            登出
          </button>
        </div>
      ) : null}
    </div>
  );
}
