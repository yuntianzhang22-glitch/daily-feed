// 单一权限表：渲染层只据此展示，主进程对每次受保护操作重新检查。
// owner 只能由本机受信任的 API 凭据建立；访问码只能由服务端授予 beta/paid。
const COMMON_SETTINGS = [
  'version', 'follows', 'schedule_enabled', 'schedule_days', 'schedule_time',
  'max_per_target', 'search_mode', 'include_replies',
];
const OWNER_SETTINGS = ['keywords', 'group_size', 'max_pages', 'avg_posts_per_day'];

function identityFor(role) {
  if (!['owner', 'beta', 'paid', 'guest'].includes(role)) role = 'guest';
  const owner = role === 'owner';
  return { role, permissions: {
    configureApi: owner,
    configureAccessCode: !owner,
    configureKeywords: owner,
    viewApiCosts: owner,
    viewMonthlyQuota: role === 'beta',
    viewBalance: role === 'paid',
  } };
}

function requirePermission(role, permission) {
  if (!identityFor(role).permissions[permission]) {
    const error = new Error('权限不足：当前身份不能执行此操作');
    error.code = 'permission_denied';
    throw error;
  }
}

function verifiedMemberRole(plan = 'beta') {
  if (!['beta', 'paid'].includes(plan)) throw new Error('访问码返回的用户身份无效');
  return plan;
}

function visibleSettings(cfg, role) {
  const keys = role === 'owner' ? [...COMMON_SETTINGS, ...OWNER_SETTINGS] : COMMON_SETTINGS;
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(cfg, key)).map((key) => [key, cfg[key]]));
}

function applySettings(before, patch, role) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效');
  const allowed = new Set(role === 'owner' ? [...COMMON_SETTINGS, ...OWNER_SETTINGS] : COMMON_SETTINGS);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      const error = new Error(`权限不足：当前身份不能修改 ${key}`);
      error.code = 'permission_denied';
      throw error;
    }
  }
  return { ...before, ...patch };
}

// 即使旧配置或磁盘文件含有超管字段，普通身份抓取时也不会使用它们。
function fetchSettings(cfg, role) {
  return role === 'owner' ? cfg : { ...cfg, keywords: [], group_size: 4, max_pages: 1, avg_posts_per_day: 2 };
}

module.exports = { identityFor, requirePermission, verifiedMemberRole, visibleSettings, applySettings, fetchSettings };
