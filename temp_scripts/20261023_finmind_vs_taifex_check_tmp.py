# 比對 FinMind 與已存期交所原始資料的重疊期間（不打網路）
import json
import sys
fm = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'output/20261023_finmind_chip_raw_tmp.json'))
tf = json.load(open('output/20261022_taifex_foreign_tmp.json'))
oi_tf = json.load(open('output/20261020_taifex_cache.json'))['oi']
WHO = {'外資': 'foreign', '投信': 'trust', '自營商': 'dealer'}
def d2s(d): return d.replace('-', '/')
# 1. 期貨法人：多口、空口
for fid, cid in [('TX', 'TXF'), ('MTX', 'MXF')]:
    ok = bad = 0; ex = []
    for r in fm[f'TaiwanFuturesInstitutionalInvestors|{fid}']:
        t = tf['fut'][cid].get(d2s(r['date']), {}).get(WHO.get(r['institutional_investors']))
        if not t: continue
        a = (r['long_open_interest_balance_volume'], r['short_open_interest_balance_volume'])
        if a == (t[0], t[2]): ok += 1
        else: bad += 1; ex.append((r['date'], r['institutional_investors'], a, (t[0], t[2])))
    print('期貨法人', fid, 'ok', ok, 'bad', bad, ex[:3])
# 2. 選擇權法人：買權賣權 × 身份 × [買口,買金,賣口,賣金]
ok = bad = 0; ex = []
for r in fm['TaiwanOptionInstitutionalInvestors|TXO']:
    cp = 'CALL' if r['call_put'] == '買權' else 'PUT'
    t = tf['opt'].get(d2s(r['date']), {}).get(WHO.get(r['institutional_investors']), {}).get(cp)
    if not t: continue
    a = (r['long_open_interest_balance_volume'], r['long_open_interest_balance_amount'], r['short_open_interest_balance_volume'], r['short_open_interest_balance_amount'])
    if a == tuple(t[:4]): ok += 1
    else: bad += 1; ex.append((r['date'], cp, r['institutional_investors'], a, t[:4]))
print('選擇權法人 ok', ok, 'bad', bad, ex[:3])
# 3. 期貨各月份未平倉（一般盤 position、非價差）
for fid in ['TX', 'MTX']:
    fmap = {}
    sess = set(); cds = set()
    for r in fm[f'TaiwanFuturesDaily|{fid}']:
        sess.add(r['trading_session']); cds.add(r['contract_date'])
        if r['trading_session'] != 'position' or '/' in r['contract_date']: continue
        fmap.setdefault(d2s(r['date']), {})[r['contract_date'].strip()] = r['open_interest']
    ok = bad = 0; ex = []
    for d, months in oi_tf[fid].items():
        if d not in fmap: continue
        if months == fmap[d]: ok += 1
        else: bad += 1; ex.append((d, months, fmap[d]))
    print('每日行情', fid, 'ok', ok, 'bad', bad, ex[:2], '| sessions', sess, '| 合約樣式', sorted(c for c in cds if not c.isdigit())[:8])
