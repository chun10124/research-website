"""價格報告：三區塊篩選 + PDF 排版（唯讀，不寫任何資料庫）。

區塊（順序即優先序，個股只出現在最前面符合的那一區）：
  1 創新高  6 個月(120日)新高　RS > 85　MA20 > MA50
  2 追發動  RS > 85　HL > 0.75　MA20 > MA50　當日漲停
  3 強勢股  RS 近 60 交易日上升 > 25　MA20 > MA50　RS > 75

用法：python3 report_price.py <資料目錄> <輸出目錄>
"""
import json, sys, statistics as st
from collections import Counter
from pathlib import Path
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
from matplotlib.gridspec import GridSpec, GridSpecFromSubplotSpec
from matplotlib.backends.backend_pdf import PdfPages

_av = {f.name for f in fm.fontManager.ttflist}
FONT = next((f for f in ('Noto Sans CJK TC', 'Noto Sans TC', 'Heiti TC', 'Arial Unicode MS')
             if f in _av), 'sans-serif')
matplotlib.rcParams.update({'font.sans-serif': [FONT], 'axes.unicode_minus': False,
                            'pdf.fonttype': 42})

# 配色沿用網站 RsChartModal（src/pages/IBDRsRankingPage.jsx:882-911）
SITE_RS, SITE_IDX, GRID = '#c0392b', '#1565c0', '#e5e7eb'
UP_F, UP_E, DN_F, DN_E = '#e53935', '#c62828', '#1a8a30', '#0f5c1e'
R, DR, G, DG, MUTED = '#c62828', '#8e1b1b', '#1a8a30', '#0f5c1e', '#666'
BARS, COLS, ROWS_PER_PAGE = 120, 4, 4
LIMIT_UP_PCT = 9.5          # 台股漲停≈+10%，受最小跳動單位影響，用 9.5% 近似

ok = lambda v: v is not None
clean = lambda xs: [x for x in xs if ok(x)]

def ma(seq, n):
    out = []
    for i in range(len(seq)):
        w = [x for x in seq[max(0, i - n + 1):i + 1] if ok(x)]
        out.append(st.mean(w) if len(w) >= n * 0.8 else None)
    return out

# ── 篩選 ────────────────────────────────────────────────────────────────
def ma_stack(c):
    m20, m50 = ma(c, 20)[-1], ma(c, 50)[-1]
    return ok(m20) and ok(m50) and m20 > m50

def new_high(c, n=120):
    prev = clean(c[-n - 1:-1])
    return bool(prev) and ok(c[-1]) and c[-1] > max(prev)

def limit_up(s, c):
    p = s.get('p1')
    if ok(p): return p >= LIMIT_UP_PCT
    if len(c) < 2 or not ok(c[-2]) or c[-2] <= 0: return False
    return (c[-1] - c[-2]) / c[-2] * 100 >= LIMIT_UP_PCT

def rs_rise_60(s):
    h = s.get('rsHist') or []
    if len(h) < 61: return None
    cur, ref = h[-1]['r'], h[-61]['r']
    return None if cur is None or ref is None else cur - ref

def screen(universe, data_date):
    pool = []
    for s in universe:
        if s['lastDate'] != data_date: continue      # 停牌／下市：資料不新鮮者剔除
        c = s['close']
        if len(c) < 130 or not ok(c[-1]): continue
        pool.append((s, c))

    b1 = [(s, c) for s, c in pool if (s['rs'] or 0) > 85 and new_high(c, 120) and ma_stack(c)]
    b2 = [(s, c) for s, c in pool if (s['rs'] or 0) > 85 and (s['hl'] or 0) > 0.75
          and ma_stack(c) and limit_up(s, c)]
    b3 = [(s, c) for s, c in pool if (s['rs'] or 0) > 75 and ma_stack(c)
          and (rs_rise_60(s) or -99) > 25]

    seen = set()
    def dedupe(rows):
        out = []
        for r in rows:
            if r[0]['id'] in seen: continue
            seen.add(r[0]['id']); out.append(r)
        return out

    order = lambda rows: sorted(dedupe(rows), key=lambda t: -(t[0]['rs'] or 0))
    return {'區塊1': order(b1), '區塊2': order(b2), '區塊3': order(b3)}, len(pool)

# ── 卡片 ────────────────────────────────────────────────────────────────
def card(fig, spec, s, cat, tw_close):
    n = min(BARS, len(s['close']))
    ma20, ma50 = ma(s['close'], 20)[-n:], ma(s['close'], 50)[-n:]   # 含暖身段，線才畫得滿
    d, c, v = s['dates'][-n:], s['close'][-n:], s['vol'][-n:]
    o = (s.get('open') or [None] * n)[-n:]
    h = (s.get('high') or [None] * n)[-n:]
    l = (s.get('low') or [None] * n)[-n:]
    rs = {p['d']: p['r'] for p in (s.get('rsHist') or [])}

    inner = GridSpecFromSubplotSpec(3, 1, subplot_spec=spec, height_ratios=[6, 1.8, 2.7], hspace=.06)
    axk, axv, axr = (fig.add_subplot(inner[i]) for i in range(3))

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

    axr.plot(range(n), [rs.get(x, float('nan')) for x in d], color=SITE_RS, lw=1.25)
    axr.set_ylim(0, 100); axr.set_yticks([90])
    ax2 = axr.twinx()
    ax2.plot(range(n), [tw_close.get(x, float('nan')) for x in d], color=SITE_IDX, lw=.95)
    ax2.set_yticks([])

    for a in (axk, axv, axr, ax2):
        a.set_xlim(-1, n); a.set_xticks([])
        a.grid(a is not ax2, ls='--', lw=.45, color=GRID)
        a.tick_params(left=False, right=False, bottom=False, top=False,
                      labelleft=False, labelright=False, labelbottom=False)
        for sp in a.spines.values(): sp.set_linewidth(.5); sp.set_color('#bbb')
    axv.set_yticks([])

    p1 = s.get('p1')
    TY = 1.06                       # 股名與 RS 共用同一基線，並與卡片保持距離
    axk.text(0., TY, f"{s['id']} {s['name']}" + (f"_{cat}" if cat else ''),
             transform=axk.transAxes, ha='left', va='baseline', fontsize=9, fontweight='bold')
    axk.text(1., TY, f"RS {s['rs']}　{p1:+.1f}%" if ok(p1) else f"RS {s['rs']}",
             transform=axk.transAxes, ha='right', va='baseline', fontsize=9, color='#555')

# ── 版面 ────────────────────────────────────────────────────────────────
L, RT = .048, .952          # 左右留白，封面與內頁一致

BLOCK_DEF = (('區塊1 創新高', '6 個月新高　RS > 85　MA20 > MA50'),
             ('區塊2 追發動', 'RS > 85　HL > 0.75　MA20 > MA50　當日漲停'),
             ('區塊3 強勢股', 'RS 近 60 交易日上升 > 25　MA20 > MA50　RS > 75'))

def cover(pdf, mkt, blocks, data_date):
    fig = plt.figure(figsize=(11.7, 8.3), facecolor='white')
    rule = lambda y: fig.lines.append(
        plt.Line2D([L, RT], [y, y], color='#ddd', lw=.9, transform=fig.transFigure))

    fig.text(L, .925, 'RS 價格報告', fontsize=25, fontweight='bold')
    fig.text(RT, .932, data_date, fontsize=11, color=MUTED, ha='right')
    rule(.895)
    fig.text(L, .850, '大盤', fontsize=13, fontweight='bold')

    tx, tp = mkt.get('taiex') or {}, mkt.get('tpex_index') or {}
    for y0, lbl, d in ((.780, '加權指數', tx), (.700, '櫃買指數', tp)):
        col = R if (d.get('chg') or 0) >= 0 else G
        fig.text(L, y0, lbl, fontsize=11.5, color=MUTED)
        fig.text(L + .092, y0 - .012, f"{d.get('close', 0):,.2f}", fontsize=21, fontweight='bold')
        fig.text(L + .232, y0 - .005, f"{d.get('chg', 0):+,.2f}", fontsize=13,
                 color=col, fontweight='bold')
        fig.text(L + .325, y0 - .005, f"{d.get('pct', 0):+.2f}%", fontsize=13, color=col)

    fig.text(L, .625, '漲跌家數', fontsize=11.5, color=MUTED)
    fig.text(L + .092, .625, '下跌／平盤／上漲', fontsize=10, color='#999')
    ax2 = fig.add_axes([.140, .420, .335, .175])
    for i, (lbl, d) in enumerate((('合計', mkt.get('total', {})), ('上櫃', mkt.get('tpex', {})),
                                  ('上市', mkt.get('twse', {})))):
        up, dn, fl = d.get('up', 0), d.get('down', 0), d.get('flat', 0)
        lu, ld = d.get('limit_up') or 0, d.get('limit_down') or 0
        tot = max(1, up + dn + fl)
        ax2.barh(i, dn / tot, left=0, color=G, height=.52)
        ax2.barh(i, ld / tot, left=0, color=DG, height=.52)
        ax2.barh(i, fl / tot, left=dn / tot, color='#d5d5d5', height=.52)
        ax2.barh(i, up / tot, left=(dn + fl) / tot, color=R, height=.52)
        ax2.barh(i, lu / tot, left=1 - lu / tot, color=DR, height=.52)
        ax2.text(-.275, i, lbl, ha='left', va='center', fontsize=11,
                 fontweight='bold' if lbl == '合計' else 'normal')
        ax2.text(-.025, i, f'跌停 {ld}', ha='right', va='center', fontsize=9.5, color=DG)
        ax2.text(1.025, i, f'漲停 {lu}', ha='left', va='center', fontsize=9.5, color=DR)
        ax2.text(.015, i, f'{dn:,}', ha='left', va='center', fontsize=9.5, color='white', fontweight='bold')
        ax2.text(.985, i, f'{up:,}', ha='right', va='center', fontsize=9.5, color='white', fontweight='bold')
    ax2.set_yticks([]); ax2.set_xticks([]); ax2.set_xlim(0, 1); ax2.set_ylim(-.55, 2.55)
    for sp in ax2.spines.values(): sp.set_visible(False)

    ax = fig.add_axes([.605, .450, .347, .295])
    intr = mkt.get('intraday') or []
    if intr:
        vals = [p['v'] for p in intr]
        prev = tx.get('close', 0) - tx.get('chg', 0)
        col = R if vals[-1] >= prev else G
        ax.plot(range(len(vals)), vals, color=col, lw=1.4)
        ax.fill_between(range(len(vals)), prev, vals, color=col, alpha=.10)
        ax.axhline(prev, color='#aaa', lw=.8, ls='--')
        ax.text(.985, prev, '昨收', transform=ax.get_yaxis_transform(),
                fontsize=7.5, color='#999', va='bottom', ha='right')
        ticks = [i for i, p in enumerate(intr) if p['t'].endswith(':00')][::2]
        ax.set_xticks(ticks); ax.set_xticklabels([intr[i]['t'] for i in ticks])
        ax.set_xlim(0, len(vals) - 1)
    else:
        ax.text(.5, .5, '分時資料無法取得', ha='center', va='center',
                fontsize=10, color='#999', transform=ax.transAxes)
        ax.set_xticks([]); ax.set_yticks([])
    ax.set_title('加權指數當日走勢', fontsize=10.5, loc='left', pad=6, color='#333')
    ax.tick_params(labelsize=7.5, length=2); ax.grid(True, ls='--', lw=.5, color='#eee')
    for sp in ('top', 'right'): ax.spines[sp].set_visible(False)
    for sp in ('left', 'bottom'): ax.spines[sp].set_color('#ccc')

    rule(.385)
    fig.text(L, .325, '本報告區塊', fontsize=13, fontweight='bold')
    y = .245
    for name, cond in BLOCK_DEF:
        fig.text(L, y, name, fontsize=12, fontweight='bold')
        fig.text(.24, y, cond, fontsize=10.5, color='#444')
        fig.text(RT, y, f"{len(blocks[name.split()[0]])} 檔", fontsize=12, ha='right', fontweight='bold')
        y -= .058
    for i, w in enumerate(mkt.get('warnings', [])):
        fig.text(RT, .90 - i * .026, '⚠️ ' + w, fontsize=8, color=R, ha='right')
    pdf.savefig(fig); plt.close(fig)

def grid_pages(pdf, title, rows, cats, tw_close, data_date):
    per = COLS * ROWS_PER_PAGE
    pages = max(1, (len(rows) + per - 1) // per)
    for pg in range(pages):
        chunk = rows[pg * per:(pg + 1) * per]
        fig = plt.figure(figsize=(11.7, 8.3), facecolor='white')
        gs = GridSpec(ROWS_PER_PAGE, COLS, figure=fig, hspace=.34, wspace=.14,
                      left=L, right=RT, top=.855, bottom=.035)
        head = title + (f'（{pg + 1}/{pages}）' if pages > 1 else '')
        fig.suptitle(head, fontsize=13, fontweight='bold', y=.945, x=L, ha='left')
        fig.text(RT, .947, f'資料日期 {data_date}', fontsize=8.5, color=MUTED, ha='right', va='bottom')
        fig.lines.append(plt.Line2D([L, RT], [.918, .918], color='#ddd', lw=.9,
                                    transform=fig.transFigure))
        for i, (s, _c) in enumerate(chunk):
            card(fig, gs[i // COLS, i % COLS], s, cats.get(s['id']), tw_close)
        pdf.savefig(fig); plt.close(fig)

def build(data_dir, out_dir):
    data_dir, out_dir = Path(data_dir), Path(out_dir)
    universe = json.load(open(data_dir / 'universe.json'))
    watchlist = json.load(open(data_dir / 'watchlist.json'))
    mkt = json.load(open(data_dir / 'market.json'))
    cats = {w['id']: w.get('category') for w in watchlist if w.get('category')}
    tw_close = {r['date']: r['close'] for r in json.load(open(data_dir / 'taiex.json'))}

    data_date = Counter(s['lastDate'] for s in universe).most_common(1)[0][0]
    blocks, pool_n = screen(universe, data_date)
    print(f'[report] 母體 {pool_n} 檔　' +
          '　'.join(f'{k} {len(v)}' for k, v in blocks.items()))

    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = out_dir / f"{data_date[2:].replace('-', '')}_價格報告.pdf"
    with PdfPages(pdf_path) as pdf:
        cover(pdf, mkt, blocks, data_date)
        for name, cond in BLOCK_DEF:
            key = name.split()[0]
            grid_pages(pdf, f'{name}　{cond}', blocks[key], cats, tw_close, data_date)
    counts = {k: len(v) for k, v in blocks.items()}
    json.dump(counts, open(out_dir / 'price_blocks.json', 'w'), ensure_ascii=False)
    print(f'[report] ✅ {pdf_path}')
    return str(pdf_path), data_date, counts

if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else 'data',
          sys.argv[2] if len(sys.argv) > 2 else 'out')
