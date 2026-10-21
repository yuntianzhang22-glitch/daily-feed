// 本地演示用的假 twitterapi.io：只在 127.0.0.1 上监听，不联网、不花钱。
// 从一份帖子数据库（默认是你真实数据库的副本）里按查询里的 from:用户名 挑帖子返回，
// 每页最多 20 条，并模拟约 1 秒的接口延迟。
//
// 用法：node relay/dev/mock-upstream.mjs <tweets.db 副本路径> [端口=8788]
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, port = '8788'] = process.argv.slice(2);
if (!dbPath) {
  console.error('用法：node relay/dev/mock-upstream.mjs <tweets.db 副本路径> [端口]');
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const all = db.prepare('SELECT raw FROM tweets').all().map((r) => JSON.parse(r.raw));
console.log(`mock upstream：载入 ${all.length} 条帖子`);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/twitter/tweet/advanced_search' || !req.headers['x-api-key']) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 404, message: 'not found' }));
  }
  const q = url.searchParams.get('query') || '';
  const names = new Set([...q.matchAll(/from:([A-Za-z0-9_]{1,15})/g)].map((m) => m[1].toLowerCase()));
  const tweets = all
    .filter((t) => names.has(String((t.author || {}).userName || '').toLowerCase()))
    .sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0))
    .slice(0, 20);
  console.log(`[${new Date().toLocaleTimeString()}] ${[...names].join(',')} → ${tweets.length} 条`);
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tweets, has_next_page: false, next_cursor: '' }));
  }, 1100);
}).listen(Number(port), '127.0.0.1', () => console.log(`mock upstream 在 http://127.0.0.1:${port}`));
