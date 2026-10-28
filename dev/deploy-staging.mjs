// 只创建/部署预发 Worker；不会读取正式密钥或使用正式 KV。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildMobile } from '../build/mobile.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = path.join(repo, 'relay/wrangler.staging.local.json');
const template = fs.readFileSync(path.join(repo, 'relay/wrangler.staging.toml'), 'utf8');
const production = fs.readFileSync(path.join(repo, 'relay/wrangler.toml'), 'utf8');
const command = (args, capture = false) => {
  const r = spawnSync(path.join(repo, 'node_modules/.bin/wrangler'), args, { cwd: repo, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.status !== 0) throw new Error(capture ? r.stderr || 'Wrangler 执行失败' : 'Wrangler 执行失败');
  return r.stdout;
};
if (!fs.existsSync(config)) {
  const output = command(['kv', 'namespace', 'create', 'daily-feed-staging-ACCESS'], true);
  const id = /["']?id["']?\s*[:=]\s*["']([a-f0-9]{32})["']/.exec(output)?.[1];
  if (!id) throw new Error('无法提取预发 KV ID，请参考 docs/ENVIRONMENTS.md 手工配置');
  fs.writeFileSync(config, JSON.stringify({
    name: 'daily-feed-relay-staging', main: 'src/worker.js', compatibility_date: '2026-10-01',
    kv_namespaces: [{ binding: 'ACCESS', id }],
    durable_objects: { bindings: [{ name: 'LEDGER', class_name: 'LedgerDO' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['LedgerDO'] }],
  }, null, 2));
}
const cfg = JSON.parse(fs.readFileSync(config, 'utf8'));
const prodId = /\bid\s*=\s*"([a-f0-9]+)"/.exec(production)?.[1];
if (cfg.name !== 'daily-feed-relay-staging' || !cfg.kv_namespaces?.[0]?.id || cfg.kv_namespaces[0].id === prodId || !template.includes(cfg.name)) {
  throw new Error('预发配置必须使用独立 Worker 和 KV');
}
await buildMobile();
cfg.assets = { directory: '../mobile/dist', binding: 'ASSETS', run_worker_first: true };
if (!cfg.durable_objects.bindings.some((b) => b.name === 'MOBILE_SCHEDULE')) cfg.durable_objects.bindings.push({ name: 'MOBILE_SCHEDULE', class_name: 'MobileScheduleDO' });
if (!cfg.migrations.some((m) => m.tag === 'v2-mobile-schedule')) cfg.migrations.push({ tag: 'v2-mobile-schedule', new_sqlite_classes: ['MobileScheduleDO'] });
if (!cfg.durable_objects.bindings.some((b) => b.name === 'TRANSLATION')) cfg.durable_objects.bindings.push({ name: 'TRANSLATION', class_name: 'TranslationDO' });
if (!cfg.migrations.some((m) => m.tag === 'v3-translation')) cfg.migrations.push({ tag: 'v3-translation', new_sqlite_classes: ['TranslationDO'] });
if (!cfg.durable_objects.bindings.some((b) => b.name === 'FEEDBACK')) cfg.durable_objects.bindings.push({ name: 'FEEDBACK', class_name: 'FeedbackDO' });
if (!cfg.migrations.some((m) => m.tag === 'v4-feedback')) cfg.migrations.push({ tag: 'v4-feedback', new_sqlite_classes: ['FeedbackDO'] });
cfg.vars = { TRANSLATION_TIER: 'disabled', TRANSLATION_MONTHLY_LIMIT: '1800000', ...cfg.vars };
fs.writeFileSync(config, JSON.stringify(cfg, null, 2));
command(['deploy', '--config', config]);
console.log('预发代码已部署。首次使用请为该配置单独设置 TWITTERAPI_KEY 和 ADMIN_TOKEN，见 docs/ENVIRONMENTS.md。');
