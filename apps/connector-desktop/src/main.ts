import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, protocol, safeStorage, session, shell } from 'electron';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { DesktopConnector } from './controller.ts';
import { httpsOrigin, mediaExtensions } from './policy.ts';
import { catalogExtensions, readCatalogFile } from './catalog-file.ts';
import { serviceSettings, workbenchOrigin } from './service-settings.ts';
import { desktopUpdates, type UpdateConfig } from './updates.ts';
import { deviceVault } from './vault.ts';

const page = 'connector://desktop/index.html';
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'";
const assets = new Map([['/index.html', 'text/html; charset=utf-8'], ['/renderer.js', 'text/javascript; charset=utf-8'], ['/styles.css', 'text/css; charset=utf-8']]);
declare const RELEASE: { api?: string; workbench?: string; update?: UpdateConfig };

app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'connector', privileges: { standard: true, secure: true } }]);
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quit = false;

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

function show() { if (win?.isMinimized()) win.restore(); win?.show(); win?.focus(); }

async function run() {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'win32') { app.quit(); return; }
  const userData = app.getPath('userData');
  const defaultOrigin = httpsOrigin(RELEASE.api);
  const defaultWorkbench = workbenchOrigin(httpsOrigin(RELEASE.workbench));
  const settings = serviceSettings(join(userData, 'service-origin.txt'));
  const savedOrigin = settings.load();
  const updates = desktopUpdates(platform, app.isPackaged ? RELEASE.update : undefined);
  const controller = new DesktopConnector({
    origin: savedOrigin ?? defaultOrigin, saveOrigin: !defaultOrigin || savedOrigin ? settings.save : undefined,
    platform, version: app.getVersion(), vault: deviceVault(join(userData, 'pairing.enc'), safeStorage, platform),
    openExternal: url => shell.openExternal(url),
    async pickCatalog(signal) {
      const selection = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: '商品导出表', extensions: catalogExtensions }] });
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
      const selection = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: [{ name: '图片与视频', extensions: mediaExtensions }] });
      signal.throwIfAborted();
      if (selection.canceled) return;
      if (selection.filePaths.length > 20) throw new Error('一次最多选取 20 个媒体文件。');
      const media = [];
      for (const path of selection.filePaths) media.push(await hashMedia(path, signal));
      return media;
    },
  });

  const isolated = session.fromPartition('connector-ui');
  isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, done) => {
    const url = URL.parse(details.url);
    done({ cancel: !url || url.protocol !== 'connector:' || url.host !== 'desktop' || !assets.has(url.pathname) });
  });
  isolated.protocol.handle('connector', async request => {
    const url = new URL(request.url);
    const mime = assets.get(url.pathname);
    if (request.method !== 'GET' || url.host !== 'desktop' || url.username || url.password || url.search || !mime) return new Response(null, { status: 404 });
    const bytes = await readFile(join(__dirname, 'ui', url.pathname.slice(1)));
    return new Response(Uint8Array.from(bytes), { headers: { 'Content-Type': mime, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' } });
  });
  win = new BrowserWindow({
    title: 'SmartSell Connector', width: 840, height: 760, minWidth: 640, minHeight: 520, backgroundColor: '#f4f3ef', show: false,
    webPreferences: { session: isolated, preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false, devTools: false, spellcheck: false, navigateOnDragDrop: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-frame-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => controller.stop());
  win.on('close', event => { if (!quit) { event.preventDefault(); win?.hide(); } });
  function workbench(origin: string | undefined, serviceMatches: boolean) {
    if (!serviceMatches) return;
    return origin === defaultOrigin && defaultWorkbench ? defaultWorkbench : workbenchOrigin(origin);
  }
  function state() {
    const snapshot = controller.snapshot();
    return { ...snapshot, updates: updates.snapshot(), workbench: workbench(snapshot.origin, snapshot.serviceMatches) };
  }
  function register(name: string, action: (body: unknown) => unknown) {
    ipcMain.handle(`connector:${name}`, async (event, body) => {
      const frame = event.senderFrame;
      if (!win || event.sender !== win.webContents || !frame || frame.parent || frame.url !== page) return { error: '请求来源无效。' };
      try { await action(body); return { state: state() }; }
      catch (error) {
        const text = error instanceof Error && /[㐀-鿿]/.test(error.message) ? error.message : '操作失败。请检查输入、服务状态或任务租约。';
        return { error: text, state: state() };
      }
    });
  }
  register('state', () => {});
  register('set-origin', origin => controller.setOrigin(origin));
  register('catalog-claim', () => controller.claimCatalog());
  register('catalog-portal', () => controller.openCatalogPortal());
  register('catalog-file', () => controller.selectCatalogFile());
  register('catalog-upload', body => controller.uploadCatalog(body));
  register('pair', body => controller.pair(body));
  register('connect', () => controller.connect());
  register('stop', () => controller.stop());
  register('disconnect', () => controller.disconnect());
  register('forget', async () => {
    const { response } = await dialog.showMessageBox(win!, { type: 'warning', buttons: ['取消', '注销本机配对'], defaultId: 0, cancelId: 0,
      message: '删除本机配对密钥？', detail: '请先回填当前任务。服务端设备仍需在工作台撤销。' });
    if (response === 1) controller.forget();
  });
  register('claim', () => controller.claim());
  register('creator', () => controller.openCreator());
  register('session-creator', app => controller.openSessionCreator(app));
  register('verify-session', body => controller.verifySession(body));
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
  register('update-check', () => updates.check());
  register('update-install', () => {
    const { task, catalog, busy } = controller.snapshot();
    if (!busy && !task && (!catalog || catalog.expired) && updates.snapshot().ready) {
      controller.stop();
      updates.install();
    }
  });

  const icon = nativeImage.createFromBitmap(trayPixels(), { width: 18, height: 18 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('SmartSell Connector');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示连接器', click: show },
    { label: '紧急停止', click: () => { controller.stop(); show(); } },
    { label: '断开', click: () => { controller.disconnect(); show(); } },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', show);
  const heartbeat = setInterval(() => { void controller.tick(); }, 15_000);
  app.on('before-quit', () => { quit = true; clearInterval(heartbeat); controller.stop(); tray?.destroy(); tray = undefined; });
  app.on('activate', show);
  app.on('second-instance', show);
  await win.loadURL(page);
  show();
}

function trayPixels() {
  const pixels = Buffer.alloc(18 * 18 * 4);
  for (let y = 1; y < 17; y++) for (let x = 1; x < 17; x++) {
    const border = x === 1 || x === 16 || y === 1 || y === 16;
    const mark = (x >= 5 && x <= 12 && [5, 8, 12].includes(y)) || (x === 5 && y === 6) || (x === 12 && y >= 9 && y <= 11);
    if (border || mark) pixels.fill(255, (y * 18 + x) * 4, (y * 18 + x + 1) * 4);
  }
  return pixels;
}

if (!app.requestSingleInstanceLock()) app.quit();
else void app.whenReady().then(run).catch(() => {
  dialog.showErrorBox('SmartSell Connector', '无法启动连接器。请检查部署配置。');
  app.quit();
});
