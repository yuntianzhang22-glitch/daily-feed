// Electron 主进程：窗口、抓取（进程内 Node 后端）、定时、通知、访问码、内置名单、应用内更新。
const {
  app, BrowserWindow, dialog, ipcMain, net, Notification, powerMonitor, safeStorage, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');

const { Store } = require('./core/store');
const { ConfigFile } = require('./core/config');
const { FeedClient } = require('./core/client');
const { runOnce, estimateMonthlyCost, cleanUsernames } = require('./core/fetcher');
const { Updater } = require('./core/updater');
const { nextSlot, prevSlot } = require('./core/schedule');

// 构建时写入的服务地址（中转、更新清单、名单）。开发时可以用环境变量覆盖。
const APP_CONFIG = (() => {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8')); } catch { /* 无 */ }
  return {
    relayUrl: process.env.DAILY_FEED_RELAY || cfg.relayUrl || '',
    updateManifestUrl: process.env.DAILY_FEED_MANIFEST || cfg.updateManifestUrl || '',
    rosterUrl: process.env.DAILY_FEED_ROSTER || cfg.rosterUrl || '',
  };
})();

// 所有网络请求都走 Electron 的 net.fetch：它使用系统代理设置（和浏览器一样），
// Node 自带的 fetch 不读系统代理，在需要代理的网络里会连不上
const netFetch = (url, init) => net.fetch(url, init);

// 测试时可用环境变量指向另一个数据目录，避免碰到真实数据
if (process.env.DAILY_FEED_USER_DATA) app.setPath('userData', process.env.DAILY_FEED_USER_DATA);
const userData = () => app.getPath('userData');
const P = {
  db: () => path.join(userData(), 'tweets.db'),
  config: () => path.join(userData(), 'config.json'),
  access: () => path.join(userData(), 'access.json'),
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
}

// ------------------------------------------------------------ 访问方式：访问码（同事）或 API Key（自用）

function readAccess() {
  try { return JSON.parse(fs.readFileSync(P.access(), 'utf8')); } catch { return {}; }
}

// 访问码本身可随时停用，存普通文件即可，避免每次更新后钥匙串弹窗
function writeAccess(code) {
  if (!code) { fs.rmSync(P.access(), { force: true }); return; }
  fs.writeFileSync(P.access(), JSON.stringify({ code }), { mode: 0o600 });
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
}

// 有访问码且配置了中转就走中转；否则用本机 API Key 直连
function accessMode() {
  const access = readAccess();
  if (APP_CONFIG.relayUrl && access.code) return { mode: 'relay', relayUrl: APP_CONFIG.relayUrl, accessCode: access.code };
  const apiKey = readApiKey();
  if (apiKey) return { mode: 'direct', apiKey };
  return { mode: 'none' };
}

function makeClient() {
  return new FeedClient({ ...accessMode(), fetchImpl: netFetch });
}

async function refreshLimits() {
  const m = accessMode();
  if (m.mode !== 'relay') { limits = {}; return null; }
  const client = makeClient();
  const s = await client.status();
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
    onFetchDone({ ok: false, error: '还没有填写访问码，请在设置里填写' });
    return { started: false };
  }
  const cfg = config.load();
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
      const fatal = errors.find((e) => /访问码|额度|余额/.test(e.message));
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
  if (!cfg.schedule_days.length || accessMode().mode === 'none') {
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

// ------------------------------------------------------------ IPC

const handlers = {
  list: (p) => store.list(p || {}),
  sources: () => store.sources(),
  counts: () => store.counts(),
  set_flag: (p) => { const r = store.setFlag(p.ids, p.field, p.value); updateBadge(); return r; },
  mark_all_read: (p) => { const r = store.markAllRead(p && p.source); updateBadge(); return r; },
  get_config: () => config.load(),
  estimate: (p) => estimateMonthlyCost({ ...config.load(), ...(p || {}) }),
  usage: () => store.usage(),
  roster: () => loadRoster(),
};

ipcMain.handle('backend', (_e, method, params) => {
  const h = handlers[method];
  if (!h) throw new Error(`不允许的方法: ${method}`);
  return h(params);
});
ipcMain.handle('save-config', (_e, cfg) => {
  const saved = config.save({ ...config.load(), ...cfg }, limits);
  schedule();
  return saved;
});
ipcMain.handle('fetch-now', () => doFetch());
ipcMain.handle('access-info', async () => {
  const m = accessMode();
  const info = { mode: m.mode, relayConfigured: Boolean(APP_CONFIG.relayUrl), hasApiKey: Boolean(readApiKey()), limits };
  if (m.mode === 'relay') {
    try {
      const s = await refreshLimits();
      Object.assign(info, { name: s.name, quota: s.quota, limits });
    } catch (e) {
      info.error = e.message;
    }
  }
  return info;
});
ipcMain.handle('set-access-code', async (_e, code) => {
  code = String(code || '').trim();
  if (!code) { writeAccess(null); schedule(); return { ok: true }; }
  if (!APP_CONFIG.relayUrl) throw new Error('这个版本没有配置中转服务');
  // 先验证再保存
  const client = new FeedClient({ mode: 'relay', relayUrl: APP_CONFIG.relayUrl, accessCode: code, fetchImpl: netFetch });
  const s = await client.status();
  writeAccess(code);
  limits = s.limits || {};
  // 立即按新的限制修正已有配置（比如最短间隔）
  config.save(config.load(), limits);
  schedule();
  return { ok: true, name: s.name, quota: s.quota, limits };
});
ipcMain.handle('set-api-key', (_e, key) => { writeApiKey(String(key || '').trim()); schedule(); });
ipcMain.handle('status', () => ({ lastFetch, next: nextRun, version: app.getVersion() }));
ipcMain.handle('check-update', () => checkForUpdate());
ipcMain.handle('install-update', () => installUpdate());
ipcMain.handle('open-url', (_e, url) => {
  // 只允许打开 X 的链接
  if (/^https:\/\/(x|twitter)\.com\//.test(url)) return shell.openExternal(url);
});
ipcMain.handle('reveal-data', () => shell.openPath(userData()));

// ------------------------------------------------------------ 窗口

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    title: 'Daily Feed',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1419',
    webPreferences: {
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
    if (process.platform === 'darwin' && !app.isQuitting) {
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
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(async () => {
    try {
      initData();
    } catch (e) {
      dialog.showErrorBox('Daily Feed 无法启动', `读取数据失败：${e.message}\n\n数据目录：${userData()}`);
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

app.on('activate', () => { if (win) win.show(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  clearTimeout(timer);
  try { if (store) store.close(); } catch { /* 忽略 */ }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
