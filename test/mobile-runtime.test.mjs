import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
import fixtures from '../dev/fixtures.cjs';

test('真实 workerd / SQLite / Alarm：没有手机连接时自动抓取并保存，关闭后撤销 Alarm', { timeout: 30000 }, async () => {
  const worker = fileURLToPath(new URL('../relay/src/worker.js', import.meta.url));
  const bundle = await build({ stdin: { contents: `
    import worker, { LedgerDO, MobileScheduleDO } from ${JSON.stringify(worker)};
    export { LedgerDO };
    export class RuntimeSchedule extends MobileScheduleDO {
      async dueForTest() {
        await this.ctx.storage.put('next_run', Date.now() - 1);
        await this.ctx.storage.setAlarm(Date.now() + 30);
      }
      async hasAlarm() { return (await this.ctx.storage.getAlarm()) !== null; }
    }
    export default worker;`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-01',
    kvNamespaces: ['ACCESS'], durableObjects: {
      LEDGER: { className: 'LedgerDO', useSQLite: true }, MOBILE_SCHEDULE: { className: 'RuntimeSchedule', useSQLite: true },
    }, bindings: { ADMIN_TOKEN: 'runtime-test-only', TWITTERAPI_KEY: 'mock-only' },
    outboundService: async (request) => {
      assert.equal(new URL(request.url).hostname, 'api.twitterapi.io');
      calls++;
      return new Response(JSON.stringify({ tweets: fixtures.sampleTweets(['karpathy']), has_next_page: false, next_cursor: '' }));
    },
  }));
  try {
    const call = (route, token, body) => mf.dispatchFetch(`https://runtime.test${route}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const created = await (await call('/admin/codes', 'runtime-test-only', { name: 'runtime-only', plan: 'beta' })).json();
    assert.ok(created.account?.account_no, JSON.stringify(created));
    const number = created.account.account_no;
    const config = { enabled: true, days: [1, 4], time: '09:00', time_zone: 'Asia/Shanghai', follows: ['karpathy'], search_mode: 'Top', include_replies: false };
    const saved = await call('/v1/mobile/schedule', number, config);
    assert.equal(saved.status, 200, await saved.text());
    const namespace = await mf.getDurableObjectNamespace('MOBILE_SCHEDULE');
    const stub = namespace.get(namespace.idFromName(number));
    await stub.dueForTest();
    let result;
    for (let i = 0; i < 100; i++) {
      result = await (await call('/v1/mobile/feed', number)).json();
      if (result.last_run?.status && result.last_run.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(result.last_run?.status, 'success', JSON.stringify(result.last_run));
    assert.equal(result.tweets.length, 3);
    assert.equal(calls, 1);
    assert.equal(await stub.hasAlarm(), true);
    assert.equal((await call('/v1/mobile/schedule', number, { ...config, enabled: false })).status, 200);
    assert.equal(await stub.hasAlarm(), false);
  } finally { await mf.dispose(); }
});
