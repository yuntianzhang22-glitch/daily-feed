// Portable feedback snapshot and durable client outbox; never calls X or an LLM.
const { extractPost } = require('./post');
const FEEDBACK_VERSION = 'feedback-v1';
const POST_ID = /^\d{1,25}$/;
function snapshotFromRaw(raw, source = '') {
  if (typeof raw === 'string') raw = JSON.parse(raw);
  const post = extractPost(raw);
  if (!post || post.unavailable || !POST_ID.test(post.id)) throw new Error('这条帖子暂不能反馈');
  const metrics = raw.retweeted_tweet || raw;
  const quoted = post.quoted?.text ? { id: post.quoted.id || '', author: post.quoted.author?.username || '',
    text: post.quoted.text.slice(0, 50000), truncated: post.quoted.text.length > 50000 } : null;
  return { id: post.id, source_post_id: String(raw.id || ''), author: post.author?.username || '',
    text: (post.text || '').slice(0, 50000), truncated: (post.text || '').length > 50000,
    created_at: post.created_at || '', source: String(source).slice(0, 160), quoted,
    links: [...(post.links || []), ...(post.quoted?.links || [])].map((l) => l.url).slice(0, 30),
    media_count: post.media?.length || 0, has_card: Boolean(post.card),
    metrics: Object.fromEntries(['likeCount', 'retweetCount', 'replyCount', 'viewCount'].map((k) => [k, Number(metrics[k]) || 0])) };
}
class FeedbackQueue {
  constructor({ storage, client, uuid = () => globalThis.crypto.randomUUID() }) {
    this.storage = storage; this.client = client; this.uuid = uuid;
    this.data = { states: {}, pending: [] }; this.operation = Promise.resolve();
  }
  async load() { this.data = await this.storage.get() || { states: {}, pending: [] }; return this; }
  state(id) {
    const saved = this.data.states[id] || { value: 0, revision: 0 };
    const pending = this.data.pending.find((p) => p.snapshot.id === id);
    return { ...saved, ...(pending ? { value: pending.value } : {}), pending: Boolean(pending) };
  }
  async persist(next) { await this.storage.put(next); this.data = next; }
  enqueue(fn) {
    const task = this.operation.then(fn); this.operation = task.catch(() => {}); return task;
  }
  set(snapshot, value, context) { return this.enqueue(() => this.setInner(snapshot, value, context)); }
  async setInner(snapshot, value, context) {
    if (![0, 1, -1].includes(value)) throw new Error('反馈标记无效');
    if (this.data.pending.some((p) => p.snapshot.id === snapshot.id)) return this.drain();
    const event = { event_id: this.uuid(), value, expected_revision: this.state(snapshot.id).revision, snapshot, context };
    await this.persist({ ...this.data, pending: [...this.data.pending, event] });
    return this.drain();
  }
  flush() { return this.enqueue(() => this.drain()); }
  async drain() {
    let conflict = false;
    while (this.data.pending.length) {
      const event = this.data.pending[0]; let state;
      try { state = (await this.client.submitFeedback(event)).state; }
      catch (e) {
        if (e.code === 'feedback_conflict' && e.body?.current) { state = e.body.current; conflict = true; }
        else if (e.status === 400 || e.status === 413) {
          await this.persist({ ...this.data, pending: this.data.pending.slice(1) }); throw e;
        } else return { pending: true, message: '已保存在本机，联网后自动同步' };
      }
      await this.persist({ ...this.data, states: { ...this.data.states, [event.snapshot.id]: state }, pending: this.data.pending.slice(1) });
    }
    return { pending: false, conflict, message: conflict ? '另一台设备已修改标记，已读取最新状态，请重新选择' : '反馈已同步' };
  }
  refresh(ids) { return this.enqueue(() => this.refreshInner(ids)); }
  async refreshInner(ids) {
    const result = await this.drain();
    const body = await this.client.readFeedback([...new Set(ids)].filter((id) => POST_ID.test(id)).slice(0, 200));
    await this.persist({ ...this.data, states: { ...this.data.states, ...body.states } });
    return result;
  }
}
module.exports = { snapshotFromRaw, FeedbackQueue, FEEDBACK_VERSION, POST_ID };
