// Login item / auto-start (§8.2). After the first successful pairing the App
// registers itself to open at login: macOS 13+ (Darwin 22+) uses SMAppService
// (`type: 'mainAppService'`), older macOS the legacy hidden login item, and
// Windows passes `--background` so the App starts with the tray only.
// SMARTSELL_NO_LOGIN_ITEM=1 (tests, --smoke) never touches the real setting.

export interface LoginItemSettingsInput {
  openAtLogin: boolean;
  openAsHidden?: boolean;
  type?: 'mainAppService';
  args?: string[];
  path?: string;
}

export interface LoginItemState { openAtLogin: boolean; wasOpenedAtLogin?: boolean; status?: string }

/** The slice of Electron's `app` this module uses. */
export interface LoginItemApp {
  setLoginItemSettings(settings: LoginItemSettingsInput): void;
  getLoginItemSettings(options?: { type?: 'mainAppService'; args?: string[]; path?: string }): LoginItemState;
}

export const BACKGROUND_FLAG = '--background';

/** Darwin kernel 22 is macOS 13 (Ventura), the first release with SMAppService. */
export function darwinMajor(osRelease: string) {
  const major = Number.parseInt(osRelease.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 0;
}

export function usesMainAppService(platform: NodeJS.Platform, osRelease: string) {
  return platform === 'darwin' && darwinMajor(osRelease) >= 22;
}

/** What `app.setLoginItemSettings` receives for this OS. */
export function loginItemSettings(platform: NodeJS.Platform, osRelease: string, enabled: boolean, execPath?: string): LoginItemSettingsInput {
  if (platform === 'darwin') {
    return usesMainAppService(platform, osRelease) ? { openAtLogin: enabled, type: 'mainAppService' } : { openAtLogin: enabled, openAsHidden: true };
  }
  if (platform === 'win32') return { openAtLogin: enabled, args: [BACKGROUND_FLAG], ...(execPath && { path: execPath }) };
  return { openAtLogin: enabled };
}

function queryOptions(platform: NodeJS.Platform, osRelease: string, execPath?: string) {
  if (usesMainAppService(platform, osRelease)) return { type: 'mainAppService' as const };
  if (platform === 'win32') return { args: [BACKGROUND_FLAG], ...(execPath && { path: execPath }) };
  return undefined;
}

export interface AutostartOptions {
  platform: NodeJS.Platform;
  osRelease: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  log?(message: string, detail?: object): void;
}

export function autostartDisabledByEnv(env: NodeJS.ProcessEnv = process.env) {
  return env.SMARTSELL_NO_LOGIN_ITEM === '1';
}

export class Autostart {
  constructor(private readonly app: LoginItemApp, private readonly options: AutostartOptions) {}

  /** Applies the setting; returns false when it was suppressed (tests, smoke checks) or Electron refused it. */
  set(enabled: boolean): boolean {
    const { platform, osRelease, execPath, env, log } = this.options;
    const settings = loginItemSettings(platform, osRelease, enabled, execPath);
    if (autostartDisabledByEnv(env)) {
      log?.('login item suppressed (SMARTSELL_NO_LOGIN_ITEM=1)', { settings });
      return false;
    }
    if (platform !== 'darwin' && platform !== 'win32') return false;
    try { this.app.setLoginItemSettings(settings); return true; }
    catch (error) { log?.('login item could not be changed', { error: String(error) }); return false; }
  }

  enabled(): boolean {
    const { platform, osRelease, execPath } = this.options;
    try { return this.app.getLoginItemSettings(queryOptions(platform, osRelease, execPath)).openAtLogin === true; }
    catch { return false; }
  }

  /**
   * §8.2: start with the tray only when the OS opened the App at login or it was given --background.
   * macOS 13+ no longer reports wasOpenedAtLogin for SMAppService items, so a launch within five minutes of
   * boot while the login item is on also counts as a background start.
   */
  startedInBackground(argv: readonly string[], uptimeSec: number): boolean {
    if (argv.includes(BACKGROUND_FLAG)) return true;
    const { platform, osRelease, execPath } = this.options;
    let state: LoginItemState;
    try { state = this.app.getLoginItemSettings(queryOptions(platform, osRelease, execPath)); } catch { return false; }
    if (state.wasOpenedAtLogin === true) return true;
    return usesMainAppService(platform, osRelease) && state.openAtLogin === true && uptimeSec < 300;
  }
}
