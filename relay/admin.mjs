#!/usr/bin/env node
// 中转服务管理脚本。中转地址读 desktop/app-config.json，管理口令读 ~/.daily-feed-admin/admin_token
// （也可以用环境变量 DAILY_FEED_RELAY / DAILY_FEED_ADMIN_TOKEN 覆盖）。
// 下面的 <账号> 可以写账号（DF-XXXXX，大小写和 DF- 都可省）、名字或 id。
//
//   node relay/admin.mjs add "名字" [每月美元额度=3]     新建内测码（免费，每月额度）
//   node relay/admin.mjs add-paid "名字"                  新建付费码（余额 0，充值后可用）
//   node relay/admin.mjs topup <账号> <金额> [备注]       充值（元）；负数为退款或冲正
//   node relay/admin.mjs list                             所有账号、余额、本月用量
//   node relay/admin.mjs show <账号>                      一个账号的充值记录和每月用量
//   node relay/admin.mjs price [汇率 加价倍数]             查看或修改价格
//   node relay/admin.mjs plan <账号> beta|paid            改内测 / 付费
//   node relay/admin.mjs quota <账号> <每月美元额度>       改内测额度
//   node relay/admin.mjs disable|enable <账号>            停用 / 启用
//   node relay/admin.mjs migrate                          把旧版访问码搬进账本（升级后运行一次）
//   node relay/admin.mjs publish-update dist/latest.json
//   node relay/admin.mjs publish-roster desktop/roster.json
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const argv = process.argv.slice(2);
const envIndex = argv.indexOf('--env');
const environment = envIndex >= 0 ? argv.splice(envIndex, 2)[1] : '';
if (!['production', 'staging'].includes(environment)) {
  console.error('请显式选择环境：npm run relay:admin:production -- <命令> 或 npm run relay:admin:staging -- <命令>');
  process.exit(1);
}

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
const stagingSecrets = environment === 'staging' ? parseEnv(readOr(new URL('../.env.staging.local', import.meta.url), '')) : {};
const base = (environment === 'staging'
  ? process.env.DAILY_FEED_STAGING_RELAY || stagingSecrets.DAILY_FEED_STAGING_RELAY || ''
  : process.env.DAILY_FEED_RELAY || appConfig.relayUrl || '').replace(/\/+$/, '');
const token = environment === 'staging'
  ? process.env.DAILY_FEED_STAGING_ADMIN_TOKEN || stagingSecrets.DAILY_FEED_STAGING_ADMIN_TOKEN || ''
  : process.env.DAILY_FEED_ADMIN_TOKEN || readOr(`${process.env.HOME}/.daily-feed-admin/admin_token`, '');
if (environment === 'staging' && (!/^https:\/\/daily-feed-relay-staging\.[\w.-]+\.workers\.dev$/.test(base) || base === appConfig.relayUrl)) {
  console.error('预发管理只能连接独立的 daily-feed-relay-staging Worker，不能使用正式地址');
  process.exit(1);
}
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

const [cmd, ...args] = argv;
const usd = (c) => `$${(c / 100000).toFixed(2)}`;
const need = (v, what) => {
  if (v === undefined || v === '') throw new Error(`缺少参数：${what}`);
  return v;
};

// 一行账号摘要：内测看本月用量 / 额度，付费看余额
function line(a) {
  const flag = a.disabled ? '[停用] ' : '';
  const money = a.plan === 'paid'
    ? `余额 ¥${a.balance.cny}（累计充值 ¥${a.balance.topped_cny}，本月花 ¥${a.balance.month_spent_cny}）`
    : `本月 ${usd(a.quota.used_credits)} / ${usd(a.monthly_credits)}`;
  return `${flag}${a.account_no}  ${a.name}  ${a.plan === 'paid' ? '付费' : '内测'}  ${money}  ${a.quota.requests} 次请求`;
}

try {
  if (cmd === 'add' || cmd === 'add-paid') {
    // add "名字" [每月美元额度=3]：内测码；add-paid "名字"：付费码，余额为 0，充值后才能用
    const [name, dollars = '3', runsPerWeek = '7', maxFollows = '60'] = args;
    if (!name) throw new Error('需要名字');
    const plan = cmd === 'add-paid' ? 'paid' : 'beta';
    const r = await call('/admin/codes', {
      name, plan, monthly_credits: Math.round(Number(dollars) * 100000),
      max_runs_per_week: Number(runsPerWeek), max_follows: Number(maxFollows),
    });
    const a = r.account;
    console.log(`已创建${plan === 'paid' ? '付费' : '内测'}账号：${a.name}  账号 ${a.account_no}`);
    console.log(`登录账号（无需密码，只显示这一次，请私下发给对方）：${r.code}`);
    if (plan === 'paid') console.log(`余额为 0。对方转账时备注账号 ${a.account_no}，收到后运行：node relay/admin.mjs topup ${a.account_no} <金额>`);
  } else if (cmd === 'list') {
    const r = await call('/admin/codes');
    const p = r.price;
    console.log(`价格：¥1 = ${p.credits_per_cny} credits（汇率 ${p.fx}，加价 ${p.markup} 倍），约 ¥${p.cny_per_1k_tweets} / 千条帖子`);
    for (const a of r.accounts) console.log(line(a));
  } else if (cmd === 'show') {
    const h = await call('/admin/history', { ref: need(args[0], '账号') });
    console.log(line(h.account));
    console.log('充值记录：' + (h.topups.length ? '' : '无'));
    for (const t of h.topups) console.log(`  ${t.at.slice(0, 16).replace('T', ' ')}  ¥${t.cny}${t.note ? `  ${t.note}` : ''}`);
    console.log('每月用量：' + (h.months.length ? '' : '无'));
    for (const m of h.months) console.log(`  ${m.month}  ${m.requests} 次请求  ${usd(m.credits)}${h.account.plan === 'paid' ? `（¥${m.cny}）` : ''}`);
  } else if (cmd === 'topup') {
    // topup <账号或名字> <金额（元）> [备注]；金额为负数表示退款或冲正
    const [ref, cny, ...note] = args;
    const r = await call('/admin/topup', { ref: need(ref, '账号'), cny: Number(need(cny, '金额')), note: note.join(' ') });
    console.log(`已${r.cny > 0 ? '充值' : '扣回'} ¥${Math.abs(r.cny)}：${r.account.name}（${r.account.account_no}）`);
    console.log(`当前余额 ¥${r.account.balance.cny}，累计充值 ¥${r.account.balance.topped_cny}`);
  } else if (cmd === 'disable' || cmd === 'enable') {
    const a = await call('/admin/account', { ref: need(args[0], '账号'), patch: { disabled: cmd === 'disable' } });
    console.log(`${cmd === 'disable' ? '已停用' : '已启用'}：${a.name}（${a.account_no}）`);
  } else if (cmd === 'quota') {
    const a = await call('/admin/account', { ref: need(args[0], '账号'), patch: { monthly_credits: Math.round(Number(need(args[1], '每月美元额度')) * 100000) } });
    console.log(`已把 ${a.name} 的每月额度改为 ${usd(a.monthly_credits)}`);
  } else if (cmd === 'plan') {
    const a = await call('/admin/account', { ref: need(args[0], '账号'), patch: { plan: need(args[1], 'beta 或 paid') } });
    console.log(`已把 ${a.name}（${a.account_no}）改为${a.plan === 'paid' ? '付费' : '内测'}账号`);
  } else if (cmd === 'price') {
    // price：查看；price <汇率> <加价倍数>：修改，只影响之后的充值，已充的余额不变
    const p = args.length ? await call('/admin/price', { fx: Number(args[0]), markup: Number(args[1]) }) : await call('/admin/price');
    console.log(`汇率 ${p.fx}，加价 ${p.markup} 倍：¥1 = ${p.credits_per_cny} credits，满页一次约 ¥${p.cny_per_full_page}，约 ¥${p.cny_per_1k_tweets} / 千条帖子`);
  } else if (cmd === 'migrate') {
    // 把旧版存在 KV 里的访问码搬进账本，只需运行一次，重复运行不会重复导入
    const r = await call('/admin/migrate-kv', {});
    console.log(`已迁移 ${r.moved.length} 个访问码：`);
    for (const a of r.moved) console.log('  ' + line(a));
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
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'));
  }
} catch (e) {
  console.error('失败：', e.message);
  process.exit(1);
}
