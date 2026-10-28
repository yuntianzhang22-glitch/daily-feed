// 在隔离的实际 Electron 页面中验证批量选择，保存前不改动配置。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async (run, win) => {
  const original = await run('api.getConfig()');
  const limits = await run('accessLimits');
  const originalSize = win.getContentSize();
  const click = (id) => run(`document.getElementById(${JSON.stringify(id)}).click()`);
  const draft = () => run('[...followDraft]');
  const search = (value) => run(`$('roster-query').value = ${JSON.stringify(value)}; $('roster-query').dispatchEvent(new Event('input'))`);
  try {
    await run('openFollows()');
    await click('clear-follows');
    assert.deepEqual(await draft(), []);
    assert.equal(await run("$('clear-follows').disabled"), true);
    assert.equal(await run("$('roster-select-all').indeterminate"), false);
    assert.deepEqual((await run('api.getConfig()')).follows, original.follows);
    await click('undo-follows');
    assert.deepEqual(await draft(), original.follows);
    assert.equal(await run("$('undo-follows').disabled"), true);

    // 选中结果外的自定义账号始终保留；匹配支持 @ 和大小写。
    await run("followDraft = ['OutsideRoster']; followHistory = []; renderFollowList(); syncRosterSelection()");
    await search('@KARPATHY');
    assert.equal(await run("$('roster-list').querySelectorAll('input').length"), 1);
    await click('roster-select-all');
    assert.deepEqual(await draft(), ['OutsideRoster', 'karpathy']);
    assert.equal(await run("$('roster-select-all').checked"), true);
    await click('roster-deselect');
    assert.deepEqual(await draft(), ['OutsideRoster']);
    await click('roster-invert');
    assert.deepEqual(await draft(), ['OutsideRoster', 'karpathy']);
    await click('roster-invert');
    assert.deepEqual(await draft(), ['OutsideRoster']);

    // 分类批量选择、部分选择态和反选。
    await search('');
    await run("document.querySelectorAll('#roster-cats button')[1].click()");
    const categoryNames = await run('matchingPeople().map(p => p.username)');
    assert.ok(categoryNames.length > 3);
    await run('accessLimits = { ...accessLimits, max_follows: 500 }');
    await click('roster-select-all');
    assert.deepEqual(await draft(), ['OutsideRoster', ...categoryNames]);
    await run("document.querySelector('#roster-list .who').click()");
    assert.equal(await run("$('roster-select-all').indeterminate"), true);
    await click('roster-invert');
    assert.deepEqual(await draft(), ['OutsideRoster', categoryNames[0]]);
    await click('undo-follows');
    assert.deepEqual(await draft(), ['OutsideRoster', ...categoryNames.slice(1)]);

    // 整行点击和 checkbox 共用 Shift 范围选择，也支持连续取消。
    await click('clear-follows');
    await run(`(() => {
      const rows = document.querySelectorAll('#roster-list .who');
      rows[0].click();
      rows[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    })()`);
    assert.deepEqual(await draft(), categoryNames.slice(0, 4));
    await run(`(() => {
      const boxes = document.querySelectorAll('#roster-list input');
      boxes[0].click();
      boxes[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    })()`);
    assert.deepEqual(await draft(), []);

    // 超过上限只加入可容纳的账号，并同步实际勾选状态。
    await run('accessLimits = { ...accessLimits, max_follows: 2 }');
    await click('roster-select-all');
    assert.deepEqual(await draft(), categoryNames.slice(0, 2));
    assert.match(await run("$('follows-error').textContent"), /最多可关注 2 人/);
    await run("document.querySelectorAll('#roster-list input')[2].click()");
    assert.equal(await run("document.querySelectorAll('#roster-list input')[2].checked"), false);
    assert.equal(await run("document.querySelectorAll('#roster-list input:checked').length"), 2);
    await click('undo-follows');
    assert.deepEqual(await draft(), []);

    await search('no_such_person_zzzz');
    for (const id of ['roster-select-all', 'roster-deselect', 'roster-invert']) {
      assert.equal(await run(`$(${JSON.stringify(id)}).disabled`), true);
    }
    await click('cancel-follows');
    await run('openFollows()');
    assert.deepEqual(await draft(), original.follows);
    assert.equal(await run("$('undo-follows').disabled"), true);

    // 记录实际排版，保存清空结果并验证重新打开后确实为空。
    await run(`accessLimits = ${JSON.stringify(limits)}; true`);
    const frame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(() => true)');
    for (const [width, height] of [[800, 540], originalSize]) {
      win.setContentSize(width, height);
      await frame();
      assert.equal(await run(`(() => {
        const el = $('save-follows'); const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.bottom <= innerHeight && (el === hit || el.contains(hit));
      })()`), true, '长名单与较小窗口中保存按钮始终可见、可点击');
    }
    fs.mkdirSync(path.join(__dirname, '../.local/follows-screenshots'), { recursive: true });
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '../.local/follows-screenshots/desktop.png'), shot.toPNG());
    assert.equal(await run("$('follows-dialog').scrollWidth <= $('follows-dialog').clientWidth"), true);
    await click('clear-follows');
    await run('saveFollows()');
    assert.deepEqual((await run('api.getConfig()')).follows, []);
    await run('openFollows()');
    assert.deepEqual(await draft(), []);
    console.log('关注批量验收通过：清空/多步撤销、筛选全选/取消/反选、整行与 Shift 连选、上限、取消与保存持久化');
  } finally {
    win.setContentSize(...originalSize);
    await run(`$('follows-dialog').close(); accessLimits = ${JSON.stringify(limits)}; api.saveConfig(${JSON.stringify(original)})`);
  }
};
