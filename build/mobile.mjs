import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const repo = fileURLToPath(new URL('../', import.meta.url));
export async function buildMobile() {
  const target = path.join(repo, 'mobile/dist/mobile');
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(repo, 'mobile/public'), target, { recursive: true });
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).version;
  await build({ entryPoints: [path.join(repo, 'mobile/app.mjs')], outfile: path.join(target, 'app.js'),
    bundle: true, platform: 'browser', target: ['safari16.4'], minify: true,
    define: { __MOBILE_VERSION__: JSON.stringify(version) }, legalComments: 'none' });
  fs.mkdirSync(path.join(target, 'icons'), { recursive: true });
  for (const size of [192, 512]) execFileSync('sips', ['-z', String(size), String(size),
    path.join(repo, 'build/icon.png'), '--out', path.join(target, `icons/icon-${size}.png`)], { stdio: 'pipe' });
  const hash = crypto.createHash('sha256');
  for (const name of ['app.js', 'index.html', 'style.css', 'manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png']) {
    hash.update(fs.readFileSync(path.join(target, name)));
  }
  fs.writeFileSync(path.join(target, 'sw.js'), fs.readFileSync(path.join(target, 'sw.js'), 'utf8').replaceAll('__BUILD_ID__', hash.digest('hex').slice(0, 16)));
  return path.dirname(target);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildMobile();
  console.log('移动版已构建：mobile/dist/mobile（Safari / iOS 16.4+）');
}
