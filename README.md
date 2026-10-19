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

```bash
npm install
npm test
npm start
```

- `desktop/`：Electron 应用（`core/` 是抓取、存储、配置、更新逻辑）
- `build/package-mac.sh`：打包 .app、更新 zip 和 `latest.json`

安装包里没有任何密钥。
