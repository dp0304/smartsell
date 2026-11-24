// 舊工作線 (§8.17 「進階」, off by default): 抖音、小紅書人工交接、知乎、商品匯入.
// The previous connector UI and controller, unchanged, in their own window
// (`legacy.html`). They are only constructed when the owner enables them, so a
// fresh Worker never runs the v1 heartbeat or opens the shared legacy Chrome.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type * as Electron from 'electron';
import { DesktopConnector } from '../controller.ts';
import { httpsOrigin, mediaExtensions } from '../policy.ts';
import { catalogExtensions, readCatalogFile } from '../catalog-file.ts';
import { serviceSettings, setupChannelSettings, workbenchOrigin } from '../service-settings.ts';
import type { Vault } from '../vault.ts';
import { ChromeBrowser } from '../chrome.ts';
import { channelRows } from '../channels.ts';
import { ChannelSessions } from '../channel-sessions.ts';

export const LEGACY_PAGE = 'connector://desktop/legacy.html';

async function hashMedia(path: string, signal: AbortSignal) {
  if (!mediaExtensions.includes(extname(path).slice(1).toLowerCase())) throw new Error('请选择受支持的图片或视频。');
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 512 * 1024 * 1024) throw new Error('请选择 512 MiB 以内的普通媒体文件。');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(256 * 1024);
    for (let offset = 0; offset < info.size;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
      if (!bytesRead) throw new Error('文件在读取期间发生变化。');
      offset += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('文件在读取期间发生变化。');
    return { name: basename(path), hash: hash.digest('hex') };
  } finally { await file.close(); }
}

export interface LegacyContext {
  electron: Pick<typeof Electron, 'BrowserWindow' | 'dialog' | 'ipcMain' | 'shell'>;
  userData: string;
  platform: 'darwin' | 'win32';
  version: string;
  vault: Vault;
  apiOrigin?: string;
  workbenchOrigin?: string;
  createWindow(page: string, options: { title: string; width: number; height: number }): Electron.BrowserWindow;
}

export function startLegacy(ctx: LegacyContext) {
  const { BrowserWindow, dialog, ipcMain, shell } = ctx.electron;
  const defaultOrigin = httpsOrigin(ctx.apiOrigin);
  const defaultWorkbench = workbenchOrigin(httpsOrigin(ctx.workbenchOrigin));
  const settings = serviceSettings(join(ctx.userData, 'service-origin.txt'));
  const setupSettings = setupChannelSettings(join(ctx.userData, 'setup-channels.json'));
  let setupChannels = setupSettings.load();
  const chrome = new ChromeBrowser(join(ctx.userData, 'platform-chrome'));
  const channels = new ChannelSessions(chrome);
  let win: Electron.BrowserWindow | undefined;
  const parent = () => win ?? BrowserWindow.getFocusedWindow() ?? undefined;
  const controller = new DesktopConnector({
    origin: settings.load() ?? defaultOrigin, saveOrigin: settings.save, channels,
    openAuthorization: url => shell.openExternal(url),
    platform: ctx.platform, version: ctx.version, vault: ctx.vault, zhihu: chrome.zhihu,
    openPlatform: (id, url, signal) => channels.openTask(id, url, signal),
    async pickCatalog(signal) {
      const selection = await dialog.showOpenDialog(parent()!, { properties: ['openFile'], filters: [{ name: '商品导出表', extensions: catalogExtensions }] });
      signal.throwIfAborted();
      if (!selection.canceled && selection.filePaths.length === 1) {
        try { return await readCatalogFile(selection.filePaths[0], signal); }
        catch (error) {
          signal.throwIfAborted();
          if (error instanceof Error && 'code' in error) throw new Error('无法读取选中的商品导出表。请检查文件权限后重试。');
          throw error;
        }
      }
    },
    async pickMedia(signal) {
      const selection = await dialog.showOpenDialog(parent()!, { properties: ['openFile', 'multiSelections'], filters: [{ name: '图片与视频', extensions: mediaExtensions }] });
      signal.throwIfAborted();
      if (selection.canceled) return;
      if (selection.filePaths.length > 20) throw new Error('一次最多选取 20 个媒体文件。');
      const media = [];
      for (const path of selection.filePaths) media.push(await hashMedia(path, signal));
      return media;
    },
  });
  function stop() { channels.suspend(); controller.stop(); }
  function disconnect() { channels.suspend(); controller.disconnect(); }
  function workbench(origin: string | undefined, serviceMatches: boolean) {
    if (!serviceMatches) return;
    return origin === defaultOrigin && defaultWorkbench ? defaultWorkbench : workbenchOrigin(origin);
  }
  function state() {
    const snapshot = controller.snapshot();
    return { ...snapshot, updates: { enabled: false, status: '更新由「SmartSell Worker 可更新」提示處理', busy: false, ready: false },
      workbench: workbench(snapshot.origin, snapshot.serviceMatches), chromeSetup: channels.chromeSetup(), setupChannels, channelRows, channelStates: channels.snapshot() };
  }
  const channelsRegistered: string[] = [];
  function register(name: string, action: (body: unknown) => unknown) {
    const channel = `connector:${name}`;
    channelsRegistered.push(channel);
    ipcMain.handle(channel, async (event, body) => {
      const frame = event.senderFrame;
      if (!win || event.sender !== win.webContents || !frame || frame.parent || frame.url !== LEGACY_PAGE) return { error: '请求来源无效。' };
      try { await action(body); return { state: state() }; }
      catch (error) {
        const text = error instanceof Error && /[㐀-鿿]/.test(error.message) ? error.message : '操作失败。请检查输入、服务状态或任务租约。';
        return { error: text, state: state() };
      }
    });
  }
  register('state', () => {});
  register('check-storage', () => controller.checkStorage());
  register('connect-chrome', () => controller.connectChrome());
  register('setup-channels', body => { setupChannels = setupSettings.save(body); });
  register('channel-open', id => channels.open(id));
  register('channel-verify', id => channels.verify(id));
  register('channel-scan', () => controller.scanChannels());
  register('channel-register', body => controller.registerChannels(body));
  register('cancel-authorization', () => controller.cancelAuthorization());
  register('catalog-portal', () => controller.openCatalogPortal());
  register('catalog-file', () => controller.selectCatalogFile());
  register('catalog-upload', body => controller.uploadCatalog(body));
  register('pair', body => controller.pairWorkbench(body));
  register('connect', () => controller.connect());
  register('stop', stop);
  register('disconnect', disconnect);
  register('forget', async () => {
    const { response } = await dialog.showMessageBox(parent()!, { type: 'warning', buttons: ['取消', '注销本机配对'], defaultId: 0, cancelId: 0,
      message: '删除本机配对密钥？', detail: '这也会停止新版 Worker 的连线。请先回填当前任务。服务端设备仍需在工作台撤销。' });
    if (response === 1) { channels.suspend(); controller.forget(); }
  });
  register('creator', () => controller.openCreator());
  register('media', () => controller.selectMedia());
  register('confirm', body => controller.confirm(body));
  register('finish', body => controller.finish(body));
  register('block', body => controller.block(body));
  register('report', () => controller.retryReport());
  register('workbench', () => {
    const { origin, serviceMatches } = controller.snapshot();
    const url = workbench(origin, serviceMatches);
    if (url) return shell.openExternal(url);
  });
  register('update-check', () => {});
  register('update-install', () => {});
  const heartbeat = setInterval(() => { void controller.tick(); }, 15_000);
  const channelWatch = setInterval(() => { void channels.poll(); }, 3000);
  return {
    show() {
      if (!win || win.isDestroyed()) {
        win = ctx.createWindow(LEGACY_PAGE, { title: 'SmartSell 舊工作線', width: 840, height: 760 });
        win.webContents.on('render-process-gone', stop);
      }
      win.show();
      win.focus();
    },
    emergencyStop: stop,
    close() {
      clearInterval(heartbeat);
      clearInterval(channelWatch);
      stop();
      chrome.close();
      for (const channel of channelsRegistered) ipcMain.removeHandler(channel);
      if (win && !win.isDestroyed()) win.destroy();
      win = undefined;
    },
  };
}
