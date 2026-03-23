/* RS 觀察列表：Firestore `ibdRsMeta/rsWatchlist`；表格與首頁相同並多「收盤」欄（RS 左側） */

import React, { useCallback, useMemo, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import { useIbdRsData } from '../features/StockAnalysis/hooks/useIbdRsData';
import { useIbdRsWatchlist } from '../features/StockAnalysis/hooks/useIbdRsWatchlist';
import { RsChartModal } from './IBDRsRankingPage';
import IbdRsQuadrantTable from '../features/StockAnalysis/components/IbdRsQuadrantTable';
import { clampIbdDeltaDays, enrichIbdRsRow } from '../features/StockAnalysis/utils/ibdRsRankingEnrich';

/** 與首頁預設相同之 Δ 回溯（僅供 enrich 使用） */
const ENRICH_FILTERS = {
  deltaShortDays: '5',
  deltaLongDays: '20',
};

export default function RSWatchlistPage() {
  const [selectedStock, setSelectedStock] = useState(null);
  const { stocks, loading } = useIbdRsData();
  const { stockIds, idSet: rsWatchlistIdSet, ready: watchlistReady, toggle: toggleRsWatchlist } =
    useIbdRsWatchlist();

  const stockById = useMemo(() => Object.fromEntries((stocks || []).map((s) => [s.id, s])), [stocks]);

  const orderedRaw = useMemo(
    () => stockIds.map((id) => stockById[id]).filter(Boolean),
    [stockIds, stockById]
  );

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
          onClose={() => setSelectedStock(null)}
        />
      )}
    </Layout>
  );
}
