const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveEnvironment, profilePath, localCode, SCENARIOS } = require('../desktop/core/environment');
const { FeedClient } = require('../desktop/core/client');

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
