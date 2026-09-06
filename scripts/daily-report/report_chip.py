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
                          R, DR, G, DG, MUTED, BARS, COLS, ROWS_PER_PAGE, L, RT,
                          layout_for, MA_SHORT, MA_LONG)

# 沿用網站籌碼視窗配色（IBDRsRankingPage.jsx:1521）
FOREIGN_C, TRUST_C, DEALER_C = '#1565c0', '#16a34a', '#f97316'
HOLD_C = '#6b21a8'      # 外資持股線：與三色柱皆不同，才分得出來
from settings import CHIP                                       # noqa: E402
RS_MIN = CHIP['rs_min']
INCLUDE_PERSIST = CHIP['include_persist']

SECTIONS = (('A', '外資 ＋ 投信　同時'),
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
        # 納入「消退中」：訊號剛結束但仍在 3 日餘溫內（calculateFlowSignal 的 persist）
        fon = f['active'] or (INCLUDE_PERSIST and f['persist'] > 0)
        ton = t['active'] or (INCLUDE_PERSIST and t['persist'] > 0)
        key = 'A' if (fon and ton) else 'B' if fon else 'C' if ton else None
        if key: out[key].append((w, u))
    for k in out:
        # 正在觸發者優先，消退中的排後面；同組內依 RS 高到低
        out[k].sort(key=lambda p: (not (p[0]['_f']['active'] or p[0]['_t']['active']),
                                   -(p[1]['rs'] or 0)))
    return out, len(pool)

# ── 卡片：K棒 / 成交量 / 法人買賣超＋外資持股 ────────────────────────────
def card(fig, spec, w, u):
    n = min(BARS, len(u['close']))
    d, c, v = u['dates'][-n:], u['close'][-n:], u['vol'][-n:]
    o = (u.get('open') or [None] * n)[-n:]
    h = (u.get('high') or [None] * n)[-n:]
    l = (u.get('low') or [None] * n)[-n:]

    inner = GridSpecFromSubplotSpec(3, 1, subplot_spec=spec, height_ratios=[6, 1.5, 3], hspace=.06)
    axk, axv, axc = (fig.add_subplot(inner[i]) for i in range(3))

    for i in range(n):
        if not (ok(o[i]) and ok(h[i]) and ok(l[i]) and ok(c[i])): continue
        fc, ec = (UP_F, UP_E) if c[i] >= o[i] else (DN_F, DN_E)
        axk.vlines(i, l[i], h[i], color=ec, lw=.4)
        body = abs(c[i] - o[i]) or (h[i] - l[i]) * .02 or .01
        axk.add_patch(plt.Rectangle((i - .34, min(o[i], c[i])), .68, body,
                                    facecolor=fc, edgecolor=ec, lw=.25))
    # 不畫均線：網站籌碼視窗 showMA 預設 false，且 MA20 的藍與外資持股藍幾乎同色
    lo = min([x for x in l if ok(x)] or [0]); hi = max([x for x in h if ok(x)] or [1])
    axk.set_ylim(lo - (hi - lo) * .06, hi + (hi - lo) * .06)

    # 持股折線改畫在柱狀區、疊於柱子之上（見下方 axc 段落）
    hmap = dict(zip(w.get('foreignHoldingDates') or [], w.get('foreignTotalHolding') or []))
    tmap = dict(zip(w.get('instDates') or [], w.get('instTrust') or []))
    extra = []

    up = [i for i in range(n) if (ok(o[i]) and ok(c[i]) and c[i] >= o[i])
          or (not ok(o[i]) and (i == 0 or (ok(c[i]) and ok(c[i - 1]) and c[i] >= c[i - 1])))]
    dn = [i for i in range(n) if i not in up]
    axv.bar(up, [v[i] / 1000 if ok(v[i]) else 0 for i in up], color=UP_F, width=.9)
    axv.bar(dn, [v[i] / 1000 if ok(v[i]) else 0 for i in dn], color=DN_F, width=.9)

    # 三大法人堆疊柱：配色與堆疊方式沿用網站（外資藍／投信綠／自營橘，正 .82、負 .5）
    fmap = dict(zip(w.get('instDates') or [], w.get('instForeign') or []))
    dmap = dict(zip(w.get('instDates') or [], w.get('instDealer') or []))
    for i, day in enumerate(d):
        pos = neg = 0.0
        for m, col in ((fmap, FOREIGN_C), (tmap, TRUST_C), (dmap, DEALER_C)):
            val = m.get(day)
            if not ok(val) or val == 0: continue
            if val > 0:
                axc.bar(i, val, bottom=pos, color=col, alpha=.82, width=.85); pos += val
            else:
                axc.bar(i, val, bottom=neg, color=col, alpha=.50, width=.85); neg += val
    axc.axhline(0, color='#999', lw=.5)

    # 兩條持股折線疊在柱子上方（各自獨立 Y 軸，zorder 拉高才不會被柱子蓋住）
    hv = [hmap.get(x) for x in d]
    if any(ok(x) for x in hv):
        axf = axc.twinx(); extra.append(axf)
        axf.plot(range(n), [x if ok(x) else float('nan') for x in hv],
                 color=FOREIGN_C, lw=.8, zorder=5)
        vals = [x for x in hv if ok(x)]
        pad = (max(vals) - min(vals)) * .35 or 1
        axf.set_ylim(min(vals) - pad, max(vals) + pad)

    cum, acc = [], 0.0                       # 投信累積持股：同 IBDRsRankingPage.jsx:1381
    for x in d:
        tv = tmap.get(x)
        if ok(tv): acc += tv
        cum.append(acc)
    if max(cum) != min(cum):
        axt = axc.twinx(); extra.append(axt)
        axt.plot(range(n), cum, color=TRUST_C, lw=.8, zorder=5)
        pad = (max(cum) - min(cum)) * .35
        axt.set_ylim(min(cum) - pad, max(cum) + pad)

    for a in (axk, axv, axc, *extra):
        a.set_xlim(-1, n); a.set_xticks([])
        a.grid(a in (axk, axv, axc), ls='--', lw=.45, color=GRID)
        a.tick_params(left=False, right=False, bottom=False, top=False,
                      labelleft=False, labelright=False, labelbottom=False)
        for sp in a.spines.values(): sp.set_linewidth(.5); sp.set_color('#bbb')
    axv.set_yticks([]); axc.set_yticks([])
    for a in extra: a.set_yticks([])

    # ── 標題三列：名稱／外資／投信，各列獨立不互相擠壓 ────────────────
    f, t = w['_f'], w['_t']
    cat, p1 = w.get('category'), u.get('p1')
    axk.text(0., 1.34, f"{u['id']} {u['name']}" + (f"_{cat}" if cat else ''),
             transform=axk.transAxes, ha='left', va='baseline', fontsize=9, fontweight='bold')
    axk.text(1., 1.34, f"RS {u['rs']}　{p1:+.1f}%" if ok(p1) else f"RS {u['rs']}",
             transform=axk.transAxes, ha='right', va='baseline', fontsize=9, color='#555')
    if w.get('foreignSignal') == 'B':
        axk.text(1., 1.19, f"B{w['foreignBCount']}", transform=axk.transAxes,
                 ha='right', va='baseline', fontsize=8.5, color='#ff2d87', fontweight='bold')

    def tag(sig, name):
        if sig['active']:
            return f"{name} {sig['days']}日 {round(sig['cum']):+,}張"
        if sig['persist'] > 0:
            return f"{name} 消退中　前 {sig['persist_days']}日、剩 {sig['persist']}日"
        return None

    for row, (sig, name, col) in enumerate(((f, '外資', FOREIGN_C), (t, '投信', TRUST_C))):
        txt = tag(sig, name)
        if txt:
            axk.text(0., 1.19 - row * .125, txt, transform=axk.transAxes,
                     ha='left', va='baseline', fontsize=8, color=col, fontweight='bold')

# ── 封面 ────────────────────────────────────────────────────────────────
def cover(pdf, inst, sections, data_date, pool_n,
          fseries=None, oiseries=None, mseries=None, taiex=None):
    """封面＝一張大盤卡片：加權指數 K 線在上，外資未平倉／買賣超／融資餘額依序在下，
       與個股卡片同一套視覺語彙。"""
    fig = plt.figure(figsize=(11.7, 8.3), facecolor='white')
    rule = lambda y: fig.lines.append(
        plt.Line2D([L, RT], [y, y], color='#ddd', lw=.9, transform=fig.transFigure))
    yi = lambda v: v / 1e8

    fig.text(L, .938, f'{data_date}　籌碼報告', fontsize=24, fontweight='bold')

    rule(.912)

    # ── 大盤卡片：K 線 / 外資未平倉 / 外資買賣超 / 融資餘額 ─────────────
    gs = GridSpec(4, 1, figure=fig, height_ratios=[7.6, 2.2, 2.2, 2.2], hspace=.24,
                  left=L, right=RT, top=.868, bottom=.055)
    axk, axo, axb, axm = (fig.add_subplot(gs[i]) for i in range(4))

    n = min(BARS, len(taiex or []))
    tx = (taiex or [])[-n:]
    if tx:
        o = [r.get('open') for r in tx]; h = [r.get('high') for r in tx]
        l = [r.get('low') for r in tx]; c = [r['close'] for r in tx]
        for i in range(n):
            if not all(ok(v) for v in (o[i], h[i], l[i], c[i])): continue
            fc, ec = (UP_F, UP_E) if c[i] >= o[i] else (DN_F, DN_E)
            axk.vlines(i, l[i], h[i], color=ec, lw=.5)
            body = abs(c[i] - o[i]) or (h[i] - l[i]) * .02 or .01
            axk.add_patch(plt.Rectangle((i - .34, min(o[i], c[i])), .68, body,
                                        facecolor=fc, edgecolor=ec, lw=.3))
        cl = [r['close'] for r in (taiex or [])]
        for span, col in ((MA_SHORT, '#1f77b4'), (MA_LONG, '#ff7f0e')):
            mv = ma(cl, span)[-n:]
            axk.plot(range(n), [m if ok(m) else float('nan') for m in mv], color=col, lw=1.0)
        lo, hi = min(x for x in l if ok(x)), max(x for x in h if ok(x))
        axk.set_ylim(lo - (hi - lo) * .05, hi + (hi - lo) * .05)
        last = tx[-1]
        prev = tx[-2]['close'] if len(tx) > 1 else last['close']
        chg = last['close'] - prev
        axk.text(0., 1.06, f'加權指數　近 {n} 交易日', transform=axk.transAxes,
                 ha='left', va='baseline', fontsize=11, fontweight='bold')
        axk.text(1., 1.06, f"{last['close']:,.2f}　{chg:+,.2f}　{chg/prev*100:+.2f}%",
                 transform=axk.transAxes, ha='right', va='baseline', fontsize=11,
                 fontweight='bold', color=(R if chg >= 0 else G))
        axk.text(.5, 1.06, f'MA{MA_SHORT}／MA{MA_LONG}', transform=axk.transAxes,
                 ha='center', va='baseline', fontsize=8.5, color='#999')

    def strip(ax, title, chg_txt, chg_val, level_txt, rows, draw):
        """標題列的視覺權重：當日變動最大（每天真正要看的），存量退為輔助資訊。"""
        t = ax.text(0., 1.13, title, transform=ax.transAxes, ha='left', va='baseline',
                    fontsize=10, color='#555')
        if chg_txt:
            # 量測標題實際寬度再接上數字。固定 x 會讓短標題後面空一大截
            # （三個標題長度是 12 / 8 / 4 個字，差很多）
            fig.canvas.draw()
            bb = t.get_window_extent(fig.canvas.get_renderer())
            x_end = ax.transAxes.inverted().transform((bb.x1, bb.y0))[0]
            ax.text(x_end + .018, 1.11, chg_txt, transform=ax.transAxes,
                    ha='left', va='baseline', fontsize=15, fontweight='bold',
                    color=(R if (chg_val or 0) >= 0 else G))
        if level_txt:
            ax.text(1., 1.13, level_txt, transform=ax.transAxes, ha='right',
                    va='baseline', fontsize=9, color='#999')
        if rows:
            draw()
        else:
            ax.text(.5, .5, '資料無法取得', ha='center', va='center', color='#999',
                    fontsize=9, transform=ax.transAxes)

    def align(rows):
        """把序列對齊到 K 線的日期軸，缺的日子留 None。"""
        m = {r['date']: r for r in (rows or [])}
        return [m.get(r['date']) for r in tx]

    def bars(ax, vals, color, width=.85):
        idx = [i for i, v in enumerate(vals) if v is not None]
        ax.bar(idx, [vals[i] for i in idx], width=width, color=color, edgecolor='none')
        for b, i in zip(ax.patches, idx): b.set_alpha(.85 if vals[i] >= 0 else .45)
        ax.axhline(0, color='#999', lw=.6)

    oi = align(oiseries)
    cur = next((r['foreign'] for r in reversed(oi) if r), 0)
    prev_oi = [r['foreign'] for r in oi if r]
    dchg = (prev_oi[-1] - prev_oi[-2]) if len(prev_oi) > 1 else 0
    strip(axo, '外資　臺股期貨未平倉淨額',
          f'{dchg:+,} 口' if oiseries else '', dchg,
          f'未平倉 {cur:+,} 口' if oiseries else '',
          oiseries, lambda: bars(axo, [r['foreign'] if r else None for r in oi], FOREIGN_C, .9))

    fs = align(fseries)
    today = yi(fseries[-1]['foreign']) if fseries else 0
    d5 = sum(yi(r['foreign']) for r in fseries[-5:]) if fseries else 0
    miss = sum(1 for r in (fseries or []) if r.get('twse_only'))
    if miss:
        # 不印在報告上（依指示），但仍留在日誌，缺漏不會無聲無息
        print(f'[chip] 注意：外資買賣超有 {miss} 日缺上櫃，該日僅計上市')
    strip(axb, '外資　現貨買賣超',
          f'{today:+,.1f} 億' if fseries else '', today,
          f'近5日 {d5:+,.1f} 億' if fseries else '',
          fseries, lambda: bars(axb, [yi(r['foreign']) if r else None for r in fs], FOREIGN_C))

    ms = align(mseries)
    last_m = next((r for r in reversed(ms) if r), None)
    mchg = (last_m.get('margin_amt_chg', 0) / 1e8) if last_m else 0
    def draw_margin():
        v = [r['margin_amt'] / 1e8 if r else None for r in ms]
        vals = [x for x in v if x is not None]
        lo, hi = min(vals), max(vals)
        base = lo - (hi - lo) * .25          # 餘額離 0 很遠，柱子自可視底部起算才看得出變化
        idx = [i for i, x in enumerate(v) if x is not None]
        axm.bar(idx, [v[i] - base for i in idx], bottom=base, width=.85,
                color='#8e44ad', alpha=.75, edgecolor='none')
        axm.set_ylim(base, hi + (hi - lo) * .12)
    strip(axm, '融資餘額',
          f'{mchg:+,.1f} 億' if last_m else '', mchg,
          f"餘額 {last_m['margin_amt']/1e8:,.1f} 億" if last_m else '',
          mseries, draw_margin)

    for a in (axk, axo, axb, axm):
        a.set_xlim(-1, n); a.set_xticks([])
        a.grid(True, ls='--', lw=.45, color=GRID)
        a.tick_params(labelsize=7, length=2, labelbottom=False)
        for sp in a.spines.values(): sp.set_linewidth(.5); sp.set_color('#bbb')
    # 只有最下面一格標日期，四格共用同一條時間軸
    step = max(1, n // 5)
    idx = list(range(0, n, step))
    axm.set_xticks(idx)
    axm.set_xticklabels([tx[i]['date'][5:] for i in idx])
    axm.tick_params(labelbottom=True, labelsize=7.5)

    if inst.get('tpex_date_mismatch'):
        fig.text(RT, .906, f"⚠️ 上櫃法人 {inst['tpex_date_mismatch']}",
                 fontsize=8, color=R, ha='right')
    pdf.savefig(fig); plt.close(fig)

def summary_page(pdf, sections, data_date, pool_n, inst=None):
    """第二頁：三大法人買賣超 + 連買訊號總覽。
       先給可掃視的數字與清單，後面才是逐檔卡片。"""
    fig = plt.figure(figsize=(11.7, 8.3), facecolor='white')
    yi = lambda v: v / 1e8

    fig.text(L, .938, '三大法人買賣超', fontsize=20, fontweight='bold')
    fig.text(L + .175, .944, '現貨／億元', fontsize=9.5, color='#999')
    fig.text(RT, .944, f'{data_date}　籌碼報告', fontsize=11, color=MUTED, ha='right')

    CX = {'total': .215, 'twse': .310, 'tpex': .395}
    for k, hdr in (('total', '合計'), ('twse', '上市'), ('tpex', '上櫃')):
        fig.text(CX[k], .888, hdr, fontsize=9.5, color=MUTED, ha='right')
    fig.lines.append(plt.Line2D([L, .395], [.874, .874], color='#eee', lw=.8,
                                transform=fig.transFigure))
    y = .824
    for key, lbl, col in (('foreign', '外資', FOREIGN_C), ('trust', '投信', TRUST_C),
                          ('dealer', '自營商', DEALER_C)):
        fig.text(L, y, '■', fontsize=8, color=col)
        fig.text(L + .022, y, lbl, fontsize=11.5, fontweight='bold')
        for mk in ('total', 'twse', 'tpex'):
            v = yi(((inst or {}).get(mk) or {}).get(key, 0))
            big = mk == 'total'
            fig.text(CX[mk], y - (.004 if big else 0), f'{v:+,.1f}',
                     fontsize=15 if big else 10.5, ha='right',
                     color=(R if v >= 0 else G), fontweight='bold' if big else 'normal')
        y -= .050
    if (inst or {}).get('tpex_date_mismatch'):
        fig.text(RT, .888, f"⚠️ 上櫃法人 {inst['tpex_date_mismatch']}",
                 fontsize=8, color=R, ha='right')

    fig.lines.append(plt.Line2D([L, RT], [.700, .700], color='#ddd', lw=.9,
                                transform=fig.transFigure))
    fig.text(L, .648, '連買訊號', fontsize=16, fontweight='bold')
    fig.text(L + .11, .652,
             f'母體 {pool_n} 檔　追蹤表 ∩ RS≥{RS_MIN} ∩ 法人資料為最近交易日',
             fontsize=9.5, color='#999')

    def line(sig, name):
        if sig['active']:
            return f"{name} {sig['days']}日 {round(sig['cum']):+,}張"
        if sig['persist'] > 0:
            return f"{name} 消退中　前 {sig['persist_days']}日、剩 {sig['persist']}日"
        return ''

    # 行距依檔數自動縮放：檔數會逐日變動，寫死行距遲早爆版
    TOP, BOTTOM = .592, .075
    n_rows = sum(max(1, len(sections[k])) for k, _ in SECTIONS)
    n_head = len(SECTIONS)
    avail = TOP - BOTTOM
    step = min(.031, (avail - n_head * .038 - n_head * .016) / max(1, n_rows))
    step = max(step, .020)                       # 再擠就看不清楚，寧可截斷
    fits = int((avail - n_head * .038 - n_head * .016) / step)
    shown, dropped = 0, 0

    y = TOP
    for key, desc in SECTIONS:
        rows = sections[key]
        fig.text(L, y, f'{key}　{desc}', fontsize=12.5, fontweight='bold')
        fig.text(L + .27, y, f'{len(rows)} 檔', fontsize=10.5, color=MUTED)
        y -= .038
        if not rows:
            fig.text(L + .02, y, '今日無符合', fontsize=10, color='#bbb')
            y -= .016 + step
            continue
        for w, u in rows:
            if shown >= fits:
                dropped += 1
                continue
            shown += 1
            cat = w.get('category')
            fig.text(L + .02, y, f"{u['id']} {u['name']}" + (f"_{cat}" if cat else ''),
                     fontsize=10.5)
            fig.text(.335, y, f"RS {u['rs']}", fontsize=10, color='#555', ha='right')
            p1 = u.get('p1')
            if ok(p1):
                fig.text(.398, y, f'{p1:+.1f}%', fontsize=10, ha='right',
                         color=(R if p1 >= 0 else G))
            fig.text(.435, y, line(w['_f'], '外資'), fontsize=9.5, color=FOREIGN_C)
            fig.text(.695, y, line(w['_t'], '投信'), fontsize=9.5, color=TRUST_C)
            if w.get('foreignSignal') == 'B':
                fig.text(RT, y, f"B{w['foreignBCount']}", fontsize=9.5,
                         color='#ff2d87', fontweight='bold', ha='right')
            y -= step
        y -= .016

    if dropped:
        fig.text(L + .02, y + .010, f'⋯ 另有 {dropped} 檔，詳見後續卡片頁',
                 fontsize=9.5, color='#999')
    fig.text(L, .042,
             '訊號＝每日買賣超 z-score（vs 過去 250 日）連續 2 天以上 > 1.0σ，'
             '移植自網站 calculateFlowSignal。',
             fontsize=8.5, color='#999')
    fig.text(L, .020,
             '含「消退中」——訊號剛結束、仍在 3 日餘溫內者。B 為外資持股動能訊號'
             '（持股 10 日變動率衝破 700 日標準差），與連買是不同的訊號。',
             fontsize=8.5, color='#999')
    pdf.savefig(fig); plt.close(fig)


def grid_pages(pdf, title, rows, data_date):
    cols, rpp, layout_rows = layout_for(len(rows))
    per = cols * rpp
    pages = max(1, (len(rows) + per - 1) // per)
    for pg in range(pages):
        chunk = rows[pg * per:(pg + 1) * per]
        fig = plt.figure(figsize=(11.7, 8.3), facecolor='white')
        gs = GridSpec(layout_rows, cols, figure=fig, hspace=.52, wspace=.14,
                      left=L, right=RT, top=.835, bottom=.035)
        head = title + (f'（{pg + 1}/{pages}）' if pages > 1 else '')
        fig.suptitle(head, fontsize=13, fontweight='bold', y=.945, x=L, ha='left')
        fig.text(RT, .947, f'資料日期 {data_date}', fontsize=8.5, color=MUTED,
                 ha='right', va='bottom')
        fig.lines.append(plt.Line2D([L, RT], [.918, .918], color='#ddd', lw=.9,
                                    transform=fig.transFigure))
        for i, (w, u) in enumerate(chunk):
            card(fig, gs[i // cols, i % cols], w, u)
        pdf.savefig(fig); plt.close(fig)

def build(data_dir, out_dir):
    data_dir, out_dir = Path(data_dir), Path(out_dir)
    universe = json.load(open(data_dir / 'universe.json'))
    watchlist = json.load(open(data_dir / 'watchlist.json'))
    inst = json.load(open(data_dir / 'institutional.json'))
    load = lambda f: json.load(open(data_dir / f)) if (data_dir / f).exists() else None
    fseries, oiseries, mseries = load('foreign_series.json'), load('futures_oi_series.json'), load('margin_series.json')
    taiex = load('taiex.json')

    data_date = Counter(s['lastDate'] for s in universe).most_common(1)[0][0]
    sections, pool_n = screen(watchlist, universe, data_date)
    print(f'[chip] 母體 {pool_n} 檔　' +
          '　'.join(f'{k} {len(v)}' for k, v in sections.items()))

    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = out_dir / f"{data_date[2:].replace('-', '')}_籌碼報告.pdf"
    with PdfPages(pdf_path) as pdf:
        cover(pdf, inst, sections, data_date, pool_n, fseries, oiseries, mseries, taiex)
        summary_page(pdf, sections, data_date, pool_n, inst)
        for key, desc in SECTIONS:
            if sections[key]:
                grid_pages(pdf, f'{key}　{desc}', sections[key], data_date)
    counts = {f'{k} {d}': len(sections[k]) for k, d in SECTIONS}
    print(f'[chip] ✅ {pdf_path}')
    return str(pdf_path), data_date, counts

if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else '_data',
          sys.argv[2] if len(sys.argv) > 2 else '_out')
