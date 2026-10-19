// SQLite 存储：与原 Python 版完全相同的表结构，直接读写已有的 tweets.db。
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tweets (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    author      TEXT,
    text        TEXT,
    url         TEXT,
    created_at  TEXT,
    likes       INTEGER,
    retweets    INTEGER,
    replies     INTEGER,
    views       INTEGER,
    fetched_at  TEXT NOT NULL,
    raw         TEXT
);
CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`;

const FLAG_FIELDS = ['is_read', 'starred'];
// 排序白名单，避免把任意字符串拼进 SQL
const SORT_ORDERS = {
  time: 'created_at DESC, id DESC',
  likes: 'likes DESC, created_at DESC',
  views: 'views DESC, created_at DESC',
};
const CREDITS_PER_USD = 100000;

// "Tue Dec 10 07:00:30 +0000 2024" -> "2024-12-10T07:00:30+00:00"（与 Python 版输出格式一致）
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseXDate(s) {
  const m = /^\w{3} (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(s || '');
  if (!m || !(m[1] in MONTHS)) return null;
  const offset = (m[6] === '-' ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8]));
  const ms = Date.UTC(Number(m[9]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
    - offset * 60000;
  return new Date(ms).toISOString().replace(/\.000Z$/, '+00:00');
}

function monthKey(month) {
  if (month) return `usage:${month}`;
  const d = new Date();
  return `usage:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  migrate() {
    // 旧库没有已读/收藏列，按需补上
    const cols = new Set(this.db.prepare('PRAGMA table_info(tweets)').all().map((c) => c.name));
    for (const col of FLAG_FIELDS) {
      if (!cols.has(col)) this.db.exec(`ALTER TABLE tweets ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
  }

  close() {
    this.db.close();
  }

  // 插入新帖子，已存在则跳过。返回是否为新帖子。
  save(t, source, fetchedAt) {
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO tweets
       (id, source, author, text, url, created_at, likes, retweets, replies, views, fetched_at, raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      String(t.id), source, (t.author || {}).userName ?? null, t.text ?? null, t.url ?? null,
      parseXDate(t.createdAt), t.likeCount ?? null, t.retweetCount ?? null,
      t.replyCount ?? null, t.viewCount ?? null, fetchedAt, JSON.stringify(t),
    );
    return r.changes === 1;
  }

  getState(key) {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setState(key, value) {
    this.db.prepare(
      'INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, String(value));
  }

  // ---- 用量记录（按本地估算的 credits，按自然月累计）

  addUsage(credits, month) {
    if (!credits) return;
    const key = monthKey(month);
    this.setState(key, Number(this.getState(key) || 0) + Math.round(credits));
  }

  usage(month) {
    const credits = Number(this.getState(monthKey(month)) || 0);
    return { credits, usd: Math.round((credits / CREDITS_PER_USD) * 10000) / 10000 };
  }

  // ---- 查询与标记

  list({ source = null, q = null, unread = false, starred = false, sort = 'time', limit = 200, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (source) { where.push('source = ?'); params.push(source); }
    if (q) {
      const pattern = '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      where.push("(text LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    if (unread) where.push('is_read = 0');
    if (starred) where.push('starred = 1');
    let sql = 'SELECT * FROM tweets';
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ` ORDER BY ${SORT_ORDERS[sort] || SORT_ORDERS.time} LIMIT ? OFFSET ?`;
    params.push(Math.max(0, Number(limit) || 0), Math.max(0, Number(offset) || 0));
    return this.db.prepare(sql).all(...params).map(rowToTweet);
  }

  sources() {
    return this.db.prepare(
      `SELECT source, COUNT(*) AS total, SUM(is_read = 0) AS unread, MAX(created_at) AS latest
       FROM tweets GROUP BY source ORDER BY source`,
    ).all().map((r) => ({ ...r }));
  }

  counts() {
    return { ...this.db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(is_read = 0), 0) AS unread,
              COALESCE(SUM(starred = 1), 0) AS starred FROM tweets`,
    ).get() };
  }

  setFlag(ids, field, value) {
    if (!FLAG_FIELDS.includes(field)) throw new Error(`不支持的字段: ${field}`);
    ids = (ids || []).map(String);
    if (!ids.length) return 0;
    const marks = ids.map(() => '?').join(',');
    return this.db.prepare(`UPDATE tweets SET ${field} = ? WHERE id IN (${marks})`)
      .run(value ? 1 : 0, ...ids).changes;
  }

  markAllRead(source) {
    const r = source
      ? this.db.prepare('UPDATE tweets SET is_read = 1 WHERE source = ?').run(source)
      : this.db.prepare('UPDATE tweets SET is_read = 1').run();
    return r.changes;
  }
}

function rowToTweet(row) {
  const { raw, ...d } = row;
  let author = {};
  try { author = (JSON.parse(raw || '{}').author) || {}; } catch { /* 损坏的 raw 忽略 */ }
  return {
    ...d,
    author_name: author.name ?? null,
    avatar: author.profilePicture ?? null,
    is_read: Boolean(d.is_read),
    starred: Boolean(d.starred),
  };
}

module.exports = { Store, parseXDate, CREDITS_PER_USD };
