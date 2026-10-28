// 账本：访问码、用量、余额、充值记录。
// 运行在一个 Durable Object（SQLite）里，所有请求串行处理，充值和扣费不会互相覆盖。
//
// 三种账号：owner（超管）不充值、不受用户月额度限制；其余两种：
//   beta（内测）：每月额度，按实际成本扣，每月重置，不花钱
//   paid（付费）：余额制，充多少用多少，不重置。加价已经算在「每元对应多少 credits」里，
//                所以扣费仍按实际成本扣 credits，余额换算成人民币显示
//
// 所有金额内部都用 twitterapi.io 的 credits（$1 = 100,000 credits）。

export const CREDITS_PER_TWEET = 15;
export const MIN_CREDITS = 15;
export const PAGE_MAX_CREDITS = CREDITS_PER_TWEET * 20;
export const DEFAULT_MONTHLY_CREDITS = 300000; // 内测默认每月 $3
export const DEFAULT_FX = 7.2;                  // 美元兑人民币
export const DEFAULT_MARKUP = 3;                // 加价倍数
export const DEFAULT_LIMITS = { max_runs_per_week: 7, max_follows: 60 };
const MIN_MS_BETWEEN_SEARCHES = 1000;
// 账号去掉容易看混的 0/O、1/I/L
const ACCOUNT_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,               -- 访问码的 SHA-256，原始访问码不保存
     account_no TEXT NOT NULL UNIQUE,   -- 给用户看的账号，如 DF-7K3QX，充值时备注
     name TEXT NOT NULL,
     plan TEXT NOT NULL,                -- owner | beta | paid
     monthly_credits INTEGER,           -- 仅 beta
     limits TEXT NOT NULL,
     disabled INTEGER NOT NULL DEFAULT 0,
     created TEXT NOT NULL,
     topped_credits INTEGER NOT NULL DEFAULT 0,  -- 仅 paid：累计充值
     spent_credits INTEGER NOT NULL DEFAULT 0    -- 仅 paid：累计扣费
   )`,
  `CREATE TABLE IF NOT EXISTS usage (
     id TEXT NOT NULL, month TEXT NOT NULL,
     credits INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, last_ms INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (id, month)
   )`,
  `CREATE TABLE IF NOT EXISTS topups (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL, at TEXT NOT NULL, cny REAL NOT NULL, credits INTEGER NOT NULL, note TEXT
   )`,
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
];

export function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

export class Ledger {
  // sql: Durable Object 的 ctx.storage.sql，或测试里兼容的实现
  constructor(sql, { now = () => Date.now() } = {}) {
    this.sql = sql;
    this.now = now;
    for (const s of SCHEMA) sql.exec(s);
  }

  rows(q, ...b) { return this.sql.exec(q, ...b).toArray(); }
  row(q, ...b) { return this.rows(q, ...b)[0] || null; }
  month() { return monthKey(new Date(this.now())); }

  // ---- 定价

  price() {
    const get = (k) => (this.row('SELECT value FROM settings WHERE key = ?', k) || {}).value;
    const fx = Number(get('fx')) || DEFAULT_FX;
    const markup = Number(get('markup')) || DEFAULT_MARKUP;
    const perCny = Number(get('credits_per_cny')) || Math.round(100000 / (fx * markup));
    return {
      fx, markup, credits_per_cny: perCny,
      cny_per_full_page: Math.round((PAGE_MAX_CREDITS / perCny) * 10000) / 10000,
      cny_per_1k_tweets: round2(CREDITS_PER_TWEET * 1000 / perCny),
    };
  }

  setPrice({ fx, markup }) {
    fx = Number(fx); markup = Number(markup);
    if (!(fx > 0) || !(markup >= 1)) throw new Error('汇率必须大于 0，加价倍数至少为 1');
    const perCny = Math.round(100000 / (fx * markup));
    for (const [k, v] of [['fx', fx], ['markup', markup], ['credits_per_cny', perCny]]) {
      this.sql.exec('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));
    }
    return this.price();
  }

  // ---- 账号

  newAccountNo() {
    for (;;) {
      const bytes = crypto.getRandomValues(new Uint8Array(5));
      const no = 'DF-' + [...bytes].map((b) => ACCOUNT_ALPHABET[b % ACCOUNT_ALPHABET.length]).join('');
      if (!this.row('SELECT 1 FROM accounts WHERE account_no = ?', no)) return no;
    }
  }

  // 按访问码哈希、账号（DF-XXXXX，大小写和横线都可省）或唯一的名字查找
  find(ref) {
    const r = String(ref || '').trim();
    if (/^[0-9a-f]{64}$/i.test(r)) return this.row('SELECT * FROM accounts WHERE id = ?', r.toLowerCase());
    const m = /^(?:DF-?)?([A-Z0-9]{5})$/i.exec(r);
    if (m) {
      const byNo = this.row('SELECT * FROM accounts WHERE account_no = ?', `DF-${m[1].toUpperCase()}`);
      if (byNo) return byNo;
    }
    const byName = this.rows('SELECT * FROM accounts WHERE name = ?', r);
    if (byName.length > 1) throw new Error(`有 ${byName.length} 个人叫「${r}」，请用账号（DF-…）`);
    return byName[0] || null;
  }

  mustFind(ref) {
    const a = this.find(ref);
    if (!a) throw new Error(`找不到账号：${ref}`);
    return a;
  }

  create({ id, name, plan = 'beta', monthly_credits, limits } = {}) {
    if (!/^[0-9a-f]{64}$/.test(id || '')) throw new Error('无效的 id');
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw new Error('需要名字');
    if (!['owner', 'beta', 'paid'].includes(plan)) throw new Error('用户身份无效');
    const lim = plan === 'owner' ? {} : { ...DEFAULT_LIMITS, ...cleanLimits(limits) };
    const no = this.newAccountNo();
    this.sql.exec(
      'INSERT INTO accounts (id, account_no, name, plan, monthly_credits, limits, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, no, name, plan, plan === 'beta' ? (Number(monthly_credits) || DEFAULT_MONTHLY_CREDITS) : null,
      JSON.stringify(lim), new Date(this.now()).toISOString(),
    );
    return this.view(this.mustFind(id));
  }

  // 仅管理口令保护的创建接口可调用；同一凭证重试不会重复开户或覆盖已有账号。
  createOwner({ id, name = '我的超管' } = {}) {
    const existing = this.find(id);
    if (existing) {
      if (existing.plan !== 'owner') throw new Error('已有用户不能通过创建超管接口升级');
      return this.view(existing);
    }
    return this.create({ id, name, plan: 'owner' });
  }

  // 把旧版（存在 KV 里的）访问码搬进账本，保留本月用量
  importBeta({ id, user, usage }) {
    if (this.find(id)) return this.view(this.find(id));
    const u = user || {};
    const no = this.newAccountNo();
    this.sql.exec(
      'INSERT INTO accounts (id, account_no, name, plan, monthly_credits, limits, disabled, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, no, String(u.name || '未命名').slice(0, 60), 'beta',
      u.monthly_credits != null && Number.isFinite(Number(u.monthly_credits)) ? Math.max(0, Number(u.monthly_credits)) : DEFAULT_MONTHLY_CREDITS,
      JSON.stringify({ ...DEFAULT_LIMITS, ...cleanLimits(u.limits) }), u.disabled ? 1 : 0, u.created || new Date(this.now()).toISOString(),
    );
    if (usage && (usage.credits || usage.requests)) {
      this.sql.exec('INSERT INTO usage (id, month, credits, requests, last_ms) VALUES (?, ?, ?, ?, ?)',
        id, this.month(), Number(usage.credits) || 0, Number(usage.requests) || 0, Number(usage.last) || 0);
    }
    return this.view(this.mustFind(id));
  }

  update(ref, patch = {}) {
    const a = this.mustFind(ref);
    if ('name' in patch) this.sql.exec('UPDATE accounts SET name = ? WHERE id = ?', String(patch.name).slice(0, 60), a.id);
    if ('disabled' in patch) this.sql.exec('UPDATE accounts SET disabled = ? WHERE id = ?', patch.disabled ? 1 : 0, a.id);
    if ('monthly_credits' in patch) this.sql.exec('UPDATE accounts SET monthly_credits = ? WHERE id = ?', Math.max(0, Math.round(Number(patch.monthly_credits) || 0)), a.id);
    if ('limits' in patch) {
      const lim = { ...JSON.parse(a.limits), ...cleanLimits(patch.limits) };
      this.sql.exec('UPDATE accounts SET limits = ? WHERE id = ?', JSON.stringify(lim), a.id);
    }
    if ('plan' in patch) {
      if (a.plan === 'owner') throw new Error('超管账号不能切换为用户套餐');
      if (!['beta', 'paid'].includes(patch.plan)) throw new Error('plan 只能是 beta 或 paid');
      // 改成内测时补上默认月额度
      this.sql.exec('UPDATE accounts SET plan = ?, monthly_credits = COALESCE(monthly_credits, ?) WHERE id = ?',
        patch.plan, DEFAULT_MONTHLY_CREDITS, a.id);
    }
    return this.view(this.mustFind(a.id));
  }

  // ---- 用量与余额

  usageRow(id, month = this.month()) {
    return this.row('SELECT credits, requests, last_ms FROM usage WHERE id = ? AND month = ?', id, month)
      || { credits: 0, requests: 0, last_ms: 0 };
  }

  quota(a) {
    const u = this.usageRow(a.id);
    const isBeta = a.plan === 'beta';
    return {
      month: this.month(),
      used_credits: u.credits,
      used_usd: u.credits / 100000,
      limit_credits: isBeta ? a.monthly_credits : null,
      limit_usd: isBeta ? a.monthly_credits / 100000 : null,
      requests: u.requests,
    };
  }

  balance(a) {
    if (a.plan !== 'paid') return null;
    const { credits_per_cny: perCny } = this.price();
    const credits = a.topped_credits - a.spent_credits;
    return {
      credits,
      cny: round2(credits / perCny),
      topped_cny: round2(a.topped_credits / perCny),
      month_spent_cny: round2(this.usageRow(a.id).credits / perCny),
      credits_per_cny: perCny,
    };
  }

  view(a) {
    return {
      id: a.id, account_no: a.account_no, name: a.name, plan: a.plan, disabled: Boolean(a.disabled),
      created: a.created, monthly_credits: a.monthly_credits, limits: JSON.parse(a.limits),
      quota: this.quota(a), balance: this.balance(a),
    };
  }

  // 给 app 看的状态
  feedbackIdentity(id) {
    const account = this.find(id);
    return account && !account.disabled ? account.id : null;
  }

  status(id) {
    const a = this.find(id);
    if (!a || a.disabled) return { error: a ? 'invalid_code' : 'not_found' };
    const v = this.view(a);
    return { name: v.name, plan: v.plan, account_no: v.account_no, limits: v.limits, quota: v.quota, balance: v.balance };
  }

  // 搜索前检查：访问码是否有效、额度或余额是否够、是否太频繁。通过时占用这一次请求的时间点
  authorize(id) {
    const a = this.find(id);
    if (!a) return { error: 'not_found' };
    if (a.disabled) return { error: 'invalid_code' };
    const u = this.usageRow(a.id);
    const now = this.now();
    if (a.plan === 'beta' && a.monthly_credits - u.credits < PAGE_MAX_CREDITS) {
      return { error: 'quota_exceeded', quota: this.quota(a) };
    }
    // 付费账号只要还有一次最低请求的余额就放行，这一次最多超出一页的费用，记成负数，下次充值补上
    if (a.plan === 'paid' && a.topped_credits - a.spent_credits < MIN_CREDITS) {
      return { error: 'balance_empty', balance: this.balance(a), account_no: a.account_no };
    }
    if (now - u.last_ms < MIN_MS_BETWEEN_SEARCHES) return { error: 'too_frequent' };
    this.sql.exec(
      `INSERT INTO usage (id, month, last_ms) VALUES (?, ?, ?)
       ON CONFLICT(id, month) DO UPDATE SET last_ms = excluded.last_ms`, a.id, this.month(), now);
    return { ok: true, plan: a.plan };
  }

  // 搜索成功后按实际返回条数扣费
  charge(id, credits) {
    const a = this.mustFind(id);
    credits = Math.max(MIN_CREDITS, Math.round(Number(credits) || 0));
    this.sql.exec(
      `INSERT INTO usage (id, month, credits, requests, last_ms) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(id, month) DO UPDATE SET credits = credits + excluded.credits, requests = requests + 1`,
      a.id, this.month(), credits, this.now());
    if (a.plan === 'paid') this.sql.exec('UPDATE accounts SET spent_credits = spent_credits + ? WHERE id = ?', credits, a.id);
    const after = this.mustFind(a.id);
    return { quota: this.quota(after), balance: this.balance(after) };
  }

  // ---- 充值

  topup(ref, cny, note = '') {
    const a = this.mustFind(ref);
    if (a.plan === 'owner') throw new Error('超管账号无需充值');
    if (a.plan !== 'paid') throw new Error(`${a.name}（${a.account_no}）是内测账号，不用充值。要改成付费请先运行 plan ${a.account_no} paid`);
    cny = Number(cny);
    if (!Number.isFinite(cny) || cny === 0 || Math.abs(cny) > 100000) throw new Error('金额无效');
    const { credits_per_cny: perCny } = this.price();
    const credits = Math.round(cny * perCny);
    // 负数用于退款或冲正，但不能把累计充值扣成负数
    if (a.topped_credits + credits < 0) throw new Error('扣回的金额超过了累计充值');
    this.sql.exec('INSERT INTO topups (id, at, cny, credits, note) VALUES (?, ?, ?, ?, ?)',
      a.id, new Date(this.now()).toISOString(), cny, credits, String(note || '').slice(0, 200));
    this.sql.exec('UPDATE accounts SET topped_credits = topped_credits + ? WHERE id = ?', credits, a.id);
    return { account: this.view(this.mustFind(a.id)), cny, credits };
  }

  list() {
    return this.rows('SELECT * FROM accounts ORDER BY created').map((a) => this.view(a));
  }

  history(ref) {
    const a = this.mustFind(ref);
    const { credits_per_cny: perCny } = this.price();
    return {
      account: this.view(a),
      topups: this.rows('SELECT at, cny, credits, note FROM topups WHERE id = ? ORDER BY seq DESC', a.id),
      months: this.rows('SELECT month, credits, requests FROM usage WHERE id = ? ORDER BY month DESC', a.id)
        .map((m) => ({ ...m, usd: m.credits / 100000, cny: round2(m.credits / perCny) })),
    };
  }
}

function cleanLimits(l) {
  const out = {};
  if (!l || typeof l !== 'object') return out;
  if (Number(l.max_runs_per_week) >= 1) out.max_runs_per_week = Math.min(7, Math.round(Number(l.max_runs_per_week)));
  if (Number(l.max_follows) >= 1) out.max_follows = Math.min(500, Math.round(Number(l.max_follows)));
  return out;
}

// 允许通过 Durable Object 调用的方法
export const LEDGER_METHODS = new Set([
  'feedbackIdentity', 'price', 'setPrice', 'create', 'createOwner', 'importBeta', 'update', 'status', 'authorize', 'charge', 'topup', 'list', 'history',
]);
