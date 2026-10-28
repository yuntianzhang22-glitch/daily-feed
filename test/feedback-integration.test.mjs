import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startLab } from '../dev/lab-server.mjs';
import feedback from '../desktop/core/feedback.js';
import clients from '../desktop/core/client.js';
import profiles from '../desktop/core/environment.js';
const exec = promisify(execFile);
const snapshot = feedback.snapshotFromRaw({ id: '123', text: 'A study with a reproducible method', author: { userName: 'sample' } });
const client = (lab, environment, code) => new clients.FeedClient({ mode: 'relay', relayUrl: lab.url, accessCode: code || profiles.localCode(environment, 'beta', 'normal'), maxRetries: 0 });
const stats = async (lab) => (await fetch(lab.url + '/admin/feedback/stats', { headers: { Authorization: `Bearer ${lab.token}` } })).json();

test('真实 HTTP：测试/预发数据隔离、跨设备同账号读取、服务重启持久化、管理 CLI 导出', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-feed-feedback-'));
  let lab = await startLab({ root, environment: 'test' });
  const staging = await startLab({ root, environment: 'staging' });
  try {
    const first = client(lab, 'test'), account = await first.status();
    const event = { event_id: crypto.randomUUID(), expected_revision: 0, value: 1, snapshot, context: { platform: 'desktop' } };
    await first.submitFeedback(event);
    const otherDevice = client(lab, 'test', account.account_no);
    assert.equal((await otherDevice.readFeedback(['123'])).states['123'].value, 1);
    assert.equal((await client(staging, 'staging').readFeedback(['123'])).states['123'].value, 0);
    assert.equal((await stats(staging)).totals.changes, 0);
    // These CLI calls target ONLY the explicitly injected local fixture server.
    const env = { ...process.env, DAILY_FEED_PROXY_SET: '1', DAILY_FEED_RELAY: lab.url, DAILY_FEED_ADMIN_TOKEN: lab.token };
    const summary = JSON.parse((await exec(process.execPath, ['relay/admin.mjs', '--env', 'production', 'feedback-stats'], { env })).stdout);
    assert.equal(summary.totals.up, 1);
    const exportFile = path.join(root, 'feedback.jsonl');
    await exec(process.execPath, ['relay/admin.mjs', '--env', 'production', 'feedback-export', 'events', exportFile], { env });
    const records = fs.readFileSync(exportFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1); assert.equal(records[0].snapshot.text, snapshot.text);
    assert.ok(!fs.readFileSync(exportFile, 'utf8').includes(account.account_no));
    assert.equal(fs.statSync(exportFile).mode & 0o777, 0o600);
    await lab.close(); lab = await startLab({ root, environment: 'test' });
    assert.equal((await client(lab, 'test', account.account_no).readFeedback(['123'])).states['123'].value, 1);
    assert.equal((await stats(lab)).totals.changes, 1);
  } finally { await lab.close(); await staging.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('丢失成功响应后重启客户端：复用事件编号重传，服务端只计一次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-feed-feedback-ack-'));
  const lab = await startLab({ root, environment: 'test' });
  try {
    let persisted, loseAck = true;
    const storage = { get: async () => structuredClone(persisted), put: async (data) => { persisted = structuredClone(data); } };
    const upstream = client(lab, 'test');
    const proxy = { readFeedback: (ids) => upstream.readFeedback(ids), submitFeedback: async (event) => {
      const result = await upstream.submitFeedback(event);
      if (loseAck) { loseAck = false; throw new Error('simulated lost response after server commit'); }
      return result;
    } };
    let queue = await new feedback.FeedbackQueue({ storage, client: proxy }).load();
    assert.equal((await queue.set(snapshot, 1, {})).pending, true);
    assert.equal((await stats(lab)).totals.changes, 1);
    queue = await new feedback.FeedbackQueue({ storage, client: proxy }).load();
    await queue.flush();
    assert.equal(queue.state('123').pending, false);
    assert.equal((await stats(lab)).totals.changes, 1);
  } finally { await lab.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
