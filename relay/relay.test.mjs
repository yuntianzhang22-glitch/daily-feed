// 中转服务的单元测试：用内存 KV、Node 自带 SQLite 模拟的账本和假的 twitterapi.io 跑 Worker，
// 不需要 Cloudflare 账号。运行：node --import ./relay/test-loader.mjs --test relay/relay.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import worker, { LedgerDO } from './src/worker.js';

function memoryKv() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
  };
}

function fakeSql() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(q, ...b) {
      const stmt = db.prepare(q);
      const rows = /^\s*(SELECT|PRAGMA)/i.test(q) ? stmt.all(...b).map((r) => ({ ...r })) : (stmt.run(...b), []);
      return { toArray: () => rows };
    },
  };
}

// 和 Durable Object 命名空间同样的接口；RPC 调用用 structuredClone 模拟跨对象传值
function ledgerNamespace() {
  const obj = new LedgerDO({ storage: { sql: fakeSql() } }, {});
  return {
    obj,
    idFromName: (n) => n,
    get: () => ({ call: async (method, args) => structuredClone(obj.call(method, structuredClone(args))) }),
  };
}

function setup(upstream) {
  const env = { ACCESS: memoryKv(), LEDGER: ledgerNamespace(), TWITTERAPI_KEY: 'secret-key', ADMIN_TOKEN: 'admin-token-123' };
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
  const admin = async (path, body) => (await call(path, { method: body === undefined ? 'GET' : 'POST', token: 'admin-token-123', body })).json();
  return { env, calls, call, admin };
}

const okUpstream = (n) => async () => new Response(JSON.stringify({
  tweets: Array.from({ length: n }, (_, i) => ({ id: String(i) })), has_next_page: false, next_cursor: '',
}));
const Q = { query: '((from:naval OR from:paulg) -filter:replies) since_time:1792000000', queryType: 'Top' };
const wait = () => new Promise((r) => setTimeout(r, 1100));

async function newCode(call, extra = {}) {
  const r = await call('/admin/codes', { method: 'POST', token: 'admin-token-123', body: { name: '同事A', ...extra } });
  assert.strictEqual(r.status, 200);
  return r.json();
}

test('管理接口需要口令', async () => {
  const { call } = setup(okUpstream(0));
  assert.strictEqual((await call('/admin/codes', { method: 'POST', body: { name: 'x' } })).status, 403);
  assert.strictEqual((await call('/admin/codes', { method: 'POST', token: 'wrong', body: { name: 'x' } })).status, 403);
  assert.strictEqual((await call('/admin/topup', { method: 'POST', token: 'wrong', body: { ref: 'x', cny: 100 } })).status, 403);
});

test('DF 编号可跨设备登录三类账号；不能调用管理接口、篡改身份或绕过停用', async () => {
  const { call, admin } = setup(okUpstream(1));
  // 展示名即使长得像编号，也不能成为另一个登录别名。
  await newCode(call, { name: 'DF-00000' });
  for (const plan of ['owner', 'beta', 'paid']) {
    const account = plan === 'owner'
      ? await admin('/admin/owner', { code: 'df_' + 'number_login_owner_'.repeat(3), name: 'number-owner' })
      : (await newCode(call, { plan, name: 'number-' + plan })).account;
    const number = account.account_no;
    for (const token of [number, number.toLowerCase().replace('-', '')]) {
      const r = await call('/v1/status', { token });
      assert.equal(r.status, 200);
      const s = await r.json();
      assert.equal(s.plan, plan);
      assert.equal(s.account_no, number);
      assert.ok(!('id' in s));
      assert.equal((await call('/admin/codes', { token })).status, 403);
    }
    if (plan === 'paid') await admin('/admin/topup', { ref: number, cny: 10 });
    if (plan !== 'owner') assert.equal((await call('/v1/search', { method: 'POST', token: number,
      body: { query: 'secret keyword', role: 'owner', plan: 'owner' } })).status, 400);
    assert.equal((await call('/v1/search', { method: 'POST', token: number, body: Q })).status, 200);
    const s = await (await call('/v1/status', { token: number })).json();
    assert.equal(s.quota.used_credits, 15);
    await admin('/admin/account', { ref: number, patch: { disabled: true } });
    assert.equal((await call('/v1/status', { token: number })).status, 401);
    assert.equal((await call('/v1/search', { method: 'POST', token: number, body: Q })).status, 401);
  }
  for (const token of ['DF-00000', 'number-owner', 'x'.repeat(64)]) assert.equal((await call('/v1/status', { token })).status, 401);
});

test('独立超管仅管理口令可创建，凭证可在多设备验证，关键词和停用均由服务端校验', async () => {
  const { call, admin, calls } = setup(okUpstream(2));
  const code = 'df_' + 'owner_private_test_'.repeat(3);
  assert.equal((await call('/admin/owner', { method: 'POST', body: { code } })).status, 403);
  const member = await newCode(call);
  assert.equal((await call('/admin/owner', { method: 'POST', token: member.code, body: { code } })).status, 403);
  const owner = await admin('/admin/owner', { code, name: '我的超管' });
  assert.equal(owner.plan, 'owner');
  assert.equal((await admin('/admin/owner', { code })).account_no, owner.account_no);
  for (let device = 0; device < 2; device++) {
    const status = await (await call('/v1/status', { token: code })).json();
    assert.equal(status.plan, 'owner');
    assert.equal(status.account_no, owner.account_no);
    assert.equal(status.balance, null);
    assert.ok(!JSON.stringify(status).includes(code));
    assert.ok(!JSON.stringify(status).includes('secret-key'));
  }
  // 超管登录账号与后台 ADMIN_TOKEN 分离。
  assert.equal((await call('/admin/codes', { token: code })).status, 403);
  const keyword = { query: '人工智能 OR "product design"', plan: 'owner', role: 'owner' };
  assert.equal((await call('/v1/search', { method: 'POST', token: member.code, body: keyword })).status, 400);
  assert.equal(calls.length, 0);
  const result = await call('/v1/search', { method: 'POST', token: code, body: keyword });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).tweets.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.get('query'), keyword.query);
  assert.equal((await call('/admin/account', { method: 'POST', token: 'admin-token-123', body: { ref: member.account.account_no, patch: { plan: 'owner' } } })).status, 400);
  const list = await admin('/admin/codes');
  assert.equal(list.accounts.length, 2);
  assert.ok(!JSON.stringify(list).includes(code));
  await admin('/admin/account', { ref: owner.account_no, patch: { disabled: true } });
  assert.equal((await call('/v1/status', { token: code })).status, 401);
  assert.equal((await call('/v1/search', { method: 'POST', token: code, body: keyword })).status, 401);
});

test('访问码：账本里只存哈希；搜索转发时带 Key，Key 不出现在响应里', async () => {
  const { env, calls, call } = setup(okUpstream(3));
  const { code, account } = await newCode(call);
  assert.match(code, /^df_[A-Za-z0-9]{20,}$/);
  assert.match(account.account_no, /^DF-[A-Z0-9]{5}$/);
  assert.ok(!JSON.stringify(env.LEDGER.obj.ledger.list()).includes(code));

  const r = await call('/v1/search', { method: 'POST', token: code, body: Q });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.tweets.length, 3);
  assert.strictEqual(body.quota.used_credits, 45);
  assert.strictEqual(body.balance, null);
  assert.ok(!JSON.stringify(body).includes('secret-key'));
  assert.strictEqual(calls[0].init.headers['X-API-Key'], 'secret-key');
  assert.match(calls[0].url, /^https:\/\/api\.twitterapi\.io\/twitter\/tweet\/advanced_search\?/);
});

test('无效或停用的访问码被拒绝，且不会调上游', async () => {
  const { calls, call, admin } = setup(okUpstream(1));
  assert.strictEqual((await call('/v1/search', { method: 'POST', token: 'df_' + 'x'.repeat(24), body: Q })).status, 401);
  assert.strictEqual((await call('/v1/search', { method: 'POST', body: Q })).status, 401);
  const { code, account } = await newCode(call);
  await admin('/admin/account', { ref: account.account_no, patch: { disabled: true } });
  assert.strictEqual((await call('/v1/search', { method: 'POST', token: code, body: Q })).status, 401);
  assert.strictEqual((await call('/v1/status', { token: code })).status, 401);
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

test('内测码：月度额度用完后拒绝，并返回 quota_exceeded', async () => {
  const { call } = setup(okUpstream(20));
  // 满页 20 条 = 300 credits；额度 500 只够一次，第二次剩 200 不够一次满页
  const { code } = await newCode(call, { monthly_credits: 500 });
  assert.strictEqual((await call('/v1/search', { method: 'POST', token: code, body: Q })).status, 200);
  await wait();
  const r = await call('/v1/search', { method: 'POST', token: code, body: Q });
  assert.strictEqual(r.status, 429);
  assert.strictEqual((await r.json()).code, 'quota_exceeded');
});

test('付费码：没充值时拒绝并返回账号；充值后可用，按返回条数扣余额', async () => {
  const { calls, call, admin } = setup(okUpstream(20));
  const { code, account } = await newCode(call, { name: '外部用户', plan: 'paid' });
  const r0 = await call('/v1/search', { method: 'POST', token: code, body: Q });
  assert.strictEqual(r0.status, 402);
  const b0 = await r0.json();
  assert.strictEqual(b0.code, 'balance_empty');
  assert.strictEqual(b0.account_no, account.account_no);
  assert.strictEqual(calls.length, 0);

  const t = await admin('/admin/topup', { ref: account.account_no, cny: 10, note: '微信转账' });
  assert.strictEqual(t.account.balance.cny, 10);

  const r1 = await call('/v1/search', { method: 'POST', token: code, body: Q });
  assert.strictEqual(r1.status, 200);
  const b1 = await r1.json();
  assert.strictEqual(b1.balance.credits, t.credits - 300);
  const s = await (await call('/v1/status', { token: code })).json();
  assert.strictEqual(s.plan, 'paid');
  assert.strictEqual(s.account_no, account.account_no);
  assert.strictEqual(s.balance.credits, t.credits - 300);

  const h = await admin('/admin/history', { ref: account.account_no });
  assert.deepStrictEqual(h.topups.map((x) => x.note), ['微信转账']);
  assert.strictEqual(h.months[0].requests, 1);
});

test('上游失败不扣费，也不透传原始错误', async () => {
  const { call, admin } = setup(async () => new Response('{"error":"account acct_123 balance low"}', { status: 402 }));
  const { code, account } = await newCode(call, { plan: 'paid' });
  await admin('/admin/topup', { ref: account.account_no, cny: 1 });
  const before = (await admin('/admin/history', { ref: account.account_no })).account.balance.credits;
  const r = await call('/v1/search', { method: 'POST', token: code, body: Q });
  assert.strictEqual(r.status, 402);
  assert.ok(!(await r.text()).includes('acct_123'));
  assert.strictEqual((await admin('/admin/history', { ref: account.account_no })).account.balance.credits, before);
});

test('管理：给内测账号充值会报错；可改套餐、改价格', async () => {
  const { call, admin } = setup(okUpstream(0));
  const { account } = await newCode(call);
  const bad = await call('/admin/topup', { method: 'POST', token: 'admin-token-123', body: { ref: account.account_no, cny: 10 } });
  assert.strictEqual(bad.status, 400);
  assert.match((await bad.json()).message, /内测账号/);
  const changed = await admin('/admin/account', { ref: account.account_no, patch: { plan: 'paid' } });
  assert.strictEqual(changed.plan, 'paid');
  const price = await admin('/admin/price', { fx: 7, markup: 2 });
  assert.strictEqual(price.markup, 2);
  assert.strictEqual((await admin('/admin/price')).fx, 7);
});

test('旧版 KV 访问码迁移进账本：访问码继续可用，本月用量保留', async () => {
  const { env, call, admin } = setup(okUpstream(1));
  // 模拟旧版存在 KV 里的访问码
  const code = 'df_oldcodeoldcodeoldcode12';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  const id = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  await env.ACCESS.put(`code:${id}`, JSON.stringify({ name: '管理员测试', monthly_credits: 100000, limits: { max_runs_per_week: 7, max_follows: 60 }, disabled: false }));
  await env.ACCESS.put(`usage:${id}:${month}`, JSON.stringify({ credits: 45, requests: 3, last: 0 }));

  assert.strictEqual((await call('/v1/status', { token: code })).status, 200);
  const m = await admin('/admin/migrate-kv', {});
  assert.strictEqual(m.moved.length, 1);
  const s = await (await call('/v1/status', { token: code })).json();
  assert.strictEqual(s.name, '管理员测试');
  assert.strictEqual(s.quota.used_credits, 45);
  // 重复迁移不会重复
  await admin('/admin/migrate-kv', {});
  assert.strictEqual((await admin('/admin/codes')).accounts.length, 1);
});

test('上游地址只能在本地开发时指到 127.0.0.1，其他值一律用 twitterapi.io', async () => {
  for (const [base, expect] of [
    ['http://127.0.0.1:8788', /^http:\/\/127\.0\.0\.1:8788\/twitter\/tweet\/advanced_search\?/],
    ['https://evil.example', /^https:\/\/api\.twitterapi\.io\//],
    ['http://127.0.0.1.evil.example:80', /^https:\/\/api\.twitterapi\.io\//],
    [undefined, /^https:\/\/api\.twitterapi\.io\//],
  ]) {
    const { env, calls, call } = setup(okUpstream(1));
    env.TWITTERAPI_BASE = base;
    const { code } = await newCode(call);
    await call('/v1/search', { method: 'POST', token: code, body: Q });
    assert.match(calls[0].url, expect, String(base));
  }
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

test('状态接口返回额度和限制；发布并读取更新清单与名单；列表里没有访问码明文', async () => {
  const { call, admin } = setup(okUpstream(0));
  const { code } = await newCode(call, { max_runs_per_week: 3, max_follows: 40 });
  const s = await (await call('/v1/status', { token: code })).json();
  assert.strictEqual(s.name, '同事A');
  assert.strictEqual(s.plan, 'beta');
  assert.deepStrictEqual(s.limits, { max_runs_per_week: 3, max_follows: 40 });
  assert.strictEqual(s.quota.limit_usd, 3);

  assert.strictEqual((await call('/v1/latest')).status, 404);
  const manifest = { version: '0.2.0', url: 'https://x/a.zip', sha256: 'a'.repeat(64) };
  await admin('/admin/publish/latest.json', manifest);
  assert.deepStrictEqual(await (await call('/v1/latest')).json(), manifest);

  const list = await admin('/admin/codes');
  assert.strictEqual(list.accounts.length, 1);
  assert.ok(list.price.credits_per_cny > 0);
  assert.ok(!JSON.stringify(list).includes(code));
});

test('翻译仅允许有效账号，三类账号同权限，不依赖抓取余额或客户端角色', async () => {
  const { call, admin, env } = setup(okUpstream(0));
  let calls = 0;
  env.TRANSLATION = { idFromName: (n) => n, get: () => ({ translate: async (account, body) => {
    calls++; assert.match(account, /^DF-/); assert.deepEqual(Object.keys(body), ['texts']);
    return { ok: true, texts: ['你好'], cached: false };
  } }) };
  assert.equal((await call('/v1/translate', { method: 'POST', body: { texts: ['hello'] } })).status, 401);
  assert.equal(calls, 0);
  for (const plan of ['owner', 'beta', 'paid']) {
    const created = await newCode(call, { name: '翻译测试', plan });
    const token = created.account.account_no;
    const r = await call('/v1/translate', { method: 'POST', token, body: { texts: ['hello'], role: 'owner', to: 'fr' } });
    assert.equal(r.status, 200); assert.equal(r.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual((await r.json()).texts, ['你好']);
    assert.equal((await call('/v1/translate', { method: 'POST', token, body: { texts: ['a'.repeat(16001)] } })).status, 400);
    await admin('/admin/account', { ref: token, patch: { disabled: true } });
    assert.equal((await call('/v1/translate', { method: 'POST', token, body: { texts: ['hello'] } })).status, 401);
  }
  assert.equal(calls, 3);
});
