/* src/features/StockAnalysis/components/RsFundamentalsTab.jsx */

/**
 * RS 個股視窗「基本面」分頁：內容與訂閱頁個股視窗相同（共用 StockFundamentals）。
 * 已訂閱的股票有筆記與提醒；未訂閱的頁尾顯示「訂閱」。
 */

import React, { useEffect, useRef, useState } from 'react';
import StockFundamentals, { AlertSettings, useThemeColors, todayYmd } from '../../../components/StockFundamentals';
import styles from '../../../components/SubscriptionPage.module.css';
import { useRsFundamentals } from '../../Subscriptions/useRsFundamentals';

/** RS 個股視窗的遮罩是 z-index 12000，提醒設定要疊在它上面 */
const SETTINGS_Z = { zIndex: 12100 };

export default function RsFundamentalsTab({ stock, onSubDialogChange }) {
  const ref = useRef(null);
  const colors = useThemeColors(ref);
  const today = todayYmd();
  const f = useRsFundamentals(stock);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => { setShowSettings(false); }, [stock?.id]);
  // 提醒設定開著時，RS 視窗的快捷鍵（Esc 關視窗、方向鍵換股）要先停用
  useEffect(() => {
    onSubDialogChange?.(showSettings);
    return () => onSubDialogChange?.(false);
  }, [showSettings, onSubDialogChange]);

  return (
    <div
      ref={ref}
      className={`${styles.theme} ${styles.embed}`}
      style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
    >
      {f.err && <div className={styles.errText}>{f.err}</div>}
      <StockFundamentals
        stock={stock}
        it={f.item}
        d={f.d}
        stats={f.stats}
        alerts={f.alerts}
        colors={colors}
        today={today}
        onAck={f.ack}
        onReload={f.reload}
        onRemove={f.canWrite ? f.unsubscribe : undefined}
        onSubscribe={f.canWrite ? f.subscribe : undefined}
        onOpenSettings={() => setShowSettings(true)}
        busy={f.busy}
      />
      {showSettings && f.item && (
        <AlertSettings
          it={f.item}
          today={today}
          onUpdate={f.update}
          onClose={() => setShowSettings(false)}
          overlayStyle={SETTINGS_Z}
        />
      )}
    </div>
  );
}
