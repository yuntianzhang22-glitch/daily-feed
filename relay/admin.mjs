#!/usr/bin/env node
// 中转服务管理脚本。需要两个环境变量：
//   DAILY_FEED_RELAY        中转地址，如 https://daily-feed-relay.<你的子域>.workers.dev
//   DAILY_FEED_ADMIN_TOKEN  部署时设置的 ADMIN_TOKEN
//
// 用法：
//   node relay/admin.mjs add "同事名字" [每月美元额度=3] [最短间隔小时=6] [最多关注人数=60]
//   node relay/admin.mjs list
//   node relay/admin.mjs disable <id>      停用（离职、泄露时）
//   node relay/admin.mjs enable <id>
//   node relay/admin.mjs quota <id> <每月美元额度>
//   node relay/admin.mjs publish-update dist/latest.json
//   node relay/admin.mjs publish-roster desktop/roster.json
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

// Node 的 fetch 不读 macOS 系统代理。没有 HTTPS_PROXY 时从系统设置里读出来，
// 带上 NODE_USE_ENV_PROXY=1 重新启动自己（这个开关只在进程启动时生效）。
if (!process.env.DAILY_FEED_PROXY_SET) {
  const env = { ...process.env, DAILY_FEED_PROXY_SET: '1', NODE_USE_ENV_PROXY: '1' };
  if (!env.HTTPS_PROXY && !env.https_proxy) {
    try {
      const out = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' });
      const get = (k) => (new RegExp(`${k}\\s*:\\s*(\\S+)`).exec(out) || [])[1];
      if (get('HTTPSEnable') === '1' && get('HTTPSProxy')) {
        env.HTTPS_PROXY = `http://${get('HTTPSProxy')}:${get('HTTPSPort') || 80}`;
      }
    } catch { /* 读不到就直连 */ }
  }
  const r = spawnSync(process.execPath, process.argv.slice(1), { env, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

// 默认从 desktop/app-config.json 读中转地址，从 ~/.daily-feed-admin/admin_token 读管理口令
const readOr = (file, fallback) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return fallback; } };
const appConfig = JSON.parse(readOr(new URL('../desktop/app-config.json', import.meta.url), '{}'));
const base = (process.env.DAILY_FEED_RELAY || appConfig.relayUrl || '').replace(/\/+$/, '');
const token = process.env.DAILY_FEED_ADMIN_TOKEN || readOr(`${process.env.HOME}/.daily-feed-admin/admin_token`, '');
if (!base || !token) {
  console.error('请先设置 DAILY_FEED_RELAY 和 DAILY_FEED_ADMIN_TOKEN');
  process.exit(1);
}

async function call(path, body) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.message || ''}`);
  return data;
}

const [cmd, ...args] = process.argv.slice(2);
const usd = (c) => `$${(c / 100000).toFixed(2)}`;

try {
  if (cmd === 'add') {
    const [name, dollars = '3', minHours = '6', maxFollows = '60'] = args;
    if (!name) throw new Error('需要名字');
    const r = await call('/admin/codes', {
      name, monthly_credits: Math.round(Number(dollars) * 100000),
      min_interval_hours: Number(minHours), max_follows: Number(maxFollows),
    });
    console.log(`已创建：${name}`);
    console.log(`访问码（只显示这一次，请私下发给对方）：${r.code}`);
    console.log(`id：${r.id}`);
  } else if (cmd === 'list') {
    const r = await call('/admin/codes');
    console.log(`月份 ${r.month}`);
    for (const c of r.codes) {
      console.log(`${c.disabled ? '[停用] ' : ''}${c.name}  已用 ${usd(c.usage.credits)} / ${usd(c.monthly_credits)}  ` +
        `请求 ${c.usage.requests} 次  最短间隔 ${c.limits.min_interval_hours}h  id ${c.id}`);
    }
  } else if (cmd === 'disable' || cmd === 'enable') {
    await call(`/admin/codes/${args[0]}`, { disabled: cmd === 'disable' });
    console.log(cmd === 'disable' ? '已停用' : '已启用');
  } else if (cmd === 'quota') {
    await call(`/admin/codes/${args[0]}`, { monthly_credits: Math.round(Number(args[1]) * 100000) });
    console.log('已更新额度');
  } else if (cmd === 'verify-roster') {
    // 逐个核对名单里的用户名，约 $0.0002 / 人；结果写到 dist/roster-check.json。
    // 未充值过的 twitterapi.io 账号限速 5 秒 1 次，所以一个一个查、每次间隔 5.5 秒，
    // 已经确认存在的不重复查。
    const roster = JSON.parse(fs.readFileSync(args[0] || 'desktop/roster.json', 'utf8'));
    const names = roster.people.map((p) => p.username);
    const out = 'dist/roster-check.json';
    const prev = new Map();
    try { for (const r of JSON.parse(fs.readFileSync(out, 'utf8'))) prev.set(r.username, r); } catch { /* 首次 */ }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = [];
    let checked = 0;
    for (const n of names) {
      const old = prev.get(n);
      if (old && (old.found || !/^http 429$/.test(old.error || ''))) { results.push(old); continue; }
      let r;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (checked++) await sleep(5500);
        r = (await call('/admin/lookup-users', { usernames: [n] })).results[0];
        if (r.error !== 'http 429') break;
      }
      results.push(r);
      console.log(`${r.found ? '✓' : '✗'} @${n} ${r.found ? `(${r.name}, ${r.followers} 关注者)` : (r.unavailable || r.error)}`);
      fs.mkdirSync('dist', { recursive: true });
      fs.writeFileSync(out, JSON.stringify([...results, ...names.slice(results.length).map((u) => prev.get(u)).filter(Boolean)], null, 2));
    }
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    const bad = results.filter((r) => !r.found);
    const renamed = results.filter((r) => r.found && r.canonical !== r.username);
    console.log(`存在 ${results.length - bad.length}，有问题 ${bad.length}，大小写不同 ${renamed.length}`);
    for (const r of bad) console.log(`  ✗ @${r.username}：${r.unavailable || r.error}`);
    for (const r of renamed) console.log(`  ~ @${r.username} → @${r.canonical}`);
  } else if (cmd === 'publish-update' || cmd === 'publish-roster') {
    const file = args[0];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cmd === 'publish-update' && !/^https:\/\//.test(data.url || '')) throw new Error('latest.json 的 url 不是 https 下载地址');
    await call(`/admin/publish/${cmd === 'publish-update' ? 'latest.json' : 'roster.json'}`, data);
    console.log(`已发布 ${file}`);
  } else {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n'));
  }
} catch (e) {
  console.error('失败：', e.message);
  process.exit(1);
}
