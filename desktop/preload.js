// 只向页面暴露有限的接口，页面本身无法访问 Node。
const { contextBridge, ipcRenderer } = require('electron');

const backend = (method, params) => ipcRenderer.invoke('backend', method, params);

contextBridge.exposeInMainWorld('api', {
  labInfo: () => ipcRenderer.invoke('lab-info'),
  labProfile: (profile) => ipcRenderer.invoke('lab-profile', profile),
  labTopup: () => ipcRenderer.invoke('lab-topup'),
  list: (params) => backend('list', params),
  sources: () => backend('sources'),
  counts: () => backend('counts'),
  setFlag: (ids, field, value) => backend('set_flag', { ids, field, value }),
  markAllRead: (source) => backend('mark_all_read', { source }),
  getConfig: () => backend('get_config'),
  estimate: (cfg) => backend('estimate', cfg),
  usage: () => backend('usage'),
  roster: () => backend('roster'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  fetchNow: () => ipcRenderer.invoke('fetch-now'),
  accessInfo: () => ipcRenderer.invoke('access-info'),
  setAccessCode: (code) => ipcRenderer.invoke('set-access-code', code),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', key),
  status: () => ipcRenderer.invoke('status'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  revealData: () => ipcRenderer.invoke('reveal-data'),
  onEvent: (cb) => ipcRenderer.on('backend-event', (_e, msg) => cb(msg)),
});
