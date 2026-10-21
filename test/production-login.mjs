// 用真实 Worker + 正式客户端入口验收：两台独立设备、进程重启、共享余额和本地数据独立。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { startLab } from '../dev/lab-server.mjs';
import profiles from '../desktop/core/environment.js';

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-feed-login-'));
const lab = await startLab({ root, environment: 'test' });
const code = profiles.localCode('test', 'paid', 'normal');
const account = lab.ledger.status(lab.accounts['paid:normal']);
async function device(phase, directory, balance) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DAILY_FEED_') && key !== 'ELECTRON_RUN_AS_NODE'));
  Object.assign(env, {
    DAILY_FEED_ENV: 'production', DAILY_FEED_USER_DATA: path.join(root, directory),
    DAILY_FEED_RELAY: lab.url, DAILY_FEED_MANIFEST: `${lab.url}/v1/latest`, DAILY_FEED_ROSTER: `${lab.url}/v1/roster`,
    LOGIN_SMOKE_PHASE: phase, LOGIN_SMOKE_ACCOUNT: code, LOGIN_SMOKE_NUMBER: account.account_no,
    LOGIN_SMOKE_BALANCE: String(balance),
  });
  const child = spawn(require('electron'), ['test/production-login.cjs'], { env, stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => exitCode === 0 ? resolve() : reject(new Error(`登录验收失败：${phase}`)));
  });
}
try {
  await device('first', 'device-a', 30);
  lab.ledger.topup(account.account_no, 10, '验收模拟到账');
  await device('restart', 'device-a', 40);
  await device('second', 'device-b', 40);
  console.log('Production login passed: 无密码登录、旧凭证兼容、进程重启、两台设备共用余额、本地设置独立、复制与退出');
} finally {
  await lab.close();
  fs.rmSync(root, { recursive: true, force: true });
}
