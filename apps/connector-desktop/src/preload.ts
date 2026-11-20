import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('connector', {
  state: () => ipcRenderer.invoke('connector:state'),
  pair: (body: unknown) => ipcRenderer.invoke('connector:pair', body),
  connect: () => ipcRenderer.invoke('connector:connect'),
  stop: () => ipcRenderer.invoke('connector:stop'),
  disconnect: () => ipcRenderer.invoke('connector:disconnect'),
  forget: () => ipcRenderer.invoke('connector:forget'),
  claim: () => ipcRenderer.invoke('connector:claim'),
  creator: () => ipcRenderer.invoke('connector:creator'),
  sessionCreator: (app: unknown) => ipcRenderer.invoke('connector:session-creator', app),
  verifySession: (body: unknown) => ipcRenderer.invoke('connector:verify-session', body),
  media: () => ipcRenderer.invoke('connector:media'),
  confirm: (body: unknown) => ipcRenderer.invoke('connector:confirm', body),
  finish: (body: unknown) => ipcRenderer.invoke('connector:finish', body),
  block: (body: unknown) => ipcRenderer.invoke('connector:block', body),
  report: () => ipcRenderer.invoke('connector:report'),
  workbench: () => ipcRenderer.invoke('connector:workbench'),
  updateCheck: () => ipcRenderer.invoke('connector:update-check'),
  updateInstall: () => ipcRenderer.invoke('connector:update-install'),
});
