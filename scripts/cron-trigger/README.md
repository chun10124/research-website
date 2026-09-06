# cron-trigger — 準點觸發每日同步

## 這是什麼 / 為什麼

GitHub 的 `on: schedule` 觸發會被嚴重延遲。實測 06/22~06/23 五場排程，**排隊 0 秒、腳本只跑 2~24 分，但「排程觸發」本身就被延了 2~4.5 小時**——原訂台灣 15:37 的 RS，GitHub 拖到 18:48 才建立 run。連凌晨低載時段的場次也照樣延，所以不是挑時間的問題，是 GitHub 對排程事件的系統性降級，改 cron 時間或多加 cron 都沒用。

唯一可靠解：用一個**準點**的外部排程器去打 `workflow_dispatch`（手動/API 觸發不被降級，數秒內開跑）。這支 Cloudflare Worker 就是那個鬧鐘，token 存在你自己的 CF 帳號下。

對應關係（與原本完全一致，只是改成準點）：

| Cron (UTC)       | 台灣時間 | dispatch 的 mode   | 抓什麼               |
| ---------------- | -------- | ------------------ | -------------------- |
| `37 7 * * 1-5`   | 15:37    | `rsThenPrice`      | RS 全市場 + 追蹤表價量 |
| `37 12 * * 1-5`  | 20:37    | `holdingsRevenue`  | 三大法人             |
| `37 13 * * 1-5`  | 21:37    | `holdingsRevenue`  | 外資持股／營收        |

> 15:37 場用單一 mode `rsThenPrice`，由 workflow 在**同一個 run** 內先跑 rs、再跑 priceVolume（與原 schedule 相同）。
> 刻意**不**拆成兩次 dispatch：GitHub 的 `concurrency` 在新 run 進 pending 時會取消「前一個還在 pending 的 run」，
> 若 rs 還沒排到 runner 就送出 priceVolume，可能把 rs 誤殺。合成單一 mode 可完全避開這個 race。

## 一次性設定

### 1. 開一把 fine-grained PAT（權限給到最小）

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token：

- **Resource owner**：`chun10124`
- **Repository access**：Only select repositories → 勾 `research-website`
- **Permissions** → Repository permissions → **Actions: Read and write**
  （Metadata: Read-only 會自動帶上，不用管）
- Expiration 自己抓，到期前記得換。

複製產生的 token（只會顯示一次）。

### 2. 部署 Worker

在這個資料夾 (`scripts/cron-trigger/`) 下：

```bash
npx wrangler login                 # 用瀏覽器登入你的 Cloudflare 帳號
npx wrangler secret put GH_PAT     # 貼上步驟 1 的 token
npx wrangler deploy
```

部署完，CF 後台 → Workers & Pages → `research-daily-sync-trigger` → Triggers/Settings 應能看到三個 Cron。Cron 由 Cloudflare 準點執行，不需要常開機器。

### 3.（選填）開手動測試端點

想不等到排程就驗證 PAT 通不通，再設一把自訂金鑰：

```bash
npx wrangler secret put TRIGGER_KEY   # 隨便一串只有你知道的字
```

然後：

```bash
# 健康檢查（免金鑰）
curl https://research-daily-sync-trigger.<你的子網域>.workers.dev/health

# 用 DRY 模式實際打一次 workflow_dispatch（只抓 2330 驗證，不寫資料）
curl "https://research-daily-sync-trigger.<你的子網域>.workers.dev/?key=<TRIGGER_KEY>&mode=DRY"
```

觸發報告（不寄信、強制產出，供非交易日測試）：

```bash
curl "https://research-daily-sync-trigger.<你的子網域>.workers.dev/?key=<TRIGGER_KEY>&report=price&no_mail=true&force=true"
```

`report` 可填 `price` 或 `chip`。

沒設 `TRIGGER_KEY` 時，這個端點一律回 403（預設關閉，安全）。

## 驗證有沒有準點

部署後第一個交易日，到 GitHub repo → Actions → 「每日追蹤表自動同步」看 run 的建立時間：應該落在台灣 15:37 / 20:37 / 21:37 的數秒~一兩分內，而不是延後好幾小時。

## 維護

- **改時間**：編輯 `wrangler.toml` 的 `crons`（UTC）與 `worker.js` 的 `CRON_JOB`，
  重新 `npx wrangler deploy`。兩處要同步——只改 cron 不改對應表，該次觸發會被當成
  「未知 cron」略過（log 會寫）。
- **改抓取邏輯**：那是 repo 裡的 `scripts/daily-sync/`，跟這支無關。這支只負責「準時按下按鈕」。
- **PAT 到期**：重跑 `npx wrangler secret put GH_PAT` 換新的即可，不用重部署程式碼。
- **看 log**：`npx wrangler tail` 即時看 cron 觸發紀錄。

## 備註：on:schedule 已移除

`daily-sync.yml` 原本的 `schedule:` 觸發已拿掉，改為只接 `workflow_dispatch`。原因是如果兩邊都留著，GitHub 那組延遲 3 小時的排程每天會「重複」再跑一次 RS、等於對 Yahoo 全市場多打一輪（本專案歷史上對限流敏感）。手動隨時想跑：repo → Actions → 該 workflow → Run workflow。
