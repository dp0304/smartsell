import { contextBridge, ipcRenderer } from 'electron';

// Phase 1 UI (index.html): one allowlisted call per action; main re-checks the sender frame.
const actions = new Set([
  'state', 'choose-role', 'pair', 'cancel-pairing', 'autostart', 'add-account', 'confirm-account', 'cancel-account', 'open-chrome',
  'check-login', 'relogin', 'open-job-chrome', 'stop', 'resume', 'update-install', 'open-web', 'open-url', 'open-logs', 'legacy-enable',
  'legacy-open', 'legacy-chrome-delete', 'forget', 'retry-vault', 'agent-hub', 'agent-connect', 'agent-cancel',
]);

contextBridge.exposeInMainWorld('smartsell', {
  call: (name: unknown, body?: unknown) => typeof name === 'string' && actions.has(name)
    ? ipcRenderer.invoke(`smartsell:${name}`, body ?? {}) : Promise.resolve({ error: '未知的操作。' }),
  onChange: (listener: unknown) => {
    if (typeof listener !== 'function') return;
    ipcRenderer.on('smartsell:changed', () => (listener as () => void)());
  },
});

// Legacy work lines (legacy.html, 「進階」): the previous connector API, unchanged.
contextBridge.exposeInMainWorld('connector', {
  state: () => ipcRenderer.invoke('connector:state'),
  checkStorage: () => ipcRenderer.invoke('connector:check-storage'),
  connectChrome: () => ipcRenderer.invoke('connector:connect-chrome'),
  setupChannels: (ids: unknown) => ipcRenderer.invoke('connector:setup-channels', ids),
  channelOpen: (id: unknown) => ipcRenderer.invoke('connector:channel-open', id),
  channelVerify: (id: unknown) => ipcRenderer.invoke('connector:channel-verify', id),
  channelScan: () => ipcRenderer.invoke('connector:channel-scan'),
  channelRegister: (body: unknown) => ipcRenderer.invoke('connector:channel-register', body),
  cancelAuthorization: () => ipcRenderer.invoke('connector:cancel-authorization'),
  catalogPortal: () => ipcRenderer.invoke('connector:catalog-portal'),
  catalogFile: () => ipcRenderer.invoke('connector:catalog-file'),
  uploadCatalog: (body: unknown) => ipcRenderer.invoke('connector:catalog-upload', body),
  pair: (body: unknown) => ipcRenderer.invoke('connector:pair', body),
  connect: () => ipcRenderer.invoke('connector:connect'),
  stop: () => ipcRenderer.invoke('connector:stop'),
  disconnect: () => ipcRenderer.invoke('connector:disconnect'),
  forget: () => ipcRenderer.invoke('connector:forget'),
  creator: () => ipcRenderer.invoke('connector:creator'),
  media: () => ipcRenderer.invoke('connector:media'),
  confirm: (body: unknown) => ipcRenderer.invoke('connector:confirm', body),
  finish: (body: unknown) => ipcRenderer.invoke('connector:finish', body),
  block: (body: unknown) => ipcRenderer.invoke('connector:block', body),
  report: () => ipcRenderer.invoke('connector:report'),
  workbench: () => ipcRenderer.invoke('connector:workbench'),
  updateCheck: () => ipcRenderer.invoke('connector:update-check'),
  updateInstall: () => ipcRenderer.invoke('connector:update-install'),
});
