// 启动实际主进程、preload 和渲染页面，验证 IPC、身份切换和界面；不用真实账号。
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
require('../desktop/main');

const timeout = setTimeout(() => { console.error('UI smoke timeout'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const waitLoaded = () => new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await waitLoaded();
    const run = (code) => win.webContents.executeJavaScript(code);
    const ready = async () => {
      for (let i = 0; i < 100; i++) {
        if (await run('Boolean(document.getElementById("lab-role").value)')) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('验收面板没有初始化');
    };
    await ready();
    assert.equal(await run('document.getElementById("lab-panel").hidden'), false);
    assert.equal((await run('api.labInfo()')).role, 'owner');
    assert.equal((await run('api.accessInfo()')).mode, 'direct');
    assert.ok((await run('api.counts()')).total > 0);
    for (const [role, scenario, expected] of [
      ['beta', 'normal', 'beta'], ['beta', 'exhausted', 'beta'], ['paid', 'empty', 'paid'], ['paid', 'normal', 'paid'],
    ]) {
      const loaded = waitLoaded();
      await run(`api.labProfile(${JSON.stringify({ role, scenario })})`);
      await loaded;
      await ready();
      assert.equal((await run('api.accessInfo()')).plan, expected);
      assert.equal((await run('api.labInfo()')).scenario, scenario);
      await run('document.getElementById("settings-btn").click()');
      for (let i = 0; i < 100; i++) {
        if (await run('document.getElementById("access-hint").textContent.includes("已连接")')) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const hint = await run('document.getElementById("access-hint").textContent');
      assert.match(hint, role === 'paid' ? /余额 ¥/ : /本月额度/);
      if (role === 'paid' && scenario === 'empty') {
        await run('api.labTopup()');
        assert.ok((await run('api.accessInfo()')).balance.cny >= 10);
      }
      await assert.rejects(run('api.setAccessCode("df_production_do_not_use")'));
    }
    console.log('UI smoke passed: 实际 Electron 页面、超管/内测/付费身份、隔离目录、充值与设置文案');
    clearTimeout(timeout);
    app.exit(0);
  } catch (e) { console.error(e); clearTimeout(timeout); app.exit(1); }
});
