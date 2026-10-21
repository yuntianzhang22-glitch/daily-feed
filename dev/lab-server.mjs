// 用真实 Worker + 账本代码驱动验收界面；仅模拟 Cloudflare 绑定和上游数据。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker, { LedgerDO } from '../relay/src/worker.js';
import profiles from '../desktop/core/environment.js';
import fixtures from './fixtures.cjs';

export async function startLab({ root, environment, port = 0, liveApiKey = '' }) {
  if (!['test', 'staging'].includes(environment)) throw new Error('本地服务不能以正式环境运行');
  if (environment === 'test' && liveApiKey) throw new Error('测试环境只使用样例数据');
  const dir = path.join(root, environment, 'server');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'ledger.db'));
  const sql = { exec(q, ...b) {
    const stmt = db.prepare(q);
    const rows = /^\s*(SELECT|PRAGMA)/i.test(q) ? stmt.all(...b).map((r) => ({ ...r })) : (stmt.run(...b), []);
    return { toArray: () => rows };
  } };
  const obj = new LedgerDO({ storage: { sql } }, {});
  const ledger = obj.ledger;
  const token = crypto.randomBytes(32).toString('hex');
  // 样例直连 Key 跨服务重启保持有效，才能真实验收本机凭据持久化。
  const fixtureKeyFile = path.join(dir, 'direct-key');
  const fixtureKey = fs.existsSync(fixtureKeyFile) ? fs.readFileSync(fixtureKeyFile, 'utf8') : crypto.randomBytes(32).toString('hex');
  if (!fs.existsSync(fixtureKeyFile)) fs.writeFileSync(fixtureKeyFile, fixtureKey, { mode: 0o600 });
  const kvFile = path.join(dir, 'public.json');
  const kv = fs.existsSync(kvFile) ? JSON.parse(fs.readFileSync(kvFile, 'utf8')) : {};
  kv['public:roster.json'] = fs.readFileSync(new URL('../desktop/roster.json', import.meta.url), 'utf8');
  const currentVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const env = {
    ADMIN_TOKEN: token, TWITTERAPI_KEY: liveApiKey || fixtureKey,
    ACCESS: {
      get: async (k) => kv[k] ?? null,
      put: async (k, v) => { kv[k] = v; fs.writeFileSync(kvFile, JSON.stringify(kv)); },
      list: async ({ prefix }) => ({ keys: Object.keys(kv).filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }),
    },
    LEDGER: { idFromName: (n) => n, get: () => ({ call: async (method, args) => structuredClone(obj.call(method, args)) }) },
  };
  const accounts = {};
  for (const role of ['owner', 'beta', 'paid']) for (const scenario of Object.keys(profiles.SCENARIOS[role])) {
    const code = profiles.localCode(environment, role, scenario);
    const id = crypto.createHash('sha256').update(code).digest('hex');
    let account = ledger.find(id);
    if (!account) {
      ledger.create({ id, name: `${profiles.ROLES[role]} · ${profiles.SCENARIOS[role][scenario]}`, plan: role,
        monthly_credits: scenario === 'exhausted' ? 300 : 300000 });
      if (role === 'paid' && ['normal', 'low', 'disabled'].includes(scenario)) {
        ledger.topup(id, scenario === 'low' ? 0.5 : 30, '验收模拟充值，不是真实转账');
      }
      if (scenario === 'exhausted') ledger.charge(id, 300);
      if (scenario === 'disabled') ledger.update(id, { disabled: true });
    }
    accounts[`${role}:${scenario}`] = id;
  }
  // 耗尽场景跨月后仍可验收；只修正该场景，不动正常账号的用量。
  const exhausted = accounts['beta:exhausted'];
  if (ledger.status(exhausted).quota.used_credits < 300) ledger.charge(exhausted, 300);

  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(req.url, origin);
      // 拒绝浏览器跨源写入本地管理服务。
      if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403); res.end(); return; }
      if (url.pathname === '/twitter/tweet/advanced_search') {
        if (liveApiKey || req.headers['x-api-key'] !== fixtureKey) { res.writeHead(401); res.end(); return; }
        const query = url.searchParams.get('query') || '';
        const names = [...new Set([...query.matchAll(/from:([A-Za-z0-9_]{1,15})/g)].map((m) => m[1]))];
        const since = Number(/since_time:(\d+)/.exec(query)?.[1] || 0) * 1000;
        const all = fixtures.sampleTweets(names.length ? names : undefined).filter((t) => Date.parse(t.createdAt) >= since);
        if (url.searchParams.get('queryType') === 'Top') all.sort((a, b) => b.likeCount - a.likeCount);
        const offset = Number(url.searchParams.get('cursor')) || 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tweets: all.slice(offset, offset + 20), has_next_page: offset + 20 < all.length, next_cursor: String(offset + 20) }));
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      // 默认没有新版本；发布本地演示清单后，走与正式版相同的 Worker 更新检查。
      if (!kv['public:latest.json']) kv['public:latest.json'] = JSON.stringify({ version: currentVersion,
        url: `${origin}/fixtures/update-preview.zip`, sha256: '0'.repeat(64), notes: '' });
      // 预览仅验证提醒和失败重试，不提供可安装包。
      if (url.pathname === '/fixtures/update-preview.zip') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: '本地演示不包含安装包' }));
        return;
      }
      const request = new Request(url, {
        method: req.method, headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const result = await worker.fetch(request, env);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch { res.writeHead(500); res.end(JSON.stringify({ message: '本地验收服务异常' })); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (e) { db.close(); throw e; }
  const url = `http://127.0.0.1:${server.address().port}`;
  if (!liveApiKey) env.TWITTERAPI_BASE = url;
  return {
    url, token, accounts, directKey: liveApiKey || fixtureKey,
    directBase: liveApiKey ? 'https://api.twitterapi.io' : url,
    ledger,
    close: async () => { await new Promise((resolve) => server.close(resolve)); db.close(); },
  };
}
