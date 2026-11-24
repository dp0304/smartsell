import { existsSync, statSync, type Stats } from 'node:fs';
import { dirname, resolve, win32 } from 'node:path';
import { parseArgs } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { configuration, defaultHubDir, HubConfigError, type Config } from '../config.js';
import { nodeExec, type Exec } from './exec.js';
import { createBackupSchedule, scratchCopy } from './backup.js';
import { applyHubEnv, readHubEnvFile } from './hub-env.js';
import { hubVersion, registerHubInfo } from './hub-info.js';
import { writeHubStatus } from './status-file.js';
import { createTailscaleMonitor } from './tailscale.js';
import { webStatic } from './web-static.js';

export interface HubIssue { level: 'error' | 'warn'; code: string; message: string }

export interface HubCheckDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  stat?: (path: string) => Pick<Stats, 'mode' | 'isDirectory'> | undefined;
  exists?: (path: string) => boolean;
}

const defaultStat = (path: string) => { try { return statSync(path); } catch { return undefined; } };

/** True when `child` is `parent` or inside it, comparing Windows paths case-insensitively. */
export function windowsPathInside(child: string, parent: string) {
  const a = win32.resolve(child).toLowerCase();
  const b = win32.resolve(parent).toLowerCase().replace(/\\+$/, '');
  return a === b || a.startsWith(`${b}\\`);
}

/**
 * Data directory rule (§2.5): 0700 on macOS and Linux; Windows has no POSIX mode bits, so the directory must be under
 * the current user's %LOCALAPPDATA%.
 */
export function dataDirectoryIssue(directory: string, deps: HubCheckDeps = {}): HubIssue | undefined {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const stat = (deps.stat ?? defaultStat)(directory);
  if (!stat?.isDirectory()) {
    return { level: 'error', code: 'HUB_DIR_MISSING', message: `找不到中樞資料夾 ${directory}。請先執行 pnpm hub:init。` };
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (!local || !windowsPathInside(directory, local)) {
      return { level: 'error', code: 'HUB_DIR_NOT_PRIVATE', message: `中樞資料夾 ${directory} 必須位於目前使用者的 %LOCALAPPDATA% 之下（${local ?? '未設定'}），其他使用者才讀不到。請移除 SMARTSELL_HUB_DIR 改用預設位置，或重跑 pnpm hub:init。` };
    }
    return;
  }
  if ((stat.mode & 0o077) !== 0) {
    return { level: 'error', code: 'HUB_DIR_NOT_PRIVATE', message: `中樞資料夾 ${directory} 的權限是 ${(stat.mode & 0o777).toString(8)}，必須是 700。請執行：chmod 700 "${directory}"` };
  }
}

/** Startup checks of §2.5 step 4 (configuration itself is validated by `configuration()`). */
export async function runHubChecks(config: Pick<Config, 'hubDirectory' | 'statePath' | 'webDistDirectory'>, deps: HubCheckDeps = {}): Promise<HubIssue[]> {
  const exists = deps.exists ?? existsSync;
  const exec = deps.exec ?? nodeExec;
  const issues: HubIssue[] = [];
  const dist = config.webDistDirectory;
  if (!dist || !exists(resolve(dist, 'index.html'))) {
    issues.push({ level: 'error', code: 'HUB_WEB_NOT_BUILT', message: `找不到 Web 的建置檔 ${dist ? resolve(dist, 'index.html') : '(未設定 SMARTSELL_WEB_DIST)'}。請在原始碼資料夾執行：pnpm --filter @smartsell/web build（或重跑 pnpm hub:init）。` });
  }
  const directories = [...new Set([config.hubDirectory, dirname(config.statePath)].filter((value): value is string => !!value))];
  for (const directory of directories) {
    const issue = dataDirectoryIssue(directory, deps);
    if (issue) issues.push(issue);
  }
  const probe = await exec('ffprobe', ['-version'], { timeoutMs: 10_000 });
  if (probe.code !== 0) {
    issues.push({ level: 'warn', code: 'HUB_FFPROBE_MISSING', message: '找不到 ffprobe：上傳的影片無法讀取長度與解析度。請安裝 ffmpeg（macOS：brew install ffmpeg；Windows：winget install Gyan.FFmpeg），然後重新啟動中樞。' });
  }
  return issues;
}

export interface LoadCheckDeps {
  /** Loads the server the way `start()` does in production; injectable so tests can make a module fail. */
  loadModules?: () => Promise<string[]>;
  /** Opens a store on a copy of the data and reads it; injectable for tests. */
  readData?: (path: string) => Promise<void>;
}

/** Production loading as bootstrap.ts does it: missing command modules and operation load failures are fatal. */
async function loadServerModules(): Promise<string[]> {
  const problems: string[] = [];
  await import('../bootstrap.js');
  const { discover } = await import('../registry.js');
  const { missing } = await discover();
  if (missing.length) problems.push(`缺少模組：${missing.join('、')}`);
  const { discoverOperations } = await import('../operations.js');
  const { loadFailures } = await discoverOperations();
  for (const [module, error] of loadFailures) problems.push(`${module} 的操作載入失敗：${error}`);
  return problems;
}

async function readDataWithThisCode(path: string) {
  const { localStore } = await import('../local.js');
  const store = localStore(path);
  try {
    await store.ready();
    await store.initialized();
  } finally {
    await store.close();
  }
}

/**
 * AO-1: `hub.ts --check --load`. Besides the configuration checks, load every module and operation with production
 * semantics and decode a private copy of the data file with this code, without listening or touching the live file.
 * `pnpm hub:update` runs it with the new code before it restarts the service; `hub:service install` before installing.
 */
export async function runLoadCheck(config: Pick<Config, 'hubDirectory' | 'statePath'>, deps: LoadCheckDeps = {}): Promise<HubIssue[]> {
  const issues: HubIssue[] = [];
  try {
    for (const problem of await (deps.loadModules ?? loadServerModules)()) {
      issues.push({ level: 'error', code: 'HUB_LOAD_FAILED', message: `這個版本的中樞程式載入失敗：${problem}` });
    }
  } catch (error) {
    issues.push({ level: 'error', code: 'HUB_LOAD_FAILED', message: `這個版本的中樞程式載入失敗：${error instanceof Error ? error.message : String(error)}` });
  }
  if (config.hubDirectory && existsSync(config.statePath)) {
    let copy: ReturnType<typeof scratchCopy> | undefined;
    try {
      copy = scratchCopy(config.statePath, config.hubDirectory);
      await (deps.readData ?? readDataWithThisCode)(copy.path);
    } catch (error) {
      issues.push({ level: 'error', code: 'HUB_DATA_UNREADABLE',
        message: `這個版本的中樞讀不了目前的資料（${error instanceof Error ? error.message : String(error)}）；檢查用的是資料的副本，原檔沒有被動到。` });
    } finally {
      copy?.remove();
    }
  }
  return issues;
}

export type HubOutcome =
  | { outcome: 'checked'; issues: HubIssue[] }
  | { outcome: 'check_failed'; issues: HubIssue[]; message: string }
  | { outcome: 'config_error'; issues: HubIssue[]; message: string; code: string; statusWritten: boolean }
  | { outcome: 'running'; app: FastifyInstance; config: Config; stop(): Promise<void> };

export interface HubMainDeps extends HubCheckDeps, LoadCheckDeps {
  log?: (line: string) => void;
  /** Bootstrap's `start`; injectable so tests can verify the wiring without opening a port. */
  start?: typeof import('../bootstrap.js').start;
  now?: () => Date;
}

/** Applies hub.env and the hub's fixed mode to `env` (§2.5 steps 1–2). */
export function prepareHubEnvironment(argv: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) {
  const { values } = parseArgs({ args: [...argv], options: { check: { type: 'boolean' }, load: { type: 'boolean' }, 'hub-dir': { type: 'string' } }, strict: true });
  const hubDir = resolve(values['hub-dir'] ?? (env.SMARTSELL_HUB_DIR || defaultHubDir(platform, env)));
  env.SMARTSELL_HUB_DIR = hubDir;
  const file = readHubEnvFile(hubDir, platform);
  const issues: HubIssue[] = [];
  if (file.exists && file.mode !== undefined && (file.mode & 0o077) !== 0) {
    issues.push({ level: 'error', code: 'HUB_ENV_NOT_PRIVATE', message: `${file.path} 的權限是 ${file.mode.toString(8)}，必須是 600。請執行：chmod 600 "${file.path}"` });
  }
  if (file.ignored.length) {
    issues.push({ level: 'warn', code: 'HUB_ENV_IGNORED_KEYS', message: `hub.env 中的 ${file.ignored.join('、')} 不在允許的設定中，已忽略。` });
  }
  if (file.invalidLines.length) {
    issues.push({ level: 'warn', code: 'HUB_ENV_INVALID_LINES', message: `hub.env 第 ${file.invalidLines.join('、')} 行不是 KEY=VALUE 格式，已忽略。` });
  }
  const applied = applyHubEnv(file.values, env);
  // A hub runs with production semantics; E2E keeps NODE_ENV=test for the two test-only exceptions (§2.3).
  if (env.NODE_ENV !== 'test') env.NODE_ENV = 'production';
  env.SMARTSELL_MODE = 'hub';
  return { hubDir, check: values.check === true, load: values.load === true, applied, issues, hubEnvExists: file.exists };
}

const errorText = (issues: HubIssue[]) => issues.filter(issue => issue.level === 'error').map(issue => issue.message).join('\n');

/** `node --import tsx apps/server/hub.ts [--check [--load]] [--hub-dir <dir>]` (§2.5). */
export async function hubMain(argv: readonly string[], deps: HubMainDeps = {}): Promise<HubOutcome> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  let prepared: ReturnType<typeof prepareHubEnvironment>;
  try {
    prepared = prepareHubEnvironment(argv, env, platform);
  } catch (error) {
    // Unknown arguments or an unreadable hub.env: still a configuration error, so exit 0 rather than restart-loop.
    const message = error instanceof Error ? error.message : String(error);
    log(`SmartSell 中樞沒有啟動：${message}`);
    const issue: HubIssue = { level: 'error', code: 'HUB_ARGUMENTS_INVALID', message };
    if (argv.includes('--check')) return { outcome: 'check_failed', issues: [issue], message };
    return { outcome: 'config_error', issues: [issue], message, code: issue.code, statusWritten: false };
  }
  const issues = [...prepared.issues];
  const fail = (code: string, message: string): HubOutcome => {
    if (prepared.check) {
      for (const issue of issues) log(`${issue.level === 'error' ? '[錯誤]' : '[警告]'} ${issue.message}`);
      return { outcome: 'check_failed', issues, message };
    }
    log(`SmartSell 中樞沒有啟動：${message}`);
    log('修正後服務不會自動重試；請執行 pnpm hub:doctor 查看，修正後以 pnpm hub:service install 或重新登入啟動。');
    const statusWritten = writeHubStatus(prepared.hubDir, { state: 'config_error', code, message }, now());
    return { outcome: 'config_error', issues, message, code, statusWritten };
  };
  let config: Config;
  try {
    config = configuration(env);
  } catch (error) {
    const code = error instanceof HubConfigError ? error.code : 'HUB_CONFIG_INVALID';
    const message = error instanceof Error ? error.message : String(error);
    issues.unshift({ level: 'error', code, message });
    return fail(code, errorText(issues));
  }
  issues.push(...await runHubChecks(config, { ...deps, platform, env }));
  // Only `--check --load` loads the code; a plain start loads it anyway and a plain --check stays fast.
  if (prepared.check && prepared.load && !issues.some(issue => issue.level === 'error')) issues.push(...await runLoadCheck(config, deps));
  const firstError = issues.find(issue => issue.level === 'error');
  if (firstError) return fail(firstError.code, errorText(issues));
  if (prepared.check) {
    for (const issue of issues) log(`[警告] ${issue.message}`);
    log(`[OK] 中樞設定檢查通過（${config.hubDirectory}）${prepared.load ? '；程式與資料都能以這個版本載入' : ''}`);
    return { outcome: 'checked', issues };
  }
  for (const issue of issues) log(`[警告] ${issue.message}`);
  const start = deps.start ?? (await import('../bootstrap.js')).start;
  const web = webStatic(config.webDistDirectory!);
  // findTailscale honours SMARTSELL_TAILSCALE_CLI (non-standard installs; tests and E2E point it at a fake CLI).
  const monitor = createTailscaleMonitor({ exec: deps.exec ?? nodeExec, port: config.port, platform, env, log });
  // E45: one copy of the data a day in <hubDir>/backups (7 kept), checked a minute after start and then hourly.
  const backups = createBackupSchedule({ statePath: config.statePath, hubDir: prepared.hubDir, log, platform });
  const version = hubVersion();
  let app: FastifyInstance;
  try {
    app = await start(config, {
      notFound: web.notFound,
      beforeListen(instance, services) {
        web.routes(instance);
        registerHubInfo(instance, { config, requireSession: services.requireSession, tailscale: monitor, version });
        instance.addHook('onClose', async () => { monitor.stop(); backups.stop(); });
      },
    });
  } catch (error) {
    monitor.stop();
    backups.stop();
    const message = error instanceof Error ? error.message : String(error);
    writeHubStatus(prepared.hubDir, { state: 'start_failed', code: 'HUB_START_FAILED', message }, now());
    throw error;
  }
  monitor.start();
  backups.start();
  writeHubStatus(prepared.hubDir, { state: 'running', pid: process.pid, version, public_origin: config.origin }, now());
  log(`SmartSell 中樞已啟動：${config.origin}（本機 http://${config.host}:${config.port}）`);
  let stopping: Promise<void> | undefined;
  return {
    outcome: 'running', app, config,
    stop: () => stopping ??= app.close().then(() => {
      writeHubStatus(prepared.hubDir, { state: 'stopped', version }, now());
    }),
  };
}
