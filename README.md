# Daily Feed

定期抓取你关注的 X 账号的帖子，整理成一个本地阅读流。macOS 桌面应用。

## 安装

1. 在 [Releases](../../releases/latest) 下载 `Daily-Feed-<版本>-mac-arm64.zip`（Apple 芯片 Mac）
2. 解压，把 **Daily Feed** 拖进「应用程序」
3. 第一次打开：右键点 Daily Feed →「打开」→ 再点「打开」。如果提示"已损坏，无法打开"，在终端运行：

```bash
xattr -dr com.apple.quarantine "/Applications/Daily Feed.app"
```

4. 打开「设置」，粘贴管理员发给你的访问码，点「验证并保存」
5. 点「关注」，从内置名单里勾选想看的人

之后的版本在应用内更新，配置、关注列表和帖子记录都会保留。数据存在 `~/Library/Application Support/Daily Feed/`。

## 网络

应用使用系统代理设置。如果你的网络访问不了 Cloudflare（`*.workers.dev`），需要开启代理。

## 开发

需要 Node.js 24。在新电脑上克隆仓库后：

```bash
npm ci
npm run dev
```

打开的是与正式应用隔离的测试环境，内置合成帖子；在左侧验收面板切换超管、内测、付费身份，以及额度耗尽、余额不足、停用等状态。无需 API Key，不产生 API 费用。

- `npm run staging`：独立的预发验收环境
- `npm run staging:live`：显式配置自己的预发 API Key 后，联调真实抓取
- `npm run start:production`：正式服务和正式数据
- `npm test` / `npm run test:ui`：业务测试 / 实际 Electron 页面验收
- `npm run release`：构建、验证并上传正式安装包及完整开发源码包到 GitHub

完整的隔离规则、账号状态、真实 API 联调、远程预发部署和发布步骤见 [环境说明](docs/ENVIRONMENTS.md)。

- `desktop/`：Electron 应用（`core/` 是抓取、存储、配置、更新逻辑）
- `relay/`：Cloudflare 中转、账号账本、管理工具与部署配置（全部随仓库迁移）
- `dev/`：本地隔离服务、三类验收身份、合成数据和预发部署入口
- `test/`：单元测试、HTTP 集成测试和实际页面验收
- `build/package-mac.sh`：打包 .app、更新 zip 和 `latest.json`

安装包和开发源码包不含真实密钥或本地数据库。更换电脑后，样例验收可直接运行；正式服务管理和真实 API 联调的凭据需要从自己的密码管理器恢复。
