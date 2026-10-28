// Feedback is client-reported evidence, not a verified assertion about an X post.
export class FeedbackError extends Error {
  constructor(code, message, status = 400, current) { super(message); Object.assign(this, { code, status, current }); }
}
const fail = () => { throw new FeedbackError('feedback_input', '反馈内容格式无效'); };
const idOK = (id) => typeof id === 'string' && /^\d{1,25}$/.test(id);
const str = (s, max, optional = false) => {
  if (optional && s == null) return '';
  if (typeof s !== 'string' || s.length > max) fail(); return s;
};
const username = (s) => { s = str(s, 15); if (s && !/^\w+$/.test(s)) fail(); return s; };
export function normalizeFeedback(body) {
  if (!body || ![0, 1, -1].includes(body.value) || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0 ||
      !/^[a-zA-Z0-9-]{16,80}$/.test(body.event_id || '')) fail();
  const s = body.snapshot;
  if (!s || !idOK(s.id) || (s.source_post_id && !idOK(s.source_post_id))) fail();
  const snapshot = { id: s.id, source_post_id: s.source_post_id || s.id, author: username(s.author),
    text: str(s.text, 50000), truncated: s.truncated === true,
    created_at: str(s.created_at, 100), source: str(s.source, 160, true), quoted: null,
    links: [], media_count: Math.min(4, Math.max(0, Number.isInteger(s.media_count) ? s.media_count : 0)), has_card: s.has_card === true, metrics: {} };
  if (s.quoted != null) {
    if (!idOK(s.quoted.id)) fail();
    snapshot.quoted = { id: s.quoted.id, author: username(s.quoted.author), text: str(s.quoted.text, 50000), truncated: s.quoted.truncated === true };
  }
  if (!Array.isArray(s.links) || s.links.length > 30) fail();
  for (const link of s.links) {
    let url; try { url = new URL(str(link, 2048)); } catch { fail(); }
    if (url.protocol !== 'https:' || url.username || url.password) fail();
    snapshot.links.push(url.href);
  }
  for (const k of ['likeCount', 'retweetCount', 'replyCount', 'viewCount']) {
    const n = s.metrics?.[k] ?? 0;
    if (!Number.isFinite(n) || n < 0 || n > 1e12) fail(); snapshot.metrics[k] = Math.round(n);
  }
  const c = body.context || {};
  const context = { platform: ['desktop', 'mobile'].includes(c.platform) ? c.platform : 'unknown',
    app_version: str(c.app_version, 40, true), view: str(c.view, 40, true), sort: str(c.sort, 40, true),
    algorithm_version: str(c.algorithm_version, 80, true) || 'baseline-v1',
    position: Number.isInteger(c.position) && c.position >= 0 && c.position < 100000 ? c.position : null };
  return { event_id: body.event_id, value: body.value, expected_revision: body.expected_revision, snapshot, context };
}
export function validateIds(ids) {
  if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => !idOK(id))) fail();
  return [...new Set(ids)];
}
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS feedback_current (user_key TEXT NOT NULL, post_id TEXT NOT NULL, value INTEGER NOT NULL,
    revision INTEGER NOT NULL, updated_at TEXT NOT NULL, content_hash TEXT NOT NULL, snapshot TEXT NOT NULL, context TEXT NOT NULL,
    PRIMARY KEY(user_key,post_id))`,
  `CREATE TABLE IF NOT EXISTS feedback_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
    user_key TEXT NOT NULL, post_id TEXT NOT NULL, value INTEGER NOT NULL, previous_value INTEGER NOT NULL, revision INTEGER NOT NULL,
    created_at TEXT NOT NULL, content_hash TEXT NOT NULL, snapshot TEXT NOT NULL, context TEXT NOT NULL,
    UNIQUE(user_key,event_id))`,
  `CREATE INDEX IF NOT EXISTS feedback_events_user_time ON feedback_events(user_key,created_at)`,
  `CREATE INDEX IF NOT EXISTS feedback_current_post ON feedback_current(post_id,value)`,
];
const features = (s) => ({ version: 'content-v1', text_length: [...s.text].length, quote_length: [...(s.quoted?.text || '')].length,
  link_count: s.links.length, has_quote: Boolean(s.quoted), media_count: s.media_count, has_card: s.has_card });
export class FeedbackStore {
  constructor(sql, transaction = (fn) => fn(), now = () => new Date().toISOString()) {
    this.sql = sql; this.transaction = transaction; this.now = now;
    for (const statement of SCHEMA) sql.exec(statement);
  }
  rows(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  state(user, id) {
    const row = this.rows('SELECT value,revision,updated_at FROM feedback_current WHERE user_key=? AND post_id=?', user, id)[0];
    return row || { value: 0, revision: 0, updated_at: null };
  }
  read(user, ids) { validateIds(ids); return { states: Object.fromEntries(ids.map((id) => [id, this.state(user, id)])) }; }
  submit(user, event, hash) {
    return this.transaction(() => {
      const { snapshot: s, context: c } = event;
      const duplicate = this.rows('SELECT post_id,value FROM feedback_events WHERE user_key=? AND event_id=?', user, event.event_id)[0];
      if (duplicate) {
        if (duplicate.post_id !== s.id || duplicate.value !== event.value) throw new FeedbackError('feedback_input', '重复请求编号不能用于其他反馈');
        return { state: this.state(user, s.id), duplicate: true };
      }
      const before = this.state(user, s.id);
      if (before.revision !== event.expected_revision) throw new FeedbackError('feedback_conflict', '另一台设备已修改标记，请重新选择', 409, before);
      // Clicking/retrying the current value is not a new vote or a training event.
      if (before.value === event.value) return { state: before, unchanged: true };
      const now = this.now();
      const count = this.rows('SELECT COUNT(*) AS n FROM feedback_events WHERE user_key=? AND created_at>=?', user, now.slice(0, 10))[0].n;
      if (count >= 2000) throw new FeedbackError('feedback_rate', '今日反馈较多，请明天再试', 429);
      const revision = before.revision + 1, snapshot = JSON.stringify(s), context = JSON.stringify(c);
      this.sql.exec(`INSERT INTO feedback_events(event_id,user_key,post_id,value,previous_value,revision,created_at,content_hash,snapshot,context) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        event.event_id,user,s.id,event.value,before.value,revision,now,hash,snapshot,context);
      this.sql.exec(`INSERT INTO feedback_current VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_key,post_id) DO UPDATE SET
        value=excluded.value,revision=excluded.revision,updated_at=excluded.updated_at,content_hash=excluded.content_hash,snapshot=excluded.snapshot,context=excluded.context`,
        user,s.id,event.value,revision,now,hash,snapshot,context);
      return { state: { value: event.value, revision, updated_at: now } };
    });
  }
  stats() {
    const totals = this.rows(`SELECT COUNT(DISTINCT CASE WHEN value<>0 THEN user_key END) AS participants,
      COUNT(DISTINCT CASE WHEN value<>0 THEN post_id END) AS posts,
      COALESCE(SUM(value=1),0) AS up, COALESCE(SUM(value=-1),0) AS down FROM feedback_current`)[0];
    const events = this.rows('SELECT COUNT(*) AS changes FROM feedback_events')[0].changes;
    const posts = this.rows(`SELECT post_id, SUM(value=1) AS up, SUM(value=-1) AS down, MAX(updated_at) AS updated_at
      FROM feedback_current WHERE value<>0 GROUP BY post_id ORDER BY COUNT(*) DESC,post_id LIMIT 100`);
    return { schema_version: 'feedback-v1', totals: { ...totals, changes: events }, posts,
      note: '统计是用户主动反馈的当前标记；未反馈不等于点踩，不代表全部用户的满意度。' };
  }
  export({ kind = 'current', after = 0, limit = 200, until } = {}) {
    if (!['current', 'events'].includes(kind) || !Number.isSafeInteger(after) || after < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (until != null && (!Number.isSafeInteger(until) || until < 0))) fail();
    const table = kind === 'current' ? 'feedback_current' : 'feedback_events', key = kind === 'current' ? 'rowid' : 'seq';
    const ceiling = until ?? this.rows(`SELECT COALESCE(MAX(${key}),0) AS n FROM ${table}`)[0].n;
    const rows = this.rows(`SELECT ${key} AS cursor,* FROM ${table} WHERE ${key}>? AND ${key}<=? ORDER BY ${key} LIMIT ?`, after, ceiling, limit + 1);
    const more = rows.length > limit;
    const records = rows.slice(0, limit).map(({ snapshot, context, ...row }) => {
      const post = JSON.parse(snapshot);
      return { ...row, snapshot: post, context: JSON.parse(context), features: features(post), provenance: 'client_reported' };
    });
    return { schema_version: 'feedback-v1', kind, until: ceiling, records, next_cursor: more ? records.at(-1).cursor : null };
  }
}
