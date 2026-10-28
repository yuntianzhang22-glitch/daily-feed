import feedbackView from '../desktop/core/feedback-view.js';
import translationView from '../desktop/core/translation-view.js';
import { BrowserStorage, MobileFeed, extractPost, cleanUsernames } from './model.mjs';
import fallbackRoster from '../desktop/roster.json';

const $ = (id) => document.getElementById(id);
const storage = new BrowserStorage();
const feed = new MobileFeed(storage);
let roster = fallbackRoster;
let draft = [];
let followHistory = [];
let followsSaving = false;
let category = '';
let view = 'all';
let pageSize = 40;
let currentTab = 'reading';
let registration;
let persistRequested = false;
let messageTimer;
let scheduleDirty = false;
let cloudRefresh;
const scrollPositions = {};
const names = { all: '全部', unread: '未读', starred: '收藏' };
const message = (text, error = false) => {
  clearTimeout(messageTimer);
  $('message').textContent = text;
  $('message').classList.toggle('failure', error);
  if (text && !error) messageTimer = setTimeout(() => { $('message').textContent = ''; }, 5000);
};
const dateText = (text, timeZone) => {
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
};
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}
function safeUrl(value, domains) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
      (!domains || url.protocol === 'https:' && domains.includes(url.hostname)) ? url.href : '';
  } catch { return ''; }
}
function link(text, href, className = '') {
  const a = node('a', className, text);
  a.href = safeUrl(href) || 'https://x.com/';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}
function showLogin(error = '') {
  document.body.classList.remove('app-open');
  $('boot').hidden = true;
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = error;
  $('feed').replaceChildren();
  $('account-number').textContent = '';
  $('account-name').textContent = '';
  $('account-usage').textContent = '';
  $('followed').replaceChildren();
  draft = [];
  followHistory = [];
}
function networkStatus() {
  const offline = !navigator.onLine || feed.offline;
  $('network').hidden = !offline;
  $('network').textContent = '当前离线：可以阅读已保存的正文，联网后可继续抓取。';
}
async function showApp() {
  document.body.classList.add('app-open');
  $('boot').hidden = $('login').hidden = true;
  $('app').hidden = false;
  $('account').value = '';
  draft = [...feed.data.follows];
  followHistory = [];
  $('follows-feedback').textContent = '修改后点击「保存关注」生效，可撤销或放弃修改。';
  view = 'all';
  $('search').value = '';
  $('sort').value = 'time';
  $('source').value = '';
  category = '';
  $('roster-search').value = '';
  pageSize = 40;
  scheduleDirty = false;
  for (const key of Object.keys(scrollPositions)) delete scrollPositions[key];
  showTab('reading');
  renderSources();
  renderFeed();
  renderFollows();
  renderSettings();
  renderSchedule(true);
  refreshCloud();
  networkStatus();
  $('today').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  message(feed.data.follows.length ? '' : '请先添加关注，再抓取帖子。');
  // Roster refresh is optional; a complete built-in roster remains available offline.
  fetch('/v1/roster', { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then(async (response) => {
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.people) && data.people.every((p) => /^[A-Za-z0-9_]{1,15}$/.test(p.username)) && Array.isArray(data.categories)) {
      roster = data;
      if (feed.session) { renderFollows(); renderSources(); }
    }
  }).catch(() => {});
}
function showTab(tab) {
  scrollPositions[currentTab] = $('content').scrollTop;
  currentTab = tab;
  for (const id of ['reading', 'following', 'settings']) $(id).hidden = id !== tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (tab === 'settings') { renderSettings(); renderSchedule(); }
  $('follow-actions').hidden = tab !== 'following';
  $('content').scrollTop = scrollPositions[tab] || 0;
}
function renderSources() {
  const selected = $('source').value;
  const sources = new Set(Object.values(feed.data.tweets).map((t) => t.source));
  $('source').replaceChildren(new Option('所有来源', ''), ...[...sources].sort().map((s) => {
    const username = s.replace(/^user:/, '');
    return new Option(roster.people.find((p) => p.username.toLowerCase() === username.toLowerCase())?.name || username, s);
  }));
  if (sources.has(selected)) $('source').value = selected;
}
function postBody(post, quoted = false) {
  const box = node('div', quoted ? 'quote' : 'post-body');
  if (!post || post.unavailable) { box.textContent = '这条帖子暂不可见'; return box; }
  if (post.more) { box.append(link('查看原帖中的引用 ↗', post.url)); return box; }
  const header = node('div', 'post-header');
  if (!quoted) {
    const url = safeUrl(post.author.avatar, ['pbs.twimg.com', 'abs.twimg.com']);
    if (url) {
      const avatar = node('img', 'avatar');
      avatar.src = url; avatar.alt = ''; avatar.loading = 'lazy';
      header.append(avatar);
    }
  }
  const author = node('div');
  author.append(node('p', 'author', post.author.name || post.author.username),
    node('p', 'post-meta', `@${post.author.username} · ${dateText(post.created_at)}`));
  header.append(author);
  box.append(header, node('p', 'post-text', post.text));
  if (post.links?.length) {
    const links = node('div', 'post-links');
    for (const item of post.links) if (safeUrl(item.url)) links.append(link(item.display, item.url));
    box.append(links);
  }
  if (post.media?.length) {
    const media = node('div', 'post-media');
    for (const item of post.media) {
      if (item.type === 'video' || item.type === 'gif') {
        const url = safeUrl(item.sources?.at(-1)?.url, ['video.twimg.com', 'video-s.twimg.com']);
        if (!url) { media.append(link('在 X 查看视频 ↗', item.url)); continue; }
        const video = node('video');
        video.src = url; video.controls = true; video.playsInline = true; video.preload = 'none';
        const poster = safeUrl(item.thumb, ['pbs.twimg.com']);
        if (poster) video.poster = poster;
        media.append(video);
      } else {
        const src = safeUrl(item.full || item.thumb, ['pbs.twimg.com']);
        if (!src) continue;
        const image = node('img'); image.src = src; image.alt = item.alt || '帖子图片'; image.loading = 'lazy';
        const a = link('', src); a.setAttribute('aria-label', '打开帖子大图'); a.append(image); media.append(a);
      }
    }
    box.append(media);
  }
  if (post.card && safeUrl(post.card.url)) box.append(link(`${post.card.title} ↗`, post.card.url, 'quote'));
  if (post.quoted && !quoted) box.append(postBody(post.quoted, true));
  return box;
}
let feedbackRefresh;
let feedbackWanted = new Set();
let feedbackRefreshSession;
let feedbackAgain = false;
async function refreshFeedback(ids = []) {
  if (!feed.session || !navigator.onLine) return;
  const session = feed.session;
  if (feedbackRefreshSession !== session) { feedbackRefreshSession = session; feedbackWanted = new Set(); }
  for (const id of ids) feedbackWanted.add(id);
  feedbackAgain = true;
  if (feedbackRefresh) return feedbackRefresh;
  feedbackRefresh = (async () => {
    while (feedbackAgain && feed.session === session) {
      const batch = [...feedbackWanted].slice(0, 200);
      for (const id of batch) feedbackWanted.delete(id);
      feedbackAgain = feedbackWanted.size > 0;
      try {
        await feed.syncFeedback(batch);
        if (feed.session === session) await feedbackView.refreshFeedbackControls(document);
      } catch {
        // Keep the durable outbox; a later online/read/retry attempt can upload it.
        if (feed.session === session) { feedbackAgain = false; feedbackWanted.clear(); }
        break;
      }
    }
  })();
  try { await feedbackRefresh; }
  finally {
    feedbackRefresh = null;
    if (feedbackAgain && feed.session) refreshFeedback([]);
  }
}
window.addEventListener('online', () => refreshFeedback([...document.querySelectorAll('#feed article')].map((a) => extractPost(feed.data.tweets[a.dataset.id]?.raw)?.id).filter(Boolean)));
function renderFeed() {
  const scroll = $('content').scrollTop;
  const focused = document.activeElement;
  const focusId = focused?.dataset?.id;
  const focusFlag = focused?.dataset?.flag;
  $('reading-title').textContent = names[view];
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  const list = feed.list({ view, query: $('search').value, source: $('source').value, sort: $('sort').value });
  $('total').textContent = `${list.length} 条`;
  const fragment = document.createDocumentFragment();
  for (const tweet of list.slice(0, pageSize)) {
    const post = extractPost(tweet.raw);
    const article = node('article', `post${tweet.read ? '' : ' unread'}`);
    article.dataset.id = tweet.raw.id;
    if (post?.retweeted_by) article.append(node('p', 'retweet', `${post.retweeted_by.name} 转发了`));
    article.append(postBody(post));
    const actions = node('div', 'post-actions');
    for (const [field, active, label, off] of [['starred', tweet.starred, '已收藏', '收藏'], ['read', tweet.read, '已读', '标为已读']]) {
      const button = node('button', '', active ? label : off);
      button.setAttribute('aria-pressed', String(Boolean(active)));
      button.dataset.flag = field;
      button.dataset.id = tweet.raw.id;
      actions.append(button);
    }
    actions.append(link('原帖 ↗', post?.url || tweet.raw.url));
    if (post?.text || post?.quoted?.text) {
      const texts = [post?.text || ''];
      if (post?.quoted?.text) texts.push(post.quoted.text);
      const session = feed.session;
      const client = feed.client();
      article.append(translationView.translationControl({ document, texts,
        translate: (values) => client.translate(values), isCurrent: () => feed.session === session && article.isConnected }));
    }
    if (/^\d{1,25}$/.test(post?.id || '')) {
      const session = feed.session;
      article.append(feedbackView.feedbackControl({ document,
        getState: () => feed.feedbackState(post.id),
        setValue: (value) => feed.setFeedback(String(tweet.raw.id), value, { app_version: __MOBILE_VERSION__, view, sort: $('sort').value, position: list.indexOf(tweet) }),
        retry: () => feed.retryFeedback(), isCurrent: () => feed.session === session && article.isConnected }));
    }
    article.append(actions);
    fragment.append(article);
  }
  if (!list.length) {
    const empty = node('div', 'empty');
    empty.append(node('h2', '', view === 'starred' ? '暂无收藏' : view === 'unread' ? '没有未读帖子' : '暂无帖子'),
      node('p', 'hint', view === 'starred' ? '点帖子下方的「收藏」，随时回来再读。' : $('search').value || $('source').value ? '没有符合筛选的帖子，试试其他条件。' : feed.data.follows.length ? '点右上角「立即抓取」，获取你关注的人最近的帖子。' : '先选几位想看的人，再抓取最近的帖子。'));
    if (!feed.data.follows.length) {
      const button = node('button', 'secondary', '去关注'); button.dataset.goFollow = 'true'; empty.append(button);
    }
    fragment.append(empty);
  }
  $('feed').replaceChildren(fragment);
  refreshFeedback(list.slice(0, pageSize).map((t) => extractPost(t.raw)?.id).filter((id) => /^\d{1,25}$/.test(id || '')));
  $('load-more').hidden = list.length <= pageSize;
  if (currentTab === 'reading') $('content').scrollTop = scroll;
  if (focusId && focusFlag) [...$('feed').querySelectorAll('button')].find((button) => button.dataset.id === focusId && button.dataset.flag === focusFlag)?.focus({ preventScroll: true });
}
function includesName(list, name) { return list.some((n) => n.toLowerCase() === name.toLowerCase()); }
function personRow(person) {
  const row = node('div', 'person');
  const text = node('div', 'person-text');
  text.append(node('p', 'author', person.name || person.username), node('p', 'hint', `@${person.username}${person.bio ? ' · ' + person.bio : ''}`));
  const selected = includesName(draft, person.username);
  const button = node('button', selected ? 'secondary' : 'primary', selected ? '已选' : '关注');
  button.dataset.username = person.username;
  button.setAttribute('aria-pressed', String(selected));
  button.setAttribute('aria-label', `${selected ? '取消关注' : '关注'} ${person.name || person.username}`);
  button.disabled = feed.busy || followsSaving;
  row.append(text, button);
  return row;
}
function matchingPeople() {
  const query = $('roster-search').value.trim().replace(/^@/, '').toLowerCase();
  return roster.people.filter((p) => (!category || p.category === category) &&
    (!query || `${p.name} ${p.username} ${p.bio}`.toLowerCase().includes(query)));
}
function changeFollows(next) {
  if (feed.busy || followsSaving) return;
  const max = Number(feed.account?.limits?.max_follows) || 500;
  const skipped = Math.max(0, next.length - max);
  next = next.slice(0, max);
  if (next.join(',') !== draft.join(',')) {
    followHistory.push([...draft]);
    draft = next;
    $('follows-feedback').textContent = `已选择 ${draft.length} 人，点击「保存关注」生效；可撤销上一步。`;
    renderFollows();
  }
  if (skipped) message(`最多可关注 ${max} 人，已选至上限，另有 ${skipped} 人未选中。可取消部分选择后继续。`, true);
  else message('');
}
function bulkFollow(mode) {
  const matches = matchingPeople();
  const names = new Set(matches.map((p) => p.username.toLowerCase()));
  const keep = draft.filter((name) => !names.has(name.toLowerCase()) || mode === 'select');
  const add = matches.filter((p) => !includesName(draft, p.username) && mode !== 'deselect').map((p) => p.username);
  changeFollows([...keep, ...add]);
}
function renderFollows() {
  const locked = feed.busy || followsSaving;
  $('follow-count').textContent = `已保存 ${feed.data.follows.length} 人`;
  $('draft-count').textContent = `已选 ${draft.length} 人`;
  const dirty = draft.join(',') !== feed.data.follows.join(',');
  $('save-follows').disabled = locked || !dirty;
  $('save-follows').textContent = followsSaving ? '保存中…' : dirty ? '保存关注' : '已保存';
  $('clear-follows').disabled = locked || !draft.length;
  $('undo-follows').disabled = locked || !followHistory.length;
  $('reset-follows').disabled = locked || !dirty;
  $('followed').replaceChildren(...draft.map((username) => personRow(roster.people.find((p) => p.username.toLowerCase() === username.toLowerCase()) || { username })));
  if (!draft.length) $('followed').append(node('p', 'hint', '暂无关注'));
  const matches = matchingPeople();
  const selected = matches.filter((p) => includesName(draft, p.username)).length;
  $('roster-select-all').disabled = locked || !matches.length || selected === matches.length;
  $('roster-deselect').disabled = locked || !selected;
  $('roster-invert').disabled = locked || !matches.length;
  $('roster-selection').textContent = `当前 ${matches.length} 人，已选 ${selected} 人`;
  $('roster').replaceChildren(...matches.map(personRow));
  if (!$('roster').children.length) $('roster').append(node('p', 'hint', '没有匹配的人，也可以在上方输入用户名添加。'));
  $('categories').replaceChildren(...[{ id: '', name: '全部' }, ...roster.categories].map((c) => {
    const button = node('button', '', c.name); button.dataset.category = c.id;
    button.setAttribute('aria-pressed', String(category === c.id)); return button;
  }));
}
function renderSettings() {
  $('account-name').textContent = feed.account?.name || '';
  $('account-number').textContent = feed.account?.account_no || '';
  const account = feed.account;
  $('account-usage').textContent = account?.plan === 'beta'
    ? `本月额度：已用 ${account.quota?.used_credits?.toLocaleString() || 0} / ${account.quota?.limit_credits?.toLocaleString() || 0}`
    : account?.plan === 'paid' ? `余额 ¥${Number(account.balance?.cny || 0).toFixed(2)}；充值时请备注账号编号。` : '已连接云端服务';
  $('search-mode').value = feed.data.search_mode;
  $('include-replies').checked = feed.data.include_replies;
  $('version').textContent = __MOBILE_VERSION__;
}
function scheduleFields() {
  $('schedule-fields').disabled = !feed.schedule || feed.busy || !$('schedule-enabled').checked;
  $('schedule-days').hidden = $('schedule-frequency').value !== 'custom';
}
function renderSchedule(force = false) {
  $('schedule-enabled').disabled = !feed.schedule || feed.busy;
  $('save-schedule').disabled = !feed.schedule || feed.busy;
  if (scheduleDirty && !force) { scheduleFields(); return; }
  const cfg = feed.schedule?.config;
  $('schedule-enabled').checked = cfg?.enabled || false;
  const days = cfg?.days || [1, 4];
  $('schedule-frequency').value = days.length === 7 ? 'daily' : [1, 2, 3, 4, 5].every((day) => days.includes(day)) && days.length === 5 ? 'weekdays' : 'custom';
  for (const checkbox of document.querySelectorAll('[name=schedule-day]')) checkbox.checked = days.includes(Number(checkbox.value));
  $('schedule-time').value = cfg?.time || '09:00';
  $('schedule-status').textContent = !cfg ? '联网后可读取和设置定时抓取' : cfg.enabled
    ? `下次抓取：${dateText(feed.schedule.next_run, 'Asia/Shanghai')}（北京时间）` : '已关闭定时抓取';
  const last = feed.schedule?.last_run;
  $('schedule-last-run').textContent = last ? `上次：${dateText(last.at, 'Asia/Shanghai')} · ${last.status === 'success' ? `新增 ${last.added} 条` : last.status === 'running' ? '正在抓取' : last.message || '抓取失败'}` : '';
  scheduleFields();
}
async function refreshCloud() {
  if (!feed.session || feed.busy) return;
  const owner = feed.session.code;
  if (cloudRefresh?.owner === owner) return cloudRefresh.promise;
  let operation;
  operation = (async () => {
    try {
      const [, added] = await Promise.all([feed.loadSchedule(), feed.syncScheduled()]);
      if (feed.session?.code !== owner) return;
      renderSchedule(); renderSources(); renderFeed();
      if (added) message(`已同步 ${added} 条定时抓取的帖子`);
    } catch (e) {
      if (feed.session?.code !== owner) return;
      if (e.status === 401) { await feed.logout(); showLogin(e.message); }
      else { renderSchedule(); $('schedule-status').textContent = '定时设置暂未读取，请联网后点「刷新状态」重试'; }
    } finally { if (cloudRefresh?.promise === operation) cloudRefresh = null; }
  })();
  cloudRefresh = { owner, promise: operation };
  await operation;
}
function setBusy() {
  for (const id of ['fetch', 'logout', 'save-follows', 'username', 'search-mode', 'include-replies', 'refresh-account']) $(id).disabled = feed.busy;
  $('fetch').textContent = feed.busy ? '抓取中…' : '立即抓取';
  renderFollows();
  renderSchedule();
}
async function action(fn) {
  try { await fn(); }
  catch (e) {
    if (!feed.session || e.code === 'invalid_code' || e.status === 401) {
      if (feed.session) await feed.logout();
      showLogin(e.message);
    } else message(e.message, true);
  }
}
async function requestPersistence() {
  if (persistRequested) return;
  persistRequested = true;
  try { await navigator.storage?.persist?.(); } catch { /* Best effort; Safari manages storage. */ }
}
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-submit').disabled = true;
  $('login-error').textContent = '';
  $('login-submit').textContent = '正在登录…';
  try { await feed.login($('account').value); feed.offline = false; await showApp(); }
  catch (e) { $('login-error').textContent = e.message; }
  finally { $('login-submit').disabled = false; $('login-submit').textContent = '登录'; }
});
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => showTab(button.dataset.tab));
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { view = button.dataset.view; pageSize = 40; renderFeed(); });
for (const id of ['search', 'source', 'sort']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { pageSize = 40; renderFeed(); });
$('load-more').addEventListener('click', () => { pageSize += 40; renderFeed(); });
$('feed').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button?.dataset.goFollow) showTab('following');
  if (button?.dataset.flag) action(async () => { await feed.flag(button.dataset.id, button.dataset.flag); renderFeed(); });
});
$('mark-read').addEventListener('click', () => action(async () => {
  const list = feed.list({ view, query: $('search').value, source: $('source').value });
  const unread = list.filter((t) => !t.read);
  for (const tweet of unread) tweet.read = true;
  try { await feed.save(); } catch (e) { for (const tweet of unread) tweet.read = false; throw e; }
  renderFeed(); message(`已将当前筛选中的 ${unread.length} 条帖子标为已读`);
}));
function toggleFollow(event) {
  const username = event.target.closest('button')?.dataset.username;
  if (!username || feed.busy || followsSaving) return;
  changeFollows(includesName(draft, username) ? draft.filter((n) => n.toLowerCase() !== username.toLowerCase()) : [...draft, username]);
}
$('followed').addEventListener('click', toggleFollow);
$('roster').addEventListener('click', toggleFollow);
$('categories').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button) { category = button.dataset.category; renderFollows(); }
});
$('roster-search').addEventListener('input', renderFollows);
$('roster-select-all').addEventListener('click', () => bulkFollow('select'));
$('roster-deselect').addEventListener('click', () => bulkFollow('deselect'));
$('roster-invert').addEventListener('click', () => bulkFollow('invert'));
$('clear-follows').addEventListener('click', () => {
  if (feed.busy || followsSaving) return;
  changeFollows([]);
  $('follows-feedback').textContent = '已清空待保存的关注列表。可撤销上一步，点击「保存关注」生效。' +
    (feed.schedule?.config?.enabled ? '保存后将同时关闭定时抓取。' : '');
});
$('undo-follows').addEventListener('click', () => {
  if (feed.busy || followsSaving || !followHistory.length) return;
  draft = followHistory.pop();
  $('follows-feedback').textContent = `已撤销上一步，恢复为 ${draft.length} 人。点击「保存关注」生效。`;
  renderFollows(); message('');
});
$('reset-follows').addEventListener('click', () => {
  if (feed.busy || followsSaving) return;
  changeFollows([...feed.data.follows]);
  $('follows-feedback').textContent = '已恢复为上次保存的关注列表。';
});
$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (feed.busy || followsSaving) return;
  const names = cleanUsernames([$('username').value]);
  if (!names.length) { message('请输入有效的 X 用户名：1–15 位字母、数字或下划线', true); return; }
  if (!includesName(draft, names[0])) changeFollows([...draft, names[0]]);
  if (includesName(draft, names[0])) { $('username').value = ''; message('已加入待保存的关注列表'); }
});
$('save-follows').addEventListener('click', () => action(async () => {
  if (feed.busy || followsSaving) return;
  const paused = !draft.length && feed.schedule?.config?.enabled;
  followsSaving = true; renderFollows();
  try {
    await feed.setFollows(draft); followHistory = [];
    $('follows-feedback').textContent = paused ? '关注列表已清空，定时抓取已关闭。' : '关注已保存。';
    if (paused) { scheduleDirty = false; renderSchedule(true); }
    message(draft.length ? '关注已保存，点「立即抓取」获取新内容' : paused ? '关注列表已清空，定时抓取已关闭' : '关注列表已清空');
    await requestPersistence();
  } finally { followsSaving = false; renderFollows(); }
}));
$('fetch').addEventListener('click', () => action(async () => {
  if (!navigator.onLine) throw new Error('当前离线，请连接网络后重试');
  if (draft.join(',') !== feed.data.follows.join(',')) throw new Error('关注有未保存的修改，请先点「保存关注」');
  const pending = feed.fetchNow((text) => message(text));
  setBusy();
  try { const added = await pending; feed.offline = false; message(`抓取完成，新增 ${added} 条`); await requestPersistence(); }
  catch (e) { if (e.added) e.message = `已保存 ${e.added} 条新帖；${e.message}`; throw e; }
  finally {
    setBusy(); renderSources(); renderFeed(); networkStatus();
    // Re-read status without allowing a transient status failure to hide saved posts.
    if (feed.session) try { await feed.refreshAccount(); renderSettings(); } catch (e) {
      if (!feed.session) showLogin(e.message);
    }
  }
}));
$('preferences').addEventListener('submit', (event) => {
  event.preventDefault();
  action(async () => {
    if (feed.busy) throw new Error('请等待当前抓取完成后保存');
    const before = { search_mode: feed.data.search_mode, include_replies: feed.data.include_replies };
    feed.data.search_mode = $('search-mode').value;
    feed.data.include_replies = $('include-replies').checked;
    try {
      if (feed.schedule?.config?.enabled) await feed.saveSchedule({ search_mode: feed.data.search_mode, include_replies: feed.data.include_replies });
      await feed.save();
    } catch (e) { Object.assign(feed.data, before); throw e; }
    message('抓取偏好已保存');
  });
});
for (const id of ['schedule-enabled', 'schedule-frequency', 'schedule-time', 'schedule-days']) $(id).addEventListener('change', () => {
  scheduleDirty = true; scheduleFields(); $('schedule-status').textContent = '修改后请保存';
});
$('schedule-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action(async () => {
    if (feed.busy) throw new Error('请等待当前抓取完成');
    if (draft.join(',') !== feed.data.follows.join(',')) throw new Error('请先保存关注列表');
    const frequency = $('schedule-frequency').value;
    const days = frequency === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : frequency === 'weekdays' ? [1, 2, 3, 4, 5]
      : [...document.querySelectorAll('[name=schedule-day]:checked')].map((input) => Number(input.value));
    $('save-schedule').disabled = true;
    try {
      await feed.saveSchedule({ enabled: $('schedule-enabled').checked, days, time: $('schedule-time').value });
      scheduleDirty = false; renderSchedule(true); message('定时设置已保存');
    } finally { $('save-schedule').disabled = !feed.schedule; }
  });
});
$('refresh-account').addEventListener('click', () => action(async () => { await feed.refreshAccount(); await refreshCloud(); renderSettings(); networkStatus(); message('账号状态已刷新'); }));
$('copy-account').addEventListener('click', () => action(async () => {
  await navigator.clipboard.writeText(feed.account.account_no); message('账号编号已复制，请私下保管');
}));
$('logout').addEventListener('click', () => action(async () => {
  if (!confirm(`退出登录？本机阅读内容会保留。${feed.schedule?.config?.enabled ? '云端定时抓取仍会继续，可在设置中关闭。' : ''}`)) return;
  await feed.logout(); message(''); showLogin();
}));
window.addEventListener('offline', networkStatus);
window.addEventListener('online', () => {
  networkStatus();
  if (feed.session) action(async () => { await feed.refreshAccount(); await refreshCloud(); networkStatus(); if (currentTab === 'settings') renderSettings(); });
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCloud(); });
function updateViewport() {
  const viewport = window.visualViewport;
  if (viewport && viewport.scale !== 1) return;
  document.documentElement.style.setProperty('--app-height', `${viewport?.height || innerHeight}px`);
  const editing = document.activeElement?.matches('input:not([type=checkbox]), select, textarea');
  document.body.classList.toggle('keyboard-open', Boolean(editing && viewport && innerHeight - viewport.height > 120));
  if (editing) document.activeElement.scrollIntoView({ block: 'nearest' });
}
window.visualViewport?.addEventListener('resize', updateViewport);
window.addEventListener('resize', updateViewport);
document.addEventListener('focusin', updateViewport);
document.addEventListener('focusout', () => requestAnimationFrame(updateViewport));
updateViewport();
function watchUpdates(reg) {
  const ready = () => { if (reg.waiting && navigator.serviceWorker.controller) $('update').hidden = false; };
  ready();
  reg.addEventListener('updatefound', () => {
    reg.installing?.addEventListener('statechange', ready);
  });
}
$('check-update').addEventListener('click', () => action(async () => {
  if (!registration) { message('请联网并用 Safari 打开已部署的 HTTPS 网址后检查更新'); return; }
  await registration.update(); message('已检查更新，有新版本时会在页面上方提示');
}));
$('update').addEventListener('click', () => {
  if (feed.busy) { message('请等待抓取完成后更新'); return; }
  registration?.waiting?.postMessage('activate');
});
let reloading = false;
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (!reloading) { reloading = true; location.reload(); }
});
(async () => {
  try {
    await storage.open();
    if (await feed.restore()) await showApp(); else showLogin();
  } catch (e) { showLogin(e.message); }
  if ('serviceWorker' in navigator) {
    try { registration = await navigator.serviceWorker.register('./sw.js', { scope: '/mobile/' }); watchUpdates(registration); }
    catch { /* Reading and login still work when offline installation is unavailable. */ }
  }
})();
