/* src/features/StockAnalysis/api/stockApi.js */

import { updateAnalysisField } from './watchlist';
// 確保使用您的私人隧道 URL
const PROXY_BASE = "https://stock-proxy.tzuchun11232004.workers.dev/?url=";
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJkYXRlIjoiMjAyNS0xMi0xNCAxNzowNzo1MyIsInVzZXJfaWQiOiJjaHVuMTAxMjQiLCJpcCI6IjYxLjIyOC43Ni4yMDYifQ.mSi9H6Lrus7e_wkaNxlYd6OoFmh79NQoQ7pZajx166s";

const safeFetch = async (targetUrl) => {
    try {
        if (!targetUrl) return null;
        
        const fullUrl = `${PROXY_BASE}${encodeURIComponent(targetUrl)}`;
        const response = await fetch(fullUrl);
        
        // 如果 Worker 回報錯誤 (500/403/429)
        if (!response.ok) {
            const errorText = await response.text();
            console.warn(`[隧道錯誤 ${response.status}]: ${targetUrl.substring(0, 40)} -> ${errorText}`);
            return null;
        }

        // 先取回文字，手動檢查是否為有效 JSON 以防解析崩潰
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
  // 防禦性檢查：確保 stockCode 存在
  const sCode = String(stockCode || "").trim();
  if (!sCode || sCode === "NaN" || sCode === "undefined") {
      throw new Error("無效的股票代碼");
  }

  const DATA_START_DATE = "2025-10-15"; 
  const REVENUE_START_DATE = "2024-01-01"; 

  const getFinmindUrl = (dataset, start) => {
    const params = new URLSearchParams({ dataset, data_id: sCode, start_date: start, token: TOKEN });
    return `${FINMIND_BASE}?${params.toString()}`;
  };

  try {
    onProgress(` [${sCode}] 正在透過專屬隧道同步數據...`);

    const [priceRes, buySellRes, holdingRes, revenueRes, infoRes, peRes] = await Promise.all([
      safeFetch(getFinmindUrl("TaiwanStockPrice", DATA_START_DATE)),
      safeFetch(getFinmindUrl("TaiwanStockInstitutionalInvestorsBuySell", DATA_START_DATE)),
      safeFetch(getFinmindUrl("TaiwanStockShareholding", DATA_START_DATE)),
      safeFetch(getFinmindUrl("TaiwanStockMonthRevenue", REVENUE_START_DATE)),
      safeFetch(getFinmindUrl("TaiwanStockInfo", "")),
      safeFetch(getFinmindUrl("TaiwanStockPER", DATA_START_DATE))
    ]);

    // 檢查點：確保核心價格數據存在
    if (!priceRes || !priceRes.data || priceRes.data.length === 0) {
        throw new Error("無法取得基礎股價數據，請檢查代碼或隧道狀態");
    }

    // --- 1. 取得 FinMind 本益比 ---
    const latestPER = (peRes?.data && peRes.data.length > 0) 
        ? peRes.data[peRes.data.length - 1].PER 
        : '--';

    // --- 2. 數據清洗 (增加選用串連保護) ---
    const priceCloseArray_NewestFirst = (priceRes.data || []).map(d => d.close).reverse(); 
    
    const rawBuySellData = buySellRes?.data || [];
    const foreignChipFlow_NewestFirst = rawBuySellData
      .filter(d => d.name === "Foreign_Investor" || d.name === "外資")
      .map(d => Math.round(((d.buy || 0) - (d.sell || 0)) / 1000)).reverse();

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
        foreignChipFlowNet: foreignChipFlow_NewestFirst, 
        foreignTotalHolding: foreignTotal_NewestFirst, 
        revenueRaw: revenueArray_OldestFirst,
        revenueYoY: revenueYoYArray_OldestFirst
      }
    };
  } catch (error) {
    onProgress(`❌ 錯誤: ${error.message}`);
    throw error; 
  }
};

export const syncStockSnapshots = async (stock) => {
  console.log(`🚀 正在同步 ${stock.name || stock.code}...`);
  
  try {
    // 1. 呼叫上方已經定義好的 fetchCompleteStockData
    const latestData = await fetchCompleteStockData(stock.code);
    
    if (!latestData) {
        console.warn(`⚠️ [${stock.code}] 未能獲取最新數據`);
        return;
    }

    // 2. 更新 Firebase 裡的資料
    await updateAnalysisField(stock.code, {
      ...latestData,
      // 確保不會蓋掉使用者手動輸入的備註或預估
      estimatedEPS: stock.estimatedEPS || 0,
      targetPrice: stock.targetPrice || 0,
      notes: stock.notes || "",
      lastUpdate: Date.now()
    });

    console.log(`✅ [${stock.code}] 數據同步成功並存入雲端。`);
  } catch (error) {
    console.error(`❌ [${stock.code}] syncStockSnapshots 失敗:`, error.message);
    throw error;
  }
};