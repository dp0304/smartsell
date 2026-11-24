// Mode dispatch and the resident App (§8.1 main.ts, §8.2, §8.17, §6.2):
//   --mcp-relay   stdio MCP relay for Codex / Claude Code: no lock, no window, no tray, Dock hidden.
//   --smoke       start-up self check of a built App; touches no keychain and no login item, then exits.
//   (default)     resident App with a single-instance lock and a tray: Worker mode (pairs, runs jobs) or
//                 the laptop Agent mode (alerts + upload hand-off), chosen on first run.
// Electron is injected (`typeof import('electron')`), so the relay and smoke paths are tested with fakes.
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, release, tmpdir, uptime } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type * as Electron from 'electron';
import { AUTOMATION_NOTICE_VERSION, RISK_TERMS_VERSION } from '@smartsell/contracts';
import { handoffSocketPath, relayMain as defaultRelayMain, type RelayMainOptions } from '@smartsell/agent-relay';
import { deviceSignatureHeaders } from '../../../connector/src/device-client.ts';
import { isPackagedBuild, testModeEnabled } from '../chrome.ts';
import { defaultSelectors } from '../drivers/selectors.ts';
import { heartbeatArch } from '../runtime/supervisor.ts';
import { createWorkerRuntime } from '../runtime/worker.ts';
import { appSettings, type AppRole } from '../service-settings.ts';
import { deviceVault } from '../vault.ts';
import { AgentShell } from './agent-mode.ts';
import { Autostart } from './autostart.ts';
import { startLegacy } from './legacy.ts';
import { createLog } from './log.ts';
import { Notifier } from './notify.ts';
import { nodeRun, PostureMonitor } from './posture.ts';
import { PowerGuard } from './power.ts';
import { isRelayMode, relayDataDir, runRelayMode } from './relay-mode.ts';
import { trayModel, trayPixels } from './tray.ts';
import { UpdateManager } from './update.ts';
import { sanitizeMachineName, WorkerShell } from './worker-mode.ts';

export const PRODUCT_NAME = 'SmartSell Worker';
export const APP_ID = 'com.smartsell.worker';
export const MAIN_PAGE = 'connector://desktop/index.html';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'";
export const UI_ASSETS = new Map([
  ['/index.html', 'text/html; charset=utf-8'], ['/renderer.js', 'text/javascript; charset=utf-8'], ['/styles.css', 'text/css; charset=utf-8'],
  ['/legacy.html', 'text/html; charset=utf-8'], ['/legacy.js', 'text/javascript; charset=utf-8'], ['/legacy.css', 'text/css; charset=utf-8'],
]);

export interface ReleaseConfig { api?: string; workbench?: string; packaged?: boolean }

export interface ShellArgs { relay: boolean; background: boolean; smoke: boolean; smokeOut: string | null; userData: string | null }

/** Flags of the App executable. `--smartsell-user-data=<dir>` isolates a smoke run from the real profile. */
export function parseShellArgs(argv: readonly string[]): ShellArgs {
  const value = (name: string) => {
    const inline = argv.find(arg => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : null;
  };
  return {
    relay: isRelayMode(argv), background: argv.includes('--background'), smoke: argv.includes('--smoke'),
    smokeOut: value('--smoke-out'), userData: value('--smartsell-user-data'),
  };
}

export function workerPlatform(platform: NodeJS.Platform, arch: string): 'mac-arm64' | 'mac-x64' | 'win-x64' | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : null;
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

/** Packaged: `<Resources>/resources/test-clip.mp4`; development: `apps/connector-desktop/resources/`. */
export function resourcePaths(appDir: string, packaged: boolean, resourcesPath?: string) {
  const resources = packaged && resourcesPath ? join(resourcesPath, 'resources') : join(appDir, '..', 'resources');
  const relay = packaged && resourcesPath ? join(resourcesPath, 'agent-relay', 'smartsell-relay.mjs') : join(appDir, 'agent-relay', 'smartsell-relay.mjs');
  return { clip: join(resources, 'test-clip.mp4'), clipManifest: join(resources, 'test-clip.json'), relay };
}

/** Finds `codex` / `claude` the way a login shell would (GUI apps get a short PATH on macOS). */
export async function which(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()) {
  const extra = platform === 'win32' ? [join(home, 'AppData', 'Roaming', 'npm')]
    : ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.claude', 'local'), join(home, '.bun', 'bin')];
  const names = platform === 'win32' ? [`${command}.cmd`, `${command}.exe`, command] : [command];
  for (const dir of [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...extra]) {
    for (const name of names) {
      const path = join(dir, name);
      try { accessSync(path, constants.X_OK); return path; } catch { /* next */ }
    }
  }
  return null;
}

export interface BootstrapOptions {
  release: ReleaseConfig;
  argv: readonly string[];
  /** Directory of the bundled main.cjs (dist/). */
  appDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  stdio?: { stdin: Readable; stdout: Writable; stderr: Writable };
  relayMain?: (options: RelayMainOptions) => Promise<number>;
}

export type BootstrapResult = 'relay' | 'smoke' | 'second_instance' | 'resident' | 'unsupported';

export async function bootstrap(electron: typeof Electron, options: BootstrapOptions): Promise<BootstrapResult> {
  const { app } = electron;
  const args = parseShellArgs(options.argv);
  const platform = options.platform ?? process.platform;
  const stdio = options.stdio ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
  if (args.relay) {
    // §6.2: one relay per Codex session; never the single-instance lock, never a window or tray.
    await runRelayMode(app, { argv: options.argv, ...stdio, platform }, options.relayMain ?? defaultRelayMain);
    return 'relay';
  }
  if (args.userData) app.setPath('userData', args.userData);
  if (args.smoke) {
    const report = await runSmoke(electron, options);
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (args.smokeOut) writeFileSync(args.smokeOut, text);
    stdio.stdout.write(text);
    app.exit(report.ok ? 0 : 1);
    return 'smoke';
  }
  if (platform !== 'darwin' && platform !== 'win32') { app.quit(); return 'unsupported'; }
  app.enableSandbox();
  electron.protocol.registerSchemesAsPrivileged([{ scheme: 'connector', privileges: { standard: true, secure: true } }]);
  if (!app.requestSingleInstanceLock()) { app.quit(); return 'second_instance'; }
  if (platform === 'win32') app.setAppUserModelId(APP_ID);
  await app.whenReady();
  await runResident(electron, options, args, platform);
  return 'resident';
}

// ---------- --smoke ----------

export interface SmokeReport {
  ok: boolean; product: string; version: string; packaged_build: boolean; electron_packaged: boolean; platform: string; arch: string;
  checks: { name: string; ok: boolean; detail: string }[];
}

/** Start-up checks of a built App (§8.18 acceptance). Never reads the keychain, never sets a login item, never connects. */
export async function runSmoke(electron: typeof Electron, options: BootstrapOptions): Promise<SmokeReport> {
  const { app } = electron;
  const checks: SmokeReport['checks'] = [];
  const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); };
  const packaged = app.isPackaged;
  check('product_name', app.getName() === PRODUCT_NAME, app.getName());
  check('release_define', !packaged || isPackagedBuild(), `RELEASE.packaged=${isPackagedBuild()}`);
  check('test_switches_refused', !isPackagedBuild() || !testModeEnabled({ SMARTSELL_TEST_MODE: '1' }), 'SMARTSELL_TEST_MODE=1 is ignored in installer builds');
  const missing = [...UI_ASSETS.keys()].filter(path => !existsSync(join(options.appDir, 'ui', path.slice(1))));
  check('ui_assets', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${UI_ASSETS.size} files`);
  const paths = resourcePaths(options.appDir, packaged, process.resourcesPath);
  try {
    const manifest = JSON.parse(readFileSync(paths.clipManifest, 'utf8')) as { sha256: string; bytes: number };
    const bytes = readFileSync(paths.clip);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    check('test_clip', sha256 === manifest.sha256 && bytes.length === manifest.bytes, `${bytes.length} bytes, sha256 ${sha256.slice(0, 12)}…`);
  } catch (error) { check('test_clip', false, String(error)); }
  check('relay_bundle', existsSync(paths.relay), paths.relay);
  check('relay_module', typeof defaultRelayMain === 'function', 'relayMain linked');
  check('contracts', AUTOMATION_NOTICE_VERSION.length > 0 && RISK_TERMS_VERSION.length > 0, `${AUTOMATION_NOTICE_VERSION}, ${RISK_TERMS_VERSION}`);
  try { check('driver_selectors', true, `bundled selectors.json ${defaultSelectors().version}`); }
  catch (error) { check('driver_selectors', false, String(error)); }
  check('heartbeat_arch', !!heartbeatArch(process.arch), `heartbeat v2 arch=${heartbeatArch(process.arch) ?? 'omitted'} (E9)`);
  const scratch = mkdtempSync(join(tmpdir(), 'smartsell-smoke-'));
  try {
    const { privateKey } = generateKeyPairSync('ed25519');
    const runtime = createWorkerRuntime({
      dataDir: scratch, identity: { origin: 'https://hub.invalid', workspaceId: 'smoke-workspace', deviceId: 'smoke-device', privateKey, machineName: 'smoke' },
      clientVersion: app.getVersion(), bundledClip: paths.clip, env: {},
    });
    check('worker_runtime', typeof runtime.start === 'function' && existsSync(join(scratch, 'chrome-profiles')), 'composed, not started');
  } catch (error) { check('worker_runtime', false, String(error)); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
  check('login_item', true, 'not touched in --smoke');
  check('single_instance_lock', true, 'not requested in --smoke');
  return { ok: checks.every(item => item.ok), product: app.getName(), version: app.getVersion(), packaged_build: isPackagedBuild(),
    electron_packaged: packaged, platform: process.platform, arch: process.arch, checks };
}

// ---------- resident App ----------

function windowFactory(electron: typeof Electron, appDir: string) {
  const { BrowserWindow, session } = electron;
  const isolated = session.fromPartition('connector-ui');
  isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, done) => {
    const url = URL.parse(details.url);
    done({ cancel: !url || url.protocol !== 'connector:' || url.host !== 'desktop' || !UI_ASSETS.has(url.pathname) });
  });
  isolated.protocol.handle('connector', async request => {
    const url = new URL(request.url);
    const mime = UI_ASSETS.get(url.pathname);
    if (request.method !== 'GET' || url.host !== 'desktop' || url.username || url.password || url.search || !mime) return new Response(null, { status: 404 });
    const bytes = readFileSync(join(appDir, 'ui', url.pathname.slice(1)));
    return new Response(Uint8Array.from(bytes), { headers: { 'Content-Type': mime, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' } });
  });
  return (page: string, { title, width, height }: { title: string; width: number; height: number }) => {
    const win = new BrowserWindow({
      title, width, height, minWidth: 560, minHeight: 480, backgroundColor: '#f4f3ef', show: false,
      webPreferences: { session: isolated, preload: join(appDir, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, webviewTag: false, devTools: false, spellcheck: false, navigateOnDragDrop: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-frame-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    void win.loadURL(page);
    return win;
  };
}

async function runResident(electron: typeof Electron, options: BootstrapOptions, args: ShellArgs, platform: 'darwin' | 'win32') {
  const { app, Menu, Tray, dialog, ipcMain, nativeImage, safeStorage, shell, Notification, powerSaveBlocker, powerMonitor } = electron;
  const env = options.env ?? process.env;
  const userData = app.getPath('userData');
  const log = createLog(join(userData, 'logs'), { stderr: !app.isPackaged });
  const version = app.getVersion();
  const settings = appSettings(join(userData, 'settings.json'));
  const notifier = new Notifier({ create: opts => new Notification(opts), supported: () => Notification.isSupported(), open: url => void shell.openExternal(url), log: log.write });
  const power = new PowerGuard(powerSaveBlocker, log.write);
  const autostart = new Autostart(app, { platform, osRelease: release(), execPath: process.execPath, env, log: log.write });
  const vault = deviceVault(join(userData, 'pairing.enc'), safeStorage, platform);
  const posture = new PostureMonitor({ platform, onBattery: () => powerMonitor.isOnBatteryPower(), log: log.write });
  powerMonitor.on('resume', () => { void posture.refresh(); });
  const paths = resourcePaths(options.appDir, app.isPackaged, process.resourcesPath);
  const bundledClip = existsSync(paths.clip) ? paths.clip : null;
  const createWindow = windowFactory(electron, options.appDir);
  const host = sanitizeMachineName(hostname(), 'SmartSell Worker');
  let quitting = false;
  let worker: WorkerShell | undefined;
  let agent: AgentShell | undefined;
  let legacy: ReturnType<typeof startLegacy> | undefined;
  let tray: Electron.Tray | undefined;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;

  const win = createWindow(MAIN_PAGE, { title: PRODUCT_NAME, width: 900, height: 780 });
  win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
  const show = () => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); };

  function onChange() {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      if (!win.isDestroyed()) win.webContents.send('smartsell:changed');
      renderTray();
    }, 150);
  }

  async function openInstaller(path: string) {
    if (path.endsWith('.exe')) {
      spawn(path, [], { detached: true, stdio: 'ignore' }).unref();
    } else if (path.endsWith('.dmg')) {
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
      await dialog.showMessageBox({ type: 'info', buttons: ['好，結束 SmartSell Worker'], message: '請把視窗中的 SmartSell Worker 拖到「應用程式」，取代舊版。',
        detail: '完成後重新開啟 SmartSell Worker。更新後請留在這台機器前，出現鑰匙圈提示時按「永遠允許」；否則 Worker 無法連線。若 macOS 說無法打開，請在「應用程式」對它按右鍵 →「打開」。' });
    } else {
      shell.showItemInFolder(path);
      await dialog.showMessageBox({ type: 'info', buttons: ['好'], message: '已下載新版 SmartSell Worker。', detail: '請解壓縮後取代「應用程式」中的舊版，再重新開啟。' });
    }
    await worker?.stop();
    quitting = true;
    app.quit();
  }

  function startWorker() {
    if (worker) return worker;
    worker = new WorkerShell({
      userData, platform, version, hostname: host, vault, notifier, power, posture, autostart, settings, bundledClip,
      openExternal: url => shell.openExternal(url), onChange, log: log.write,
      updates: (pairing, runtime) => new UpdateManager({
        currentVersion: version, platform, hubOrigin: pairing.origin, dir: join(userData, 'updates'), notifier, onChange, log: log.write,
        platformKey: workerPlatform(platform, process.arch),
        jobs: () => runtime.runner.views(), now: () => runtime.clock.now(), openInstaller,
        download: (url, signal, offered) => {
          const segment = url.pathname.split('/').pop() ?? '';
          const target = offered ?? (['mac-arm64', 'mac-x64', 'win-x64'].includes(segment) ? segment : workerPlatform(platform, process.arch) ?? segment);
          const headers = deviceSignatureHeaders(pairing.key, pairing.workspace, pairing.device, `worker_download.read:${target}`, new Uint8Array(), runtime.clock.now());
          return fetch(url, { headers, redirect: 'error', cache: 'no-store', signal });
        },
      }),
    });
    worker.start();
    return worker;
  }

  function startAgent() {
    if (agent) return agent;
    agent = new AgentShell({
      userData, platform, hostname: host, execPath: process.execPath, homeDir: homedir(), notifier, settings, onChange, log: log.write,
      socketPath: handoffSocketPath(relayDataDir(userData), platform), hold: (reason, on) => power.hold(reason, on),
      openExternal: url => shell.openExternal(url), which: command => which(command, env, platform),
      run: (file, argv) => nodeRun(file, argv), bundledRelayScript: existsSync(paths.relay) ? paths.relay : null,
    });
    void agent.start();
    return agent;
  }

  function startRole(role: AppRole) {
    if (role === 'worker') startWorker(); else startAgent();
  }

  function openLegacy() {
    if (!settings.load().legacy_lines) throw new Error('請先在「進階」開啟舊工作線。');
    legacy ??= startLegacy({ electron, userData, platform, version, vault, apiOrigin: options.release.api, workbenchOrigin: options.release.workbench, createWindow });
    legacy.show();
  }

  function state() {
    const current = settings.load();
    return {
      product: PRODUCT_NAME, version, platform, default_machine_name: host, settings: current,
      worker: worker?.snapshot() ?? null, agent: agent?.snapshot() ?? null, notifications: notifier.history(),
      power: { blocking_sleep: power.active(), reasons: power.reasons() }, now: new Date().toISOString(),
    };
  }

  const handlers: Record<string, (body: Record<string, unknown>) => unknown> = {
    state: () => undefined,
    'choose-role': body => {
      const role = body.role === 'worker' || body.role === 'agent' ? body.role : null;
      if (!role) throw new Error('請選擇這台機器的用途。');
      const current = settings.load().role;
      if (current && current !== role && (worker?.phase === 'running' || agent)) throw new Error('要改變用途，請先在「進階」登出本機配對並重新開啟 App。');
      settings.save({ role });
      if (role === 'agent' && settings.load().autostart !== false) { autostart.set(true); settings.save({ autostart: true }); }
      startRole(role);
    },
    pair: body => startWorker().pair({ hub: body.hub, name: body.name, workspace: body.workspace, code: body.code, owns: body.owns }),
    'cancel-pairing': () => worker?.cancelPairing(),
    autostart: body => { const enabled = body.enabled === true; autostart.set(enabled); settings.save({ autostart: enabled }); },
    'add-account': body => startWorker().addAccount(body.provider),
    'confirm-account': () => startWorker().confirmAccount(),
    'cancel-account': () => worker?.cancelAccount(),
    'open-chrome': body => startWorker().openChrome(body.id),
    'check-login': body => startWorker().checkLogin(body.id),
    relogin: body => startWorker().reLogin(body.id),
    'open-job-chrome': body => startWorker().openJobChrome(body.id),
    stop: () => { startWorker().emergencyStop(); legacy?.emergencyStop(); },
    resume: () => startWorker().resume(),
    'update-install': body => worker?.updates?.install({ confirmDueSoon: body.confirm === true }),
    'open-web': body => {
      const snapshot = worker?.snapshot();
      const target = body.target === 'channel' ? snapshot?.channels.find(item => item.social_account_id === body.id)?.web_url
        : body.target === 'machine' ? snapshot?.machine_url : snapshot?.hub_origin ?? agent?.snapshot().hub_origin;
      if (target) return shell.openExternal(target);
    },
    'open-url': body => {
      const known = [...notifier.history().map(item => item.url), ...(agent?.snapshot().alerts ?? []).map(alert => alert.web_url)];
      if (typeof body.url === 'string' && known.includes(body.url)) return shell.openExternal(body.url);
    },
    'open-logs': () => shell.openPath(log.dir),
    'legacy-enable': body => { settings.save({ legacy_lines: body.enabled === true }); if (body.enabled !== true) { legacy?.close(); legacy = undefined; } },
    'legacy-open': () => openLegacy(),
    'legacy-chrome-delete': async () => {
      const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['取消', '刪除'], defaultId: 0, cancelId: 0,
        message: '刪除舊版共用的 Chrome 資料（platform-chrome）？', detail: '新版每個帳號都有自己的 Chrome 資料夾，不受影響。舊版的登入狀態會消失。' });
      if (response === 1) worker?.deleteLegacyChrome();
    },
    forget: async () => {
      const { response } = await dialog.showMessageBox(win, { type: 'warning', buttons: ['取消', '登出本機配對'], defaultId: 0, cancelId: 0,
        message: '刪除這台機器的配對金鑰？', detail: '這台機器會停止連線與發文；中樞上的機器紀錄要到網頁的機器頁撤銷。' });
      if (response === 1) await worker?.forget();
    },
    'retry-vault': () => worker?.retryVault(),
    'agent-hub': body => startAgent().setHub(String(body.hub ?? '')),
    'agent-connect': body => startAgent().connect(body.client),
    'agent-cancel': () => agent?.cancelConnect(),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`smartsell:${name}`, async (event, body) => {
      const frame = event.senderFrame;
      if (event.sender !== win.webContents || !frame || frame.parent || frame.url !== MAIN_PAGE) return { error: '請求來源無效。' };
      try {
        const result = await handler(body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {});
        return { result: result ?? null, state: state() };
      } catch (error) {
        const message = error instanceof Error && /[㐀-鿿]/.test(error.message) ? error.message : '操作失敗，請重試。';
        log.write('ui action failed', { action: name, error: error instanceof Error ? error.message : String(error) });
        return { error: message, state: state() };
      }
    });
  }

  function renderTray() {
    const current = settings.load();
    const snap = worker?.snapshot();
    const agentSnap = agent?.snapshot();
    const connection = current.role === 'agent'
      ? (!agentSnap?.connected_client ? 'agent_unconnected' : agentSnap.alerts_state === 'open' ? 'agent_open' : agentSnap.alerts_state === 'unauthorized' ? 'agent_unauthorized' : 'agent_offline')
      : !snap || snap.phase === 'unpaired' || snap.phase === 'pairing' ? 'unpaired' : snap.phase === 'vault_locked' ? 'vault_locked' : snap.connection as never;
    const model = trayModel({
      role: current.role, machineName: snap?.machine_name ?? null, connection, nextRetryAt: snap?.next_retry_at ?? null,
      jobs: snap?.jobs.length ?? 0, needsOwner: snap?.jobs.filter(job => job.needs_owner).length ?? 0, emergencyStop: snap?.emergency_stop ?? false,
      updateVersion: snap?.update?.available?.version ?? null, uploads: agentSnap?.uploads.filter(item => item.status === 'uploading').length ?? 0, now: Date.now(),
    });
    const glyph = trayPixels(model.tone, model.badge);
    const image = nativeImage.createFromBitmap(glyph.pixels, { width: 18, height: 18 });
    image.setTemplateImage(glyph.template);
    tray ??= new Tray(image);
    tray.setImage(image);
    tray.setToolTip(model.tooltip);
    const actions: Record<string, () => void> = {
      show, quit: () => { quitting = true; app.quit(); },
      stop: () => { worker?.emergencyStop(); legacy?.emergencyStop(); show(); },
      resume: () => worker?.resume(), update: show,
    };
    tray.setContextMenu(Menu.buildFromTemplate(model.items.map(item => item.separator ? { type: 'separator' as const }
      : { label: item.label, enabled: item.enabled, click: actions[item.id] })));
  }

  renderTray();
  tray?.on('click', show);
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('window-all-closed', () => { /* resident: keep running in the tray */ });
  app.on('before-quit', () => {
    quitting = true;
    void worker?.stop();
    void agent?.stop();
    legacy?.close();
    posture.stop();
    power.release();
    tray?.destroy();
    tray = undefined;
  });
  const role = settings.load().role;
  if (role) startRole(role);
  const background = autostart.startedInBackground(args.background ? [...options.argv, '--background'] : options.argv, uptime());
  log.write('started', { version, role, background, packaged: app.isPackaged });
  if (!background || !role) win.once('ready-to-show', show);
  setInterval(renderTray, 15_000).unref();
}

