"""報告寄送模組。憑證一律取自環境變數，不落地、不寫入任何檔案。

環境變數（對應 GitHub Secrets）：
  GMAIL_ADDRESS       寄件者＝收件者
  GMAIL_APP_PASSWORD  Google 應用程式密碼（16 碼，非登入密碼）

可獨立執行（本機驗證用）：
  python3 mailer.py --dry-run <pdf> --kind price --date 2026-09-04
亦供 run.py 匯入使用。
"""
import argparse, json, os, smtplib, ssl, sys
from email.message import EmailMessage
from pathlib import Path

SMTP_HOST, SMTP_PORT = 'smtp.gmail.com', 465          # SSL；587+STARTTLS 亦可

KIND = {
    'price': ('價格報告', '創新高／追發動／強勢股'),
    'chip':  ('籌碼報告', '外資投信連買訊號'),
}

def build(kind, date, pdf_path=None, stale=None, market=None, blocks=None):
    label, subtitle = KIND[kind]
    msg = EmailMessage()
    addr = os.environ.get('GMAIL_ADDRESS', 'unset@example.com')
    msg['From'], msg['To'] = addr, addr

    if stale:
        msg['Subject'] = f'⚠️ {date} {label} — 資料未更新，未產出報告'
        msg.set_content(
            f'{date} {label} 今日未產出。\n\n'
            f'原因：資料庫最新收盤日為 {stale}，與預期的交易日 {date} 不符。\n'
            f'代表每日同步未執行或失敗。\n\n'
            f'請檢查：\n'
            f'  1. GitHub Actions 是否有當日 run\n'
            f'     https://github.com/chun10124/research-website/actions/workflows/daily-sync.yml\n'
            f'  2. 若完全沒有 run，問題在 Cloudflare Worker（觸發端），可能是 GH_PAT 過期\n\n'
            f'（本信為自動發出，資料正確前不會寄出報告，以免你看到過期數字。）\n')
        return msg

    lines = [f'{date}　{label}', f'（{subtitle}）', '']
    if market:
        t, p = market.get('taiex') or {}, market.get('tpex_index') or {}
        lines += [f"加權指數　{t.get('close', 0):,.2f}　{t.get('chg', 0):+,.2f}　{t.get('pct', 0):+.2f}%",
                  f"櫃買指數　{p.get('close', 0):,.2f}　{p.get('chg', 0):+,.2f}　{p.get('pct', 0):+.2f}%"]
        tot = market.get('total') or {}
        lines += [f"漲跌家數　上漲 {tot.get('up', 0):,}（漲停 {tot.get('limit_up', 0)}）　"
                  f"下跌 {tot.get('down', 0):,}（跌停 {tot.get('limit_down', 0)}）　"
                  f"平盤 {tot.get('flat', 0):,}", '']
    if blocks:
        for name, n in blocks.items():
            lines.append(f'{name}　{n} 檔')
        lines.append('')
    lines += ['詳見附件 PDF。', '',
              '本報告僅為數據排名與統計，不含任何買賣建議。']

    msg['Subject'] = f'{date} {label}'
    msg.set_content('\n'.join(lines))

    if pdf_path:
        p = Path(pdf_path)
        msg.add_attachment(p.read_bytes(), maintype='application', subtype='pdf', filename=p.name)
    return msg

def send(msg):
    addr = os.environ.get('GMAIL_ADDRESS')
    pw   = os.environ.get('GMAIL_APP_PASSWORD')
    missing = [k for k, v in (('GMAIL_ADDRESS', addr), ('GMAIL_APP_PASSWORD', pw)) if not v]
    if missing:
        sys.exit(f'❌ 缺少環境變數：{", ".join(missing)}（本機請勿寫入檔案，用 export 設定）')
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context()) as s:
        s.login(addr, pw)
        s.send_message(msg)
    print(f'✅ 已寄出：{msg["Subject"]} → {addr}')

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf', nargs='?')
    ap.add_argument('--kind', choices=list(KIND), required=True)
    ap.add_argument('--date', required=True)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--stale', help='資料庫實際最新日期；給了就寄警告信')
    ap.add_argument('--market', help='大盤摘要 JSON 路徑')
    ap.add_argument('--blocks', help='區塊檔數 JSON 路徑')
    a = ap.parse_args()

    mkt = json.load(open(a.market)) if a.market and Path(a.market).exists() else None
    blk = None
    if a.blocks and Path(a.blocks).exists():
        raw = json.load(open(a.blocks))
        blk = {k: len(v) for k, v in raw.items()}

    m = build(a.kind, a.date, a.pdf, stale=a.stale, market=mkt, blocks=blk)
    if a.dry_run:
        print('─── 乾跑：以下為將寄出的信件 ───')
        print(f'Subject: {m["Subject"]}')
        print(f'To:      {m["To"]}')
        body = m.get_body(preferencelist=('plain'))
        print('─── 內文 ───'); print(body.get_content())
        for part in m.iter_attachments():
            print(f'─── 附件：{part.get_filename()}　'
                  f'{len(part.get_payload(decode=True))/1e6:.2f} MB ───')
        sys.exit(0)
    send(m)
