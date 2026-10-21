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
let labContext = { enabled: false };
let identity = { role: 'guest', permissions: {} };

function applyIdentity(info) {
  identity = { role: info.role, permissions: info.permissions || {} };
  const p = identity.permissions;
  $('api-key-box').hidden = !p.configureApi;
  $('api-key').disabled = !p.configureApi;
  $('save-api-key').disabled = !p.configureApi;
  const member = p.configureAccessCode && info.relayConfigured;
  $('access-code-row').hidden = !member || info.mode !== 'none';
  $('account-actions').hidden = info.mode === 'none';
  $('copy-account').hidden = !info.hasAccount;
  $('login-owner-account').hidden = info.role !== 'owner' || info.hasAccount || !info.relayConfigured;
  $('account-help').hidden = !member || (info.role === 'owner' && !info.hasAccount);
  $('use-cloud-api').hidden = info.role !== 'owner' || !info.hasAccount || info.mode !== 'direct';
  if (labContext.enabled) $('lab-topup').hidden = info.role !== 'paid' || Boolean(info.error);
  $('keywords-box').hidden = !p.configureKeywords;
  $('keywords').disabled = !p.configureKeywords;
  $('estimate-panel').hidden = !p.viewApiCosts;
  $('avg-posts-field').hidden = !p.viewApiCosts;
}

async function initLab() {
  labContext = await api.labInfo();
  if (!labContext.enabled) return;
  document.querySelector('.brand').textContent = 'Daily Feed Test';
  $('lab-panel').hidden = false;
  $('lab-label').textContent = labContext.label;
  $('lab-data-hint').textContent = labContext.live ? '真实 API · 会产生接口费用；账号余额为本地模拟' : '合成数据 · 无接口费用 · 与正式环境隔离';
  $('lab-panel').title = `数据目录：${labContext.dataPath}`;
  document.title = `Daily Feed Test · ${labContext.label} · ${labContext.roles[labContext.role]}`;
  for (const [value, label] of Object.entries(labContext.roles)) $('lab-role').append(el('option', { value, text: label }));
  $('lab-role').value = labContext.role;
  for (const [value, label] of Object.entries(labContext.scenarios[labContext.role])) $('lab-scenario').append(el('option', { value, text: label }));
  $('lab-scenario').value = labContext.scenario;
  $('lab-copy-account').addEventListener('click', async () => {
    try {
      await api.labCopyAccount();
      $('lab-message').textContent = '样例登录账号已复制，可在设置中退出后重新登录；仅在当前隔离环境有效。';
    } catch (e) { $('lab-message').textContent = errText(e); }
  });
  const switchTo = async (role, scenario) => {
    try { await api.labProfile({ role, scenario }); }
    catch (e) { $('lab-message').textContent = errText(e); $('lab-role').value = labContext.role; $('lab-scenario').value = labContext.scenario; }
  };
  $('lab-role').addEventListener('change', (e) => switchTo(e.target.value, 'normal'));
  $('lab-scenario').addEventListener('change', (e) => switchTo(labContext.role, e.target.value));
  $('lab-topup').hidden = labContext.role !== 'paid' || labContext.scenario === 'disabled';
  $('lab-topup').addEventListener('click', async () => {
    $('lab-topup').disabled = true;
    try {
      await api.labTopup();
      $('lab-message').textContent = '已模拟到账 ¥10。打开设置查看余额，或立即抓取验收。';
      if ($('settings').open) await renderAccess();
    } catch (e) { $('lab-message').textContent = errText(e); }
    finally { $('lab-topup').disabled = false; }
  });
}

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

// ---- 帖子内容：正文、图片 / 视频、链接卡片、被引用的帖子（所有文字都用 textContent，不拼 HTML）

const TWIMG = /^https:\/\/pbs\.twimg\.com\//;

function openLink(url) {
  if (/^https?:\/\//.test(url || '')) api.openUrl(url);
}

function linkButton(cls, url, label, ...children) {
  return el('button', {
    class: cls, type: 'button', title: url, 'aria-label': label,
    onclick: (e) => { e.stopPropagation(); openLink(url); },
  }, ...children);
}

function formatDuration(sec) {
  if (!sec) return '';
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

const TWVIDEO = /^https:\/\/video(-s)?\.twimg\.com\//;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// GIF（X 上其实是静音循环的短视频）在列表里滚动到可见时才加载并播放，滚出去就暂停
const gifObserver = new IntersectionObserver((entries) => {
  for (const { target: v, isIntersecting } of entries) {
    if (isIntersecting) {
      if (!v.src) v.src = v.dataset.src;
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }
}, { rootMargin: '200px' });

function renderMedia(media, postUrl) {
  if (!media || !media.length) return null;
  const items = media.filter((m) => TWIMG.test(m.thumb));
  if (!items.length) return null;
  const grid = el('div', { class: `media-grid n${Math.min(items.length, 4)}` });
  items.forEach((m, i) => {
    const label = m.type === 'photo' ? `查看大图${m.alt ? `：${m.alt}` : ''}` : `播放${m.type === 'gif' ? ' GIF' : '视频'}`;
    const thumb = m.thumb + (m.thumb.includes('?') ? '' : '?name=small');
    let visual;
    const gifSrc = m.type === 'gif' && m.sources && m.sources.length && TWVIDEO.test(m.sources[0].url) ? m.sources[0].url : '';
    if (gifSrc && !reducedMotion.matches) {
      visual = el('video', { poster: thumb, 'data-src': gifSrc, playsinline: true, loop: true, preload: 'none', 'aria-hidden': 'true' });
      visual.muted = true;
      gifObserver.observe(visual);
    } else {
      visual = el('img', { src: thumb, alt: m.alt || '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    }
    const overlay = m.type === 'photo' ? null
      : el('span', { class: 'play', 'aria-hidden': 'true', text: m.type === 'gif' ? 'GIF' : `▶ ${formatDuration(m.duration)}` });
    grid.append(el('button', {
      class: 'media-item', type: 'button', 'aria-label': label,
      onclick: (e) => { e.stopPropagation(); openViewer(items, i, postUrl); },
    }, visual, overlay));
  });
  return grid;
}

// ---- 应用内查看：图片放大（缩放、拖动）、视频播放（可切清晰度）
// 文件直接从 X 的服务器（pbs / video.twimg.com）加载，不经过 twitterapi.io，不产生 API 费用

const viewer = { items: [], index: 0, postUrl: '', scale: 1, x: 0, y: 0, drag: null };

// 默认清晰度：不超过约 2.5 Mbps 里最清楚的一档，太慢太大的不默认用
function defaultSource(sources) {
  const ok = sources.filter((s) => s.bitrate && s.bitrate <= 2600000);
  return ok.length ? ok[ok.length - 1] : sources[0];
}

function openViewer(items, index, postUrl) {
  viewer.items = items;
  viewer.postUrl = postUrl;
  const multi = items.length > 1;
  $('viewer-prev').hidden = !multi;
  $('viewer-next').hidden = !multi;
  if (!$('viewer').open) $('viewer').showModal();
  showViewerItem(index);
}

function stopViewerMedia() {
  // 关掉或切换时停止下载，不在后台继续耗流量
  for (const v of $('viewer-stage').querySelectorAll('video')) {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
  $('viewer-stage').replaceChildren();
}

function viewerError(text) {
  const p = $('viewer-error');
  p.textContent = text;
  p.hidden = false;
}

function applyZoom(img) {
  img.style.transform = `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.scale})`;
  img.classList.toggle('zoomed', viewer.scale > 1);
}

function setZoom(img, scale) {
  viewer.scale = Math.max(1, Math.min(5, scale));
  if (viewer.scale === 1) { viewer.x = 0; viewer.y = 0; }
  applyZoom(img);
}

function showViewerItem(index) {
  const n = viewer.items.length;
  viewer.index = (index + n) % n;
  viewer.scale = 1; viewer.x = 0; viewer.y = 0;
  const m = viewer.items[viewer.index];
  stopViewerMedia();
  $('viewer-error').hidden = true;
  $('viewer-count').textContent = n > 1 ? `${viewer.index + 1} / ${n}` : '';
  $('viewer-quality-box').hidden = true;
  $('viewer-zoom-hint').hidden = m.type !== 'photo';
  const stage = $('viewer-stage');

  if (m.type === 'photo') {
    const src = TWIMG.test(m.full || '') ? m.full : m.thumb;
    const img = el('img', { class: 'viewer-img', src, alt: m.alt || '', referrerpolicy: 'no-referrer', draggable: 'false' });
    img.addEventListener('error', () => viewerError('图片加载失败。可能需要开启代理，或者点右上角「在 X 打开」。'));
    img.addEventListener('dblclick', () => setZoom(img, viewer.scale > 1 ? 1 : 2.5));
    img.addEventListener('pointerdown', (e) => {
      if (viewer.scale <= 1) return;
      viewer.drag = { px: e.clientX, py: e.clientY, x: viewer.x, y: viewer.y };
      img.setPointerCapture(e.pointerId);
    });
    img.addEventListener('pointermove', (e) => {
      if (!viewer.drag) return;
      viewer.x = viewer.drag.x + e.clientX - viewer.drag.px;
      viewer.y = viewer.drag.y + e.clientY - viewer.drag.py;
      applyZoom(img);
    });
    img.addEventListener('pointerup', () => { viewer.drag = null; });
    stage.append(img);
    return;
  }

  const sources = (m.sources || []).filter((s) => TWVIDEO.test(s.url));
  if (!sources.length) {
    stage.append(el('img', { class: 'viewer-img', src: m.full || m.thumb, alt: '', referrerpolicy: 'no-referrer' }));
    viewerError('这个视频没有可直接播放的地址，请点右上角「在 X 打开」。');
    return;
  }
  const isGif = m.type === 'gif';
  const start = defaultSource(sources);
  const video = el('video', { class: 'viewer-video', poster: m.full || m.thumb, playsinline: true, preload: 'auto' });
  video.controls = true;
  video.autoplay = true;
  if (isGif) { video.loop = true; video.muted = true; }
  video.src = start.url;
  video.addEventListener('error', () => {
    if (video.getAttribute('src')) viewerError('视频加载失败，可能已被删除或需要开启代理。可以点右上角「在 X 打开」。');
  });
  stage.append(video);

  // GIF 只有一档；视频提供清晰度切换，切换时保留播放进度
  if (!isGif && sources.length > 1) {
    const sel = $('viewer-quality');
    sel.replaceChildren(...sources.map((s, i) => el('option', {
      value: String(i),
      text: `${s.label || '未知'} · ${(s.bitrate / 1e6).toFixed(1).replace(/\.0$/, '')} Mbps`,
    })));
    sel.value = String(sources.indexOf(start));
    sel.onchange = () => {
      const t = video.currentTime;
      const playing = !video.paused;
      video.src = sources[Number(sel.value)].url;
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = t;
        if (playing) video.play().catch(() => {});
      }, { once: true });
    };
    $('viewer-quality-box').hidden = false;
  }
}

function initViewer() {
  const dlg = $('viewer');
  $('viewer-close').addEventListener('click', () => dlg.close());
  $('viewer-prev').addEventListener('click', () => showViewerItem(viewer.index - 1));
  $('viewer-next').addEventListener('click', () => showViewerItem(viewer.index + 1));
  $('viewer-open-x').addEventListener('click', () => {
    const m = viewer.items[viewer.index];
    openLink((m && m.url) || viewer.postUrl);
  });
  dlg.addEventListener('close', stopViewerMedia);
  // 点空白处关闭
  $('viewer-stage').addEventListener('click', (e) => { if (e.target === e.currentTarget) dlg.close(); });
  // 滚轮 / 触控板双指缩放图片
  $('viewer-stage').addEventListener('wheel', (e) => {
    const img = $('viewer-stage').querySelector('.viewer-img');
    if (!img || viewer.items[viewer.index].type !== 'photo') return;
    e.preventDefault();
    setZoom(img, viewer.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
  }, { passive: false });
  // 左右键切换；焦点在视频或清晰度菜单上时左右键留给它们（快进 / 选项）
  dlg.addEventListener('keydown', (e) => {
    if (viewer.items.length < 2 || e.target.closest('video, select')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); showViewerItem(viewer.index - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); showViewerItem(viewer.index + 1); }
  });
}

function renderCard(c) {
  if (!c) return null;
  return linkButton('link-card', c.url, `打开链接：${c.title}`,
    c.image && TWIMG.test(c.image) ? el('img', { src: c.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
    el('span', { class: 'link-card-body' },
      c.domain ? el('span', { class: 'link-card-domain', text: c.domain }) : null,
      el('span', { class: 'link-card-title', text: c.title }),
      c.description ? el('span', { class: 'link-card-desc', text: c.description }) : null,
    ),
  );
}

// 正文里的链接显示成可点的样子（链接文本本身来自 entities.display_url）
function renderText(text, links) {
  const p = el('p', { class: 'tweet-text' });
  if (!links || !links.length) { p.textContent = text; return p; }
  let rest = text;
  for (const l of links) {
    const i = rest.indexOf(l.display);
    if (i === -1) continue;
    p.append(rest.slice(0, i), linkButton('inline-link', l.url, `打开链接 ${l.display}`, l.display));
    rest = rest.slice(i + l.display.length);
  }
  p.append(rest);
  return p;
}

function renderQuoted(q) {
  if (!q) return null;
  if (q.unavailable) {
    return el('div', { class: 'quoted unavailable', text: '引用的帖子已删除或不可见' });
  }
  if (q.more) {
    return linkButton('quoted more', q.url, `在 X 查看 @${q.author.username} 的引用帖`,
      `还引用了 @${q.author.username} 的帖子，点击在 X 查看`);
  }
  const box = el('div', { class: 'quoted' });
  const head = el('div', { class: 'quoted-head' },
    q.author.avatar && TWIMG.test(q.author.avatar)
      ? el('img', { class: 'quoted-avatar', src: q.author.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
    el('span', { class: 'name', text: q.author.name }),
    el('span', { class: 'handle', text: '@' + q.author.username }),
    q.created_at ? el('span', { class: 'time', text: '· ' + relTime(parseXTime(q.created_at)) }) : null,
    q.url ? linkButton('icon-btn quoted-open', q.url, `在 X 打开 @${q.author.username} 的这条帖子`, '↗') : null,
  );
  box.append(head);
  if (q.text) box.append(renderText(q.text, q.links));
  const media = renderMedia(q.media, q.url);
  if (media) box.append(media);
  const card = renderCard(q.card);
  if (card) box.append(card);
  const nested = renderQuoted(q.quoted);
  if (nested) box.append(nested);
  return box;
}

// 引用帖里的时间是 X 的原始格式（Tue Dec 10 07:00:30 +0000 2024），Date 能直接解析
function parseXTime(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
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

  const p = t.post;
  const body = el('div', { class: 'tweet-body' }, head);
  if (p && p.retweeted_by) {
    body.prepend(el('div', { class: 'retweet-note', text: `⟲ @${p.retweeted_by.username} 转发了 @${p.author.username}` }));
  }
  if (p) {
    if (p.text) body.append(renderText(p.text, p.links));
    for (const part of [renderMedia(p.media, p.url), renderCard(p.card), renderQuoted(p.quoted)]) {
      if (part) body.append(part);
    }
  } else {
    body.append(el('p', { class: 'tweet-text', text: t.text || '' }));
  }
  body.append(foot);
  card.append(avatar, body);
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

// ---- 抓取计划：频率（每周哪几天）+ 时间（时 / 分）

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MINUTE_STEP = 5;
const pad2 = (n) => String(n).padStart(2, '0');

const sched = { enabled: true, days: [1, 4], hour: 9, minute: 0 };

// 实际生效的抓取日：总开关关闭时为空
const activeDays = (enabled, days) => (enabled === false ? [] : days || []);

function describeDays(days) {
  if (!days.length) return '不自动抓取';
  if (days.length === 7) return '每天';
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return '工作日';
  if (key === '0,6') return '周末';
  return DAY_ORDER.filter((d) => days.includes(d)).map((d) => DAY_NAMES[d]).join('、');
}

function scheduleSummary(enabled, days, time) {
  if (enabled === false) return '定时抓取已关闭，只能手动点「立即抓取」';
  if (!days.length) return '没有选择抓取日，不会自动抓取';
  const n = days.length;
  return `${describeDays(days)} ${time} 自动抓取，每周 ${n} 次，每月约 ${Math.round(n * 30 / 7)} 次`;
}

function timeValue() {
  return `${pad2(sched.hour)}:${pad2(sched.minute)}`;
}

function dayBoxes() {
  return [...document.querySelectorAll('#freq-menu input[name="day"]')];
}

function renderFreq() {
  for (const b of dayBoxes()) b.checked = sched.days.includes(Number(b.value));
  const all = $('day-all');
  all.checked = sched.days.length === 7;
  all.indeterminate = sched.days.length > 0 && sched.days.length < 7;
  $('freq-text').textContent = describeDays(sched.days);
  // 总开关关闭时频率和时间都不能改（选好的值会保留）；没选天时时间没有意义
  const sw = $('schedule-switch');
  sw.setAttribute('aria-checked', String(sched.enabled));
  $('schedule-fields').classList.toggle('off', !sched.enabled);
  $('freq-button').disabled = !sched.enabled;
  $('time-button').disabled = !sched.enabled || !sched.days.length;
}

function renderTime() {
  $('time-text').textContent = timeValue();
  for (const [col, value] of [[$('hour-col'), sched.hour], [$('minute-col'), sched.minute]]) {
    for (const li of col.children) {
      const on = Number(li.dataset.value) === value;
      li.setAttribute('aria-selected', String(on));
      li.tabIndex = -1;
      if (on) col.setAttribute('aria-activedescendant', li.id);
    }
  }
}

function buildTimeColumns() {
  const fill = (col, count, step, prefix) => {
    for (let v = 0; v < count; v += step) {
      col.append(el('li', { role: 'option', id: `${prefix}-${v}`, 'data-value': String(v), text: pad2(v) }));
    }
  };
  fill($('hour-col'), 24, 1, 'h');
  fill($('minute-col'), 60, MINUTE_STEP, 'm');
}

function scrollSelectedIntoView() {
  for (const col of [$('hour-col'), $('minute-col')]) {
    const sel = col.querySelector('[aria-selected="true"]');
    if (sel) col.scrollTop = sel.offsetTop - col.clientHeight / 2 + sel.offsetHeight / 2;
  }
}

function setOpen(button, menu, open) {
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

function closeMenus(except) {
  if (except !== 'freq') setOpen($('freq-button'), $('freq-menu'), false);
  if (except !== 'time') setOpen($('time-button'), $('time-menu'), false);
}

function scheduleChanged() {
  renderFreq();
  renderTime();
  updateEstimate();
}

function loadSchedule(cfg) {
  sched.enabled = cfg.schedule_enabled !== false;
  sched.days = (cfg.schedule_days || []).map(Number);
  const [h, m] = String(cfg.schedule_time || '09:00').split(':').map(Number);
  sched.hour = h;
  // 旧配置的分钟不一定是 5 的倍数，向下取整到最近的一格
  sched.minute = Math.floor(m / MINUTE_STEP) * MINUTE_STEP;
  closeMenus();
  scheduleChanged();
}

// ---- 设置

let settingsCfg = null;
let accessLimits = {};

async function openSettings() {
  const [cfg, status] = await Promise.all([api.getConfig(), api.status()]);
  settingsCfg = cfg;
  loadSchedule(cfg);
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
  applyIdentity(info);
  const ownApi = identity.role === 'owner';
  $('access-title').textContent = info.mode === 'direct' ? 'API 连接' : '账号登录';
  $('account-help').textContent = ownApi
    ? '完整超管登录账号可在其他设备登录；新电脑使用云端 API，无需复制本机 API Key。本机内容暂不跨设备同步。'
    : info.mode === 'relay'
    ? '登录状态已保存在本机。复制完整登录账号，在其他设备输入一次即可登录。登录账号请私下保管；DF- 开头的短编号仅用于充值备注。本机的关注、收藏和阅读记录暂不同步。'
    : '只需登录账号，无需密码或额外访问码。原访问码可直接作为登录账号使用；充值备注用的 DF- 短编号不能登录。';
  $('api-key-summary').textContent = info.mode === 'direct' ? '更换 API Key' : '使用本机 API Key 直连（可选）';
  if (ownApi) $('api-key-box').open = false;
  $('key-hint').textContent = info.hasApiKey ? '已在本机加密保存' : '尚未设置';
  updateEstimate();
  if (ownApi) {
    setHint('access-hint', info.hasAccount
      ? `已登录（${info.name || '超管'}${info.account_no ? `，编号 ${info.account_no}` : ''}，超管）。` +
        (info.mode === 'direct' ? '当前使用本机 API Key 直连。' : '使用云端 API。') + (info.error ? ` ${info.error}` : '')
      : '使用自己的 twitterapi.io API Key 直连。', info.error ? 'warn' : 'ok');
    return;
  }
  if (!info.relayConfigured) {
    setHint('access-hint', '尚未配置账号服务，请联系管理员。', 'warn');
    return;
  }
  const maxDays = accessLimits.max_runs_per_week;
  if (info.mode === 'relay' && info.error) {
    setHint('access-hint', info.error, 'warn');
  } else if (info.mode === 'relay' && info.plan === 'paid') {
    // 付费账号：显示账号和余额，余额不足时提示充值方式
    const b = info.balance || { cny: 0 };
    const low = b.cny < 1;
    setHint('access-hint',
      `已登录（${info.name || '已验证'}，充值编号 ${info.account_no}）。余额 ¥${b.cny.toFixed(2)}，本月已花 ¥${(b.month_spent_cny || 0).toFixed(2)}。` +
      (low ? ` 余额快用完了，转账充值时请备注账号 ${info.account_no}。` : ''), low ? 'warn' : 'ok');
  } else if (info.mode === 'relay') {
    const q = identity.permissions.viewMonthlyQuota ? info.quota || {} : {};
    setHint('access-hint',
      `已登录（${info.name || '已验证'}${info.account_no ? `，编号 ${info.account_no}` : ''}，内测）。本月额度已用 ${usd(q.used_usd)} / ${usd(q.limit_usd)}` +
      (maxDays && maxDays < 7 ? `，每周最多抓 ${maxDays} 天` : '') + '。', 'ok');
  } else {
    setHint('access-hint', '向管理员领取登录账号，粘贴后即可登录；下次打开自动沿用。', 'warn');
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
    // 限制（如每周最多几天）可能把已有配置改了，重新读一遍
    settingsCfg = await api.getConfig();
    loadSchedule(settingsCfg);
  } catch (err) {
    setHint('access-hint', errText(err), 'warn');
  } finally {
    btn.disabled = false;
  }
}

async function copyLoginAccount() {
  try {
    await api.copyLoginAccount();
    setHint('access-hint', '登录账号已复制，可在你的其他设备上粘贴登录。请勿公开分享。', 'ok');
  } catch (err) { setHint('access-hint', errText(err), 'warn'); }
}

async function logoutAccount() {
  if (!confirm('退出后需重新输入完整登录账号。本机帖子、关注和收藏会保留。确定退出？')) return;
  const btn = $('logout-account');
  btn.disabled = true;
  try {
    await api.setAccessCode('');
    await renderAccess();
    settingsCfg = await api.getConfig();
    loadSchedule(settingsCfg);
    $('access-code').focus();
  } catch (err) { setHint('access-hint', errText(err), 'warn'); }
  finally { btn.disabled = false; }
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
    schedule_enabled: sched.enabled,
    schedule_days: [...sched.days].sort((a, b) => a - b),
    schedule_time: timeValue(),
    max_per_target: Number($('max-per-target').value) || 0,
    search_mode: $('search-mode').value,
    include_replies: $('include-replies').checked,
    ...(identity.permissions.configureKeywords ? { keywords: lines($('keywords').value) } : {}),
    ...(identity.permissions.viewApiCosts ? { avg_posts_per_day: Number($('avg-posts').value) || 0 } : {}),
  };
}

const updateEstimate = debounce(async () => {
  const cfg = settingsForm();
  const maxDays = accessLimits.max_runs_per_week;
  $('schedule-hint').textContent = scheduleSummary(cfg.schedule_enabled, cfg.schedule_days, cfg.schedule_time) +
    (cfg.schedule_enabled && maxDays && cfg.schedule_days.length > maxDays ? `。你的额度每周最多 ${maxDays} 天，保存时只保留前 ${maxDays} 天` : '');
  if (!identity.permissions.viewApiCosts) return;
  const [e, used] = await Promise.all([api.estimate(cfg), api.usage()]);
  const extra = e.keywords_high || 0;
  $('est-expected').textContent = usd(e.expected + extra);
  $('est-low').textContent = usd(e.low);
  $('est-high').textContent = usd(e.high + extra);
  $('est-used').textContent = usd(used.usd);
  if (!e.people && !cfg.keywords.length) {
    $('est-detail').textContent = '还没有关注任何人，点侧栏「关注」勾选。';
  } else if (!activeDays(cfg.schedule_enabled, cfg.schedule_days).length) {
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
    const form = settingsForm();
    const saved = await api.saveConfig(form);
    $('settings').close();
    const cut = form.schedule_days.length - saved.schedule_days.length;
    // 保存后侧栏直接显示新的计划（下次抓取时间或已关闭），被额度截掉天数时先提示这一点
    const { next } = await api.status();
    state.nextRun = next;
    setStatus(cut > 0 ? `已保存，抓取日调整为${describeDays(saved.schedule_days)}` : scheduleText(), cut > 0);
  } catch (err) {
    $('settings-error').textContent = errText(err);
  }
}

// ---- 选择器交互

function initSchedulePickers() {
  buildTimeColumns();

  $('freq-button').addEventListener('click', () => {
    const open = $('freq-menu').hidden;
    closeMenus('freq');
    setOpen($('freq-button'), $('freq-menu'), open);
    if (open) $('day-all').focus();
  });
  $('time-button').addEventListener('click', () => {
    const open = $('time-menu').hidden;
    closeMenus('time');
    setOpen($('time-button'), $('time-menu'), open);
    if (open) { scrollSelectedIntoView(); $('hour-col').focus(); }
  });

  $('schedule-switch').addEventListener('click', () => {
    sched.enabled = !sched.enabled;
    closeMenus();
    scheduleChanged();
  });

  $('day-all').addEventListener('change', (e) => {
    sched.days = e.target.checked ? [0, 1, 2, 3, 4, 5, 6] : [];
    scheduleChanged();
  });
  for (const b of dayBoxes()) {
    b.addEventListener('change', () => {
      sched.days = dayBoxes().filter((x) => x.checked).map((x) => Number(x.value));
      scheduleChanged();
    });
  }

  const pick = (col, key) => {
    col.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      sched[key] = Number(li.dataset.value);
      scheduleChanged();
    });
    // 键盘：上下键逐格移动，Enter 收起
    col.addEventListener('keydown', (e) => {
      const items = [...col.children];
      const i = items.findIndex((li) => li.getAttribute('aria-selected') === 'true');
      let next = i;
      if (e.key === 'ArrowDown') next = Math.min(items.length - 1, i + 1);
      else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = items.length - 1;
      else if (e.key === 'Enter') { e.preventDefault(); closeMenus(); $('time-button').focus(); return; }
      else return;
      e.preventDefault();
      sched[key] = Number(items[next].dataset.value);
      scheduleChanged();
      items[next].scrollIntoView({ block: 'nearest' });
    });
  };
  pick($('hour-col'), 'hour');
  pick($('minute-col'), 'minute');

  // 点外面或按 Esc 收起菜单；Esc 只收菜单，不关整个设置对话框
  $('settings').addEventListener('click', (e) => {
    if (!e.target.closest('.picker')) closeMenus();
  });
  $('settings').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [['freq', 'freq-button', 'freq-menu'], ['time', 'time-button', 'time-menu']]
      .find(([, , menu]) => !$(menu).hidden);
    if (open) {
      e.preventDefault();
      closeMenus();
      $(open[1]).focus();
    }
  });
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
  if (!identity.permissions.viewApiCosts) {
    const max = accessLimits.max_follows;
    $('follows-cost').textContent = `已选择 ${followDraft.length} 人` + (max ? `，最多可关注 ${max} 人。` : '。');
    return;
  }
  const cfg = { ...(await api.getConfig()), follows: followDraft };
  const e = await api.estimate(cfg);
  $('follows-cost').textContent = e.people
    ? (cfg.schedule_enabled === false
      ? '定时抓取已关闭，只有手动抓取时才会产生费用。'
      : `按当前计划（${describeDays(cfg.schedule_days || [])} ${cfg.schedule_time || ''}），预计每月 ${usd(e.expected)}，最多 ${usd(e.high)}。`)
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
  if (!state.nextRun) return '定时抓取已关闭';
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
['max-per-target', 'search-mode', 'avg-posts', 'include-replies', 'keywords']
  .forEach((id) => $(id).addEventListener('input', updateEstimate));
initSchedulePickers();
initViewer();
$('save-access').addEventListener('click', saveAccessCode);
$('access-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveAccessCode(); } });
$('copy-account').addEventListener('click', copyLoginAccount);
$('logout-account').addEventListener('click', logoutAccount);
$('login-owner-account').addEventListener('click', () => { $('access-code-row').hidden = false; $('access-code').focus(); });
$('use-cloud-api').addEventListener('click', async () => {
  try { await api.useCloudApi(); await renderAccess(); }
  catch (err) { $('key-hint').textContent = errText(err); }
});
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
  await initLab();
  await refreshSidebar();
  await loadFeed(true);
  const [info, status] = await Promise.all([api.accessInfo(), api.status()]);
  applyIdentity(info);
  accessLimits = info.limits || {};
  if (info.mode === 'none') {
    setStatus('请先在设置里登录账号', true);
    openSettings();
  } else {
    state.nextRun = status.next;
    setStatus(info.error || scheduleText(), Boolean(info.error));
  }
})();
