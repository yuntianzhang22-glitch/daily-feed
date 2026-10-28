import fetcher from '../../desktop/core/fetcher.js';
import clientModule from '../../desktop/core/client.js';

const DAY = 86400000;
const OFFSET = 8 * 3600000;
export const scheduleDefaults = () => ({ enabled: false, days: [1, 4], time: '09:00',
  time_zone: 'Asia/Shanghai', follows: [], search_mode: 'Top', include_replies: false, revision: 0 });

export function validateSchedule(body, account, before = scheduleDefaults()) {
  const keys = ['enabled', 'days', 'time', 'follows', 'search_mode', 'include_replies', 'time_zone'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !keys.includes(key))) throw new Error('定时设置格式无效');
  const next = { ...before, ...body };
  if (typeof next.enabled !== 'boolean' || typeof next.include_replies !== 'boolean') throw new Error('开关格式无效');
  if (!Array.isArray(next.days) || next.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('请选择有效的抓取日');
  next.days = [...new Set(next.days)].sort();
  if (next.enabled && !next.days.length) throw new Error('请至少选择一天');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.time) || next.time_zone !== 'Asia/Shanghai') throw new Error('请选择有效的北京时间');
  if (!['Top', 'Latest'].includes(next.search_mode)) throw new Error('内容排序无效');
  if (!Array.isArray(next.follows) || next.follows.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(n))) throw new Error('关注用户名无效');
  next.follows = fetcher.cleanUsernames(next.follows);
  if (next.enabled && !next.follows.length) throw new Error('请先保存关注的人');
  const maxDays = account.plan === 'owner' ? 7 : Number(account.limits?.max_runs_per_week ?? 7);
  const maxFollows = account.plan === 'owner' ? 60 : Number(account.limits?.max_follows ?? 60);
  if (next.enabled && next.days.length > maxDays) throw new Error(`当前账号每周最多抓取 ${maxDays} 天`);
  if (next.follows.length > 60 || next.enabled && next.follows.length > maxFollows) throw new Error(`当前账号最多关注 ${Math.min(60, maxFollows)} 人`);
  return { ...next, configured: true, revision: before.revision + 1 };
}

export function nextScheduledAt(config, from = Date.now()) {
  if (!config.enabled || !config.days.length) return null;
  const local = new Date(from + OFFSET);
  const [hour, minute] = config.time.split(':').map(Number);
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  for (let i = 0; i <= 7; i++) {
    const date = new Date(dayStart + i * DAY);
    const candidate = date.getTime() + hour * 3600000 + minute * 60000 - OFFSET;
    if (config.days.includes(date.getUTCDay()) && candidate > from) return candidate;
  }
  return null;
}

// One Durable Object per canonical account. Alarms continue when every phone is
// closed. Each due slot is claimed before calling the paid upstream, preventing
// Cloudflare's at-least-once alarm delivery from charging twice on a retry.
export class ScheduledFeed {
  constructor(storage, { accountStatus, search, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.storage = storage;
    this.accountStatus = accountStatus;
    this.search = search;
    this.now = now;
    this.sleep = sleep;
  }
  async read() {
    return { config: await this.storage.get('config') || scheduleDefaults(),
      next_run: await this.storage.get('next_run') || null,
      last_run: await this.storage.get('last_run') || null };
  }
  async save(account, body) {
    const config = validateSchedule(body, account, (await this.read()).config);
    await this.storage.put({ config, account_no: account.account_no });
    await this.arm(config);
    return this.read();
  }
  async arm(config) {
    const next = nextScheduledAt(config, this.now());
    await this.storage.put('next_run', next);
    if (next) await this.storage.setAlarm(next);
    else await this.storage.deleteAlarm();
  }
  async feed() {
    const rows = await this.storage.list({ prefix: 'tweet:', reverse: true, limit: 500 });
    return { tweets: [...rows.values()], state: await this.storage.get('state') || {},
      last_run: await this.storage.get('last_run') || null };
  }
  async alarm() {
    const { config, next_run: due } = await this.read();
    if (!config.enabled) { await this.storage.deleteAlarm(); return; }
    if (!due || due > this.now()) { await this.arm(config); return; }
    if (await this.storage.get('attempted_slot') === due) {
      const last = await this.storage.get('last_run');
      if (last?.status === 'running') await this.storage.put('last_run', { ...last, status: 'error', message: '上次任务中断，可手动抓取或等待下次计划' });
      await this.arm(config); return;
    }
    await this.storage.put('attempted_slot', due);
    const accountNo = await this.storage.get('account_no');
    const result = { at: this.now(), status: 'running', added: 0, message: '' };
    await this.storage.put('last_run', result);
    try {
      const account = await this.accountStatus(accountNo);
      if (account.error) throw new Error('账号无效或已停用，请重新登录后保存定时设置');
      validateSchedule(Object.fromEntries(['enabled', 'days', 'time', 'follows', 'search_mode', 'include_replies', 'time_zone'].map((key) => [key, config[key]])), account, config);
      const client = new clientModule.FeedClient({ mode: 'relay', relayUrl: 'https://mobile.internal', accessCode: accountNo,
        maxRetries: 0, fetchImpl: (url, init) => this.search(new Request(url, init)) });
      const state = await this.storage.get('state') || {};
      const cfg = { ...config, group_size: 4, max_pages: 1, max_per_target: 3 };
      const groups = fetcher.followGroups(cfg);
      for (let i = 0; i < groups.length; i++) {
        if (i) await this.sleep(1100);
        if ((await this.storage.get('config')).revision !== config.revision) break;
        const writes = {};
        const existing = await this.storage.list({ prefix: 'tweet:', reverse: true, limit: 500 });
        const store = {
          getState: (key) => state[key], setState: (key, value) => { state[key] = value; },
          save: (raw, source, fetchedAt) => {
            if (!/^\d{1,24}$/.test(String(raw.id || ''))) return false;
            const key = 'tweet:' + String(raw.id).padStart(24, '0');
            writes[key] = { raw, source, fetchedAt };
            if (existing.has(key)) return false;
            result.added++; return true;
          },
        };
        await fetcher.collectFollowGroup(client, store, groups[i], cfg, new Date(this.now()).toISOString(), this.now());
        await this.storage.put({ ...writes, state, last_run: result });
        const all = await this.storage.list({ prefix: 'tweet:', reverse: true, limit: 600 });
        const old = [...all.keys()].slice(500);
        if (old.length) await this.storage.delete(old);
      }
      result.status = 'success';
    } catch (e) {
      result.status = 'error';
      result.message = e.code || /账号|当前账号|关注|抓取日/.test(e.message) ? e.message : '服务暂时不可用，请稍后重试';
    } finally {
      await this.storage.put('last_run', result);
      await this.arm((await this.read()).config);
    }
  }
}
