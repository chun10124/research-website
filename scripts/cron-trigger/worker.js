/* Cloudflare Worker — 準點觸發 GitHub Actions 的每日排程
 *   daily-sync.yml    每日追蹤表自動同步
 *   daily-report.yml  每日 RS 報告（價格／籌碼）
 *
 * 為什麼要這支：
 *   GitHub 的 on:schedule 是 best-effort 低優先級，實測會被延遲 2~4 小時才真正建立 run
 *   （連凌晨低載時段也照樣延，非挑時間問題）。改用 workflow_dispatch（手動/API 觸發）
 *   不會被降級——本 Worker 的 Cron Trigger 準點呼叫 GitHub API，數秒內開跑。
 *
 * cron(UTC) → 要 dispatch 的 mode：
 *   37 7  * * 1-5  (台灣 15:37)  rsThenPrice        一次 dispatch；workflow 端在同一個 run 內
 *                                先跑 RS 全市場、再跑追蹤表價量，與原 schedule 完全相同。
 *                                ※ 刻意不拆成兩次 dispatch：GitHub 的 concurrency 在新 run 進 pending 時
 *                                  會取消「前一個還在 pending 的 run」，可能誤殺還沒排到 runner 的 RS。
 *   37 12 * * 1-5  (台灣 20:37)  holdingsRevenue    抓三大法人
 *   37 13 * * 1-5  (台灣 21:37)  holdingsRevenue    抓外資持股／營收
 *   30 8  * * 1-5  (台灣 16:30)  daily-report price 價格報告。15:37 那場實測 22~26 分，
 *                                約 16:05 完成，留 25 分餘裕。
 *   0  14 * * 1-5  (台灣 22:00)  daily-report chip  籌碼報告。21:37 那場約 21:42 完成。
 *
 * 報告端自帶防呆：交易所回報的最近交易日不等於今日就不產出；資料庫日期對不上
 * 就改寄警告信。所以非交易日觸發是無害的。
 *
 * 需要的 secret（用 npx wrangler secret put 設定）：
 *   GH_PAT       必填。fine-grained PAT，只授權 chun10124/research-website、Actions 讀寫。
 *   TRIGGER_KEY  選填。設了才會開啟手動測試端點；沒設時該端點一律 403。
 */

/** cron(UTC) → { workflow, inputs }。workflow 省略時用 env.GH_WORKFLOW（daily-sync.yml）。 */
const CRON_JOB = {
  // 資料同步
  "37 7 * * 1-5": { inputs: { mode: "rsThenPrice", limit: "0" } }, // 台灣 15:37
  "37 12 * * 1-5": { inputs: { mode: "holdingsRevenue", limit: "0" } }, // 台灣 20:37
  "37 13 * * 1-5": { inputs: { mode: "holdingsRevenue", limit: "0" } }, // 台灣 21:37
  // 報告
  "30 8 * * 1-5": {
    workflow: "daily-report.yml",
    inputs: { kind: "price", no_mail: "false", force: "false" },
  }, // 台灣 16:30
  "0 14 * * 1-5": {
    workflow: "daily-report.yml",
    inputs: { kind: "chip", no_mail: "false", force: "false" },
  }, // 台灣 22:00
};

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
    const job = CRON_JOB[event.cron];
    if (!job) {
      console.log(`未知 cron「${event.cron}」，略過`);
      return;
    }
    const label = `${job.workflow || env.GH_WORKFLOW} ${JSON.stringify(job.inputs)}`;
    console.log(`cron ${event.cron} → dispatch ${label}`);
    ctx.waitUntil(
      dispatch(env, job).then(
        () => console.log(`✅ 已觸發：${label}`),
        (err) => {
          console.error(`❌ ${err.message}`);
          throw err; // 讓 CF 後台把這次 cron 標記為失敗，方便排查
        },
      ),
    );
  },

  /** 手動測試端點（選填，需 TRIGGER_KEY）：
   *    GET /health                                  → 健康檢查
   *    GET /?key=<KEY>&mode=DRY                     → 觸發同步（驗證 PAT）
   *    GET /?key=<KEY>&report=price&force=true      → 觸發報告（report=price|chip）
   */
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/health") return new Response("ok\n", { status: 200 });
    if (!env.TRIGGER_KEY || u.searchParams.get("key") !== env.TRIGGER_KEY) {
      return new Response("forbidden\n", { status: 403 });
    }
    const report = u.searchParams.get("report");
    const job = report
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
