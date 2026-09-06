"""籌碼報告：外資／投信連買訊號 + PDF 排版（唯讀，不寫任何資料庫）。

分區（順序即優先序，個股只出現一次）：
  A 同時觸發外資與投信   B 僅外資   C 僅投信

母體＝追蹤表（stockWatchlist）∩ RS≥85 ∩ 法人資料為最近交易日。
只有追蹤表那 320 檔有法人資料，全市場沒有——這是資料面的硬限制，非設計選擇。
訊號採原始嚴格參數（z>1.0、連買≥2 天），檔數少屬預期行為。

用法：python3 report_chip.py <資料目錄> <輸出目錄>
"""
import json, sys, statistics as st
from collections import Counter
from pathlib import Path
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec, GridSpecFromSubplotSpec
from matplotlib.backends.backend_pdf import PdfPages

sys.path.insert(0, str(Path(__file__).resolve().parent))
from flow_signal import flow_signal                                   # noqa: E402
from report_price import (ok, clean, ma, FONT, GRID, UP_F, UP_E, DN_F, DN_E,   # noqa: E402
                          R, DR, G, DG, MUTED, BARS, COLS, ROWS_PER_PAGE, L, RT)

FOREIGN_C, TRUST_C, HOLD_C = '#c0392b', '#1565c0', '#7c3aed'   # 外資紅／投信藍／持股紫
RS_MIN = 85

SECTIONS = (('A', '同時觸發　外資 ＋ 投信'),
            ('B', '僅外資'),
            ('C', '僅投信'))

# ── 篩選 ────────────────────────────────────────────────────────────────
def screen(watchlist, universe, data_date):
    uni = {s['id']: s for s in universe}
    pool, out = [], {'A': [], 'B': [], 'C': []}
    for w in watchlist:
        u = uni.get(w['id'])
        if not u or (u['rs'] or 0) < RS_MIN: continue
        if w.get('latestInstDate') != data_date: continue     # 法人資料須為最近交易日
        pool.append(w)
        f, t = flow_signal(w)
        w['_f'], w['_t'] = f, t
        key = 'A' if (f['active'] and t['active']) else 'B' if f['active'] else 'C' if t['active'] else None
        if key: out[key].append((w, u))
    for k in out:
        out[k].sort(key=lambda p: -(p[1]['rs'] or 0))
    return out, len(pool)

# ── 卡片：K棒 / 成交量 / 法人買賣超＋外資持股 ────────────────────────────
def card(fig, spec, w, u):
    n = min(BARS, len(u['close']))
    ma20, ma50 = ma(u['close'], 20)[-n:], ma(u['close'], 50)[-n:]
    d, c, v = u['dates'][-n:], u['close'][-n:], u['vol'][-n:]
    o = (u.get('open') or [None] * n)[-n:]
    h = (u.get('high') or [None] * n)[-n:]
    l = (u.get('low') or [None] * n)[-n:]

    inner = GridSpecFromSubplotSpec(3, 1, subplot_spec=spec, height_ratios=[6, 1.8, 2.7], hspace=.06)
    axk, axv, axc = (fig.add_subplot(inner[i]) for i in range(3))

    for i in range(n):
        if not (ok(o[i]) and ok(h[i]) and ok(l[i]) and ok(c[i])): continue
        fc, ec = (UP_F, UP_E) if c[i] >= o[i] else (DN_F, DN_E)
        axk.vlines(i, l[i], h[i], color=ec, lw=.4)
        body = abs(c[i] - o[i]) or (h[i] - l[i]) * .02 or .01
        axk.add_patch(plt.Rectangle((i - .34, min(o[i], c[i])), .68, body,
                                    facecolor=fc, edgecolor=ec, lw=.25))
    for mv, col in ((ma20, '#1f77b4'), (ma50, '#ff7f0e')):
        axk.plot(range(n), [m if ok(m) else float('nan') for m in mv], color=col, lw=.85)
    lo = min([x for x in l if ok(x)] or [0]); hi = max([x for x in h if ok(x)] or [1])
    axk.set_ylim(lo - (hi - lo) * .06, hi + (hi - lo) * .06)

    up = [i for i in range(n) if (ok(o[i]) and ok(c[i]) and c[i] >= o[i])
          or (not ok(o[i]) and (i == 0 or (ok(c[i]) and ok(c[i - 1]) and c[i] >= c[i - 1])))]
    dn = [i for i in range(n) if i not in up]
    axv.bar(up, [v[i] / 1000 if ok(v[i]) else 0 for i in up], color=UP_F, width=.9)
    axv.bar(dn, [v[i] / 1000 if ok(v[i]) else 0 for i in dn], color=DN_F, width=.9)

    # 法人買賣超：inst 陣列為 newest-first，先轉成 date→值再對齊 K 線日期
    fmap = dict(zip(w.get('instDates') or [], w.get('instForeign') or []))
    tmap = dict(zip(w.get('instDates') or [], w.get('instTrust') or []))
    fx = [fmap.get(x) for x in d]
    tx = [tmap.get(x) for x in d]
    axc.bar([i for i in range(n) if ok(fx[i])], [fx[i] for i in range(n) if ok(fx[i])],
            color=FOREIGN_C, width=.85, label='外資')
    axc.bar([i for i in range(n) if ok(tx[i])], [tx[i] for i in range(n) if ok(tx[i])],
            color=TRUST_C, width=.5, label='投信')
    axc.axhline(0, color='#999', lw=.5)

    hmap = dict(zip(w.get('foreignHoldingDates') or [], w.get('foreignTotalHolding') or []))
    hv = [hmap.get(x) for x in d]
    if any(ok(x) for x in hv):
        ax2 = axc.twinx()
        ax2.plot(range(n), [x if ok(x) else float('nan') for x in hv], color=HOLD_C, lw=1.0)
        ax2.set_yticks([])
        for sp in ax2.spines.values(): sp.set_linewidth(.5); sp.set_color('#bbb')
        ax2.set_xlim(-1, n)

    for a in (axk, axv, axc):
        a.set_xlim(-1, n); a.set_xticks([])
        a.grid(True, ls='--', lw=.45, color=GRID)
        a.tick_params(left=False, right=False, bottom=False, top=False,
                      labelleft=False, labelright=False, labelbottom=False)
        for sp in a.spines.values(): sp.set_linewidth(.5); sp.set_color('#bbb')
    axv.set_yticks([]); axc.set_yticks([])

    f, t = w['_f'], w['_t']
    cat, p1 = w.get('category'), u.get('p1')
    axk.text(0., 1.20, f"{u['id']} {u['name']}" + (f"_{cat}" if cat else ''),
             transform=axk.transAxes, ha='left', va='baseline', fontsize=9, fontweight='bold')
    axk.text(1., 1.20, f"RS {u['rs']}　{p1:+.1f}%" if ok(p1) else f"RS {u['rs']}",
             transform=axk.transAxes, ha='right', va='baseline', fontsize=9, color='#555')
    # 第二行：連買資訊 + 外資持股動能標記（放這裡才不會把標題撐到撞上 RS）
    parts = []
    if f['days']: parts.append((f"外資 {f['days']}日 {round(f['cum']):+,}張", FOREIGN_C))
    if t['days']: parts.append((f"投信 {t['days']}日 {round(t['cum']):+,}張", TRUST_C))
    x = 0.
    for txt, col in parts:
        axk.text(x, 1.05, txt, transform=axk.transAxes, ha='left', va='baseline',
                 fontsize=8, color=col, fontweight='bold')
        x += .50
    if w.get('foreignSignal') == 'B':
        axk.text(1., 1.05, f"◆持股動能 B{w['foreignBCount']}", transform=axk.transAxes,
                 ha='right', va='baseline', fontsize=8, color=HOLD_C, fontweight='bold')

# ── 封面 ────────────────────────────────────────────────────────────────
def cover(pdf, inst, fseries, sections, data_date, pool_n):
    fig = plt.figure(figsize=(11.7, 8.3), facecolor='white')
    rule = lambda y: fig.lines.append(
        plt.Line2D([L, RT], [y, y], color='#ddd', lw=.9, transform=fig.transFigure))
    yi = lambda v: v / 1e8                                  # 元 → 億

    fig.text(L, .925, 'RS 籌碼報告', fontsize=25, fontweight='bold')
    fig.text(RT, .932, data_date, fontsize=11, color=MUTED, ha='right')
    rule(.895)
    fig.text(L, .850, '三大法人買賣超', fontsize=13, fontweight='bold')
    fig.text(L + .155, .852, '單位：億元', fontsize=9, color='#999')

    cols = (.30, .42, .54)
    for x, hdr in zip(cols, ('外資', '投信', '自營商')):
        fig.text(x, .795, hdr, fontsize=10.5, color=MUTED, ha='right')
    y = .740
    for key, lbl in (('twse', '上市'), ('tpex', '上櫃'), ('total', '合計')):
        d = inst.get(key) or {}
        bold = 'bold' if key == 'total' else 'normal'
        fig.text(L, y, lbl, fontsize=12, fontweight=bold)
        for x, k in zip(cols, ('foreign', 'trust', 'dealer')):
            val = yi(d.get(k, 0))
            fig.text(x, y, f'{val:+,.1f}', fontsize=13, ha='right',
                     color=(R if val >= 0 else G), fontweight=bold)
        y -= .055

    # 近 20 交易日外資買賣超：單日數字沒有意義，連續性才是重點
    ax = fig.add_axes([.605, .450, .347, .295])
    if fseries:
        vals = [yi(r['foreign']) for r in fseries]
        ax.bar(range(len(vals)), vals,
               color=[R if v >= 0 else G for v in vals], width=.75)
        ax.axhline(0, color='#999', lw=.7)
        step = max(1, len(vals) // 4)
        idx = list(range(0, len(vals), step))
        ax.set_xticks(idx); ax.set_xticklabels([fseries[i]['date'][5:] for i in idx])
        ax.set_xlim(-.8, len(vals) - .2)
    else:
        ax.text(.5, .5, '外資買賣超序列無法取得', ha='center', va='center',
                fontsize=10, color='#999', transform=ax.transAxes)
        ax.set_xticks([]); ax.set_yticks([])
    ax.set_title(f'外資買賣超　近 {len(fseries)} 交易日（億元，上市）',
                 fontsize=10.5, loc='left', pad=6, color='#333')
    ax.tick_params(labelsize=7.5, length=2); ax.grid(True, axis='y', ls='--', lw=.5, color='#eee')
    for sp in ('top', 'right'): ax.spines[sp].set_visible(False)
    for sp in ('left', 'bottom'): ax.spines[sp].set_color('#ccc')

    rule(.385)
    fig.text(L, .325, '連買訊號', fontsize=13, fontweight='bold')
    fig.text(L + .13, .327,
             f'母體 {pool_n} 檔（追蹤表 ∩ RS≥{RS_MIN} ∩ 法人資料為最近交易日）',
             fontsize=9.5, color='#999')
    y = .245
    for key, desc in SECTIONS:
        fig.text(L, y, f'{key}　{desc}', fontsize=12, fontweight='bold')
        fig.text(RT, y, f'{len(sections[key])} 檔', fontsize=12, ha='right', fontweight='bold')
        y -= .058
    fig.text(L, y - .01,
             '訊號＝每日買賣超 z-score（vs 過去 250 日）連續 2 天以上 > 1.0σ。'
             '採原始嚴格參數，檔數少屬預期。',
             fontsize=9, color='#999')
    if inst.get('tpex_date_mismatch'):
        fig.text(RT, .90, f"⚠️ 上櫃法人資料日期為 {inst['tpex_date_mismatch']}",
                 fontsize=8, color=R, ha='right')
    pdf.savefig(fig); plt.close(fig)

def grid_pages(pdf, title, rows, data_date):
    per = COLS * ROWS_PER_PAGE
    pages = max(1, (len(rows) + per - 1) // per)
    for pg in range(pages):
        chunk = rows[pg * per:(pg + 1) * per]
        fig = plt.figure(figsize=(11.7, 8.3), facecolor='white')
        gs = GridSpec(ROWS_PER_PAGE, COLS, figure=fig, hspace=.40, wspace=.14,
                      left=L, right=RT, top=.845, bottom=.035)
        head = title + (f'（{pg + 1}/{pages}）' if pages > 1 else '')
        fig.suptitle(head, fontsize=13, fontweight='bold', y=.945, x=L, ha='left')
        fig.text(RT, .947, f'資料日期 {data_date}', fontsize=8.5, color=MUTED,
                 ha='right', va='bottom')
        fig.lines.append(plt.Line2D([L, RT], [.918, .918], color='#ddd', lw=.9,
                                    transform=fig.transFigure))
        for i, (w, u) in enumerate(chunk):
            card(fig, gs[i // COLS, i % COLS], w, u)
        pdf.savefig(fig); plt.close(fig)

def build(data_dir, out_dir):
    data_dir, out_dir = Path(data_dir), Path(out_dir)
    universe = json.load(open(data_dir / 'universe.json'))
    watchlist = json.load(open(data_dir / 'watchlist.json'))
    inst = json.load(open(data_dir / 'institutional.json'))
    fseries = json.load(open(data_dir / 'foreign_series.json'))

    data_date = Counter(s['lastDate'] for s in universe).most_common(1)[0][0]
    sections, pool_n = screen(watchlist, universe, data_date)
    print(f'[chip] 母體 {pool_n} 檔　' +
          '　'.join(f'{k} {len(v)}' for k, v in sections.items()))

    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = out_dir / f"{data_date[2:].replace('-', '')}_籌碼報告.pdf"
    with PdfPages(pdf_path) as pdf:
        cover(pdf, inst, fseries, sections, data_date, pool_n)
        for key, desc in SECTIONS:
            if sections[key]:
                grid_pages(pdf, f'{key}　{desc}', sections[key], data_date)
    counts = {f'{k} {d}': len(sections[k]) for k, d in SECTIONS}
    print(f'[chip] ✅ {pdf_path}')
    return str(pdf_path), data_date, counts

if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else '_data',
          sys.argv[2] if len(sys.argv) > 2 else '_out')
