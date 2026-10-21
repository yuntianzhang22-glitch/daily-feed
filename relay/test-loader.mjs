// 测试用：在 Node 里把 cloudflare:workers 换成一个最小实现，让 worker.js 能被直接导入。
// 用法：node --import ./relay/test-loader.mjs --test relay/relay.test.mjs
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'stub:cloudflare-workers', shortCircuit: true };
    return next(specifier, context);
  }
  export async function load(url, context, next) {
    if (url === 'stub:cloudflare-workers') {
      return {
        format: 'module', shortCircuit: true,
        source: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
      };
    }
    return next(url, context);
  }
`));
