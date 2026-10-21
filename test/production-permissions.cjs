// 在无验收权限的正式入口验证首次激活：普通用户不能通过 IPC 获得超管或身份切换能力。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-feed-permissions-'));
for (const key of Object.keys(process.env)) if (key.startsWith('DAILY_FEED_')) delete process.env[key];
Object.assign(process.env, {
  DAILY_FEED_ENV: 'production', DAILY_FEED_USER_DATA: dir,
  DAILY_FEED_RELAY: 'http://127.0.0.1:1', DAILY_FEED_MANIFEST: 'http://127.0.0.1:1/v1/latest',
  DAILY_FEED_ROSTER: 'http://127.0.0.1:1/v1/roster',
});
require('../desktop/main');
const timeout = setTimeout(() => { console.error('Production permission smoke timeout'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    const run = (code) => win.webContents.executeJavaScript(code);
    const info = await run('api.accessInfo()');
    assert.equal(info.role, 'guest');
    assert.equal(info.permissions.configureApi, false);
    assert.equal((await run('api.labInfo()')).enabled, false);
    await assert.rejects(run('api.setApiKey("cannot-create-owner")'), /权限不足/);
    await assert.rejects(run('api.labProfile({role:"owner",scenario:"normal"})'), /正式环境不开放/);
    await assert.rejects(run('api.labCopyAccount()'), /正式环境不开放/);
    await assert.rejects(run('api.labPreviewUpdate()'), /正式环境不开放/);
    await assert.rejects(run('api.saveConfig({role:"owner"})'), /权限不足/);
    assert.ok(!fs.existsSync(path.join(dir, 'api_key.bin')));
    assert.equal((await run('api.accessInfo()')).role, 'guest');
    assert.equal(await run('getComputedStyle(document.getElementById("api-key-box")).display'), 'none');
    console.log('Production permissions passed: 首次激活不显示 API 输入，IPC 无法提权或切换身份');
    clearTimeout(timeout);
    app.exit(0);
  } catch (e) { console.error(e); clearTimeout(timeout); app.exit(1); }
});
process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
