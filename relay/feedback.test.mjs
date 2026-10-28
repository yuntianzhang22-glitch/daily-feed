import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { FeedbackStore, normalizeFeedback, validateIds } from './src/feedback.js';
import feedbackModule from '../desktop/core/feedback.js';
const { snapshotFromRaw } = feedbackModule;
export const sample = (id = '123') => ({ id, author: { userName: 'sample' }, text: 'A useful research result', createdAt: '2026-10-28T00:00:00Z',
  likeCount: 10, url: `https://x.com/sample/status/${id}`, quoted_tweet: { id: '456', text: 'Methods and data', author: { userName: 'source' } } });
export const event = (value = 1, revision = 0, id = '123', request = crypto.randomUUID()) => ({ event_id: request,
  value, expected_revision: revision, snapshot: snapshotFromRaw(sample(id), 'user:sample'), context: { platform: 'desktop', app_version: '0.10.2', algorithm_version: 'baseline-v1' } });
function setup() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(q, ...args) { const stmt = db.prepare(q); return { toArray: () => /^\s*SELECT/.test(q) ? stmt.all(...args).map((r) => ({ ...r })) : (stmt.run(...args), []) }; } };
  // Execute every statement immediately, like Cloudflare SQL cursors.
  sql.exec = (q, ...args) => { const stmt = db.prepare(q), rows = /^\s*SELECT/.test(q) ? stmt.all(...args).map((r) => ({ ...r })) : (stmt.run(...args), []); return { toArray: () => rows }; };
  const transaction = (fn) => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  return { db, store: new FeedbackStore(sql, transaction, () => '2026-10-28T01:00:00Z') };
}
test('当前标记互斥、改踩和取消准确计数；保留历史、快照与评估上下文', () => {
  const { db, store } = setup();
  assert.equal(store.submit('user-a', normalizeFeedback(event()), 'hash').state.revision, 1);
  store.submit('user-b', normalizeFeedback(event(-1)), 'hash');
  assert.deepEqual(store.stats().totals, { participants: 2, posts: 1, up: 1, down: 1, changes: 2 });
  store.submit('user-a', normalizeFeedback(event(-1, 1)), 'hash');
  store.submit('user-b', normalizeFeedback(event(0, 1)), 'hash');
  assert.deepEqual(store.stats().totals, { participants: 1, posts: 1, up: 0, down: 1, changes: 4 });
  assert.equal(store.read('user-b', ['123']).states['123'].value, 0);
  const records = store.export({ kind: 'events' }).records;
  assert.deepEqual(records.map((r) => r.value), [1, -1, -1, 0]);
  assert.equal(records[0].snapshot.quoted.text, 'Methods and data');
  assert.equal(records[0].features.has_quote, true);
  assert.equal(records[0].context.algorithm_version, 'baseline-v1'); db.close();
});
test('幂等重试、跨设备版本冲突、数据隔离，重试旧事件不会覆盖新状态', () => {
  const { db, store } = setup(), first = normalizeFeedback(event());
  store.submit('a', first, 'hash'); store.submit('a', first, 'hash');
  assert.equal(store.stats().totals.changes, 1);
  assert.equal(store.read('b', ['123']).states['123'].value, 0);
  assert.throws(() => store.submit('a', normalizeFeedback(event(-1, 0)), 'hash'), { code: 'feedback_conflict', status: 409 });
  store.submit('a', normalizeFeedback(event(-1, 1)), 'hash');
  assert.equal(store.submit('a', first, 'hash').state.value, -1);
  assert.throws(() => store.submit('a', normalizeFeedback(event(1, 2, '999', first.event_id)), 'hash'), { code: 'feedback_input' });
  assert.equal(store.stats().totals.changes, 2); db.close();
});
test('导出游标分页不漏记录，快照不含身份和凭据字段', () => {
  const { db, store } = setup();
  for (let i = 1; i <= 5; i++) store.submit('opaque-user', normalizeFeedback({ ...event(1, 0, String(i)), account_no: 'DF-XXXXX', token: 'secret' }), 'hash');
  const first = store.export({ kind: 'events', limit: 2 });
  const second = store.export({ kind: 'events', limit: 2, after: first.next_cursor, until: first.until });
  const third = store.export({ kind: 'events', limit: 2, after: second.next_cursor, until: first.until });
  assert.deepEqual([...first.records, ...second.records, ...third.records].map((r) => r.post_id), ['1', '2', '3', '4', '5']);
  assert.equal(third.next_cursor, null);
  assert.ok(!JSON.stringify(first).includes('DF-XXXXX')); assert.ok(!JSON.stringify(first).includes('secret'));
  assert.throws(() => store.export({ limit: 10000 }), { code: 'feedback_input' }); db.close();
});
test('失败事务回滚、输入限制与无效帖子不能进入样本', () => {
  const { db, store } = setup();
  for (const bad of [{}, { ...event(), value: 5 }, { ...event(), expected_revision: -1 }, { ...event(), snapshot: { ...event().snapshot, links: ['javascript:alert(1)'] } }]) assert.throws(() => normalizeFeedback(bad));
  assert.throws(() => validateIds(Array(201).fill('1')));
  assert.throws(() => snapshotFromRaw({ id: 'bad', text: 'x' }));
  db.exec(`CREATE TRIGGER fail_write BEFORE INSERT ON feedback_current BEGIN SELECT RAISE(ABORT,'test failure'); END`);
  assert.throws(() => store.submit('a', normalizeFeedback(event()), 'hash'));
  assert.equal(store.stats().totals.changes, 0); db.close();
});
