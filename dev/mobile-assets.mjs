import fs from 'node:fs/promises';
import path from 'node:path';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
export function mobileAssets(root) {
  return { async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname === '/mobile/' ? '/mobile/index.html' : url.pathname;
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(path.resolve(root) + path.sep)) return new Response('', { status: 404 });
    try {
      const bytes = await fs.readFile(file);
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      } });
    } catch { return new Response('not found', { status: 404 }); }
  } };
}
