const PROXY = "https://corsproxy.io/?";
const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";
const TWSE_BASE = "https://openapi.twse.com.tw/v1";
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJkYXRlIjoiMjAyNS0xMi0xNCAxNzowNzo1MyIsInVzZXJfaWQiOiJjaHVuMTAxMjQiLCJpcCI6IjYxLjIyOC43Ni4yMDYifQ.mSi9H6Lrus7e_wkaNxlYd6OoFmh79NQoQ7pZajx166s";

export const fetchCompleteStockData = async (stockCode, onProgress = () => {}) => {
  // 股價/外資抓 60 天；營收抓 2 年；持股抓 60 天以利比對 22 個交易日前數據
  const startDate = "2024-10-01"; 
  const startRevDate = "2023-01-01"; 

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
    onProgress(`📡 [${stockCode}] 正在對接 TaiwanStockShareholding 資料庫...`);

    const [pRes, cRes, hRes, rRes, fRes] = await Promise.all([
      fetch(getUrl("TaiwanStockPrice", startDate)).then(r => r.json()),
      fetch(getUrl("TaiwanStockInstitutionalInvestorsBuySell", startDate)).then(r => r.json()),
      // 🚀 修正：使用正確的持股資料集
      fetch(getUrl("TaiwanStockShareholding", startDate)).then(r => r.json()),
      fetch(getUrl("TaiwanStockMonthRevenue", startRevDate)).then(r => r.json()),
      fetch(`${PROXY}${encodeURIComponent(`${TWSE_BASE}/fund/MI_QFIIS_sort_20`)}`).then(r => r.json())
    ]);

    // 1. 處理營收 (單位：千元 / 自算 YoY)
    const rData = rRes.data || [];
    const rawRev = rData.map(d => Math.round((d.revenue || 0) / 1000)).reverse();
    const sortedRevYoY = rawRev.map((cur, i) => {
      const prev = rawRev[i + 12];
      return prev ? parseFloat(((cur - prev) / prev * 100).toFixed(2)) : 0;
    });

    // 2. 處理外資買賣超 (張) -> 用於 10D 加速度
    const cData = cRes.data || [];
    const foreignBuySell = cData.filter(d => d.name === "Foreign_Investor" || d.name === "外資").reverse();
    const foreignChipHistory = foreignBuySell.map(d => Math.round(((d.buy || 0) - (d.sell || 0)) / 1000));


    
    // 3. 處理「絕對持股張數」 (用於月增 20% 警示)
    const hData = hRes.data || [];
    // 先取出所有張數序列 (由新到舊)
    const sortedHoldings = hData.map(d => {
      const shares = d.ForeignInvestmentShares || 0;
      return Math.round(shares / 1000); // 轉換為「張」
    }).reverse();

    // 修改重點：讓 dailyHoldings 每一筆都算出「當下的月增率」
    const dailyHoldings = hData.map((d, index) => {
      // 因為 hData 原本是由舊到新，我們對齊反轉後的 index
      const revIndex = hData.length - 1 - index; 
      const current = sortedHoldings[revIndex];
      const past = sortedHoldings[revIndex + 22]; // 往後找 22 個交易日
      
      const growth = (past && past > 0) 
        ? (((current - past) / past) * 100).toFixed(2) 
        : "0.00";

      return {
        ...d,
        sharesInLot: current,
        monthlyGrowth: growth // 儲存每一天算出來的月增率
      };
    }).reverse();

    // 取得用於判定的數據（最新一筆）
    const currentShares = sortedHoldings[0] || 0;
    const lastMonthShares = sortedHoldings[Math.min(22, sortedHoldings.length - 1)] || 0;
    const growthRatio = lastMonthShares > 0 ? (currentShares - lastMonthShares) / lastMonthShares : 0;
    
    
    // 4. 處理股價 -> 用於 20D 加速度
    const pData = pRes.data || [];
    const sortedPrices = pData.map(d => d.close).reverse();

    return {
      code: stockCode,
      name: fRes.find(item => item.StockNo === stockCode)?.StockName || pData[0]?.stock_name || stockCode,
      currentPrice: sortedPrices[0] || 0,
      
      // 傳給 UI 的警示數據
      currentForeignShares: sortedHoldings[0] || 0,
      lastMonthForeignShares: sortedHoldings[Math.min(22, sortedHoldings.length - 1)] || 0,
      ownershipGrowth: (growthRatio * 100).toFixed(2), // 月增幅 % [cite: 2025-12-14]
      isOwnershipAlert: growthRatio >= 0.2,            // 鎖碼警示 [cite: 2025-12-14]

      dailyHoldings: dailyHoldings,
      
      history: {
        price: sortedPrices,
        foreign: foreignChipHistory,
        revenueRaw: rawRev,
        revenueYoY: sortedRevYoY
      }
    };
  } 
  catch (error) {
    onProgress(`❌ 錯誤: ${error.message}`);
    return null;
  }
};