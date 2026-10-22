#!/usr/bin/env node
// 先构建和验证，再发布。完整源码包包含客户端、中转、验收环境、测试与部署说明。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { version } = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const run = (cmd, argv, extra = {}) => {
  const r = spawnSync(cmd, argv, { cwd: repo, env: process.env, encoding: 'utf8', stdio: 'inherit', ...extra });
  if (r.status !== 0) throw new Error(`${cmd} 执行失败`);
  return r.stdout;
};
const status = run('git', ['status', '--porcelain'], { stdio: 'pipe' });
if (status.trim()) throw new Error('发布前请先提交源码，确保安装包和 GitHub 源码一致');
run('node', ['build/check-repository.mjs']);
const tag = `v${version}`;
const repository = 'yuntianzhang22-glitch/daily-feed';
const source = `dist/Daily-Feed-${version}-development.zip`;
const zip = `dist/Daily-Feed-${version}-mac-${process.arch}.zip`;
const dmg = `dist/Daily-Feed-${version}-mac-${process.arch}.dmg`;
process.env.DAILY_FEED_DOWNLOAD_BASE = `https://github.com/${repository}/releases/download/${tag}`;
run('npm', ['run', 'dist']);
run('npm', ['run', 'test:ui']);
run('git', ['archive', '--format=zip', `--prefix=Daily-Feed-${version}-development/`, '-o', source, 'HEAD']);
if (args.includes('--prepare-only')) {
  console.log(`发布产物已就绪：${dmg}、${zip}、${source}、dist/latest.json。尚未上传或更新正式更新通道。`);
  process.exit(0);
}
// 推送提交后，在该提交上打版本标签；不覆盖已有同名版本。
const sha = run('git', ['rev-parse', 'HEAD'], { stdio: 'pipe' }).trim();
run('git', ['push', 'origin', 'HEAD']);
run('gh', ['release', 'create', tag, dmg, zip, source, 'dist/latest.json', '--repo', repository,
  '--target', sha, '--title', `Daily Feed ${version}`, '--notes-file', 'docs/RELEASE_NOTES.md']);
console.log('GitHub Release 已发布，含 DMG 安装包、ZIP 更新包和完整开发环境。验收后可显式运行 npm run relay:admin:production -- publish-update dist/latest.json 推送给正式用户。');
