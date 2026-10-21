// Daily Feed 中转服务（Cloudflare Worker）
//
// - twitterapi.io 的 API Key 只存在这里（Worker Secret: TWITTERAPI_KEY），不进安装包
// - 每个用户一个私密登录账号：超管、内测（免费月额度）、付费（充值余额）
// - 账号、用量、余额、充值记录都在一个 Durable Object（SQLite）里，扣费和充值不会互相覆盖
// - 普通账号只放行按关注的人搜索；超管另可搜索关键词。查询与身份都在服务端检查
// - 更新清单和内置名单仍放在 KV（ACCESS）里，供 app 拉取
//
// 管理接口用 ADMIN_TOKEN（Worker Secret）保护，见 relay/admin.mjs。

import { DurableObject } from 'cloudflare:workers';
import { Ledger, LEDGER_METHODS, CREDITS_PER_TWEET, MIN_CREDITS, monthKey } from './ledger.js';

const TWITTERAPI_DEFAULT = 'https://api.twitterapi.io';
const MAX_QUERY_LENGTH = 512;

// 本地开发（.dev.vars）可以把上游指到本机的模拟服务；只接受 127.0.0.1，线上始终是 twitterapi.io
function upstreamBase(env) {
  const b = String(env.TWITTERAPI_BASE || '');
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(b) ? b : TWITTERAPI_DEFAULT;
}

// 只允许 from:用户名 的组合，加上 Daily Feed 会拼的条件
const QUERY_RE = /^[\w\s():\-"']+$/;

// ------------------------------------------------------------ 账本（Durable Object）

export class LedgerDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ledger = new Ledger(ctx.storage.sql);
  }

  // 通过 RPC 调用账本方法；Durable Object 一次只处理一个调用，不会出现两笔扣费同时改余额
  call(method, args) {
    if (!LEDGER_METHODS.has(method)) throw new Error(`不允许的方法: ${method}`);
    return this.ledger[method](...(args || []));
  }
}

// 整个服务只用一个账本实例
function ledger(env) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName('main'));
  return { call: (method, ...args) => stub.call(method, args) };
}

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

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 账本里只存访问码的哈希，泄露了也拿不到原始访问码
async function codeId(request) {
  const m = /^Bearer\s+(\S{16,128})$/.exec(request.headers.get('Authorization') || '');
  return m ? sha256(m[1]) : null;
}

const DENIED = {
  invalid_code: [401, '访问码无效或已停用'],
  not_found: [401, '访问码无效或已停用'],
  quota_exceeded: [429, '本月额度已用完'],
  balance_empty: [402, '余额不足，请充值'],
  too_frequent: [429, '请求太频繁'],
};

function denied(r) {
  const [status, message] = DENIED[r.error] || [403, '不允许'];
  return json({ code: r.error, message, quota: r.quota, balance: r.balance, account_no: r.account_no }, status);
}

// 老凭证按需迁移，避免部署到批量迁移完成之间出现登录空窗；不覆盖已有账本数据。
async function accountStatus(book, env, id) {
  const current = await book.call('status', id);
  if (current.error !== 'not_found') return current;
  const raw = await env.ACCESS.get(`code:${id}`);
  if (!raw) return current;
  const usage = JSON.parse((await env.ACCESS.get(`usage:${id}:${monthKey()}`)) || 'null');
  await book.call('importBeta', { id, user: JSON.parse(raw), usage });
  return book.call('status', id);
}

// ------------------------------------------------------------ 公共接口

async function search(request, env) {
  const id = await codeId(request);
  if (!id) return json({ code: 'invalid_code', message: '访问码无效或已停用' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ code: 'bad_request', message: 'invalid json' }, 400); }
  const query = String(body.query || '');
  const queryType = body.queryType === 'Latest' ? 'Latest' : 'Top';
  const cursor = typeof body.cursor === 'string' ? body.cursor.slice(0, 2048) : '';
  const book = ledger(env);
  const account = await accountStatus(book, env, id);
  if (account.error) return denied(account);
  // 关键词搜索只向服务端确认的超管开放；请求体中的 role/plan 不参与授权。
  const allowedQuery = account.plan === 'owner'
    ? !/[\u0000-\u001f\u007f]/.test(query)
    : QUERY_RE.test(query) && /from:\w+/.test(query);
  if (!query.trim() || query.length > MAX_QUERY_LENGTH || !allowedQuery) {
    return json({ code: 'bad_query', message: '当前身份不支持此搜索内容' }, 400);
  }
  const auth = await book.call('authorize', id);
  if (!auth.ok) return denied(auth);

  const qs = new URLSearchParams({ query, queryType, cursor });
  const upstream = await fetch(`${upstreamBase(env)}/twitter/tweet/advanced_search?${qs}`, {
    headers: { 'X-API-Key': env.TWITTERAPI_KEY, Accept: 'application/json' },
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    // 不把上游的原始错误（可能含账户信息）透传给客户端；上游失败不扣费
    const status = upstream.status === 402 ? 402 : upstream.status === 429 ? 503 : 502;
    return json({ code: 'upstream', message: `上游错误 ${upstream.status}` }, status);
  }
  let data;
  try { data = JSON.parse(text); } catch { return json({ code: 'upstream', message: '上游返回格式错误' }, 502); }
  const tweets = Array.isArray(data.tweets) ? data.tweets : [];
  const after = await book.call('charge', id, Math.max(MIN_CREDITS, CREDITS_PER_TWEET * tweets.length));

  return json({
    tweets,
    has_next_page: Boolean(data.has_next_page),
    next_cursor: data.next_cursor || '',
    quota: after.quota,
    balance: after.balance,
  });
}

async function status(request, env) {
  const id = await codeId(request);
  if (!id) return json({ code: 'invalid_code', message: '访问码无效或已停用' }, 401);
  const s = await accountStatus(ledger(env), env, id);
  if (s.error) return denied(s);
  return json(s);
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
  const book = ledger(env);
  const run = async (fn) => {
    try { return json(await fn()); } catch (e) { return json({ code: 'bad_request', message: e.message }, 400); }
  };

  // 独立超管凭证由管理端预先生成并私下保存。客户端无权自行创建/升级超管。
  if (url.pathname === '/admin/owner' && request.method === 'POST') {
    if (!/^df_[A-Za-z0-9_-]{43,80}$/.test(body.code || '')) return json({ message: '超管登录账号格式无效' }, 400);
    const id = await sha256(body.code);
    return run(() => book.call('createOwner', { id, name: body.name }));
  }

  // 新建访问码：只在创建时返回一次明文
  if (url.pathname === '/admin/codes' && request.method === 'POST') {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const code = 'df_' + btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': 'A', '/': 'B', '=': '' }[c]));
    const id = await sha256(code);
    return run(async () => ({
      code,
      account: await book.call('create', {
        id, name: body.name, plan: body.plan, monthly_credits: body.monthly_credits,
        limits: { max_runs_per_week: body.max_runs_per_week, max_follows: body.max_follows },
      }),
    }));
  }

  if (url.pathname === '/admin/codes' && request.method === 'GET') {
    return run(async () => ({ accounts: await book.call('list'), price: await book.call('price') }));
  }

  // 修改：POST /admin/account {ref, patch}；ref 可以是账号（DF-…）、id 或名字
  if (url.pathname === '/admin/account' && request.method === 'POST') {
    return run(() => book.call('update', body.ref, body.patch || {}));
  }
  if (url.pathname === '/admin/history' && request.method === 'POST') {
    return run(() => book.call('history', body.ref));
  }
  // 充值（负数为退款 / 冲正）：POST /admin/topup {ref, cny, note}
  if (url.pathname === '/admin/topup' && request.method === 'POST') {
    return run(() => book.call('topup', body.ref, body.cny, body.note));
  }
  if (url.pathname === '/admin/price' && request.method === 'POST') {
    return run(() => book.call('setPrice', body));
  }
  if (url.pathname === '/admin/price' && request.method === 'GET') {
    return run(() => book.call('price'));
  }

  // 把旧版存在 KV 里的访问码和本月用量搬进账本（只需运行一次，可重复运行）
  if (url.pathname === '/admin/migrate-kv' && request.method === 'POST') {
    return run(async () => {
      const list = await env.ACCESS.list({ prefix: 'code:' });
      const d = new Date();
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const moved = [];
      for (const k of list.keys) {
        const id = k.name.slice(5);
        const user = JSON.parse(await env.ACCESS.get(k.name));
        const usage = JSON.parse((await env.ACCESS.get(`usage:${id}:${month}`)) || 'null');
        moved.push(await book.call('importBeta', { id, user, usage }));
      }
      return { moved };
    });
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
