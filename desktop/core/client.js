// 访问推文数据的客户端。两种模式：
//   relay：经 Cloudflare Worker 中转，app 里只有每人一个的访问码（同事用）
//   direct：直接调 twitterapi.io，用本机的 API Key（开发者自用 / 自建）
// 两种模式返回的数据结构完全相同。
const CREDITS_PER_TWEET = 15;
const MIN_CREDITS_PER_CALL = 15;
const TWITTERAPI_BASE = 'https://api.twitterapi.io';

// 已保存自用 Key 的用户始终使用自己的 API，旧内测码不会覆盖超管身份。
function resolveAccess({ apiKey, relayUrl, accessCode } = {}) {
  if (apiKey) return { mode: 'direct', apiKey };
  if (relayUrl && accessCode) return { mode: 'relay', relayUrl, accessCode };
  return { mode: 'none' };
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class FeedClient {
  // fetchImpl(url, init) -> Response，可注入以便测试
  constructor({ mode, relayUrl, accessCode, apiKey, directBase = TWITTERAPI_BASE, fetchImpl = fetch, maxRetries = 3, sleep } = {}) {
    if (mode === 'relay' && (!relayUrl || !accessCode)) throw new ApiError('未配置访问码', 0, 'no_access');
    if (mode === 'direct' && !apiKey) throw new ApiError('未设置 API Key', 0, 'no_key');
    if (mode !== 'relay' && mode !== 'direct') throw new ApiError('未配置数据来源', 0, 'no_access');
    this.mode = mode;
    this.relayUrl = (relayUrl || '').replace(/\/+$/, '');
    this.accessCode = accessCode;
    this.apiKey = apiKey;
    if (directBase !== TWITTERAPI_BASE && !/^http:\/\/127\.0\.0\.1:\d+$/.test(directBase)) {
      throw new Error('直连接口只能使用官方地址或本地样例服务');
    }
    this.directBase = directBase;
    this.fetch = fetchImpl;
    this.maxRetries = maxRetries;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.creditsUsed = 0;
    // 中转返回的本月额度信息
    this.quota = null;
  }

  async request(url, init) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      } catch (e) {
        if (attempt < this.maxRetries) { await this.sleep(2000 * 2 ** attempt); continue; }
        throw new ApiError(`网络错误：${e.cause?.code || e.message}`, 0, 'network');
      }
      // 429 限流和 5xx 重试；中转的额度用尽 (429 + quota_exceeded) 不重试
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* 非 JSON */ }
      if (res.ok) return body || {};
      const code = body && body.code;
      const retryable = (res.status === 429 && code !== 'quota_exceeded') || res.status >= 500;
      if (retryable && attempt < this.maxRetries) { await this.sleep(2000 * 2 ** attempt); continue; }
      const msg = (body && (body.message || body.error || body.msg)) || text.slice(0, 200) || res.statusText;
      throw new ApiError(friendly(res.status, code, msg, body), res.status, code);
    }
  }

  // 搜索一页推文。返回 { tweets, has_next_page, next_cursor }
  async searchPage(query, queryType, cursor) {
    let body;
    if (this.mode === 'relay') {
      body = await this.request(`${this.relayUrl}/v1/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.accessCode}` },
        body: JSON.stringify({ query, queryType, cursor }),
      });
      if (body.quota) this.quota = body.quota;
      if (body.balance !== undefined) this.balance = body.balance;
    } else {
      const qs = new URLSearchParams({ query, queryType, cursor: cursor || '' });
      body = await this.request(`${this.directBase}/twitter/tweet/advanced_search?${qs}`, {
        headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' },
      });
    }
    const tweets = Array.isArray(body.tweets) ? body.tweets : [];
    this.creditsUsed += Math.max(MIN_CREDITS_PER_CALL, CREDITS_PER_TWEET * tweets.length);
    return { tweets, has_next_page: Boolean(body.has_next_page), next_cursor: body.next_cursor || '' };
  }

  // 逐页产出推文数组
  async *search(query, maxPages = 1, queryType = 'Latest') {
    let cursor = '';
    for (let i = 0; i < maxPages; i++) {
      const page = await this.searchPage(query, queryType, cursor);
      yield page.tweets;
      if (!page.has_next_page || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  // 只在中转模式下可用：查询本月额度
  async status() {
    if (this.mode !== 'relay') return null;
    const body = await this.request(`${this.relayUrl}/v1/status`, {
      headers: { Authorization: `Bearer ${this.accessCode}` },
    });
    this.quota = body.quota || null;
    this.balance = body.balance ?? null;
    return body;
  }
}

function friendly(status, code, msg, body) {
  if (code === 'invalid_code' || status === 401) return '访问码无效或已停用，请联系管理员';
  if (code === 'quota_exceeded') return '本月抓取额度已用完，下个月自动恢复';
  if (code === 'balance_empty') {
    const no = body && body.account_no;
    return `余额不足，请充值${no ? `（转账时备注账号 ${no}）` : ''}`;
  }
  if (code === 'too_frequent') return '抓取太频繁，请稍后再试';
  if (status === 402) return 'API 余额不足，请联系管理员充值';
  return `请求失败（${status || '网络'}）：${msg}`;
}

module.exports = { FeedClient, ApiError, resolveAccess, CREDITS_PER_TWEET, MIN_CREDITS_PER_CALL };
