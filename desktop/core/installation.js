// 使用 Electron 的 macOS 原生安装与重启流程；移动成功后不再从旧路径读取资源。
async function ensureInstalled({ app, dialog, packaged, platform = process.platform }) {
  if (platform !== 'darwin' || !packaged || app.isInApplicationsFolder()) return true;
  const { response } = await dialog.showMessageBox({
    type: 'question', title: '安装 Daily Feed', message: '将 Daily Feed 安装到「应用程序」？',
    detail: '安装后会自动重新打开，以便正常使用和接收更新。已有登录、关注和帖子都会保留。',
    buttons: ['安装并打开', '暂不安装'], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (response !== 0) return true;
  for (;;) {
    try {
      const moved = app.moveToApplicationsFolder({
        conflictHandler: (type) => {
          if (type === 'existsAndRunning') {
            dialog.showMessageBoxSync({
              type: 'info', title: 'Daily Feed 正在运行', message: '请先退出已安装的 Daily Feed',
              detail: '退出后重新打开安装包，即可继续安装。', buttons: ['取消安装'], defaultId: 0, cancelId: 0,
            });
            return false;
          }
          return type === 'exists' && dialog.showMessageBoxSync({
            type: 'question', title: '替换 Daily Feed', message: '「应用程序」中已有 Daily Feed，要替换吗？',
            detail: '只替换应用，已有登录、关注和帖子都会保留。',
            buttons: ['替换并打开', '取消'], defaultId: 1, cancelId: 1, noLink: true,
          }) === 0;
        },
      });
      // 成功时 Electron 负责退出并重新打开；取消系统授权时返回 false，可继续使用当前副本。
      return !moved;
    } catch {
      const retry = await dialog.showMessageBox({
        type: 'error', title: '安装未完成', message: '未能安装 Daily Feed',
        detail: '请检查可用空间及「应用程序」文件夹的写入权限。也可退出应用后手动拖入该文件夹。',
        buttons: ['重试', '暂不安装'], defaultId: 0, cancelId: 1, noLink: true,
      });
      if (retry.response !== 0) return true;
    }
  }
}

module.exports = { ensureInstalled };
