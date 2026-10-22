#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { startLab } from './lab-server.mjs';
import { testRuntime } from './test-runtime.mjs';
import profiles from '../desktop/core/environment.js';
import fixtures from './fixtures.cjs';
import storeModule from '../desktop/core/store.js';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const [environment = 'test', ...args] = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const role = value('--role', 'owner');
const scenario = value('--scenario', 'normal');
profiles.validateProfile(role, scenario);
if (!['test', 'staging'].includes(environment)) throw new Error('使用 test 或 staging，正式应用用 npm run start:production');
const live = args.includes('--live');
if (live && environment !== 'staging') throw new Error('只有预发环境支持 --live');
let secrets = {};
const secretFile = path.join(repo, '.env.staging.local');
if (live && fs.existsSync(secretFile)) {
  // 仅解析文件，不把其他 DAILY_FEED_* 配置带入验收进程。
  secrets = createRequire(import.meta.url)('node:util').parseEnv(fs.readFileSync(secretFile, 'utf8'));
}
const liveApiKey = live ? (process.env.DAILY_FEED_STAGING_API_KEY || secrets.DAILY_FEED_STAGING_API_KEY || '') : '';
if (live && (!liveApiKey || liveApiKey.startsWith('replace_'))) throw new Error('真实预发需要 .env.staging.local 中的 DAILY_FEED_STAGING_API_KEY，见 docs/ENVIRONMENTS.md');
const smoke = args.includes('--smoke');
const root = path.join(repo, '.local', smoke ? `smoke-${process.pid}` : live ? 'live' : 'fixtures');
const lab = await startLab({ root, environment, port: Number(value('--port', smoke ? '0' : live ? '8793' : environment === 'test' ? '8791' : '8792')), liveApiKey });
for (const [r, scenarios] of Object.entries(profiles.SCENARIOS)) for (const s of Object.keys(scenarios)) {
  const dir = profiles.profilePath(root, environment, r, s);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ version: 3, follows: ['karpathy', 'simonw', 'emollick'],
    schedule_enabled: false, schedule_days: [1, 4], schedule_time: '09:00', max_per_target: 3, search_mode: 'Top' }));
  if (!live) {
    const store = new storeModule.Store(path.join(dir, 'tweets.db'));
    if (!store.counts().total) for (const t of fixtures.sampleTweets()) store.save(t, `user:${t.author.userName}`, new Date().toISOString());
    store.close();
  }
}
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DAILY_FEED_') && k !== 'ELECTRON_RUN_AS_NODE'));
Object.assign(env, {
  DAILY_FEED_ENV: environment, DAILY_FEED_ROLE: role, DAILY_FEED_SCENARIO: scenario,
  DAILY_FEED_LAB_URL: lab.url, DAILY_FEED_LAB_TOKEN: lab.token, DAILY_FEED_LIVE: live ? '1' : '0',
  DAILY_FEED_LAB_ROOT: root,
  DAILY_FEED_LAB_KEY: lab.directKey, DAILY_FEED_LAB_DIRECT_BASE: lab.directBase,
  ...(smoke ? { DAILY_FEED_AUTOMATED_TEST: '1' } : {}),
});
console.log(`${environment === 'test' ? '测试' : '预发'}环境 · ${live ? '真实 API（会产生接口费用）' : '合成数据（不调用外部 API）'}\n${lab.url}\n界面内可切换三类身份和异常状态；数据：${root}/${environment}`);
const electron = testRuntime(repo, environment, { background: smoke });
const child = spawn(electron, [smoke ? path.join(repo, 'test/electron-smoke.cjs') : repo], { cwd: repo, env, stdio: 'inherit' });
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  if (child.exitCode === null) child.kill('SIGTERM');
  await lab.close();
  if (smoke) fs.rmSync(root, { recursive: true, force: true });
  process.exit(code);
}
child.on('exit', (code, signal) => close(code ?? (signal ? 1 : 0)));
child.on('error', () => close(1));
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
