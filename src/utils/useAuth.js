/* src/utils/useAuth.js */

/**
 * Google 登入狀態 hook。
 *
 * 登入狀態由 Firebase 自行保存在瀏覽器（預設 browserLocalPersistence），
 * 因此只有「第一次在這台裝置」需要按登入；之後開頁面會由 onAuthStateChanged
 * 自動還原，使用者不會看到任何提示。
 *
 * ready 的意義：身分「還原完畢」（不是「已登入」）。
 * 頁面載入後的頭 100~300ms 是還沒還原的狀態，此時若去讀受保護的 Firestore
 * 會拿到 permission-denied，所以呼叫端必須等 ready 為 true 再決定要做什麼。
 */

import { useCallback, useEffect, useState } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { auth } from './firebaseConfig';

export function useAuth() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!auth) {
      // SSR 或 Firebase 未初始化：直接視為「還原完畢且未登入」
      setReady(true);
      return undefined;
    }
    return onAuthStateChanged(
      auth,
      (u) => {
        setUser(u);
        setReady(true);
      },
      (e) => {
        console.warn('[useAuth] onAuthStateChanged 失敗:', e?.message || e);
        setError(e?.message || '無法取得登入狀態');
        setReady(true);
      }
    );
  }, []);

  const signIn = useCallback(async () => {
    if (!auth) return;
    setError(null);
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      // 使用者自己關掉彈窗不算錯誤，不要跳訊息
      const code = e?.code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      if (code === 'auth/unauthorized-domain') {
        setError('此網域尚未在 Firebase Console 的「授權網域」清單中');
        return;
      }
      setError(e?.message || '登入失敗');
    }
  }, []);

  const logout = useCallback(async () => {
    if (!auth) return;
    try {
      await signOut(auth);
    } catch (e) {
      console.warn('[useAuth] 登出失敗:', e?.message || e);
    }
  }, []);

  return { user, ready, error, signIn, logout };
}
