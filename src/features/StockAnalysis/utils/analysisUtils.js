/* src/features/StockAnalysis/utils/analysisUtils.js (營收 SMA3 曲度修正版) */

// =================================================================
// 【核心配置參數】
// =================================================================
const ANALYSIS_CONFIG = {
    SHORT_TREND: {
        N_DAYS: 7,    
        MID_DAYS: 3,  
    },
    MA9_K: 9,
    MA21_K: 21,

    // 營收專用配置
    REVENUE: {
        K_PERIOD: 2,    // 2個月均線
    },
    
    CURVATURE_NORM_ALPHA: 40, 
    REVENUE_NORM_ALPHA: 0.2,
};

// --- 輔助函式區 ---

const calculateSMA = (data, period) => {
    if (!data || data.length < period) return null;
    const latestData = data.slice(0, period);
    return latestData.reduce((a, b) => a + b, 0) / period;
};

/**
 * 股價專用：三點比較法
 */
const calculateThreePointCurvature = (data, n, mid, k) => {
    if (!data || data.length < n + 1 || data.length < mid + k) return null;
    const priceToday = data[0];
    const priceNDaysAgo = data[n];
    const trendCenter = (priceToday + priceNDaysAgo) / 2;
    const kSMAFromMid = calculateSMA(data.slice(mid), k);
    return (trendCenter !== undefined && kSMAFromMid !== null) ? (trendCenter - kSMAFromMid) : null;
};

/**
 * 營收專用：SMA3 曲線曲度計算
 * 公式：(SMA3_最新 + SMA3_2個月前) / 2 - SMA3_1個月前
 */
const calculateRevenueSmaCurvature = (revenueYoYArray, k) => {
    // 數據為 NewestFirst
    if (!revenueYoYArray || revenueYoYArray.length < k + 2) return null;

    // 1. 計算三個時間點的 SMA3
    const smaLatest = calculateSMA(revenueYoYArray, k);           // 最新月的 SMA3
    const sma1MonthAgo = calculateSMA(revenueYoYArray.slice(1), k); // 1個月前的 SMA3
    const sma2MonthsAgo = calculateSMA(revenueYoYArray.slice(2), k); // 2個月前的 SMA3

    if (smaLatest === null || sma1MonthAgo === null || sma2MonthsAgo === null) return null;

    // 2. 執行您的公式：(最新 + 2個月前)/2 - 1個月前
    return ((smaLatest + sma2MonthsAgo) / 2) - sma1MonthAgo;
};

const normalizeTanh = (value, alpha) => {
    if (value === null || value === undefined) return null;
    return parseFloat(Math.tanh(alpha * value).toFixed(2));
};

// --- 核心計算函式 ---

export const calculateSingleStockIndicators = (stock) => {
    const priceData = stock.history?.priceClose || [];
    const chipFlowNetData = stock.history?.foreignChipFlowNet || []; 
    const totalHoldingData = stock.history?.foreignTotalHolding || []; 
    const revenueYoYData = stock.history?.revenueYoY ? [...stock.history.revenueYoY].reverse() : [];
    
    // 股價數據檢查
    const minPriceReq = 3 + 21; 
    if (priceData.length < minPriceReq) return { calculatedStatus: `數據不足` };

    const currentPrice = stock.currentPrice || 1; 

    // 1. 股價曲度
    const raw9 = calculateThreePointCurvature(priceData, 7, 3, 9);
    const raw21 = calculateThreePointCurvature(priceData, 7, 3, 21);

    // 2. 營收曲度 (使用 SMA3 曲線算法)
    const rawRevCurv = calculateRevenueSmaCurvature(revenueYoYData, ANALYSIS_CONFIG.REVENUE.K_PERIOD);

    // 標準化
    const MA9Curvature = normalizeTanh(raw9 !== null ? raw9 / currentPrice : null, ANALYSIS_CONFIG.CURVATURE_NORM_ALPHA);
    const MA21Curvature = normalizeTanh(raw21 !== null ? raw21 / currentPrice : null, ANALYSIS_CONFIG.CURVATURE_NORM_ALPHA);
    const RevenueYoYCurvature = normalizeTanh(rawRevCurv, ANALYSIS_CONFIG.REVENUE_NORM_ALPHA);

    // 3. 籌碼與漲跌
    const raw_WeeklyChipFlow = chipFlowNetData.slice(0, 5).reduce((a, b) => a + b, 0); 
    const holdingGrowth = totalHoldingData[21] ? ((totalHoldingData[0] - totalHoldingData[21]) / totalHoldingData[21]) * 100 : 0;
    const raw_DailyChange = stock.yesterdayClose ? ((stock.currentPrice - stock.yesterdayClose) / stock.yesterdayClose) * 100
    : 0; // 如果無漲跌，則給予 0

    return {
        DailyChange: raw_DailyChange !== null ? parseFloat(raw_DailyChange.toFixed(2)) : 0.00,
        WeeklyChipFlow: raw_WeeklyChipFlow, 
        HoldingGrowth_M: parseFloat(holdingGrowth.toFixed(2)),
        MA9Curvature,
        MA21Curvature,
        RevenueYoYCurvature,
        realTimePE: stock.realTimePE || '--',
        calculatedStatus: '更新成功',
    };
};