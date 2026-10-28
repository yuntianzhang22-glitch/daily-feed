// 启动实际主进程、preload 和渲染页面，验证 IPC、身份切换和界面；不用真实账号。
const { app, BrowserWindow, clipboard, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const { localCode } = require('../desktop/core/environment');
const { extractPost } = require('../desktop/core/post');
let copiedAccount;
clipboard.writeText = (text) => { copiedAccount = text; };
// 测试进程只存本地样例 Key；替换钥匙串 OS 边界，避免无人值守验收被授权弹窗阻塞。
safeStorage.isEncryptionAvailable = () => true;
safeStorage.encryptString = (text) => Buffer.from('smoke-test:' + text);
safeStorage.decryptString = (buffer) => {
  assert.ok(buffer.toString().startsWith('smoke-test:'));
  return buffer.toString().slice('smoke-test:'.length);
};
// 自动验收全程不得显示窗口或抢焦点（包括重载和模态弹窗）。
app.on('browser-window-created', (_event, window) => {
  for (const event of ['show', 'focus']) window.on(event, () => {
    console.error(`后台验收意外触发窗口 ${event}`);
    app.exit(1);
  });
});
require('../desktop/main');

const timeout = setTimeout(() => { console.error('UI smoke timeout'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    assert.equal(win.isVisible(), false);
    assert.equal(win.isFocused(), false);
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
    // 实际页面必须完整显示长正文和引用长帖，不得只通过解析器单测。
    const longText = '研究解读 👋 '.repeat(70) + '外层全文结尾';
    const quoteText = '方法、实验与结果。'.repeat(90) + '引用全文结尾';
    const longPost = extractPost({ id: 'long-post-regression', text: longText, displayTextRange: [0, 280],
      author: { userName: 'sample' }, quoted_tweet: { id: 'long-quote', text: quoteText,
        displayTextRange: [0, 280], author: { userName: 'source' },
        extendedEntities: { media: [{ url: 'https://t.co/ABSENT', indices: [281, 304] }] },
      } });
    const rendered = await run(`(() => {
      const card = renderTweet(${JSON.stringify({ id: 'long-post-regression', source: 'user:sample', author: 'sample', is_read: true, post: longPost })});
      document.getElementById('feed').append(card);
      const nodes = [...card.querySelectorAll('.tweet-text')];
      const result = nodes.map(n => ({ text: n.textContent, clamp: getComputedStyle(n).webkitLineClamp, clipped: n.scrollHeight > n.clientHeight }));
      card.remove();
      return result;
    })()`);
    assert.deepEqual(rendered.map(n => n.text), [longText, quoteText]);
    assert.ok(rendered.every(n => n.clamp === 'none' && !n.clipped));
    await run(`(async () => {
      let calls = 0;
      const control = translationControl({ document, texts: ['hello', 'quote'], translate: async () => {
        calls++; return { texts: ['你好 <script>bad()</script>', '引用译文'] };
      } });
      document.getElementById('feed').append(control);
      const button = control.querySelector('button'); button.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!control.textContent.includes('引用译文') || control.querySelector('script') || button.getAttribute('aria-expanded') !== 'true') throw new Error('译文展示错误');
      button.click(); if (!control.querySelector('.translation-output').hidden) throw new Error('收起译文失败');
      button.click(); if (calls !== 1) throw new Error('切换重复请求');
      control.remove();
      const failed = translationControl({ document, texts: ['hello'], translate: async () => { throw new Error('翻译服务尚未启用'); } });
      document.body.append(failed); failed.querySelector('button').click();
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!failed.textContent.includes('翻译服务尚未启用') || failed.querySelector('button').disabled) throw new Error('翻译失败反馈错误');
      failed.remove();
    })()`);
    console.log('Long-post rendering passed: 长正文和引用全文完整显示，无行数或高度截断');
    assert.equal(await run('document.getElementById("lab-panel").hidden'), false);
    assert.equal(await run('document.getElementById("lab-copy-account").hidden'), false);
    assert.equal(app.getName(), 'Daily Feed Test');
    if (process.platform === 'darwin') assert.ok(process.execPath.includes('/Daily Feed Test.app/'));
    assert.equal(await run('document.querySelector(".brand").textContent'), 'Daily Feed Test');
    assert.equal((await run('api.labInfo()')).role, 'owner');
    assert.equal((await run('api.accessInfo()')).mode, 'relay');
    assert.ok((await run('api.counts()')).total > 0);
    const feedbackTweet = (await run('api.list({limit:1})'))[0];
    await run('loadFeed(true)');
    const waitFeedback = async (expression) => {
      for (let i = 0; i < 200; i++) { if (await run(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error('反馈界面未完成：' + expression);
    };
    await waitFeedback(`document.querySelector('#feed .feedback-button')?.disabled === false`);
    await run(`document.querySelector('#feed .feedback-button').click()`);
    await waitFeedback(`document.querySelector('#feed .feedback-status').textContent.includes('已同步') && document.querySelector('#feed .feedback-button').getAttribute('aria-pressed') === 'true'`);
    assert.equal((await run(`api.feedbackState(${JSON.stringify(feedbackTweet.post.id)})`)).value, 1);
    await run(`document.querySelector('#feed .feedback-buttons button:nth-child(2)').click()`);
    await waitFeedback(`document.querySelector('#feed .feedback-buttons button:nth-child(2)').getAttribute('aria-pressed') === 'true' && !document.querySelector('#feed .feedback-buttons button:nth-child(2)').disabled`);
    await run(`document.querySelector('#feed .feedback-buttons button:nth-child(2)').click()`);
    await waitFeedback(`document.querySelector('#feed .feedback-buttons button:nth-child(2)').getAttribute('aria-pressed') === 'false' && !document.querySelector('#feed .feedback-button').disabled`);
    const response = await fetch(process.env.DAILY_FEED_LAB_URL + '/admin/feedback/stats', { headers: { Authorization: 'Bearer ' + process.env.DAILY_FEED_LAB_TOKEN } });
    const stats = await response.json();
    assert.equal(stats.totals.changes, 3); assert.equal(stats.totals.up, 0); assert.equal(stats.totals.down, 0);
    console.log('桌面反馈验收通过：真实按钮/IPC/服务端存储/改踩/取消/统计，未调用 X。');
    await require('./follows-ui.cjs')(run, win);
    await run('openSettings().then(() => renderAccess())');
    assert.equal(await run('document.getElementById("access-title").textContent'), '账号登录');
    assert.equal(await run('getComputedStyle(document.getElementById("access-code-row")).display'), 'none');
    assert.notEqual(await run('getComputedStyle(document.getElementById("api-key-box")).display'), 'none');
    assert.equal((await run('api.accessInfo()')).permissions.configureApi, true);
    assert.equal(await run('document.getElementById("api-key").disabled'), false);
    await run(`api.setApiKey(${JSON.stringify(process.env.DAILY_FEED_LAB_KEY)})`);
    await assert.rejects(run('api.setAccessCode("df_do_not_overwrite_owner")'), /无效/);
    await run('api.copyLoginAccount()');
    assert.equal(copiedAccount, (await run('api.accessInfo()')).account_no);
    assert.equal((await run('api.accessInfo()')).mode, 'direct');
    await run('api.useCloudApi()');
    assert.equal((await run('api.accessInfo()')).mode, 'relay');
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
      assert.equal(await run('document.getElementById("access-title").textContent'), '账号登录');
      assert.equal(await run('getComputedStyle(document.getElementById("access-code-row")).display'), 'none');
      assert.equal(await run('document.getElementById("copy-account").disabled'), false);
      assert.equal(await run('document.getElementById("logout-account").disabled'), false);
      const code = localCode('test', role, scenario);
      await run('copyLoginAccount()');
      assert.equal(copiedAccount, (await run('api.accessInfo()')).account_no || code);
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
      // 通过真实页面退出、重载后仍未登录，再用同一页面登录；不能靠样例选择器强行授予身份。
      const counts = await run('api.counts()');
      await run('window.confirm = () => true; logoutAccount()');
      assert.equal((await run('api.accessInfo()')).role, 'guest');
      assert.equal((await run('api.fetchNow()')).started, false);
      const reloaded = waitLoaded();
      win.reload();
      await reloaded;
      await ready();
      await run('openSettings().then(() => renderAccess())');
      assert.equal((await run('api.accessInfo()')).mode, 'none');
      assert.equal(await run('document.getElementById("access-code").disabled'), false);
      assert.deepEqual(await run('api.counts()'), counts);
      await run('api.labCopyAccount()');
      assert.match(copiedAccount, /^DF-[A-Z0-9]{5}$/);
      await assert.rejects(run(`api.setAccessCode(${JSON.stringify(localCode('staging', role, scenario))})`), /无效/);
      await assert.rejects(run('api.setAccessCode("df_production_do_not_use")'), /无效/);
      if (scenario === 'disabled') {
        await run(`document.getElementById('access-code').value = ${JSON.stringify(code)}; saveAccessCode()`);
        assert.match(await run('document.getElementById("access-hint").textContent'), /停用/);
        assert.equal((await run('api.accessInfo()')).role, 'guest');
      } else {
        await run(`document.getElementById('access-code').value = ${JSON.stringify(code)}; saveAccessCode()`);
        assert.equal((await run('api.accessInfo()')).role, role);
      }
    }
    // 当前选择付费停用样例，实际登录内测正常账号时只能拥有内测权限。
    await run(`api.setAccessCode(${JSON.stringify(localCode('test', 'beta', 'normal'))})`);
    const actual = await run('api.accessInfo()');
    assert.equal(actual.role, 'beta');
    assert.equal(actual.permissions.viewBalance, false);
    assert.equal(actual.permissions.viewMonthlyQuota, true);
    console.log('UI smoke passed: 三类身份全部状态、真实登录/复制/退出/重载、停用拒绝、跨环境拒绝、权限按实际账号、充值和设置');
    clearTimeout(timeout);
    app.exit(0);
  } catch (e) { console.error(e); clearTimeout(timeout); app.exit(1); }
});
