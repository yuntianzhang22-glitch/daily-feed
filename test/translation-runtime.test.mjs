import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

test('真实 workerd/SQLite/RPC：翻译并发去重、持久缓存及预算上限', { timeout: 30000 }, async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../relay/src/worker.js', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-01',
    kvNamespaces: ['ACCESS'], durableObjects: { LEDGER: { className: 'LedgerDO', useSQLite: true }, TRANSLATION: { className: 'TranslationDO', useSQLite: true } },
    bindings: { ADMIN_TOKEN: 'test-only', AZURE_TRANSLATOR_KEY: 'mock-only', TRANSLATION_TIER: 'F0', TRANSLATION_MONTHLY_LIMIT: '10' },
    outboundService: async (request) => {
      assert.equal(new URL(request.url).hostname, 'api.cognitive.microsofttranslator.com'); calls++;
      return Response.json((await request.json()).map(({ Text }) => ({ translations: [{ text: '中文：' + Text }] })));
    },
  }));
  try {
    const call = (path, token, body) => mf.dispatchFetch('https://runtime.test' + path, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const accounts = [];
    for (const plan of ['owner', 'beta', 'paid']) {
      const created = await (await call('/admin/codes', 'test-only', { name: 'test-only', plan })).json();
      assert.ok(created.account?.account_no, JSON.stringify(created)); accounts.push(created.account.account_no);
    }
    const responses = await Promise.all(accounts.map((token) => call('/v1/translate', token, { texts: ['hello'] })));
    for (const r of responses) { assert.equal(r.status, 200); assert.deepEqual((await r.json()).texts, ['中文：hello']); }
    assert.equal(calls, 1);
    assert.equal((await call('/v1/translate', accounts[0], { texts: ['world!'] })).status, 429);
    assert.equal(calls, 1);
    assert.equal((await call('/v1/translate', accounts[0], { texts: ['hello'] })).status, 200);
    const ns = await mf.getDurableObjectNamespace('TRANSLATION'); const stub = ns.get(ns.idFromName('main'));
    assert.equal((await stub.translate(accounts[0], { texts: ['hello'] })).cached, true);
  } finally { await mf.dispose(); }
});
