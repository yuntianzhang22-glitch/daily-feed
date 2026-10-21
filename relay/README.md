# 中转服务与账号管理

中转源码、Durable Object SQLite 账本、部署配置、测试和管理工具是开发仓库的一部分。
本地凭据（`.dev.vars*`、`.env.staging.local`）、运行数据库和 `.wrangler/` 不入库。
完整的环境隔离、部署和新电脑迁移步骤见 [环境说明](../docs/ENVIRONMENTS.md)。

## 常用管理命令

每次明确选择 `staging` 或 `production`，避免把测试充值写入正式账本：

```bash
npm run relay:admin:staging -- add "预发内测"
npm run relay:admin:staging -- add-paid "预发付费"
npm run relay:admin:staging -- topup <账号> 30 "预发模拟到账"
npm run relay:admin:staging -- list
```

正式管理用 `npm run relay:admin:production -- <命令>`，从 `desktop/app-config.json` 读取地址，从 `~/.daily-feed-admin/admin_token` 读取管理口令，或使用环境变量 `DAILY_FEED_RELAY` / `DAILY_FEED_ADMIN_TOKEN`。
预发只读取 `.env.staging.local` 或环境变量中的 `DAILY_FEED_STAGING_RELAY` / `DAILY_FEED_STAGING_ADMIN_TOKEN`，不会回退到正式口令。

| 命令 | 用途 |
| --- | --- |
| `add "名字" [每月美元额度=3]` | 免费内测，按实际 API 成本计入每月额度 |
| `add-paid "名字"` | 付费用户，初始零余额 |
| `topup <账号> <人民币金额> [备注]` | 收到转账后记账；负数用于退款或冲正 |
| `list` / `show <账号>` | 查看账号、余额、充值记录、月度用量 |
| `disable <账号>` / `enable <账号>` | 停用或恢复 |
| `plan <账号> beta 或 paid` | 切换套餐 |
| `quota <账号> <每月美元额度>` | 修改内测额度 |
| `price [汇率 加价倍数]` | 查看或修改之后充值的兑换价格 |
| `migrate` | 旧 KV 访问码导入账本，保留已发出的访问码 |
| `verify-roster [名单文件]` | 真实 API 核对名单，会产生费用 |
| `publish-roster desktop/roster.json` | 发布名单，名单版本号需递增 |
| `publish-update dist/latest.json` | 更新该环境的应用更新清单 |

登录账号（`df_…`，兼容原访问码）只在创建时显示一次，账本只保存哈希，无需密码。完整登录账号可在用户已登录的应用中复制，用于其他设备登录。短编号（DF-XXXXX）仅用于转账备注和管理命令，不能登录。停用账号对所有设备生效；目前不提供单台设备撤销。
内测默认月额度 $3，付费余额不会按月重置。默认汇率 7.2、加价 3 倍，这些是可修改的账本配置。

## 发布

`npm run release` 同时上传正式安装包、更新清单和完整开发源码包；该命令不会自动修改正式服务的更新清单。
完成验收后再显式运行：

```bash
npm run relay:admin:production -- publish-update dist/latest.json
```

## 首次部署正式服务

正式 Worker 的资源名与 KV ID 在 `wrangler.toml` 中，已有服务应保持不变。若部署到全新 Cloudflare 账号，需要先建立自己的 KV 并填写 ID，再设置两个独立的 Secret：

```bash
npx wrangler login
npx wrangler secret put TWITTERAPI_KEY --config relay/wrangler.toml
npx wrangler secret put ADMIN_TOKEN --config relay/wrangler.toml
npm run relay:deploy:production
```

正式 `TWITTERAPI_KEY`、`ADMIN_TOKEN` 不能写在配置文件、源码或发布包中。
