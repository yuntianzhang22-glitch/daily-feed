import feedbackModule from '../desktop/core/feedback.js';
import clientModule from '../desktop/core/client.js';
import fetcher from '../desktop/core/fetcher.js';
import postModule from '../desktop/core/post.js';
import permissions from '../desktop/core/permissions.js';

export const { extractPost } = postModule;
export const { cleanUsernames } = fetcher;
export const { verifiedAccountRole } = permissions;
export const defaults = () => ({ follows: [], include_replies: false, search_mode: 'Top',
  max_per_target: 3, tweets: {}, state: {}, lastFetched: '' });

// Browser storage is partitioned by the server's canonical account number.
// API responses and credentials never enter the service worker cache.
export class BrowserStorage {
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('daily-feed-mobile', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('无法打开本机存储，请退出无痕浏览后重试'));
    });
  }
  async get(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('data', 'readonly');
      const request = tx.objectStore('data').get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(new Error('读取本机数据失败'));
    });
  }
  async put(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('data', 'readwrite');
      if (value === undefined) tx.objectStore('data').delete(key);
      else tx.objectStore('data').put(value, key);
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(new Error('本机存储失败，请检查剩余空间；本次更改尚未保存'));
    });
  }
}

export class MobileFeed {
  constructor(storage, { relayUrl = globalThis.location?.origin, fetchImpl = (url, init) => globalThis.fetch(url, init) } = {}) {
    this.storage = storage;
    this.relayUrl = relayUrl;
    this.fetchImpl = fetchImpl;
    this.data = defaults();
    this.session = null;
    this.account = null;
    this.busy = false;
    this.schedule = null;
  }
  client(code = this.session?.code) {
    return new clientModule.FeedClient({ mode: 'relay', relayUrl: this.relayUrl,
      accessCode: code, fetchImpl: this.fetchImpl, maxRetries: 0 });
  }
  async feedbackQueue() {
    const session = this.session;
    if (!session) throw new Error('请先登录账号后反馈');
    if (this.feedbackSession !== session) {
      this.feedbackSession = session;
      const key = `feedback:${this.account.account_no}`;
      const guard = () => { if (this.session !== session) throw new Error('登录状态已变更，请重试'); };
      const client = this.client();
      const queue = new feedbackModule.FeedbackQueue({ storage: {
        get: () => this.storage.get(key),
        put: async (data) => { guard(); await this.storage.put(key, data); guard(); },
      }, client: {
        submitFeedback: async (event) => { guard(); const result = await client.submitFeedback(event); guard(); return result; },
        readFeedback: async (ids) => { guard(); const result = await client.readFeedback(ids); guard(); return result; },
      } });
      this.feedbackReady = queue.load().then(() => ({ queue, guard }));
    }
    const result = await this.feedbackReady; result.guard(); return result;
  }
  async feedbackState(id) { const { queue } = await this.feedbackQueue(); return queue.state(id); }
  async syncFeedback(ids = []) { const { queue, guard } = await this.feedbackQueue(); const result = await queue.refresh(ids); guard(); return result; }
  async retryFeedback() { const { queue, guard } = await this.feedbackQueue(); const result = await queue.flush(); guard(); return result; }
  async setFeedback(id, value, context) {
    const record = this.data.tweets[id]; if (!record) throw new Error('帖子不存在');
    const snapshot = feedbackModule.snapshotFromRaw(record.raw, record.source);
    const { queue, guard } = await this.feedbackQueue();
    const result = await queue.set(snapshot, value, { ...context, platform: 'mobile', algorithm_version: 'baseline-v1' });
    guard(); return result;
  }
  async login(code) {
    if (this.busy) throw new Error('请等待当前抓取完成');
    const account = await this.client(String(code).trim()).status();
    verifiedAccountRole(account.plan);
    if (!/^DF-[A-Z0-9]{5}$/.test(account.account_no)) throw new Error('登录账号返回的编号无效');
    const session = { code: account.account_no, account };
    const data = await this.storage.get(`account:${account.account_no}`) || defaults();
    await this.storage.put('session', session);
    this.session = session;
    this.account = account;
    this.data = data;
    this.schedule = null;
    return account;
  }
  async restore() {
    const session = await this.storage.get('session');
    if (!session) return false;
    // An offline session can read previously saved posts. Any online denial locks it.
    try { await this.login(session.code); return true; }
    catch (e) {
      if (e.code !== 'network') { await this.storage.put('session', undefined); throw e; }
      verifiedAccountRole(session.account.plan);
      this.session = session;
      this.account = session.account;
      this.data = await this.storage.get(`account:${session.account.account_no}`) || defaults();
      this.offline = true;
      return true;
    }
  }
  async refreshAccount() {
    try {
      const account = await this.client().status();
      verifiedAccountRole(account.plan);
      this.account = account;
      this.session.account = account;
      await this.storage.put('session', this.session);
      this.offline = false;
      return account;
    } catch (e) {
      if (e.code === 'invalid_code' || e.status === 401) await this.logout();
      throw e;
    }
  }
  async logout() {
    if (this.busy) throw new Error('请等待当前抓取完成再退出');
    await this.storage.put('session', undefined);
    this.session = this.account = null;
    this.data = defaults();
    this.schedule = null;
  }
  async save() {
    if (!this.session) throw new Error('请先登录');
    await this.storage.put(`account:${this.account.account_no}`, this.data);
  }
  async setFollows(names) {
    if (this.busy) throw new Error('请等待当前抓取完成后修改关注');
    const follows = cleanUsernames(names);
    const limit = Number(this.account?.limits?.max_follows) || 0;
    if (limit && follows.length > limit) throw new Error(`当前账号最多关注 ${limit} 人`);
    const before = this.data.follows;
    this.data.follows = follows;
    try {
      if (this.schedule?.config?.enabled) await this.saveSchedule({ follows, ...(!follows.length ? { enabled: false } : {}) });
      await this.save();
    } catch (e) { this.data.follows = before; throw e; }
  }
  async mobileRequest(path, body) {
    const client = this.client();
    return client.request(`${this.relayUrl}/v1/mobile/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.session.code}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async loadSchedule() {
    const owner = this.session?.code;
    const schedule = await this.mobileRequest('schedule');
    if (this.session?.code !== owner) return null;
    this.schedule = schedule;
    return this.schedule;
  }
  async saveSchedule(patch) {
    const owner = this.session?.code;
    const config = this.schedule?.config || { enabled: false, days: [1, 4], time: '09:00', time_zone: 'Asia/Shanghai' };
    const body = { enabled: config.enabled, days: config.days, time: config.time, time_zone: 'Asia/Shanghai',
      follows: this.data.follows, search_mode: this.data.search_mode, include_replies: this.data.include_replies, ...patch };
    const schedule = await this.mobileRequest('schedule', body);
    if (this.session?.code !== owner) throw new Error('登录状态已变化，请重试');
    this.schedule = schedule;
    return this.schedule;
  }
  async syncScheduled() {
    const owner = this.session?.code;
    if (!owner) return 0;
    const body = await this.mobileRequest('feed');
    if (this.session?.code !== owner || this.busy) return 0;
    let added = 0;
    for (const record of body.tweets || []) {
      const id = String(record.raw?.id || '');
      if (!id) continue;
      const previous = this.data.tweets[id];
      this.data.tweets[id] = { ...record, read: previous?.read || false, starred: previous?.starred || false };
      if (!previous) added++;
    }
    for (const [key, value] of Object.entries(body.state || {})) this.data.state[key] = Math.max(Number(this.data.state[key]) || 0, Number(value) || 0);
    if (body.last_run?.status === 'success') this.data.lastFetched = new Date(body.last_run.at).toISOString();
    await this.save();
    return added;
  }
  async flag(id, field) {
    if (!['read', 'starred'].includes(field) || !this.data.tweets[id]) return;
    this.data.tweets[id][field] = !this.data.tweets[id][field];
    try { await this.save(); } catch (e) { this.data.tweets[id][field] = !this.data.tweets[id][field]; throw e; }
  }
  list({ view = 'all', query = '', source = '', sort = 'time' } = {}) {
    const needle = query.trim().toLocaleLowerCase();
    return Object.values(this.data.tweets).filter((t) =>
      (view !== 'unread' || !t.read) && (view !== 'starred' || t.starred) &&
      (!source || t.source === source) && (!needle ||
        [t.raw.text, t.raw.author?.name, t.raw.author?.userName, extractPost(t.raw)?.text].join(' ').toLocaleLowerCase().includes(needle)))
      .sort((a, b) => sort === 'likes' ? (Number(b.raw.likeCount) || 0) - (Number(a.raw.likeCount) || 0)
        : (Date.parse(b.raw.createdAt) || 0) - (Date.parse(a.raw.createdAt) || 0));
  }
  async fetchNow(progress = () => {}) {
    if (this.busy) throw new Error('正在抓取，请稍候');
    if (!this.session) throw new Error('请先登录');
    if (!this.data.follows.length) throw new Error('请先在「关注」中添加想看的人');
    this.busy = true;
    let added = 0;
    try {
      const client = this.client();
      const cfg = permissions.fetchSettings({ ...this.data, group_size: 4, max_pages: 1 }, this.account.plan);
      const groups = fetcher.followGroups(cfg);
      const store = {
        getState: (key) => this.data.state[key],
        setState: (key, value) => { this.data.state[key] = value; },
        save: (raw, source, fetchedAt) => {
          const id = String(raw.id || '');
          if (!id) return false;
          const previous = this.data.tweets[id];
          this.data.tweets[id] = { raw, source, fetchedAt, read: previous?.read || false, starred: previous?.starred || false };
          if (!previous) added++;
          return !previous;
        },
      };
      for (let i = 0; i < groups.length; i++) {
        // The shared ledger allows one request per second across all devices.
        if (i) await new Promise((resolve) => setTimeout(resolve, 1100));
        progress(`正在抓取 ${i + 1}/${groups.length} 组…`);
        await fetcher.collectFollowGroup(client, store, groups[i], cfg, new Date().toISOString());
        this.data.lastFetched = new Date().toISOString();
        await this.save();
      }
      return added;
    } catch (e) {
      // Earlier successful groups were persisted even if a later group fails.
      e.added = added;
      throw e;
    } finally { this.busy = false; }
  }
}
