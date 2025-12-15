import { fetchLatestStockData } from './stockApi';
import { updateAnalysisField } from './watchlist';

export const syncStockSnapshots = async (stock) => {
  console.log(`正在同步 ${stock.name} (${stock.code})...`);
  
  const latest = await fetchLatestStockData(stock.code);
  
  if (!latest) return; // 抓取失敗則跳過

  // 1. 維護 22 筆價格歷史 (n=20)
  const priceHistory = latest.allPrices.slice(0, 22);

  // 2. 維護 12 筆外資買賣歷史 (n=10)
  const foreignHistory = latest.allChips.slice(0, 12);

  // 3. 維護 4 筆營收 YoY 歷史 (n=3)
  const revenueHistory = latest.allRevYoY.slice(0, 4);

  // 4. 更新 Firebase
  await updateAnalysisField(stock.id, {
    currentPrice: latest.currentPrice,
    change: latest.change,
    currentForeignOwnership: latest.foreignOwnership,
    priceHistory: priceHistory,
    foreignChipHistory: foreignHistory,
    revenueYoYHistory: revenueHistory,
    lastUpdate: Date.now()
  });
};