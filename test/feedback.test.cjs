const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FeedbackQueue, snapshotFromRaw } = require('../desktop/core/feedback');
const snapshot = snapshotFromRaw({ id: '123', text: 'hello', author: { userName: 'sample' } });
function setup() {
  let saved, state = { value: 0, revision: 0 }, fail = false, calls = 0;
  const storage = { get: async () => structuredClone(saved), put: async (next) => { saved = structuredClone(next); } };
  const seen = new Set();
  const client = { submitFeedback: async (event) => {
    calls++; if (fail) throw Object.assign(new Error('offline'), { status: 0 });
    if (!seen.has(event.event_id)) {
      if (event.expected_revision !== state.revision) throw Object.assign(new Error('conflict'), { code: 'feedback_conflict', body: { current: state } });
      state = { value: event.value, revision: state.revision + 1 }; seen.add(event.event_id);
    }
    return { state };
  }, readFeedback: async () => ({ states: { '123': state } }) };
  return { storage, client, offline: (v) => { fail = v; }, calls: () => calls, saved: () => saved,
    remote: (value, revision) => { state = { value, revision }; } };
}
test('离线先持久化、重启恢复、上传后切换/取消；无网络不会假报同步', async () => {
  const s = setup(); let queue = await new FeedbackQueue(s).load(); s.offline(true);
  assert.equal((await queue.set(snapshot, 1, {})).pending, true);
  assert.equal(queue.state('123').pending, true); assert.equal(s.saved().pending.length, 1);
  const request = s.saved().pending[0].event_id;
  queue = await new FeedbackQueue(s).load(); assert.equal(queue.state('123').value, 1);
  s.offline(false); await queue.flush(); assert.equal(queue.state('123').pending, false);
  assert.equal(s.saved().states['123'].revision, 1);
  await queue.set(snapshot, -1, {}); await queue.set(snapshot, 0, {});
  assert.equal(queue.state('123').value, 0); assert.equal(queue.state('123').revision, 3);
  assert.ok(request);
});
test('跨设备冲突读取最新状态，旧待传队列不会覆盖新设备的反馈', async () => {
  const s = setup(), queue = await new FeedbackQueue(s).load(); s.offline(true);
  await queue.set(snapshot, 1, {}); s.remote(-1, 1); s.offline(false);
  const result = await queue.flush(); assert.equal(result.conflict, true);
  assert.equal(queue.state('123').value, -1); assert.equal(s.saved().pending.length, 0);
});
test('存储失败不发送；并行标记不同帖子不会丢队列或状态', async () => {
  const s = setup();
  const failing = await new FeedbackQueue({ ...s, storage: { get: async () => null, put: async () => { throw new Error('disk full'); } } }).load();
  await assert.rejects(failing.set(snapshot, 1, {}), /disk full/); assert.equal(s.calls(), 0);
  s.offline(true); const queue = await new FeedbackQueue(s).load();
  await Promise.all([queue.set(snapshot, 1, {}), queue.set({ ...snapshot, id: '456' }, -1, {})]);
  assert.equal(queue.data.pending.length, 2); assert.equal(s.saved().pending.length, 2);
});
