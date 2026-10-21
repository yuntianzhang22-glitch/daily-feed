// 受信任的本机初始化入口。正式普通用户的页面/IPC 不提供升级为超管的操作。
// 凭据只从本地环境读取，不能作为命令行参数传递，不输出密钥。
const { app, net, safeStorage } = require('electron');
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
} else app.whenReady().then(async () => {
  try {
    const accountFile = path.join(__dirname, '..', '.local', 'owner-account.json');
    if (fs.existsSync(accountFile)) {
      const saved = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
      const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'app-config.json'), 'utf8'));
      if (saved.relayUrl !== config.relayUrl || !/^df_[A-Za-z0-9_-]{43,80}$/.test(saved.code || '')) throw new Error('超管账号凭证与正式环境不匹配');
      const r = await net.fetch(`${config.relayUrl}/v1/status`, { headers: { Authorization: `Bearer ${saved.code}` }, signal: AbortSignal.timeout(20000) });
      const status = await r.json();
      if (!r.ok || status.plan !== 'owner') throw new Error('服务端未确认超管身份，未修改本机登录');
      fs.writeFileSync(path.join(dataDir, 'access.json'), JSON.stringify({ code: saved.code, plan: 'owner', accountLogin: true }), { mode: 0o600 });
      fs.rmSync(path.join(dataDir, 'signed_out'), { force: true });
      console.log(`独立超管账号已登录（${status.account_no}）。新电脑安装新版应用后，输入同一登录账号即可，无需复制 API Key。`);
      app.exit(0);
      return;
    }
    const file = path.join(__dirname, '..', '.env.owner.local');
    const local = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
    const key = (process.env.DAILY_FEED_OWNER_API_KEY || local.DAILY_FEED_OWNER_API_KEY || '').trim();
    if (!key || key.startsWith('replace_')) throw new Error('请先在 .env.owner.local 填写 DAILY_FEED_OWNER_API_KEY');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'api_key.bin'), safeStorage.encryptString(key), { mode: 0o600 });
    fs.rmSync(path.join(dataDir, 'signed_out'), { force: true });
    console.log('超管凭据已在本机加密保存。重新打开正式应用即可使用。');
    app.exit(0);
  } catch (e) { console.error(e.message); app.exit(1); }
});
