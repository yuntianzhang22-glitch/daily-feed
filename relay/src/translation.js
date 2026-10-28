// Character-billed standard translation only. No LLM or paid fallback.
export const MAX_TEXT = 16000;
export class TranslationError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function validateTexts(body) {
  if (!Array.isArray(body?.texts) || !body.texts.length || body.texts.length > 2 ||
      body.texts.some((t) => typeof t !== 'string') ||
      body.texts.reduce((n, t) => n + t.length, 0) > MAX_TEXT || !body.texts.some((t) => t.trim())) {
    throw new TranslationError('translation_input', '请选择一条有正文的帖子，单次最多翻译 16000 字符');
  }
  return body.texts;
}
const hash = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
export class TranslationService {
  constructor(storage, env, fetchImpl = (...args) => fetch(...args), now = () => new Date()) {
    this.storage = storage; this.env = env; this.fetch = fetchImpl; this.now = now;
    this.queue = Promise.resolve();
  }
  translate(account, body) {
    const run = this.queue.then(() => this.run(account, body));
    this.queue = run.catch(() => {});
    return run;
  }
  async cleanup() {
    let startAfter; let retained = false;
    for (;;) {
      const entries = await this.storage.list({ prefix: 'cache:', limit: 128, ...(startAfter ? { startAfter } : {}) });
      if (!entries.size) break;
      const expired = [];
      for (const [key, value] of entries) {
        startAfter = key;
        if (value.expires <= this.now().getTime()) expired.push(key); else retained = true;
      }
      if (expired.length) await this.storage.delete(expired);
      if (entries.size < 128) break;
    }
    if (retained) await this.storage.setAlarm(this.now().getTime() + 86400000);
  }
  async run(account, body) {
    const texts = validateTexts(body);
    const keys = await Promise.all(texts.map((t) => hash(`azure-v3:zh-Hans:${t}`)));
    const results = new Map();
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i].trim()) { results.set(keys[i], ''); continue; }
      const cached = await this.storage.get(`cache:${keys[i]}`);
      if (cached?.expires > this.now().getTime() && typeof cached?.text === 'string') results.set(keys[i], cached.text);
    }
    const missing = [...new Set(keys)].filter((key) => !results.has(key));
    if (!missing.length) return { texts: keys.map((key) => results.get(key)), cached: true };
    if (this.env.TRANSLATION_TIER !== 'F0' || !this.env.AZURE_TRANSLATOR_KEY) {
      throw new TranslationError('translation_unavailable', '翻译服务尚未启用，请稍后再试', 503);
    }
    const budget = Number(this.env.TRANSLATION_MONTHLY_LIMIT || 1800000);
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1800000) {
      throw new TranslationError('translation_unavailable', '翻译服务暂不可用', 503);
    }
    const input = missing.map((key) => texts[keys.indexOf(key)]);
    // UTF-16 length conservatively counts supplementary Unicode twice.
    const chars = input.reduce((n, t) => n + t.length, 0);
    const date = this.now().toISOString();
    const month = date.slice(0, 7), day = date.slice(0, 10);
    const usage = await this.storage.get('usage') || {};
    const used = usage.month === month ? usage.chars : 0;
    const daily = usage.day === day ? usage.accounts || {} : {};
    if (used + chars > budget) throw new TranslationError('translation_quota', '本月免费翻译额度已用完，下个月恢复', 429);
    if ((daily[account] || 0) + chars > 40000) throw new TranslationError('translation_daily', '今日翻译次数较多，请明天再试', 429);
    // Reserve before any external call; failed/ambiguous calls stay counted.
    await this.storage.put('usage', { month, chars: used + chars, day, accounts: { ...daily, [account]: (daily[account] || 0) + chars } });
    let translated;
    try {
      const response = await this.fetch('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans&textType=plain', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': this.env.AZURE_TRANSLATOR_KEY,
          ...(this.env.AZURE_TRANSLATOR_REGION ? { 'Ocp-Apim-Subscription-Region': this.env.AZURE_TRANSLATOR_REGION } : {}) },
        body: JSON.stringify(input.map((Text) => ({ Text }))), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('provider');
      translated = await response.json();
      if (!Array.isArray(translated) || translated.length !== input.length || translated.some((t) => typeof t.translations?.[0]?.text !== 'string' || !t.translations[0].text.trim())) throw new Error('response');
    } catch {
      throw new TranslationError('translation_failed', '翻译暂时失败，请稍后重试，原文仍可阅读', 502);
    }
    for (let i = 0; i < missing.length; i++) {
      const text = translated[i].translations[0].text;
      await this.storage.put(`cache:${missing[i]}`, { text, expires: this.now().getTime() + 2592000000 });
      results.set(missing[i], text);
    }
    if (!(await this.storage.getAlarm())) await this.storage.setAlarm(this.now().getTime() + 86400000);
    return { texts: keys.map((key) => results.get(key)), cached: false };
  }
}
