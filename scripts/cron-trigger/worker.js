/* Cloudflare Worker — 準點觸發 GitHub Actions 的每日排程
 *   daily-sync.yml    每日追蹤表自動同步
 *   daily-report.yml  每日 RS 報告（價格／籌碼）
 *
 * 為什麼要這支：
 *   GitHub 的 on:schedule 是 best-effort 低優先級，實測會被延遲 2~4 小時才真正建立 run
 *   （連凌晨低載時段也照樣延，非挑時間問題）。改用 workflow_dispatch（手動/API 觸發）
 *   不會被降級——本 Worker 的 Cron Trigger 準點呼叫 GitHub API，數秒內開跑。
 *
 * ⚠️ 星期欄用 * 而非 1-5：實測 Cloudflare 的星期欄不是標準的 0=週日，
 *    設 1-5 實際觸發的是週日～週四，週五完全不會跑（7 週零次）。詳見 wrangler.toml。
 *
 * cron(UTC) → 要 dispatch 的 mode：
 *   37 7  * * *    (台灣 15:37)  rsThenPrice        一次 dispatch；workflow 端在同一個 run 內
 *                                先跑 RS 全市場、再跑追蹤表價量，與原 schedule 完全相同。
 *                                ※ 刻意不拆成兩次 dispatch：GitHub 的 concurrency 在新 run 進 pending 時
 *                                  會取消「前一個還在 pending 的 run」，可能誤殺還沒排到 runner 的 RS。
 *   37 12 * * *    (台灣 20:37)  holdingsRevenue    抓三大法人
 *   37 13 * * *    (台灣 21:37)  holdingsRevenue    抓外資持股／營收
 *   30 8  * * *    (台灣 16:30)  daily-report price 價格報告。15:37 那場實測 22~26 分，
 *                                約 16:05 完成，留 25 分餘裕。
 *   0  15 * * *    (台灣 23:00)  daily-report chip  籌碼報告。原為 22:00，2026-09-30 撞 FinMind
 *                                每小時配額（21:37 同步耗用，約 21:40 結束）→ 402；延到 23:00
 *                                離同步結束約 80 分，避開配額時窗。
 *
 * 報告端自帶防呆：交易所回報的最近交易日不等於今日就不產出；資料庫日期對不上
 * 就改寄警告信。所以非交易日觸發是無害的。
 *
 * 需要的 secret（用 npx wrangler secret put 設定）：
 *   GH_PAT       必填。fine-grained PAT，只授權 chun10124/research-website、Actions 讀寫。
 *   TRIGGER_KEY  選填。設了才會開啟手動測試端點；沒設時該端點一律 403。
 */

/**
 * 排程表：UTC「HH:MM」→ 要 dispatch 的工作。workflow 省略時用 env.GH_WORKFLOW（daily-sync.yml）。
 *
 * 2026-10-20 起改成「每分鐘醒一次、查表 dispatch」：Cloudflare 免費方案整個帳號只能有 5 個
 * Cron Trigger，原本 5 個已用滿，加富邦工作只能合併成單一 "* * * * *"。原 5 個工作時間完全不變。
 * 富邦三項（fubon-fetch.yml）都可重複觸發：token 每次重推、closeBars 覆寫同日文件、
 * inst 當日已寫過或尚未公布都會直接結束。
 */
const FUBON = (job) => ({ workflow: "fubon-fetch.yml", inputs: { job } });
const SCHEDULE = {
  // 富邦：推行情 token（台灣 08:50、10:50、12:50；實測 token 3 小時以上仍有效，中午補推當保險）
  "00:50": [FUBON("token")],
  "02:50": [FUBON("token")],
  "04:50": [FUBON("token")],
  // 富邦：全市場收盤 K 棒＋加權指數（台灣 13:36，13:50 補一次；已寫過會自動略過）
  "05:36": [FUBON("closeBars")],
  "05:50": [FUBON("closeBars")],
  // 資料同步
  // 台灣 14:00（原 15:37）：富邦收盤 K 棒 13:36 已寫入；Yahoo 延遲 20 分，14:00 也已有最終收盤
  "06:00": [{ inputs: { mode: "rsThenPrice", limit: "0" } }],
  // 籌碼頁（期貨籌碼表）預算：期交所約 15:00 公布法人與行情；16:00 先跑、18:00 再跑一次補晚公布的部分（18:00 併在下方 10:00）
  "08:00": [{ inputs: { mode: "futuresChips", limit: "0" } }], // 台灣 16:00
  "12:37": [{ inputs: { mode: "holdingsRevenue", limit: "0" } }], // 台灣 20:37
  "13:37": [{ inputs: { mode: "holdingsRevenue", limit: "0" } }], // 台灣 21:37
  // 富邦：追蹤表三大法人（10/20 實測 17:00～17:09 間公布；17:15 起嘗試，公布後第一次寫入，之後自動略過）
  "09:15": [FUBON("inst")],
  // 台灣 17:30：三大法人同步（讀 17:15 富邦寫入的資料）。20:37 那場保留當備援——
  // 17:30 已更新就因新鮮度判斷自動略過、不吃 FinMind；富邦當天失敗則照舊由 FinMind 補
  "09:30": [{ inputs: { mode: "holdingsRevenue", limit: "0" } }],
  "10:00": [FUBON("inst"), { inputs: { mode: "futuresChips", limit: "0" } }], // 富邦法人＋籌碼頁補跑（台灣 18:00）
  "11:00": [FUBON("inst")],
  "11:45": [FUBON("inst")],
  "12:15": [FUBON("inst")],
  // 報告
  "08:30": [{ workflow: "daily-report.yml", inputs: { kind: "price", no_mail: "false", force: "false" } }], // 台灣 16:30
  "15:00": [{ workflow: "daily-report.yml", inputs: { kind: "chip", no_mail: "false", force: "false" } }], // 台灣 23:00
};

const hhmmUtc = (ms) => new Date(ms).toISOString().slice(11, 16);
/** 台北時間週六、日（富邦工作、籌碼頁預算不派；其餘 daily-sync／報告維持每天，由各自的交易日防呆處理） */
const isTaipeiWeekend = (ms) => [0, 6].includes(new Date(ms + 8 * 3600_000).getUTCDay());
/** 週末不派的工作：富邦沒有週末資料；籌碼頁預算非交易日會失敗、每場寄一封失敗信（10/24、10/25 實測），週末期交所也沒有新資料 */
const weekdayOnly = (job) => job.workflow === "fubon-fetch.yml" || job.inputs?.mode === "futuresChips";

/** 打一次 workflow_dispatch；成功回 204 No Content，其餘視為失敗。 */
async function dispatch(env, job) {
  const workflow = job.workflow || env.GH_WORKFLOW;
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${workflow}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GH_PAT}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "research-daily-sync-trigger",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.GH_REF, inputs: job.inputs }),
  });
  if (res.status !== 204) {
    const txt = await res.text().catch(() => "");
    throw new Error(`dispatch ${workflow} ${JSON.stringify(job.inputs)} 失敗：${res.status} ${txt}`);
  }
}

export default {
  /** Cron Trigger 進入點 */
  async scheduled(event, env, ctx) {
    const weekend = isTaipeiWeekend(event.scheduledTime);
    const jobs = (SCHEDULE[hhmmUtc(event.scheduledTime)] || []).filter((j) => !(weekend && weekdayOnly(j)));
    if (!jobs.length) return; // 每分鐘都會醒，大多數時間沒有工作
    ctx.waitUntil(
      Promise.all(
        jobs.map((job) => {
          const label = `${job.workflow || env.GH_WORKFLOW} ${JSON.stringify(job.inputs)}`;
          console.log(`${hhmmUtc(event.scheduledTime)} UTC → dispatch ${label}`);
          return dispatch(env, job).then(
            () => console.log(`✅ 已觸發：${label}`),
            (err) => {
              console.error(`❌ ${err.message}`);
              throw err; // 讓 CF 後台把這次 cron 標記為失敗，方便排查
            },
          );
        }),
      ),
    );
  },

  /** 手動測試端點（選填，需 TRIGGER_KEY）：
   *    GET /health                                  → 健康檢查
   *    GET /?key=<KEY>&mode=DRY                     → 觸發同步（驗證 PAT）
   *    GET /?key=<KEY>&report=price&force=true      → 觸發報告（report=price|chip）
   *    GET /?key=<KEY>&fubon=token                  → 觸發富邦工作（fubon=token|closeBars|inst）
   */
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/health") return new Response("ok\n", { status: 200 });
    if (!env.TRIGGER_KEY || u.searchParams.get("key") !== env.TRIGGER_KEY) {
      return new Response("forbidden\n", { status: 403 });
    }
    const report = u.searchParams.get("report");
    const fubon = u.searchParams.get("fubon");
    const job = fubon
      ? FUBON(fubon)
      : report
      ? {
          workflow: "daily-report.yml",
          inputs: {
            kind: report,
            no_mail: u.searchParams.get("no_mail") === "true" ? "true" : "false",
            force: u.searchParams.get("force") === "true" ? "true" : "false",
          },
        }
      : { inputs: { mode: u.searchParams.get("mode") || "DRY", limit: "0" } };
    try {
      await dispatch(env, job);
      return new Response(`dispatched: ${JSON.stringify(job.inputs)}\n`, { status: 200 });
    } catch (e) {
      return new Response(`error: ${e.message}\n`, { status: 502 });
    }
  },
};
