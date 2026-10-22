// 只归档已知发布产物，不移动正在使用的 .app，也不删除历史文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--version')) {
  throw new Error('用法：node build/organize-dist.mjs [--version <即将构建的版本>]');
}
const dist = path.join(repo, 'dist');
const manifestPath = path.join(dist, 'latest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
const current = args[1] || manifest?.version || JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const validVersion = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
if (!validVersion.test(current) || (manifest && !validVersion.test(manifest.version))) {
  throw new Error('发布版本号格式无效，未整理任何文件');
}
fs.mkdirSync(dist, { recursive: true });
const moves = [];
for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const match = /^Daily-Feed-(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)-(?:development|mac-[A-Za-z0-9_]+)\.zip$/.exec(entry.name);
  if (match && match[1] !== current) moves.push({ name: entry.name, group: match[1] });
  if (['RELEASE_STEPS.md', 'roster-check.json'].includes(entry.name)) moves.push({ name: entry.name, group: 'legacy' });
}
if (manifest && manifest.version !== current) moves.push({ name: 'latest.json', group: manifest.version });
// 重复构建的同名文件也保留，已有归档不会被覆盖。
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const move of moves) {
  let directory = path.join(dist, 'archive', move.group);
  if (fs.existsSync(path.join(directory, move.name))) directory = path.join(directory, `saved-${stamp}`);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, move.name);
  if (fs.existsSync(target)) throw new Error(`归档目标已存在：${target}`);
  fs.renameSync(path.join(dist, move.name), target);
  console.log(`已归档：${move.name} → ${path.relative(dist, target)}`);
}
fs.writeFileSync(path.join(dist, 'README.md'), `# Daily Feed 发布文件\n\n当前版本：${current}。\n\n- \`Daily Feed.app\`：本机可直接打开的正式应用。\n- \`Daily-Feed-${current}-mac-*.zip\`：发给用户的安装包，解压后打开应用。\n- \`Daily-Feed-${current}-development.zip\`：对应发布版本的完整开发源码包，由发布流程生成。\n- \`latest.json\`：应用更新清单。\n- [archive](archive/)：按版本归档的历史产物；legacy 中是早期辅助文件。\n\n每次正式发布生成独立的版本安装包，历史版本保留用于回退。日常开发不需要打包；GitHub 仓库保存最新源码，Releases 保存每次正式发布的安装包及对应开发源码包。\n\n可在项目根目录运行 \`npm run dist:organize\` 再次整理。打包时会自动归档其他版本，不删除历史文件；旧版应用如需回退，可从归档安装包解压。\n`);
console.log(`整理完成：dist 顶层保留 ${current}，历史产物位于 dist/archive/。`);
