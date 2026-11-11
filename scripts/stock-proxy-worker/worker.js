/* Cloudflare Worker — stock-proxy（網站與每日同步共用的資料代理）
 *
 * 用法：GET https://stock-proxy.tzuchun11232004.workers.dev/?url=<encodeURIComponent(目標網址)>
 *
 * 2026-11-11 改版（原版只在 Cloudflare 後台、會幫任何人轉發任何網址）：
 *   1. 只轉發 ALLOWED_HOSTS 內的網域，其餘 403——避免被當成公開跳板、用掉額度或害 IP 被封。
 *   2. FinMind token 改存在 Worker secret（FINMIND_TOKEN），不再寫在網頁程式裡：
 *      - 網址已自帶 token（每日同步／報告用 GitHub secret 帶入）→ 原樣轉發
 *      - 沒帶 token、且來自本站網頁（Origin 在 ALLOWED_ORIGINS）→ 由 Worker 補上
 *      - 其他來源不補 token（照 FinMind 匿名額度）
 *      限制：Origin 標頭非瀏覽器可以偽造，這只能擋掉一般盜用，擋不住刻意的人。
 *
 * secret：npx wrangler secret put FINMIND_TOKEN
 */

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'api.finmindtrade.com',
  'www.twse.com.tw',
  'openapi.twse.com.tw',
  'www.tpex.org.tw',
  'www.taifex.com.tw',
  'openapi.taifex.com.tw',
  'mopsov.twse.com.tw',
  'mops.twse.com.tw',
]);

const ALLOWED_ORIGINS = new Set([
  'https://chun10124.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
]);

const FINMIND_HOST = 'api.finmindtrade.com';

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const reqUrl = request.url;
    const urlKey = '?url=';
    const urlIndex = reqUrl.indexOf(urlKey);
    if (urlIndex === -1) {
      return new Response('Missing URL', { status: 400, headers: corsHeaders });
    }

    let target;
    try {
      target = new URL(decodeURIComponent(reqUrl.substring(urlIndex + urlKey.length)));
    } catch (_) {
      return new Response('Bad URL', { status: 400, headers: corsHeaders });
    }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
      return new Response('Host not allowed', { status: 403, headers: corsHeaders });
    }

    if (target.hostname === FINMIND_HOST && !target.searchParams.get('token') && env.FINMIND_TOKEN) {
      const origin = request.headers.get('origin') || '';
      if (ALLOWED_ORIGINS.has(origin)) target.searchParams.set('token', env.FINMIND_TOKEN);
    }

    try {
      const response = await fetch(target.toString(), {
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': target.origin + '/',
        },
      });

      // 被重導向就直接報錯，不跟著跳
      if (response.status >= 300 && response.status < 400) {
        return new Response('Blocked by redirect: ' + response.headers.get('location'), { status: 502, headers: corsHeaders });
      }

      const body = await response.arrayBuffer();
      const newResponse = new Response(body, response);
      Object.keys(corsHeaders).forEach((k) => newResponse.headers.set(k, corsHeaders[k]));
      return newResponse;
    } catch (e) {
      return new Response('Fetch Error: ' + e.message, { status: 500, headers: corsHeaders });
    }
  },
};
