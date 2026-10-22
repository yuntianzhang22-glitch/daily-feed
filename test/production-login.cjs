const { app, BrowserWindow, clipboard, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
// CI 的无前台会话无法读取系统剪贴板；只替换 OS 边界，验证实际 IPC 写入的值。
let copiedAccount;
clipboard.writeText = (text) => { assert.equal(typeof text, 'string'); copiedAccount = text; };
// 正式入口的自动化进程没有用户钥匙串授权，替换 OS 边界避免弹窗阻塞。
// 这里只保存样例 Key；真实加密读写另由品牌测试应用的界面验收覆盖。
safeStorage.isEncryptionAvailable = () => true;
safeStorage.encryptString = (text) => Buffer.from('login-test:' + text);
safeStorage.decryptString = (buffer) => {
  const text = buffer.toString();
  assert.ok(text.startsWith('login-test:'));
  return text.slice('login-test:'.length);
};
const phase = process.env.LOGIN_SMOKE_PHASE;
const code = process.env.LOGIN_SMOKE_ACCOUNT;
const accountNo = process.env.LOGIN_SMOKE_NUMBER;
const role = process.env.LOGIN_SMOKE_ROLE;
const timeout = setTimeout(() => { console.error('Production login timeout'); app.exit(1); }, 30000);
// 自动验收全程不得显示窗口或抢焦点（包括重载和模态弹窗）。
app.on('browser-window-created', (_event, window) => {
  for (const event of ['show', 'focus']) window.on(event, () => {
    console.error(`后台验收意外触发窗口 ${event}`);
    app.exit(1);
  });
});
require('../desktop/main');
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    assert.equal(win.isVisible(), false);
    assert.equal(win.isFocused(), false);
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    const run = (js) => win.webContents.executeJavaScript(js);
    const isHidden = (id) => run(`document.getElementById(${JSON.stringify(id)}).hidden`);
    if (phase === 'disabled-history') {
      await run('openLogin()');
      await run('document.getElementById("login-previous").click(); submitLogin()');
      assert.equal((await run('api.accessInfo()')).role, 'guest');
      assert.equal(await run('document.getElementById("login-dialog").open'), true);
      assert.match(await run('document.getElementById("login-error").textContent'), /无效或已停用/);
      clearTimeout(timeout);
      app.exit(0);
      return;
    }
    if (phase === 'update') {
      for (let i = 0; i < 240; i++) {
        if (await run('document.getElementById("update-dialog").open')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(await run('document.getElementById("update-dialog").open'), true,
        JSON.stringify(await run('api.checkUpdate()')));
      assert.equal(await run('document.activeElement.id'), 'update-later');
      const text = await run('document.getElementById("update-dialog").innerText');
      assert.match(text, /发现新版本.*Daily Feed/s);
      assert.match(text, /128 MB/);
      assert.doesNotMatch(text, /超管|内测|付费|管理员|API/);
      assert.equal(await run('document.querySelector("#update-dialog-notes img")'), null);
      assert.match(await run('document.getElementById("update-dialog-notes").textContent'), /<img/);
      await run('document.getElementById("update-later").click()');
      await run('api.checkUpdate()');
      assert.equal(await run('document.getElementById("update-dialog").open'), false);
      assert.equal(await isHidden('update-banner'), false);
      await run('document.getElementById("update-banner").click()');
      assert.equal(await run('document.getElementById("update-dialog").open'), true);
      // 不再调用 confirm；双击也只发起一次安装。预览包返回真实 404，保留重试入口。
      await run('window.confirm = () => { throw new Error("不应重复确认"); }; Promise.all([installUpdate(), installUpdate()])');
      assert.match(await run('document.getElementById("update-dialog-error").textContent'), /下载失败（404）/);
      assert.equal(await run('document.getElementById("update-now").disabled'), false);
      assert.equal(await run('document.getElementById("update-now").textContent'), '重试');
      assert.equal(await run('document.getElementById("update-later").disabled'), false);
      await run('installUpdate()');
      assert.equal(await run('document.getElementById("update-dialog").open'), true);
      await run('document.getElementById("update-later").click(); checkUpdate()');
      assert.equal(await run('document.getElementById("update-dialog").open'), true);
      assert.equal((await run('api.accessInfo()')).role, role);
      console.log(`${process.env.DAILY_FEED_ENV}/${role} update dialog passed: 启动自动提示、稍后不重复、手动打开、失败重试、文案隔离`);
      clearTimeout(timeout);
      app.exit(0);
      return;
    }
    const checkVisibleCopy = async (currentRole) => {
      if (currentRole === 'owner') return;
      // innerText 排除隐藏项；验收面板位于设置之外，不属于真实用户界面。
      const text = await run('document.getElementById("settings").innerText');
      assert.doesNotMatch(text, /超管|管理员|内测|付费用户|普通用户|API|twitterapi/i);
      if (currentRole !== 'paid') assert.doesNotMatch(text, /充值|转账|余额/);
      if (currentRole === 'paid') assert.doesNotMatch(text, /本月额度/);
      if (currentRole === 'guest') {
        assert.equal(await run('document.getElementById("access-code").placeholder'), '输入账号编号，例如 DF-XXXXX');
      }
      if (process.env.DAILY_FEED_ENV === 'production') assert.equal(await isHidden('lab-panel'), true);
    };
    if (phase === 'logout-restart') {
      assert.equal((await run('api.accessInfo()')).role, 'guest');
      assert.equal((await run('api.accessInfo()')).mode, 'none');
      assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'access.json')), false);
      await run('openLogin()');
      assert.equal((await run('api.lastAccount()')).account_no, accountNo);
      assert.equal(await isHidden('login-previous'), false);
      await run('document.getElementById("login-previous").click()');
      assert.equal((await run('api.accessInfo()')).role, 'guest');
      assert.equal(await run('document.getElementById("login-account").value'), accountNo);
      await run('submitLogin()');
      assert.equal((await run('api.accessInfo()')).role, role);
      assert.equal(await run('document.getElementById("login-dialog").open'), false);
      await run('window.confirm = () => true; logoutAccount()');
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
      for (let i = 0; i < 100 && !await run('document.getElementById("login-dialog").open'); i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(await run('document.getElementById("login-dialog").open'), true);
      if (phase === 'first' && process.env.DAILY_FEED_ENV === 'production') assert.equal(await isHidden('login-previous'), true);
      await run('submitLogin()');
      assert.match(await run('document.getElementById("login-error").textContent'), /请输入账号编号/);
      const previous = await run('api.lastAccount()');
      await run('document.getElementById("login-account").value="DF-00000"; submitLogin()');
      assert.equal((await run('api.accessInfo()')).role, 'guest');
      assert.deepEqual(await run('api.lastAccount()'), previous);
      assert.equal(await run('document.getElementById("login-dialog").open'), true);
      await run(`document.getElementById('login-account').value = ${JSON.stringify(accountNo.toLowerCase())}; submitLogin()`);
      assert.equal(await run('document.getElementById("login-dialog").open'), false);
      await run('openSettings().then(() => renderAccess())');
    } else {
      // 第二次启动同一数据目录，不输入任何凭证。
      assert.equal((await run('api.accessInfo()')).role, role);
      assert.deepEqual((await run('api.getConfig()')).follows, ['naval']);
      await run('openSettings().then(() => renderAccess())');
    }
    const info = await run('api.accessInfo()');
    assert.equal(info.role, role);
    assert.equal(info.account_no, accountNo);
    if (role === 'paid') assert.equal(info.balance.cny, Number(process.env.LOGIN_SMOKE_BALANCE));
    if (role === 'owner') {
      assert.equal(info.mode, 'relay');
      assert.equal(info.permissions.configureKeywords, true);
      assert.equal('balance' in info, false);
      assert.equal('quota' in info, false);
    }
    assert.equal(JSON.stringify(info).includes(code), false);
    assert.equal(await isHidden('access-code-row'), true);
    assert.equal(await isHidden('account-actions'), false);
    assert.equal(await isHidden('api-key-box'), role !== 'owner');
    await checkVisibleCopy(role);
    if (role !== 'owner') {
      await assert.rejects(run('api.setApiKey("cannot-promote")'), /权限不足/);
      await assert.rejects(run('api.useCloudApi()'), /权限不足/);
    }
    await run('copyLoginAccount()');
    assert.equal(copiedAccount, accountNo);
    if (phase === 'first') {
      await run('api.saveConfig({follows:["naval"],schedule_enabled:false})');
      assert.equal(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'access.json'))).code, accountNo);
      if (role === 'owner') {
        await run(`api.setApiKey(${JSON.stringify(process.env.LOGIN_SMOKE_DIRECT_KEY)})`);
        assert.equal((await run('api.accessInfo()')).mode, 'direct');
        await run('api.useCloudApi()');
        assert.equal((await run('api.accessInfo()')).mode, 'relay');
      }
    }
    if (phase === 'second') {
      assert.notDeepEqual((await run('api.getConfig()')).follows, ['naval']);
      const before = await run('api.getConfig()');
      if (role === 'owner') {
        await run(`api.setApiKey(${JSON.stringify(process.env.LOGIN_SMOKE_DIRECT_KEY)})`);
        assert.equal((await run('api.accessInfo()')).mode, 'direct');
      }
      await run('window.confirm = () => true; logoutAccount()');
      const loggedOut = await run('api.accessInfo()');
      assert.equal(loggedOut.role, 'guest');
      assert.deepEqual(loggedOut.limits, {});
      assert.equal(await run('document.getElementById("login-dialog").open'), true);
      assert.equal(await isHidden('account-actions'), true);
      assert.deepEqual((await run('api.getConfig()')).follows, before.follows);
      assert.equal(loggedOut.mode, 'none');
      assert.doesNotMatch(await run('document.getElementById("login-dialog").innerText'), /API|管理员|超管|内测|付费/);
      await assert.rejects(run('api.setApiKey("cannot-promote-after-logout")'), /权限不足/);
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
