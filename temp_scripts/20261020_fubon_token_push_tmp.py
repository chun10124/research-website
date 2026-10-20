"""
登入富邦取得行情 sdk_token，推送到 Cloudflare Worker（research-quote）供網頁即時報價使用。
憑據：鑰匙圈 research-fubon（FUBON_ID / FUBON_API_KEY / QUOTE_PUSH_SECRET）＋ ~/.fubon/cert.p12
由 launchd 於交易日盤前與盤中定時執行（token 效期實測後再決定頻率）。不印出任何 token。
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
    return subprocess.run(["security", "find-generic-password", "-s", "research-fubon", "-a", account, "-w"],
                          capture_output=True, text=True, check=True).stdout.strip()


def main():
    sdk = FubonSDK()
    res = sdk.apikey_login(kc("FUBON_ID"), kc("FUBON_API_KEY"), os.path.expanduser("~/.fubon/cert.p12"))
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
