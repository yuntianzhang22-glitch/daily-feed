// 运行：npm test（用 Electron 自带的 Node 跑，和打包后的运行环境一致）
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store, parseXDate } = require('../desktop/core/store');
const { ConfigFile, migrate, clean, activeDays } = require('../desktop/core/config');
const { FeedClient } = require('../desktop/core/client');
const { followGroups, runOnce, estimateMonthlyCost, cleanUsernames } = require('../desktop/core/fetcher');
const { compareVersions, validateManifest, Updater, currentBundlePath } = require('../desktop/core/updater');
const { nextSlot, prevSlot, weeklyGapsHours, daysFromInterval, describeDays } = require('../desktop/core/schedule');
const { extractPost } = require('../desktop/core/post');

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
  // 最早版本本来就是按周几 + 时间，原样保留
  assert.deepStrictEqual(cfg.schedule_days, [1, 4]);
  assert.strictEqual(cfg.schedule_time, '09:00');
  assert.strictEqual(cfg.max_per_target, 8);
  assert.strictEqual(cfg.version, 3);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!('accounts' in saved) && !('interval_hours' in saved));
  assert.strictEqual(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  // 再次读取不会重复迁移或备份
  new ConfigFile(file).load();
  assert.strictEqual(fs.readdirSync(path.join(dir, 'backups')).length, 1);
});

test('配置：0.2.0 / Python 版的小时间隔迁移成每周几天，其余设置原样保留', () => {
  const cases = [
    [84, [1, 4]], [24, [0, 1, 2, 3, 4, 5, 6]], [6, [0, 1, 2, 3, 4, 5, 6]],
    [168, [1]], [56, [1, 3, 5]], [0, []],
  ];
  for (const [hours, days] of cases) {
    const dir = tmpdir();
    const file = path.join(dir, 'config.json');
    const v2 = { version: 2, follows: ['karpathy', 'naval'], keywords: [], interval_hours: hours, max_per_target: 8, search_mode: 'Latest', avg_posts_per_day: 10 };
    fs.writeFileSync(file, JSON.stringify(v2));
    const cfg = new ConfigFile(file).load();
    assert.deepStrictEqual(cfg.schedule_days, days, `${hours} 小时`);
    assert.strictEqual(cfg.schedule_time, '09:00');
    assert.deepStrictEqual([cfg.follows, cfg.max_per_target, cfg.search_mode, cfg.avg_posts_per_day],
      [v2.follows, 8, 'Latest', 10]);
    assert.ok(!('interval_hours' in cfg));
  }
});

test('配置：损坏的文件不会让应用起不来', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{oops');
  const cfg = new ConfigFile(file).load();
  assert.deepStrictEqual(cfg.follows, []);
  assert.ok(fs.readdirSync(path.join(dir, 'backups'))[0].startsWith('config-corrupt'));
});

test('配置：边界值、非法的天和时间、共用额度下每周最多几天', () => {
  const c = clean({ follows: ['@a', 'bad!', 'A'], schedule_days: [4, 1, 1, 9, -1, '3', 'x'], schedule_time: '25:99', max_per_target: 'abc', search_mode: 'x' });
  assert.deepStrictEqual(c.follows, ['a']);
  assert.deepStrictEqual(c.schedule_days, [1, 3, 4]);
  assert.strictEqual(c.schedule_time, '09:00');
  assert.strictEqual(c.max_per_target, 3);
  assert.strictEqual(c.search_mode, 'Top');
  assert.strictEqual(clean({ schedule_time: '7:5' }).schedule_time, '07:05');
  assert.deepStrictEqual(clean({ schedule_days: [] }).schedule_days, []);
  // 每周最多 3 天：按周一到周日的顺序保留前 3 天
  assert.deepStrictEqual(clean({ schedule_days: [0, 1, 2, 3, 4, 5, 6] }, { max_runs_per_week: 3 }).schedule_days, [1, 2, 3]);
  assert.deepStrictEqual(clean({ schedule_days: [0, 6] }, { max_runs_per_week: 1 }).schedule_days, [6]);
  assert.deepStrictEqual(clean({ schedule_days: [1, 4] }, { max_runs_per_week: 7 }).schedule_days, [1, 4]);
  // 定时抓取总开关：旧配置没有这个字段时视为开启；关闭时保留选好的天和时间
  assert.strictEqual(clean({}).schedule_enabled, true);
  assert.strictEqual(clean({ schedule_enabled: 'no' }).schedule_enabled, true);
  const off = clean({ schedule_enabled: false, schedule_days: [2, 5], schedule_time: '21:30' });
  assert.deepStrictEqual([off.schedule_enabled, off.schedule_days, off.schedule_time], [false, [2, 5], '21:30']);
  assert.deepStrictEqual(activeDays(off), []);
  assert.deepStrictEqual(activeDays({ ...off, schedule_enabled: true }), [2, 5]);
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

test('抓取：付费账号余额不足时停止抓取，提示里带上充值要备注的账号', async () => {
  const s = new Store(path.join(tmpdir(), 't.db'));
  const f = fakeFetch([], { status: 402, body: { code: 'balance_empty', message: 'x', account_no: 'DF-7K3QX', balance: { cny: 0 } } });
  const client = new FeedClient({ mode: 'relay', relayUrl: 'https://r', accessCode: 'c', fetchImpl: f, sleep: async () => {} });
  const errors = [];
  await runOnce(client, s, { follows: ['a', 'b', 'c', 'd', 'e', 'f'], group_size: 2 }, { errors });
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(errors[0].message, '余额不足，请充值（转账时备注账号 DF-7K3QX）');
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

test('费用估算：按每周抓取日计算，间隔不均匀时分别计算', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => `u${i}`);
  const W = 30 / 7;
  const usd = (credits) => Math.round((credits / 100000) * 10000) / 10000;
  // 每天：每组每次 4 人 × 2 条 = 8 条
  const daily = estimateMonthlyCost({ follows: twelve, schedule_days: [0, 1, 2, 3, 4, 5, 6], avg_posts_per_day: 2 });
  assert.strictEqual(daily.runs, 30);
  assert.strictEqual(daily.expected, usd(7 * W * 3 * 8 * 15));
  assert.strictEqual(daily.low, usd(7 * W * 3 * 15));
  assert.strictEqual(daily.high, usd(7 * W * 3 * 20 * 15));
  // 周一、周四：间隔 72 和 96 小时，每组新帖 24 和 32 条，都超过一页 20 条
  const twice = estimateMonthlyCost({ follows: twelve, schedule_days: [1, 4], avg_posts_per_day: 2 });
  assert.strictEqual(twice.runs, 9);
  assert.strictEqual(twice.expected, usd(2 * W * 3 * 20 * 15));
  assert.strictEqual(twice.expected, twice.high);
  // 每人每天 0.5 条时，72 小时 6 条、96 小时 8 条，按实际条数计费
  const quiet = estimateMonthlyCost({ follows: twelve, schedule_days: [1, 4], avg_posts_per_day: 0.5 });
  assert.strictEqual(quiet.expected, usd(W * 3 * (6 + 8) * 15));
  // 不自动抓取
  assert.strictEqual(estimateMonthlyCost({ follows: twelve, schedule_days: [] }).high, 0);
  // 总开关关闭时即使选了天也按 0 估算
  const off = estimateMonthlyCost({ follows: twelve, schedule_enabled: false, schedule_days: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepStrictEqual([off.runs, off.high], [0, 0]);
});

test('抓取计划：下次 / 上次时间点、跨周、恰好整点', () => {
  // 2026-10-19 是周一
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const days = [1, 4];
  assert.strictEqual(fmt(nextSlot(days, '09:00', at(19, 8))), '10/19 09:00');
  assert.strictEqual(fmt(nextSlot(days, '09:00', at(19, 9))), '10/22 09:00');
  assert.strictEqual(fmt(nextSlot(days, '09:00', at(24, 12))), '10/26 09:00');
  assert.strictEqual(fmt(prevSlot(days, '09:00', at(19, 9))), '10/19 09:00');
  assert.strictEqual(fmt(prevSlot(days, '09:00', at(19, 8, 59))), '10/15 09:00');
  assert.strictEqual(fmt(nextSlot([1], '23:55', at(19, 23, 56))), '10/26 23:55');
  assert.strictEqual(fmt(nextSlot([0, 1, 2, 3, 4, 5, 6], '00:00', at(19, 0, 0))), '10/20 00:00');
  assert.strictEqual(nextSlot([], '09:00', at(19, 8)), null);
  assert.deepStrictEqual(weeklyGapsHours([1, 4]), [72, 96]);
  assert.deepStrictEqual(weeklyGapsHours([3]), [168]);
  assert.deepStrictEqual(daysFromInterval(84), [1, 4]);
  assert.strictEqual(describeDays([0, 1, 2, 3, 4, 5, 6]), '每天');
  assert.strictEqual(describeDays([1, 2, 3, 4, 5]), '工作日');
  assert.strictEqual(describeDays([0, 6]), '周末');
  assert.strictEqual(describeDays([0, 3, 1]), '周一、周三、周日');
});

test('帖子内容：引用、图片、链接、emoji 下标、转推、引用嵌套', () => {
  // 正文含 emoji（JS 里占 2 个下标，X 按 1 个码点算），末尾是图片短链和引用短链
  const text = 'Hi 👋 read https://t.co/AAA https://t.co/PIC https://t.co/QQQ';
  const t = {
    id: '1', url: 'https://x.com/a/status/1', text, author: { userName: 'a', name: 'A' },
    displayTextRange: [0, 31],
    entities: { urls: [
      { url: 'https://t.co/AAA', expanded_url: 'https://example.com/post', display_url: 'example.com/post', indices: [10, 26] },
      { url: 'https://t.co/QQQ', expanded_url: 'https://x.com/b/status/2', display_url: 'x.com/b/status/2', indices: [44, 60] },
    ] },
    extendedEntities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/x.jpg', indices: [27, 43], expanded_url: 'https://x.com/a/status/1/photo/1' }] },
    quoted_tweet: {
      id: '2', url: 'https://x.com/b/status/2', text: 'quoted body', author: { userName: 'b', name: 'B' },
      quoted_tweet: { id: '3', url: 'https://x.com/c/status/3', text: 'deeper', author: { userName: 'c' } },
    },
  };
  const v = extractPost(t);
  assert.strictEqual(v.text, 'Hi 👋 read example.com/post');
  assert.deepStrictEqual(v.links, [{ url: 'https://example.com/post', display: 'example.com/post' }]);
  assert.strictEqual(v.media.length, 1);
  assert.strictEqual(v.media[0].type, 'photo');
  assert.strictEqual(v.quoted.author.username, 'b');
  assert.strictEqual(v.quoted.text, 'quoted body');
  // 第二层引用只留跳转链接
  assert.strictEqual(v.quoted.quoted.more, true);
  assert.strictEqual(v.quoted.quoted.url, 'https://x.com/c/status/3');

  // 转推：显示原帖，标明转发人
  const rt = extractPost({ id: '9', text: 'RT @b: x', author: { userName: 'a' }, retweeted_tweet: { id: '2', text: 'original', author: { userName: 'b' }, url: 'https://x.com/b/status/2' } });
  assert.strictEqual(rt.text, 'original');
  assert.strictEqual(rt.retweeted_by.username, 'a');

  // 被删除的引用、非 twimg 的图片地址、损坏的 JSON
  assert.strictEqual(extractPost({ id: '1', text: 'x', author: { userName: 'a' }, quoted_tweet: { unavailable: true } }).quoted.unavailable, true);
  assert.strictEqual(extractPost({ id: '1', text: 'x', author: { userName: 'a' }, extendedEntities: { media: [{ type: 'photo', media_url_https: 'https://evil.example/x.jpg', indices: [0, 0] }] } }).media.length, 0);
  assert.strictEqual(extractPost('{bad'), null);
});

test('帖子媒体：大图地址、视频 mp4 按码率排序、只接受 X 的服务器', () => {
  const v = extractPost({
    id: '1', url: 'https://x.com/a/status/1', text: '', author: { userName: 'a' },
    extendedEntities: { media: [
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/p.jpg', indices: [0, 0] },
      { type: 'video', media_url_https: 'https://pbs.twimg.com/thumb/v.jpg', indices: [0, 0], video_info: { duration_millis: 59893, variants: [
        { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/v/pl/x.m3u8' },
        { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/v/vid/avc1/1280x720/c.mp4?tag=1' },
        { content_type: 'video/mp4', bitrate: 256000, url: 'https://video-s.twimg.com/v/vid/avc1/480x270/a.mp4?tag=1' },
        { content_type: 'video/mp4', bitrate: 832000, url: 'https://evil.example/b.mp4' },
        { content_type: 'video/mp4', bitrate: 950000, url: 'https://video-s.twimg.com/v/vid/avc1/480x852/d.mp4?tag=1' },
      ] } },
      { type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/thumb/g.jpg', indices: [0, 0], video_info: { variants: [
        { content_type: 'video/mp4', bitrate: 0, url: 'https://video.twimg.com/tweet_video/g.mp4' },
      ] } },
    ] },
  });
  const [photo, video, gif] = v.media;
  assert.strictEqual(photo.full, 'https://pbs.twimg.com/media/p.jpg?name=large');
  assert.deepStrictEqual(photo.sources, []);
  assert.strictEqual(video.type, 'video');
  assert.strictEqual(video.duration, 60);
  assert.deepStrictEqual(video.sources.map((s) => [s.bitrate, s.label]), [[256000, '270p'], [950000, '480p'], [2176000, '720p']]);
  assert.strictEqual(gif.type, 'gif');
  assert.strictEqual(gif.sources[0].url, 'https://video.twimg.com/tweet_video/g.mp4');
});

test('真实数据库：每个视频都解析出可播放的 mp4', { skip: !fs.existsSync(path.join(os.homedir(), 'Library/Application Support/Daily Feed/tweets.db')) }, () => {
  const copy = path.join(tmpdir(), 'real.db');
  fs.copyFileSync(path.join(os.homedir(), 'Library/Application Support/Daily Feed/tweets.db'), copy);
  const s = new Store(copy);
  const media = s.list({ limit: 10000 }).flatMap((t) => [...(t.post?.media || []), ...(t.post?.quoted?.media || [])]);
  const videos = media.filter((m) => m.type !== 'photo');
  assert.ok(videos.length > 0);
  assert.ok(videos.every((m) => m.sources.length > 0 && m.sources.every((x) => /^https:\/\/video(-s)?\.twimg\.com\//.test(x.url))));
  assert.ok(media.filter((m) => m.type === 'photo').every((m) => m.full.startsWith('https://pbs.twimg.com/')));
  s.close();
});

test('Store：list 返回解析好的帖子内容', () => {
  const s = new Store(path.join(tmpdir(), 't.db'));
  s.save({ ...tweet(1, 'alice'), quoted_tweet: { id: '2', text: 'ctx', url: 'https://x.com/bob/status/2', author: { userName: 'bob' } } }, 'user:alice', 'now');
  const [t] = s.list();
  assert.strictEqual(t.post.quoted.text, 'ctx');
  assert.strictEqual(t.post.quoted.author.username, 'bob');
  s.close();
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
