// 从 Git 清单验证发布的开发仓库完整，避免“本机有、中转源码在别处”的隐性依赖。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const required = [
  'relay/src/worker.js', 'relay/src/ledger.js', 'relay/admin.mjs', 'relay/test-loader.mjs',
  'relay/wrangler.toml', 'relay/wrangler.staging.toml', 'relay/relay.test.mjs', 'relay/ledger.test.mjs',
  'dev/start.mjs', 'dev/lab-server.mjs', 'dev/fixtures.cjs', '.env.staging.example',
  'desktop/core/permissions.js', 'dev/setup-owner.cjs', '.env.owner.example',
  'docs/ENVIRONMENTS.md', 'docs/RELEASE_NOTES.md', 'package-lock.json', 'test/lab.test.mjs', 'test/electron-smoke.cjs',
];
for (const file of required) if (!files.includes(file) || !fs.existsSync(file)) throw new Error(`开发仓库缺失：${file}`);
for (const file of files) {
  if (/(^|\/)(\.local|\.wrangler|node_modules)(\/|$)|(^|\/)\.dev\.vars|\.local\.(json|toml)$|(^|\/)\.env(\.|$)/.test(file) && !['.env.staging.example', '.env.owner.example'].includes(file)) {
    throw new Error(`不应发布的本地文件：${file}`);
  }
  if (/\.(db|db-wal|db-shm)$|(^|\/)admin_token$/.test(file)) throw new Error(`不应发布的数据/口令文件：${file}`);
}
console.log('完整开发仓库检查通过：客户端、中转、测试/预发环境及文档都在 Git 中，无本地凭据或数据库。');
