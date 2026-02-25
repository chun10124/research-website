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

// 營收 API 日期轉「資料所屬月」YYYY-MM（公告日 1～15 日視為上月）
const toRevenueMonthStr = (dateStr) => {
  if (!dateStr || dateStr.length < 10) return null;
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);
  if (d <= 15 && m >= 2) return `${y}-${String(m - 1).padStart(2, '0')}`;
  if (d <= 15 && m === 1) return `${y - 1}-12`;
  return `${y}-${String(m).padStart(2, '0')}`;
};

export const fetchCompleteStockData = async (stockCode, onProgress = () => {}, options = {}) => {
  const sCode = String(stockCode || "").trim();
  if (!sCode || sCode === "NaN" || sCode === "undefined") {
      throw new Error("無效的股票代碼");
  }

  const skipRevenue = options.skipRevenue === true && options.existingRevenue != null;
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

  const getLatestDate = (arr) => {
    if (!arr?.length) return null;
    let maxStr = null;
    for (const row of arr) {
      const d = row.date ?? row.Date ?? row.trade_date ?? row.TradeDate;
      const str = d ? String(d).trim().split(' ')[0] : null;
      if (str && /^\d{4}-\d{2}-\d{2}$/.test(str) && (!maxStr || str > maxStr)) maxStr = str;
    }
    return maxStr;
  };

  try {
    onProgress(` [${sCode}] 正在抓取三年長線持股數據以計算策略門檻...`);

    const pricePromise = safeFetch(getFinmindUrl("TaiwanStockPrice", DATA_START_DATE));
    const holdingPromise = safeFetch(getFinmindUrl("TaiwanStockShareholding", THREE_YEARS_START));
    const revenuePromise = skipRevenue ? Promise.resolve(null) : safeFetch(getFinmindUrl("TaiwanStockMonthRevenue", REVENUE_START_DATE));
    const infoPromise = safeFetch(getFinmindUrl("TaiwanStockInfo", ""));
    const pePromise = safeFetch(getFinmindUrl("TaiwanStockPER", DATA_START_DATE));

    const [priceRes, holdingRes, revenueRes, infoRes, peRes] = await Promise.all([
      pricePromise,
      holdingPromise,
      revenuePromise,
      infoPromise,
      pePromise
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
    
    let revenueArray_OldestFirst;
    let latestRevenueDate;
    if (skipRevenue && options.existingRevenue) {
      revenueArray_OldestFirst = options.existingRevenue.revenueRaw || [];
      latestRevenueDate = options.existingRevenue.latestRevenueDate || null;
    } else {
      revenueArray_OldestFirst = (revenueRes?.data || []).map(d => Math.round((d.revenue || 0) / 1000));
      latestRevenueDate = revenueRes?.data?.length ? getLatestDate(revenueRes.data) : null;
    }
    const revenueYoYArray_OldestFirst = (skipRevenue && Array.isArray(options.existingRevenue?.revenueYoY) && options.existingRevenue.revenueYoY.length > 0)
      ? options.existingRevenue.revenueYoY
      : revenueArray_OldestFirst
          .map((cur, i) => {
            const prev = revenueArray_OldestFirst[i - 12];
            return (prev && prev > 0) ? parseFloat(((cur - prev) / prev * 100).toFixed(2)) : null;
          }).filter(val => val !== null);

    const stockName = (infoRes?.data || []).find(d => d.stock_id === sCode)?.stock_name || "未知";

    const latestPriceDate = getLatestDate(priceRes.data);
    const latestHoldingsDate = getLatestDate(holdingRes?.data);

    return {
      code: sCode,
      name: stockName,
      currentPrice: priceCloseArray_NewestFirst[0] || 0,
      yesterdayClose: priceCloseArray_NewestFirst[1] || 0,
      realTimePE: latestPER,
      lastUpdate: Date.now(),
      latestPriceDate,
      latestHoldingsDate,
      latestRevenueDate,
      history: {
        priceClose: priceCloseArray_NewestFirst, 
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
    const now = new Date();
    const lastCompleteMonth = now.getMonth() === 0
      ? `${now.getFullYear() - 1}-12`
      : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;
    const haveLatestRevenue = stock.latestRevenueDate && toRevenueMonthStr(stock.latestRevenueDate) === lastCompleteMonth;
    const opts = haveLatestRevenue
      ? { skipRevenue: true, existingRevenue: { revenueRaw: stock.history?.revenueRaw, revenueYoY: stock.history?.revenueYoY, latestRevenueDate: stock.latestRevenueDate } }
      : {};
    const latestData = await fetchCompleteStockData(stock.code, () => {}, opts);
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