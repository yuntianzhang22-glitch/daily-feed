// 为源码验收生成独立的 macOS 运行时外壳。只修改 .local 副本，不改安装依赖或正式应用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import environmentConfig from '../desktop/core/environment.js';

const require = createRequire(import.meta.url);
export function testRuntime(repo, environment, { background = false } = {}) {
  const electron = require('electron');
  if (process.platform !== 'darwin') return electron;
  if (!['test', 'staging'].includes(environment)) throw new Error('测试运行时不能用于正式环境');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const icon = path.join(repo, 'build/icon.png');
  const fingerprint = crypto.createHash('sha256')
    .update(fs.readFileSync(new URL(import.meta.url)))
    .update(fs.readFileSync(icon)).update(pkg.version).update(require('electron/package.json').version)
    .update(background ? 'background-test' : 'interactive')
    .digest('hex').slice(0, 12);
  const root = path.join(repo, '.local/runtime', `${environment}-${fingerprint}`);
  const bundle = path.join(root, `${environmentConfig.LAB_APP_NAME}.app`);
  const executable = path.join(bundle, 'Contents/MacOS', environmentConfig.LAB_APP_NAME);
  const marker = path.join(root, 'ready');
  if (fs.existsSync(marker) && fs.existsSync(executable)) return executable;

  fs.mkdirSync(root, { recursive: true });
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
  // 目录只包含本次指纹对应的生成物；旧版本的外壳可继续运行，不会被原地替换。
  fs.rmSync(bundle, { recursive: true, force: true });
  const sourceBundle = path.resolve(electron, '../../..');
  run('/usr/bin/ditto', [sourceBundle, bundle]);
  fs.renameSync(path.join(bundle, 'Contents/MacOS/Electron'), executable);
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({
    CFBundleName: environmentConfig.LAB_APP_NAME, CFBundleDisplayName: environmentConfig.LAB_APP_NAME,
    CFBundleExecutable: environmentConfig.LAB_APP_NAME, CFBundleIdentifier: `local.dailyfeed.${environment}`,
    CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version,
    ...(background ? { LSUIElement: 'true' } : {}),
  })) {
    try { run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]); }
    catch { run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${key === 'LSUIElement' ? 'bool' : 'string'} ${value}`, plist]); }
  }
  const iconset = fs.mkdtempSync(path.join(root, 'icons-')) + '/app.iconset';
  fs.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
      const output = path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
      run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), icon, '--out', output]);
    }
    run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(bundle, 'Contents/Resources/electron.icns')]);
  } finally { fs.rmSync(path.dirname(iconset), { recursive: true, force: true }); }
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  fs.writeFileSync(marker, fingerprint);
  return executable;
}
