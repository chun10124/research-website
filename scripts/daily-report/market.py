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
    """加權指數日線 OHLCV。close 供個股卡片的 RS 面板疊圖，OHLC 供封面大盤 K 線。"""
    import datetime, zoneinfo
    tz = zoneinfo.ZoneInfo('Asia/Taipei')
    r = get(f'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII'
            f'?range={years}y&interval=1d')['chart']['result'][0]
    q = r['indicators']['quote'][0]
    out = []
    for i, t in enumerate(r['timestamp']):
        c = q['close'][i]
        if c is None: continue
        out.append({'date': datetime.datetime.fromtimestamp(t, tz).strftime('%Y-%m-%d'),
                    'open': q['open'][i], 'high': q['high'][i],
                    'low': q['low'][i], 'close': c, 'volume': q['volume'][i]})
    return out


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


# ── 三大法人（大盤層級）─────────────────────────────────────────────────
def _num(x):
    return float(str(x).replace(',', '')) if x not in (None, '') else 0.0

def institutional(date):
    """單日三大法人買賣超（元）。上市 TWSE BFI82U、上櫃 TPEX 3insti_summary。
       自營商合併「自行買賣 + 避險」。"""
    out = {'date': date}
    y = date.replace('-', '')
    tw = get(f'https://www.twse.com.tw/rwd/zh/fund/BFI82U?dayDate={y}&type=day&response=json')
    m = {r[0]: _num(r[3]) for r in tw.get('data', [])}
    out['twse'] = {
        'foreign': m.get('外資及陸資(不含外資自營商)', 0) + m.get('外資自營商', 0),
        'trust':   m.get('投信', 0),
        'dealer':  m.get('自營商(自行買賣)', 0) + m.get('自營商(避險)', 0),
    }
    tp = get('https://www.tpex.org.tw/openapi/v1/tpex_3insti_summary')
    latest = max(r['Date'] for r in tp)
    mm = {r['Investor'].strip(): _num(r['Net']) for r in tp if r['Date'] == latest}
    out['tpex'] = {'foreign': mm.get('外資及陸資合計', 0),
                   'trust':   mm.get('投信', 0),
                   'dealer':  mm.get('自營商合計', 0)}
    d = roc_to_ymd(latest)
    if d != date:
        out['tpex_date_mismatch'] = d
    out['total'] = {k: out['twse'][k] + out['tpex'][k] for k in ('foreign', 'trust', 'dealer')}
    return out

def foreign_net_series(trading_days):
    """近 N 個交易日的外資買賣超（上市，元）。單日數字沒有意義，要看連續性。
       BFI82U 一次只給一天，故逐日抓；失敗的日子略過不中斷。"""
    out = []
    for d in trading_days:
        try:
            y = d.replace('-', '')
            tw = get(f'https://www.twse.com.tw/rwd/zh/fund/BFI82U?dayDate={y}&type=day&response=json')
            m = {r[0]: _num(r[3]) for r in tw.get('data', [])}
            if not m: continue
            out.append({'date': d,
                        'foreign': m.get('外資及陸資(不含外資自營商)', 0) + m.get('外資自營商', 0),
                        'trust': m.get('投信', 0)})
        except Exception:
            continue
    return out


# ── 台指期三大法人未平倉 ────────────────────────────────────────────────
def futures_oi(contract='臺股期貨'):
    """臺股期貨三大法人的交易口數淨額與未平倉淨額。
       端點清單在 https://openapi.taifex.com.tw/v1/swagger.json（在 /v1/ 底下，非根目錄）。
       注意欄位是 ContractCode 而非 ContractName。"""
    d = get('https://openapi.taifex.com.tw/v1/'
            'MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate')
    rows = [r for r in d if r.get('ContractCode', '').strip() == contract]
    if not rows: return None
    out = {'date': roc_to_ymd_ad(rows[0]['Date']), 'contract': contract, 'items': {}}
    for r in rows:
        out['items'][r['Item'].strip()] = {
            'net_volume': int(_num(r['TradingVolume(Net)'])),
            'net_oi': int(_num(r['OpenInterest(Net)'])),
        }
    return out

def roc_to_ymd_ad(s):
    """期交所用西元 YYYYMMDD（與證交所的民國格式不同）。"""
    s = str(s).strip()
    return f'{s[:4]}-{s[4:6]}-{s[6:8]}' if len(s) == 8 else None


# ── 融資融券 ────────────────────────────────────────────────────────────
def _margin_one(date):
    y = date.replace('-', '')
    d = get(f'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN'
            f'?date={y}&selectType=MS&response=json')
    tbl = next((t for t in d.get('tables', []) if '信用交易統計' in str(t.get('title', ''))), None)
    if not tbl: return None
    m = {r[0]: r for r in tbl.get('data', [])}
    pick = lambda k, i: _num(m[k][i]) if k in m else 0.0
    return {'date': date,
            'margin_bal':  pick('融資(交易單位)', 5),      # 今日餘額（張）
            'margin_prev': pick('融資(交易單位)', 4),
            'short_bal':   pick('融券(交易單位)', 5),
            'short_prev':  pick('融券(交易單位)', 4),
            'margin_amt':  pick('融資金額(仟元)', 5)}

def margin_balance(date):
    r = _margin_one(date)
    if r:
        r['margin_chg'] = r['margin_bal'] - r['margin_prev']
        r['short_chg'] = r['short_bal'] - r['short_prev']
    return r

def margin_series(trading_days):
    """近 N 交易日融資餘額。逐日請求，失敗的日子略過不中斷。"""
    out = []
    for d in trading_days:
        try:
            r = _margin_one(d)
            if r: out.append(r)
        except Exception:
            continue
    return out


# ── 歷史序列（半年）────────────────────────────────────────────────────
# 證交所的 BFI82U / MI_MARGN 只能一天一請求，半年要 120 次；FinMind 的
# 大盤級 dataset 支援區間查詢，一次就好。期貨那張 FinMind 需付費等級，
# 改走期交所的區間 CSV（同樣一次請求）。
FINMIND = 'https://api.finmindtrade.com/api/v4/data'
FINMIND_TOKEN = ('eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJkYXRlIjoiMjAyNS0xMi0xNCAxNzowNzo1MyIsInVzZXJf'
                 'aWQiOiJjaHVuMTAxMjQiLCJpcCI6IjYxLjIyOC43Ni4yMDYifQ.mSi9H6Lrus7e_wkaNxlYd6OoFmh79NQoQ7pZajx166s')

def _finmind(dataset, start, end):
    import urllib.parse
    q = urllib.parse.urlencode({'dataset': dataset, 'start_date': start,
                                'end_date': end, 'token': FINMIND_TOKEN})
    r = get(f'{FINMIND}?{q}')
    if r.get('msg') != 'success':
        raise RuntimeError(f"FinMind {dataset}: {r.get('msg')}")
    return r.get('data') or []

def foreign_net_series(start, end):
    """大盤三大法人買賣超（元）。FinMind 只給 buy/sell，淨額自算。
       外資 = 外資及陸資(不含自營) + 外資自營商，與證交所 BFI82U 的分類一致。"""
    rows = _finmind('TaiwanStockTotalInstitutionalInvestors', start, end)
    by_date = {}
    for r in rows:
        d = by_date.setdefault(r['date'], {'date': r['date'], 'foreign': 0.0,
                                           'trust': 0.0, 'dealer': 0.0})
        net = (r.get('buy') or 0) - (r.get('sell') or 0)
        n = r.get('name')
        if n in ('Foreign_Investor', 'Foreign_Dealer_Self'): d['foreign'] += net
        elif n == 'Investment_Trust':                        d['trust'] += net
        elif n in ('Dealer_self', 'Dealer_Hedging'):         d['dealer'] += net
    return [by_date[d] for d in sorted(by_date)]

def margin_series(start, end):
    """大盤融資融券餘額（張）。TodayBalance 即當日餘額。"""
    rows = _finmind('TaiwanStockTotalMarginPurchaseShortSale', start, end)
    by_date = {}
    for r in rows:
        d = by_date.setdefault(r['date'], {'date': r['date']})
        if r['name'] == 'MarginPurchase':
            d['margin_bal'] = r['TodayBalance']; d['margin_prev'] = r['YesBalance']
        elif r['name'] == 'MarginPurchaseMoney':          # 元；融資通常以金額（億元）表示
            d['margin_amt'] = r['TodayBalance']; d['margin_amt_prev'] = r['YesBalance']
        elif r['name'] == 'ShortSale':
            d['short_bal'] = r['TodayBalance']; d['short_prev'] = r['YesBalance']
    out = [by_date[d] for d in sorted(by_date) if 'margin_bal' in by_date[d]]
    for r in out:
        r['margin_chg'] = r['margin_bal'] - r.get('margin_prev', r['margin_bal'])
        r['short_chg'] = r.get('short_bal', 0) - r.get('short_prev', 0)
        r['margin_amt_chg'] = r.get('margin_amt', 0) - r.get('margin_amt_prev', 0)
    return out

def futures_oi_series(start, end, contract='臺股期貨'):
    """臺股期貨三大法人未平倉淨額（口）。FinMind 的期貨法人表需付費等級，
       改用期交所區間 CSV（Big5），一次請求拿整段。"""
    import csv, io, urllib.parse
    body = urllib.parse.urlencode({
        'firstDate': start.replace('-', '/'), 'lastDate': end.replace('-', '/'),
        'queryStartDate': start.replace('-', '/'), 'queryEndDate': end.replace('-', '/'),
        'commodityId': 'TXF',
    }).encode()
    req = urllib.request.Request(
        'https://www.taifex.com.tw/cht/3/futContractsDateDown', data=body,
        headers={'User-Agent': 'Mozilla/5.0',
                 'Referer': 'https://www.taifex.com.tw/cht/3/futContractsDate'})
    raw = urllib.request.urlopen(req, timeout=60, context=CTX).read().decode('big5', 'ignore')
    key = {'外資及陸資': 'foreign', '投信': 'trust', '自營商': 'dealer'}
    acc = {}
    for row in csv.reader(io.StringIO(raw)):
        if len(row) < 14 or not row[0][:4].isdigit(): continue
        if row[1].strip() != contract: continue
        k = key.get(row[2].strip())
        if not k: continue
        d = row[0].strip().replace('/', '-')
        acc.setdefault(d, {'date': d})[k] = int(_num(row[13]))   # 多空未平倉口數淨額
    return [acc[d] for d in sorted(acc)]


def tpex_foreign_series(trading_days, workers=4):
    """上櫃三大法人買賣超歷史（元）。TPEX 只提供單日查詢，故逐日抓；
       用少量併行縮短時間。失敗的日子略過，不中斷整體流程。"""
    from concurrent.futures import ThreadPoolExecutor
    def one(d):
        try:
            r = get(f'https://www.tpex.org.tw/www/zh-tw/insti/summary'
                    f'?type=Daily&date={d.replace("-", "/")}&response=json')
            tbl = next((t for t in r.get('tables', []) if t.get('data')), None)
            if not tbl: return None
            m = {row[0].strip(): _num(row[3]) for row in tbl['data'] if len(row) >= 4}
            return {'date': d,
                    'foreign': m.get('外資及陸資合計', 0),
                    'trust': m.get('投信', 0),
                    'dealer': m.get('自營商合計', 0)}
        except Exception:
            return None
    with ThreadPoolExecutor(max_workers=workers) as ex:
        rows = [r for r in ex.map(one, trading_days) if r]
    return sorted(rows, key=lambda r: r['date'])

def foreign_net_series_all(start, end, trading_days):
    """上市＋上櫃合計的三大法人買賣超。上市走 FinMind（一次請求），
       上櫃走 TPEX 逐日（無區間端點）。上櫃抓不到時退回只有上市，並標記。"""
    tw = {r['date']: r for r in foreign_net_series(start, end)}
    days = [d for d in trading_days if start <= d <= end]
    tp = {r['date']: r for r in tpex_foreign_series(days)}
    out = []
    for d in sorted(tw):
        a, b = tw[d], tp.get(d)
        out.append({'date': d,
                    'foreign': a['foreign'] + (b['foreign'] if b else 0),
                    'trust':   a['trust'] + (b['trust'] if b else 0),
                    'dealer':  a['dealer'] + (b['dealer'] if b else 0),
                    'twse_only': b is None})
    return out
