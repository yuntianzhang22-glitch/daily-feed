// Traditional, deterministic reading-priority heuristics. No model or network.
const { extractPost } = require('./post');
const VERSION = 'rules-v1';
const WEIGHTS = Object.freeze({ relevance: 25, specificity: 25, sources: 20, explanation: 15, freshness: 10, engagement: 5 });
const LABELS = { relevance: '主题匹配', specificity: '具体信息线索', sources: '来源线索', explanation: '解释与方法线索', freshness: '发布时间', engagement: '作者相对热度' };
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const TOPIC_ALIASES = { ai: ['artificial intelligence', '人工智能', 'machine learning', '机器学习', 'llm', '大模型', 'chatgpt', 'claude', 'openai', 'anthropic'] };
TOPIC_ALIASES['人工智能'] = ['ai', ...TOPIC_ALIASES.ai];
const normalize = (s) => String(s || '').normalize('NFKC').toLowerCase();
function cleanTopics(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(/[,，、\n]/)).map(t => normalize(t).trim()).filter(Boolean))].slice(0, 20).map(t => t.slice(0, 40));
}
function tokens(s) {
  const text = normalize(s).replace(/https?:\/\/\S+/g, ' ');
  const words = text.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]+/g) || [];
  return new Set(words.flatMap(w => /[\u3400-\u9fff]/.test(w) ? Array.from({ length: Math.max(0, w.length - 1) }, (_, i) => w.slice(i, i + 2)) : [w]));
}
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0; for (const t of a) if (b.has(t)) common++;
  return common / (a.size + b.size - common);
}
function hasTerm(text, term) {
  let at = text.indexOf(term);
  while (at >= 0) {
    if (!/^[a-z0-9_ ]+$/i.test(term) || (!/[a-z0-9_]/.test(text[at - 1] || '') && !/[a-z0-9_]/.test(text[at + term.length] || ''))) return true;
    at = text.indexOf(term, at + 1);
  }
  return false;
}
function describe(record, now) {
  let raw = record.raw ?? record;
  try { if (typeof raw === 'string') raw = JSON.parse(raw); } catch { raw = {}; }
  const post = extractPost(raw) || {};
  const text = normalize([post.text, post.quoted?.text].filter(Boolean).join('\n'));
  const published = Date.parse(post.created_at || record.created_at || '');
  const age = Number.isFinite(published) && published <= now ? (now - published) / 86400000 : null;
  const metrics = raw.retweeted_tweet || raw;
  const metric = (n) => Number.isFinite(Number(n)) ? clamp(Number(n), 0, 1e12) : 0;
  const links = [...new Set([...(post.links || []), ...(post.quoted?.links || []), ...(post.card?.url ? [{ url: post.card.url }] : [])].map(l => l.url))];
  const domains = links.flatMap(link => { try { const u = new URL(link); return u.protocol === 'https:' ? [u.hostname.replace(/^www\./, '')] : []; } catch { return []; } });
  return { record, id: String(raw.id || record.id || ''), canonical: post.id || String(raw.id || record.id || ''),
    author: normalize(post.author?.username), text, tokens: tokens(text), ownTokens: tokens(post.text), age, post, domains,
    numbers: (text.match(/\d+(?:\.\d+)?/g) || []).join('|'),
    linkKey: links.slice().sort().join('|'), mediaKey: (post.media || []).map(m => m.full || m.thumb || m.url).sort().join('|'),
    popularity: Math.log1p(metric(metrics.likeCount) + 2 * metric(metrics.retweetCount)) };
}
function ranked(records, { now = Date.now(), topics = [], deduplicate = true, diversify = true, limit = Infinity } = {}) {
  const interests = cleanTopics(topics), items = records.map(r => describe(r, now));
  const scored = items.map(item => {
    const { text, age, domains } = item;
    const method = /\b(method|protocol|guide|tutorial|implementation|workflow|playbook|how to)\b|方法|步骤|教程|实践|流程/.test(text);
    const result = /\b(experiment|evaluation|benchmark|results?|dataset|technical report|trial)\b|实验|评估|结果|技术报告|数据集/.test(text);
    const example = /\b(for example|for instance|case study|in production)\b|例如|比如|案例|生产环境/.test(text);
    const news = /\b(introducing|released?|launch|joining|announc\w*)\b|发布|加入|上线|推出/.test(text);
    const specificNumber = /\b\d+(?:\.\d+)?\s*(?:%|pages?|rules?|users?|analysts?|days?|hours?|times|models?)\b|\d+\s*(?:%|页|项|人|天|小时|倍)/.test(text);
    const trustedType = domains.some(d => /(^|\.)(arxiv\.org|doi\.org|github\.com|aclanthology\.org|openreview\.net)$/.test(d));
    const firsthand = /\b(we(?:'ve| have| are)? (?:built|released?|introduc\w*|tested|found|show\w*)|i(?:'m| am) (?:joining|launching))\b|我们(?:发布|发现|测试|提出)|我(?:加入|发布)/.test(text);
    const matches = interests.filter(t => [t, ...(TOPIC_ALIASES[t] || [])].some(term => hasTerm(text + ' ' + item.author, term)));
    // Baselines compare only other posts by the same author in a broad age band.
    const band = a => a == null ? -1 : a < 1 ? 0 : a < 3 ? 1 : a < 7 ? 2 : 3;
    const peers = item.author ? items.filter(p => p !== item && p.canonical !== item.canonical && p.author === item.author && band(p.age) === band(age)).map(p => p.popularity).sort((a,b)=>a-b) : [];
    const median = peers.length ? peers[Math.floor(peers.length / 2)] : 0;
    const features = {
      relevance: interests.length ? clamp(matches.length / Math.min(3, interests.length)) : 0.5,
      specificity: clamp(0.1 + 0.3 * method + 0.3 * result + 0.2 * example + 0.1 * specificNumber + 0.2 * news),
      sources: trustedType ? 0.9 : domains.length ? 0.6 : firsthand ? 0.6 : item.post.quoted?.text ? 0.4 : 0.2,
      explanation: clamp(0.1 + 0.35 * method + 0.3 * /\b(because|however|limitations?|trade.?offs?|why|disagree)\b|因为|原因|局限|但是|权衡|不同意/.test(text) + 0.25 * example),
      freshness: age == null ? 0.5 : Math.pow(0.5, age / (news && !method && !result ? 2 : 7)),
      engagement: peers.length >= 4 ? clamp(0.5 + (item.popularity - median) / 8) : 0.5,
    };
    const noise = /\b(like and (?:retweet|repost)|follow (?:me )?to win|giveaway)\b|(?:点赞|转发|关注).{0,12}抽奖/.test(text) ? 20 : 0;
    const contributions = Object.fromEntries(Object.entries(WEIGHTS).map(([key, weight]) => [key, Math.round(features[key] * weight * 100) / 100]));
    const score = clamp(Object.values(contributions).reduce((a,b)=>a+b,0) - noise, 0, 100);
    const reasons = [matches.length ? `匹配主题：${matches.join('、')}` : interests.length ? '未命中所选主题词' : '未设置主题，按中性值评分',
      method ? '含方法或实践词语' : '', result ? '含研究或评估词语' : '', news ? '含发布或变动词语' : '',
      domains.length ? '含可追溯链接（未核验真实性）' : firsthand ? '含一手发布表述（未核验）' : '',
      peers.length < 4 ? '作者样本不足，热度按中性值计' : '热度与同作者相近帖龄内容比较', noise ? '含互动诱导线索，扣20分' : ''].filter(Boolean);
    return { ...item, score, ranking: { version: VERSION, score: Math.round(score * 10) / 10, features, contributions, reasons, noise_penalty: noise, diversity_penalty: 0, duplicate_count: 0 } };
  }).sort((a,b) => b.score - a.score || (a.age ?? Infinity) - (b.age ?? Infinity) || a.id.localeCompare(b.id));
  const unique = [];
  for (const item of scored) {
    // A shared link alone is insufficient: independent commentary must survive.
    const duplicate = deduplicate && unique.find(p => p.canonical === item.canonical || (p.linkKey === item.linkKey && p.mediaKey === item.mediaKey && p.numbers === item.numbers && ((p.text && p.text === item.text) || (item.tokens.size >= 15 && p.tokens.size >= 15 && similarity(p.tokens, item.tokens) >= 0.85 && similarity(p.ownTokens, item.ownTokens) >= 0.85))));
    if (duplicate) duplicate.ranking.duplicate_count++;
    else unique.push(item);
  }
  const output = [], authorCounts = new Map();
  while (unique.length && output.length < limit) {
    unique.sort((a,b) => (b.score - (diversify && b.author ? Math.min(30, (authorCounts.get(b.author) || 0) * 10) : 0)) - (a.score - (diversify && a.author ? Math.min(30, (authorCounts.get(a.author) || 0) * 10) : 0)) || a.id.localeCompare(b.id));
    const item = unique.shift(), penalty = diversify && item.author ? Math.min(30, (authorCounts.get(item.author) || 0) * 10) : 0;
    item.ranking.diversity_penalty = penalty;
    item.ranking.score = Math.round(clamp(item.score - penalty, 0, 100) * 10) / 10;
    if (penalty) item.ranking.reasons.push(`同作者已入选，扣${penalty}分`);
    if (item.ranking.duplicate_count) item.ranking.reasons.push(`合并${item.ranking.duplicate_count}条相似分享，可在全部中查看`);
    authorCounts.set(item.author, (authorCounts.get(item.author) || 0) + 1);
    output.push({ ...item.record, ranking: item.ranking });
  }
  return output;
}
module.exports = { VERSION, WEIGHTS, LABELS, cleanTopics, ranked, tokens, similarity };
