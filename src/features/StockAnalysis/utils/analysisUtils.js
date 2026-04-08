/* src/features/StockAnalysis/utils/analysisUtils.js */

// =================================================================
// 【核心配置參數】
// =================================================================
const ANALYSIS_CONFIG = {
    MA10_K: 10,
    MA20_K: 20,

    // 營收專用配置
    REVENUE: {
        K_PERIOD: 2,    // 2個月均線
    },
    
    CURVATURE_NORM_ALPHA: 50, 
    REVENUE_NORM_ALPHA: 0.2,
};

// --- 內部輔助函式區 ---

const calculateSMA = (data, period) => {
    if (!data || data.length < period) return null;
    const latestData = data.slice(0, period);
    return latestData.reduce((a, b) => a + b, 0) / period;
};

/**
 * 股價專用：三點比較法 (均線曲度)
 * 公式：((MA今天 + MA6日前) / 2) - MA3日前
 */
const calculateThreePointCurvature = (data, k) => {
    if (!data || data.length < k + 6) return null;

    const maToday = calculateSMA(data, k);              
    const ma3DaysAgo = calculateSMA(data.slice(3), k);  
    const ma6DaysAgo = calculateSMA(data.slice(6), k);  

    if (maToday === null || ma3DaysAgo === null || ma6DaysAgo === null) return null;

    return ((maToday + ma6DaysAgo) / 2) - ma3DaysAgo;
};

/**
 * 🟢 外資買進力道策略 (10D ROC 慣性打破)
 * 核心假設：持股變動率衝破過去 3 年波動範圍時為趨勢表態 [cite: 3, 4]
 */
export const calculateForeignForce = (holdings = [], prevBCount = 0) => {
    // 觀測週期為 10D (兩週)，回測表現最佳，勝率約 58.71% 
    const N = 10; 
    
    // 確保數據足夠計算 10D ROC 以及 700 個交易日(3年) 的標準差 [cite: 8]
    if (!holdings || holdings.length < 700 + N) {
        return { signal: "N", bCount: 0, roc: 0, threshold: 0, zScore: 0 };
    }

    // 1. 計算 ROC 序列: (當天 - N天前) / N天前 [cite: 7]
    const rocHistory = holdings.map((val, i) => {
        const prev = holdings[i + N];
        return (prev && prev !== 0) ? (val - prev) / prev : null;
    }).filter(v => v !== null);

    // 2. 計算滾動標準差門檻 (Rolling Threshold): 過去 700 日 [cite: 8, 9]
    const slice700 = rocHistory.slice(1, 701); // 排除今天，計算交易當下過去的標準差 [cite: 5]
    const mean = slice700.reduce((a, b) => a + b, 0) / slice700.length;
    const stdDev = Math.sqrt(slice700.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / 700);

    const todayROC = rocHistory[0];
    const zScore = stdDev !== 0 ? (todayROC / stdDev).toFixed(1) : 0;

    // 3. 進場訊號與 B 計數：今天 > 今日門檻 → B；連續天數要用「當日門檻」往回判
    //    若用同一門檻比歷史 ROC，門檻每天變動會讓昨天變「未突破」→ 連續兩天都顯示 B1
    let bCount = 0;
    let signal = "N";

    if (todayROC > stdDev) {
        signal = "B";
        for (let i = 0; i < rocHistory.length; i++) {
            const past = rocHistory.slice(i + 1, i + 701);
            if (past.length < 700) break;
            const m = past.reduce((a, b) => a + b, 0) / 700;
            const sd = Math.sqrt(past.map(x => Math.pow(x - m, 2)).reduce((a, b) => a + b, 0) / 700);
            if (rocHistory[i] > sd) {
                bCount++;
            } else {
                break;
            }
        }
    }
    return {
        signal,
        bCount,
        roc: (todayROC * 100).toFixed(2),
        zScore,
        threshold: (stdDev * 100).toFixed(2)
    };
};

/**
 * 營收專用：SMA3 曲線曲度計算
 */
const calculateRevenueSmaCurvature = (revenueYoYArray, k) => {
    if (!revenueYoYArray || revenueYoYArray.length < k + 2) return null;
    const smaLatest = calculateSMA(revenueYoYArray, k);
    const sma1MonthAgo = calculateSMA(revenueYoYArray.slice(1), k);
    const sma2MonthsAgo = calculateSMA(revenueYoYArray.slice(2), k);
    if (smaLatest === null || sma1MonthAgo === null || sma2MonthsAgo === null) return null;
    return ((smaLatest + sma2MonthsAgo) / 2) - sma1MonthAgo;
};

const normalizeTanh = (value, alpha) => {
    if (value === null || value === undefined) return null;
    return parseFloat(Math.tanh(alpha * value).toFixed(2));
};

// --- 核心計算函式 ---

export const calculateSingleStockIndicators = (stock) => {
    const priceData = stock.history?.priceClose || [];
    const totalHoldingData = stock.history?.foreignTotalHolding || []; 
    const revenueYoYData = stock.history?.revenueYoY ? [...stock.history.revenueYoY].reverse() : [];
    
    if (priceData.length < 27) return { calculatedStatus: `數據不足` };

    const currentPrice = stock.currentPrice || 1; 

    // 1. 股價均線曲度
    const raw10 = calculateThreePointCurvature(priceData, 10);
    const raw20 = calculateThreePointCurvature(priceData, 20);

    // 2. 營收曲度
    const rawRevCurv = calculateRevenueSmaCurvature(revenueYoYData, ANALYSIS_CONFIG.REVENUE.K_PERIOD);

    // 3. 標準化
    const MA9Curvature = normalizeTanh(raw10 !== null ? raw10 / currentPrice : null, ANALYSIS_CONFIG.CURVATURE_NORM_ALPHA);
    const MA21Curvature = normalizeTanh(raw20 !== null ? raw20 / currentPrice : null, ANALYSIS_CONFIG.CURVATURE_NORM_ALPHA);
    const RevenueYoYCurvature = normalizeTanh(rawRevCurv, ANALYSIS_CONFIG.REVENUE_NORM_ALPHA);

    // 4. 外資買進力道策略 (10D ROC)
    const force = calculateForeignForce(totalHoldingData, stock.foreignBCount || 0);

    // 5. 漲跌幅計算
    const raw_DailyChange = stock.yesterdayClose ? ((stock.currentPrice - stock.yesterdayClose) / stock.yesterdayClose) * 100 : 0;
    const holdingGrowth = totalHoldingData[21] ? ((totalHoldingData[0] - totalHoldingData[21]) / totalHoldingData[21]) * 100 : 0;

    // 6. 量比：1日成交量 / 5日平均成交量（newest first）
    const volumeData = stock.history?.volume || [];
    let VolumeRatio = null;
    if (volumeData.length >= 5) {
        const sum5 = volumeData.slice(0, 5).reduce((a, b) => a + b, 0);
        if (sum5 > 0 && volumeData[0] != null) {
            VolumeRatio = (volumeData[0] * 5) / sum5;
        }
    }

    return {
        DailyChange: parseFloat(raw_DailyChange.toFixed(2)),
        VolumeRatio,
        // 🟢 替換原本的 WeeklyChipFlow 為 N/B 訊號數據
        foreignSignal: force.signal,
        foreignBCount: force.bCount,
        zScore: force.zScore,
        HoldingGrowth_M: parseFloat(holdingGrowth.toFixed(2)),
        MA9Curvature,
        MA21Curvature,
        RevenueYoYCurvature,
        realTimePE: stock.realTimePE || '--',
        calculatedStatus: '更新成功',
    };
};