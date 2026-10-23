# 一次性：從 FinMind 抓籌碼頁歷史原始資料（2018/6 ～ 2024/10），存 output/20261023_finmind_chip_raw_tmp.json
# 不打期交所。每次請求間隔 1.2 秒；遇 402／429 立即停止。整段只跑一次，之後重算一律讀這個檔。
import json, sys, time, urllib.request, urllib.parse

API = 'https://api.finmindtrade.com/api/v4/data'
# 第一段 2018-06-01～2024-10-31；第二段（銜接網站一年份資料）2024-11-01～2025-10-31：python3 本檔 2
PART = sys.argv[1] if len(sys.argv) > 1 else '1'
START, END = ('2018-06-01', '2024-10-31') if PART == '1' else ('2024-11-01', '2025-10-31')
OUT = 'output/20261023_finmind_chip_raw_tmp.json' if PART == '1' else 'output/20261023_finmind_chip_raw2_tmp.json'
JOBS = [
    ('TaiwanFuturesInstitutionalInvestors', 'TX'),
    ('TaiwanFuturesInstitutionalInvestors', 'MTX'),
    ('TaiwanOptionInstitutionalInvestors', 'TXO'),
    ('TaiwanFuturesDaily', 'TX'),
    ('TaiwanFuturesDaily', 'MTX'),
]
calls = 0


def get(dataset, data_id, a, b):
    global calls
    calls += 1
    time.sleep(1.2)
    u = API + '?' + urllib.parse.urlencode({'dataset': dataset, 'data_id': data_id, 'start_date': a, 'end_date': b})
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=120)
        d = json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f'HTTP {e.code} {dataset} {data_id} {a}~{b}，停止'); sys.exit(1)
    if d.get('status') != 200:
        print(f'FinMind {d.get("status")} {d.get("msg")} {dataset} {data_id} {a}~{b}，停止'); sys.exit(1)
    return d['data']


out = {}
for ds, did in JOBS:
    rows = get(ds, did, START, END)
    days = sorted({r['date'] for r in rows})
    # 一次查整段若被截斷（最後日期離 END 太遠），改按年補抓缺的部分
    if not days or days[-1] < END[:8] + '20' or days[0] > START[:8] + '10':
        print(f'{ds} {did} 整段回傳 {len(rows)} 筆、{days[:1]}~{days[-1:]}，改按年抓')
        rows = []
        for y in range(int(START[:4]), int(END[:4]) + 1):
            rows += get(ds, did, max(START, f'{y}-01-01'), min(END, f'{y}-12-31'))
        days = sorted({r['date'] for r in rows})
    out[f'{ds}|{did}'] = rows
    print(f'{ds} {did}: {len(rows)} 筆，{days[0]} ~ {days[-1]}，共 {len(days)} 天')
json.dump(out, open(OUT, 'w'), ensure_ascii=False)
print('FinMind 請求次數', calls)
