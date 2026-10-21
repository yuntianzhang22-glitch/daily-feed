// 启动实际主进程、preload 和渲染页面，验证 IPC、身份切换和界面；不用真实账号。
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
require('../desktop/main');

const timeout = setTimeout(() => { console.error('UI smoke timeout'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const waitLoaded = () => new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await waitLoaded();
    const run = (code) => win.webContents.executeJavaScript(code);
    const denied = (code) => assert.rejects(run(code), /权限不足/);
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
    await run('openSettings().then(() => renderAccess())');
    assert.equal(await run('document.getElementById("access-title").textContent'), 'API 连接');
    assert.equal(await run('getComputedStyle(document.getElementById("access-code-row")).display'), 'none');
    assert.notEqual(await run('getComputedStyle(document.getElementById("api-key-box")).display'), 'none');
    assert.equal((await run('api.accessInfo()')).permissions.configureApi, true);
    await denied('api.setAccessCode("df_do_not_overwrite_owner")');
    assert.doesNotMatch(await run('document.getElementById("access-hint").textContent'), /内测|月额度|充值|访问码/);
    await run('document.getElementById("settings").close()');
    for (const [role, scenario, expected] of [
      ['beta', 'normal', 'beta'], ['beta', 'exhausted', 'beta'], ['beta', 'disabled', 'beta'],
      ['paid', 'empty', 'paid'], ['paid', 'normal', 'paid'], ['paid', 'low', 'paid'], ['paid', 'disabled', 'paid'],
    ]) {
      const loaded = waitLoaded();
      await run(`api.labProfile(${JSON.stringify({ role, scenario })})`);
      await loaded;
      await ready();
      assert.equal((await run('api.accessInfo()')).role, expected);
      assert.equal((await run('api.labInfo()')).scenario, scenario);
      await run('openSettings().then(() => renderAccess())');
      const hint = await run('document.getElementById("access-hint").textContent');
      assert.match(hint, scenario === 'disabled' ? /停用/ : role === 'paid' ? /余额 ¥/ : /本月额度/);
      assert.equal(await run('document.getElementById("access-title").textContent'), '访问码');
      assert.notEqual(await run('getComputedStyle(document.getElementById("access-code-row")).display'), 'none');
      for (const id of ['api-key-box', 'keywords-box', 'estimate-panel', 'avg-posts-field']) {
        assert.equal(await run(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).display`), 'none');
      }
      const before = await run('api.getConfig()');
      assert.ok(!('keywords' in before));
      await denied('api.setApiKey("cannot_promote_to_owner")');
      await denied('api.saveConfig({role:"owner"})');
      await denied('api.saveConfig({keywords:["forbidden"]})');
      await denied('api.usage()');
      await denied('api.estimate({})');
      assert.deepEqual(await run('api.getConfig()'), before);
      assert.equal((await run('api.accessInfo()')).role, role);
      assert.ok((await run('api.saveConfig({include_replies:false})')).follows.length > 0);
      const info = await run('api.accessInfo()');
      if (role === 'paid') assert.ok(!('quota' in info));
      else assert.ok(!('balance' in info));
      if (role === 'paid' && scenario === 'empty') {
        await run('api.labTopup()');
        assert.ok((await run('api.accessInfo()')).balance.cny >= 10);
      }
      await assert.rejects(run('api.setAccessCode("df_production_do_not_use")'));
    }
    console.log('UI smoke passed: 三类身份全部状态、界面权限隔离、IPC 越权拒绝、充值和普通设置保存');
    clearTimeout(timeout);
    app.exit(0);
  } catch (e) { console.error(e); clearTimeout(timeout); app.exit(1); }
});
