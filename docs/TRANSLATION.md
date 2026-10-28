# 帖子中文翻译

桌面版和移动版的帖子下方提供「翻译成中文」，按需翻译正文及一层引用正文。原文、图片、链接和收藏/已读状态保留。译文可收起；翻译失败可手动重试。图片文字、视频字幕、外链文章、引用之外的整个讨论串不在本次范围内。

## 当前状态

功能随 0.11.0 提供，真实翻译默认关闭；未配置 Azure 时服务返回「翻译服务尚未启用」。没有在安装包、浏览器或仓库内存放供应商密钥。旧安装包需升级至 0.11.0；移动端需部署配套 Worker 与 Pages 入口。

## 免费方案及保护

使用 Azure Translator **单服务标准翻译 F0**，不使用大模型，不按 LLM token 计费。F0 当前每个订阅月最多 200 万字符，达到后停止。参考：[定价](https://azure.microsoft.com/en-us/pricing/details/translator/)、[官方 FAQ](https://www.microsoft.com/en-us/translator/business/faq/)、[REST 接口](https://learn.microsoft.com/azure/ai-services/translator/text-translation/reference/v3/translate)。必须在 Azure 门户确认实际 SKU 为 F0；本项目的配置字符串不能验证 Azure 真实套餐。切换 S1 后不再具有相同的免费保护。

- 默认关闭。服务端须同时配置 `TRANSLATION_TIER=F0` 和密钥才会调用供应商。
- 本应用每个环境每 UTC 自然月最多预留 180 万字符，可调低、不可调高；这与 Azure 订阅月边界不一定相同，供应商 F0 限制仍是最终保护。
- 每个账号每日最多 4 万字符；每次最多正文与引用两段，总计 16000 UTF-16 字符（非 BMP 字符保守地算两个）。
- 单一 Durable Object 持久化预留额度并串行请求，并发不能越过预算。超时、失败的请求也保留预留额度，避免已被供应商处理但丢失响应时低估用量。
- 相同原文按内容、目标语言和翻译版本缓存 30 天，跨有效账号复用；缓存存于该环境的专用 Durable Object，定期清理到期结果。原文不作为缓存键明文存储。译文存云端；点击翻译会把正文发送给 Azure。
- 不自动重试供应商请求，不切换付费资源，不扣用户的 X 抓取额度或充值余额。缓存命中时不再消耗翻译字符。
- 正式和预发使用独立 Worker、DO、账号。最好使用独立 F0 资源；如 Azure 账号不允许再创建 F0，预发保留样例服务，不以付费资源代替。若多个应用共用资源，Azure 免费额度由所有调用共享，应用预算仅约束本应用。
- Cloudflare 现有运行、存储资源仍受自身免费配额约束，因此这里指翻译供应商 F0 免费，并非对所有基础设施费用的承诺。

## 配置（资源创建后）

1. 在 Azure 门户创建 Translator 单服务资源，**定价层 F0**。保留 Key 和区域供本机配置，不发到聊天、不写入仓库。当前客户端只使用官方全球标准翻译端点，不适配 Azure 中国区或私有端点。
2. 为正式资源通过终端交互录入密钥；命令会提示输入，不把密钥写在命令参数中：

   ```sh
   npx wrangler secret put AZURE_TRANSLATOR_KEY --config relay/wrangler.toml
   ```

3. 编辑正式 `relay/wrangler.toml` 的 `[vars]`：将 `TRANSLATION_TIER` 改为 `"F0"`，加入 `AZURE_TRANSLATOR_REGION = "实际区域"`。区域不是密钥，可提交 Git。`TRANSLATION_MONTHLY_LIMIT` 保持 `"1800000"` 或更小值。
4. 预发使用独立本地配置 `relay/wrangler.staging.local.json`，在其 `vars` 中配置相同字段，并用该配置录入预发专用密钥：

   ```sh
   npx wrangler secret put AZURE_TRANSLATOR_KEY --config relay/wrangler.staging.local.json
   ```

   `npm run relay:deploy:staging` 会自动补充 `TRANSLATION` 绑定与 `v3-translation` 迁移。不要将生成的本地配置或 `.dev.vars` 提交。
5. 先在预发验证正文、引用、长帖、失败提示和重复缓存，再部署正式 Worker、移动入口及统一发布桌面安装包。启用/部署操作与这次完成的代码准备分开执行；部署不会自动开通 Azure 或启用真实翻译。

关闭：将对应环境 `TRANSLATION_TIER` 改回 `"disabled"` 并部署。已缓存译文仍可读取，新的内容不会再发给供应商。删除密钥也能阻止新请求。

## 验收

- `npm test`：输入校验、权限、缓存、并发预留、字符上限、失败及跨月恢复，并包含真实 workerd/SQLite/RPC 翻译测试。
- `npm run test:ui`：隐藏窗口桌面实际组件展示、收起/展开不重复请求、错误恢复、文本安全。
- `npm run test:mobile`：移动构建及真实浏览器点击翻译；本地服务返回标明「样例译文」的固定数据，不代表翻译质量。还需要启用 F0 后验证真实研究帖译文质量，以及真机 Safari 体验。
