#!/usr/bin/env bash
# 用户下载用 DMG；保留 ZIP 作为现有更新器的下载载荷。
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"
ARCH="$(node -p "process.arch")"
APP="dist/Daily Feed.app"
DMG="dist/Daily-Feed-$VERSION-mac-$ARCH.dmg"
[ -d "$APP" ] || { echo "请先生成正式 .app"; exit 1; }
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Daily Feed.app"
ln -s /Applications "$STAGE/Applications"
cp "$APP/Contents/Resources/electron.icns" "$STAGE/.VolumeIcon.icns"
if [ -x /usr/bin/SetFile ]; then /usr/bin/SetFile -a C "$STAGE"; fi
cat > "$STAGE/安装说明.txt" <<'TEXT'
Daily Feed

1. 将 Daily Feed 拖到旁边的 Applications（应用程序）文件夹。
2. 从「应用程序」打开 Daily Feed，输入账号编号登录。
3. 安装完成后，可推出此磁盘映像。

如果直接打开此磁盘中的 Daily Feed，应用会提示一键安装并重新打开。
替换旧版应用前请先退出；登录、关注、收藏和帖子记录保留。
TEXT
hdiutil create -volname "Daily Feed $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
hdiutil verify "$DMG"
echo "安装包: $DMG"
