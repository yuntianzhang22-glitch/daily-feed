import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const output = fileURLToPath(new URL('../.local/mobile-entry/', import.meta.url));
fs.mkdirSync(output, { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('../mobile/entry-worker.mjs', import.meta.url))],
  outfile: output + '_worker.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true });
// Pages needs a public asset directory, even though every permitted request is
// handled by the entry Worker. Deploy this folder only, never repository files.
fs.writeFileSync(output + '404.html', '<!doctype html><meta charset="utf-8"><title>Daily Feed</title><p>页面不存在</p>');
console.log('Daily Feed 独立入口已构建：.local/mobile-entry/');
