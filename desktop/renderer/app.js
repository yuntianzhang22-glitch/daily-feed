// 渲染进程：只通过 window.api 与主进程通信，所有帖子内容都用 textContent 写入，避免 XSS。
const PAGE_SIZE = 50;
const $ = (id) => document.getElementById(id);

const state = {
  view: 'all',      // all | unread | starred | source
  source: null,
  q: '',
  sort: 'time',
  offset: 0,
  hasMore: false,
  fetching: false,
};

// ------------------------------------------------------------ 工具函数

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function formatNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function relTime(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function sourceLabel(src) {
  const [kind, ...rest] = src.split(':');
  const name = rest.join(':');
  return { kind: kind === 'user' ? '账号' : '搜索', name: kind === 'user' ? '@' + name : name };
}

function setStatus(text, isError = false) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('error', isError);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ------------------------------------------------------------ 侧栏

async function refreshSidebar() {
  const [counts, sources] = await Promise.all([api.counts(), api.sources()]);
  setBadge($('count-all'), counts.total, false);
  setBadge($('count-unread'), counts.unread, true);
  setBadge($('count-starred'), counts.starred, false);

  const list = $('sources');
  list.replaceChildren();
  if (!sources.length) {
    list.append(el('li', { class: 'hint', text: '暂无数据，先去设置里添加账号或关键词' }));
  }
  for (const s of sources) {
    const { kind, name } = sourceLabel(s.source);
    const badge = el('span', { class: 'badge' });
    setBadge(badge, s.unread, true);
    const btn = el('button', {
      class: 'nav-item' + (state.view === 'source' && state.source === s.source ? ' active' : ''),
      title: s.source,
      onclick: () => selectView('source', s.source),
    }, el('span', { class: 'label', text: name }), el('span', { class: 'kind', text: kind }), badge);
    list.append(el('li', {}, btn));
  }
}

function setBadge(node, n, highlight) {
  node.textContent = n ? formatNum(n) : '';
  node.classList.toggle('has-unread', Boolean(highlight && n));
}

function selectView(view, source = null) {
  state.view = view;
  state.source = source;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  if (view === 'source') {
    document.querySelectorAll('#sources .nav-item').forEach((b) => {
      if (b.title === source) b.classList.add('active');
    });
    const { name } = sourceLabel(source);
    $('view-title').textContent = name;
  } else {
    document.querySelector(`[data-view="${view}"]`).classList.add('active');
    $('view-title').textContent = { all: '全部', unread: '未读', starred: '收藏' }[view];
  }
  loadFeed(true);
}

// ------------------------------------------------------------ 帖子列表

function listParams() {
  return {
    source: state.view === 'source' ? state.source : null,
    unread: state.view === 'unread',
    starred: state.view === 'starred',
    q: state.q || null,
    sort: state.sort,
    limit: PAGE_SIZE,
    offset: state.offset,
  };
}

async function loadFeed(reset = false) {
  const feed = $('feed');
  if (reset) {
    state.offset = 0;
    feed.replaceChildren();
    feed.scrollTop = 0;
  }
  const tweets = await api.list(listParams());
  feed.querySelector('.load-more')?.remove();
  if (reset && !tweets.length) {
    feed.append(el('p', { class: 'empty', text: emptyText() }));
    return;
  }
  for (const t of tweets) feed.append(renderTweet(t));
  state.offset += tweets.length;
  state.hasMore = tweets.length === PAGE_SIZE;
  if (state.hasMore) {
    feed.append(el('button', { class: 'btn load-more', text: '加载更多', onclick: () => loadFeed(false) }));
  }
}

function emptyText() {
  if (state.q) return '没有匹配的帖子';
  if (state.view === 'unread') return '全部读完了';
  if (state.view === 'starred') return '还没有收藏';
  return '还没有帖子，点「立即抓取」试试';
}

function renderTweet(t) {
  const card = el('article', { class: 'tweet' + (t.is_read ? '' : ' unread'), 'data-id': t.id });

  const avatar = t.avatar
    ? el('img', { class: 'avatar', src: t.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : el('div', { class: 'avatar', 'aria-hidden': 'true' });

  const { name: srcName } = sourceLabel(t.source);
  const head = el('div', { class: 'tweet-head' },
    el('span', { class: 'name', text: t.author_name || t.author || '未知' }),
    el('span', { class: 'handle', text: '@' + (t.author || '?') }),
    el('time', { class: 'time', datetime: t.created_at || '', title: t.created_at || '', text: '· ' + relTime(t.created_at) }),
    el('span', { class: 'src', text: srcName }),
  );

  const starBtn = el('button', {
    class: 'icon-btn star' + (t.starred ? ' on' : ''),
    'aria-pressed': String(t.starred),
    'aria-label': t.starred ? '取消收藏' : '收藏',
    title: t.starred ? '取消收藏' : '收藏',
    text: t.starred ? '★' : '☆',
    onclick: async () => {
      t.starred = !t.starred;
      await api.setFlag([t.id], 'starred', t.starred);
      starBtn.classList.toggle('on', t.starred);
      starBtn.textContent = t.starred ? '★' : '☆';
      starBtn.setAttribute('aria-pressed', String(t.starred));
      starBtn.setAttribute('aria-label', t.starred ? '取消收藏' : '收藏');
      starBtn.title = t.starred ? '取消收藏' : '收藏';
      refreshSidebar();
    },
  });

  const readBtn = el('button', {
    class: 'icon-btn',
    text: t.is_read ? '标为未读' : '标为已读',
    onclick: async () => {
      t.is_read = !t.is_read;
      await api.setFlag([t.id], 'is_read', t.is_read);
      card.classList.toggle('unread', !t.is_read);
      readBtn.textContent = t.is_read ? '标为未读' : '标为已读';
      refreshSidebar();
    },
  });

  const openBtn = el('button', {
    class: 'icon-btn',
    text: '在 X 打开',
    onclick: async () => {
      if (t.url) api.openUrl(t.url);
      if (!t.is_read) {
        t.is_read = true;
        await api.setFlag([t.id], 'is_read', true);
        card.classList.remove('unread');
        readBtn.textContent = '标为未读';
        refreshSidebar();
      }
    },
  });

  const foot = el('div', { class: 'tweet-foot' },
    el('span', { title: '点赞', text: '♥ ' + formatNum(t.likes) }),
    el('span', { title: '转发', text: '⟲ ' + formatNum(t.retweets) }),
    el('span', { title: '回复', text: '💬 ' + formatNum(t.replies) }),
    el('span', { title: '浏览', text: '👁 ' + formatNum(t.views) }),
    el('span', { class: 'actions' }, starBtn, readBtn, openBtn),
  );

  card.append(avatar, el('div', {}, head, el('p', { class: 'tweet-text', text: t.text || '' }), foot));
  return card;
}

// ------------------------------------------------------------ 设置

function lines(text) {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

function errText(err) {
  return String(err.message || err)
    .replace(/^Error invoking remote method '[^']+': /, '')
    .replace(/^Error: /, '')
    .replace(/^\w+Error: /, '');
}

function usd(n) {
  n = Number(n) || 0;
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

function intervalText(hours) {
  if (!hours) return '自动抓取关闭，只能手动抓取';
  if (hours < 24) return `每 ${hours} 小时一次，约每天 ${(24 / hours).toFixed(1).replace(/\.0$/, '')} 次`;
  const perWeek = 168 / hours;
  if (perWeek >= 1) return `约每周 ${perWeek.toFixed(1).replace(/\.0$/, '')} 次`;
  return `约每 ${(hours / 24).toFixed(1).replace(/\.0$/, '')} 天一次`;
}

// ---- 设置

let settingsCfg = null;
let accessLimits = {};

async function openSettings() {
  const [cfg, status] = await Promise.all([api.getConfig(), api.status()]);
  settingsCfg = cfg;
  $('interval-hours').value = cfg.interval_hours ?? 84;
  $('max-per-target').value = cfg.max_per_target ?? 3;
  $('search-mode').value = cfg.search_mode === 'Latest' ? 'Latest' : 'Top';
  $('avg-posts').value = cfg.avg_posts_per_day ?? 2;
  $('include-replies').checked = Boolean(cfg.include_replies);
  $('keywords').value = (cfg.keywords || []).join('\n');
  $('settings-error').textContent = '';
  $('access-code').value = '';
  $('api-key').value = '';
  $('update-text').textContent = `当前版本 ${status.version}`;
  $('settings').showModal();
  updateEstimate();
  renderAccess();
}

function setHint(id, text, kind) {
  const n = $(id);
  n.textContent = text;
  n.classList.toggle('ok', kind === 'ok');
  n.classList.toggle('warn', kind === 'warn');
}

async function renderAccess() {
  setHint('access-hint', '正在检查…');
  const info = await api.accessInfo();
  accessLimits = info.limits || {};
  $('interval-hours').min = accessLimits.min_interval_hours || 0;
  // 中转只放行按关注的人搜索，关键词在中转模式下不可用
  $('keywords-box').hidden = info.mode === 'relay';
  $('key-hint').textContent = info.hasApiKey ? '已保存（加密存储在系统钥匙串中）' : '尚未设置';
  if (!info.relayConfigured) {
    setHint('access-hint', '这个版本没有配置中转服务，请使用 API Key。');
    $('api-key-box').open = true;
    return;
  }
  if (info.mode === 'relay' && info.error) {
    setHint('access-hint', info.error, 'warn');
  } else if (info.mode === 'relay') {
    const q = info.quota || {};
    setHint('access-hint',
      `已连接（${info.name || '已验证'}）。本月共用额度已用 ${usd(q.used_usd)} / ${usd(q.limit_usd)}` +
      (accessLimits.min_interval_hours ? `，抓取间隔不低于 ${accessLimits.min_interval_hours} 小时` : '') + '。', 'ok');
  } else if (info.mode === 'direct') {
    setHint('access-hint', '当前使用本机 API Key 直连。填写访问码后改走中转。');
  } else {
    setHint('access-hint', '还没有填写访问码。向管理员要一个，粘贴到上面。', 'warn');
  }
}

async function saveAccessCode() {
  const code = $('access-code').value.trim();
  if (!code) return;
  const btn = $('save-access');
  btn.disabled = true;
  setHint('access-hint', '正在验证…');
  try {
    await api.setAccessCode(code);
    $('access-code').value = '';
    await renderAccess();
    // 限制（如最短间隔）可能把已有配置改了，重新读一遍
    settingsCfg = await api.getConfig();
    $('interval-hours').value = settingsCfg.interval_hours;
    updateEstimate();
  } catch (err) {
    setHint('access-hint', errText(err), 'warn');
  } finally {
    btn.disabled = false;
  }
}

async function saveApiKey() {
  const key = $('api-key').value.trim();
  if (!key) return;
  try {
    await api.setApiKey(key);
    $('api-key').value = '';
    renderAccess();
  } catch (err) {
    $('key-hint').textContent = errText(err);
  }
}

function settingsForm() {
  return {
    ...settingsCfg,
    interval_hours: Number($('interval-hours').value) || 0,
    max_per_target: Number($('max-per-target').value) || 0,
    search_mode: $('search-mode').value,
    avg_posts_per_day: Number($('avg-posts').value) || 0,
    include_replies: $('include-replies').checked,
    keywords: lines($('keywords').value),
  };
}

const updateEstimate = debounce(async () => {
  const cfg = settingsForm();
  const min = accessLimits.min_interval_hours || 0;
  $('interval-hint').textContent = intervalText(cfg.interval_hours) +
    (min && cfg.interval_hours > 0 && cfg.interval_hours < min ? `（保存时会调整为 ${min} 小时）` : '');
  const [e, used] = await Promise.all([api.estimate(cfg), api.usage()]);
  const extra = e.keywords_high || 0;
  $('est-expected').textContent = usd(e.expected + extra);
  $('est-low').textContent = usd(e.low);
  $('est-high').textContent = usd(e.high + extra);
  $('est-used').textContent = usd(used.usd);
  if (!e.people && !cfg.keywords.length) {
    $('est-detail').textContent = '还没有关注任何人，点侧栏「关注」勾选。';
  } else if (!cfg.interval_hours) {
    $('est-detail').textContent = '自动抓取已关闭，只有手动抓取会产生费用（每次约 $0.003 × 组数）。';
  } else {
    $('est-detail').textContent =
      `${e.people} 人分 ${e.groups} 组，每月约 ${e.runs} 次 × ${e.groups} 组 = ${e.requests} 次请求，` +
      `接口返回约 ${e.tweets} 条。按返回条数计费，与保留几条无关；` +
      `「预计」按每人每天 ${cfg.avg_posts_per_day} 条估算。本月已用为本机估算值。` +
      (extra ? ` 额外关键词最多另加 ${usd(extra)}。` : '');
  }
}, 150);

async function saveSettings(e) {
  e.preventDefault();
  try {
    const saved = await api.saveConfig(settingsForm());
    $('settings').close();
    const adjusted = saved.interval_hours !== (Number($('interval-hours').value) || 0);
    setStatus(adjusted ? `已保存，间隔调整为 ${saved.interval_hours} 小时` : '设置已保存');
  } catch (err) {
    $('settings-error').textContent = errText(err);
  }
}

// ---- 关注（内置名单，本地搜索，不花钱）

let roster = { categories: [], people: [] };
let followDraft = [];
let rosterCat = 'all';

const lower = (s) => String(s || '').toLowerCase();

async function openFollows() {
  const [cfg, r] = await Promise.all([api.getConfig(), api.roster()]);
  roster = r;
  followDraft = [...(cfg.follows || [])];
  $('roster-query').value = '';
  $('follows-error').textContent = '';
  rosterCat = 'all';
  renderCats();
  renderRoster();
  renderFollowList();
  $('follows-dialog').showModal();
  $('roster-query').focus();
}

function isFollowing(username) {
  return followDraft.some((f) => lower(f) === lower(username));
}

function toggleFollow(username, on) {
  followDraft = followDraft.filter((f) => lower(f) !== lower(username));
  if (on) followDraft.push(username);
  renderFollowList();
}

function personFor(username) {
  return roster.people.find((p) => lower(p.username) === lower(username)) || { username, name: '', bio: '' };
}

function catName(id) {
  return (roster.categories.find((c) => c.id === id) || {}).name || '';
}

function renderCats() {
  const box = $('roster-cats');
  box.replaceChildren();
  const counts = {};
  for (const p of roster.people) counts[p.category] = (counts[p.category] || 0) + 1;
  const cats = [{ id: 'all', name: `全部 ${roster.people.length}` },
    ...roster.categories.map((c) => ({ id: c.id, name: `${c.name} ${counts[c.id] || 0}` }))];
  for (const c of cats) {
    box.append(el('button', {
      class: 'chip', type: 'button', text: c.name, 'aria-pressed': String(rosterCat === c.id),
      onclick: () => { rosterCat = c.id; renderCats(); renderRoster(); },
    }));
  }
}

function personRow(p, control) {
  const initial = el('div', { class: 'initial', 'aria-hidden': 'true', text: (p.name || p.username).slice(0, 1).toUpperCase() });
  return el('li', { class: 'user-row' },
    initial,
    el('div', { class: 'who' },
      el('div', { class: 'top' },
        el('span', { class: 'name', text: p.name || p.username }),
        el('span', { class: 'meta', text: '@' + p.username }),
        p.category ? el('span', { class: 'cat', text: catName(p.category) }) : null,
      ),
      p.bio ? el('p', { class: 'bio', title: p.bio, text: p.bio }) : null,
    ),
    control,
  );
}

function renderRoster() {
  const q = lower($('roster-query').value.trim()).replace(/^@/, '');
  const list = $('roster-list');
  list.replaceChildren();
  const matches = roster.people.filter((p) => (rosterCat === 'all' || p.category === rosterCat) &&
    (!q || [p.username, p.name, p.bio].some((s) => lower(s).includes(q))));
  if (!matches.length) {
    list.append(el('li', { class: 'empty-row', text: '名单里没有匹配的人。需要加新的人请联系管理员。' }));
  }
  for (const p of matches) {
    const id = `pick-${p.username}`;
    const box = el('input', { type: 'checkbox', id, 'aria-label': `关注 ${p.name || p.username}` });
    box.checked = isFollowing(p.username);
    box.addEventListener('change', () => toggleFollow(p.username, box.checked));
    list.append(personRow(p, box));
  }
  $('roster-hint').textContent = `名单共 ${roster.people.length} 人，更新于 ${roster.updated || '-'}。`;
}

function renderFollowList() {
  const list = $('follow-list');
  list.replaceChildren();
  $('follow-count').textContent = `（${followDraft.length} 人）`;
  if (!followDraft.length) {
    list.append(el('li', { class: 'empty-row', text: '还没有关注任何人，在上面勾选' }));
  }
  for (const username of followDraft) {
    const p = personFor(username);
    const btn = el('button', {
      class: 'btn', type: 'button', text: '移除', 'aria-label': `移除 @${username}`,
      onclick: () => { toggleFollow(username, false); renderRoster(); },
    });
    list.append(personRow(p, btn));
  }
  updateFollowsCost();
}

const updateFollowsCost = debounce(async () => {
  const cfg = { ...(await api.getConfig()), follows: followDraft };
  const e = await api.estimate(cfg);
  $('follows-cost').textContent = e.people
    ? `按当前间隔（${intervalText(cfg.interval_hours)}），预计每月 ${usd(e.expected)}，最多 ${usd(e.high)}。`
    : '';
}, 150);

async function saveFollows() {
  try {
    const cfg = await api.getConfig();
    const saved = await api.saveConfig({ ...cfg, follows: followDraft });
    $('follows-dialog').close();
    const cut = followDraft.length - saved.follows.length;
    setStatus(cut > 0 ? `已关注 ${saved.follows.length} 人（超出上限，${cut} 人未保存）` : `已关注 ${saved.follows.length} 人`, cut > 0);
  } catch (err) {
    $('follows-error').textContent = errText(err);
  }
}

// ---- 更新

let updateInfo = null;

function renderUpdate(info) {
  updateInfo = info;
  const banner = $('update-banner');
  if (info && info.available) {
    banner.hidden = false;
    banner.textContent = `有新版本 ${info.latest}，点击安装`;
    $('update-text').textContent = `当前版本 ${info.current}，可更新到 ${info.latest}` +
      (info.size ? `（${(info.size / 1048576).toFixed(0)} MB）` : '');
    $('update-notes').textContent = info.notes || '';
    $('install-update').hidden = false;
  } else {
    banner.hidden = true;
    $('install-update').hidden = true;
    $('update-notes').textContent = '';
    if (info && info.error) $('update-text').textContent = `检查更新失败：${info.error}`;
    else if (info && info.configured === false) $('update-text').textContent = `当前版本 ${info.current || ''}（这个版本没有配置更新地址）`;
    else if (info) $('update-text').textContent = `当前版本 ${info.current}，已是最新`;
  }
}

async function checkUpdate() {
  const btn = $('check-update');
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    renderUpdate(await api.checkUpdate());
  } finally {
    btn.disabled = false;
    btn.textContent = '检查更新';
  }
}

async function installUpdate() {
  if (!updateInfo || !updateInfo.available) return;
  const ok = confirm(`安装 ${updateInfo.latest}？\n\n应用会下载新版、自动退出并重新打开，大约需要一分钟。配置和帖子记录都会保留。`);
  if (!ok) return;
  $('install-update').disabled = true;
  $('update-banner').disabled = true;
  $('update-progress').hidden = false;
  $('update-text').textContent = '正在下载更新…';
  try {
    await api.installUpdate();
    $('update-text').textContent = '下载完成，正在重启…';
  } catch (err) {
    $('update-text').textContent = `更新失败：${errText(err)}`;
    $('install-update').disabled = false;
    $('update-banner').disabled = false;
    $('update-progress').hidden = true;
  }
}

// ------------------------------------------------------------ 抓取

async function fetchNow() {
  if (state.fetching) return;
  await api.fetchNow();
}

function scheduleText() {
  if (!state.nextRun) return '自动抓取已关闭';
  const d = new Date(state.nextRun);
  const week = '日一二三四五六'[d.getDay()];
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `下次自动抓取：${date} 周${week} ${time}`;
}

function setFetching(on) {
  state.fetching = on;
  $('fetch-btn').disabled = on;
  $('fetch-btn').textContent = on ? '抓取中…' : '立即抓取';
}

api.onEvent(async ({ channel, data }) => {
  if (channel === 'fetch_started') {
    setFetching(true);
    setStatus('正在抓取…');
  } else if (channel === 'log') {
    if (state.fetching) setStatus(String(data));
  } else if (channel === 'fetch_done') {
    setFetching(false);
    if (!data.ok) {
      setStatus(data.error, true);
      return;
    }
    const failed = (data.errors || []).length;
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    setStatus(`${time} 新增 ${data.new} 条` + (failed ? `，${failed} 组失败：${data.errors[0].message}` : ''), failed > 0);
    await refreshSidebar();
    if (data.new) loadFeed(true);
  } else if (channel === 'schedule') {
    state.nextRun = data.next;
    if (!state.fetching) setStatus(scheduleText());
  } else if (channel === 'update_status') {
    renderUpdate(data);
  } else if (channel === 'update_progress') {
    const p = $('update-progress');
    if (data.total) { p.max = data.total; p.value = data.received; }
    $('update-text').textContent = `正在下载更新… ${(data.received / 1048576).toFixed(0)} MB` +
      (data.total ? ` / ${(data.total / 1048576).toFixed(0)} MB` : '');
  }
});

// ------------------------------------------------------------ 绑定事件

document.querySelectorAll('[data-view]').forEach((b) => {
  b.addEventListener('click', () => selectView(b.dataset.view));
});
$('search').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); loadFeed(true); }, 250));
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; loadFeed(true); });
$('mark-read-btn').addEventListener('click', async () => {
  await api.markAllRead(state.view === 'source' ? state.source : null);
  await refreshSidebar();
  loadFeed(true);
});
$('fetch-btn').addEventListener('click', fetchNow);
$('settings-btn').addEventListener('click', openSettings);
$('settings-form').addEventListener('submit', saveSettings);
$('cancel-settings').addEventListener('click', () => $('settings').close());
['interval-hours', 'max-per-target', 'search-mode', 'avg-posts', 'include-replies', 'keywords']
  .forEach((id) => $(id).addEventListener('input', updateEstimate));
$('save-access').addEventListener('click', saveAccessCode);
$('access-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveAccessCode(); } });
$('save-api-key').addEventListener('click', saveApiKey);
$('check-update').addEventListener('click', checkUpdate);
$('install-update').addEventListener('click', installUpdate);
$('update-banner').addEventListener('click', async () => {
  await openSettings();
  installUpdate();
});
$('reveal-data').addEventListener('click', () => api.revealData());
$('follows-btn').addEventListener('click', openFollows);
$('roster-query').addEventListener('input', debounce(renderRoster, 100));
$('save-follows').addEventListener('click', saveFollows);
$('cancel-follows').addEventListener('click', () => $('follows-dialog').close());

// ------------------------------------------------------------ 启动

(async () => {
  await refreshSidebar();
  await loadFeed(true);
  const [info, status] = await Promise.all([api.accessInfo(), api.status()]);
  accessLimits = info.limits || {};
  if (info.mode === 'none') {
    setStatus('请先在设置里填写访问码', true);
    openSettings();
  } else {
    state.nextRun = status.next;
    setStatus(info.error || scheduleText(), Boolean(info.error));
  }
})();
