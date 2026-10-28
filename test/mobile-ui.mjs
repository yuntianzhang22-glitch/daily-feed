import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMobile } from '../build/mobile.mjs';
import { mobileAssets } from '../dev/mobile-assets.mjs';
import { startLab } from '../dev/lab-server.mjs';
import { testRuntime } from '../dev/test-runtime.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-feed-mobile-ui-'));
const repo = fileURLToPath(new URL('../', import.meta.url));
const assets = mobileAssets(await buildMobile());
const lab = await startLab({ root, environment: 'test', assets });
try {
  const env = { ...process.env, MOBILE_SMOKE_URL: lab.url, MOBILE_SMOKE_ROOT: root,
    MOBILE_SMOKE_ACCOUNT: lab.ledger.status(lab.accounts['beta:normal']).account_no,
    MOBILE_SMOKE_EMPTY: lab.ledger.status(lab.accounts['paid:empty']).account_no,
    MOBILE_SMOKE_EXHAUSTED: lab.ledger.status(lab.accounts['beta:exhausted']).account_no,
    MOBILE_SMOKE_SHOTS: path.join(repo, '.local/mobile-screenshots') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(testRuntime(repo, 'test', { background: true }), [path.join(repo, 'test/mobile-ui.cjs')], { env, stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`移动页面验收失败：${code}`)));
  });
} finally { await lab.close(); fs.rmSync(root, { recursive: true, force: true }); }
