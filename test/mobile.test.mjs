import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../relay/src/worker.js';
import { startLab } from '../dev/lab-server.mjs';
import { MobileFeed } from '../mobile/model.mjs';

class MemoryStorage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
}
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-feed-mobile-'));
  const lab = await startLab({ root, environment: 'test' });
  t.after(async () => { await lab.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const storage = new MemoryStorage();
  return { lab, storage, feed: new MobileFeed(storage, { relayUrl: lab.url }),
    account: (role, scenario = 'normal') => lab.ledger.status(lab.accounts[`${role}:${scenario}`]).account_no };
}

test('移动版真实 HTTP：登录、关注抓取、完整正文、搜索、标记持久化、账号隔离', async (t) => {
  const { lab, feed, storage, account } = await setup(t);
  await feed.login(account('beta').toLowerCase().replace('-', ''));
  await feed.setFollows(['@karpathy', 'simonw', 'KARPATHY']);
  assert.deepEqual(feed.data.follows, ['karpathy', 'simonw']);
  assert.equal(await feed.fetchNow(), 6);
  const first = feed.list()[0];
  await feed.flag(first.raw.id, 'starred');
  await feed.flag(first.raw.id, 'read');
  assert.equal(feed.list({ view: 'starred' }).length, 1);
  assert.equal(feed.list({ view: 'unread' }).length, 5);
  assert.equal(feed.list({ query: 'simonw' }).length, 3);
  assert.equal(feed.list({ source: 'user:karpathy' }).length, 3);
  assert.equal(feed.list({ sort: 'likes' })[0].raw.likeCount, 170);
  assert.ok(Object.keys(feed.data.state).some((key) => key.startsWith('last_run:group:')));
  await feed.logout();
  assert.equal(feed.list().length, 0);
  assert.equal(await storage.get('session'), undefined);
  await feed.login(account('paid'));
  assert.equal(feed.list().length, 0);
  assert.deepEqual(feed.data.follows, []);
  await feed.login(account('beta'));
  assert.equal(feed.list({ view: 'starred' }).length, 1);
  const restored = new MobileFeed(storage, { relayUrl: lab.url });
  assert.equal(await restored.restore(), true);
  assert.equal(restored.list().length, 6);
  await restored.refreshAccount();
  assert.equal(restored.account.quota.used_credits, 90);
  await feed.logout();
  assert.equal(await new MobileFeed(storage, { relayUrl: lab.url }).restore(), false);
});

test('移动版拒绝停用/额度耗尽/未充值；客户端篡改身份不能突破服务端', async (t) => {
  const { lab, feed, account } = await setup(t);
  await assert.rejects(feed.login('DF-00000'), (e) => e.status === 401);
  for (const [role, scenario, code] of [['beta', 'exhausted', 'quota_exceeded'], ['paid', 'empty', 'balance_empty']]) {
    await feed.login(account(role, scenario));
    await feed.setFollows(['karpathy']);
    await assert.rejects(feed.fetchNow(), (e) => e.code === code);
    assert.equal(feed.list().length, 0);
    assert.equal(feed.busy, false);
  }
  await feed.login(account('beta'));
  lab.ledger.update(account('beta'), { disabled: true });
  await assert.rejects(feed.refreshAccount(), (e) => e.code === 'invalid_code');
  assert.equal(feed.session, null);
  assert.equal(feed.list().length, 0);
});

test('移动版离线只恢复之前成功的账号；联网停用后清除会话', async (t) => {
  const { lab, feed, storage, account } = await setup(t);
  await feed.login(account('beta'));
  await feed.setFollows(['simonw']);
  const offline = new MobileFeed(storage, { relayUrl: lab.url, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await offline.restore(), true);
  assert.equal(offline.offline, true);
  assert.deepEqual(offline.data.follows, ['simonw']);
  lab.ledger.update(account('beta'), { disabled: true });
  const denied = new MobileFeed(storage, { relayUrl: lab.url });
  await assert.rejects(denied.restore(), (e) => e.code === 'invalid_code');
  assert.equal(await storage.get('session'), undefined);
});

test('关注数量限制、保存失败回滚、抓取中防止切换账号', async (t) => {
  const { feed, storage, account } = await setup(t);
  await feed.login(account('beta'));
  feed.account.limits.max_follows = 1;
  await assert.rejects(feed.setFollows(['karpathy', 'simonw']), /最多关注/);
  await feed.setFollows(['simonw']);
  const original = storage.put;
  storage.put = async () => { throw new Error('storage-full'); };
  await assert.rejects(feed.setFollows(['karpathy']), /storage-full/);
  assert.deepEqual(feed.data.follows, ['simonw']);
  storage.put = original;
  feed.busy = true;
  await assert.rejects(feed.login(account('paid')), /等待/);
  await assert.rejects(feed.logout(), /等待/);
  await assert.rejects(feed.setFollows(['karpathy']), /等待/);
});

test('后续分组失败时仍保留已经抓取的数据和进度，可重新登录读取', async (t) => {
  const { lab, storage, account } = await setup(t);
  let searches = 0;
  const feed = new MobileFeed(storage, { relayUrl: lab.url, fetchImpl: async (url, init) => {
    if (url.endsWith('/v1/search') && ++searches === 2) return new Response(JSON.stringify({ code: 'quota_exceeded' }), { status: 429 });
    return fetch(url, init);
  } });
  await feed.login(account('beta'));
  await feed.setFollows(['karpathy', 'simonw', 'emollick', 'swyx', 'paulg']);
  await assert.rejects(feed.fetchNow(), (e) => e.code === 'quota_exceeded' && e.added === 12);
  await feed.logout();
  await feed.login(account('beta'));
  assert.equal(feed.list().length, 12);
  assert.equal(Object.keys(feed.data.state).length, 1);
});

test('清空关注时关闭已启用的云端定时抓取，保留帖子和收藏；网络失败可重试', async (t) => {
  const { feed, storage, account, lab } = await setup(t);
  await feed.login(account('beta'));
  await feed.setFollows(['karpathy']);
  await feed.fetchNow();
  const first = feed.list()[0].raw.id;
  await feed.flag(first, 'starred');
  await feed.saveSchedule({ enabled: true, days: [1, 4], time: '09:30' });
  const fetchImpl = feed.fetchImpl;
  feed.fetchImpl = async () => { throw new Error('offline'); };
  await assert.rejects(feed.setFollows([]), /网络|offline/);
  assert.deepEqual(feed.data.follows, ['karpathy']);
  assert.equal(feed.schedule.config.enabled, true);
  feed.fetchImpl = fetchImpl;
  await feed.setFollows([]);
  assert.deepEqual(feed.data.follows, []);
  assert.equal(feed.schedule.config.enabled, false);
  assert.deepEqual(feed.schedule.config.days, [1, 4]);
  assert.equal(feed.schedule.config.time, '09:30');
  assert.equal(feed.schedule.next_run, null);
  assert.equal(await lab.schedules.get(account('beta')).feed.storage.get('alarm'), undefined);
  const restored = new MobileFeed(storage, { relayUrl: lab.url });
  await restored.restore();
  await restored.loadSchedule();
  assert.deepEqual(restored.data.follows, []);
  assert.equal(restored.schedule.config.enabled, false);
  assert.equal(restored.list().length, 3);
  assert.equal(restored.list({ view: 'starred' }).length, 1);
});

test('移动资源经过安全头；API 和管理接口不回退 HTML，也不开放 CORS', async () => {
  const paths = [];
  const env = { ASSETS: { fetch: async (request) => { paths.push(new URL(request.url).pathname); return new Response('<html></html>'); } } };
  const call = (pathname, method = 'GET') => worker.fetch(new Request(`https://relay.test${pathname}`, { method }), env);
  assert.equal((await call('/')).headers.get('Location'), 'https://relay.test/mobile/');
  const response = await call('/mobile/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('Cache-Control'), 'no-cache');
  assert.equal((await call('/v1/missing')).status, 404);
  assert.equal((await call('/admin/codes')).status, 403);
  assert.equal((await call('/mobile/', 'POST')).status, 404);
  assert.deepEqual(paths, ['/mobile/']);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});
