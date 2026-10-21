const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
// CI 的无前台会话无法读取系统剪贴板；只替换 OS 边界，验证实际 IPC 写入的值。
let copiedAccount;
clipboard.writeText = (text) => { assert.equal(typeof text, 'string'); copiedAccount = text; };
const phase = process.env.LOGIN_SMOKE_PHASE;
const code = process.env.LOGIN_SMOKE_ACCOUNT;
const accountNo = process.env.LOGIN_SMOKE_NUMBER;
const timeout = setTimeout(() => { console.error('Production login timeout'); app.exit(1); }, 30000);
require('../desktop/main');
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    const run = (js) => win.webContents.executeJavaScript(js);
    const isHidden = (id) => run(`document.getElementById(${JSON.stringify(id)}).hidden`);
    if (phase === 'logout-restart') {
      assert.equal((await run('api.accessInfo()')).role, 'guest');
      assert.equal((await run('api.accessInfo()')).mode, 'none');
      assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'access.json')), false);
      clearTimeout(timeout);
      app.exit(0);
      return;
    }
    if (phase !== 'restart') {
      // 验收样例首次准备了登录状态；随后和正式版完全一样，从设置退出再登录。
      if ((await run('api.labInfo()')).enabled) {
        await run('openSettings().then(() => renderAccess())');
        await run('window.confirm = () => true; logoutAccount()');
      }
      assert.equal((await run('api.accessInfo()')).role, 'guest');
      await run('openSettings().then(() => renderAccess())');
      assert.equal(await isHidden('access-code-row'), false);
      // 公开的充值短编号不能用来登录，失败后仍为未登录。
      await assert.rejects(run(`api.setAccessCode(${JSON.stringify(accountNo)})`), /无效/);
      assert.equal((await run('api.accessInfo()')).role, 'guest');
      await run(`document.getElementById('access-code').value = ${JSON.stringify(code)}; saveAccessCode()`);
    } else {
      // 第二次启动同一数据目录，不输入任何凭证。
      assert.equal((await run('api.accessInfo()')).role, 'paid');
      assert.deepEqual((await run('api.getConfig()')).follows, ['naval']);
      await run('openSettings().then(() => renderAccess())');
    }
    const info = await run('api.accessInfo()');
    assert.equal(info.role, 'paid');
    assert.equal(info.account_no, accountNo);
    assert.equal(info.balance.cny, Number(process.env.LOGIN_SMOKE_BALANCE));
    assert.equal(JSON.stringify(info).includes(code), false);
    assert.equal(await isHidden('access-code-row'), true);
    assert.equal(await isHidden('account-actions'), false);
    assert.equal(await isHidden('api-key-box'), true);
    await assert.rejects(run('api.setApiKey("cannot-promote")'), /权限不足/);
    await run('copyLoginAccount()');
    assert.equal(copiedAccount, code);
    if (phase === 'first') {
      await run('api.saveConfig({follows:["naval"],schedule_enabled:false})');
      assert.equal(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'access.json'))).code, code);
    }
    if (phase === 'second') {
      assert.notDeepEqual((await run('api.getConfig()')).follows, ['naval']);
      const before = await run('api.getConfig()');
      await run('window.confirm = () => true; logoutAccount()');
      const loggedOut = await run('api.accessInfo()');
      assert.equal(loggedOut.role, 'guest');
      assert.deepEqual(loggedOut.limits, {});
      assert.equal(await isHidden('access-code-row'), false);
      assert.equal(await isHidden('account-actions'), true);
      assert.deepEqual(await run('api.getConfig()'), before);
      assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'access.json')), false);
      await assert.rejects(run('api.copyLoginAccount()'), /请先登录/);
    }
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
