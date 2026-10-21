// 账本测试：用 Node 自带的 SQLite 模拟 Durable Object 的 ctx.storage.sql，跑真实的账本代码。
// 运行：node --test relay/ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { Ledger, PAGE_MAX_CREDITS } from './src/ledger.js';

// 和 Durable Object 的 sql.exec(query, ...bindings).toArray() 同样的接口
function fakeSql() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(q, ...b) {
      const stmt = db.prepare(q);
      const isRead = /^\s*(SELECT|PRAGMA)/i.test(q);
      const rows = isRead ? stmt.all(...b).map((r) => ({ ...r })) : (stmt.run(...b), []);
      return { toArray: () => rows };
    },
  };
}

const id = (n) => String(n).padStart(64, '0');
let clock = Date.UTC(2026, 9, 20, 12);
const book = () => new Ledger(fakeSql(), { now: () => clock });
const tick = () => { clock += 2000; };

test('定价：默认汇率 7.2、加价 3 倍；可以修改', () => {
  const l = book();
  const p = l.price();
  assert.strictEqual(p.fx, 7.2);
  assert.strictEqual(p.markup, 3);
  assert.strictEqual(p.credits_per_cny, Math.round(100000 / 21.6));
  // 满页 20 条 = 300 credits ≈ ¥0.065
  assert.ok(Math.abs(p.cny_per_full_page - 300 / p.credits_per_cny) < 0.0001);
  assert.strictEqual(l.setPrice({ fx: 7, markup: 2 }).credits_per_cny, Math.round(100000 / 14));
  assert.throws(() => l.setPrice({ fx: 7, markup: 0.5 }), /至少为 1/);
});

test('独立超管：幂等创建、无余额和额度限制、不能升级普通账号或混用套餐', () => {
  const l = book();
  const owner = l.createOwner({ id: id(90), name: '我的超管' });
  assert.equal(owner.plan, 'owner');
  assert.deepEqual(owner.limits, {});
  assert.equal(owner.balance, null);
  assert.equal(owner.quota.limit_credits, null);
  assert.equal(l.createOwner({ id: id(90) }).account_no, owner.account_no);
  l.charge(id(90), 100000000); tick();
  assert.equal(l.authorize(id(90)).ok, true);
  assert.throws(() => l.topup(id(90), 10), /无需充值/);
  assert.throws(() => l.update(id(90), { plan: 'beta' }), /不能切换/);
  l.create({ id: id(91), name: '普通账号' });
  assert.throws(() => l.createOwner({ id: id(91) }), /不能.*升级/);
  assert.throws(() => l.update(id(91), { plan: 'owner' }));
  assert.equal(l.find(id(91)).plan, 'beta');
});

test('账号：生成易读的账号，可按账号、名字、id 查找；重名时要求用账号', () => {
  const l = book();
  const a = l.create({ id: id(1), name: '张三', plan: 'paid' });
  assert.match(a.account_no, /^DF-[2-9A-HJKMNP-Z]{5}$/);
  assert.strictEqual(l.find(a.account_no).id, id(1));
  assert.strictEqual(l.find(a.account_no.slice(3).toLowerCase()).id, id(1));
  assert.strictEqual(l.find('张三').id, id(1));
  l.create({ id: id(2), name: '张三' });
  assert.throws(() => l.find('张三'), /2 个人叫/);
  assert.strictEqual(l.find(id(2)).plan, 'beta');
});

test('内测账号：每月额度，按实际成本扣，余额不显示，不能充值', () => {
  const l = book();
  l.create({ id: id(1), name: '同事', monthly_credits: 1000 });
  assert.ok(l.authorize(id(1)).ok);
  l.charge(id(1), 300); tick();
  l.charge(id(1), 300); tick();
  // 剩 400，还够一次满页（300）
  assert.ok(l.authorize(id(1)).ok);
  l.charge(id(1), 300); tick();
  // 剩 100，不够一次满页
  assert.strictEqual(l.authorize(id(1)).error, 'quota_exceeded');
  assert.strictEqual(l.status(id(1)).balance, null);
  assert.throws(() => l.topup(id(1), 10), /内测账号/);
  // 下个月重置
  clock = Date.UTC(2026, 10, 1, 1);
  assert.ok(l.authorize(id(1)).ok);
});

test('付费账号：先充值，余额按实际成本扣，扣完就停，充值后恢复', () => {
  const l = book();
  const a = l.create({ id: id(1), name: '外部用户', plan: 'paid' });
  assert.strictEqual(l.authorize(id(1)).error, 'balance_empty');
  assert.strictEqual(l.authorize(id(1)).account_no, a.account_no);

  const r = l.topup(a.account_no, 10, '微信转账');
  const perCny = l.price().credits_per_cny;
  assert.strictEqual(r.credits, 10 * perCny);
  assert.strictEqual(r.account.balance.cny, 10);

  tick(); assert.ok(l.authorize(id(1)).ok);
  const after = l.charge(id(1), PAGE_MAX_CREDITS);
  assert.strictEqual(after.balance.credits, 10 * perCny - PAGE_MAX_CREDITS);
  // 充值和花费都有记录
  const h = l.history(a.account_no);
  assert.deepStrictEqual(h.topups.map((t) => [t.cny, t.note]), [[10, '微信转账']]);
  assert.strictEqual(h.months[0].credits, PAGE_MAX_CREDITS);
  assert.strictEqual(h.months[0].requests, 1);

  // 把余额花光
  const left = l.status(id(1)).balance.credits;
  tick(); l.authorize(id(1)); l.charge(id(1), left);
  tick(); assert.strictEqual(l.authorize(id(1)).error, 'balance_empty');
  l.topup(a.account_no, 5);
  tick(); assert.ok(l.authorize(id(1)).ok);
});

test('付费账号：最后一次请求可能略超，余额记成负数，下次充值补上', () => {
  const l = book();
  l.create({ id: id(1), name: 'x', plan: 'paid' });
  l.topup('x', 0.01); // 约 46 credits，够最低一次 15
  tick(); assert.ok(l.authorize(id(1)).ok);
  const after = l.charge(id(1), PAGE_MAX_CREDITS);
  assert.ok(after.balance.credits < 0);
  tick(); assert.strictEqual(l.authorize(id(1)).error, 'balance_empty');
  l.topup('x', 1);
  // 每笔充值各自取整成 credits
  const per = l.price().credits_per_cny;
  assert.strictEqual(l.status(id(1)).balance.credits, Math.round(per * 0.01) + Math.round(per * 1) - PAGE_MAX_CREDITS);
});

test('退款 / 冲正：负数充值，不能扣成负的累计充值', () => {
  const l = book();
  l.create({ id: id(1), name: 'x', plan: 'paid' });
  l.topup('x', 20);
  l.topup('x', -5, '多加了，冲正');
  assert.strictEqual(l.status(id(1)).balance.cny, 15);
  assert.throws(() => l.topup('x', -100), /超过了累计充值/);
  assert.throws(() => l.topup('x', 0), /金额无效/);
  assert.throws(() => l.topup('x', 'abc'), /金额无效/);
});

test('停用、改套餐、限制', () => {
  const l = book();
  const a = l.create({ id: id(1), name: 'x', plan: 'paid', limits: { max_runs_per_week: 3, max_follows: 20 } });
  assert.deepStrictEqual(a.limits, { max_runs_per_week: 3, max_follows: 20 });
  l.update('x', { disabled: true });
  assert.strictEqual(l.authorize(id(1)).error, 'invalid_code');
  assert.strictEqual(l.status(id(1)).error, 'invalid_code');
  l.update('x', { disabled: false, plan: 'beta' });
  const b = l.status(id(1));
  assert.strictEqual(b.plan, 'beta');
  assert.ok(b.quota.limit_credits > 0);
  assert.strictEqual(l.status(id(9)).error, 'not_found');
});

test('同一账号 1 秒内连续请求会被拒绝', () => {
  const l = book();
  l.create({ id: id(1), name: 'x' });
  assert.ok(l.authorize(id(1)).ok);
  assert.strictEqual(l.authorize(id(1)).error, 'too_frequent');
  tick();
  assert.ok(l.authorize(id(1)).ok);
});

test('旧版 KV 访问码导入：保留名字、额度、限制、停用状态和本月用量；重复导入不会重复', () => {
  const l = book();
  const user = { name: '管理员测试', monthly_credits: 100000, limits: { max_runs_per_week: 7, max_follows: 60, min_interval_hours: null }, disabled: false, created: '2026-10-19T00:00:00.000Z' };
  const v = l.importBeta({ id: id(7), user, usage: { credits: 45, requests: 3, last: 1 } });
  assert.strictEqual(v.name, '管理员测试');
  assert.strictEqual(v.plan, 'beta');
  assert.deepStrictEqual(v.limits, { max_runs_per_week: 7, max_follows: 60 });
  assert.strictEqual(v.quota.used_credits, 45);
  assert.strictEqual(v.quota.requests, 3);
  l.importBeta({ id: id(7), user, usage: { credits: 45, requests: 3 } });
  assert.strictEqual(l.list().length, 1);
  const zero = l.importBeta({ id: id(8), user: { ...user, monthly_credits: 0 } });
  assert.strictEqual(zero.monthly_credits, 0);
  assert.strictEqual(l.authorize(id(8)).error, 'quota_exceeded');
  assert.strictEqual(l.status(id(7)).quota.used_credits, 45);
});
