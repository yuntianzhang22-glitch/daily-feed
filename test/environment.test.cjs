const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveEnvironment, profilePath, localCode, SCENARIOS } = require('../desktop/core/environment');
const { FeedClient, resolveAccess } = require('../desktop/core/client');
const { identityFor, requirePermission, verifiedAccountRole, visibleSettings, applySettings, fetchSettings } = require('../desktop/core/permissions');

test('用户身份不能通过访问码或配置字段升级；普通身份不能读取/修改超管配置', () => {
  const before = { version: 3, follows: ['karpathy'], keywords: ['secret query'], group_size: 8, max_pages: 10, avg_posts_per_day: 5 };
  for (const role of ['beta', 'paid', 'guest', 'unknown']) {
    assert.throws(() => requirePermission(role, 'configureApi'), { code: 'permission_denied' });
    assert.throws(() => requirePermission(role, 'viewApiCosts'), { code: 'permission_denied' });
    for (const patch of [{ keywords: [] }, { max_pages: 10 }, { role: 'owner' }, { permissions: { configureApi: true } }]) {
      assert.throws(() => applySettings(before, patch, role), { code: 'permission_denied' });
    }
    assert.deepEqual(visibleSettings(before, role), { version: 3, follows: ['karpathy'] });
    assert.deepEqual(fetchSettings(before, role).keywords, []);
    assert.equal(fetchSettings(before, role).max_pages, 1);
    assert.deepEqual(applySettings(before, { follows: ['simonw'] }, role).follows, ['simonw']);
  }
  assert.equal(verifiedAccountRole('paid'), 'paid');
  assert.equal(verifiedAccountRole(), 'beta'); // 兼容旧中转：不带 plan 的有效访问码只授予内测权限
  assert.equal(verifiedAccountRole('owner'), 'owner');
  assert.throws(() => verifiedAccountRole('admin'));
  assert.equal(identityFor('beta').permissions.viewMonthlyQuota, true);
  assert.equal(identityFor('beta').permissions.viewBalance, false);
  assert.equal(identityFor('paid').permissions.viewBalance, true);
  assert.equal(identityFor('paid').permissions.viewMonthlyQuota, false);
  assert.doesNotThrow(() => requirePermission('owner', 'configureApi'));
  assert.doesNotThrow(() => requirePermission('owner', 'configureAccessCode'));
});

test('超管的自用 API Key 优先于残留内测码；仅有访问码的用户继续走中转', () => {
  const relay = { relayUrl: 'https://relay.example', accessCode: 'df_old_beta_code' };
  assert.deepEqual(resolveAccess({ ...relay, apiKey: 'own-key' }), { mode: 'direct', apiKey: 'own-key' });
  assert.deepEqual(resolveAccess({ ...relay, apiKey: 'own-key', preferAccount: true }), { mode: 'relay', ...relay });
  assert.deepEqual(resolveAccess(relay), { mode: 'relay', ...relay });
  assert.deepEqual(resolveAccess({ apiKey: 'own-key' }), { mode: 'direct', apiKey: 'own-key' });
  assert.deepEqual(resolveAccess({ relayUrl: relay.relayUrl }), { mode: 'none' });
});

const appConfig = { relayUrl: 'https://production.example', updateManifestUrl: 'https://production.example/v1/latest' };
test('非正式环境拒绝缺失服务、正式服务回退、远程控制和打包安装包', () => {
  for (const name of ['test', 'staging']) {
    for (const url of ['', appConfig.relayUrl, 'http://localhost:1234', 'http://127.0.0.1:1/evil']) {
      assert.throws(() => resolveEnvironment({ env: { DAILY_FEED_ENV: name, DAILY_FEED_LAB_URL: url, DAILY_FEED_LAB_TOKEN: 'token' }, appConfig, localRoot: '/tmp/df' }));
    }
    assert.throws(() => resolveEnvironment({ env: { DAILY_FEED_ENV: name }, packaged: true }));
  }
  assert.throws(() => resolveEnvironment({ env: { DAILY_FEED_ENV: 'typo' } }));
});
test('所有环境、身份和状态使用不同目录，验收不使用正式更新地址', () => {
  const dirs = [];
  for (const environment of ['test', 'staging']) for (const [role, scenarios] of Object.entries(SCENARIOS)) for (const scenario of Object.keys(scenarios)) {
    const runtime = resolveEnvironment({ env: { DAILY_FEED_ENV: environment, DAILY_FEED_LAB_URL: 'http://127.0.0.1:1234', DAILY_FEED_LAB_TOKEN: 't', DAILY_FEED_ROLE: role, DAILY_FEED_SCENARIO: scenario, DAILY_FEED_RELAY: appConfig.relayUrl, DAILY_FEED_MANIFEST: appConfig.updateManifestUrl }, appConfig, localRoot: '/tmp/df' });
    assert.equal(runtime.relayUrl, 'http://127.0.0.1:1234');
    assert.equal(runtime.updateManifestUrl, '');
    dirs.push(runtime.dataPath);
  }
  assert.equal(new Set(dirs).size, dirs.length);
  assert.throws(() => profilePath('/tmp', 'production', 'owner', 'normal'));
  assert.throws(() => profilePath('/tmp', 'test', '../../production', 'normal'));
  assert.notEqual(localCode('test', 'paid', 'normal'), localCode('staging', 'paid', 'normal'));
  assert.equal(resolveEnvironment({ env: {}, appConfig }).relayUrl, appConfig.relayUrl);
});
test('API Key 的替代上游只接受本机，不能发送到任意远程地址', () => {
  assert.throws(() => new FeedClient({ mode: 'direct', apiKey: 'key', directBase: 'https://evil.example' }));
  assert.doesNotThrow(() => new FeedClient({ mode: 'direct', apiKey: 'key', directBase: 'http://127.0.0.1:1234' }));
});
