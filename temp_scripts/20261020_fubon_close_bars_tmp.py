"""
收盤後在 Mac 執行：富邦全市場收盤 K 棒 → Firestore ibdRsMeta/fubonCloseBars_YYYYMMDD
供每日 RS 同步優先使用（缺檔或不適用時同步自動退回 Yahoo）。

抓取（約 5 次請求）：
  - snapshot/quotes TSE、OTC（ALLBUT0999）→ 今日 開高低收量（tradeVolume 單位＝張）
  - corporate-actions/dividends 近 15 天 → 有配股（stockDividendShares>0）的股票
  - corporate-actions/capital-changes 近 15 天 → 減資／增資等股本變動的股票
  - historical/candles IX0001 近 40 天 → 交易日序列（判斷同步端既有歷史是否連續）
  - historical/candles IX0001 近 3 年 + 盤後報價 → ibdRsMeta/fubonIndexDaily（前端加權指數）
配股、股本變動的股票同步端改走 Yahoo 全段重抓（Yahoo 會追溯調整歷史，富邦快照只有今日一根）。

用法：
  互動：temp_scripts/20261020_fubon_close_bars_run_tmp.sh            （只存本機，不寫 Firestore）
        temp_scripts/20261020_fubon_close_bars_run_tmp.sh --write    （另寫 Firestore）
  憑據：環境變數 FUBON_ID / FUBON_API_KEY / FUBON_CERT_PATH；
        未設時改讀 macOS 鑰匙圈（服務 research-fubon，帳號 FUBON_ID / FUBON_API_KEY）與 ~/.fubon/cert.p12
輸出：output/fubon_close_bars/YYYYMMDD.json（每日獨立檔，不覆蓋舊日）
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from fubon_neo.sdk import FubonSDK

TW = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "output" / "fubon_close_bars"
FIREBASE_PROJECT = "my-tools-1228"
FIREBASE_API_KEY = "AIzaSyAUDHCT_dtMHQFPcUh6-gFSIFXT6dR9MVg"  # 前端公開 web key，權限由 Firestore 規則把關
SCHEMA_VERSION = 2


def log(msg):
    print(f"[{datetime.now(TW):%H:%M:%S}] {msg}", flush=True)


def keychain(account):
    try:
        return subprocess.run(["security", "find-generic-password", "-s", "research-fubon", "-a", account, "-w"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except subprocess.CalledProcessError:
        return None


def credentials():
    pid = os.environ.get("FUBON_ID") or keychain("FUBON_ID")
    key = os.environ.get("FUBON_API_KEY") or keychain("FUBON_API_KEY")
    cert = os.environ.get("FUBON_CERT_PATH") or str(Path.home() / ".fubon" / "cert.p12")
    if not (pid and key):
        sys.exit("缺少 FUBON_ID / FUBON_API_KEY（環境變數或鑰匙圈 research-fubon）")
    if not Path(cert).is_file():
        sys.exit(f"找不到憑證檔：{cert}")
    return pid, key, cert


def num(v):
    return v if isinstance(v, (int, float)) and v == v else None


def firestore_put(doc_id, payload, date_s, schema):
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    url = (f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}/databases/(default)/documents/"
           f"ibdRsMeta/{doc_id}?key={FIREBASE_API_KEY}")
    fields = {"json": {"stringValue": body}, "date": {"stringValue": date_s},
              "schema": {"integerValue": str(schema)},
              "updatedAt": {"integerValue": str(int(datetime.now(TW).timestamp() * 1000))}}
    r = requests.patch(url, json={"fields": fields}, timeout=30)
    if not r.ok:
        sys.exit(f"Firestore 寫入 {doc_id} 失敗 HTTP {r.status_code}: {r.text[:300]}")
    log(f"已寫入 Firestore ibdRsMeta/{doc_id}（{len(body)/1024:.0f} KB）")


def already_written(today_s):
    url = (f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT}/databases/(default)/documents/"
           f"ibdRsMeta/fubonCloseBars_{today_s.replace('-', '')}")
    return requests.get(url, params={"key": FIREBASE_API_KEY, "mask.fieldPaths": "date"}, timeout=20).status_code == 200


def main():
    write = "--write" in sys.argv
    today = datetime.now(TW).date()
    today_s = today.isoformat()
    if write and already_written(today_s):
        log("今日收盤 K 棒已寫入過，略過")
        return

    pid, key, cert = credentials()
    sdk = FubonSDK()
    res = sdk.apikey_login(pid, key, cert)
    del pid, key
    if not getattr(res, "is_success", False):
        sys.exit(f"富邦登入失敗：{getattr(res, 'message', None)}")
    sdk.init_realtime()
    stock = sdk.marketdata.rest_client.stock
    log("富邦登入完成")

    # 1. 全市場快照
    bars, snap_meta = {}, {}
    for mkt in ("TSE", "OTC"):
        d = stock.snapshot.quotes(market=mkt, type="ALLBUT0999")
        snap_date = d.get("date")
        snap_meta[mkt] = {"date": snap_date, "time": d.get("time"), "count": len(d.get("data", []))}
        if snap_date != today_s:
            log(f"{mkt} 快照日期 {snap_date} ≠ 今日 {today_s}（非交易日或尚未更新），不輸出")
            sys.exit(0)
        for r in d.get("data", []):
            if r.get("isTrial"):
                continue
            o, h, l, c = (num(r.get(k)) for k in ("openPrice", "highPrice", "lowPrice", "closePrice"))
            v = num(r.get("tradeVolume"))
            chg = num(r.get("change"))
            if not c or c <= 0:
                continue  # 今日無成交（暫停交易等）→ 同步端退回 Yahoo
            # 第 6 欄：昨收（close − change；快照 change 對昨收、非除權參考價），同步端用來核對既有歷史
            prev = round(c - chg, 4) if chg is not None else None
            bars[r["symbol"]] = [o, h, l, c, v, prev]
    log(f"快照：上市 {snap_meta['TSE']['count']}、上櫃 {snap_meta['OTC']['count']}，有效收盤 {len(bars)} 檔"
        f"（資料時間 {snap_meta['TSE']['time']}）")

    # 2. 除權（配股）與股本變動 → 同步端改走 Yahoo
    since = (today - timedelta(days=15)).isoformat()
    events = {}
    dv = stock.corporate_actions.dividends(start_date=since, end_date=today_s).get("data", [])
    # 富邦 stockDividendShares 常缺（2890 等「權」事件配股欄為 0）→ 只要類型含「權」就列入
    for e in dv:
        if (e.get("stockDividendShares") or 0) > 0 or "權" in (e.get("dividendType") or ""):
            events.setdefault(e["symbol"], []).append({"date": e["date"][:10], "type": e.get("dividendType"),
                                                       "per1000": e.get("stockDividendShares")})
    try:
        cc = stock.corporate_actions.capital_changes(start_date=since, end_date=today_s).get("data", [])
    except Exception as ex:
        log(f"⚠️ capital-changes 失敗（{type(ex).__name__}: {ex}），改列入 warnings")
        cc = None
    for e in cc or []:
        sym = e.get("symbol")
        if sym:
            events.setdefault(sym, []).append({"date": str(e.get("date", ""))[:10], "type": "capitalChange"})
    log(f"近 15 天除權 {sum(1 for v in events.values() if any(x['type'] != 'capitalChange' for x in v))} 檔、"
        f"股本變動 {len(cc or [])} 筆")

    # 3. 交易日序列（IX0001 日 K 16:30 才更新今日，故今日以快照日期補上）
    ix = stock.historical.candles(symbol="IX0001", **{"from": (today - timedelta(days=40)).isoformat(),
                                                      "to": today_s}, timeframe="D", sort="asc")
    trading_days = sorted({row["date"][:10] for row in ix.get("data", [])} | {today_s})

    payload = {
        "schema": SCHEMA_VERSION,
        "date": today_s,
        "generatedAt": datetime.now(TW).isoformat(),
        "source": "fubon-snapshot",
        "volumeUnit": "lots",
        "snapshot": snap_meta,
        "tradingDays": trading_days[-25:],
        "eventSymbols": events,
        "capitalChangesOk": cc is not None,
        "bars": bars,  # symbol → [open, high, low, close, volumeLots, prevClose]
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{today_s.replace('-', '')}.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    log(f"本機已存：{out.relative_to(ROOT)}（{out.stat().st_size/1024:.0f} KB）")

    # 4. 加權指數日收盤（前端 ^TWII 改讀這份；圖表最多回溯約 930 天 → 抓 3 個一年區段）
    index_closes, index_highs, index_lows = {}, {}, {}  # 高低點給籌碼頁的波段回測
    try:
        for k in range(3):
            end = today - timedelta(days=365 * k)
            start = end - timedelta(days=364)
            rows = stock.historical.candles(symbol="IX0001", **{"from": start.isoformat(), "to": end.isoformat()},
                                            timeframe="D", sort="asc").get("data", [])
            for row in rows:
                index_closes[row["date"][:10]] = row["close"]
                if num(row.get("high")) and num(row.get("low")):
                    index_highs[row["date"][:10]] = row["high"]
                    index_lows[row["date"][:10]] = row["low"]
        q = stock.intraday.quote(symbol="IX0001")  # 日 K 16:30 才有今日 → 以盤後報價補今日收盤
        if q.get("date") == today_s and num(q.get("closePrice")) and datetime.now(TW).strftime("%H%M") >= "1335":
            index_closes.setdefault(today_s, q["closePrice"])
            if num(q.get("highPrice")) and num(q.get("lowPrice")):
                index_highs.setdefault(today_s, q["highPrice"])
                index_lows.setdefault(today_s, q["lowPrice"])
        index_payload = {"schema": 1, "symbol": "IX0001", "through": max(index_closes),
                         "start": min(index_closes), "generatedAt": datetime.now(TW).isoformat(),
                         "closes": dict(sorted(index_closes.items())),
                         "highs": dict(sorted(index_highs.items())), "lows": dict(sorted(index_lows.items()))}
        (OUT_DIR / f"index_{today_s.replace('-', '')}.json").write_text(
            json.dumps(index_payload, ensure_ascii=False, separators=(",", ":")))
        log(f"加權指數 {len(index_closes)} 天（{index_payload['start']} ~ {index_payload['through']}）")
    except Exception as ex:
        log(f"⚠️ 加權指數抓取失敗（{type(ex).__name__}: {ex}），本次不更新指數文件")
        index_payload = None

    if write:
        firestore_put(f"fubonCloseBars_{today_s.replace('-', '')}", payload, today_s, SCHEMA_VERSION)
        if index_payload:
            firestore_put("fubonIndexDaily", index_payload, index_payload["through"], 1)
    else:
        log("未加 --write，未寫入 Firestore")

    try:
        sdk.logout()
    except Exception:
        pass


if __name__ == "__main__":
    main()
