// 樣式常數
export const PNL_COLOR = (pnl) => (pnl > 0 ? 'green' : (pnl < 0 ? 'red' : 'inherit'));
export const GOLDEN_BORDER_COLOR = '#deb887'; 

// 格式化輔助函數
export const formatQuantity = (num) => {
    if (num === null || num === undefined || isNaN(num)) return '0';
    return Math.round(num).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

export const formatAvgCost = (num) => {
    if (num === null || num === undefined || isNaN(num)) return '0.0';
    return Number(num).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
};

export const formatPnl = (pnl) => {
    if (pnl === null || pnl === undefined || isNaN(pnl)) return '0';
    const integerPnl = Math.round(pnl);
    return integerPnl.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};