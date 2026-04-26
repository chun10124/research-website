import React, { useState, useEffect, useMemo } from 'react';
import { onSnapshot, getDoc, doc } from 'firebase/firestore';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { JOURNAL_DOC_REF, STOCK_WATCHLIST_COLLECTION } from '../utils/firebaseConfig';
import {
  fetchCurrentPrice,
  fetchYahooPrice,
  fetchYahooHistoricalPriceMap,
} from '../features/StockAnalysis/api/stockApi';
import { calculatePnlSummary } from '../utils/pnlCalculator';
import { formatPnl } from '../utils/formatting';
import {
  autoDetectCashFlows,
  getCumulativeCFUpTo,
  previousDay,
  getNAVAt,
  navReturnPercent,
  getDefaultPeriods,
  getMonthlyReturnsMatrix,
} from '../utils/periodReturns';
import { buildDailyNAVCurve } from '../utils/dailyNavEngine';

const GOLDEN_BORDER = '#deb887';

// ─────────────────────────────────────────────────────────────
// 入金自動識別邏輯：
//   掃描交易明細（舊→新），維護 cashBalance。
//   BUY 時若 cashBalance < 買入成本，缺口視為「外部入金」。
//   SELL 時 proceeds 回流 cashBalance（內部盈利，非入金）。
//
// 資產公式：
//   帳戶資產(date) = cumAutoDeposit(date) + cumulativeRealized(date)
//   今日總資產     = cumAutoDeposit(today) + realizedPnl + unrealizedPnl
//
// 報酬率 = (End_NAV / Start_NAV) - 1，入金不影響 NAV。
// ─────────────────────────────────────────────────────────────

function PerformancePage() {
  const [entries, setEntries] = useState([]);
  const [entriesReady, setEntriesReady] = useState(false);
  const [prices, setPrices] = useState({});
  const [pricesLoading, setPricesLoading] = useState(false);
  const [showDeposits, setShowDeposits] = useState(false);
  const [chartNormalized, setChartNormalized] = useState(false);
  const [historicalPricesByCode, setHistoricalPricesByCode] = useState({});
  const [historicalPricesLoading, setHistoricalPricesLoading] = useState(false);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // ── Firestore 監聽（只需要 entries） ───────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      JOURNAL_DOC_REF,
      (snap) => {
        setEntries(snap.exists() ? snap.data().entries || [] : []);
        setEntriesReady(true);
      },
      (err) => console.error('Firestore 監聽失敗:', err)
    );
    return () => unsub();
  }, []);

  // ── 自動識別入金 ──────────────────────────────────────────
  const autoCashFlows = useMemo(() => autoDetectCashFlows(entries), [entries]);

  const totalAutoDeposit = useMemo(
    () => autoCashFlows.reduce((s, c) => s + c.amount, 0),
    [autoCashFlows]
  );

  // ── P&L（全時段，用於持倉與總損益） ─────────────────────
  const allTimeSummary = useMemo(
    () => calculatePnlSummary(entries, 'ALL'),
    [entries]
  );

  const holdings = useMemo(
    () => (allTimeSummary.byStock || []).filter((s) => Math.abs(s.netQuantity) > 1e-6),
    [allTimeSummary]
  );

  const holdingCodes = useMemo(() => holdings.map((s) => s.code), [holdings]);

  // ── 持股市價：每次進入頁面／持倉變動皆先打 API 取最新收盤，Firestore 僅備援 ──
  useEffect(() => {
    if (holdingCodes.length === 0) {
      setPrices({});
      return;
    }
    setPricesLoading(true);
    let cancelled = false;
    const load = async () => {
      const results = await Promise.all(
        holdingCodes.map(async (code) => {
          let price = null;
          const fin = await fetchCurrentPrice(code);
          const finClose = fin?.currentPrice != null ? Number(fin.currentPrice) : NaN;
          if (Number.isFinite(finClose) && finClose > 0) price = finClose;
          if (price == null) {
            const y = await fetchYahooPrice(code);
            if (y != null && y > 0) price = y;
          }
          if (price == null) {
            const bare = code.replace(/\.(TW|tw|TWO|two)$/i, '');
            const candidates = [...new Set([code, bare, `${bare}.TW`, `${bare}.TWO`])];
            for (const id of candidates) {
              const snap = await getDoc(doc(STOCK_WATCHLIST_COLLECTION, id));
              if (snap.exists()) {
                const p = Number(snap.data().currentPrice);
                if (p > 0) { price = p; break; }
              }
            }
          }
          return [code, price];
        })
      );
      if (cancelled) return;
      const next = {};
      results.forEach(([code, p]) => { if (p != null) next[code] = p; });
      setPrices(next);
      setPricesLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [holdingCodes.join(',')]);

  // ── 損益 ──────────────────────────────────────────────────
  const { totalRealizedPnl } = allTimeSummary;

  const holdingsWithPnl = useMemo(() => {
    return holdings.map((s) => {
      const qty = s.netQuantity;
      const mktPrice = prices[s.code] ?? null;
      let unrealizedPnl = 0;
      if (mktPrice != null && mktPrice > 0) {
        unrealizedPnl = qty > 0
          ? (mktPrice - s.avgCost) * qty
          : (s.avgCost - mktPrice) * Math.abs(qty);
      }
      return { ...s, mktPrice, unrealizedPnl };
    });
  }, [holdings, prices]);

  const totalUnrealizedPnl = useMemo(
    () => Math.round(holdingsWithPnl.reduce((s, h) => s + h.unrealizedPnl, 0)),
    [holdingsWithPnl]
  );

  // ── 總資產 ────────────────────────────────────────────────
  // 正確公式：自動入金累計 + 已實現損益 + 未實現損益
  const totalCumulativeCF = useMemo(
    () => getCumulativeCFUpTo(autoCashFlows, todayStr),
    [autoCashFlows, todayStr]
  );

  const totalNetWorth = totalCumulativeCF + totalRealizedPnl + totalUnrealizedPnl;

  // ── 每日 NAV 引擎：時間軸從第一次交易到今天，每日 Cash + Holdings，按日盯市 ─────
  const curveCodes = useMemo(() => {
    const set = new Set();
    (entries || []).forEach((e) => {
      if (e.direction === 'BUY' || e.direction === 'SELL') set.add(e.code);
    });
    return [...set];
  }, [entries]);

  const curveDateRange = useMemo(() => {
    const dates = (entries || [])
      .filter((e) => (e.direction === 'BUY' || e.direction === 'SELL') && (e.date || '').slice(0, 10))
      .map((e) => (e.date || '').slice(0, 10))
      .filter(Boolean);
    if (dates.length === 0) return null;
    return { start: dates.sort()[0], end: todayStr };
  }, [entries, todayStr]);

  useEffect(() => {
    if (!curveDateRange || curveCodes.length === 0) {
      setHistoricalPricesByCode({});
      return;
    }
    setHistoricalPricesLoading(true);
    const { start, end } = curveDateRange;
    const load = async () => {
      const results = await Promise.all(
        curveCodes.map((code) =>
          fetchYahooHistoricalPriceMap(code, start, end).then((map) => [code, map])
        )
      );
      const next = {};
      results.forEach(([code, map]) => { if (Object.keys(map).length > 0) next[code] = map; });
      setHistoricalPricesByCode(next);
      setHistoricalPricesLoading(false);
    };
    load();
  }, [curveDateRange?.start, curveDateRange?.end, curveCodes.join(',')]);

  const priceMapWithToday = useMemo(() => {
    const m = {};
    Object.keys(historicalPricesByCode).forEach((code) => {
      m[code] = { ...historicalPricesByCode[code] };
    });
    Object.keys(prices).forEach((code) => {
      if (prices[code] > 0) {
        if (!m[code]) m[code] = {};
        m[code][todayStr] = prices[code];
      }
    });
    return m;
  }, [historicalPricesByCode, prices, todayStr]);

  const dailyNavCurve = useMemo(
    () => buildDailyNAVCurve(entries, todayStr, priceMapWithToday),
    [entries, todayStr, priceMapWithToday]
  );

  const totalNetWorthFromCurve = dailyNavCurve.length > 0 ? dailyNavCurve[dailyNavCurve.length - 1].totalAssets : (totalCumulativeCF + totalRealizedPnl + totalUnrealizedPnl);

  const chartPoints = useMemo(() => {
    if (dailyNavCurve.length === 0) {
      return totalNetWorthFromCurve !== 0 ? [{ date: todayStr, 淨值: totalNetWorthFromCurve }] : [];
    }
    return dailyNavCurve.map((r) => ({ date: r.date, 淨值: r.totalAssets }));
  }, [dailyNavCurve, totalNetWorthFromCurve, todayStr]);

  const displayChartPoints = useMemo(() => {
    if (!chartNormalized || chartPoints.length === 0) return chartPoints;
    const base = chartPoints[0].淨值;
    if (!base) return chartPoints;
    return chartPoints.map((p) => ({ ...p, 淨值: (100 * p.淨值) / base }));
  }, [chartPoints, chartNormalized]);

  const navCurve = dailyNavCurve;

  const navChartData = useMemo(() => {
    if (navCurve.length === 0) return [];
    const base = navCurve[0].nav || 100;
    return navCurve.map((p) => ({ date: (p.date || '').slice(0, 10), NAV: base > 0 ? (100 * p.nav) / base : p.nav }));
  }, [navCurve]);

  const navChartDomain = useMemo(() => {
    if (navChartData.length === 0) return undefined;
    const vals = navChartData.map((d) => d.NAV).filter((v) => typeof v === 'number');
    if (vals.length === 0) return undefined;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = Math.max(2, (hi - lo) * 0.1);
    return [lo - pad, hi + pad];
  }, [navChartData]);

  // ── 區間報酬率 ────────────────────────────────────────────
  const periods = useMemo(() => getDefaultPeriods(), [todayStr]);

  const periodReturns = useMemo(() => {
    const currentNAV = navCurve.length ? navCurve[navCurve.length - 1].nav : null;
    return periods.map((p) => {
      const startNAV = getNAVAt(navCurve, previousDay(p.startStr) || p.startStr);
      const endNAV = p.endStr >= todayStr ? currentNAV : getNAVAt(navCurve, p.endStr);
      return { ...p, returnPct: navReturnPercent(startNAV, endNAV) };
    });
  }, [navCurve, periods, todayStr]);

  // ── 月度熱力圖 ────────────────────────────────────────────
  const monthlyMatrix = useMemo(
    () => getMonthlyReturnsMatrix(navCurve, todayStr),
    [navCurve, todayStr]
  );

  const heatmapByYear = useMemo(() => {
    const map = new Map();
    for (const { year, month, returnPct } of monthlyMatrix) {
      if (!map.has(year)) map.set(year, {});
      map.get(year)[month] = returnPct;
    }
    return map;
  }, [monthlyMatrix]);

  // ── UI 工具 ───────────────────────────────────────────────
  const pnlColor = (val) => ({ color: val > 0 ? 'red' : val < 0 ? 'green' : 'inherit' });
  const fmtPct = (pct) => pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—';
  const fmtNum = (n) => Math.round(n).toLocaleString('zh-TW');
  const thTdStyle = { padding: '8px 10px', textAlign: 'center', fontSize: '0.8rem' };

  // ── Render ────────────────────────────────────────────────
  if (!entriesReady) {
    return (
      <div style={{ width: '100%', maxWidth: 720, margin: '20px auto', padding: '0 20px', boxSizing: 'border-box' }}>
        <h2 style={{ marginBottom: 24 }}>績效</h2>
        <div style={{ padding: 48, textAlign: 'center', color: '#888' }}>載入中…</div>
      </div>
    );
  }

  const sectionStyle = { width: '100%' };

  return (
    <div style={{ width: '100%', maxWidth: 720, margin: '20px auto', padding: '0 20px', boxSizing: 'border-box', flexShrink: 0 }}>
      <h2 style={{ marginBottom: 24 }}>績效</h2>

      {/* ── 摘要卡片（市價/歷史價未齊時不顯示易錯的數值，避免閃爍） ─────────────────────────────────────── */}
      {(() => {
        const pendingPrices = holdingCodes.length > 0 && pricesLoading;
        const pendingCurve = curveCodes.length > 0 && historicalPricesLoading;
        const showUnrealized = !pendingPrices;
        const showTotalAssets = !pendingPrices && !pendingCurve;
        return (
          <div style={{ ...sectionStyle, display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
            {[
              {
                label: '總已實現損益',
                value: formatPnl(totalRealizedPnl),
                style: pnlColor(totalRealizedPnl),
                sub: null,
              },
              {
                label: `總未實現損益${pricesLoading ? ' (載入中…)' : ''}`,
                value: showUnrealized ? formatPnl(totalUnrealizedPnl) : '—',
                style: showUnrealized ? pnlColor(totalUnrealizedPnl) : {},
                sub: showUnrealized && holdingCodes.length > 0 && totalUnrealizedPnl === 0
                  ? '股價來自 watchlist；若為 0 請先至分析頁同步' : null,
              },
              {
                label: '帳戶總資產（含市值）',
                value: showTotalAssets
                  ? fmtNum(dailyNavCurve.length ? totalNetWorthFromCurve : totalNetWorth)
                  : '—',
                style: {},
              },
            ].map((card) => (
              <div
                key={card.label}
                style={{ flex: '1 1 180px', padding: 16, border: `1px solid ${GOLDEN_BORDER}`, borderRadius: 8, minWidth: 160 }}
              >
                <div style={{ fontSize: '0.88rem', color: '#666', marginBottom: 6 }}>{card.label}</div>
                <div style={{ fontSize: '1.5em', fontWeight: 700, minHeight: 32, ...card.style }}>{card.value}</div>
                {card.sub && <div style={{ fontSize: '0.77rem', color: '#888', marginTop: 5 }}>{card.sub}</div>}
              </div>
            ))}
          </div>
        );
      })()}

      {/* ── 區間報酬率（數字算好前顯示 —） ───────────────────────────────────── */}
      {(() => {
        const tableReady = !(curveCodes.length > 0 && historicalPricesLoading);
        return (
          <div
            style={{ ...sectionStyle, border: `1px solid ${GOLDEN_BORDER}`, borderRadius: 8, padding: 16, marginBottom: 24 }}
          >
            <h4 style={{ margin: '0 0 4px 0' }}>績效（區間報酬率）</h4>
            <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: '#888' }}>
              自動識別的入金不影響 NAV，故不計入報酬。
            </p>
            <div style={{ overflowX: 'auto', width: '100%' }}>
              <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse', fontSize: '0.82rem', tableLayout: 'fixed' }}>
                <colgroup>
                  {periodReturns.map((p) => (
                    <col key={p.key} style={{ width: `${100 / periodReturns.length}%` }} />
                  ))}
                </colgroup>
                <thead>
                  <tr style={{ borderBottom: '2px solid #333' }}>
                    {periodReturns.map((p) => (
                      <th key={p.key} style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 600 }}>
                        {p.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {periodReturns.map((p) => (
                      <td key={p.key} style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 700, ...(tableReady ? pnlColor(p.returnPct ?? 0) : {}) }}>
                        {tableReady ? fmtPct(p.returnPct) : '—'}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ── 資產曲線 ──────────────────────────────────────── */}
      <div
        style={{
          ...sectionStyle,
          border: `1px solid ${GOLDEN_BORDER}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 24,
          background: 'var(--ifm-background-surface-color)',
        }}
      >
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}
        >
          <h4 style={{ margin: 0 }}>資產曲線</h4>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.88rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={chartNormalized}
              onChange={(e) => setChartNormalized(e.target.checked)}
            />
            歸一化（Y 軸從 100 開始）
          </label>
        </div>
        <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: '#888' }}>
          {chartNormalized
            ? '以首筆資產為 100，觀察相對成長曲線。'
            : '每日總資產 = Cash + Σ(持股×當日收盤價)，按日盯市；週末沿用前一交易日收盤價。無歷史價時以成本計。'}
          {historicalPricesLoading && <span style={{ marginLeft: 6, color: '#f90' }}>載入歷史價中…</span>}
        </p>
        {curveCodes.length > 0 && historicalPricesLoading ? (
          <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
            載入歷史價中…
          </div>
        ) : displayChartPoints.length === 0 ? (
          <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
            尚無交易紀錄
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={displayChartPoints} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => (v || '').slice(0, 10)}
              />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => typeof v === 'number' ? v.toLocaleString('zh-TW', { maximumFractionDigits: 0 }) : v} />
              <Tooltip
                formatter={(value) => (typeof value === 'number' ? value.toLocaleString('zh-TW', { maximumFractionDigits: 0 }) : value)}
                labelFormatter={(label) => `日期：${label}`}
              />
              <Legend />
              <ReferenceLine y={0} stroke="#999" strokeDasharray="2 2" />
              <Line
                type="monotone"
                dataKey="淨值"
                stroke="var(--ifm-color-primary)"
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── NAV 曲線（單位淨值） ───────────────────────────── */}
      <div
        style={{
          ...sectionStyle,
          border: `1px solid ${GOLDEN_BORDER}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 24,
          background: 'var(--ifm-background-surface-color)',
        }}
      >
        <h4 style={{ margin: '0 0 8px 0' }}>NAV 曲線（單位淨值）</h4>
        <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: '#888' }}>
          以首日 NAV 為 100，觀察單位淨值相對走勢。入金不改變 NAV，僅反映交易損益。
        </p>
        {curveCodes.length > 0 && historicalPricesLoading ? (
          <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
            載入歷史價中…
          </div>
        ) : navChartData.length === 0 ? (
          <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
            尚無資料
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={navChartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => (v || '').slice(0, 10)}
              />
              <YAxis
                domain={navChartDomain}
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => (typeof v === 'number' ? v.toLocaleString('zh-TW', { maximumFractionDigits: 1 }) : v) ?? ''}
              />
              <Tooltip
                formatter={(value) => (typeof value === 'number' ? value.toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : value)}
                labelFormatter={(label) => `日期：${label}`}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="NAV"
                name="單位淨值"
                stroke="#2e7d32"
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── 月度報酬熱力圖 ────────────────────────────────── */}
      <div
        style={{
          ...sectionStyle,
          border: `1px solid ${GOLDEN_BORDER}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 24,
          background: 'var(--ifm-background-surface-color)',
        }}
      >
        <h4 style={{ margin: '0 0 4px 0' }}>月度報酬熱力圖</h4>
        <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: '#888' }}>
          基於 NAV 計算，僅顯示已結束月份。
        </p>
        {monthlyMatrix.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#888' }}>尚無完整月份資料</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', minWidth: 420 }}>
              <thead>
                <tr>
                  <th style={{ padding: '6px 8px', border: '1px solid #ddd', textAlign: 'center' }}>年</th>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => (
                    <th key={m} style={{ padding: '6px 4px', border: '1px solid #ddd', textAlign: 'center' }}>
                      {m}月
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...heatmapByYear.keys()].sort((a, b) => b - a).map((year) => (
                  <tr key={year}>
                    <td style={{ padding: '6px 8px', border: '1px solid #ddd', textAlign: 'center', fontWeight: 600 }}>
                      {year}
                    </td>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => {
                      const pct = heatmapByYear.get(year)?.[m];
                      const bg =
                        pct == null ? 'transparent'
                        : pct > 0 ? 'rgba(180,0,0,0.28)'
                        : pct < 0 ? 'rgba(0,120,0,0.28)'
                        : 'rgba(0,0,0,0.05)';
                      const color =
                        pct == null ? '#bbb' : pct > 0 ? '#c00' : pct < 0 ? '#0a5' : 'inherit';
                      return (
                        <td
                          key={m}
                          style={{
                            padding: '4px 3px',
                            border: '1px solid #ddd',
                            textAlign: 'center',
                            background: bg,
                            color,
                            minWidth: 46,
                          }}
                          title={pct != null ? `${year}年${m}月：${fmtPct(pct)}` : ''}
                        >
                          {pct != null ? fmtPct(pct) : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 持倉明細 ────────────────────────────────────────── */}
      {holdings.length > 0 && (
        <div
          style={{
            ...sectionStyle,
            border: `1px solid ${GOLDEN_BORDER}`,
            borderRadius: 8,
            padding: 16,
            marginBottom: 24,
            overflowX: 'auto',
          }}
        >
          <h4 style={{ margin: '0 0 12px 0' }}>
            持倉明細 {pricesLoading ? '（市價載入中…）' : ''}
          </h4>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.8rem',
              minWidth: 580,
              tableLayout: 'fixed',
            }}
            className="perf-holdings-table"
          >
            <colgroup>
              <col style={{ width: '10%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '15%' }} />
              <col style={{ width: '15%' }} />
            </colgroup>
            <thead>
              <tr style={{ borderBottom: '2px solid #333', background: 'rgba(0,0,0,0.03)' }}>
                {['代碼', '名稱', '持倉金額', '成本價', '現價', '未實現損益', '損益%'].map((h) => (
                  <th key={h} style={thTdStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...holdingsWithPnl].sort((a, b) => Math.abs(b.unrealizedPnl) - Math.abs(a.unrealizedPnl)).map((s) => {
                const costBasis = s.avgCost * Math.abs(s.netQuantity);
                const unrealizedPct = (s.mktPrice != null && costBasis > 0)
                  ? (s.unrealizedPnl / costBasis) * 100
                  : null;
                return (
                  <tr key={s.code} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={thTdStyle}>{s.code}</td>
                    <td style={{ ...thTdStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</td>
                    <td style={thTdStyle}>
                      {(s.mktPrice != null ? s.mktPrice * s.netQuantity : s.avgCost * s.netQuantity).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                    </td>
                    <td style={thTdStyle}>{s.avgCost.toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
                    <td style={thTdStyle}>
                      {s.mktPrice != null
                        ? s.mktPrice.toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
                        : <span style={{ color: '#f90', fontSize: '0.78rem' }}>⚠ 無市價</span>}
                    </td>
                    <td style={{ ...thTdStyle, fontWeight: 600, ...pnlColor(s.unrealizedPnl) }}>
                      {s.mktPrice != null ? formatPnl(s.unrealizedPnl) : '—'}
                    </td>
                    <td style={{ ...thTdStyle, fontWeight: 600, ...pnlColor(unrealizedPct ?? 0) }}>
                      {unrealizedPct != null ? `${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(2)}%` : '—'}
                    </td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: '2px solid #333', fontWeight: 700, background: 'rgba(0,0,0,0.02)' }}>
                <td colSpan={5} style={thTdStyle}>合計</td>
                <td style={{ ...thTdStyle, ...pnlColor(totalUnrealizedPnl) }}>{formatPnl(totalUnrealizedPnl)}</td>
                <td style={thTdStyle} />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ── 自動識別入金（展開查看） ──────────────────────── */}
      <div
        style={{
          ...sectionStyle,
          border: `1px solid ${GOLDEN_BORDER}`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 24,
        }}
      >
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
          onClick={() => setShowDeposits((v) => !v)}
        >
          <div>
            <h4 style={{ margin: 0 }}>自動識別入金</h4>
            <p style={{ margin: '4px 0 0', fontSize: '0.82rem', color: '#888' }}>
              系統從交易明細推導：買入時現金不足的缺口視為外部入金。
              共 {autoCashFlows.length} 筆，合計 {fmtNum(totalAutoDeposit)} 元。
            </p>
          </div>
          <span style={{ fontSize: '1.2rem', color: '#999' }}>{showDeposits ? '▲' : '▼'}</span>
        </div>

        {showDeposits && (
          <div style={{ marginTop: 12 }}>
            {autoCashFlows.length === 0 ? (
              <p style={{ color: '#aaa', margin: 0 }}>無自動識別入金（尚無交易紀錄）</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #eee' }}>
                    <th style={{ padding: '6px 10px', textAlign: 'left' }}>#</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left' }}>日期</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>入金金額</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left', color: '#999' }}>說明</th>
                  </tr>
                </thead>
                <tbody>
                  {[...autoCashFlows].reverse().map((cf, i) => (
                    <tr key={cf.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '5px 10px', color: '#aaa' }}>{i + 1}</td>
                      <td style={{ padding: '5px 10px' }}>{cf.date}</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 600 }}>
                        {fmtNum(cf.amount)}
                      </td>
                      <td style={{ padding: '5px 10px', fontSize: '0.8rem', color: '#888' }}>
                        買入時現金缺口
                      </td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid #eee', fontWeight: 700 }}>
                    <td colSpan={2} style={{ padding: '6px 10px' }}>合計</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtNum(totalAutoDeposit)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default PerformancePage;
