// Exercise the deployed browser bundle without Node integration or an Electron preload.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', path.join(process.env.MOBILE_SMOKE_ROOT, 'browser'));
app.on('browser-window-created', (_event, win) => {
  for (const event of ['show', 'focus']) win.on(event, () => { console.error(`移动验收意外触发 ${event}`); app.exit(1); });
});
const timer = setTimeout(() => { console.error('mobile UI timeout'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 390, height: 844,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', (_event, details) => {
    if (details.message?.includes('Content Security Policy') || details.message?.includes('Uncaught')) errors.push(details.message);
  });
  const run = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (expression) => {
    for (let i = 0; i < 500; i++) {
      if (await run(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待失败：${expression}; ${JSON.stringify(await run(`({url:location.href, login:document.getElementById('login-error')?.textContent, message:document.getElementById('message')?.textContent})`))}; console: ${errors.join('; ')}`);
  };
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const reload = () => new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.reload(); });
  const login = async (code) => {
    await run(`document.getElementById('account').value=${JSON.stringify(code)};document.getElementById('login-form').requestSubmit()`);
    await waitFor(`!document.getElementById('app').hidden`);
  };
  const screenshot = async (name) => {
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(() => true)');
    fs.mkdirSync(process.env.MOBILE_SMOKE_SHOTS, { recursive: true });
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(process.env.MOBILE_SMOKE_SHOTS, name + '.png'), image.toPNG());
  };
  const layout = async () => {
    assert.equal(await run(`document.documentElement.scrollWidth <= innerWidth + 1`), true, '手机宽度不应横向溢出');
    assert.equal(await run(`Boolean(document.querySelector('meta[name=viewport]').content.includes('viewport-fit=cover'))`), true);
    assert.equal(await run(`getComputedStyle(document.getElementById('account')).fontSize`), '16px');
    assert.deepEqual(await run(`Array.from(document.querySelectorAll('#app input:not([type=checkbox]), #app select')).filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(el => el.id)`), [], '输入框与选择器不应触发 iPhone 自动放大');
    if (await run(`!document.getElementById('app').hidden`)) {
      assert.equal(await run(`(() => {
        const main = document.getElementById('content').getBoundingClientRect();
        const nav = document.querySelector('.tabbar').getBoundingClientRect();
        const actions = document.getElementById('follow-actions');
        const bottom = actions.hidden ? nav.top : actions.getBoundingClientRect().top;
        return main.bottom <= bottom + 1 && nav.bottom <= innerHeight + 1 && main.height > 100 &&
          (actions.hidden || actions.getBoundingClientRect().bottom <= nav.top + 1);
      })()`), true, '内容、保存栏与导航不能相互遮挡');
    }
  };
  try {
    await win.loadURL(process.env.MOBILE_SMOKE_URL + '/mobile/');
    await waitFor(`!document.getElementById('login').hidden`);
    await layout();
    await screenshot('login-390');
    await login(process.env.MOBILE_SMOKE_ACCOUNT);
    await click('[data-tab="following"]');
    await require('./mobile-follows-ui.cjs')({ run, click, waitFor, reload, screenshot, layout });
    await click('#roster [data-username="karpathy"]');
    await click('#roster [data-username="simonw"]');
    await click('#save-follows');
    await waitFor(`document.getElementById('follow-count').textContent.includes('2')`);
    await layout();
    await screenshot('following-390');
    await click('[data-tab="reading"]');
    await click('#fetch');
    await waitFor(`document.querySelectorAll('#feed article').length === 6 && !document.getElementById('fetch').disabled`);
    await layout();
    await click('#feed .translation-button');
    await waitFor(`document.querySelector('#feed .translation-output')?.hidden === false`);
    assert.ok(await run(`document.querySelector('#feed .translation-output').textContent.includes('样例译文')`));
    await layout();
    await screenshot('translation-390');
    await click('#feed .translation-button');
    assert.equal(await run(`document.querySelector('#feed .translation-output').hidden`), true);
    await waitFor(`document.querySelector('#feed .feedback-button')?.disabled === false`);
    await click('#feed .feedback-button');
    await waitFor(`document.querySelector('#feed .feedback-button')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#feed .feedback-status').textContent.includes('已同步')`);
    await screenshot('feedback-390');
    await click('#feed .feedback-buttons button:nth-child(2)');
    await waitFor(`document.querySelector('#feed .feedback-buttons button:nth-child(2)').getAttribute('aria-pressed') === 'true'`);
    await click('#feed .feedback-buttons button:nth-child(2)');
    await waitFor(`document.querySelector('#feed .feedback-buttons button:nth-child(2)').getAttribute('aria-pressed') === 'false' && !document.querySelector('#feed .feedback-button').disabled`);
    await screenshot('feed-390');
    await click('#feed [data-flag="starred"]');
    await waitFor(`document.querySelector('#feed [data-flag="starred"]').getAttribute('aria-pressed') === 'true'`);
    await click('[data-view="starred"]');
    assert.equal(await run(`document.querySelectorAll('#feed article').length`), 1);
    await click('#feed [data-flag="read"]');
    await waitFor(`document.querySelector('#feed [data-flag="read"]').getAttribute('aria-pressed') === 'true'`);
    await click('[data-view="unread"]');
    assert.equal(await run(`document.querySelectorAll('#feed article').length`), 5);
    await run(`document.getElementById('search').value = 'simonw'; document.getElementById('search').dispatchEvent(new Event('input'))`);
    assert.equal(await run(`document.querySelectorAll('#feed article').length`), 3);
    await win.webContents.session.serviceWorkers.getAllRunning();
    await waitFor(`navigator.serviceWorker.getRegistration().then(r => Boolean(r?.active))`);
    // Reopen through the service worker, then prove a real browser navigation works offline.
    await reload();
    await waitFor(`!document.getElementById('app').hidden`);
    await win.webContents.session.enableNetworkEmulation({ offline: true });
    // Chromium can exempt localhost from network emulation; explicitly fail API traffic.
    win.webContents.session.webRequest.onBeforeRequest({ urls: [process.env.MOBILE_SMOKE_URL + '/v1/*'] }, (_details, callback) => callback({ cancel: true }));
    await reload();
    await waitFor(`!document.getElementById('app').hidden`);
    assert.equal(await run(`document.querySelectorAll('#feed article').length`), 6);
    assert.equal(await run(`document.getElementById('network').hidden`), false);
    assert.ok(await run(`performance.getEntriesByType('navigation')[0].workerStart > 0`));
    await waitFor(`document.querySelector('#feed .feedback-button')?.disabled === false`);
    await click('#feed .feedback-button');
    await waitFor(`document.querySelector('#feed .feedback-status').textContent.includes('待同步')`);
    await reload(); await waitFor(`!document.getElementById('app').hidden`);
    await waitFor(`document.querySelector('#feed .feedback-status')?.textContent.includes('待同步')`);
    await win.webContents.session.disableNetworkEmulation();
    win.webContents.session.webRequest.onBeforeRequest(null);
    await click('#feed .feedback-buttons button:nth-child(3)');
    await waitFor(`document.querySelector('#feed .feedback-status')?.textContent.includes('已同步')`);
    await click('[data-tab="settings"]');
    await click('#refresh-account');
    await waitFor(`!document.getElementById('save-schedule').disabled`);
    await run(`document.getElementById('schedule-enabled').click(); document.getElementById('schedule-frequency').value='daily'; document.getElementById('schedule-frequency').dispatchEvent(new Event('change')); document.getElementById('schedule-time').value='09:30'; true`);
    await click('#save-schedule');
    await waitFor(`document.getElementById('schedule-status').textContent.includes('下次抓取')`);
    assert.equal(await run(`document.getElementById('schedule-enabled').checked`), true);
    await run(`document.getElementById('schedule-form').scrollIntoView({block:'start'}); true`);
    await screenshot('settings-390');
    await reload();
    await waitFor(`!document.getElementById('app').hidden && !document.getElementById('save-schedule').disabled`);
    await click('[data-tab="settings"]');
    assert.equal(await run(`document.getElementById('schedule-enabled').checked`), true);
    assert.equal(await run(`document.getElementById('schedule-frequency').value`), 'daily');
    assert.equal(await run(`document.getElementById('schedule-time').value`), '09:30');
    await click('#schedule-enabled'); await click('#save-schedule');
    await waitFor(`document.getElementById('schedule-status').textContent.includes('已关闭')`);
    assert.equal(await run(`document.getElementById('schedule-fields').disabled`), true);
    assert.equal(await run(`document.getElementById('schedule-time').value`), '09:30');
    const cached = await run(`caches.keys().then(async keys => (await Promise.all(keys.map(k => caches.open(k).then(c => c.keys())))).flat().map(r => r.url))`);
    assert.ok(cached.length >= 6);
    assert.ok(cached.every((url) => new URL(url).pathname.startsWith('/mobile/')));
    await run(`window.confirm = () => true; true`);
    await click('#logout');
    await waitFor(`!document.getElementById('login').hidden`);
    await reload();
    await waitFor(`!document.getElementById('login').hidden`);
    await login(process.env.MOBILE_SMOKE_EMPTY);
    assert.equal(await run(`document.querySelectorAll('#feed article').length`), 0);
    await click('[data-tab="settings"]');
    assert.match(await run(`document.getElementById('account-usage').textContent`), /余额 ¥0.00/);
    assert.doesNotMatch(await run(`document.getElementById('account-usage').textContent`), /月额度/);
    await run(`window.confirm = () => true; true`); await click('#logout');
    await waitFor(`!document.getElementById('login').hidden`);
    await login(process.env.MOBILE_SMOKE_EXHAUSTED);
    await click('[data-tab="following"]');
    await click('#roster [data-username="karpathy"]'); await click('#save-follows');
    await waitFor(`document.getElementById('follow-count').textContent.includes('1')`);
    await click('#fetch');
    await waitFor(`document.getElementById('message').textContent.includes('额度已用完')`);
    await run(`window.confirm = () => true; true`); await click('[data-tab="settings"]'); await click('#logout');
    await waitFor(`!document.getElementById('login').hidden`);
    await login(process.env.MOBILE_SMOKE_ACCOUNT);
    await click('[data-view="starred"]');
    assert.equal(await run(`document.querySelectorAll('#feed article').length`), 1);
    for (const [width, height] of [[320, 568], [375, 667], [390, 420], [430, 932], [844, 390]]) {
      win.setContentSize(width, height);
      await run(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(() => true)`);
      await layout();
      await click('[data-tab="following"]'); await layout();
      await run(`document.getElementById('content').scrollTop=1000; true`);
      assert.equal(await run(`(() => { const el=document.getElementById('save-follows');const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el===hit||el.contains(hit);})()`), true, '滚动长名单时保存按钮始终可见、可点击');
      await click('[data-tab="settings"]'); await layout();
      await run(`document.getElementById('save-schedule').scrollIntoView({block:'center'}); true`);
      assert.equal(await run(`(() => { const el=document.getElementById('save-schedule');const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el===hit||el.contains(hit);})()`), true, '定时设置保存按钮不被导航遮挡');
      await click('[data-tab="reading"]');
    }
    assert.deepEqual(errors, []);
    console.log('移动版浏览器验收通过：320–844px、登录/关注/抓取/搜索/收藏/已读、账号隔离、额度错误、离线导航与持久化、安全缓存。');
    clearTimeout(timer); app.exit(0);
  } catch (e) { console.error(e); clearTimeout(timer); app.exit(1); }
});
