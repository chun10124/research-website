/* src/components/NavbarAccount.jsx */

/**
 * 把身分小鈕掛到 Docusaurus navbar 右側（深色模式切換鈕旁邊）。
 *
 * 用 portal 而非 swizzle navbar 的原因：新增 navbar item 必須改
 * docusaurus.config.js，那是本專案的唯讀保護檔。portal 只需在 Root 掛一次，
 * 不動任何 Docusaurus 設定。
 *
 * 未登入時不 render 任何東西——朋友只看 RS 頁，不該看到帳號相關 UI。
 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from '@docusaurus/router';
import { useAuth } from '../utils/useAuth';
import AccountChip from './AccountChip';

const SLOT_ATTR = 'data-account-slot';

export default function NavbarAccount() {
  const [host, setHost] = useState(null);
  const { user, ready, logout } = useAuth();
  const location = useLocation();

  const signedIn = ready && !!user;

  useEffect(() => {
    let alive = true;
    let raf = 0;

    // 未登入就完全不碰 DOM：不建掛載點，navbar 對訪客維持原樣
    if (!signedIn) {
      document.querySelector(`[${SLOT_ATTR}]`)?.remove();
      setHost(null);
      return undefined;
    }

    /** 掛載點插在「深色模式切換鈕」正後方（已在目前 navbar 裡就重用） */
    const ensureSlot = () => {
      // 換頁瞬間新舊 navbar 會並存，querySelector 會抓到即將被移除的舊的。
      // 取最後一個＝最新掛上的那個。
      const all = document.querySelectorAll('.navbar__items--right');
      const right = all.length ? all[all.length - 1] : null;
      if (!right) return;
      let el = right.querySelector(`[${SLOT_ATTR}]`);
      if (!el || !el.isConnected) {
        el = document.createElement('div');
        el.setAttribute(SLOT_ATTR, '1');
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.marginLeft = '10px';
        // 色彩模式切換鈕的 class 是 CSS module 產生的雜湊，用前綴比對
        const toggle = [...right.children].find((c) =>
          String(c.className || '').includes('colorModeToggle')
        );
        if (toggle) toggle.insertAdjacentElement('afterend', el);
        else right.appendChild(el);
      }
      if (alive) setHost((prev) => (prev === el ? prev : el));
    };

    ensureSlot();

    /**
     * 必須觀察 document.body：站內換頁時 Docusaurus 會整個換掉 navbar 元素，
     * 若只觀察 .navbar，換頁後會變成監看已脫離文件的舊節點、永遠不再觸發，
     * 掛載點就再也補不回來（實測症狀＝首頁有頭像、切到績效就消失）。
     * 以 requestAnimationFrame 合併，每幀最多跑一次，RS 頁大量 DOM 變動也不吃效能。
     */
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        ensureSlot();
      });
    };
    const obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true });

    // 舊 navbar 被移除後 DOM 可能就靜止了，觀察者不會再觸發；
    // 換頁後補跑幾次當保險，成本極低。
    const timers = [80, 300, 800].map((ms) => setTimeout(ensureSlot, ms));

    return () => {
      alive = false;
      obs.disconnect();
      timers.forEach(clearTimeout);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [location.pathname, signedIn]);

  // host 可能已被換頁時的 navbar 汰換而脫離文件，這時先不渲染，等 ensureSlot 補上
  if (!host || !host.isConnected || !signedIn) return null;
  return createPortal(<AccountChip user={user} onLogout={logout} />, host);
}
