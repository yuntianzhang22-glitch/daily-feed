import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveEntry } from '../mobile/entry-worker.mjs';

const request = (path, init) => new Request(`https://daily-feed-reader.pages.dev${path}`, init);
test('独立域名转发手机资源、登录凭证与抓取请求；不会跳回旧域名', async () => {
  const calls = [];
  const upstream = async (req) => {
    calls.push(req);
    if (new URL(req.url).pathname === '/mobile/index.html') return Response.redirect('https://daily-feed-relay.roam-travel-planner.workers.dev/mobile/', 308);
    return new Response(req.method === 'POST' ? await req.text() : 'ok', { headers: { 'Cache-Control': 'no-store' } });
  };
  const home = await serveEntry(request('/'), upstream);
  assert.equal(home.headers.get('Location'), 'https://daily-feed-reader.pages.dev/mobile/');
  assert.equal((await serveEntry(request('/mobile/'), upstream)).status, 200);
  const status = await serveEntry(request('/v1/status', { headers: { Authorization: 'Bearer DF-ABCDE', Cookie: 'private=value' } }), upstream);
  assert.equal(status.status, 200);
  assert.equal(calls.at(-1).headers.get('Authorization'), 'Bearer DF-ABCDE');
  assert.equal(calls.at(-1).headers.get('Cookie'), null);
  const search = await serveEntry(request('/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"query":"from:karpathy"}' }), upstream);
  assert.equal(await search.text(), '{"query":"from:karpathy"}');
  assert.equal(calls.at(-1).method, 'POST');
  assert.equal((await serveEntry(request('/mobile/index.html'), upstream)).headers.get('Location'), 'https://daily-feed-reader.pages.dev/mobile/');
});
test('独立入口拒绝管理请求、任意转发目标和意外重定向', async () => {
  const upstream = async () => { throw new Error('不应该转发'); };
  for (const path of ['/admin/codes', '/v1/latest', '/.env', '/mobile/secret', '//evil.test/', '/v1/status/extra']) {
    assert.equal((await serveEntry(request(path), upstream)).status, 404);
  }
  assert.equal((await serveEntry(request('/v1/status', { method: 'POST' }), upstream)).status, 404);
  assert.equal((await serveEntry(request('/mobile/', { method: 'POST' }), upstream)).status, 404);
  const redirect = await serveEntry(request('/mobile/'), async () => Response.redirect('https://evil.test/', 302));
  assert.equal(redirect.status, 502);
  const failed = await serveEntry(request('/mobile/'), async () => { throw new Error('network'); });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('travel-planner'));
});

test('移动入口转发本人反馈及读取，拒绝反馈管理统计/导出', async () => {
  for (const path of ['/v1/feedback', '/v1/feedback/read']) {
    const body = path.endsWith('/read') ? '{"ids":["123"]}' : '{"value":1}';
    const result = await serveEntry(request(path, { method: 'POST', headers: { Authorization: 'Bearer DF-ABCDE', 'Content-Type': 'application/json' }, body }), async (req) => {
      assert.equal(new URL(req.url).pathname, path);
      assert.equal(req.headers.get('Authorization'), 'Bearer DF-ABCDE');
      assert.equal(await req.text(), body);
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    });
    assert.equal(result.status, 200); assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal((await serveEntry(request(path), () => assert.fail('GET 不能转发'))).status, 404);
  }
  for (const path of ['/admin/feedback/stats', '/admin/feedback/export']) assert.equal((await serveEntry(request(path), () => assert.fail('管理接口不能转发'))).status, 404);
});
