"""未來法說會：公開資訊觀測站「法人說明會一覽表」（唯讀）。

來源是新版觀測站背後的舊版入口 mopsov.twse.com.tw。新版 mops.twse.com.tw/mops/api
用程式直接打會被 WAF 擋（回「因為安全性考量…」），舊版 ajax 端點可正常 POST。
證交所／櫃買 OpenAPI 皆無法說會端點（2026-09-21 查過兩邊 swagger）。

限制：公司多半在會前幾天到一週才申報，所以越遠的日期越稀疏——
「14 天內無法說會」只代表「目前還沒申報」，不代表不會開。

「今日新增」：觀測站沒有申報日期欄位（簡報檔名的日期是上傳日，約 4 成場次無檔，
也有沿用舊簡報的），只能每天存快照、與先前快照比對。快照存 _state/（Actions 用
cache 保存），首次執行沒有基準，當天不標任何新增。
比對基準依報告而異：
  價格報告（16:30）只比先前的「價格報告」快照——16:30 後才申報的場次，
    隔天價格報告仍會標紅，不會因為前一晚籌碼報告已看過而被吃掉。
  籌碼報告（22:00）比先前所有快照（兩種報告都算）。
"""
import datetime, html, json, re, urllib.parse, urllib.request
from pathlib import Path

URL = 'https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1'
MARKETS = ('sii', 'otc')                     # 上市、上櫃；興櫃不在 RS 母體內

_ROW = re.compile(r"<tr[^>]*data-type='body'[^>]*>(.*?)</tr>", re.S)
_TD = re.compile(r'<td[^>]*>(.*?)</td>', re.S)
_ROC = re.compile(r'(\d{2,3})/(\d{1,2})/(\d{1,2})')

def _text(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', s))).strip()

def _roc(s):
    y, m, d = map(int, s.groups())
    return datetime.date(y + 1911, m, d)

def _months(start, end):
    """至少查「當月＋下月」，不只 window 橫跨的月份——快照要涵蓋明天的 window，
       否則早已申報、明天才滑進 window 的場次會被誤判為新增。"""
    nxt = (start.replace(day=1) + datetime.timedelta(days=32)).replace(day=1)
    end = max(end, nxt)
    out, d = [], start.replace(day=1)
    while d <= end:
        out.append((d.year - 1911, d.month))
        d = (d + datetime.timedelta(days=32)).replace(day=1)
    return out

_key = lambda r: '|'.join((r['id'], r['date_raw'], r['time']))
KEEP_SNAPSHOTS = 15

def _diff(state_dir, data_date, keys, kind):
    """與資料日之前的快照聯集比對，並存今日快照（conf_<kind>_<日期>.json）。
       回傳 (先前已見 keys 或 None, 基準日)。價格報告只看價格快照，籌碼報告看全部。
       用聯集而非只比前一份：前一天觀測站若漏回某筆，隔天才不會又被當成新增。"""
    if not state_dir: return None, None
    d = Path(state_dir); d.mkdir(parents=True, exist_ok=True)
    date_of = lambda f: f.stem.rsplit('_', 1)[1]
    pattern = 'conf_price_*.json' if kind == 'price' else 'conf_*_*.json'
    prev = sorted((f for f in d.glob(pattern) if date_of(f) < data_date), key=date_of)
    seen = set()
    for f in prev:
        seen |= set(json.load(open(f)))
    (d / f'conf_{kind}_{data_date}.json').write_text(json.dumps(sorted(keys), ensure_ascii=False))
    for k in ('price', 'chip'):
        for f in sorted(d.glob(f'conf_{k}_*.json'))[:-KEEP_SNAPSHOTS]:
            f.unlink()
    return (seen if prev else None), (date_of(prev[-1]) if prev else None)

def _query(typek, roc_year, month, timeout=25):
    body = urllib.parse.urlencode({'encodeURIComponent': 1, 'step': 1, 'firstin': 1, 'off': 1,
                                   'TYPEK': typek, 'year': roc_year, 'month': f'{month:02d}',
                                   'co_id': ''}).encode()
    req = urllib.request.Request(URL, data=body, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        t = r.read().decode('utf-8', 'replace')
    if 'data-type' not in t and '查詢無資料' not in t and '查無' not in t:
        # WAF 攔截頁或格式改版——寧可報錯讓報告顯示「無法取得」，也不要當成「沒有法說會」
        raise RuntimeError(f'觀測站回應非預期格式（{typek} {roc_year}/{month}）：{_text(t)[:80]}')
    rows = []
    for tr in _ROW.findall(t):
        td = [_text(x) for x in _TD.findall(tr)]
        if len(td) < 6: continue
        ds = [_roc(m) for m in _ROC.finditer(td[2])]
        if not ds: continue
        rows.append({'id': td[0], 'name': td[1], 'start': ds[0], 'end': ds[-1],
                     'date_raw': td[2], 'time': td[3], 'place': td[4], 'desc': td[5],
                     'market': typek})
    return rows

def fetch(data_date, days=14, state_dir=None, kind='price'):
    """回傳 {'rows': 開會日落在 (data_date, data_date+days] 的場次, 'baseline': 比對基準日}。
       日期欄可能是區間（「115/09/11 至 115/10/13」，多場受邀活動合併申報），
       區間與 window 重疊即納入，date 取區間在 window 內的第一天。
       每筆帶 new：先前快照沒出現過＝今日新增；無基準時一律 False。"""
    base = datetime.date.fromisoformat(data_date)
    lo, hi = base + datetime.timedelta(days=1), base + datetime.timedelta(days=days)
    allkeys, out = set(), []
    for typek in MARKETS:
        for y, m in _months(lo, hi):
            for r in _query(typek, y, m):
                key = _key(r)
                if key in allkeys: continue       # 跨月查詢會重複撈到同一筆區間
                allkeys.add(key)
                if r['end'] < lo or r['start'] > hi: continue
                first = max(r['start'], lo)
                out.append({**r, 'date': first.isoformat(),
                            'start': r['start'].isoformat(), 'end': r['end'].isoformat(),
                            'is_range': r['start'] != r['end']})
    seen, baseline = _diff(state_dir, data_date, allkeys, kind)
    for r in out:
        r['new'] = seen is not None and _key(r) not in seen
    out.sort(key=lambda r: (r['date'], r['time'], r['id']))
    return {'rows': out, 'baseline': baseline}

def by_stock(confs):
    """{股號: 一場}。卡片只標一場：有今日新增的場次就標最近的那場新增，否則標最近一場——
       避免標籤是紅的、日期卻是早就申報的那場。"""
    m = {}
    for r in (confs or {}).get('rows') or []:           # rows 已依日期排序
        cur = m.get(r['id'])
        if cur is None or (r.get('new') and not cur.get('new')):
            m[r['id']] = r
    return m

def label(r):
    """只標日期：單日「09/25」；區間照申報原樣顯示起訖——區間內哪天真的有場次，
       觀測站只給文字描述，這裡不猜。今日新增只靠紅底區分，不加字。"""
    md = lambda d: d[5:].replace('-', '/')
    if r.get('is_range'):
        return f"{md(r['start'])}–{md(r['end'])}"
    return md(r['date'])

BADGE_C = '#e67e22'
NEW_C = '#d32f2f'          # 今日新增：標籤改紅底

def badge(ax, r):
    """K 線區左上角的法說日期標籤（橘底；今日新增紅底）。強勢股左上多半是空的，不會壓到 K 棒主體。"""
    if not r: return
    ax.text(.012, .965, label(r), transform=ax.transAxes, ha='left', va='top',
            fontsize=7.5, color='white', fontweight='bold', zorder=10,
            bbox=dict(boxstyle='round,pad=.25', fc=color(r), ec='none'))

def color(r):
    return NEW_C if r.get('new') else BADGE_C

if __name__ == '__main__':
    import sys, zoneinfo
    d = sys.argv[1] if len(sys.argv) > 1 else \
        datetime.datetime.now(zoneinfo.ZoneInfo('Asia/Taipei')).strftime('%Y-%m-%d')
    res = fetch(d, state_dir=sys.argv[2] if len(sys.argv) > 2 else None)
    rows = res['rows']
    print(f"{d} 之後 14 天：{len(rows)} 場　基準 {res['baseline']}　新增 {sum(r['new'] for r in rows)}")
    for r in rows:
        print('新' if r['new'] else '　', r['date'], r['time'], r['market'], r['id'], r['name'],
              r['date_raw'], r['place'][:20])
