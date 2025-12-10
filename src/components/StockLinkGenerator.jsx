import React, { useState } from 'react'; // 移除 useEffect
import styles from './StockLinkGenerator.module.css'; 

// VVVV 嚴格使用您提供的 linkTemplates 陣列 VVVV
const linkTemplates = [
  { 
    name: '財報狗', 
    url: 'https://statementdog.com/analysis/',
  },
 
  { 
    name: '法說會簡報', 
    url: 'https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1?encodeURIComponent=1&step=0&firstin=true&colorchg=&co_id=',
    suffix: '&URL=&from=&COMPANY_ID=&SEQ_NO=&sortMyTable=1&sortMyTable=2&seq=1&seq:2'
  },
   { 
    name: '季/年度報告', 
    url: 'https://statementdog.com/analysis/',
    suffix: '/e-report' 
  },
  { 
    name: 'WebPro法說會影片', 
    url: 'https://webpro.twse.com.tw/WebPortal/search/investor?searchPageUrl=%252FWebPortal%252Fsearch%252Finvestor&keyword=',
    suffix: '&eventDateFrom=&eventDateTo=&topCategoryId=-1&subCategoryId=-1&industryCode=&market=&speaker=&description=&order=eventDate&queryType=normal' 
  },
  { 
    name: 'MoneyDJ', 
    url: 'https://www.google.com/search?q=',
    suffix: '+moneydj' 
  },
  
  { 
    name: 'TradingView', 
    url: 'https://tw.tradingview.com/chart/?symbol=',
    prefix: 'TWSE:', // 必須保留 prefix 邏輯
  },
  { 
    name: 'MoneyDJ News', 
    url: 'https://www.google.com/search?q=',
    suffix: '+moneydj news' 
  },
  { 
    name: '優分析', 
    url: 'https://www.google.com/search?q=',
    suffix: '+優分析' 
  },
  { 
    name: '公開說明書', 
    url: 'https://doc.twse.com.tw/server-java/t57sb01?step=1&colorchg=1&co_id=',
    suffix: '&year=&seamon=&mtype=B' 
  },
  { 
    name: 'Goodinfo籌碼', 
    url: 'https://goodinfo.tw/tw/StockDirectorSharehold.asp?STOCK_ID=',
  },
  
];
// ^^^^ linkTemplates 陣列 ^^^^


function StockLinkGenerator() {
  const [stockCode, setStockCode] = useState('');
  const [links, setLinks] = useState([]);
  // 移除 companyName 和 loading 狀態

  // VVVV 連結生成邏輯 (恢復 prefix 處理) VVVV
  const generateLinks = () => {
    if (!stockCode) {
      alert("請輸入股票代號！");
      return;
    }

    const generatedLinks = linkTemplates.map(template => {
      const finalCode = stockCode;
      
      // 檢查是否有前綴 (Prefix)：例如 'TWSE:' (TradingView 需要)
      const prefix = template.prefix || ''; 
      
      // 檢查是否有後綴 (Suffix)：例如 '/e-report'
      const suffix = template.suffix || ''; 
      
      return {
        name: template.name,
        // 拼接完整的 URL: URL + 前綴 + 代號 + 後綴
        url: template.url + prefix + finalCode + suffix, 
      };
    });

    setLinks(generatedLinks);
  };

  return (
    <div className={styles.container}>
      <h2>快速查詢工具</h2>
      <div className={styles.inputGroup}>
        <input
          type="text"
          placeholder="請輸入股票代號 (例如: 2330)"
          value={stockCode}
          onChange={(e) => {
             setStockCode(e.target.value);
             // 清空舊連結
             setLinks([]); 
          }}
          onKeyDown={(e) => {
             if (e.key === 'Enter') generateLinks();
          }}
          className={styles.inputField}
          // 移除 disabled 屬性
        />
        <button onClick={generateLinks} className={styles.button}>
          生成連結
        </button>
      </div>

      {links.length > 0 && (
        <> {/* 使用 Fragment 來包裹標題和容器，確保排版正確 */}
          {/* VVVV 移除公司名稱顯示 VVVV */}
          <h3>
             {stockCode} 相關連結
          </h3>
          {/* VVVV 連結清單獨立成一個兩欄容器 VVVV */}
          <div className={styles.linksContainer}>
            {links.map(link => (
              <div key={link.name} className={styles.linkItem}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {/* 移除 [公司名稱] 顯示 */}
                  {link.name} 
                </a>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default StockLinkGenerator;