// 同一套实际登录流程分别验收正式、测试、预发：两台设备、登录/退出后重启、共享余额、本地数据独立。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { startLab } from '../dev/lab-server.mjs';
import profiles from '../desktop/core/environment.js';

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-feed-login-'));
async function device(lab, environment, code, account, phase, directory, balance) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DAILY_FEED_') && key !== 'ELECTRON_RUN_AS_NODE'));
  Object.assign(env, {
    DAILY_FEED_ENV: environment, DAILY_FEED_USER_DATA: path.join(root, environment, directory),
    DAILY_FEED_RELAY: lab.url, DAILY_FEED_MANIFEST: `${lab.url}/v1/latest`, DAILY_FEED_ROSTER: `${lab.url}/v1/roster`,
    LOGIN_SMOKE_PHASE: phase, LOGIN_SMOKE_ACCOUNT: code, LOGIN_SMOKE_NUMBER: account.account_no,
    LOGIN_SMOKE_BALANCE: String(balance),
  });
  if (environment !== 'production') Object.assign(env, {
    DAILY_FEED_ROLE: 'paid', DAILY_FEED_SCENARIO: 'normal', DAILY_FEED_LAB_URL: lab.url,
    DAILY_FEED_LAB_TOKEN: lab.token, DAILY_FEED_LAB_ROOT: path.join(root, environment, directory),
  });
  const child = spawn(require('electron'), ['test/production-login.cjs'], { env, stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => exitCode === 0 ? resolve() : reject(new Error(`登录验收失败：${phase}`)));
  });
}
try {
  for (const environment of ['production', 'test', 'staging']) {
    const serverEnvironment = environment === 'production' ? 'test' : environment;
    const lab = await startLab({ root: path.join(root, environment, 'server'), environment: serverEnvironment });
    let labClosed = false;
    try {
      const code = profiles.localCode(serverEnvironment, 'paid', 'normal');
      const account = lab.ledger.status(lab.accounts['paid:normal']);
      await device(lab, environment, code, account, 'first', 'device-a', 30);
      lab.ledger.topup(account.account_no, 10, '验收模拟到账');
      await device(lab, environment, code, account, 'restart', 'device-a', 40);
      await device(lab, environment, code, account, 'second', 'device-b', 40);
      // 重启本地 Worker 及客户端，退出状态仍不能被自动注入的样例身份覆盖。
      await lab.close();
      labClosed = true;
      const restarted = await startLab({ root: path.join(root, environment, 'server'), environment: serverEnvironment });
      try { await device(restarted, environment, code, account, 'logout-restart', 'device-b', 40); }
      finally { await restarted.close(); }
      console.log(`${environment} login parity passed: 真实登录/复制/退出、进程和服务重启、两台设备、共享余额、本地设置独立`);
    } finally { if (!labClosed) await lab.close(); }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
