"""每日報告主控。順序：交易日判定 → 抓資料 → 新鮮度檢查 → 產 PDF → 寄信。

設計原則：資料不對就不寄報告，改寄警告信。寧可讓你看到「今天沒出報告」，
也不要讓你收到一份看起來正常、其實是舊資料的報告（2026-09-04 就發生過）。

用法：python3 scripts/daily-report/run.py --kind price [--no-mail] [--force]
"""
import argparse, datetime, json, subprocess, sys, zoneinfo
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA, OUT = HERE / '_data', HERE / '_out'      # 產物不進版控，見同層 .gitignore
TZ = zoneinfo.ZoneInfo('Asia/Taipei')

sys.path.insert(0, str(HERE))
import market, mailer                                   # noqa: E402

def log(m): print(f'[run] {m}', flush=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--kind', choices=['price', 'chip'], default='price')
    ap.add_argument('--no-mail', action='store_true', help='只產出 PDF，不寄信')
    ap.add_argument('--force', action='store_true',
                    help='非交易日或資料過期仍強制產出（測試用）')
    a = ap.parse_args()

    today = datetime.datetime.now(TZ).strftime('%Y-%m-%d')
    ltd = market.latest_trading_day()
    log(f'今日(台北) {today}　交易所回報最近交易日 {ltd}')

    if ltd != today and not a.force:
        log('今日非交易日（或交易所尚未更新），不產出報告、不寄信。')
        return 0

    DATA.mkdir(parents=True, exist_ok=True)
    log('抓取 Firestore…')
    subprocess.run(['node', str(HERE / 'fetch_firestore.mjs'), str(DATA)], check=True)

    universe = json.load(open(DATA / 'universe.json'))
    from collections import Counter
    data_date = Counter(s['lastDate'] for s in universe).most_common(1)[0][0]
    log(f'資料庫最新收盤日 {data_date}')

    if data_date != ltd and not a.force:
        log(f'⚠️ 資料過期（{data_date} ≠ {ltd}），改寄警告信。')
        if not a.no_mail:
            mailer.send(mailer.build(a.kind, ltd, stale=data_date))
        return 1

    log('抓取大盤資料…')
    taiex = market.fetch_taiex_daily()
    json.dump(taiex, open(DATA / 'taiex.json', 'w'))

    if a.kind == 'price':
        m = market.fetch(data_date)
        json.dump(m, open(DATA / 'market.json', 'w'), ensure_ascii=False)
        import report_price
        pdf, date, counts = report_price.build(DATA, OUT)
        blocks, mail_market = counts, m
    else:
        log('抓取三大法人（含近 20 交易日外資序列，逐日請求需數秒）…')
        inst = market.institutional(data_date)
        json.dump(inst, open(DATA / 'institutional.json', 'w'), ensure_ascii=False)
        days = [r['date'] for r in taiex][-20:]
        json.dump(market.foreign_net_series(days), open(DATA / 'foreign_series.json', 'w'))
        import report_chip
        pdf, date, counts = report_chip.build(DATA, OUT)
        blocks, mail_market = counts, None

    if a.no_mail:
        log(f'--no-mail：略過寄信。PDF 位於 {pdf}')
        return 0

    mailer.send(mailer.build(a.kind, date, pdf, market=mail_market, blocks=blocks))
    return 0

if __name__ == '__main__':
    sys.exit(main())
