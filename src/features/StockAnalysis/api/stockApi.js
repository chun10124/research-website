/* src/features/StockAnalysis/api/stockApi.js (最終清晰版) */

const PROXY = "https://corsproxy.io/?";
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";
const TWSE_BASE = "https://openapi.twse.com.tw/v1";
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJkYXRlIjoiMjAyNS0xMi0xNCAxNzowNzo1MyIsInVzZXJfaWQiOiJjaHVuMTAxMjQiLCJpcCI6IjYxLjIyOC43Ni4yMDYifQ.mSi9H6Lrus7e_wkaNxlYd6OoFmh79NQoQ7pZajx166s";

export const fetchCompleteStockData = async (stockCode, onProgress = () => {}) => {
  
  // 依據您的新要求設定抓取區間
  // 注意：由於無法執行日期運算，這裡使用絕對日期，您可以手動調整到實際的 30 天前和 3 個月前
  const DATA_START_DATE = "2025-10-15"; // 抓取約 45 天的股價/持股/買賣超
  const REVENUE_START_DATE = "2024-01-01"; // 抓取約 24 個月的月營收

  const getUrl = (dataset, start) => {
    const params = new URLSearchParams({
      dataset,
      data_id: stockCode,
      start_date: start,
      token: TOKEN
    });
    return `${PROXY}${encodeURIComponent(`${FINMIND_BASE}?${params.toString()}`)}`;
  };

  try {
    onProgress(` [${stockCode}] 開始抓取多方 API 數據 (30日股價, 3月營收)...`);

    // --- 核心 API 請求 ---
    const [priceRes, buySellRes, holdingRes, revenueRes, infoRes] = await Promise.all([
      // 1. 股價 (Price)
      fetch(getUrl("TaiwanStockPrice", DATA_START_DATE)).then(r => r.json()),
      // 2. 買賣超 (Institutional Buy/Sell)
      fetch(getUrl("TaiwanStockInstitutionalInvestorsBuySell", DATA_START_DATE)).then(r => r.json()),
      // 3. 外資總持股 (Shareholding)
      fetch(getUrl("TaiwanStockShareholding", DATA_START_DATE)).then(r => r.json()),
      // 4. 月營收 (Monthly Revenue)
      fetch(getUrl("TaiwanStockMonthRevenue", REVENUE_START_DATE)).then(r => r.json()),
      // 5. 抓名稱
      fetch(getUrl("TaiwanStockInfo", "")).then(r => r.json()),
    ]);

    // --- 數據清洗與轉換 (變數名稱明確定義) ---

    // 1. 股價數據 (Price Data)
    const rawPriceData = priceRes.data || [];
    // 輸出：由新到舊的「收盤價」純數字陣列 (用於 MA 計算)
    const priceCloseArray_NewestFirst = rawPriceData
      .map(d => d.close)
      .reverse(); 

    // 2. 外資買賣超淨額 (Chip Flow Data)
    const rawBuySellData = buySellRes.data || [];
    // 輸出：由新到舊的「外資買賣超淨額」純數字陣列 (單位：千張) (用於 MCI 計算)
    const foreignChipFlowNetInThousands_NewestFirst = rawBuySellData
      .filter(d => d.name === "Foreign_Investor" || d.name === "外資")
      .map(d => Math.round(((d.buy || 0) - (d.sell || 0)) / 1000)) 
      .reverse();

    // 3. 外資總持股張數 (Holding Data)
    const rawHoldingData = holdingRes.data || [];
    // 輸出：由新到舊的「外資總持股張數」純數字陣列 (單位：千張) (用於持股變化率計算)
    const foreignTotalHoldingInThousands_NewestFirst = rawHoldingData
      .map(d => Math.round((d.ForeignInvestmentShares || 0) / 1000)) 
      .reverse();
    
    // 4. 營收數據 (Revenue Data)
    const rawRevenueData = revenueRes.data || [];
    // 輸出：營收數字陣列 (千元) 和 YoY 百分比陣列 (由舊到新)
    const revenueArray_OldestFirst = rawRevenueData
      .map(d => Math.round((d.revenue || 0) / 1000)); 

    const revenueYoYArray_OldestFirst = revenueArray_OldestFirst
        .map((cur, i) => {
            const prevIdx = i - 12; // 往前找 12 個月
            const prev = revenueArray_OldestFirst[prevIdx];
            return (prev && prev > 0) ? parseFloat(((cur - prev) / prev * 100).toFixed(2)) : null;
        })
        .filter(val => val !== null); // 確保只回傳有計算出 YoY 的月份

    // 提取名稱
    const stockInfo = (infoRes.data || []).find(d => d.stock_id === stockCode);
    const stockName = stockInfo ? stockInfo.stock_name : "未知";

    // --- 最終輸出 (傳輸給 Firebase 的結構) ---

    return {
      code: stockCode,
      name: stockName,
      currentPrice: priceCloseArray_NewestFirst[0] || 0,
      yesterdayClose: priceCloseArray_NewestFirst.length >= 2 ? priceCloseArray_NewestFirst[1] : 0,

      // history 物件中的鍵名現在與數據內容完美匹配
      history: {
        // 股價: [最新收盤價, ...]
        priceClose: priceCloseArray_NewestFirst, 
        
        // 籌碼流: [最新買賣超淨額, ...]
        foreignChipFlowNet: foreignChipFlowNetInThousands_NewestFirst, 
        
        // 總持股: [最新持股總數, ...]
        foreignTotalHolding: foreignTotalHoldingInThousands_NewestFirst, 
        
        // 營收: [最早營收, ...], [最早YoY, ...]
        revenueRaw: revenueArray_OldestFirst,
        revenueYoY: revenueYoYArray_OldestFirst
      }
    };
  } 
  catch (error) {
    onProgress(`❌ 錯誤: ${error.message}`);
    throw error; 
  }
};