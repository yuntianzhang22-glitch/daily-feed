#!/usr/bin/env bash
# 把已安装的 Electron 组装成 "Daily Feed.app"（macOS，本机 ad-hoc 签名），并生成更新包。
# 用法: npm run dist
# 产物:
#   dist/Daily Feed.app                    本机直接用
#   dist/Daily-Feed-<版本>-mac-<架构>.dmg   用户下载安装
#   dist/Daily-Feed-<版本>-mac-<架构>.zip   应用内更新包
#   dist/latest.json                       更新清单（url 需要指向上面 zip 的下载地址）
# 环境变量:
#   DAILY_FEED_DOWNLOAD_BASE  zip 的下载地址前缀，如 https://github.com/<用户>/<仓库>/releases/download/v0.2.0
#   DAILY_FEED_NOTES          写进更新清单的更新说明
set -euo pipefail

cd "$(dirname "$0")/.."
NAME="Daily Feed"
BUNDLE_ID="local.dailyfeed.app"
VERSION="$(node -p "require('./package.json').version")"
ARCH="$(node -p "process.arch")"
SRC_APP="node_modules/electron/dist/Electron.app"
OUT="dist/$NAME.app"
RES="$OUT/Contents/Resources"
PLIST="$OUT/Contents/Info.plist"
ZIP="dist/Daily-Feed-$VERSION-mac-$ARCH.zip"

[ -d "$SRC_APP" ] || { echo "找不到 $SRC_APP，请先 npm install"; exit 1; }
[ -f build/icon.png ] || { echo "找不到 build/icon.png，请先 npm run icon"; exit 1; }

# 保留旧安装包和更新清单，顶层只展示本次构建的版本。
node build/organize-dist.mjs --version "$VERSION"
rm -rf "$OUT" "$ZIP"
mkdir -p dist
ditto "$SRC_APP" "$OUT"

# 应用代码（Electron 会优先加载 Resources/app）。不打包测试和临时文件
rm -f "$RES/default_app.asar"
mkdir -p "$RES/app"
rsync -a --exclude '_*' --exclude '.DS_Store' desktop/ "$RES/app/desktop/"
node -e "
const p = require('./package.json');
const out = { name: p.name, productName: p.productName, version: p.version, main: p.main };
require('fs').writeFileSync(process.argv[1], JSON.stringify(out, null, 2));
" "$RES/app/package.json"

# 安装包里绝不能有 API Key
if grep -R -l -E "TWITTERAPI_KEY=|X-API-Key: [A-Za-z0-9]{20,}" "$RES/app" >/dev/null 2>&1; then
  echo "安装包里疑似包含 API Key，已中止"; exit 1
fi

# 图标
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/electron.icns"
rm -rf "$(dirname "$ICONSET")"

# Info.plist
pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST"; }
pb "Set :CFBundleName $NAME"
pb "Set :CFBundleDisplayName $NAME" 2>/dev/null || pb "Add :CFBundleDisplayName string $NAME"
pb "Set :CFBundleIdentifier $BUNDLE_ID"
pb "Set :CFBundleShortVersionString $VERSION"
pb "Set :CFBundleVersion $VERSION"
pb "Set :LSApplicationCategoryType public.app-category.news" 2>/dev/null \
  || pb "Add :LSApplicationCategoryType string public.app-category.news"

# 改了包内容后原签名失效，Apple Silicon 上必须重新签名才能运行
xattr -cr "$OUT"
codesign --force --deep --sign - "$OUT"
codesign --verify --deep --strict "$OUT"

# 更新包：ditto 保留符号链接和签名
ditto -c -k --sequesterRsrc --keepParent "$OUT" "$ZIP"
SHA="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
SIZE="$(stat -f%z "$ZIP")"
BASE="${DAILY_FEED_DOWNLOAD_BASE:-REPLACE_WITH_DOWNLOAD_BASE}"
node -e "
const [version, url, sha256, size, notes] = process.argv.slice(1);
const m = { version, notes, url, sha256, size: Number(size), released: new Date().toISOString() };
require('fs').writeFileSync('dist/latest.json', JSON.stringify(m, null, 2) + '\n');
" "$VERSION" "$BASE/$(basename "$ZIP")" "$SHA" "$SIZE" "${DAILY_FEED_NOTES:-}"

echo "完成: $OUT"
echo "更新包: $ZIP ($((SIZE / 1048576)) MB, sha256 $SHA)"
echo "更新清单: dist/latest.json"
bash build/package-dmg.sh
