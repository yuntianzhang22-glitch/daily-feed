const assert = require('node:assert/strict');

module.exports = async ({ run, click, waitFor, reload, screenshot, layout }) => {
  const selected = () => run(`Array.from(document.querySelectorAll('#followed [data-username]'), b => b.dataset.username)`);
  const search = (value) => run(`document.getElementById('roster-search').value = ${JSON.stringify(value)}; document.getElementById('roster-search').dispatchEvent(new Event('input'))`);
  await run(`document.getElementById('username').value = 'OutsideRoster'; document.getElementById('add-form').requestSubmit()`);
  assert.deepEqual(await selected(), ['OutsideRoster']);
  await search('@KARPATHY');
  await click('#roster-select-all');
  assert.deepEqual(await selected(), ['OutsideRoster', 'karpathy']);
  await click('#roster-deselect');
  assert.deepEqual(await selected(), ['OutsideRoster']);
  await click('#roster-invert');
  assert.deepEqual(await selected(), ['OutsideRoster', 'karpathy']);
  await click('#roster-invert');
  assert.deepEqual(await selected(), ['OutsideRoster']);

  await search('');
  await click('#categories button:nth-child(2)');
  const group = await run(`Array.from(document.querySelectorAll('#roster [data-username]'), b => b.dataset.username)`);
  assert.ok(group.length > 3);
  await click('#roster-select-all');
  assert.deepEqual(await selected(), ['OutsideRoster', ...group]);
  await click('#roster button');
  await click('#roster-invert');
  assert.deepEqual(await selected(), ['OutsideRoster', group[0]]);
  await click('#undo-follows');
  assert.deepEqual(await selected(), ['OutsideRoster', ...group.slice(1)]);
  await click('#clear-follows');
  assert.deepEqual(await selected(), []);
  assert.equal(await run(`document.getElementById('clear-follows').disabled`), true);
  await click('#undo-follows');
  assert.deepEqual(await selected(), ['OutsideRoster', ...group.slice(1)]);
  await click('#reset-follows');
  assert.deepEqual(await selected(), []);
  assert.equal(await run(`document.getElementById('save-follows').disabled`), true);

  // 真实内测账号上限是 60，批量选择先保留已有账号，明确反馈未选人数。
  await click('#categories [data-category=""]');
  await click('#roster-select-all');
  assert.equal((await selected()).length, 60);
  assert.equal(await run(`document.getElementById('followed').clientHeight <= 320`), true, '长关注列表不应把批量操作推到很远的位置');
  assert.match(await run(`document.getElementById('message').textContent`), /最多可关注 60 人/);
  assert.match(await run(`document.getElementById('follow-count').textContent`), /已保存 0 人/);
  await click('#undo-follows');
  assert.deepEqual(await selected(), []);
  await search('no_such_person_zzzz');
  for (const id of ['roster-select-all', 'roster-deselect', 'roster-invert']) {
    assert.equal(await run(`document.getElementById(${JSON.stringify(id)}).disabled`), true);
  }
  await search('');
  await layout();
  await screenshot('following-bulk-390');

  // 保存后撤销历史清空；清空必须保存才持久化，重新加载仍为空。
  await click('#roster [data-username="karpathy"]');
  await click('#save-follows');
  await waitFor(`document.getElementById('follow-count').textContent === '已保存 1 人'`);
  assert.equal(await run(`document.getElementById('undo-follows').disabled`), true);
  await click('#clear-follows');
  assert.match(await run(`document.getElementById('follow-count').textContent`), /已保存 1 人/);
  await click('#undo-follows');
  assert.deepEqual(await selected(), ['karpathy']);
  await click('#clear-follows');
  await click('#save-follows');
  await waitFor(`document.getElementById('follow-count').textContent === '已保存 0 人'`);
  await reload();
  await waitFor(`!document.getElementById('app').hidden`);
  await click('[data-tab="following"]');
  assert.deepEqual(await selected(), []);
  assert.equal(await run(`document.getElementById('undo-follows').disabled`), true);
  console.log('移动关注批量验收通过：筛选全选/取消/反选、清空与多步撤销、放弃修改、上限和保存持久化');
};
