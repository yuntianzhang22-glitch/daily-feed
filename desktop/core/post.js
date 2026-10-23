// 从 twitterapi.io 返回的原始推文 JSON 里取出界面要显示的内容：
// 正文（去掉 t.co 短链）、链接、图片 / 视频、链接卡片、被引用的帖子、转推。
// 原始 JSON 已完整存在 tweets.raw 里，旧帖子不用重新抓取。
//
// 注意：displayTextRange 和 entities 的 indices 是按 Unicode 码点计数的，
// 不是 JS 字符串下标（emoji 在 JS 里占两位），所以先按码点拆开再处理。

const MAX_QUOTE_DEPTH = 1; // 引用里再嵌套的引用只显示一层，避免无限套娃
const X_URL = /^https:\/\/(x|twitter)\.com\//;

function cp(text) {
  return Array.from(String(text || ''));
}

// 长帖的 text 已是全文，但预览范围和链接坐标可能仍属于旧的 280 字符版本。
// 只替换实际存在的短链；绝不能按过期坐标删除正文里的普通文字。
function entityRanges(entity, chars) {
  const url = typeof entity.url === 'string' ? entity.url : '';
  const [a, b] = Array.isArray(entity.indices) ? entity.indices : [];
  const valid = Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= chars.length;
  if (valid) {
    const token = chars.slice(a, b).join('');
    if (url ? token === url : /^https?:\/\/t\.co\/[A-Za-z0-9]+$/.test(token)) return [{ a, b }];
  }
  if (!url) return [];
  const text = chars.join('');
  const matches = [];
  for (let at = text.indexOf(url); at !== -1; at = text.indexOf(url, at + url.length)) {
    // 避免把短链 ABC 误当成 ABCDEF 的一部分。
    if (/[A-Za-z0-9]/.test(text[at + url.length] || '')) continue;
    const start = cp(text.slice(0, at)).length;
    matches.push({ a: start, b: start + cp(url).length });
  }
  return matches;
}

// 保留全文，仅沿用范围起点隐藏回复对象；媒体及引用短链通过实际 URL 移除。
function bodyOf(t) {
  const chars = cp(t.text);
  const from = Array.isArray(t.displayTextRange) ? t.displayTextRange[0] : 0;
  const start = Number.isInteger(from) && from >= 0 && from <= chars.length ? from : 0;
  const end = chars.length;
  const media = (t.extendedEntities && t.extendedEntities.media) || (t.entities && t.entities.media) || [];
  const urls = (t.entities && t.entities.urls) || [];
  const quotedUrl = t.quoted_tweet && t.quoted_tweet.url;

  const edits = [];
  for (const m of media) {
    for (const range of entityRanges(m, chars)) edits.push({ ...range, text: '' });
  }
  const links = [];
  for (const u of urls) {
    const ranges = entityRanges(u, chars).filter((range) => range.a >= start);
    if (!ranges.length) continue;
    const href = u.expanded_url || u.url;
    if (quotedUrl && isSamePost(href, quotedUrl)) {
      for (const range of ranges) edits.push({ ...range, text: '' });
      continue;
    }
    const display = u.display_url || href;
    for (const range of ranges) edits.push({ ...range, text: display });
    links.push({ url: href, display });
  }

  // 按位置从前往后拼接；同一个 t.co 可能被多张图片共用，重叠的区间只处理第一次
  edits.sort((x, y) => x.a - y.a);
  let out = '';
  let i = start;
  for (const e of edits) {
    if (e.b <= start || e.a >= end || e.a < i) continue;
    out += chars.slice(i, e.a).join('') + e.text;
    i = e.b;
  }
  if (i < end) out += chars.slice(i, end).join('');
  const text = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, links };
}

function isSamePost(a, b) {
  const id = (u) => (/\/status\/(\d+)/.exec(String(u || '')) || [])[1];
  return Boolean(id(a)) && id(a) === id(b);
}

const TWIMG_IMAGE = /^https:\/\/pbs\.twimg\.com\//;
// X 的视频放在 video.twimg.com 和 video-s.twimg.com 两个域名上
const TWIMG_VIDEO = /^https:\/\/video(-s)?\.twimg\.com\//;

// 大图地址：pbs.twimg.com 的图片用 name=large 取较大尺寸
function largeImage(url) {
  if (!TWIMG_IMAGE.test(url)) return '';
  return url.includes('?') ? url : `${url}?name=large`;
}

// 视频可播放的 mp4 地址，按码率从低到高；只要 video.twimg.com 上的，HLS（m3u8）不用
function videoSources(m) {
  const variants = (m.video_info && m.video_info.variants) || [];
  return variants
    .filter((v) => v.content_type === 'video/mp4' && TWIMG_VIDEO.test(v.url || ''))
    .map((v) => {
      // 清晰度按短边算，竖屏 720x1280 也显示 720p
      const size = /\/(\d+)x(\d+)\//.exec(v.url);
      const short = size ? Math.min(Number(size[1]), Number(size[2])) : 0;
      return { url: v.url, bitrate: Number(v.bitrate) || 0, label: short ? `${short}p` : '' };
    })
    .sort((a, b) => a.bitrate - b.bitrate);
}

function mediaOf(t) {
  const list = (t.extendedEntities && t.extendedEntities.media) || [];
  return list.slice(0, 4).map((m) => {
    const isVideo = m.type === 'video' || m.type === 'animated_gif';
    const size = m.original_info || {};
    return {
      type: isVideo ? (m.type === 'animated_gif' ? 'gif' : 'video') : 'photo',
      thumb: m.media_url_https || '',
      // 应用内查看用：图片的大图、视频的 mp4（直接从 X 的服务器加载，不经过 twitterapi.io）
      full: largeImage(m.media_url_https || ''),
      sources: isVideo ? videoSources(m) : [],
      alt: m.ext_alt_text || '',
      width: size.width || 0,
      height: size.height || 0,
      duration: isVideo && m.video_info ? Math.round((m.video_info.duration_millis || 0) / 1000) : 0,
      url: X_URL.test(m.expanded_url || '') ? m.expanded_url : t.url,
    };
  }).filter((m) => TWIMG_IMAGE.test(m.thumb));
}

// 链接预览卡片（文章、网页）
function cardOf(t) {
  const c = t.card;
  if (!c || !Array.isArray(c.binding_values)) return null;
  const v = {};
  for (const b of c.binding_values) {
    const val = b.value || {};
    v[b.key] = val.string_value ?? (val.image_value && val.image_value.url) ?? null;
  }
  const url = v.card_url || c.url || '';
  const title = v.title || '';
  if (!title) return null;
  const image = v.summary_photo_image_large || v.photo_image_full_size_large || v.thumbnail_image_large || v.thumbnail_image || '';
  // 卡片地址一般是 t.co，换成正文里对应的真实地址
  const real = ((t.entities && t.entities.urls) || []).find((u) => u.url === url);
  return {
    title: title.slice(0, 200),
    description: (v.description || '').slice(0, 300),
    domain: v.vanity_url || v.domain || '',
    image: /^https:\/\/pbs\.twimg\.com\//.test(image) ? image : '',
    url: (real && real.expanded_url) || url,
  };
}

function authorOf(t) {
  const a = t.author || {};
  return { username: a.userName || '', name: a.name || a.userName || '', avatar: a.profilePicture || '' };
}

function postView(t, depth = 0) {
  if (!t || typeof t !== 'object') return null;
  // 被删除或不可见的引用
  if (t.unavailable || (!t.text && !t.author)) {
    return { unavailable: true, url: t.url || '' };
  }
  const { text, links } = bodyOf(t);
  const card = cardOf(t);
  const view = {
    id: String(t.id || ''),
    url: t.url || '',
    author: authorOf(t),
    created_at: t.createdAt || '',
    text,
    links,
    media: mediaOf(t),
    // 有图片时不再显示链接卡片，避免重复
    card: card,
    quoted: null,
  };
  if (view.media.length && view.card && !view.card.image) view.card = null;
  if (depth < MAX_QUOTE_DEPTH && t.quoted_tweet && typeof t.quoted_tweet === 'object') {
    view.quoted = postView(t.quoted_tweet, depth + 1);
  } else if (t.quoted_tweet && typeof t.quoted_tweet === 'object') {
    // 超过层数只留一个跳转链接
    view.quoted = { more: true, url: t.quoted_tweet.url || '', author: authorOf(t.quoted_tweet) };
  }
  return view;
}

// 一条帖子的完整显示内容。转推显示原帖，并标明是谁转的
function extractPost(raw) {
  let t;
  try { t = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { return null; }
  const rt = t.retweeted_tweet && typeof t.retweeted_tweet === 'object' ? t.retweeted_tweet : null;
  if (rt) {
    const view = postView(rt);
    if (view && !view.unavailable) view.retweeted_by = authorOf(t);
    return view;
  }
  return postView(t);
}

module.exports = { extractPost, bodyOf, mediaOf, cardOf };
