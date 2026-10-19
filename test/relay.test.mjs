// 中转服务的单元测试：用内存 KV 和假的 twitterapi.io 跑 Worker，不需要 Cloudflare 账号。
import { test } from 'node:test';
import assert from 'node:assert';
import worker from '../relay/src/worker.js';

function memoryKv() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  };
}

function setup(upstream) {
  const env = { ACCESS: memoryKv(), TWITTERAPI_KEY: 'secret-key', ADMIN_TOKEN: 'admin-token-123' };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return upstream(url, init);
  };
  const call = (path, { method = 'GET', body, token } = {}) => worker.fetch(new Request(`https://relay.test${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { env, calls, call };
}

const okUpstream = (n) => async () => new Response(JSON.stringify({
  tweets: Array.from({ length: n }, (_, i) => ({ id: String(i) })), has_next_page: false, next_cursor: '',
}));

async function newCode(call, extra = {}) {
  const r = await call('/admin/codes', { method: 'POST', token: 'admin-token-123', body: { name: '同事A', ...extra } });
  assert.strictEqual(r.status, 200);
  return r.json();
}

test('管理接口需要口令', async () => {
  const { call } = setup(okUpstream(0));
  assert.strictEqual((await call('/admin/codes', { method: 'POST', body: { name: 'x' } })).status, 403);
  assert.strictEqual((await call('/admin/codes', { method: 'POST', token: 'wrong', body: { name: 'x' } })).status, 403);
});

test('访问码：KV 里只存哈希；搜索转发时带 Key，Key 不出现在响应里', async () => {
  const { env, calls, call } = setup(okUpstream(3));
  const { code, id } = await newCode(call);
  assert.match(code, /^df_[A-Za-z0-9]{20,}$/);
  assert.ok(![...env.ACCESS.m.keys()].some((k) => k.includes(code)));
  assert.ok(env.ACCESS.m.has(`code:${id}`));

  const r = await call('/v1/search', { method: 'POST', token: code, body: { query: '((from:naval OR from:paulg) -filter:replies) since_time:1792000000', queryType: 'Top' } });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.tweets.length, 3);
  assert.strictEqual(body.quota.used_credits, 45);
  assert.ok(!JSON.stringify(body).includes('secret-key'));
  assert.strictEqual(calls[0].init.headers['X-API-Key'], 'secret-key');
  assert.match(calls[0].url, /^https:\/\/api\.twitterapi\.io\/twitter\/tweet\/advanced_search\?/);
});

test('无效或停用的访问码被拒绝，且不会调上游', async () => {
  const { calls, call } = setup(okUpstream(1));
  const q = { query: 'from:naval', queryType: 'Top' };
  assert.strictEqual((await call('/v1/search', { method: 'POST', token: 'df_' + 'x'.repeat(24), body: q })).status, 401);
  assert.strictEqual((await call('/v1/search', { method: 'POST', body: q })).status, 401);
  const { code, id } = await newCode(call);
  await call(`/admin/codes/${id}`, { method: 'POST', token: 'admin-token-123', body: { disabled: true } });
  assert.strictEqual((await call('/v1/search', { method: 'POST', token: code, body: q })).status, 401);
  assert.strictEqual(calls.length, 0);
});

test('只允许按关注的人搜索', async () => {
  const { calls, call } = setup(okUpstream(1));
  const { code } = await newCode(call);
  for (const query of ['bitcoin', '', 'from:a'.repeat(200), 'from:a <script>', 'from:a; drop']) {
    const r = await call('/v1/search', { method: 'POST', token: code, body: { query } });
    assert.strictEqual(r.status, 400, query);
  }
  assert.strictEqual(calls.length, 0);
});

test('月度额度用完后拒绝，并返回 quota_exceeded', async () => {
  const { call } = setup(okUpstream(20));
  // 满页 20 条 = 300 credits；额度 500 只够一次，第二次剩 200 不够一次满页
  const { code } = await newCode(call, { monthly_credits: 500 });
  const q = { query: 'from:naval', queryType: 'Top' };
  assert.strictEqual((await call('/v1/search', { method: 'POST', token: code, body: q })).status, 200);
  // 等过最小间隔
  await new Promise((r) => setTimeout(r, 1100));
  const r = await call('/v1/search', { method: 'POST', token: code, body: q });
  assert.strictEqual(r.status, 429);
  assert.strictEqual((await r.json()).code, 'quota_exceeded');
});

test('上游错误不透传原始内容', async () => {
  const { call } = setup(async () => new Response('{"error":"account acct_123 balance low"}', { status: 402 }));
  const { code } = await newCode(call);
  const r = await call('/v1/search', { method: 'POST', token: code, body: { query: 'from:naval' } });
  assert.strictEqual(r.status, 402);
  assert.ok(!(await r.text()).includes('acct_123'));
});

test('核对用户名：区分存在、不存在、停用；非法用户名直接丢弃', async () => {
  const { calls, call } = setup(async (url) => {
    const n = new URL(url).searchParams.get('userName');
    if (n === 'naval') return new Response(JSON.stringify({ status: 'success', data: { userName: 'naval', name: 'Naval', followers: 3000000 } }));
    if (n === 'gone') return new Response(JSON.stringify({ status: 'success', data: { userName: 'gone', unavailable: true, unavailableReason: 'Suspended' } }));
    return new Response(JSON.stringify({ status: 'error', msg: 'user not found' }));
  });
  assert.strictEqual((await call('/admin/lookup-users', { method: 'POST', body: { usernames: ['naval'] } })).status, 403);
  const r = await (await call('/admin/lookup-users', {
    method: 'POST', token: 'admin-token-123', body: { usernames: ['naval', 'nobody', 'gone', 'bad name!'] },
  })).json();
  assert.deepStrictEqual(r.results.map((x) => [x.username, x.found]), [['naval', true], ['nobody', false], ['gone', false]]);
  assert.strictEqual(r.results[0].followers, 3000000);
  assert.strictEqual(r.results[2].unavailable, 'Suspended');
  assert.strictEqual(calls.length, 3);
});

test('状态接口返回额度和限制；发布并读取更新清单与名单', async () => {
  const { call } = setup(okUpstream(0));
  const { code } = await newCode(call, { min_interval_hours: 12, max_follows: 40 });
  const s = await (await call('/v1/status', { token: code })).json();
  assert.strictEqual(s.name, '同事A');
  assert.deepStrictEqual(s.limits, { min_interval_hours: 12, max_follows: 40 });
  assert.strictEqual(s.quota.limit_usd, 3);

  assert.strictEqual((await call('/v1/latest')).status, 404);
  const manifest = { version: '0.2.0', url: 'https://x/a.zip', sha256: 'a'.repeat(64) };
  await call('/admin/publish/latest.json', { method: 'POST', token: 'admin-token-123', body: manifest });
  assert.deepStrictEqual(await (await call('/v1/latest')).json(), manifest);

  const list = await (await call('/admin/codes', { token: 'admin-token-123' })).json();
  assert.strictEqual(list.codes.length, 1);
  assert.ok(!JSON.stringify(list).includes(code));
});
