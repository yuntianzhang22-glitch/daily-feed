import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLab } from '../dev/lab-server.mjs';
import profiles from '../desktop/core/environment.js';
import clientModule from '../desktop/core/client.js';
import storeModule from '../desktop/core/store.js';
import fetcherModule from '../desktop/core/fetcher.js';

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'daily-feed-lab-'));
const clientFor = (lab, environment, role, scenario = 'normal') => new clientModule.FeedClient(
  { mode: 'relay', relayUrl: lab.url, accessCode: profiles.localCode(environment, role, scenario), maxRetries: 0 });
const query = '((from:karpathy OR from:simonw) -filter:replies) since_time:1';

test('真实 HTTP + Worker + 账本：三种身份、额度耗尽、余额不足、停用、充值恢复', async () => {
  const root = temporary();
  const lab = await startLab({ root, environment: 'test' });
  try {
    for (const role of ['owner', 'beta', 'paid']) {
      const client = clientFor(lab, 'test', role);
      const store = new storeModule.Store(path.join(root, `${role}.db`));
      try {
        const errors = [];
        const result = await fetcherModule.runOnce(client, store, { follows: ['karpathy', 'simonw'], max_per_target: 3, max_pages: 1 }, { errors });
        assert.equal(errors.length, 0);
        assert.equal(Object.values(result).flat().length, 6);
        assert.ok(store.list().every((t) => t.created_at && t.post));
        if (role !== 'owner') assert.equal((await client.status()).quota.used_credits, 90);
      } finally { store.close(); }
    }
    for (const [role, scenario, code] of [
      ['beta', 'exhausted', 'quota_exceeded'], ['paid', 'empty', 'balance_empty'],
      ['beta', 'disabled', 'invalid_code'], ['paid', 'disabled', 'invalid_code'],
    ]) {
      await assert.rejects(clientFor(lab, 'test', role, scenario).searchPage(query, 'Top', ''), (e) => e.code === code);
    }
    const low = await clientFor(lab, 'test', 'paid', 'low').status();
    assert.equal(low.balance.cny, 0.5);
    const empty = clientFor(lab, 'test', 'paid', 'empty');
    const status = await empty.status();
    const topped = await fetch(`${lab.url}/admin/topup`, { method: 'POST',
      headers: { Authorization: `Bearer ${lab.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: status.account_no, cny: 10, note: 'test' }) });
    assert.equal(topped.status, 200);
    assert.equal((await empty.searchPage(query, 'Top', '')).tweets.length, 6);
    assert.ok((await empty.status()).balance.cny < 10);
    assert.equal((await fetch(`${lab.url}/admin/codes`)).status, 403);
    assert.equal((await fetch(`${lab.url}/admin/codes`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${lab.url}/twitter/tweet/advanced_search`)).status, 401);
  } finally { await lab.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('测试与预发不共用账号/余额；重启保留本地充值，不能使用另一个环境的访问码', async () => {
  const root = temporary();
  const testLab = await startLab({ root, environment: 'test' });
  const stagingLab = await startLab({ root, environment: 'staging' });
  try {
    testLab.ledger.topup(testLab.accounts['paid:empty'], 10, 'test only');
    assert.equal((await clientFor(testLab, 'test', 'paid', 'empty').status()).balance.cny, 10);
    assert.equal((await clientFor(stagingLab, 'staging', 'paid', 'empty').status()).balance.cny, 0);
    await assert.rejects(clientFor(stagingLab, 'test', 'beta').status(), (e) => e.status === 401);
  } finally { await testLab.close(); await stagingLab.close(); }
  const reopened = await startLab({ root, environment: 'test' });
  try { assert.equal((await clientFor(reopened, 'test', 'paid', 'empty').status()).balance.cny, 10); }
  finally { await reopened.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('预发真实 API 未配置时不回退到正式密钥；测试环境禁止真实 API', async () => {
  const root = temporary();
  await assert.rejects(startLab({ root, environment: 'production' }));
  await assert.rejects(startLab({ root, environment: 'test', liveApiKey: 'never-send' }));
  fs.rmSync(root, { recursive: true, force: true });
});
