// 抓取逻辑和费用估算，从原 Python 版移植，状态键与 Python 版相同，可无缝接着抓。
const { weeklyGapsHours } = require('./schedule');

const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
const PAGE_SIZE = 20;
const CREDITS_PER_TWEET = 15;
const MIN_CREDITS_PER_CALL = 15;
const CREDITS_PER_USD = 100000;

function cleanUsernames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names || []) {
    const n = String(raw).trim().replace(/^@+/, '');
    if (USERNAME_RE.test(n) && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.push(n);
    }
  }
  return out;
}

// 把关注列表切成若干组，每组合成一条 from:a OR from:b 搜索，一次请求覆盖多人
function followGroups(cfg) {
  const names = cleanUsernames(cfg.follows);
  const size = Math.max(1, Number(cfg.group_size) || 4);
  const groups = [];
  for (let i = 0; i < names.length; i += size) groups.push(names.slice(i, i + size));
  return groups;
}

function groupQuery(names, includeReplies) {
  const q = names.map((n) => `from:${n}`).join(' OR ');
  return includeReplies ? q : `(${q}) -filter:replies`;
}

function lookbackSince(cfg, store, stateKey, now) {
  const since = store.getState(stateKey);
  if (since) return Number(since);
  // 首次只回看最近几天，避免 Top 模式拉到很久以前的热帖
  return Math.floor(now / 1000) - (Number(cfg.first_lookback_days) || 4) * 86400;
}

// 一组关注的人：合并搜索，入库时按作者归到 user:xxx，侧栏就能按人分
async function collectFollowGroup(client, store, names, cfg, fetchedAt, now = Date.now()) {
  const stateKey = 'last_run:group:' + names.map((n) => n.toLowerCase()).sort().join(',');
  const since = lookbackSince(cfg, store, stateKey, now);
  const mode = cfg.search_mode === 'Latest' ? 'Latest' : 'Top';
  const cap = Math.max(0, Number(cfg.max_per_target) || 0);
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const results = Object.fromEntries(names.map((n) => [`user:${n}`, []]));
  const query = `(${groupQuery(names, cfg.include_replies)}) since_time:${since}`;
  for await (const page of client.search(query, Number(cfg.max_pages) || 1, mode)) {
    for (const t of page) {
      const author = String((t.author || {}).userName || '').toLowerCase();
      const source = `user:${byLower.get(author) || author}`;
      const bucket = results[source] || (results[source] = []);
      // 上限按人算，避免高产的人把整组名额占满
      if (cap && bucket.length >= cap) continue;
      if (store.save(t, source, fetchedAt)) bucket.push(t);
    }
  }
  store.setState(stateKey, Math.floor(now / 1000));
  return results;
}

// 额外的关键词搜索（高级用法）
async function collectKeyword(client, store, keyword, cfg, fetchedAt, now = Date.now()) {
  const source = `search:${keyword}`;
  const stateKey = `last_run:${source}`;
  const since = lookbackSince(cfg, store, stateKey, now);
  const mode = cfg.search_mode === 'Latest' ? 'Latest' : 'Top';
  const cap = Math.max(0, Number(cfg.max_per_target) || 0);
  const out = [];
  outer:
  for await (const page of client.search(`(${keyword}) since_time:${since}`, Number(cfg.max_pages) || 1, mode)) {
    for (const t of page) {
      if (cap && out.length >= cap) break outer;
      if (store.save(t, source, fetchedAt)) out.push(t);
    }
  }
  store.setState(stateKey, Math.floor(now / 1000));
  return { [source]: out };
}

async function runOnce(client, store, cfg, { log = () => {}, errors = [] } = {}) {
  const fetchedAt = new Date().toISOString();
  const results = {};
  const jobs = [
    ...followGroups(cfg).map((names) => ({ label: names.join(', '), run: () => collectFollowGroup(client, store, names, cfg, fetchedAt) })),
    ...(cfg.keywords || []).filter(Boolean).map((k) => ({ label: k, run: () => collectKeyword(client, store, k, cfg, fetchedAt) })),
  ];
  for (const job of jobs) {
    try {
      const r = await job.run();
      Object.assign(results, r);
      log(`[${job.label}] 新增 ${Object.values(r).reduce((s, v) => s + v.length, 0)} 条`);
    } catch (e) {
      errors.push({ target: job.label, message: e.message });
      // 访问码无效或额度用尽时后面的请求也会失败，直接停
      if (['invalid_code', 'quota_exceeded', 'no_access', 'no_key'].includes(e.code)) break;
    }
  }
  const total = Object.values(results).reduce((s, v) => s + v.length, 0);
  log(`完成，共新增 ${total} 条`);
  return results;
}

// 估算每月费用（美元）。费用取决于接口「返回」了多少条，不是本地保留多少条。
// 每周几天抓，相邻两次的间隔可能不同（周一、周四 → 72 和 96 小时），按每个间隔分别算新帖数。
const WEEKS_PER_MONTH = 30 / 7;

function estimateMonthlyCost(cfg) {
  const groups = followGroups(cfg);
  const people = groups.reduce((s, g) => s + g.length, 0);
  const gaps = weeklyGapsHours(cfg.schedule_days);
  const keywords = (cfg.keywords || []).filter(Boolean).length;
  const empty = { runs: 0, requests: 0, tweets: 0, low: 0, expected: 0, high: 0, people, groups: groups.length, keywords_high: 0 };
  if ((!groups.length && !keywords) || !gaps.length) return empty;
  const runs = gaps.length * WEEKS_PER_MONTH;
  const maxPages = Math.max(1, Number(cfg.max_pages) || 1);
  const avg = Number(cfg.avg_posts_per_day ?? 2);

  const costFor = (perPersonPerDay) => {
    let credits = 0; let tweets = 0; let requests = 0;
    for (const hours of gaps) {
      for (const g of groups) {
        const fresh = Math.min((g.length * perPersonPerDay * hours) / 24, PAGE_SIZE * maxPages);
        const pages = Math.max(1, Math.ceil(fresh / PAGE_SIZE));
        for (let p = 0; p < pages; p++) {
          credits += Math.max(MIN_CREDITS_PER_CALL, CREDITS_PER_TWEET * Math.min(PAGE_SIZE, fresh - p * PAGE_SIZE));
        }
        tweets += fresh;
        requests += pages;
      }
    }
    const k = WEEKS_PER_MONTH;
    return [credits * k, tweets * k, requests * k];
  };
  const [low] = costFor(0);
  const [expected, tweets, requests] = costFor(avg);
  const [high] = costFor(1e6);
  const usd = (c) => Math.round((c / CREDITS_PER_USD) * 10000) / 10000;
  // 额外关键词按每次满页估算上限
  const kwHigh = runs * keywords * maxPages * PAGE_SIZE * CREDITS_PER_TWEET;
  return {
    runs: Math.round(runs), requests: Math.round(requests), tweets: Math.round(tweets),
    low: usd(low), expected: usd(expected), high: usd(high),
    people, groups: groups.length, keywords_high: usd(kwHigh),
  };
}

module.exports = {
  USERNAME_RE, cleanUsernames, followGroups, groupQuery, collectFollowGroup, collectKeyword,
  runOnce, estimateMonthlyCost,
};
