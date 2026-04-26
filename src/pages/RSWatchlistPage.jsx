/* RS 觀察列表：Firestore `ibdRsMeta/rsWatchlist`；表格與首頁相同並多「收盤」欄（RS 左側） */

import React, { useCallback, useMemo, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import { useIbdRsData } from '../features/StockAnalysis/hooks/useIbdRsData';
import { useIbdRsWatchlist } from '../features/StockAnalysis/hooks/useIbdRsWatchlist';
import { RsChartModal } from './IBDRsRankingPage';
import IbdRsQuadrantTable from '../features/StockAnalysis/components/IbdRsQuadrantTable';
import { clampIbdDeltaDays, enrichIbdRsRow } from '../features/StockAnalysis/utils/ibdRsRankingEnrich';
import { getEffectiveDisplayRs } from '../features/StockAnalysis/utils/ibdRsRankingTableUtils';

/** 與首頁預設相同之 Δ 回溯（僅供 enrich 使用） */
const ENRICH_FILTERS = {
  deltaShortDays: '5',
  deltaLongDays: '20',
};

function downloadWatchlistJson(rows) {
  const now = new Date();
  const taipeiLocale = { timeZone: 'Asia/Taipei' };
  const dateStr = now.toLocaleDateString('en-CA', taipeiLocale);
  const timeStr = now.toLocaleTimeString('zh-TW', { ...taipeiLocale, hour12: false });

  const data = {
    exportedAt: `${dateStr} ${timeStr}`,
    total: rows.length,
    description: 'RS 觀察清單匯出，供 AI 分析用。RS = 相對強度（0-99），Δ = 相對強度變化，HL = 近六個月高低位置（0=最低，1=最高）。',
    stocks: rows.map((s) => ({
      code: s.id,
      name: s.name,
      lastClose: s.ibdRsLastClose ?? null,
      lastCloseDate: s.ibdRsLastCloseDate ?? null,
      dayChangePct: s.pricePct1d ?? null,
      rs: getEffectiveDisplayRs(s) ?? null,
      rsDelta5: s.delta5d ?? null,
      rsDelta20: s.delta20d ?? null,
      pricePct5d: s.pricePct5d ?? null,
      pricePct20d: s.pricePct20d ?? null,
      pricePos6m: s.pricePos6m ?? null,
    })),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rs-watchlist-${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function RSWatchlistPage() {
  const [selectedStock, setSelectedStock] = useState(null);
  const { stocks, loading } = useIbdRsData();
  const { stockIds, idSet: rsWatchlistIdSet, priorities: rsWatchlistPriorities, ready: watchlistReady, toggle: toggleRsWatchlist, setPriority: setRsWatchlistPriority } =
    useIbdRsWatchlist();

  const stockById = useMemo(() => Object.fromEntries((stocks || []).map((s) => [s.id, s])), [stocks]);

  const orderedRaw = useMemo(() => {
    const items = stockIds.map((id) => stockById[id]).filter(Boolean);
    return [...items].sort((a, b) => {
      const pa = rsWatchlistPriorities[String(a.id)] ?? 99;
      const pb = rsWatchlistPriorities[String(b.id)] ?? 99;
      return pa - pb;
    });
  }, [stockIds, stockById, rsWatchlistPriorities]);

  const enriched = useMemo(
    () => orderedRaw.map((s) => enrichIbdRsRow(s, ENRICH_FILTERS)),
    [orderedRaw]
  );

  const deltaShortDaysResolved = clampIbdDeltaDays(ENRICH_FILTERS.deltaShortDays, 5);
  const deltaLongDaysResolved = clampIbdDeltaDays(ENRICH_FILTERS.deltaLongDays, 20);
  const deltaShortTitle = `今日 RS 減去 ${deltaShortDaysResolved} 個交易日前之 RS（ibdRsHistory 筆數；需足夠歷史）`;
  const deltaLongTitle = `今日 RS 減去 ${deltaLongDaysResolved} 個交易日前之 RS（ibdRsHistory 筆數；需足夠歷史）`;

  const tdBase = {
    padding: '2px 5px',
    border: '1px solid #f0f0f0',
    verticalAlign: 'middle',
    height: 22,
    boxSizing: 'border-box',
    fontSize: 11.5,
  };

  const thBase = {
    padding: '4px 5px',
    border: '1px solid #ddd',
    textAlign: 'center',
    background: '#dce8f8',
    fontWeight: 700,
    fontSize: 11,
    height: 26,
  };

  const openStockModal = useCallback((s) => {
    setSelectedStock(s);
  }, []);

  return (
    <Layout title="RS 觀察列表">
      <main className="ibd-rs-ranking-main" style={{ padding: '8px 0 12px', minWidth: 0 }}>
        <div className="ibd-rs-ranking-page-inner" style={{ padding: '0 10px', minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: '1.15rem' }}>RS 觀察列表</h2>
            <Link
              to="/IBDRsRankingPage"
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#0f766e',
                textDecoration: 'none',
                borderBottom: '1px solid rgba(15, 118, 110, 0.35)',
              }}
            >
              ← 回 RS 排名
            </Link>
            <div style={{ marginLeft: 'auto' }}>
              <button
                onClick={() => downloadWatchlistJson(enriched)}
                disabled={enriched.length === 0}
                title="下載觀察清單 JSON，供 AI 分析用"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: enriched.length === 0 ? '#aaa' : '#1d4ed8',
                  background: enriched.length === 0 ? '#f5f5f5' : '#eff6ff',
                  border: `1px solid ${enriched.length === 0 ? '#ddd' : '#bfdbfe'}`,
                  borderRadius: 5,
                  cursor: enriched.length === 0 ? 'not-allowed' : 'pointer',
                  lineHeight: 1.4,
                }}
              >
                ↓ 下載清單（{enriched.length} 檔）
              </button>
            </div>
          </div>

          {!watchlistReady || (loading && stocks.length === 0) ? (
            <div style={{ padding: 36, textAlign: 'center', color: '#888', fontSize: 13 }}>載入中…</div>
          ) : enriched.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: 'center',
                color: '#888',
                background: '#fff',
                border: '1px solid #eee',
                borderRadius: 6,
              }}
            >
              尚無項目。請至 RS 排名開啟個股圖表，點右下角星星加入。
            </div>
          ) : (
            <div
              className="ibd-rs-ranking-table-scroll"
              role="region"
              aria-label="RS 觀察列表表"
              style={{ width: 'max-content', maxWidth: '100%' }}
            >
              <IbdRsQuadrantTable
                rows={enriched}
                tdBase={tdBase}
                thBase={thBase}
                onNameClick={(s) => openStockModal(s)}
                showLastCloseColumn
                deltaShortLabel={`Δ${deltaShortDaysResolved}`}
                deltaLongLabel={`Δ${deltaLongDaysResolved}`}
                deltaShortTitle={deltaShortTitle}
                deltaLongTitle={deltaLongTitle}
              />
            </div>
          )}
        </div>
      </main>

      {selectedStock && (
        <RsChartModal
          stock={selectedStock}
          navigationList={enriched}
          onNavigate={setSelectedStock}
          inWatchlist={rsWatchlistIdSet.has(selectedStock.id)}
          onToggleWatchlist={async (st) => {
            await toggleRsWatchlist(st.id);
          }}
          watchlistPriority={rsWatchlistPriorities[selectedStock.id] ?? null}
          onSetPriority={async (st, p) => {
            await setRsWatchlistPriority(st.id, p);
          }}
          onClose={() => setSelectedStock(null)}
        />
      )}
    </Layout>
  );
}
