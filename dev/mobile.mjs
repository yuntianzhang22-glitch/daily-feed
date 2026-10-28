import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMobile } from '../build/mobile.mjs';
import { mobileAssets } from './mobile-assets.mjs';
import { startLab } from './lab-server.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const assets = mobileAssets(await buildMobile());
const lab = await startLab({ root: path.join(repo, '.local/mobile'), environment: 'test', port: 8794, assets });
console.log(`移动版本地验收（合成帖子，不产生 API 费用）：${lab.url}/mobile/`);
for (const role of ['beta', 'owner', 'paid']) console.log(`${role} 样例账号：${lab.ledger.status(lab.accounts[`${role}:normal`]).account_no}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await lab.close(); process.exit(0); });
