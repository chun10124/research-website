import React, { useState } from 'react';
import { fetchCompleteStockData } from '../api/stockApi';

const ApiTester = () => {
  const [code, setCode] = useState('2330');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const runTest = async () => {
    setLoading(true);
    const result = await fetchCompleteStockData(code);
    setData(result);
    setLoading(false);
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h2>📊 全維度數據核對 (含原始持股)</h2>
      <input value={code} onChange={e => setCode(e.target.value)} style={{ padding: '8px' }} />
      <button onClick={runTest} disabled={loading} style={{ marginLeft: '10px', padding: '8px 16px' }}>
        {loading ? '執行中...' : '同步所有資料'}
      </button>

      {data && (
        <div style={{ marginTop: '20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          
          {/* 區塊 A: 你要確認的原始持股 */}
          <section style={boxStyle}>
  <h4 style={{ color: '#d9534f' }}>📍 每日持股監控 (目標：月增 20%)</h4>
  <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
    <table style={tableStyle}>
      <thead>
        <tr style={{ background: '#eee' }}>
          <th>日期</th>
          <th>外資總持股 (張)</th>
          {/* 🚀 這裡把原本的「持股比 %」換成「月增率 %」 */}
          <th>月增率 %</th>
        </tr>
      </thead>
      <tbody>
  {data.dailyHoldings.slice(0, 15).map((h, i) => (
    <tr key={i}>
      <td>{h.date}</td>
      <td style={{ fontWeight: 'bold' }}>{h.sharesInLot?.toLocaleString()} 張</td>
      
      {/* 🚀 移除 i === 0 的限制，改為讀取該行物件中的 monthlyGrowth */}
      <td style={{ 
        color: parseFloat(h.monthlyGrowth) >= 20 ? 'red' : 'inherit',
        fontWeight: parseFloat(h.monthlyGrowth) >= 20 ? 'bold' : 'normal'
      }}>
        {h.monthlyGrowth}%
      </td>
    </tr>
  ))}
</tbody>
    </table>
    <div style={{ fontSize: '12px', color: '#666', marginTop: '10px' }}>
      註：月增率是以最新持股對比 22 個交易日前之張數 [cite: 2025-12-14]。
    </div>
  </div>
</section>

          {/* 區塊 B: 營收核對 */}
          <section style={boxStyle}>
            <h4 style={{ color: '#5cb85c' }}>🧾 營收核對 (千元 / YoY)</h4>
            <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={{ background: '#eee' }}>
                    <th>月份</th>
                    <th>金額 (千元)</th>
                    <th>自算 YoY%</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.revenueRaw.slice(0, 12).map((rev, i) => (
                    <tr key={i}>
                      <td>M-{i}</td>
                      <td>{rev.toLocaleString()}</td>
                      <td>{data.history.revenueYoY[i]}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 區塊 C: 股價與外資買賣超 (張) */}
          <section style={{ ...boxStyle, gridColumn: 'span 2' }}>
            <h4 style={{ color: '#007bff' }}>💰 行情與買賣超 (20D/10D 基礎)</h4>
            <div style={{ display: 'flex', gap: '20px' }}>
              <table style={tableStyle}>
                <thead><tr style={{ background: '#eee' }}><th>天數</th><th>收盤價</th><th>外資買賣 (張)</th></tr></thead>
                <tbody>
                  {data.history.price.slice(0, 10).map((p, i) => (
                    <tr key={i}>
                      <td>D-{i}</td>
                      <td>{p}</td>
                      <td style={{ color: data.history.foreign[i] >= 0 ? 'red' : 'green' }}>
                        {data.history.foreign[i]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

        </div>
      )}
    </div>
  );
};

const boxStyle = { border: '1px solid #ddd', padding: '15px', borderRadius: '8px', background: '#fff' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', textAlign: 'right', fontSize: '13px' };

export default ApiTester;