/* 股價、營收、外資 加速度 計算在這裡 */
/* 外資持股月增 20% 檢查 也在這 */

/**
 * 核心：中點比較法 (曲率計算)
 * 邏輯：(今日 + n日前)/2 - (n/2日前)
 */
const getCurvature = (history, n) => {
  if (!history || history.length <= n) return 0;
  const today = history[0];
  const nDaysAgo = history[n];
  const midPoint = history[Math.floor(n / 2)];
  
  const chordMid = (today + nDaysAgo) / 2;
  return Number((chordMid - midPoint).toFixed(2));
};

/**
 * 計算三大加速度
 */
export const calculateAllAcc = (stock) => {
  return {
    // 股價加速度 (20日)
    priceAcc: getCurvature(stock.priceHistory, 20),
    
    // 外資加速度 (10日 - 依照您的要求調整)
    foreignAcc: getCurvature(stock.foreignChipHistory, 10),
    
    // 營收加速度 (3個月 - 靈敏版)
    revenueAcc: (() => {
        const h = stock.revenueYoYHistory;
        // 檢查是否有足夠數據 (至少 4 個月)
        if (!h || h.length < 4) return 0;
        
        // A: 直線中點 (本月 + 3個月前) / 2
        const chordMid = (h[0] + h[3]) / 2;
        // B: 實際中點 (1.5個月前，我們取 1 與 2 的平均)
        const arcMid = (h[1] + h[2]) / 2;
        
        return Number((chordMid - arcMid).toFixed(2));
    })()
  };
};

/**
 * 外資持股月增 20% 檢查
 */
export const checkOwnershipAlert = (current, lastMonth) => {
  if (!lastMonth || lastMonth === 0) return false;
  return (current - lastMonth) / lastMonth >= 0.20;
};