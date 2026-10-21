// 受信任的本机初始化入口。正式普通用户的页面/IPC 不提供升级为超管的操作。
// 凭据只从本地环境读取，不能作为命令行参数传递，不输出密钥。
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

app.setName('Daily Feed');
const dataDir = path.join(app.getPath('appData'), 'Daily Feed');
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
if (!app.requestSingleInstanceLock()) {
  console.error('请先退出正式 Daily Feed，再初始化超管凭据。');
  app.exit(1);
} else app.whenReady().then(() => {
  try {
    const file = path.join(__dirname, '..', '.env.owner.local');
    const local = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
    const key = (process.env.DAILY_FEED_OWNER_API_KEY || local.DAILY_FEED_OWNER_API_KEY || '').trim();
    if (!key || key.startsWith('replace_')) throw new Error('请先在 .env.owner.local 填写 DAILY_FEED_OWNER_API_KEY');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'api_key.bin'), safeStorage.encryptString(key), { mode: 0o600 });
    console.log('超管凭据已在本机加密保存。重新打开正式应用即可使用。');
    app.exit(0);
  } catch (e) { console.error(e.message); app.exit(1); }
});
