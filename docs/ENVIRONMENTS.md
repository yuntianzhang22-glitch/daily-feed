# 开发、验收和环境隔离

## 新电脑开始工作

需要 Apple 芯片 Mac、Node.js 24（与 CI 一致）和 Git；安装包仍然面向 macOS。

```bash
git clone https://github.com/yuntianzhang22-glitch/daily-feed.git
cd daily-feed
npm ci
npm run dev
```

不需要拷贝旧电脑的数据库、Python、API Key 或 Cloudflare 登录状态，就能进入带有合成帖子的实际应用。
中转 Worker、SQLite 账本和客户端使用同一套业务代码；本地适配器只替代 Cloudflare 绑定和上游数据。

## 环境

| 启动命令 | 服务与数据 | 用途 |
| --- | --- | --- |
| `npm start` / `npm run dev` | 本机合成数据，`.local/fixtures/test/` | 开发、功能验收，零 API 费用 |
| `npm run staging` | 独立本机服务，`.local/fixtures/staging/` | 发布候选验收，零 API 费用 |
| `npm run staging:live` | 真实 twitterapi.io，上游 Key 显式配置；独立账本和 `.local/live/staging/` | 真实抓取联调，会消耗 API 额度 |
| `npm run start:production` | 正式 Worker；`~/Library/Application Support/Daily Feed/` | 正式应用身份和数据 |

本地预发用真实 Worker 的 HTTP 处理和账本代码，Cloudflare 绑定由 Node 适配；它不等同于线上 Cloudflare 运行时。需要验收云端部署行为时，另按下面步骤部署远程预发 Worker。

每个非正式环境按 `profiles/<身份>/<状态>/` 再拆分数据库和配置。正式应用可以与测试或预发同时运行。样例模式、真实 API 模式也不共享数据。
同一种环境同时只运行一个验收实例（固定本机端口 8791/8792/8793）；关闭窗口就退出本地验收应用，在启动终端按 Ctrl+C 可停止整套服务。
正式应用关闭窗口后仍保留原有后台抓取行为。

环境入口会清除继承来的 `DAILY_FEED_*`，不会意外使用终端里残留的正式访问码、数据目录或更新地址。非正式环境不读取正式配置、API Key 或阅读数据库；没有本地服务就拒绝启动。
验收环境不会检查或安装正式更新，也不发送抓取系统通知、不改正式应用未读角标。正式安装包拒绝进入本地验收模式。

## 三种身份和验收状态

打开应用左侧的“环境验收”面板，可以直接切换身份和状态，窗口会重新加载实际应用界面。

| 身份 | 实际权限/数据路径 | 预置状态 |
| --- | --- | --- |
| 超管（自用 API） | API Key 直连，无用户月额度/充值余额限制；保留关键词抓取 | 正常 |
| 内测用户 | 访问码经本地中转使用管理员 API；免费，受月额度限制 | 正常、额度耗尽、停用 |
| 普通付费用户 | 访问码经中转，按返回条数扣余额；显示账号供转账备注 | 已充值 ¥30、未充值、低余额 ¥0.50、停用 |

这里的“超管”对应现有产品的自用直连身份，账号管理仍通过管理脚本进行；没有给普通客户端发放服务管理口令。
正式应用只要保存了自己的 API Key，就优先直连，即使本机残留旧内测码也不会被当作内测用户。设置页显示“API 连接”，隐藏访问码输入和内测月额度，可展开“更换 API Key”调整配置。
本地验收管理口令每次启动随机生成，只在主进程和回环服务之间使用，不暴露给页面，也不能管理正式账号。
本地合成访问码是公开可复现的测试数据，只存在本地账本；远程 Worker 不会自动创建或接受它们。

可直接指定初始身份：

```bash
npm run dev -- --role beta
npm run dev -- --role beta --scenario exhausted
npm run staging -- --role paid --scenario empty
```

在付费身份中点击“模拟转账充值 ¥10”，可验收转账后管理员记账、余额显示和恢复抓取；不发生真实资金交易。
余额、用量和阅读标记会持久化，所以充值后的“未充值”样例会变为有余额。要复原所有样例，请先关闭验收服务，再删除对应的 `.local/fixtures/test/` 或 `.local/fixtures/staging/`，下次启动自动重建。
不要删除正式应用的数据目录。真实 API 模式账号余额同样是本地模拟资金，API 消耗则是真实的。

推荐验收：

1. 超管：查看样例、搜索、收藏、已读、关键词设置、手动抓取。
2. 内测正常：设置显示免费月额度；抓取成功且用量增加。
3. 内测耗尽/停用：抓取被拦截，显示正确原因。
4. 付费未充值：设置显示账号、零余额、转账备注提示；抓取被拦截。
5. 模拟到账：点击充值按钮，设置显示新余额，抓取恢复且余额扣减。
6. 付费低余额/停用：验收充值提示和停用拦截。
7. 在三个身份之间切换：已读、收藏、关注列表分别保留；正式应用数据不变。

## 真实 API 预发

```bash
cp .env.staging.example .env.staging.local
# 在编辑器里填写 DAILY_FEED_STAGING_API_KEY，切勿提交该文件
npm run staging:live
```

该模式不会尝试读取正式密钥；未填写就退出。可填写自己的 API Key（会消耗同一个供应商账户的额度），也可使用独立测试 Key。
预发中的内测和付费用户仍共享这一预发上游 Key，但额度、余额、访问码与正式账本完全分开。首次没有样例帖子，手动抓取后才有真实内容。

## 远程 Cloudflare 预发

远程资源隔离使用独立 Worker `daily-feed-relay-staging`、独立 KV 和该 Worker 自己的 Durable Object 账本，不修改正式 `daily-feed-relay`。
参照 [Cloudflare 环境隔离文档](https://developers.cloudflare.com/workers/wrangler/environments/)，绑定和密钥必须分别配置。

```bash
npx wrangler login
npm run relay:deploy:staging
npx wrangler secret put TWITTERAPI_KEY --config relay/wrangler.staging.local.json
npx wrangler secret put ADMIN_TOKEN --config relay/wrangler.staging.local.json
```

部署脚本首次创建独立 KV，将配置写入被忽略的 `relay/wrangler.staging.local.json`。这个文件没有密钥，可在换电脑时从 Cloudflare 找回 KV ID，或重新创建一套预发资源。
远程凭据请存密码管理器或 Cloudflare Secrets；完整开发仓库可公开，真实凭据不进入 GitHub。
填写 `.env.staging.local` 中远程预发的地址与独立管理口令，然后：

```bash
npm run relay:admin:staging -- add "预发内测"
npm run relay:admin:staging -- add-paid "预发付费"
npm run relay:admin:staging -- topup <预发账号> 30 "预发模拟到账"
npm run relay:admin:staging -- publish-roster desktop/roster.json
```

远程预发用于云端服务联调；上面的本地一键验收面板始终使用本机账本，不会把操作发给远程或正式账本。
部署正式 Worker 必须显式运行 `npm run relay:deploy:production`。正式账号管理用 `npm run relay:admin:production -- <命令>`。

## 测试和发布

```bash
npm test
npm run test:ui
npm run dist
```

测试包括真实本机 HTTP、Worker、SQLite 账本、实际 Electron 页面和身份切换。CI 从干净 GitHub checkout 安装依赖，缺失中转文件会直接失败。

发布前更新版本和 `docs/RELEASE_NOTES.md`，提交完整源码，然后运行：

```bash
npm run release -- --prepare-only   # 完整构建、测试、生成三个发布产物
npm run release                    # 推送提交并创建 GitHub Release
```

Release 包含正式 `.app` 的安装 zip、`latest.json`、`Daily-Feed-<版本>-development.zip`（完整 Git 跟踪的开发仓库）。GitHub 自带 Source code 也包含全部环境源码。
开发源码包不带 `node_modules`、本地数据库和密钥，解压后 `npm ci && npm run dev` 即可运行。
GitHub CLI 需已登录且具备仓库写权限，发布流程不会把本机验收服务、验收账户或运行数据打进正式安装包。
GitHub Release 创建后，验证完成再运行下面的显式命令更新正式用户的更新通道：

```bash
npm run relay:admin:production -- publish-update dist/latest.json
```

这一操作与 GitHub 上传分开，避免未验收的安装包直接推送到所有正式用户。
