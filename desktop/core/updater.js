// 应用内更新（不依赖 Apple 开发者证书）。
//
// 流程：读取更新清单 latest.json → 比较版本 → 下载 zip → 校验 SHA-256 →
//       ditto 解压到临时目录 → 检查包内版本号和 Bundle ID →
//       退出后由一个独立的小脚本把新版换到原位置，失败则还原旧版，最后重新打开。
//
// 由 app 自己下载的文件不会被加上 quarantine 标记，所以之后的更新不会再触发 Gatekeeper 提示。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const BUNDLE_ID = 'local.dailyfeed.app';

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

// 清单格式：{ version, notes, url, sha256, size, min_os? }
function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('更新清单格式错误');
  if (!parseVersion(m.version)) throw new Error('更新清单版本号无效');
  // 只允许 https；本机回环地址例外，仅用于本地测试更新流程
  if (!/^https:\/\//.test(m.url || '') && !/^http:\/\/127\.0\.0\.1:\d+\//.test(m.url || '')) {
    throw new Error('更新地址必须是 https');
  }
  if (!/^[0-9a-f]{64}$/.test(m.sha256 || '')) throw new Error('更新清单缺少校验值');
  return m;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败：${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

// app 所在的 .app 路径，如 /Applications/Daily Feed.app
function currentBundlePath(execPath = process.execPath) {
  const i = execPath.indexOf('.app/Contents/MacOS/');
  return i === -1 ? null : execPath.slice(0, i + 4);
}

class Updater {
  constructor({ manifestUrl, currentVersion, fetchImpl = fetch, workDir, onProgress = () => {}, bundleId = BUNDLE_ID, allowedDownloadOrigin }) {
    this.manifestUrl = manifestUrl;
    this.currentVersion = currentVersion;
    this.fetch = fetchImpl;
    this.workDir = workDir || path.join(os.tmpdir(), 'daily-feed-update');
    this.onProgress = onProgress;
    this.staged = null;
    this.bundleId = bundleId;
    this.allowedDownloadOrigin = allowedDownloadOrigin;
  }

  validateDownload(manifest) {
    validateManifest(manifest);
    if (this.allowedDownloadOrigin && new URL(manifest.url).origin !== this.allowedDownloadOrigin) {
      throw new Error('验收更新只能使用当前隔离环境的下载地址');
    }
    return manifest;
  }

  async check() {
    if (!this.manifestUrl) return { available: false, reason: '未配置更新地址' };
    const res = await this.fetch(this.manifestUrl, { signal: AbortSignal.timeout(15000), cache: 'no-store',
      ...(this.allowedDownloadOrigin ? { redirect: 'error' } : {}) });
    if (!res.ok) throw new Error(`检查更新失败（${res.status}）`);
    const m = this.validateDownload(await res.json());
    return {
      available: compareVersions(m.version, this.currentVersion) > 0,
      current: this.currentVersion,
      latest: m.version,
      notes: String(m.notes || '').slice(0, 2000),
      size: Number(m.size) || 0,
      manifest: m,
    };
  }

  // 下载并校验，成功后返回解压好的新 .app 路径
  async download(manifest) {
    this.validateDownload(manifest);
    fs.rmSync(this.workDir, { recursive: true, force: true });
    fs.mkdirSync(this.workDir, { recursive: true });
    const zipPath = path.join(this.workDir, 'update.zip');

    const res = await this.fetch(manifest.url, { signal: AbortSignal.timeout(10 * 60 * 1000),
      ...(this.allowedDownloadOrigin ? { redirect: 'error' } : {}) });
    if (!res.ok || !res.body) throw new Error(`下载失败（${res.status}）`);
    const total = Number(res.headers.get('content-length')) || Number(manifest.size) || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(zipPath);
    let received = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      this.onProgress({ received, total });
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

    const digest = hash.digest('hex');
    if (digest !== manifest.sha256) {
      fs.rmSync(this.workDir, { recursive: true, force: true });
      throw new Error('下载的文件校验失败，已丢弃');
    }

    const unpack = path.join(this.workDir, 'unpacked');
    await run('/usr/bin/ditto', ['-x', '-k', zipPath, unpack]);
    const appName = fs.readdirSync(unpack).find((n) => n.endsWith('.app'));
    if (!appName) throw new Error('更新包里没有找到应用');
    const newApp = path.join(unpack, appName);

    // 再确认一次包里的版本和 Bundle ID，防止装错包
    const plist = path.join(newApp, 'Contents', 'Info.plist');
    const info = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
    if (info.CFBundleIdentifier !== this.bundleId) throw new Error('更新包的应用标识不匹配');
    if (info.CFBundleShortVersionString !== manifest.version) throw new Error('更新包的版本号与清单不一致');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', newApp]);
    // 万一被打上了隔离标记也去掉，避免更新后被 Gatekeeper 拦下
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});

    fs.rmSync(zipPath, { force: true });
    this.staged = { newApp, version: manifest.version };
    return this.staged;
  }

  // 生成替换脚本并在 app 退出后执行；调用方随后应调用 app.quit()
  installAndRelaunch({ pid = process.pid, target = currentBundlePath() } = {}) {
    if (!this.staged) throw new Error('还没有下载更新');
    if (!target) throw new Error('无法确定当前应用位置（开发模式不支持自动更新）');
    const parent = path.dirname(target);
    try {
      fs.accessSync(parent, fs.constants.W_OK);
    } catch {
      throw new Error(`没有权限写入 ${parent}，请把应用拖到「应用程序」文件夹后再更新`);
    }
    const script = path.join(this.workDir, 'install.sh');
    const log = path.join(this.workDir, 'install.log');
    fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o700 });
    const child = spawn('/bin/bash', [script, String(pid), this.staged.newApp, target, log], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { script, log };
  }
}

// $1=旧进程 pid  $2=新 .app  $3=目标 .app  $4=日志
// 先把旧版改名备份，再移入新版；任何一步失败都还原旧版，保证至少有一个能用的版本。
const INSTALL_SCRIPT = `#!/bin/bash
set -u
PID="$1"; NEW="$2"; TARGET="$3"; LOG="$4"
exec >>"$LOG" 2>&1
echo "[$(date)] 等待进程 $PID 退出"
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then echo "旧进程未退出，放弃更新"; exit 1; fi
OLD="$TARGET.old-$$"
if ! mv "$TARGET" "$OLD"; then echo "无法移动旧版"; open "$TARGET"; exit 1; fi
if ditto "$NEW" "$TARGET" && /usr/bin/codesign --verify --deep --strict "$TARGET"; then
  rm -rf "$OLD"
  echo "更新完成"
else
  echo "安装新版失败，还原旧版"
  rm -rf "$TARGET"
  mv "$OLD" "$TARGET"
fi
rm -rf "$NEW"
open "$TARGET"
`;

module.exports = { Updater, compareVersions, parseVersion, validateManifest, currentBundlePath, INSTALL_SCRIPT, BUNDLE_ID };
