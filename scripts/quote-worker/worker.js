/* Cloudflare Worker — 富邦即時報價中繼
 *
 *   POST /token   Mac 登入富邦後推送行情 sdk_token（標頭 X-Push-Secret＝PUSH_SECRET）
 *   GET  /quotes?ids=2330,2317   網頁查詢；需 Firebase ID token（Authorization: Bearer），
 *                               且 uid 在 ALLOWED_UIDS 內（預設只有擁有者）
 *
 * 不存任何盤中價：每次查詢用 token 打富邦快照（上市＋上櫃各 1 次），於 Worker 記憶體快取
 * QUOTE_CACHE_MS，只回傳要求的代碼。富邦憑證與 API Key 永遠留在 Mac，這裡只有行情 token。
 *
 * 需要：
 *   KV binding  QUOTE_KV           存 token（key: "token" → { token, base, at }）
 *   secret      PUSH_SECRET        Mac 推 token 用的共享密鑰
 *   vars        FIREBASE_PROJECT、ALLOWED_UIDS（逗號分隔）、ALLOWED_ORIGINS（逗號分隔）
 */

const QUOTE_CACHE_MS = 4000;
const MAX_IDS = 300;
const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let snapCache = { at: 0, data: null, promise: null };
let jwkCache = { at: 0, keys: null };

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors } });

function corsHeaders(req, env) {
  const origin = req.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, OPTIONS',
    vary: 'origin',
  };
}

const b64urlToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function googleJwks() {
  if (jwkCache.keys && Date.now() - jwkCache.at < 3600_000) return jwkCache.keys;
  const r = await fetch(JWK_URL);
  if (!r.ok) throw new Error(`jwk ${r.status}`);
  jwkCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return jwkCache.keys;
}

/** 驗證 Firebase ID token（RS256），回傳 uid；失敗回 null */
async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!(payload.exp > now) || !(payload.iat <= now + 300) || !payload.sub) return null;
  const jwk = (await googleJwks()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  return ok ? payload.sub : null;
}

async function fetchSnapshots(env) {
  const tok = await env.QUOTE_KV.get('token', 'json');
  if (!tok?.token || !tok?.base) return { error: 'no-token' };
  const get = async (mkt) => {
    const r = await fetch(`${tok.base}/snapshot/quotes/${mkt}?type=ALLBUT0999`, { headers: { 'X-SDK-TOKEN': tok.token } });
    if (!r.ok) throw Object.assign(new Error(`fubon ${mkt} ${r.status}`), { status: r.status });
    return r.json();
  };
  const [tse, otc] = await Promise.all([get('TSE'), get('OTC')]);
  const map = {};
  for (const d of [tse, otc]) {
    for (const x of d.data || []) {
      map[x.symbol] = {
        price: x.lastPrice ?? x.closePrice ?? null,
        open: x.openPrice ?? null,
        high: x.highPrice ?? null,
        low: x.lowPrice ?? null,
        change: x.change ?? null,
        changePct: x.changePercent ?? null,
        volumeLots: x.tradeVolume ?? null,
        trial: !!x.isTrial,
      };
    }
  }
  return { data: { date: tse.date, time: tse.time, tokenAt: tok.at, map } };
}

async function cachedSnapshots(env) {
  if (snapCache.data && Date.now() - snapCache.at < QUOTE_CACHE_MS) return { data: snapCache.data };
  if (!snapCache.promise) {
    snapCache.promise = fetchSnapshots(env)
      .then((res) => {
        if (res.data) snapCache = { at: Date.now(), data: res.data, promise: null };
        else snapCache.promise = null;
        return res;
      })
      .catch((e) => {
        snapCache.promise = null;
        return { error: e.status === 401 || e.status === 403 ? 'token-expired' : 'fubon-error', detail: e.message };
      });
  }
  return snapCache.promise;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/token' && req.method === 'POST') {
      if (!env.PUSH_SECRET || req.headers.get('x-push-secret') !== env.PUSH_SECRET) return json({ error: 'forbidden' }, 403, {});
      const body = await req.json().catch(() => null);
      if (!body?.token || !/^https:\/\/api\.fugle\.tw\//.test(body.base || '')) return json({ error: 'bad-body' }, 400, {});
      await env.QUOTE_KV.put('token', JSON.stringify({ token: body.token, base: body.base.replace(/\/$/, ''), at: Date.now() }));
      snapCache = { at: 0, data: null, promise: null };
      return json({ ok: true }, 200, {});
    }

    if (url.pathname === '/quotes' && req.method === 'GET') {
      const auth = req.headers.get('authorization') || '';
      const uid = await verifyFirebaseIdToken(auth.replace(/^Bearer\s+/i, ''), env.FIREBASE_PROJECT).catch(() => null);
      const allowed = (env.ALLOWED_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!uid || !allowed.includes(uid)) return json({ error: 'unauthorized' }, 401, cors);
      const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter((s) => /^[0-9A-Z]{4,6}$/.test(s)).slice(0, MAX_IDS);
      const res = await cachedSnapshots(env);
      if (!res.data) return json({ error: res.error }, 503, cors);
      const quotes = {};
      for (const id of ids) if (res.data.map[id]) quotes[id] = res.data.map[id];
      return json({ date: res.data.date, time: res.data.time, tokenAt: res.data.tokenAt, quotes }, 200, cors);
    }

    return json({ error: 'not-found' }, 404, cors);
  },
};
