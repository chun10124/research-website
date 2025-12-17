/* src/pages/AnalysisPage.jsx */

import React, { useState } from 'react';
import Layout from '@theme/Layout'; 
import { useStockData } from '../features/StockAnalysis/hooks/useStockData';
import { useDataSync } from '../features/StockAnalysis/hooks/useDataSync';
import { updateAnalysisField } from '../features/StockAnalysis/api/watchlist';
import IndustryAnalysisTable from '../features/StockAnalysis/components/IndustryAnalysisTable'; 

const AnalysisPage = () => {
    const [testCode, setTestCode] = useState('');
    const [statusMessage, setStatusMessage] = useState('');

    const { stocks, loading } = useStockData(); 
    useDataSync(stocks); 
    
    const handleAddStock = async () => {
        const code = testCode.trim();
        if (!code) {
            setStatusMessage('請輸入股票代碼！');
            return;
        }

        setStatusMessage(`🟡 嘗試同步 ${code}...`);
        try {
            await updateAnalysisField(code, { 
                code: code,
                name: `代碼 ${code}`,
                category: '自選',
                lastUpdate: 0, 
                history: { price: [] } 
            });
            setStatusMessage(`✅ ${code} 新增成功！`);
            setTestCode('');
        } catch (error) {
            setStatusMessage(`❌ 失敗：${error.message}`);
        }
    };

    return (
        <Layout title="量化分析儀表板">
            <main style={{ padding: '20px 0' }}>
                <div style={{ padding: '0 20px', maxWidth: '1650px', margin: '0 auto' }}>

                    {/*  1. 表格移到最上面 */}
                    <div style={{ 
                        overflowX: 'auto', 
                        backgroundColor: '#fff', 
                        borderRadius: '8px',
                        boxShadow: '0 4px 6px rgba(0,0,0,0.05)',
                        marginBottom: '30px',
                        marginLeft: '-25px',
                        marginTop: '-25px'
                    }}>
                        <IndustryAnalysisTable />
                    </div>

                    {/*  2. 輸入區移到最下面 (並進行樣式優化) */}
                    <div style={{ 
                        borderTop: '2px solid #eee',
                        paddingTop: '25px',
                        marginTop: '10px'
                    }}>
                        <div style={{ 
                            backgroundColor: '#f8f9fa', 
                            padding: '15px 25px', 
                            borderRadius: '12px',
                            display: 'inline-flex', // 讓它跟內容一樣寬就好
                            alignItems: 'center',
                            gap: '15px'
                        }}>
                            <strong style={{ fontSize: '1.1em', color: '#333' }}>新增/更新股票</strong>
                            <input
                                type="text"
                                value={testCode}
                                onChange={(e) => setTestCode(e.target.value)}
                                placeholder="輸入股票代碼"
                                disabled={loading}
                                style={{ 
                                    padding: '8px 12px', 
                                    border: '1px solid #ccc',
                                    borderRadius: '6px',
                                    width: '140px',
                                    fontSize: '14px'
                                }}
                            />
                            <button 
                                onClick={handleAddStock} 
                                disabled={loading || !testCode}
                                style={{ 
                                    padding: '10px 20px', 
                                    cursor: 'pointer',
                                    backgroundColor: '#25c2a0',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '6px',
                                    fontWeight: 'bold',
                                    transition: 'opacity 0.2s'
                                }}
                            >
                                {loading ? '載入中...' : '同步數據'}
                            </button>
                            
                            <span style={{ 
                                marginLeft: '10px',
                                color: statusMessage.startsWith('❌') ? '#e74c3c' : '#27ae60',
                                fontWeight: '500'
                            }}>
                                {statusMessage}
                            </span>
                        </div>
                        <p style={{ fontSize: '0.85em', color: '#888', marginTop: '10px', paddingLeft: '5px' }}>
                            * 輸入股票代碼後點擊同步，系統將自動從 API 獲取最新的股價、營收與籌碼數據。
                        </p>
                    </div>
                </div>
            </main>
        </Layout>
    );
};

export default AnalysisPage;