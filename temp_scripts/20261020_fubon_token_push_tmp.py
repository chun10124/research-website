"""
登入富邦取得行情 sdk_token，推送到 Cloudflare Worker（research-quote）供網頁即時報價使用。
憑據：環境變數 FUBON_ID / FUBON_API_KEY / QUOTE_PUSH_SECRET / FUBON_CERT_PATH（GitHub Actions）；
      未設時讀鑰匙圈 research-fubon ＋ ~/.fubon/cert.p12。不印出任何 token。
由 Cloudflare Worker（cron-trigger）盤前與盤中觸發 fubon-fetch.yml 執行。
"""
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

import requests
from fubon_neo.sdk import FubonSDK

TW = timezone(timedelta(hours=8))
WORKER = os.environ.get("QUOTE_WORKER_URL", "https://research-quote.tzuchun11232004.workers.dev")


def kc(account):
    if os.environ.get(account):
        return os.environ[account]
    return subprocess.run(["security", "find-generic-password", "-s", "research-fubon", "-a", account, "-w"],
                          capture_output=True, text=True, check=True).stdout.strip()


def main():
    sdk = FubonSDK()
    cert = os.environ.get("FUBON_CERT_PATH") or os.path.expanduser("~/.fubon/cert.p12")
    res = sdk.apikey_login(kc("FUBON_ID"), kc("FUBON_API_KEY"), cert)
    if not getattr(res, "is_success", False):
        sys.exit(f"富邦登入失敗：{getattr(res, 'message', None)}")
    sdk.init_realtime()
    cfg = sdk.marketdata.rest_client.stock.snapshot.config
    r = requests.post(f"{WORKER}/token", json={"token": cfg["sdk_token"], "base": cfg["base_url"]},
                      headers={"X-Push-Secret": kc("QUOTE_PUSH_SECRET")}, timeout=20)
    print(f"[{datetime.now(TW):%F %T}] 推送 token → HTTP {r.status_code} {r.text[:100]}")
    sys.exit(0 if r.ok else 1)


if __name__ == "__main__":
    main()
