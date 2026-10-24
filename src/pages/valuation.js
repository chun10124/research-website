// 估值資料頁：/valuation?id=2330，左季（1Q24 起）右年（2023 起），各附複製按鈕

import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import { useLocation } from '@docusaurus/router';
import { fetchValuationTables } from '../components/valuationData';
import styles from './valuation.module.css';

async function copyTable(table) {
  if (window.ClipboardItem && navigator.clipboard?.write) {
    // 附 HTML 讓貼到 Excel／Numbers 時中文為黑體-簡
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([table.text], { type: 'text/plain' }),
      'text/html': new Blob([table.html], { type: 'text/html' }),
    })]);
  } else {
    await navigator.clipboard.writeText(table.text);
  }
}

function TablePanel({ title, table }) {
  const [copyState, setCopyState] = useState(null); // 'ok' | 'fail'
  const onCopy = async () => {
    try {
      await copyTable(table);
      setCopyState('ok');
    } catch (_) {
      setCopyState('fail');
    }
    setTimeout(() => setCopyState(null), 1500);
  };
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <h3>{title}</h3>
        <button type="button" className={styles.copyButton} onClick={onCopy}>
          {copyState === 'ok' ? '已複製' : copyState === 'fail' ? '複製失敗' : '複製'}
        </button>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>{table.cells[0].map((c, i) => <th key={i}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {table.cells.slice(1).map((row) => (
              <tr key={row[0]}>{row.map((c, i) => (i === 0 ? <th key={i}>{c}</th> : <td key={i}>{c}</td>))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ValuationPage() {
  const { search } = useLocation();
  const id = (new URLSearchParams(search).get('id') || '').trim();
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    if (!id) { setState({ error: '請在網址加上 ?id=股票代號' }); return; }
    let alive = true;
    setState({ loading: true });
    fetchValuationTables(id)
      .then((tables) => alive && setState({ tables }))
      .catch((e) => alive && setState({ error: e.message }));
    return () => { alive = false; };
  }, [id]);

  return (
    <Layout title={id ? `${id} 估值資料` : '估值資料'}>
      <main className={styles.page}>
        <h2>{id} 估值資料</h2>
        {state.loading && <p className={styles.note}>抓取中…</p>}
        {state.error && <p className={styles.error}>{state.error}</p>}
        {state.tables && (
          <div className={styles.panels}>
            <TablePanel title="季" table={state.tables.quarter} />
            <TablePanel title="年" table={state.tables.year} />
          </div>
        )}
      </main>
    </Layout>
  );
}
