import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationService, validateTexts } from './src/translation.js';
function setup({ limit = 1800000, enabled = true, provider } = {}) {
  const values = new Map(); let alarm = null; let calls = 0; let date = new Date('2026-10-28T00:00:00Z');
  const storage = { get: async (key) => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)),
    getAlarm: async () => alarm, setAlarm: async (at) => { alarm = at; },
    delete: async (keys) => keys.forEach((k) => values.delete(k)),
    list: async ({ prefix, limit, startAfter = '' }) => new Map([...values].filter(([k]) => k.startsWith(prefix) && k > startAfter).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
  };
  const service = new TranslationService(storage, { TRANSLATION_TIER: enabled ? 'F0' : 'disabled', AZURE_TRANSLATOR_KEY: 'test-secret', TRANSLATION_MONTHLY_LIMIT: limit }, async (url, init) => {
    calls++;
    assert.ok(url.startsWith('https://api.cognitive.microsofttranslator.com/translate?'));
    assert.equal(init.headers['Ocp-Apim-Subscription-Key'], 'test-secret');
    return provider ? provider(url, init) : Response.json(JSON.parse(init.body).map(({ Text }) => ({ translations: [{ text: `中文：${Text}` }] })));
  }, () => date);
  return { service, values, calls: () => calls, date: (d) => { date = new Date(d); } };
}
test('正文与引用翻译、跨账号缓存、并发去重和空正文对齐', async () => {
  const { service, calls } = setup();
  const [a, b] = await Promise.all([service.translate('DF-AAAAA', { texts: ['hello', 'quote'] }), service.translate('DF-BBBBB', { texts: ['hello', 'quote'] })]);
  assert.deepEqual(a.texts, ['中文：hello', '中文：quote']); assert.equal(b.cached, true); assert.equal(calls(), 1);
  assert.deepEqual((await service.translate('DF-AAAAA', { texts: ['', 'hello'] })).texts, ['', '中文：hello']);
  assert.equal(calls(), 1);
});
test('免费开关、非法输入不调用供应商', async () => {
  const { service, calls } = setup({ enabled: false });
  await assert.rejects(service.translate('a', { texts: ['hello'] }), { code: 'translation_unavailable' });
  for (const body of [{}, { texts: [] }, { texts: [''] }, { texts: [1] }, { texts: ['a'.repeat(16001)] }, { texts: ['a', 'b', 'c'] }]) assert.throws(() => validateTexts(body));
  assert.equal(calls(), 0);
});
test('预算先持久化、失败不退款、并发不能突破免费预算、跨月恢复', async () => {
  const { service, calls, date, values } = setup({ limit: 5, provider: () => new Response('provider secret debug', { status: 500 }) });
  const results = await Promise.allSettled([service.translate('a', { texts: ['hello'] }), service.translate('b', { texts: ['world'] })]);
  assert.equal(results[0].reason.code, 'translation_failed'); assert.equal(results[1].reason.code, 'translation_quota');
  assert.equal(calls(), 1); assert.equal(values.get('usage').chars, 5);
  assert.ok(!JSON.stringify(results).includes('provider secret'));
  date('2026-11-01T00:00:00Z');
  await assert.rejects(service.translate('a', { texts: ['hello'] }), { code: 'translation_failed' }); assert.equal(calls(), 2);
});
test('每日账号限制和缓存到期清理', async () => {
  const { service, date, calls, values } = setup();
  for (let i = 0; i < 3; i++) await service.translate('a', { texts: [String(i).repeat(13000)] });
  await assert.rejects(service.translate('a', { texts: ['a'.repeat(1001)] }), { code: 'translation_daily' });
  date('2026-10-29T00:00:00Z'); await service.translate('a', { texts: ['a'.repeat(1001)] }); assert.equal(calls(), 4);
  date('2026-12-01T00:00:00Z'); await service.cleanup(); assert.equal([...values.keys()].filter((k) => k.startsWith('cache:')).length, 0);
});
test('无效供应商返回不写缓存，重复文本只翻译一次', async () => {
  const invalid = setup({ provider: () => Response.json([]) });
  await assert.rejects(invalid.service.translate('a', { texts: ['hello'] }), { code: 'translation_failed' });
  assert.equal([...invalid.values.keys()].filter((k) => k.startsWith('cache:')).length, 0);
  const { service, values } = setup();
  assert.deepEqual((await service.translate('a', { texts: ['same', 'same'] })).texts, ['中文：same', '中文：same']);
  assert.equal(values.get('usage').chars, 4);
});
