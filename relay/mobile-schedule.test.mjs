import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextScheduledAt, scheduleDefaults, validateSchedule } from './src/mobile-schedule.js';
import { startLab } from '../dev/lab-server.mjs';
import { MobileFeed } from '../mobile/model.mjs';

class MemoryStorage {
  data = new Map();
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
}
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-feed-schedule-'));
  const lab = await startLab({ root, environment: 'test' });
  t.after(async () => { await lab.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const number = (role = 'beta', scenario = 'normal') => lab.ledger.status(lab.accounts[`${role}:${scenario}`]).account_no;
  const call = (route, code, body) => fetch(`${lab.url}/v1/mobile/${route}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const config = { enabled: true, days: [1, 4], time: '09:00', time_zone: 'Asia/Shanghai',
    follows: ['karpathy', 'simonw'], search_mode: 'Top', include_replies: false };
  return { lab, number, call, config };
}

test('北京时间每周计划：跨 UTC 日期、指定工作日、整点只运行一次和停用', () => {
  const cfg = { ...scheduleDefaults(), enabled: true, days: [1, 4] };
  assert.equal(new Date(nextScheduledAt(cfg, Date.parse('2026-10-25T23:30:00Z'))).toISOString(), '2026-10-26T01:00:00.000Z');
  assert.equal(new Date(nextScheduledAt(cfg, Date.parse('2026-10-26T01:00:00Z'))).toISOString(), '2026-10-29T01:00:00.000Z');
  assert.equal(nextScheduledAt({ ...cfg, enabled: false }), null);
  assert.equal(new Date(nextScheduledAt({ ...cfg, days: [0], time: '00:15' }, Date.parse('2026-10-24T15:59:00Z'))).toISOString(), '2026-10-24T16:15:00.000Z');
});

test('定时配置严格校验日期、时间、用户名、频率和关注限制，拒绝客户端提权', () => {
  const account = { plan: 'beta', limits: { max_runs_per_week: 2, max_follows: 2 } };
  const valid = { enabled: true, follows: ['karpathy'] };
  assert.deepEqual(validateSchedule(valid, account).days, [1, 4]);
  assert.equal(validateSchedule({ enabled: false, days: [0, 1, 2, 3, 4, 5, 6] }, account).enabled, false);
  for (const patch of [{ days: [] }, { days: [8] }, { days: ['1'] }, { time: '25:00' }, { follows: [] },
    { follows: ['from:x OR keyword'] }, { days: [1, 2, 3] }, { follows: ['a', 'b', 'c'] }, { role: 'owner' }, { enabled: 'true' }]) {
    assert.throws(() => validateSchedule({ ...valid, ...patch }, account));
  }
});

test('真实 HTTP 定时抓取：页面关闭后执行、恢复结果、保留收藏、重试不重复扣费、关闭停止', async (t) => {
  const { lab, call, number, config } = await setup(t);
  const account = number();
  assert.equal((await call('schedule', 'DF-00000')).status, 401);
  assert.equal((await call('schedule', account, { ...config, role: 'owner' })).status, 400);
  const saved = await (await call('schedule', account, config)).json();
  assert.ok(saved.next_run > Date.now());
  assert.equal((await (await call('schedule', number('paid'))).json()).config.enabled, false);
  const obj = lab.schedules.get(account);
  const due = Date.now() - 1000;
  await obj.feed.storage.put('next_run', due);
  await obj.alarm(); // No browser or device session exists here.
  const result = await (await call('feed', account)).json();
  assert.equal(result.last_run.status, 'success');
  assert.equal(result.tweets.length, 6);
  assert.equal(lab.ledger.status(account).quota.used_credits, 90);
  await obj.feed.storage.put('next_run', due);
  await obj.alarm();
  assert.equal(lab.ledger.status(account).quota.used_credits, 90);
  const store = new MemoryStorage();
  const device = new MobileFeed(store, { relayUrl: lab.url });
  await device.login(account);
  assert.equal(await device.syncScheduled(), 6);
  const first = device.list()[0].raw.id;
  await device.flag(first, 'starred');
  await device.flag(first, 'read');
  assert.equal(await device.syncScheduled(), 0);
  assert.equal(device.list({ view: 'starred' }).length, 1);
  assert.equal(device.list({ view: 'unread' }).length, 5);
  const stopped = await (await call('schedule', account, { ...config, enabled: false })).json();
  assert.equal(stopped.next_run, null);
  assert.equal(await obj.feed.storage.get('alarm'), undefined);
  await obj.alarm();
  assert.equal(lab.ledger.status(account).quota.used_credits, 90);
  lab.ledger.update(account, { disabled: true });
  assert.equal((await call('feed', account)).status, 401);
  assert.equal((await call('schedule', account, config)).status, 401);
});

test('定时额度不足和分组部分失败：不重复消费，保留已完成分组，并安排下次计划', async (t) => {
  const { lab, call, number, config } = await setup(t);
  const account = number();
  lab.ledger.update(account, { monthly_credits: 350 });
  await call('schedule', account, { ...config, follows: ['karpathy', 'simonw', 'emollick', 'swyx', 'paulg'] });
  const obj = lab.schedules.get(account);
  await obj.feed.storage.put('next_run', Date.now() - 1);
  await obj.alarm();
  const saved = await obj.read();
  assert.equal(saved.last_run.status, 'error');
  assert.match(saved.last_run.message, /额度/);
  assert.equal((await obj.posts()).tweets.length, 12);
  assert.equal(lab.ledger.status(account).quota.used_credits, 180);
  assert.ok(saved.next_run > Date.now());
  const exhausted = number('beta', 'exhausted');
  await call('schedule', exhausted, config);
  const empty = lab.schedules.get(exhausted);
  await empty.feed.storage.put('next_run', Date.now() - 1);
  await empty.alarm();
  assert.equal((await empty.posts()).tweets.length, 0);
  assert.equal(lab.ledger.status(exhausted).quota.used_credits, 300);
});
