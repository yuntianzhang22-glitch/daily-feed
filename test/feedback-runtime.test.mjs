import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import feedback from '../desktop/core/feedback.js';
const sample = { id: '123', text: 'Research results and interpretation', author: { userName: 'sample' },
  quoted_tweet: { id: '456', text: 'Original study', author: { userName: 'lab' } } };
const event = (value = 1, expected_revision = 0, event_id = crypto.randomUUID()) => ({ event_id, value, expected_revision,
  snapshot: feedback.snapshotFromRaw(sample), context: { platform: 'desktop', algorithm_version: 'baseline-v1' } });

test('真实 workerd/SQLite/RPC：三种身份反馈、账号隔离、重试并发、停用与管理员导出', { timeout: 30000 }, async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../relay/src/worker.js', import.meta.url))], bundle: true,
    write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-01',
    kvNamespaces: ['ACCESS'], durableObjects: { LEDGER: { className: 'LedgerDO', useSQLite: true }, FEEDBACK: { className: 'FeedbackDO', useSQLite: true } },
    bindings: { ADMIN_TOKEN: 'runtime-test-only' }, outboundService: () => { assert.fail('反馈不应调用 X 或其他外部服务'); },
  }));
  const call = (route, token, body) => mf.dispatchFetch(`https://test.local${route}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await call('/v1/feedback', '', event())).status, 401);
    const tokens = [];
    for (const plan of ['owner', 'beta', 'paid']) {
      const created = await (await call('/admin/codes', 'runtime-test-only', { name: `fixture-${plan}`, plan })).json();
      tokens.push(created.account.account_no);
      const r = await call('/v1/feedback', created.account.account_no, { ...event(), account_no: tokens[0], role: 'owner' });
      assert.equal(r.status, 200, await r.clone().text()); assert.equal(r.headers.get('Cache-Control'), 'no-store');
      assert.equal((await r.json()).state.value, 1);
    }
    // A paid account with zero balance can still participate; feedback does not spend credits.
    const before = await (await mf.dispatchFetch('https://test.local/v1/status', { headers: { Authorization: `Bearer ${tokens[2]}` } })).json();
    assert.equal(before.balance.cny, 0);
    const oversized = await call('/v1/feedback', tokens[0], { ...event(), padding: 'x'.repeat(524289) });
    assert.equal(oversized.status, 413);
    const after = await (await mf.dispatchFetch('https://test.local/v1/status', { headers: { Authorization: `Bearer ${tokens[2]}` } })).json();
    assert.deepEqual(after.balance, before.balance);
    assert.deepEqual(after.quota, before.quota);
    const down = event(-1, 1); down.snapshot.metrics.likeCount = 100;
    const duplicate = await Promise.all([call('/v1/feedback', tokens[0], down), call('/v1/feedback', tokens[0], down)]);
    for (const r of duplicate) assert.equal(r.status, 200);
    assert.equal((await call('/v1/feedback', tokens[0], event(0, 1))).status, 409);
    assert.equal((await (await call('/v1/feedback/read', tokens[0], { ids: ['123'] })).json()).states['123'].value, -1);
    assert.equal((await (await call('/v1/feedback/read', tokens[1], { ids: ['123'] })).json()).states['123'].value, 1);
    assert.equal((await (await call('/v1/feedback/read', tokens[1], { ids: ['999'] })).json()).states['999'].value, 0);
    for (const token of tokens) {
      assert.equal((await call('/admin/feedback/stats', token)).status, 403);
      assert.equal((await call('/admin/feedback/export', token)).status, 403);
    }
    const stats = await (await call('/admin/feedback/stats', 'runtime-test-only')).json();
    assert.deepEqual(stats.totals, { participants: 3, posts: 1, up: 2, down: 1, changes: 4 });
    const exported = await (await call('/admin/feedback/export?kind=events&limit=2', 'runtime-test-only')).json();
    assert.equal(exported.records.length, 2); assert.ok(exported.next_cursor);
    for (const token of tokens) assert.ok(!JSON.stringify(exported).includes(token));
    assert.equal(exported.records[0].snapshot.quoted.text, 'Original study');
    const allEvents = await (await call('/admin/feedback/export?kind=events', 'runtime-test-only')).json();
    assert.equal(new Set(allEvents.records.map((r) => r.content_hash)).size, 1, '互动量变化不能把同一内容拆成不同样本组');
    assert.equal((await call('/v1/feedback', tokens[0], { ...event(), snapshot: { id: 'bad' } })).status, 400);
    await call('/admin/account', 'runtime-test-only', { ref: tokens[0], patch: { disabled: true } });
    assert.equal((await call('/v1/feedback', tokens[0], event(0, 2))).status, 401);
    assert.equal((await call('/v1/feedback/read', tokens[0], { ids: ['123'] })).status, 401);
  } finally { await mf.dispose(); }
});
