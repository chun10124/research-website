"""價格報告：三分區篩選 + PDF 排版（唯讀，不寫任何資料庫）。

分區（順序即優先序，個股只出現在最前面符合的那一區）：
  A.創新高  6 個月(120日)新高　RS > 85　MA20 > MA50
  B.追發動  RS > 85　HL > 0.75　MA20 > MA50　當日漲停；不足 16 檔依當日漲幅補齊，全區依漲幅排序
  C.強勢股  RS 近 60 交易日上升 > 25　MA20 > MA50　RS > 80
  D.法說會  RS ≥ 80　HL > 0.75 且未來 14 日內有法說會；不參與去重，依法說日期排列
  所有卡片若 14 日內有法說會，K 線左上角標「法說 MM/DD」

用法：python3 report_price.py <資料目錄> <輸出目錄>
"""
import json, math, sys, statistics as st
from collections import Counter
from pathlib import Path
import sys as _sys; _sys.path.insert(0, str(Path(__file__).resolve().parent))
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
from settings import (BARS, COLS, ROWS_PER_PAGE, MIN_COLS, HISTORY_DAYS,     # noqa: E402
                      MA_SHORT, MA_LONG, PRICE, CONF_DAYS)
import conference                                                       # noqa: E402
B1, B2, B3, B4 = PRICE['block1'], PRICE['block2'], PRICE['block3'], PRICE['block4']

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
    m20, m50 = ma(c, MA_SHORT)[-1], ma(c, MA_LONG)[-1]
    return ok(m20) and ok(m50) and m20 > m50

def new_high(c, n):
    prev = clean(c[-n - 1:-1])
    return bool(prev) and ok(c[-1]) and c[-1] > max(prev)

def gain(s, c):
    p = s.get('p1')
    if ok(p): return p
    if len(c) < 2 or not ok(c[-2]) or c[-2] <= 0: return None
    return (c[-1] - c[-2]) / c[-2] * 100

def limit_up(s, c):
    g = gain(s, c)
    return ok(g) and g >= B2['limit_up_pct']

def rs_rise(s, days):
    h = s.get('rsHist') or []
    if len(h) < days + 1: return None
    cur, ref = h[-1]['r'], h[-days - 1]['r']
    return None if cur is None or ref is None else cur - ref

def screen(universe, data_date):
    pool = []
    for s in universe:
        if s['lastDate'] != data_date: continue      # 停牌／下市：資料不新鮮者剔除
        c = s['close']
        if len(c) < 130 or not ok(c[-1]): continue
        pool.append((s, c))

    b1 = [(s, c) for s, c in pool if (s['rs'] or 0) > B1['rs_min']
          and new_high(c, B1['high_days']) and (not B1['ma_stack'] or ma_stack(c))]
    b2 = [(s, c) for s, c in pool if (s['rs'] or 0) > B2['rs_min']
          and (s['hl'] or 0) > B2['hl_min']
          and (not B2['ma_stack'] or ma_stack(c))]
    b3 = [(s, c) for s, c in pool if (s['rs'] or 0) > B3['rs_min']
          and (not B3['ma_stack'] or ma_stack(c))
          and (rs_rise(s, B3['rs_rise_days']) or -99) > B3['rs_rise_min']]

    seen = set()
    def dedupe(rows):
        out = []
        for r in rows:
            if r[0]['id'] in seen: continue
            seen.add(r[0]['id']); out.append(r)
        return out

    order = lambda rows: sorted(dedupe(rows), key=lambda t: -(t[0]['rs'] or 0))
    by_gain = lambda rows: sorted(rows, key=lambda t: (-gain(*t), -(t[0]['rs'] or 0)))
    a = order(b1)
    b = dedupe(by_gain([r for r in b2 if limit_up(*r)]))
    # 漲停不足 fill_to 檔：同條件未漲停者依當日漲幅補齊。只把「選中的」標記為已用，
    # 沒選上的仍可落入 C 區。漲停與補齊都依漲幅排，整區即由高到低
    need = max(0, B2.get('fill_to', 0) - len(b))
    fill = by_gain([r for r in b2 if r[0]['id'] not in seen
                    and not limit_up(*r) and ok(gain(*r))])[:need]
    b += dedupe(fill)
    return {'A': a, 'B': b, 'C': order(b3)}, len(pool)

# ── 卡片 ────────────────────────────────────────────────────────────────
def card(fig, spec, s, cat, tw_close, conf=None):
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
    conference.badge(axk, conf)

# ── 版面 ────────────────────────────────────────────────────────────────
L, RT = .048, .952          # 左右留白，封面與內頁一致

def _stack(c):
    return f"　MA{MA_SHORT} > MA{MA_LONG}" if c.get('ma_stack') else ''

SECTIONS = (
    ('A', B1['name'], f"{B1['high_days']} 日新高　RS > {B1['rs_min']}{_stack(B1)}"),
    ('B', B2['name'], f"RS > {B2['rs_min']}　HL > {B2['hl_min']}{_stack(B2)}"),
    ('C', B3['name'], f"RS 近 {B3['rs_rise_days']} 交易日上升 > {B3['rs_rise_min']}"
                      f"{_stack(B3)}　RS > {B3['rs_min']}"),
    ('D', B4['name'], f"未來 {CONF_DAYS} 日內有法說會　RS ≥ {B4['rs_min']}　HL > {B4['hl_min']}"
                      "　依法說日期排列"),
)

def section_list(sections, conf_ok=True):
    """B 的條件文字補上當日實際漲停檔數（其餘是依漲幅補齊的）與排序方式；
       D 在觀測站抓不到時明講，不讓 0 檔被讀成「都沒有法說會」。"""
    n_lu = sum(limit_up(s, c) for s, c in sections['B'])
    out = []
    for k, name, cond in SECTIONS:
        if k == 'B': cond = f'{cond}　依漲幅排列（今日漲停 {n_lu} 檔）'
        if k == 'D' and not conf_ok: cond = f'{cond}　（法說會資料無法取得）'
        out.append((k, name, cond))
    return out

def conf_rows(universe, data_date, cmap):
    """D 區：RS ≥ rs_min、HL > hl_min 且未來有法說會。不設 K 棒長度門檻——新上市股也該看得到。"""
    rows = [(s, s['close']) for s in universe
            if s['lastDate'] == data_date and ok((s['close'] or [None])[-1])
            and (s['rs'] or 0) >= B4['rs_min'] and (s['hl'] or 0) > B4['hl_min']
            and s['id'] in cmap]
    return sorted(rows, key=lambda t: (cmap[t[0]['id']]['date'], cmap[t[0]['id']]['time'],
                                       -(t[0]['rs'] or 0)))

def taiex_kline(ax, axv, taiex, amount, data_date):
    """加權指數近半年日 K + MA，畫法同籌碼報告封面；axv 畫上市成交金額（億）。
       Yahoo 若已有比資料日新的 K 棒則截掉。"""
    rows = [r for r in (taiex or []) if r['date'] <= data_date]
    n = min(HISTORY_DAYS, len(rows))
    tx = rows[-n:]
    if not tx:
        for a in (ax, axv):
            a.set_xticks([]); a.set_yticks([])
        ax.text(.5, .5, '日線資料無法取得', ha='center', va='center',
                fontsize=10, color='#999', transform=ax.transAxes)
        return
    o = [r.get('open') for r in tx]; h = [r.get('high') for r in tx]
    l = [r.get('low') for r in tx]; c = [r['close'] for r in tx]
    for i in range(n):
        if not all(ok(v) for v in (o[i], h[i], l[i], c[i])): continue
        fc, ec = (UP_F, UP_E) if c[i] >= o[i] else (DN_F, DN_E)
        ax.vlines(i, l[i], h[i], color=ec, lw=.45)
        body = abs(c[i] - o[i]) or (h[i] - l[i]) * .02 or .01
        ax.add_patch(plt.Rectangle((i - .34, min(o[i], c[i])), .68, body,
                                   facecolor=fc, edgecolor=ec, lw=.25))
    cl = [r['close'] for r in rows]
    for span, col in ((MA_SHORT, '#1f77b4'), (MA_LONG, '#ff7f0e')):
        mv = ma(cl, span)[-n:]
        ax.plot(range(n), [m if ok(m) else float('nan') for m in mv], color=col, lw=.9)
    lo, hi = min(x for x in l if ok(x)), max(x for x in h if ok(x))
    ax.set_ylim(lo - (hi - lo) * .05, hi + (hi - lo) * .05)
    amt = {r['date']: r['amount'] / 1e8 for r in (amount or [])}
    vals = [amt.get(r['date']) for r in tx]
    if any(ok(v) for v in vals):
        up = [i for i in range(n) if ok(vals[i]) and ok(o[i]) and ok(c[i]) and c[i] >= o[i]]
        dn = [i for i in range(n) if ok(vals[i]) and i not in set(up)]
        axv.bar(up, [vals[i] for i in up], color=UP_F, width=.8)
        axv.bar(dn, [vals[i] for i in dn], color=DN_F, width=.8)
        last = next((v for v in reversed(vals) if ok(v)), None)
        axv.text(.005, .97, f'成交金額（億）　{last:,.0f}', transform=axv.transAxes,
                 ha='left', va='top', fontsize=7, color='#666')
        axv.set_ylim(0, max(v for v in vals if ok(v)) * 1.45)   # 頂部留白放標籤，不壓到柱子
        axv.set_yticks([])
    else:
        axv.text(.5, .5, '成交金額無法取得', ha='center', va='center',
                 fontsize=8, color='#999', transform=axv.transAxes)
        axv.set_yticks([])
    for a in (ax, axv): a.set_xlim(-1, n)
    idx = list(range(0, n, max(1, n // 5)))
    ax.set_xticks(idx); ax.tick_params(labelbottom=False)
    axv.set_xticks(idx); axv.set_xticklabels([tx[i]['date'][5:] for i in idx])
    ax.set_title(f'加權指數　近 {n} 交易日', fontsize=10.5, loc='left', pad=6, color='#333')
    ax.text(1., 1.02, f'MA{MA_SHORT}／MA{MA_LONG}', transform=ax.transAxes,
            ha='right', va='bottom', fontsize=8, color='#999')

def cover(pdf, mkt, sections, data_date, taiex=None, amount=None, conf_ok=True, n_new=0):
    fig = plt.figure(figsize=(11.7, 8.3), facecolor='white')
    rule = lambda y: fig.lines.append(
        plt.Line2D([L, RT], [y, y], color='#ddd', lw=.9, transform=fig.transFigure))

    fig.text(L, .925, f'{data_date}　價格報告', fontsize=25, fontweight='bold')
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

    # 右欄：上＝近半年日 K，下＝當日分時
    axk = fig.add_axes([.605, .635, .347, .205])
    axkv = fig.add_axes([.605, .570, .347, .060])
    taiex_kline(axk, axkv, taiex, amount, data_date)
    for a in (axk, axkv):
        a.tick_params(labelsize=7.5, length=2); a.grid(True, ls='--', lw=.5, color='#eee')
        for sp in ('top', 'right'): a.spines[sp].set_visible(False)
        for sp in ('left', 'bottom'): a.spines[sp].set_color('#ccc')

    ax = fig.add_axes([.605, .355, .347, .135])
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

    rule(.310)
    y = .258
    for key, name, cond in section_list(sections, conf_ok):
        fig.text(L, y, f'{key}.{name}', fontsize=12, fontweight='bold')
        fig.text(.24, y, cond, fontsize=10.5, color='#444')
        fig.text(RT, y, f'{len(sections[key])} 檔', fontsize=12, ha='right', fontweight='bold')
        if key == 'D' and n_new:
            fig.text(RT - .055, y, f'今日新增 {n_new}', fontsize=10.5, ha='right',
                     color=conference.NEW_C, fontweight='bold')
        y -= .058
    for i, w in enumerate(mkt.get('warnings', [])):
        fig.text(RT, .90 - i * .026, '⚠️ ' + w, fontsize=8, color=R, ha='right')
    pdf.savefig(fig); plt.close(fig)

def layout_for(n):
    """依檔數決定欄列數：數量少時用較少欄位把卡片放大，避免整頁留白。
       回傳 (每頁欄數, 每頁列數, 版面列數)——版面列數至少 2，
       否則單列會被拉成整頁高、卡片變成極扁的長條。"""
    cols = COLS if n > (MIN_COLS * 2) else MIN_COLS
    rows = math.ceil(n / cols) if n else 1
    return cols, min(rows, ROWS_PER_PAGE), max(2, min(rows, ROWS_PER_PAGE))


def page_head(title, data_date):
    """內頁頁首：分區標題、資料日期、分隔線。回傳 fig。"""
    fig = plt.figure(figsize=(11.7, 8.3), facecolor='white')
    fig.suptitle(title, fontsize=13, fontweight='bold', y=.945, x=L, ha='left')
    fig.text(RT, .947, f'資料日期 {data_date}', fontsize=8.5, color=MUTED, ha='right', va='bottom')
    fig.lines.append(plt.Line2D([L, RT], [.918, .918], color='#ddd', lw=.9,
                                transform=fig.transFigure))
    return fig


def grid_pages(pdf, title, rows, cats, tw_close, data_date, cmap=None, empty='本日無符合個股'):
    # 該分區今天一檔都沒有：頁還是留著（分區數固定，翻頁位置才不會每天跑掉），
    # 但要明講「本日無符合個股」——否則就是一張只有標題的空白頁，看起來像排版壞掉。
    if not rows:
        fig = page_head(title, data_date)
        fig.text(.5, .48, empty, fontsize=15, color=MUTED, ha='center', va='center')
        pdf.savefig(fig); plt.close(fig)
        return

    cols, rpp, layout_rows = layout_for(len(rows))
    per = cols * rpp
    pages = (len(rows) + per - 1) // per
    for pg in range(pages):
        chunk = rows[pg * per:(pg + 1) * per]
        head = title + (f'（{pg + 1}/{pages}）' if pages > 1 else '')
        fig = page_head(head, data_date)
        gs = GridSpec(layout_rows, cols, figure=fig, hspace=.34, wspace=.14,
                      left=L, right=RT, top=.855, bottom=.035)
        for i, (s, _c) in enumerate(chunk):
            card(fig, gs[i // cols, i % cols], s, cats.get(s['id']), tw_close,
                 (cmap or {}).get(s['id']))
        pdf.savefig(fig); plt.close(fig)

def _fit(fig, x, y, text, right, **kw):
    """畫文字，超出 right（figure 座標）就從尾端截斷補「…」。依實際渲染寬度量，
       不用字數估——中英混排的字寬差一倍，字數截斷必然有些列會超出頁緣。"""
    rend = fig.canvas.get_renderer()
    t = fig.text(x, y, text, **kw)
    while text and t.get_window_extent(rend).x1 / fig.bbox.width > right:
        text = text[:-1]
        t.set_text(text.rstrip() + '…')
    return t

def conf_table(pdf, title, rows, cmap, cats, data_date, baseline=None):
    """D 區清單頁：先給可掃視的日期表，後面才是 K 線卡片。每頁 24 列，超過續頁。
       今日新增（與先前快照比對）者日期改紅色。"""
    PER, TOP, STEP, GAP = 24, .862, .0335, .012
    X_DATE, X_TIME, X_STK, X_PLACE, X_DESC = L, L + .085, L + .135, L + .345, L + .530
    HDR = ((X_DATE, '日期'), (X_TIME, '時間'), (X_STK, '股票'), (X_PLACE, '地點'), (X_DESC, '摘要'))
    n_new = sum(bool(cmap[s['id']].get('new')) for s, _c in rows)
    note = (f'紅色＝今日新增 {n_new} 檔（與 {baseline} 快照比對）' if baseline
            else '尚無先前快照，今日不標新增')
    pages = max(1, math.ceil(len(rows) / PER))
    for pg in range(pages):
        fig = page_head(title + (f'（{pg + 1}/{pages}）' if pages > 1 else ''), data_date)
        for x, h in HDR:
            fig.text(x, .885, h, fontsize=9, color=MUTED)
        fig.text(RT, .885, note, fontsize=8.5, color=conference.NEW_C if n_new else MUTED, ha='right')
        for i, (s, _c) in enumerate(rows[pg * PER:(pg + 1) * PER]):
            r, y = cmap[s['id']], TOP - i * STEP
            if i % 2 == 0:
                fig.patches.append(plt.Rectangle((L - .006, y - .010), RT - L + .012, STEP,
                                                 transform=fig.transFigure, fc='#f6f6f6', ec='none'))
            date = r['date'][5:].replace('-', '/')
            if r['is_range']:
                date = f"{r['start'][5:].replace('-', '/')}–{r['end'][5:].replace('-', '/')}"
            cat = cats.get(s['id'])
            fig.text(X_DATE, y, date, fontsize=9.5, fontweight='bold', color=conference.color(r))
            fig.text(X_TIME, y, r['time'], fontsize=9.5)
            _fit(fig, X_STK, y, f"{s['id']} {s['name']}" + (f"_{cat}" if cat else ''),
                 X_PLACE - GAP, fontsize=9.5, fontweight='bold')
            _fit(fig, X_PLACE, y, r['place'], X_DESC - GAP, fontsize=8.5, color='#444')
            _fit(fig, X_DESC, y, r['desc'], RT, fontsize=8.5, color='#444')
        fig.text(L, .022, '來源：公開資訊觀測站法人說明會一覽表。公司多半會前幾天才申報，'
                 '越遠的日期越稀疏——未列出不代表不會開。日期為區間者是多場活動合併申報。',
                 fontsize=8, color='#999')
        pdf.savefig(fig); plt.close(fig)

def build(data_dir, out_dir):
    data_dir, out_dir = Path(data_dir), Path(out_dir)
    universe = json.load(open(data_dir / 'universe.json'))
    watchlist = json.load(open(data_dir / 'watchlist.json'))
    mkt = json.load(open(data_dir / 'market.json'))
    cats = {w['id']: w.get('category') for w in watchlist if w.get('category')}
    taiex = json.load(open(data_dir / 'taiex.json'))
    tw_close = {r['date']: r['close'] for r in taiex}
    amt_path = data_dir / 'taiex_amount.json'
    amount = json.load(open(amt_path)) if amt_path.exists() else []
    conf_path = data_dir / 'conferences.json'
    confs = json.load(open(conf_path)) if conf_path.exists() else None
    conf_ok = confs is not None
    cmap = conference.by_stock(confs)
    baseline = (confs or {}).get('baseline')

    data_date = Counter(s['lastDate'] for s in universe).most_common(1)[0][0]
    sections, pool_n = screen(universe, data_date)
    sections['D'] = conf_rows(universe, data_date, cmap)
    print(f'[report] 母體 {pool_n} 檔　' +
          '　'.join(f'{k} {len(v)}' for k, v in sections.items()))

    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = out_dir / f"{data_date[2:].replace('-', '')}_價格報告.pdf"
    with PdfPages(pdf_path) as pdf:
        n_new = sum(bool(cmap[s['id']].get('new')) for s, _c in sections['D'])
        cover(pdf, mkt, sections, data_date, taiex, amount, conf_ok, n_new)
        for key, name, cond in section_list(sections, conf_ok):
            title = f'{key}.{name}　{cond}'
            if key == 'D' and sections['D']:
                conf_table(pdf, title, sections['D'], cmap, cats, data_date, baseline)
            grid_pages(pdf, title, sections[key], cats, tw_close, data_date, cmap,
                       empty='本日無符合個股' if key != 'D' or conf_ok else '法說會資料無法取得')
    counts = {f'{k}.{name}': len(sections[k]) for k, name, _ in SECTIONS}
    json.dump(counts, open(out_dir / 'price_blocks.json', 'w'), ensure_ascii=False)
    print(f'[report] ✅ {pdf_path}')
    return str(pdf_path), data_date, counts

if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else 'data',
          sys.argv[2] if len(sys.argv) > 2 else 'out')
