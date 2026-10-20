// 用户配置：读写 ~/Library/Application Support/Daily Feed/config.json。
// 带版本号，旧格式（包括 Python 版写的）在读取时自动迁移，迁移前先备份。
const fs = require('fs');
const path = require('path');
const { cleanUsernames } = require('./fetcher');
const { cleanDays, cleanTime, daysFromInterval, DEFAULT_DAYS, DEFAULT_TIME } = require('./schedule');

const CONFIG_VERSION = 3;
const DEFAULTS = {
  version: CONFIG_VERSION,
  follows: [],
  keywords: [],
  // 每周哪几天抓（0=周日 … 6=周六），空数组表示不自动抓取；几点抓
  schedule_days: DEFAULT_DAYS,
  schedule_time: DEFAULT_TIME,
  max_per_target: 3,
  search_mode: 'Top',
  include_replies: false,
  max_pages: 1,
  group_size: 4,
  avg_posts_per_day: 2,
};
const FROM_RE = /from:([A-Za-z0-9_]{1,15})/gi;

function num(value, lo, hi, dflt, int = true) {
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, int ? Math.trunc(n) : n));
}

// v0：accounts + 关键词 + schedule_days/schedule_time（最早的版本）
// v1/v2：follows + interval_hours（Python 版和 0.2.0）
// v3：follows + schedule_days/schedule_time
function migrate(raw) {
  const cfg = { ...raw };
  const isV0 = !('follows' in cfg);
  if (isV0) {
    const follows = [...(cfg.accounts || [])];
    const keywords = [];
    for (const k of cfg.keywords || []) {
      const names = [...String(k).matchAll(FROM_RE)].map((m) => m[1]);
      const rest = String(k).replace(FROM_RE, '').replace(/\bOR\b/g, '').replace('-filter:replies', '');
      // 只含 from: 的分组搜索才迁移成关注，夹带其他条件的保留为关键词
      if (names.length && !rest.replace(/[\s()]/g, '')) follows.push(...names);
      else keywords.push(k);
    }
    cfg.follows = follows;
    cfg.keywords = keywords;
  }
  // v0 本来就是按周几 + 时间，保留；v1/v2 的小时间隔换算成周几，时间用默认值
  if (!isV0 || !Array.isArray(cfg.schedule_days)) {
    if (!Array.isArray(cfg.schedule_days)) cfg.schedule_days = daysFromInterval(cfg.interval_hours);
    if (!cfg.schedule_time) cfg.schedule_time = DEFAULT_TIME;
  }
  for (const k of ['accounts', 'interval_hours']) delete cfg[k];
  cfg.version = CONFIG_VERSION;
  return cfg;
}

// 共用额度时一周最多抓几次（中转下发的 max_runs_per_week），超出时保留靠前的几天
function capDays(days, maxPerWeek) {
  const max = Number(maxPerWeek) || 0;
  if (!max || days.length <= max) return days;
  // 按周一到周日的顺序保留
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).slice(0, max).sort((a, b) => a - b);
}

function clean(cfg, limits = {}) {
  const maxFollows = Number(limits.max_follows) || 500;
  return {
    version: CONFIG_VERSION,
    follows: cleanUsernames(cfg.follows).slice(0, maxFollows),
    keywords: (cfg.keywords || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 20),
    schedule_days: capDays(cleanDays(cfg.schedule_days ?? DEFAULTS.schedule_days), limits.max_runs_per_week),
    schedule_time: cleanTime(cfg.schedule_time),
    max_per_target: num(cfg.max_per_target, 0, 100, DEFAULTS.max_per_target),
    search_mode: cfg.search_mode === 'Latest' ? 'Latest' : 'Top',
    include_replies: Boolean(cfg.include_replies),
    max_pages: num(cfg.max_pages, 1, 10, 1),
    group_size: num(cfg.group_size, 1, 8, 4),
    avg_posts_per_day: num(cfg.avg_posts_per_day, 0, 100, 2, false),
  };
}

class ConfigFile {
  constructor(file, { defaultsFile, backupDir } = {}) {
    this.file = file;
    this.defaultsFile = defaultsFile;
    this.backupDir = backupDir || path.join(path.dirname(file), 'backups');
  }

  load() {
    if (!fs.existsSync(this.file)) {
      // 首次运行：用内置默认配置（如有）
      let seed = { ...DEFAULTS };
      if (this.defaultsFile && fs.existsSync(this.defaultsFile)) {
        seed = { ...seed, ...JSON.parse(fs.readFileSync(this.defaultsFile, 'utf8')) };
      }
      return this.save(seed);
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // 文件损坏：备份后用默认值，不让应用起不来
      this.backup('corrupt');
      return this.save({ ...DEFAULTS });
    }
    if ((raw.version || 0) < CONFIG_VERSION) {
      this.backup(`v${raw.version || 0}`);
      return this.save(migrate(raw));
    }
    return { ...DEFAULTS, ...raw };
  }

  save(cfg, limits) {
    const cleaned = clean({ ...DEFAULTS, ...cfg }, limits);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 先写临时文件再改名，避免写一半断电导致配置损坏
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cleaned, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    return cleaned;
  }

  backup(tag) {
    if (!fs.existsSync(this.file)) return;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(this.file, path.join(this.backupDir, `config-${tag}-${stamp}.json`));
  }
}

module.exports = { ConfigFile, migrate, clean, capDays, DEFAULTS, CONFIG_VERSION };
