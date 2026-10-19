# 发布与管理

## 一次性准备（约 10 分钟）

1. 注册 Cloudflare 账号（免费）：https://dash.cloudflare.com/sign-up
2. 在本目录登录并创建存储：

```bash
cd relay
npx wrangler@4.151.2 login
npx wrangler@4.151.2 kv namespace create ACCESS
```

把输出里的 `id` 填进 `wrangler.toml` 的 `REPLACE_WITH_KV_NAMESPACE_ID`。

3. 设置两个密钥（输入时不会显示）：

```bash
npx wrangler@4.151.2 secret put TWITTERAPI_KEY
npx wrangler@4.151.2 secret put ADMIN_TOKEN
```

`ADMIN_TOKEN` 自己生成一个长随机串，例如 `openssl rand -hex 32` 的输出，保存好。

4. 部署：

```bash
npx wrangler@4.151.2 deploy
```

记下输出的地址，形如 `https://daily-feed-relay.<子域>.workers.dev`。

5. 把地址填进 `desktop/app-config.json`：

```json
{
  "relayUrl": "https://daily-feed-relay.<子域>.workers.dev",
  "updateManifestUrl": "https://daily-feed-relay.<子域>.workers.dev/v1/latest",
  "rosterUrl": "https://daily-feed-relay.<子域>.workers.dev/v1/roster"
}
```

## 给同事发访问码

```bash
export DAILY_FEED_RELAY=https://daily-feed-relay.<子域>.workers.dev
export DAILY_FEED_ADMIN_TOKEN=<上面的 ADMIN_TOKEN>
node relay/admin.mjs add "张三"            # 默认每月 $3，最短间隔 6 小时，最多关注 60 人
node relay/admin.mjs list                  # 看每个人本月用量
node relay/admin.mjs disable <id>          # 停用某人
```

访问码只在创建时显示一次，私下发给对方。

## 发布新版本

1. 改 `package.json` 的 `version`（比如 0.2.0 → 0.2.1）
2. 打包，下载地址指向 GitHub Release：

```bash
DAILY_FEED_DOWNLOAD_BASE=https://github.com/<用户>/<仓库>/releases/download/v0.2.1 DAILY_FEED_NOTES="这次改了什么" npm run dist
```

3. 上传 zip 到 GitHub Release（仓库可以是公开的，安装包里没有任何密钥）：

```bash
gh release create v0.2.1 dist/Daily-Feed-0.2.1-mac-arm64.zip --repo <用户>/<仓库> --notes "这次改了什么"
```

4. 发布更新清单，同事的应用下次打开就会提示更新：

```bash
node relay/admin.mjs publish-update dist/latest.json
```

## 更新名单（不用发新版）

改 `desktop/roster.json`，把 `version` 加 1，然后：

```bash
node relay/admin.mjs publish-roster desktop/roster.json
```

## 同事第一次安装

1. 解压 zip，把 Daily Feed 拖进「应用程序」
2. 第一次打开：右键点 Daily Feed →「打开」→ 再点「打开」。如果提示"已损坏"，在终端运行：

```bash
xattr -dr com.apple.quarantine "/Applications/Daily Feed.app"
```

3. 打开后在设置里粘贴访问码。以后的更新在应用内完成，不用再做这些。
