"""
晚上在 Mac 執行：追蹤表個股的富邦三大法人買賣超 → Firestore ibdRsMeta/fubonInst_YYYYMMDD
供每日同步（holdingsRevenue 的法人那段）優先使用，省 FinMind 每小時配額；缺檔時同步自動退回 FinMind。

  - 清單：Firestore stockWatchlist（與同步相同母體）
  - 每檔抓近 LOOKBACK_DAYS 天（ownership/institutional-trades），每分鐘 ≤ 57 次（實測上限約 60/min）
  - 今日資料尚未公布（有近期資料的股票中，今日有資料者未過半）→ 不寫 Firestore，結束碼 2，排程稍後再試
  - 每日一列 [date, 外資買, 外資賣, 投信買, 投信賣, 自營買, 自營賣]（股）；同步端轉回 FinMind 形狀沿用 parseInstRows
    （FinMind 形狀 325 檔逼近 Firestore 單文件 1MB 上限，故存精簡陣列）
用法：temp_scripts/.venv_fubon/bin/python temp_scripts/20261020_fubon_inst_tmp.py [--write] [--limit N]
憑據：環境變數 FUBON_ID / FUBON_API_KEY / FUBON_CERT_PATH（GitHub Actions）；未設時讀鑰匙圈 research-fubon ＋ ~/.fubon/cert.p12
排程會在傍晚多次觸發：當日文件已存在就直接結束；尚未公布也正常結束（結束碼 0），等下一次觸發
輸出：output/fubon_inst/YYYYMMDD.json（每日獨立檔）
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from fubon_neo.sdk import FubonSDK, FugleAPIError

TW = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "output" / "fubon_inst"
FIREBASE_PROJECT = "my-tools-1228"
FIREBASE_API_KEY = "AIzaSyAUDHCT_dtMHQFPcUh6-gFSIFXT6dR9MVg"  # 前端公開 web key，權限由 Firestore 規則把關
FS_BASE = f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}/databases/(default)/documents"
LOOKBACK_DAYS = 20
MIN_INTERVAL_S = 1.05
SCHEMA_VERSION = 1


def log(msg):
    print(f"[{datetime.now(TW):%H:%M:%S}] {msg}", flush=True)


def kc(account):
    if os.environ.get(account):
        return os.environ[account]
    return subprocess.run(["security", "find-generic-password", "-s", "research-fubon", "-a", account, "-w"],
                          capture_output=True, text=True, check=True).stdout.strip()


def doc_exists(doc_id):
    r = requests.get(f"{FS_BASE}/ibdRsMeta/{doc_id}", params={"key": FIREBASE_API_KEY, "mask.fieldPaths": "date"}, timeout=20)
    return r.status_code == 200


def watchlist_codes():
    codes, token = [], None
    while True:
        params = {"pageSize": 300, "mask.fieldPaths": "code", "key": FIREBASE_API_KEY}
        if token:
            params["pageToken"] = token
        r = requests.get(f"{FS_BASE}/stockWatchlist", params=params, timeout=30)
        r.raise_for_status()
        j = r.json()
        for d in j.get("documents", []):
            code = (d.get("fields", {}).get("code", {}).get("stringValue") or d["name"].rsplit("/", 1)[-1]).strip()
            code = code.split(".")[0]
            if code:
                codes.append(code)
        token = j.get("nextPageToken")
        if not token:
            return sorted(set(codes))


def compact_row(item):
    return [item["date"][:10], item["foreign"]["buy"], item["foreign"]["sell"], item["trust"]["buy"],
            item["trust"]["sell"], item["dealer"]["buy"], item["dealer"]["sell"]]


def main():
    write = "--write" in sys.argv
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 0
    today = datetime.now(TW).date()
    today_s, from_s = today.isoformat(), (today - timedelta(days=LOOKBACK_DAYS)).isoformat()

    if write and doc_exists(f"fubonInst_{today_s.replace('-', '')}"):
        log("今日富邦法人已寫入過，略過")
        return
    if today.weekday() >= 5:
        log("週末，略過")
        return

    codes = watchlist_codes()
    if limit:
        codes = codes[:limit]
    log(f"追蹤表 {len(codes)} 檔，查詢 {from_s} ~ {today_s}")

    sdk = FubonSDK()
    cert = os.environ.get("FUBON_CERT_PATH") or os.path.expanduser("~/.fubon/cert.p12")
    res = sdk.apikey_login(kc("FUBON_ID"), kc("FUBON_API_KEY"), cert)
    if not getattr(res, "is_success", False):
        sys.exit(f"富邦登入失敗：{getattr(res, 'message', None)}")
    sdk.init_realtime()
    own = sdk.marketdata.rest_client.stock.ownership

    per_stock, failed, last = {}, [], 0.0
    for i, code in enumerate(codes, 1):
        for attempt in range(3):
            wait = MIN_INTERVAL_S - (time.time() - last)
            if wait > 0:
                time.sleep(wait)
            last = time.time()
            try:
                data = own.institutional_trades(symbol=code, **{"from": from_s, "to": today_s, "sort": "asc"}).get("data", [])
                per_stock[code] = [compact_row(item) for item in data]
                break
            except FugleAPIError as e:
                if e.status_code == 429:
                    log(f"429，等 60 秒（{code}）")
                    time.sleep(60)
                    continue
                failed.append(code)
                break
            except Exception:
                failed.append(code)
                break
        if i % 50 == 0:
            log(f"{i}/{len(codes)}")

    recent = [c for c, rows in per_stock.items() if rows]
    with_today = [c for c in recent if any(r[0] == today_s for r in per_stock[c])]
    log(f"完成：成功 {len(per_stock)}、失敗 {len(failed)}；近期有資料 {len(recent)} 檔、其中今日有資料 {len(with_today)} 檔")

    payload = {"schema": SCHEMA_VERSION, "date": today_s, "from": from_s, "generatedAt": datetime.now(TW).isoformat(),
               "source": "fubon-institutional-trades", "failed": failed, "rows": per_stock}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{today_s.replace('-', '')}.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    log(f"本機已存：{out.relative_to(ROOT)}（{out.stat().st_size/1024:.0f} KB）")

    if not recent or len(with_today) * 2 < len(recent):
        log("今日法人資料尚未公布（未過半），不寫 Firestore，等下一次觸發")
        return
    if write:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        fields = {"json": {"stringValue": body}, "date": {"stringValue": today_s},
                  "schema": {"integerValue": str(SCHEMA_VERSION)},
                  "updatedAt": {"integerValue": str(int(time.time() * 1000))}}
        r = requests.patch(f"{FS_BASE}/ibdRsMeta/fubonInst_{today_s.replace('-', '')}",
                           params={"key": FIREBASE_API_KEY}, json={"fields": fields}, timeout=60)
        if not r.ok:
            sys.exit(f"Firestore 寫入失敗 HTTP {r.status_code}: {r.text[:300]}")
        log(f"已寫入 Firestore ibdRsMeta/fubonInst_{today_s.replace('-', '')}（{len(body)/1024:.0f} KB）")
    else:
        log("未加 --write，未寫入 Firestore")


if __name__ == "__main__":
    main()
