/* src/features/StockAnalysis/api/stockApi.js */

import { updateAnalysisField } from './watchlist';
const PROXY_BASE = "https://stock-proxy.tzuchun11232004.workers.dev/?url=";
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJkYXRlIjoiMjAyNS0xMi0xNCAxNzowNzo1MyIsInVzZXJfaWQiOiJjaHVuMTAxMjQiLCJpcCI6IjYxLjIyOC43Ni4yMDYifQ.mSi9H6Lrus7e_wkaNxlYd6OoFmh79NQoQ7pZajx166s";

const safeFetch = async (targetUrl) => {
    try {
        if (!targetUrl) return null;
        const fullUrl = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
        const response = await fetch(fullUrl);
        if (!response.ok) {
            const errorText = await response.text();
            console.warn(`[隧道錯誤 ${response.status}]: ${targetUrl.substring(0, 40)} -> ${errorText}`);
            return null;
        }
        const text = await response.text();
        if (!text || text.trim() === "") return null;
        try {
            return JSON.parse(text);
        } catch (parseError) {
            console.error("Worker 回傳內容非 JSON 格式:", text.substring(0, 100));
            return null;
        }
    } catch (e) {
        console.error("私人隧道請求或連線發生異常:", e.message);
        return null;
    }
};

export const fetchCompleteStockData = async (stockCode, onProgress = () => {}) => {
  const sCode = String(stockCode || "").trim();
  if (!sCode || sCode === "NaN" || sCode === "undefined") {
      throw new Error("無效的股票代碼");
  }

  //  1. 計算三年前的日期 (為了取得策略建議的 750 日標準差門檻)
  const today = new Date();
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(today.getFullYear() - 3);
  const THREE_YEARS_START = threeYearsAgo.toISOString().split('T')[0];
  
  const DATA_START_DATE = "2025-10-15"; 
  const REVENUE_START_DATE = "2024-01-01"; 

  const getFinmindUrl = (dataset, start) => {
    const params = new URLSearchParams({ dataset, data_id: sCode, start_date: start, token: TOKEN });
    return `${FINMIND_BASE}?${params.toString()}`;
  };

  try {
    onProgress(` [${sCode}] 正在抓取三年長線持股數據以計算策略門檻...`);

    // 🔴 2. 移除買賣超 (InstitutionalInvestorsBuySell)
    const [priceRes, holdingRes, revenueRes, infoRes, peRes] = await Promise.all([
      safeFetch(getFinmindUrl("TaiwanStockPrice", DATA_START_DATE)),
      // 🟢 3. 修改：外資持股改抓三年前開始，確保計算 ROC 與 700 日標準差的精準度
      safeFetch(getFinmindUrl("TaiwanStockShareholding", THREE_YEARS_START)), 
      safeFetch(getFinmindUrl("TaiwanStockMonthRevenue", REVENUE_START_DATE)),
      safeFetch(getFinmindUrl("TaiwanStockInfo", "")),
      safeFetch(getFinmindUrl("TaiwanStockPER", DATA_START_DATE))
    ]);

    if (!priceRes || !priceRes.data || priceRes.data.length === 0) {
        throw new Error("無法取得基礎股價數據，請檢查代碼或隧道狀態");
    }

    const latestPER = (peRes?.data && peRes.data.length > 0) 
        ? peRes.data[peRes.data.length - 1].PER 
        : '--';

    const priceCloseArray_NewestFirst = (priceRes.data || []).map(d => d.close).reverse(); 
    
    // 🔴 4. 移除外資買賣超流量計算 (foreignChipFlowNet)
    
    // 🟢 5. 處理三年份的持股數據 (確保順序為最新在前，供策略運算使用)
    const rawHoldingData = holdingRes?.data || [];
    const foreignTotal_NewestFirst = rawHoldingData
      .map(d => Math.round((d.ForeignInvestmentShares || 0) / 1000)).reverse();
    
    const revenueArray_OldestFirst = (revenueRes?.data || []).map(d => Math.round((d.revenue || 0) / 1000)); 
    const revenueYoYArray_OldestFirst = revenueArray_OldestFirst
        .map((cur, i) => {
            const prev = revenueArray_OldestFirst[i - 12];
            return (prev && prev > 0) ? parseFloat(((cur - prev) / prev * 100).toFixed(2)) : null;
        }).filter(val => val !== null);

    const stockName = (infoRes?.data || []).find(d => d.stock_id === sCode)?.stock_name || "未知";

    return {
      code: sCode,
      name: stockName,
      currentPrice: priceCloseArray_NewestFirst[0] || 0,
      yesterdayClose: priceCloseArray_NewestFirst[1] || 0,
      realTimePE: latestPER,
      lastUpdate: Date.now(),
      history: {
        priceClose: priceCloseArray_NewestFirst, 
        // 🔴 移除 foreignChipFlowNet
        foreignTotalHolding: foreignTotal_NewestFirst, // 此陣列現在包含約 750+ 筆數據
        revenueRaw: revenueArray_OldestFirst,
        revenueYoY: revenueYoYArray_OldestFirst
      }
    };
  } catch (error) {
    onProgress(`❌ 錯誤: ${error.message}`);
    throw error; 
  }
};

// syncStockSnapshots 保持原樣
export const syncStockSnapshots = async (stock) => {
  console.log(`🚀 正在同步 ${stock.name || stock.code}...`);
  try {
    const latestData = await fetchCompleteStockData(stock.code);
    if (!latestData) return;
    await updateAnalysisField(stock.code, {
      ...latestData,
      estimatedEPS: stock.estimatedEPS || 0,
      targetPrice: stock.targetPrice || 0,
      notes: stock.notes || "",
      lastUpdate: Date.now()
    });
    console.log(`✅ [${stock.code}] 數據同步成功。`);
  } catch (error) {
    console.error(`❌ [${stock.code}] 失敗:`, error.message);
  }
};