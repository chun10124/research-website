"""大盤摘要：加權／櫃買指數漲跌、上市上櫃漲跌家數與漲跌停家數，以及最近交易日判定。
   來源皆為交易所官方：
     加權指數      TWSE OpenAPI  /exchangeReport/MI_INDEX
     上市漲跌家數  TWSE rwd      MI_INDEX?type=MS  的「漲跌證券數合計」（取『股票』欄，排除權證/ETF）
     櫃買指數+家數 TPEX OpenAPI  /openapi/v1/tpex_mainborad_highlight（端點名稱官方拼錯，非筆誤）
"""
import json, ssl, urllib.request, re
from pathlib import Path
try:
    import certifi; CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = None

UA = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.twse.com.tw/'}

def get(url):
    """urllib 優先；SSL 驗證失敗改用 curl（TPEX 憑證鏈缺 Subject Key Identifier，
       certifi 會拒絕但系統信任庫接受）。兩種環境都能跑。"""
    try:
        return json.load(urllib.request.urlopen(
            urllib.request.Request(url, headers=UA), timeout=25, context=CTX))
    except (ssl.SSLError, urllib.error.URLError) as e:
        if 'CERTIFICATE_VERIFY_FAILED' not in str(e): raise
        import subprocess
        r = subprocess.run(['curl', '-sL', '--max-time', '25',
                            '-H', f"User-Agent: {UA['User-Agent']}",
                            '-H', f"Referer: {UA['Referer']}", url],
                           capture_output=True, text=True, check=True)
        return json.loads(r.stdout)

def roc_to_ymd(s):
    s = str(s).strip()
    return f"{int(s[:-4])+1911:04d}-{s[-4:-2]}-{s[-2:]}" if len(s) >= 6 else None

def parse_pair(txt):
    """'762(15)' → (762, 15)；'102' → (102, None)"""
    m = re.match(r'^([\d,]+)(?:\((\d+)\))?$', str(txt).strip())
    if not m: return None, None
    return int(m.group(1).replace(',', '')), (int(m.group(2)) if m.group(2) else None)

def fetch_intraday(data_date):
    """當日加權指數分時（5 分鐘）。Yahoo ^TWII；TWSE OpenAPI 無盤中指數。
       回傳 [{'t':'HH:MM','v':float}, ...]，抓不到回 []。"""
    import datetime, zoneinfo
    tz = zoneinfo.ZoneInfo('Asia/Taipei')
    y, m, d = (int(x) for x in data_date.split('-'))
    p1 = int(datetime.datetime(y, m, d, 8, 0, tzinfo=tz).timestamp())
    p2 = int(datetime.datetime(y, m, d, 15, 0, tzinfo=tz).timestamp())
    try:
        r = get(f'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII'
                f'?period1={p1}&period2={p2}&interval=5m')['chart']['result'][0]
        ts = r.get('timestamp') or []
        cl = r['indicators']['quote'][0]['close']
        return [{'t': datetime.datetime.fromtimestamp(t, tz).strftime('%H:%M'), 'v': v}
                for t, v in zip(ts, cl) if v is not None]
    except Exception:
        return []

def fetch_taiex_daily(years=2):
    """加權指數日收盤，供個股卡片的 RS 面板疊圖用。回傳 [{'date','close'}]。"""
    import datetime, zoneinfo
    tz = zoneinfo.ZoneInfo('Asia/Taipei')
    r = get(f'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII'
            f'?range={years}y&interval=1d')['chart']['result'][0]
    return [{'date': datetime.datetime.fromtimestamp(t, tz).strftime('%Y-%m-%d'), 'close': c}
            for t, c in zip(r['timestamp'], r['indicators']['quote'][0]['close']) if c is not None]


def latest_trading_day():
    """交易所回報的最近一個交易日（YYYY-MM-DD）。
       不自行推算國定假日／颱風假——以官方資料的日期為唯一真實來源。"""
    idx = get('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX')
    row = next((r for r in idx if r.get('指數') == '發行量加權股價指數'), None)
    return roc_to_ymd(row['日期']) if row else None


def fetch(data_date):
    """data_date: 'YYYY-MM-DD'，用來核對官方資料是否為同一天。"""
    out = {'date': data_date, 'warnings': []}

    # ── 加權指數 ──
    twse_idx = get('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX')
    row = next((r for r in twse_idx if r.get('指數') == '發行量加權股價指數'), None)
    if row:
        sign = -1 if row.get('漲跌', '+').strip() == '-' else 1
        out['taiex'] = {'close': float(row['收盤指數'].replace(',', '')),
                        'chg': sign * float(row['漲跌點數'].replace(',', '')),
                        'pct': sign * float(row['漲跌百分比'])}
        d = roc_to_ymd(row['日期'])
        if d != data_date: out['warnings'].append(f'加權指數日期 {d} 與報告資料日 {data_date} 不符')

    # ── 上市漲跌家數（取「股票」欄）──
    y = data_date.replace('-', '')
    ms = get(f'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={y}&type=MS&response=json')
    tbl = next((t for t in ms.get('tables', []) if t.get('title') == '漲跌證券數合計'), None)
    if tbl:
        col = tbl['fields'].index('股票')
        m = {r[0]: r[col] for r in tbl['data']}
        up,  ulim = parse_pair(m.get('上漲(漲停)', '0'))
        dn,  dlim = parse_pair(m.get('下跌(跌停)', '0'))
        flat, _   = parse_pair(m.get('持平', '0'))
        out['twse'] = {'up': up, 'limit_up': ulim, 'down': dn, 'limit_down': dlim, 'flat': flat}

    # ── 櫃買指數 + 漲跌家數 ──
    tp = get('https://www.tpex.org.tw/openapi/v1/tpex_mainborad_highlight')
    r = tp[0] if isinstance(tp, list) else tp
    out['tpex_index'] = {'close': float(r['CloseIndex']), 'chg': float(r['IndexChange'])}
    prev = out['tpex_index']['close'] - out['tpex_index']['chg']
    out['tpex_index']['pct'] = out['tpex_index']['chg'] / prev * 100 if prev else None
    out['tpex'] = {'up': int(r['PriceRiseCompanyNumbers']), 'limit_up': int(r['LimitUpCompanyNumbers']),
                   'down': int(r['PriceDeclineCompanyNumbers']), 'limit_down': int(r['LimitDownCompanyNumbers']),
                   'flat': int(r['PriceFlatCompanyNumbers'])}
    d = roc_to_ymd(r['Date'])
    if d != data_date: out['warnings'].append(f'櫃買資料日期 {d} 與報告資料日 {data_date} 不符')

    out['intraday'] = fetch_intraday(data_date)
    if not out['intraday']:
        out['warnings'].append('當日分時走勢抓取失敗，封面走勢圖將留白')

    a, b = out.get('twse', {}), out.get('tpex', {})
    out['total'] = {k: (a.get(k) or 0) + (b.get(k) or 0)
                    for k in ('up', 'limit_up', 'down', 'limit_down', 'flat')}
    return out

if __name__ == '__main__':
    import sys
    date = sys.argv[1] if len(sys.argv) > 1 else latest_trading_day()
    out  = sys.argv[2] if len(sys.argv) > 2 else 'data/market.json'
    m = fetch(date)
    json.dump(m, open(out, 'w'), ensure_ascii=False, indent=1)
    tx = fetch_taiex_daily()
    json.dump(tx, open(str(Path(out).parent / 'taiex.json'), 'w'))
    print(f'加權日線 {len(tx)} 筆　最近交易日（交易所回報）{latest_trading_day()}')
    t, p = m['taiex'], m['tpex_index']
    print(f"加權 {t['close']:,.2f}  {t['chg']:+.2f} ({t['pct']:+.2f}%)")
    print(f"櫃買 {p['close']:,.2f}  {p['chg']:+.2f} ({p['pct']:+.2f}%)")
    for k, lbl in (('twse','上市'), ('tpex','上櫃'), ('total','合計')):
        d = m[k]
        print(f"{lbl}　漲 {d['up']:>4}（漲停 {d['limit_up']:>2}）　"
              f"跌 {d['down']:>4}（跌停 {d['limit_down']:>2}）　平 {d['flat']:>3}")
    for w in m['warnings']: print('⚠️', w)
