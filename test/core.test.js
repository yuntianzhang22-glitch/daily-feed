// 运行：npm test（用 Electron 自带的 Node 跑，和打包后的运行环境一致）
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store, parseXDate } = require('../desktop/core/store');
const { ConfigFile, migrate, clean } = require('../desktop/core/config');
const { FeedClient } = require('../desktop/core/client');
const { followGroups, runOnce, estimateMonthlyCost, cleanUsernames } = require('../desktop/core/fetcher');
const { compareVersions, validateManifest, Updater, currentBundlePath } = require('../desktop/core/updater');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'df-test-'));

function tweet(id, author, extra = {}) {
  return {
    id: String(id), url: `https://x.com/${author}/status/${id}`, text: `tweet ${id}`,
    createdAt: 'Tue Dec 10 07:00:30 +0000 2024', likeCount: 1, retweetCount: 0, replyCount: 0, viewCount: 10,
    author: { userName: author, name: author.toUpperCase(), profilePicture: 'https://pbs.twimg.com/a.jpg' },
    ...extra,
  };
}

// 模拟 twitterapi.io / 中转服务：按 cursor 返回预设页面，记录请求
function fakeFetch(pages, { status = 200, body } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    let cursor = u.searchParams.get('cursor') || '';
    if (init.body) cursor = JSON.parse(init.body).cursor || '';
    const idx = Number(cursor || 0);
    const payload = body !== undefined ? body : {
      tweets: pages[idx] || [],
      has_next_page: idx + 1 < pages.length,
      next_cursor: idx + 1 < pages.length ? String(idx + 1) : '',
    };
    return new Response(JSON.stringify(payload), { status });
  };
  impl.calls = calls;
  return impl;
}

test('parseXDate 与 Python 版输出一致', () => {
  assert.strictEqual(parseXDate('Tue Dec 10 07:00:30 +0000 2024'), '2024-12-10T07:00:30+00:00');
  assert.strictEqual(parseXDate('Tue Dec 10 07:00:30 +0800 2024'), '2024-12-09T23:00:30+00:00');
  assert.strictEqual(parseXDate('bad'), null);
  assert.strictEqual(parseXDate(undefined), null);
});

test('Store：去重、查询、标记、LIKE 转义、非法排序', () => {
  const s = new Store(path.join(tmpdir(), 't.db'));
  assert.ok(s.save(tweet(1, 'alice'), 'user:alice', 'now'));
  assert.ok(!s.save(tweet(1, 'alice'), 'user:alice', 'now'));
  s.save({ ...tweet(2, 'bob'), text: '100% real_deal' }, 'user:bob', 'now');
  assert.deepStrictEqual(s.list({ q: '0% r' }).map((t) => t.id), ['2']);
  assert.deepStrictEqual(s.list({ q: 'r_al' }), []);
  assert.strictEqual(s.list({ sort: 'id; DROP TABLE tweets' }).length, 2);
  const t = s.list({ source: 'user:alice' })[0];
  assert.strictEqual(t.author_name, 'ALICE');
  assert.strictEqual(t.is_read, false);
  assert.ok(!('raw' in t));
  s.setFlag(['1'], 'starred', true);
  assert.deepStrictEqual(s.counts(), { total: 2, unread: 2, starred: 1 });
  assert.throws(() => s.setFlag(['1'], 'text', 1));
  s.markAllRead('user:bob');
  assert.strictEqual(s.counts().unread, 1);
  s.addUsage(150, '2026-10');
  s.addUsage(50, '2026-10');
  assert.deepStrictEqual(s.usage('2026-10'), { credits: 200, usd: 0.002 });
  s.close();
});

test('Store：能打开旧的、没有已读/收藏列的 Python 版数据库', () => {
  const file = path.join(tmpdir(), 'old.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE tweets (id TEXT PRIMARY KEY, source TEXT NOT NULL, author TEXT, text TEXT, url TEXT,
    created_at TEXT, likes INTEGER, retweets INTEGER, replies INTEGER, views INTEGER, fetched_at TEXT NOT NULL, raw TEXT)`);
  db.exec("INSERT INTO tweets VALUES ('9','user:x',NULL,'old',NULL,NULL,0,0,0,0,'now','{}')");
  db.close();
  const s = new Store(file);
  assert.strictEqual(s.counts().unread, 1);
  s.close();
});

test('真实数据库副本：读得出来，统计一致，不报错', { skip: !fs.existsSync(path.join(os.homedir(), 'Library/Application Support/Daily Feed/tweets.db')) }, () => {
  const src = path.join(os.homedir(), 'Library/Application Support/Daily Feed/tweets.db');
  const copy = path.join(tmpdir(), 'real.db');
  fs.copyFileSync(src, copy);
  const s = new Store(copy);
  const c = s.counts();
  assert.ok(c.total > 0);
  assert.strictEqual(s.list({ limit: 1000 }).length, c.total);
  assert.ok(s.sources().every((r) => r.source.startsWith('user:') || r.source.startsWith('search:')));
  // 已有的抓取进度键能读到，升级后接着抓而不是从头开始
  assert.ok(s.getState('last_run:group:emollick,karpathy,simonw,swyx'));
  s.close();
});

test('配置：Python 版 / 更早格式自动迁移，并先备份', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    accounts: ['OpenAI'],
    keywords: ['(from:naval OR from:paulg) -filter:replies', 'AI agent min_faves:50'],
    schedule_days: [1, 4], schedule_time: '09:00', max_per_target: 8,
  }));
  const cfg = new ConfigFile(file).load();
  assert.deepStrictEqual(cfg.follows, ['OpenAI', 'naval', 'paulg']);
  assert.deepStrictEqual(cfg.keywords, ['AI agent min_faves:50']);
  assert.strictEqual(cfg.interval_hours, 84);
  assert.strictEqual(cfg.max_per_target, 8);
  assert.strictEqual(cfg.version, 2);
  assert.ok(!('schedule_days' in JSON.parse(fs.readFileSync(file, 'utf8'))));
  assert.strictEqual(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  // 再次读取不会重复迁移或备份
  new ConfigFile(file).load();
  assert.strictEqual(fs.readdirSync(path.join(dir, 'backups')).length, 1);
});

test('配置：Python v1 格式（follows + interval_hours，无 version）原样保留', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'config.json');
  const v1 = { follows: ['karpathy', 'naval'], keywords: [], interval_hours: 84, max_per_target: 8, search_mode: 'Top', avg_posts_per_day: 2 };
  fs.writeFileSync(file, JSON.stringify(v1));
  const cfg = new ConfigFile(file).load();
  for (const k of Object.keys(v1)) assert.deepStrictEqual(cfg[k], v1[k], k);
});

test('配置：损坏的文件不会让应用起不来', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{oops');
  const cfg = new ConfigFile(file).load();
  assert.deepStrictEqual(cfg.follows, []);
  assert.ok(fs.readdirSync(path.join(dir, 'backups'))[0].startsWith('config-corrupt'));
});

test('配置：边界值与共用额度下的最短间隔', () => {
  const c = clean({ follows: ['@a', 'bad!', 'A'], interval_hours: '-5', max_per_target: 'abc', search_mode: 'x' });
  assert.deepStrictEqual(c.follows, ['a']);
  assert.strictEqual(c.interval_hours, 0);
  assert.strictEqual(c.max_per_target, 3);
  assert.strictEqual(c.search_mode, 'Top');
  assert.strictEqual(clean({ interval_hours: 1 }, { min_interval_hours: 6 }).interval_hours, 6);
  assert.strictEqual(clean({ interval_hours: 0 }, { min_interval_hours: 6 }).interval_hours, 0);
  assert.strictEqual(clean({ follows: ['a', 'b', 'c'] }, { max_follows: 2 }).follows.length, 2);
});

test('分组与清洗', () => {
  assert.deepStrictEqual(cleanUsernames(['@naval', 'Naval', 'x y', 'a'.repeat(16)]), ['naval']);
  assert.deepStrictEqual(followGroups({ follows: ['a', 'b', 'c'], group_size: 2 }), [['a', 'b'], ['c']]);
});

test('抓取（直连）：按作者归类、按人限额、按返回条数计费、查询格式与 Python 版一致', async () => {
  const s = new Store(path.join(tmpdir(), 't.db'));
  const page = [1, 2, 3, 4, 5].map((i) => tweet(i, 'Naval')).concat([tweet(9, 'paulg')]);
  const f = fakeFetch([page]);
  const client = new FeedClient({ mode: 'direct', apiKey: 'k', fetchImpl: f });
  const results = await runOnce(client, s, { follows: ['naval', 'paulg'], max_per_target: 2, search_mode: 'Top' });
  assert.strictEqual(results['user:naval'].length, 2);
  assert.strictEqual(results['user:paulg'].length, 1);
  const u = new URL(f.calls[0].url);
  assert.strictEqual(u.pathname, '/twitter/tweet/advanced_search');
  assert.match(u.searchParams.get('query'), /^\(\(from:naval OR from:paulg\) -filter:replies\) since_time:\d+$/);
  assert.strictEqual(u.searchParams.get('queryType'), 'Top');
  assert.strictEqual(f.calls[0].init.headers['X-API-Key'], 'k');
  assert.strictEqual(client.creditsUsed, 6 * 15);
  s.close();
});

test('抓取（中转）：带访问码、空结果按最低价计费、记录额度', async () => {
  const s = new Store(path.join(tmpdir(), 't.db'));
  const f = fakeFetch([], { body: { tweets: [], has_next_page: false, next_cursor: '', quota: { used_usd: 0.1, limit_usd: 3 } } });
  const client = new FeedClient({ mode: 'relay', relayUrl: 'https://relay.example/', accessCode: 'df_code', fetchImpl: f });
  await runOnce(client, s, { follows: ['naval'] });
  assert.strictEqual(f.calls[0].url, 'https://relay.example/v1/search');
  assert.strictEqual(f.calls[0].init.headers.Authorization, 'Bearer df_code');
  assert.ok(!f.calls[0].url.includes('df_code'));
  assert.strictEqual(client.creditsUsed, 15);
  assert.strictEqual(client.quota.limit_usd, 3);
  s.close();
});

test('抓取：访问码失效时立刻停止，不继续打后面的组', async () => {
  const s = new Store(path.join(tmpdir(), 't.db'));
  const f = fakeFetch([], { status: 401, body: { code: 'invalid_code', message: 'x' } });
  const client = new FeedClient({ mode: 'relay', relayUrl: 'https://r', accessCode: 'c', fetchImpl: f, sleep: async () => {} });
  const errors = [];
  await runOnce(client, s, { follows: ['a', 'b', 'c', 'd', 'e', 'f'], group_size: 2 }, { errors });
  assert.strictEqual(f.calls.length, 1);
  assert.match(errors[0].message, /访问码无效/);
  s.close();
});

test('抓取：5xx 重试后成功，额度用尽不重试', async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? new Response('err', { status: 502 }) : new Response(JSON.stringify({ tweets: [] })));
  const c1 = new FeedClient({ mode: 'direct', apiKey: 'k', fetchImpl: flaky, sleep: async () => {} });
  await c1.searchPage('from:a', 'Top', '');
  assert.strictEqual(n, 3);
  let m = 0;
  const quota = async () => { m++; return new Response(JSON.stringify({ code: 'quota_exceeded' }), { status: 429 }); };
  const c2 = new FeedClient({ mode: 'relay', relayUrl: 'https://r', accessCode: 'c', fetchImpl: quota, sleep: async () => {} });
  await assert.rejects(c2.searchPage('from:a', 'Top', ''), /额度已用完/);
  assert.strictEqual(m, 1);
});

test('费用估算与 Python 版结果一致', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `u${i}`);
  const a = estimateMonthlyCost({ follows: twelve, interval_hours: 84, avg_posts_per_day: 2 });
  assert.deepStrictEqual([a.runs, a.requests, a.tweets, a.low, a.expected, a.high], [9, 26, 514, 0.0039, 0.0771, 0.0771]);
  const b = estimateMonthlyCost({ follows: twelve, interval_hours: 6, avg_posts_per_day: 2 });
  assert.deepStrictEqual([b.runs, b.requests, b.tweets, b.low, b.expected, b.high], [120, 360, 720, 0.054, 0.108, 1.08]);
  assert.strictEqual(estimateMonthlyCost({ follows: twelve, interval_hours: 0 }).high, 0);
});

test('更新：版本比较与清单校验', () => {
  assert.strictEqual(compareVersions('0.2.0', '0.1.9'), 1);
  assert.strictEqual(compareVersions('0.10.0', '0.9.0'), 1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('0.1.0', '0.2.0'), -1);
  const ok = { version: '0.2.0', url: 'https://x/y.zip', sha256: 'a'.repeat(64) };
  assert.ok(validateManifest(ok));
  assert.throws(() => validateManifest({ ...ok, url: 'http://x/y.zip' }), /https/);
  assert.throws(() => validateManifest({ ...ok, sha256: 'abc' }), /校验/);
  assert.throws(() => validateManifest({ ...ok, version: 'v2' }), /版本/);
  assert.strictEqual(currentBundlePath('/Applications/Daily Feed.app/Contents/MacOS/Electron'), '/Applications/Daily Feed.app');
  assert.strictEqual(currentBundlePath('/usr/local/bin/node'), null);
});

test('更新：检查到新版本', async () => {
  const manifest = { version: '0.3.0', notes: '新功能', url: 'https://x/a.zip', sha256: 'b'.repeat(64), size: 10 };
  const u = new Updater({ manifestUrl: 'https://x/latest.json', currentVersion: '0.2.0', fetchImpl: async () => new Response(JSON.stringify(manifest)) });
  const r = await u.check();
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.latest, '0.3.0');
  const same = new Updater({ manifestUrl: 'https://x', currentVersion: '0.3.0', fetchImpl: async () => new Response(JSON.stringify(manifest)) });
  assert.strictEqual((await same.check()).available, false);
});

test('更新：校验值不对的下载会被丢弃', async () => {
  const workDir = tmpdir();
  const u = new Updater({ manifestUrl: 'x', currentVersion: '0.1.0', workDir, fetchImpl: async () => new Response('not the real file') });
  await assert.rejects(u.download({ version: '0.2.0', url: 'https://x/a.zip', sha256: 'c'.repeat(64) }), /校验失败/);
  assert.ok(!fs.existsSync(path.join(workDir, 'update.zip')));
});
