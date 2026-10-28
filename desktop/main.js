const { FeedbackQueue, snapshotFromRaw, POST_ID } = require('./core/feedback');
// Electron 主进程：窗口、抓取（进程内 Node 后端）、定时、通知、访问码、内置名单、应用内更新。
const {
  app, BrowserWindow, clipboard, dialog, ipcMain, net, Notification, powerMonitor, safeStorage, shell,
} = require('electron');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const { Store } = require('./core/store');
const { ConfigFile, activeDays } = require('./core/config');
const { FeedClient, resolveAccess } = require('./core/client');
const { runOnce, estimateMonthlyCost, cleanUsernames } = require('./core/fetcher');
const { Updater } = require('./core/updater');
const { nextSlot, prevSlot } = require('./core/schedule');
const { LAB_APP_NAME, resolveEnvironment, ROLES, SCENARIOS, validateProfile, profilePath, localCode } = require('./core/environment');
const { identityFor, requirePermission, verifiedAccountRole, visibleSettings, applySettings, fetchSettings } = require('./core/permissions');
const { ensureInstalled } = require('./core/installation');

// 只有仓库内的自动验收入口可隐藏窗口；正式安装包不含这些入口。
const sourceRoot = path.resolve(__dirname, '..');
const testHarness = ['electron-smoke.cjs', 'production-login.cjs', 'production-permissions.cjs']
  .some((file) => process.argv[1] === path.join(sourceRoot, 'test', file) && fs.existsSync(process.argv[1]));
const backgroundTest = testHarness && process.env.DAILY_FEED_AUTOMATED_TEST === '1';

// 构建时写入的服务地址（中转、更新清单、名单）。开发时可以用环境变量覆盖。
const APP_CONFIG = (() => {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8')); } catch { /* 无 */ }
  // 自定义 macOS 测试外壳会被 Electron 标为 packaged；只允许它从本仓库加载源码。
  // 正式安装包在 Resources/app 下，没有源码开发入口，也不能使用本地验收身份。
  const sourceEntry = app.getAppPath() === sourceRoot || testHarness;
  const developmentRuntime = sourceEntry
    && process.execPath.startsWith(path.join(sourceRoot, '.local', 'runtime') + path.sep)
    && fs.existsSync(path.join(sourceRoot, 'dev', 'start.mjs'));
  return resolveEnvironment({ appConfig: cfg, packaged: app.isPackaged, developmentRuntime,
    localRoot: process.env.DAILY_FEED_LAB_ROOT || path.join(__dirname, '..', '.local', process.env.DAILY_FEED_LIVE === '1' ? 'live' : 'fixtures') });
})();

// 所有网络请求都走 Electron 的 net.fetch：它使用系统代理设置（和浏览器一样），
// Node 自带的 fetch 不读系统代理，在需要代理的网络里会连不上
const netFetch = (url, init) => net.fetch(url, init);

// 测试时可用环境变量指向另一个数据目录，避免碰到真实数据
if (APP_CONFIG.lab) {
  // 锁、缓存、配置、数据库按环境和身份分开，可与正式应用同时打开。
  app.setName(LAB_APP_NAME);
  fs.mkdirSync(APP_CONFIG.dataPath, { recursive: true });
  fs.mkdirSync(path.join(APP_CONFIG.root, APP_CONFIG.name, 'browser-session'), { recursive: true });
  app.setPath('userData', APP_CONFIG.dataPath);
  app.setPath('sessionData', path.join(APP_CONFIG.root, APP_CONFIG.name, 'browser-session'));
} else if (process.env.DAILY_FEED_USER_DATA) app.setPath('userData', process.env.DAILY_FEED_USER_DATA);
const userData = () => app.getPath('userData');
const P = {
  db: () => path.join(userData(), 'tweets.db'),
  config: () => path.join(userData(), 'config.json'),
  access: () => path.join(userData(), 'access.json'),
  signedOut: () => path.join(userData(), 'signed_out'),
  lastAccount: () => path.join(userData(), 'last_account.json'),
  apiKey: () => path.join(userData(), 'api_key.bin'),
  lastAuto: () => path.join(userData(), 'last_auto_fetch.txt'),
  rosterCache: () => path.join(userData(), 'roster-cache.json'),
  backups: () => path.join(userData(), 'backups'),
};

let win = null;
let store = null;
let config = null;
let timer = null;
let nextRun = null;
let lastFetch = null;
let fetching = false;
let limits = {};
let updater = null;
let pendingUpdate = null;
let authRevision = 0;

// ------------------------------------------------------------ 数据

// 每次升级到新版本后第一次启动时备份数据库和配置（保留最近 5 份）
function backupOnVersionChange() {
  const marker = path.join(userData(), 'last_version.txt');
  let last = '';
  try { last = fs.readFileSync(marker, 'utf8').trim(); } catch { /* 首次 */ }
  const current = app.getVersion();
  if (last === current) return;
  const dir = path.join(P.backups(), `before-${current}-${Date.now()}`);
  for (const f of [P.db(), P.config()]) {
    if (fs.existsSync(f)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(f, path.join(dir, path.basename(f)));
    }
  }
  try {
    const all = fs.readdirSync(P.backups()).filter((n) => n.startsWith('before-')).sort();
    for (const old of all.slice(0, -5)) fs.rmSync(path.join(P.backups(), old), { recursive: true, force: true });
  } catch { /* 无备份目录 */ }
  fs.writeFileSync(marker, current);
}

function initData() {
  fs.mkdirSync(userData(), { recursive: true });
  backupOnVersionChange();
  store = new Store(P.db());
  config = new ConfigFile(P.config(), {
    defaultsFile: path.join(__dirname, 'default-config.json'),
    backupDir: P.backups(),
  });
  config.load();
  seedLabLogin();
}

// 验收工具仅准备首次样例凭据；之后的登录、退出与重启复用正式逻辑。
// 标记独立于凭据文件，退出删除凭据后，重启不会悄悄恢复登录。
function seedLabLogin(reset = false) {
  if (!APP_CONFIG.lab) return;
  const marker = path.join(userData(), 'lab-login-initialized');
  if (!reset && fs.existsSync(marker)) return;
  if (reset || (!fs.existsSync(P.access()) && !fs.existsSync(P.apiKey()))) {
    writeApiKey(null);
    writeAccess(localCode(APP_CONFIG.name, APP_CONFIG.role, APP_CONFIG.scenario), APP_CONFIG.role, { accountLogin: true });
  }
  fs.writeFileSync(marker, '1', { mode: 0o600 });
}

// ------------------------------------------------------------ 访问方式：访问码（同事）或 API Key（自用）

function readAccess() {
  try { return JSON.parse(fs.readFileSync(P.access(), 'utf8')); } catch { return {}; }
}

function lastAccount() {
  try {
    const saved = JSON.parse(fs.readFileSync(P.lastAccount(), 'utf8'));
    if (saved.relayUrl !== APP_CONFIG.relayUrl || !/^DF-[A-Z0-9]{5}$/.test(saved.account_no)) return null;
    return { account_no: saved.account_no, name: saved.name || '' };
  } catch { return null; }
}

function rememberAccount(s) {
  if (!/^DF-[A-Z0-9]{5}$/.test(s.account_no || '')) return;
  fs.writeFileSync(P.lastAccount(), JSON.stringify({ relayUrl: APP_CONFIG.relayUrl, account_no: s.account_no, name: s.name || '' }), { mode: 0o600 });
}

// 访问码本身可随时停用，存普通文件即可，避免每次更新后钥匙串弹窗
function writeAccess(code, plan, { accountLogin = readAccess().accountLogin, account = readAccess() } = {}) {
  if (!code) {
    // 保留加密 Key，但明确退出，防止账号退出后自动回退为本机超管。
    fs.writeFileSync(P.signedOut(), '1', { mode: 0o600 });
    fs.rmSync(P.access(), { force: true });
    return;
  }
  fs.writeFileSync(P.access(), JSON.stringify({ code, accountLogin: Boolean(accountLogin),
    account_no: account.account_no, name: account.name, ...(plan ? { plan: verifiedAccountRole(plan) } : {}) }), { mode: 0o600 });
  fs.rmSync(P.signedOut(), { force: true });
}

function readApiKey() {
  try {
    const buf = fs.readFileSync(P.apiKey());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : null;
  } catch {
    return null;
  }
}

function writeApiKey(key) {
  if (!key) { fs.rmSync(P.apiKey(), { force: true }); return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，无法安全保存 Key');
  fs.writeFileSync(P.apiKey(), safeStorage.encryptString(key), { mode: 0o600 });
  fs.rmSync(P.signedOut(), { force: true });
}

// 自用 API Key 优先；只有访问码的内测/付费用户走中转。
function accessMode() {
  if (fs.existsSync(P.signedOut())) return { mode: 'none' };
  const saved = readAccess();
  const preferAccount = saved.accountLogin && APP_CONFIG.relayUrl && saved.code;
  // 云端账号无需解密本机 Key，避免更新后因无关的钥匙串授权阻塞启动和更新检查。
  const access = resolveAccess({ apiKey: preferAccount ? null : readApiKey(), relayUrl: APP_CONFIG.relayUrl, accessCode: saved.code, preferAccount: saved.accountLogin });
  // 只替换验收上游地址，账号与权限判断不因测试环境而改变。
  if (APP_CONFIG.lab && access.mode === 'direct') access.directBase = process.env.DAILY_FEED_LAB_DIRECT_BASE;
  return access;
}

function activeAccount() {
  const mode = accessMode().mode;
  const saved = readAccess();
  return mode !== 'none' && saved.code && (mode === 'relay' || saved.plan === 'owner' || saved.accountLogin) ? saved : null;
}

function makeClient() {
  return new FeedClient({ ...accessMode(), fetchImpl: netFetch });
}

function currentRole() {
  if (accessMode().mode === 'direct') return 'owner';
  const access = readAccess();
  return accessMode().mode === 'relay' && access.code && ['owner', 'beta', 'paid'].includes(access.plan) ? access.plan : 'guest';
}

const authorize = (permission) => requirePermission(currentRole(), permission);
const currentConfig = () => visibleSettings(config.load(), currentRole());

async function refreshLimits() {
  const session = activeAccount();
  const accessFile = P.access();
  if (!session) { limits = {}; return null; }
  const client = new FeedClient({ mode: 'relay', relayUrl: APP_CONFIG.relayUrl, accessCode: session.code, fetchImpl: netFetch });
  const s = await client.status();
  const plan = verifiedAccountRole(s.plan);
  if (P.access() !== accessFile || activeAccount()?.code !== session.code) {
    throw new Error('登录状态已变更，请重试');
  }
  writeAccess(session.code, plan, { account: s });
  rememberAccount(s);
  limits = s.limits || {};
  return s;
}

// ------------------------------------------------------------ 内置名单

function loadRoster() {
  const builtin = JSON.parse(fs.readFileSync(path.join(__dirname, 'roster.json'), 'utf8'));
  // 远程名单（较新时）覆盖内置名单，这样加人不一定要发新版
  try {
    const cached = JSON.parse(fs.readFileSync(P.rosterCache(), 'utf8'));
    if ((cached.version || 0) > (builtin.version || 0)) return cached;
  } catch { /* 无缓存 */ }
  return builtin;
}

async function refreshRemoteRoster() {
  if (!APP_CONFIG.rosterUrl) return;
  try {
    const res = await netFetch(APP_CONFIG.rosterUrl, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
    if (!res.ok) return;
    const r = await res.json();
    if (Array.isArray(r.people) && Array.isArray(r.categories)) {
      fs.writeFileSync(P.rosterCache(), JSON.stringify(r));
    }
  } catch { /* 离线时用内置名单 */ }
}

// ------------------------------------------------------------ 抓取

function sendToUi(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send('backend-event', { channel, data });
}

async function doFetch() {
  if (fetching) return { started: false, reason: 'busy' };
  const mode = accessMode();
  if (mode.mode === 'none') {
    onFetchDone({ ok: false, error: '尚未登录，请在设置里填写登录账号' });
    return { started: false };
  }
  const cfg = fetchSettings(config.load(), currentRole());
  if (!cfg.follows.length && !cfg.keywords.length) {
    onFetchDone({ ok: false, error: '还没有关注任何人，先去「关注」里勾选' });
    return { started: false };
  }
  fetching = true;
  sendToUi('fetch_started', null);
  // 后台进行，不阻塞 IPC
  (async () => {
    const client = makeClient();
    const errors = [];
    try {
      const results = await runOnce(client, store, cfg, { log: (m) => sendToUi('log', m), errors });
      store.addUsage(client.creditsUsed);
      const total = Object.values(results).reduce((s, v) => s + v.length, 0);
      const preview = Object.values(results).flatMap((v) => v.slice(0, 3))
        .slice(0, 3).map((t) => ({ author: (t.author || {}).userName, text: (t.text || '').slice(0, 120) }));
      // 访问码失效或额度用尽属于整体失败
      const fatal = errors.find((e) => /登录账号|访问码|额度|余额/.test(e.message));
      onFetchDone(fatal && !total
        ? { ok: false, error: fatal.message, quota: client.quota }
        : { ok: true, new: total, errors, preview, credits: client.creditsUsed, quota: client.quota });
    } catch (e) {
      store.addUsage(client.creditsUsed);
      onFetchDone({ ok: false, error: e.message });
    } finally {
      fetching = false;
    }
  })();
  return { started: true };
}

function onFetchDone(data) {
  lastFetch = { at: new Date().toISOString(), ...data };
  notifyFetch(data);
  updateBadge();
  sendToUi('fetch_done', data);
}

function notifyFetch(data) {
  if (APP_CONFIG.lab) return;
  if (!Notification.isSupported()) return;
  if (!data.ok) {
    new Notification({ title: 'Daily Feed 抓取失败', body: data.error || '未知错误' }).show();
    return;
  }
  if (!data.new) return;
  const body = (data.preview || []).map((p) => `@${p.author}: ${p.text.replace(/\s+/g, ' ')}`).join('\n');
  const n = new Notification({ title: `新增 ${data.new} 条帖子`, body: body.slice(0, 240) });
  n.on('click', () => { if (win) { win.show(); win.focus(); } });
  n.show();
}

function updateBadge() {
  if (APP_CONFIG.lab) return;
  try {
    const { unread } = store.counts();
    if (process.platform === 'darwin') app.dock.setBadge(unread ? String(unread) : '');
  } catch { /* 忽略 */ }
}

// ------------------------------------------------------------ 定时：每周选定的几天、固定时间点
// 错过的时间点（关机、睡眠、应用没开）在下次启动或唤醒时补抓一次，不会连补多次。

function readLastAuto() {
  try { return Number(fs.readFileSync(P.lastAuto(), 'utf8')) || 0; } catch { return 0; }
}

function writeLastAuto(ms) {
  fs.writeFileSync(P.lastAuto(), String(ms));
}

function schedule() {
  clearTimeout(timer);
  timer = null;
  nextRun = null;
  const cfg = config.load();
  if (!activeDays(cfg).length || accessMode().mode === 'none') {
    sendToUi('schedule', { next: null });
    return;
  }
  const now = new Date();
  const lastAuto = readLastAuto();
  // 首次启用只记录，不立即抓
  if (!lastAuto) writeLastAuto(now.getTime());
  const prev = prevSlot(cfg.schedule_days, cfg.schedule_time, now);
  if (lastAuto && prev && prev.getTime() > lastAuto) {
    writeLastAuto(now.getTime());
    doFetch();
  }
  const next = nextSlot(cfg.schedule_days, cfg.schedule_time, now);
  nextRun = next.toISOString();
  // 最多 7 天，在 setTimeout 的上限（约 24.8 天）以内
  timer = setTimeout(schedule, Math.max(1000, next - now));
  sendToUi('schedule', { next: nextRun });
}

// ------------------------------------------------------------ 更新

function initUpdater() {
  updater = new Updater({
    manifestUrl: APP_CONFIG.updateManifestUrl,
    currentVersion: app.getVersion(),
    fetchImpl: netFetch,
    workDir: path.join(app.getPath('temp'), 'daily-feed-update'),
    ...(APP_CONFIG.lab ? {
      workDir: path.join(app.getPath('temp'), `daily-feed-${APP_CONFIG.name}-update-${process.pid}`),
      bundleId: `local.dailyfeed.${APP_CONFIG.name}`,
      allowedDownloadOrigin: new URL(APP_CONFIG.relayUrl).origin,
    } : {}),
    onProgress: (p) => sendToUi('update_progress', p),
  });
}

async function checkForUpdate({ silent = false } = {}) {
  try {
    const info = await updater.check();
    pendingUpdate = info.available ? info : null;
    sendToUi('update_status', publicUpdateInfo(info));
    return publicUpdateInfo(info);
  } catch (e) {
    if (!silent) sendToUi('update_status', { error: e.message });
    return { error: e.message };
  }
}

function publicUpdateInfo(info) {
  const { manifest, ...rest } = info;
  return { ...rest, configured: Boolean(APP_CONFIG.updateManifestUrl) };
}

async function installUpdate() {
  if (!pendingUpdate) throw new Error('当前没有可用更新');
  if (fetching) throw new Error('正在抓取，请稍后再安装更新');
  await updater.download(pendingUpdate.manifest);
  updater.installAndRelaunch();
  app.isQuitting = true;
  setTimeout(() => app.quit(), 300);
  return { ok: true };
}

// Feedback outboxes are partitioned by signed-in account, independently of local posts.
const feedbackQueues = new Map();
async function feedbackQueue() {
  const session = activeAccount(), revision = authRevision, file = P.db(), dbStore = store;
  if (!session) throw new Error('请先登录账号后反馈');
  const code = session.code, scope = session.account_no || code;
  const key = `${file}:${scope}:${revision}`;
  const guard = () => {
    if (P.db() !== file || activeAccount()?.code !== code || authRevision !== revision) throw new Error('登录状态已变更，请重试');
  };
  if (!feedbackQueues.has(key)) {
    const client = new FeedClient({ mode: 'relay', relayUrl: APP_CONFIG.relayUrl, accessCode: code, fetchImpl: netFetch });
    const queue = new FeedbackQueue({ storage: {
      get: async () => { guard(); return JSON.parse(dbStore.getState(`feedback:${scope}`) || 'null'); },
      put: async (data) => { guard(); dbStore.setState(`feedback:${scope}`, JSON.stringify(data)); },
    }, client: {
      submitFeedback: async (event) => { guard(); const result = await client.submitFeedback(event); guard(); return result; },
      readFeedback: async (ids) => { guard(); const result = await client.readFeedback(ids); guard(); return result; },
    }, uuid: () => require('node:crypto').randomUUID() });
    feedbackQueues.set(key, queue.load().then(() => ({ queue, guard })));
  }
  const result = await feedbackQueues.get(key); guard(); return result;
}

// ------------------------------------------------------------ IPC

const handlers = {
  list: (p) => store.list(p || {}),
  sources: () => store.sources(),
  counts: () => store.counts(),
  set_flag: (p) => { const r = store.setFlag(p.ids, p.field, p.value); updateBadge(); return r; },
  mark_all_read: (p) => { const r = store.markAllRead(p && p.source); updateBadge(); return r; },
  get_config: () => currentConfig(),
  estimate: (p) => { authorize('viewApiCosts'); return estimateMonthlyCost({ ...config.load(), ...(p || {}) }); },
  usage: () => { authorize('viewApiCosts'); return store.usage(); },
  roster: () => loadRoster(),
};

function labInfo() {
  if (!APP_CONFIG.lab) return { enabled: false };
  return { enabled: true, environment: APP_CONFIG.name, label: APP_CONFIG.label,
    role: APP_CONFIG.role, scenario: APP_CONFIG.scenario, roles: ROLES, scenarios: SCENARIOS,
    live: APP_CONFIG.live, dataPath: userData() };
}

ipcMain.handle('lab-info', () => labInfo());
ipcMain.handle('lab-copy-account', async () => {
  if (!APP_CONFIG.lab) throw new Error('正式环境不开放验收控制');
  const id = crypto.createHash('sha256').update(localCode(APP_CONFIG.name, APP_CONFIG.role, APP_CONFIG.scenario)).digest('hex');
  const r = await netFetch(`${APP_CONFIG.relayUrl}/admin/codes`, {
    headers: { Authorization: `Bearer ${process.env.DAILY_FEED_LAB_TOKEN}` }, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('读取样例账号失败');
  const account = (await r.json()).accounts.find((a) => a.id === id);
  if (!account) throw new Error('没有找到样例账号');
  clipboard.writeText(account.account_no);
  return { ok: true };
});
ipcMain.handle('lab-preview-update', async () => {
  if (!APP_CONFIG.lab) throw new Error('正式环境不开放验收控制');
  const version = app.getVersion().split('.').map(Number);
  version[2] += 1;
  const response = await netFetch(`${APP_CONFIG.relayUrl}/admin/publish/latest.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DAILY_FEED_LAB_TOKEN}` },
    body: JSON.stringify({ version: version.join('.'), notes: '改善阅读体验和稳定性。关注、收藏与阅读记录保留。',
      url: `${APP_CONFIG.relayUrl}/fixtures/update-preview.zip`, sha256: '0'.repeat(64), size: 128 * 1048576 }),
  });
  if (!response.ok) throw new Error('准备演示更新失败');
  return checkForUpdate();
});
ipcMain.handle('lab-profile', async (_e, { role, scenario }) => {
  if (!APP_CONFIG.lab) throw new Error('正式环境不开放验收控制');
  if (fetching) throw new Error('请等待本次抓取完成后再切换身份');
  validateProfile(role, scenario);
  authRevision++;
  clearTimeout(timer);
  store.close();
  APP_CONFIG.role = role;
  APP_CONFIG.scenario = scenario;
  app.setPath('userData', profilePath(APP_CONFIG.root, APP_CONFIG.name, role, scenario));
  lastFetch = null;
  limits = {};
  initData();
  seedLabLogin(true);
  await refreshLimits().catch(() => {});
  schedule();
  win.reload();
  return { ok: true };
});
ipcMain.handle('lab-topup', async () => {
  if (!APP_CONFIG.lab || currentRole() !== 'paid') throw new Error('只可为本地付费验收账号模拟充值');
  const client = makeClient();
  const status = await client.status();
  const response = await netFetch(`${APP_CONFIG.relayUrl}/admin/topup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DAILY_FEED_LAB_TOKEN}` },
    body: JSON.stringify({ ref: status.account_no, cny: 10, note: '验收模拟转账充值，不是真实资金' }),
  });
  if (!response.ok) throw new Error('模拟充值失败');
  return { ok: true };
});

ipcMain.handle('backend', (_e, method, params) => {
  const h = handlers[method];
  if (!h) throw new Error(`不允许的方法: ${method}`);
  return h(params);
});
ipcMain.handle('save-config', (_e, cfg) => {
  const before = config.load();
  const saved = config.save(applySettings(before, cfg, currentRole()), limits);
  // 从关闭切回开启时，关闭期间错过的时间点不补抓，从现在开始重新计时
  if (!activeDays(before).length && activeDays(saved).length) writeLastAuto(Date.now());
  schedule();
  return visibleSettings(saved, currentRole());
});
ipcMain.handle('feedback-state', async (_e, id) => {
  if (!POST_ID.test(String(id))) throw new Error('帖子编号无效');
  const { queue, guard } = await feedbackQueue(); guard(); return queue.state(String(id));
});
ipcMain.handle('feedback-sync', async (_e, ids = []) => {
  if (!Array.isArray(ids) || ids.length > 200 || ids.some((id) => !POST_ID.test(id))) throw new Error('帖子编号无效');
  const { queue, guard } = await feedbackQueue();
  try { const result = await queue.refresh(ids); guard(); return result; }
  catch (e) { guard(); throw e; }
});
ipcMain.handle('feedback-set', async (_e, id, value, context) => {
  const { queue, guard } = await feedbackQueue(); guard();
  const row = store.db.prepare('SELECT raw,source FROM tweets WHERE id=?').get(String(id));
  if (!row) throw new Error('帖子不存在');
  const snapshot = snapshotFromRaw(row.raw, row.source);
  const result = await queue.set(snapshot, value, { view: String(context?.view || '').slice(0, 40), sort: String(context?.sort || '').slice(0, 40),
    position: context?.position, platform: 'desktop', app_version: app.getVersion(), algorithm_version: 'baseline-v1' });
  guard(); return result;
});
ipcMain.handle('feedback-retry', async () => {
  const { queue, guard } = await feedbackQueue(); const result = await queue.flush(); guard(); return result;
});
ipcMain.handle('translate-post', async (_e, id) => {
  const session = activeAccount();
  if (!session) throw new Error('请先登录账号后使用翻译');
  if (typeof id !== 'string' || id.length > 128) throw new Error('帖子编号无效');
  const row = store.db.prepare('SELECT raw FROM tweets WHERE id = ?').get(id);
  if (!row) throw new Error('帖子不存在');
  const { extractPost } = require('./core/post');
  const post = extractPost(row.raw);
  const texts = [post?.text || ''];
  if (post?.quoted?.text) texts.push(post.quoted.text);
  const client = new FeedClient({ mode: 'relay', relayUrl: APP_CONFIG.relayUrl, accessCode: session.code, fetchImpl: netFetch });
  const result = await client.translate(texts);
  if (activeAccount()?.code !== session.code) throw new Error('登录状态已变更，请重试');
  return result;
});
ipcMain.handle('fetch-now', () => doFetch());
ipcMain.handle('access-info', async () => {
  const m = accessMode();
  const info = { mode: m.mode, relayConfigured: Boolean(APP_CONFIG.relayUrl),
    hasApiKey: m.mode === 'direct', hasAccount: Boolean(activeAccount()), limits };
  if (activeAccount()) {
    try {
      const s = await refreshLimits();
      Object.assign(info, { name: s.name, plan: s.plan || 'beta', account_no: s.account_no, quota: s.quota, balance: s.balance, limits });
    } catch (e) {
      info.error = e.message;
    }
  }
  const identity = identityFor(currentRole());
  if (!identity.permissions.viewMonthlyQuota) delete info.quota;
  if (!identity.permissions.viewBalance) delete info.balance;
  return { ...info, ...identity };
});
ipcMain.handle('last-account', () => lastAccount());
ipcMain.handle('set-access-code', async (_e, code) => {
  authorize('configureAccessCode');
  if (fetching) throw new Error('请等待当前抓取完成后再登录或退出');
  code = String(code || '').trim();
  const revision = ++authRevision;
  if (/^DF-?[A-Z0-9]{5}$/i.test(code)) code = code.toUpperCase().replace(/^DF-?/, 'DF-');
  if (!code) { writeAccess(null); limits = {}; schedule(); return { ok: true }; }
  if (!APP_CONFIG.relayUrl) throw new Error('账号服务暂不可用，请联系支持');
  // 先验证再保存
  const client = new FeedClient({ mode: 'relay', relayUrl: APP_CONFIG.relayUrl, accessCode: code, fetchImpl: netFetch });
  const accessFile = P.access();
  const s = await client.status();
  if (P.access() !== accessFile || revision !== authRevision) throw new Error('登录状态已变更，请重新登录');
  if (fetching) throw new Error('请等待当前抓取完成后再登录或退出');
  writeAccess(s.account_no || code, verifiedAccountRole(s.plan), { accountLogin: true, account: s });
  rememberAccount(s);
  limits = s.limits || {};
  // 立即按新的限制修正已有配置（比如最短间隔）
  config.save(config.load(), limits);
  schedule();
  return { ok: true, name: s.name, quota: s.quota, limits };
});
// 登录账号本身是私密凭证。只在用户主动复制时写入剪贴板，不传回页面或状态接口。
ipcMain.handle('copy-login-account', () => {
  authorize('configureAccessCode');
  const saved = activeAccount();
  const code = saved?.account_no || saved?.code;
  if (!code) throw new Error('请先登录账号');
  clipboard.writeText(code);
  return { ok: true };
});
ipcMain.handle('set-api-key', (_e, key) => {
  authorize('configureApi');
  writeApiKey(String(key || '').trim());
  const saved = readAccess();
  if (saved.code) writeAccess(saved.code, saved.plan, { accountLogin: !readApiKey() });
  if (readApiKey()) limits = {};
  schedule();
});
ipcMain.handle('use-cloud-api', async () => {
  authorize('configureApi');
  if (fetching) throw new Error('请等待当前抓取完成后再切换 API');
  const status = await refreshLimits();
  if (!status || status.plan !== 'owner') throw new Error('请先登录独立超管账号');
  const saved = activeAccount();
  writeAccess(saved.code, 'owner', { accountLogin: true });
  limits = {};
  schedule();
  return { ok: true };
});
ipcMain.handle('status', () => ({ lastFetch, next: nextRun, version: app.getVersion() }));
ipcMain.handle('check-update', () => checkForUpdate());
ipcMain.handle('install-update', () => installUpdate());
ipcMain.handle('open-url', (_e, url) => {
  // 帖子里的链接交给系统浏览器打开；只允许 http(s)，防止 file:、javascript: 之类的地址
  let u;
  try { u = new URL(String(url)); } catch { return; }
  if (u.protocol === 'https:' || u.protocol === 'http:') return shell.openExternal(u.href);
});
ipcMain.handle('reveal-data', () => shell.openPath(userData()));

// ------------------------------------------------------------ 窗口

function createWindow() {
  win = new BrowserWindow({
    show: !backgroundTest,
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    title: APP_CONFIG.lab ? `${LAB_APP_NAME} · ${APP_CONFIG.label}` : 'Daily Feed',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1419',
    webPreferences: {
      backgroundThrottling: !backgroundTest,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // macOS 上关闭窗口只隐藏，保持后台定时抓取
  win.on('close', (e) => {
    if (process.platform === 'darwin' && !APP_CONFIG.lab && !app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// 时间选择器的分钟每 5 分钟一格；已保存的时间不是 5 的倍数时（如旧配置）对齐到整格，
// 让界面显示的时间和实际抓取的时间一致
function alignScheduleTime() {
  const cfg = config.load();
  const [h, m] = cfg.schedule_time.split(':').map(Number);
  const aligned = Math.floor(m / 5) * 5;
  if (aligned !== m) config.save({ ...cfg, schedule_time: `${String(h).padStart(2, '0')}:${String(aligned).padStart(2, '0')}` }, limits);
}

// 只允许一个实例，否则两个进程会同时写数据库
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win && !backgroundTest) { win.show(); win.focus(); } });

  app.whenReady().then(async () => {
    // 只对正式安装包启用；源码、测试外壳和预发环境不移动应用或弹出安装提示。
    const packaged = app.isPackaged && app.getAppPath() === path.join(process.resourcesPath, 'app');
    if (packaged && !await ensureInstalled({ app, dialog, packaged })) return;
    try {
      initData();
    } catch (e) {
      if (backgroundTest) console.error('Daily Feed 无法启动：', e.message);
      else dialog.showErrorBox('Daily Feed 无法启动', `读取数据失败：${e.message}\n\n数据目录：${userData()}`);
      app.quit();
      return;
    }
    alignScheduleTime();
    initUpdater();
    createWindow();
    refreshLimits().catch(() => {});
    schedule();
    updateBadge();
    refreshRemoteRoster();
    // 启动后稍等再检查更新，不拖慢打开速度
    setTimeout(() => checkForUpdate({ silent: true }), 5000);
    // 电脑睡眠期间 setTimeout 不准，唤醒后重新调度（会补抓错过的时间点）
    powerMonitor.on('resume', () => schedule());
  });
}

app.on('activate', () => { if (win && !backgroundTest) win.show(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  clearTimeout(timer);
  try { if (store) store.close(); } catch { /* 忽略 */ }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || APP_CONFIG.lab) app.quit();
});
