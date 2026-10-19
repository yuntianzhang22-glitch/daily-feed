// Daily Feed 中转服务（Cloudflare Worker）
//
// - twitterapi.io 的 API Key 只存在这里（Worker Secret: TWITTERAPI_KEY），不进安装包
// - 每个同事一个访问码，存在 KV（ACCESS）里，可单独停用、设月度额度
// - 只放行推文搜索这一个接口，查询内容做格式校验，防止访问码被拿去做别的
// - 同时托管更新清单和内置名单（KV 里的 latest.json / roster.json），供 app 拉取
//
// 管理接口用 ADMIN_TOKEN（Worker Secret）保护，见 relay/admin.mjs。

const TWITTERAPI = 'https://api.twitterapi.io/twitter/tweet/advanced_search';
const CREDITS_PER_TWEET = 15;
const MIN_CREDITS = 15;
const DEFAULT_MONTHLY_CREDITS = 300000; // $3 / 人 / 月
const MIN_SECONDS_BETWEEN_SEARCHES = 1;
const MAX_QUERY_LENGTH = 512;

// 只允许 from:用户名 的组合，加上 Daily Feed 会拼的条件
const QUERY_RE = /^[\w\s():\-"']+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
      if (url.pathname === '/v1/search' && request.method === 'POST') return await search(request, env);
      if (url.pathname === '/v1/status' && request.method === 'GET') return await status(request, env);
      if (url.pathname === '/v1/latest' && request.method === 'GET') return await publicKv(env, 'latest.json');
      if (url.pathname === '/v1/roster' && request.method === 'GET') return await publicKv(env, 'roster.json');
      if (url.pathname.startsWith('/admin/')) return await admin(request, env, url);
      return json({ code: 'not_found', message: 'not found' }, 404);
    } catch (e) {
      return json({ code: 'internal', message: String(e && e.message || e) }, 500);
    }
  },
};

// ------------------------------------------------------------ 访问码

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// KV 里只存访问码的哈希，KV 泄露也拿不到原始访问码
async function authenticate(request, env) {
  const m = /^Bearer\s+(\S{16,128})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const id = await sha256(m[1]);
  const raw = await env.ACCESS.get(`code:${id}`);
  if (!raw) return null;
  const user = JSON.parse(raw);
  if (user.disabled) return null;
  return { id, user };
}

async function getUsage(env, id) {
  const raw = await env.ACCESS.get(`usage:${id}:${monthKey()}`);
  return raw ? JSON.parse(raw) : { credits: 0, requests: 0, last: 0 };
}

function quotaOf(user, usage) {
  const limit = user.monthly_credits ?? DEFAULT_MONTHLY_CREDITS;
  return {
    month: monthKey(),
    used_credits: usage.credits,
    limit_credits: limit,
    used_usd: usage.credits / 100000,
    limit_usd: limit / 100000,
    requests: usage.requests,
  };
}

// ------------------------------------------------------------ 公共接口

async function search(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ code: 'invalid_code', message: '访问码无效或已停用' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ code: 'bad_request', message: 'invalid json' }, 400); }
  const query = String(body.query || '');
  const queryType = body.queryType === 'Latest' ? 'Latest' : 'Top';
  const cursor = typeof body.cursor === 'string' ? body.cursor.slice(0, 2048) : '';
  if (!query || query.length > MAX_QUERY_LENGTH || !QUERY_RE.test(query) || !/from:\w+/.test(query)) {
    return json({ code: 'bad_query', message: '只支持按关注的人搜索' }, 400);
  }

  const usage = await getUsage(env, auth.id);
  const quota = quotaOf(auth.user, usage);
  // 每次请求最多花 20 条 × 15 credits，剩余额度不够一次满页就拒绝，保证不超额
  if (quota.limit_credits - usage.credits < CREDITS_PER_TWEET * 20) {
    return json({ code: 'quota_exceeded', message: '本月额度已用完', quota }, 429);
  }
  const now = Date.now();
  if (now - usage.last < MIN_SECONDS_BETWEEN_SEARCHES * 1000) {
    return json({ code: 'too_frequent', message: '请求太频繁' }, 429);
  }

  const qs = new URLSearchParams({ query, queryType, cursor });
  const upstream = await fetch(`${TWITTERAPI}?${qs}`, {
    headers: { 'X-API-Key': env.TWITTERAPI_KEY, Accept: 'application/json' },
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    // 不把上游的原始错误（可能含账户信息）透传给客户端
    const status = upstream.status === 402 ? 402 : upstream.status === 429 ? 503 : 502;
    return json({ code: 'upstream', message: `上游错误 ${upstream.status}` }, status);
  }
  let data;
  try { data = JSON.parse(text); } catch { return json({ code: 'upstream', message: '上游返回格式错误' }, 502); }
  const tweets = Array.isArray(data.tweets) ? data.tweets : [];
  const cost = Math.max(MIN_CREDITS, CREDITS_PER_TWEET * tweets.length);

  usage.credits += cost;
  usage.requests += 1;
  usage.last = now;
  // KV 写入是最终一致的；几个人的低频使用场景下误差可以忽略
  await env.ACCESS.put(`usage:${auth.id}:${monthKey()}`, JSON.stringify(usage), { expirationTtl: 86400 * 400 });

  return json({
    tweets,
    has_next_page: Boolean(data.has_next_page),
    next_cursor: data.next_cursor || '',
    quota: quotaOf(auth.user, usage),
  });
}

async function status(request, env) {
  const auth = await authenticate(request, env);
  if (!auth) return json({ code: 'invalid_code', message: '访问码无效或已停用' }, 401);
  const usage = await getUsage(env, auth.id);
  return json({ name: auth.user.name, quota: quotaOf(auth.user, usage), limits: auth.user.limits || {} });
}

async function publicKv(env, key) {
  const raw = await env.ACCESS.get(`public:${key}`);
  if (!raw) return json({ code: 'not_found', message: `${key} 未发布` }, 404);
  return new Response(raw, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ------------------------------------------------------------ 管理接口

async function admin(request, env, url) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
  if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    return json({ code: 'forbidden', message: 'forbidden' }, 403);
  }
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

  // 新建访问码：只在创建时返回一次明文
  if (url.pathname === '/admin/codes' && request.method === 'POST') {
    const name = String(body.name || '').slice(0, 60);
    if (!name) return json({ code: 'bad_request', message: 'name required' }, 400);
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const code = 'df_' + btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': 'A', '/': 'B', '=': '' }[c]));
    const id = await sha256(code);
    const user = {
      name,
      created: new Date().toISOString(),
      monthly_credits: Number(body.monthly_credits) || DEFAULT_MONTHLY_CREDITS,
      limits: { min_interval_hours: Number(body.min_interval_hours ?? 6), max_follows: Number(body.max_follows ?? 60) },
      disabled: false,
    };
    await env.ACCESS.put(`code:${id}`, JSON.stringify(user));
    return json({ code, id, user });
  }

  if (url.pathname === '/admin/codes' && request.method === 'GET') {
    const list = await env.ACCESS.list({ prefix: 'code:' });
    const out = [];
    for (const k of list.keys) {
      const id = k.name.slice(5);
      const user = JSON.parse(await env.ACCESS.get(k.name));
      out.push({ id, ...user, usage: await getUsage(env, id) });
    }
    return json({ month: monthKey(), codes: out });
  }

  // 修改或停用：POST /admin/codes/<id> {disabled, monthly_credits, limits}
  const m = /^\/admin\/codes\/([0-9a-f]{64})$/.exec(url.pathname);
  if (m && request.method === 'POST') {
    const raw = await env.ACCESS.get(`code:${m[1]}`);
    if (!raw) return json({ code: 'not_found', message: 'no such code' }, 404);
    const user = { ...JSON.parse(raw) };
    if ('disabled' in body) user.disabled = Boolean(body.disabled);
    if ('monthly_credits' in body) user.monthly_credits = Number(body.monthly_credits);
    if ('limits' in body) user.limits = { ...user.limits, ...body.limits };
    await env.ACCESS.put(`code:${m[1]}`, JSON.stringify(user));
    return json({ id: m[1], user });
  }

  // 核对用户名是否存在：POST /admin/lookup-users {usernames: [...]}，每次最多 40 个
  // （免费版 Worker 每次请求最多 50 个子请求）。每个约 18 credits，记在管理员自己的余额上。
  if (url.pathname === '/admin/lookup-users' && request.method === 'POST') {
    const names = (Array.isArray(body.usernames) ? body.usernames : [])
      .map(String).filter((n) => /^[A-Za-z0-9_]{1,15}$/.test(n)).slice(0, 40);
    const results = [];
    for (const n of names) {
      const r = await fetch(`https://api.twitterapi.io/twitter/user/info?userName=${encodeURIComponent(n)}`, {
        headers: { 'X-API-Key': env.TWITTERAPI_KEY, Accept: 'application/json' },
      });
      const d = await r.json().catch(() => ({}));
      const u = d.data || {};
      results.push({
        username: n,
        found: r.ok && d.status === 'success' && Boolean(u.userName) && !u.unavailable,
        canonical: u.userName || null,
        name: u.name || null,
        followers: u.followers ?? null,
        unavailable: u.unavailable ? (u.unavailableReason || 'unavailable') : null,
        error: r.ok ? (d.status === 'success' ? null : (d.msg || 'not found')) : `http ${r.status}`,
      });
    }
    return json({ results });
  }

  // 发布更新清单 / 名单：POST /admin/publish/latest.json 或 roster.json
  const p = /^\/admin\/publish\/(latest\.json|roster\.json)$/.exec(url.pathname);
  if (p && request.method === 'POST') {
    await env.ACCESS.put(`public:${p[1]}`, JSON.stringify(body));
    return json({ ok: true });
  }

  return json({ code: 'not_found', message: 'not found' }, 404);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
