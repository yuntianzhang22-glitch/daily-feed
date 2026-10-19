// 用 Electron 离屏渲染生成 1024x1024 应用图标：electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d9bf0"/><stop offset="1" stop-color="#0b4f8a"/>
    </linearGradient>
  </defs>
  <!-- macOS 图标网格：824 内容区，四周留白 100 -->
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <g fill="#fff">
    <rect x="250" y="300" width="524" height="96" rx="48" opacity="0.95"/>
    <rect x="250" y="464" width="420" height="96" rx="48" opacity="0.8"/>
    <rect x="250" y="628" width="300" height="96" rx="48" opacity="0.65"/>
  </g>
  <circle cx="724" cy="676" r="70" fill="#f5c518"/>
</svg></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, transparent: true, frame: false,
    useContentSize: true, webPreferences: { offscreen: true },
  });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = path.join(__dirname, 'icon.png');
  fs.writeFileSync(out, img.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log('icon written:', out, img.getSize());
  app.quit();
});
