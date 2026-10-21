// 环境与验收身份。正式应用不读取本地验收账号，也不开放验收控制。
const path = require('node:path');

const ROLES = { owner: '超管（自用 API）', beta: '内测用户', paid: '付费用户' };
const SCENARIOS = {
  owner: { normal: '正常使用' },
  beta: { normal: '额度充足', exhausted: '本月额度耗尽', disabled: '账号停用' },
  paid: { normal: '已充值', empty: '未充值 / 余额不足', low: '余额低于 ¥1', disabled: '账号停用' },
};

function validateProfile(role, scenario) {
  if (!SCENARIOS[role] || !Object.hasOwn(SCENARIOS[role], scenario)) throw new Error('未知的验收身份或状态');
  return { role, scenario };
}

function localCode(environment, role, scenario) {
  if (!['test', 'staging'].includes(environment) || role === 'owner') throw new Error('只能生成本地用户访问码');
  validateProfile(role, scenario);
  return `df_local_${environment}_${role}_${scenario}_only`;
}

function profilePath(root, environment, role, scenario) {
  if (!['test', 'staging'].includes(environment)) throw new Error('验收目录不能用于正式环境');
  validateProfile(role, scenario);
  return path.join(root, environment, 'profiles', role, scenario);
}

function resolveEnvironment({ env = process.env, packaged = false, appConfig = {}, localRoot }) {
  const name = env.DAILY_FEED_ENV || 'production';
  if (!['production', 'test', 'staging'].includes(name)) throw new Error('未知的运行环境');
  if (packaged && name !== 'production') throw new Error('正式安装包不支持本地验收模式，请从完整开发仓库启动');
  if (name === 'production') return {
    name, label: '正式环境', lab: false,
    relayUrl: env.DAILY_FEED_RELAY || appConfig.relayUrl || '',
    updateManifestUrl: env.DAILY_FEED_MANIFEST || appConfig.updateManifestUrl || '',
    rosterUrl: env.DAILY_FEED_ROSTER || appConfig.rosterUrl || '',
  };
  const relayUrl = env.DAILY_FEED_LAB_URL || '';
  // 非正式环境绝不能回退到正式中转，验收控制只接受本机服务。
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(relayUrl) || !env.DAILY_FEED_LAB_TOKEN) {
    throw new Error('请用 npm run dev 或 npm run staging 启动隔离环境');
  }
  const role = env.DAILY_FEED_ROLE || 'owner';
  const scenario = env.DAILY_FEED_SCENARIO || 'normal';
  validateProfile(role, scenario);
  const root = path.resolve(localRoot);
  return {
    name, label: name === 'test' ? '测试环境' : '预发环境', lab: true, root, role, scenario,
    live: env.DAILY_FEED_LIVE === '1', relayUrl,
    updateManifestUrl: '', rosterUrl: `${relayUrl}/v1/roster`,
    dataPath: profilePath(root, name, role, scenario),
  };
}

module.exports = { ROLES, SCENARIOS, validateProfile, localCode, profilePath, resolveEnvironment };
