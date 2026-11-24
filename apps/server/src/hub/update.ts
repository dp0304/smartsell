import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultHubDir } from '../config.js';
import { preUpdateBackup, restoreDatabase, snapshotDigest, type BackupResult } from './backup.js';
import { nodeExec, pnpmCommand, type Exec } from './exec.js';
import { readHubEnvFile, writePrivateFile } from './hub-env.js';
import { REPO_ROOT } from './init.js';
import { describeHubStatus, readHubStatus } from './status-file.js';
import { agentPlistPath, DAEMON_PLIST, hubPort, installedMode, LAUNCHD_LABEL, planInstall, readyz, runPlan, serviceNodeIssue, stableNodePath,
  versionedNodePath, WINDOWS_TASK_NAME, writeServiceFile } from './service.js';

export const SELECTORS_SOURCE = 'apps/connector-desktop/src/drivers/selectors.json';
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;

export interface UpdateDeps {
  exec?: Exec;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  repo?: string;
  home?: string;
  uid?: number;
  nodePath?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Swaps the freshly built Web directory into place; injectable for tests. */
  swapDirectory?: (staging: string, target: string) => void;
  daemonInstalled?: () => boolean;
  now?: () => Date;
  /** Whether a process is still running (default: `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  /** Reads an installed launchd plist (AO-3); service file writes go through these when it is re-rendered. */
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  writeFile?: (path: string, content: string | Buffer, mode?: number) => void;
  removeFile?: (path: string) => void;
}

const previousOf = (target: string) => `${target}.previous`;

/**
 * Replaces `target` with `staging` so a failed build never leaves a half-written dist behind. With `keepPrevious`, the
 * old directory stays at `<target>.previous` until `dropPrevious` (success) or `restorePrevious` (rollback).
 */
export function swapDirectory(staging: string, target: string, options: { keepPrevious?: boolean } = {}) {
  const previous = previousOf(target);
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, previous);
  try {
    renameSync(staging, target);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, target);
    throw error;
  }
  if (!options.keepPrevious) rmSync(previous, { recursive: true, force: true });
}

/** Puts `<target>.previous` back (AO-1 rollback); true when there was one. */
export function restorePrevious(target: string) {
  const previous = previousOf(target);
  if (!existsSync(previous)) return false;
  rmSync(target, { recursive: true, force: true });
  renameSync(previous, target);
  return true;
}

export const dropPrevious = (target: string) => rmSync(previousOf(target), { recursive: true, force: true });

/** Copies the selector data file for `GET /api/v1/device/driver-config` (§8.11), refusing anything that is not JSON. */
export function placeSelectors(repo: string, hubDir: string, platform: NodeJS.Platform = process.platform) {
  const source = join(repo, SELECTORS_SOURCE);
  if (!existsSync(source)) return { status: 'missing' as const, source };
  const text = readFileSync(source, 'utf8');
  let version: unknown;
  try { version = (JSON.parse(text) as { version?: unknown }).version; } catch { return { status: 'invalid' as const, source }; }
  const directory = join(hubDir, 'driver-config');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, 'selectors.json');
  const previous = existsSync(target) ? readFileSync(target, 'utf8') : null;
  writePrivateFile(target, text, platform);
  return { status: 'copied' as const, source, target, version: typeof version === 'string' ? version : null, previous };
}

type ServiceMode = 'agent' | 'daemon' | 'windows';

export function restartCommands(platform: NodeJS.Platform, mode: ServiceMode | undefined, uid: number): string[][] {
  if (platform === 'darwin' && mode === 'agent') return [['launchctl', 'kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`]];
  if (platform === 'darwin' && mode === 'daemon') return [['sudo', 'launchctl', 'kickstart', '-k', `system/${LAUNCHD_LABEL}`]];
  if (platform === 'win32') return [['schtasks', '/End', '/TN', WINDOWS_TASK_NAME], ['schtasks', '/Run', '/TN', WINDOWS_TASK_NAME]];
  return [];
}

/** Stop and start (not restart) commands for the AO-1 rollback, which must swap the data file while no hub runs. */
export function stopStartCommands(platform: NodeJS.Platform, mode: ServiceMode | undefined, uid: number, home: string): { stop: string[][]; start: string[][] } {
  if (platform === 'darwin' && mode === 'agent') {
    return { stop: [['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`]], start: [['launchctl', 'bootstrap', `gui/${uid}`, agentPlistPath(home)]] };
  }
  if (platform === 'darwin' && mode === 'daemon') {
    return { stop: [['sudo', 'launchctl', 'bootout', `system/${LAUNCHD_LABEL}`]], start: [['sudo', 'launchctl', 'bootstrap', 'system', DAEMON_PLIST]] };
  }
  if (platform === 'win32') return { stop: [['schtasks', '/End', '/TN', WINDOWS_TASK_NAME]], start: [['schtasks', '/Run', '/TN', WINDOWS_TASK_NAME]] };
  return { stop: [], start: [] };
}

const defaultAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * `pnpm hub:update` (§2.13, AO-1, E45). Returns the exit code.
 *
 * 0. record `git rev-parse HEAD` and copy the data (`<hubDir>/backups/pre-update-*.sqlite`);
 * 1. `git pull --ff-only`; 2. `pnpm install --frozen-lockfile` and the relay bundle; 3. type-check and build the Web app
 *    into a staging folder; 4. `hub.ts --check --load` with the new code (loads every module, decodes a copy of the data);
 * 5. swap in the Web app and the selector data; 6. restart the service and wait for the *new* process's /readyz.
 *
 * Any failure in 2–4 puts the source (`git reset --keep`), dependencies, relay bundle, Web app and selectors back, so
 * the old version keeps running and is also what starts after the next reboot. A new version that does not answer
 * within 60 s is stopped and rolled back the same way, with the data copy restored if the new code changed the data
 * (the changed file is kept aside, never deleted).
 */
export async function updateMain(argv: readonly string[], deps: UpdateDeps = {}): Promise<number> {
  const { values } = parseArgs({ args: argv.filter(arg => arg !== '--'), options: {
    'hub-dir': { type: 'string' }, 'skip-pull': { type: 'boolean' }, 'no-restart': { type: 'boolean' },
  } });
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? nodeExec;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const repo = resolve(deps.repo ?? REPO_ROOT);
  const hubDir = resolve(values['hub-dir'] ?? (env.SMARTSELL_HUB_DIR || defaultHubDir(platform, env)));
  const hubEnv = readHubEnvFile(hubDir, platform).values;
  const statePath = resolve(hubEnv.SMARTSELL_DATA_FILE ?? env.SMARTSELL_DATA_FILE ?? join(hubDir, 'smartsell.sqlite'));
  const node = deps.nodePath ?? stableNodePath(process.execPath, platform, deps.exists);
  const pnpm = pnpmCommand(platform);
  const skipPull = values['skip-pull'] === true;

  // 0. Where we are, and a copy of the data, before anything changes.
  const head = async () => {
    const result = await exec('git', ['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 60_000 });
    const commit = result.stdout.trim();
    return result.code === 0 && /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
  };
  const previous = await head();
  if (!previous) {
    log('[失敗] 0/6 讀不到目前的版本（git rev-parse HEAD），無法在更新失敗時回到這一版，所以沒有更新。請在原始碼資料夾執行 git status 確認。');
    return 1;
  }
  const known: string = previous;
  const short = known.slice(0, 12);
  let backup: BackupResult;
  try {
    backup = preUpdateBackup(statePath, hubDir, { now: now(), platform });
  } catch (error) {
    log(`[失敗] 0/6 更新前備份資料失敗（${error instanceof Error ? error.message : String(error)}），所以沒有更新。請確認磁碟空間後重跑 pnpm hub:update。`);
    return 1;
  }
  log(backup.status === 'created' ? `0/6 目前的版本 ${short}；已備份資料：${backup.path}` : `0/6 目前的版本 ${short}；還沒有資料檔（中樞沒有執行過），略過備份。`);

  const target = resolve(hubEnv.SMARTSELL_WEB_DIST ?? env.SMARTSELL_WEB_DIST ?? join(repo, 'apps/web/dist'));
  const staging = `${target}.staging`;
  const changed = { dependencies: false, web: false, selectors: undefined as undefined | { target: string; previous: string | null } };

  /** Puts the code, dependencies, relay bundle, Web app and selectors back as they were before step 1. */
  async function revertFiles(): Promise<boolean> {
    let complete = true;
    rmSync(staging, { recursive: true, force: true });
    if (changed.web && restorePrevious(target)) log(`已換回更新前的 Web：${target}`);
    if (changed.selectors) {
      if (changed.selectors.previous === null) rmSync(changed.selectors.target, { force: true });
      else writePrivateFile(changed.selectors.target, changed.selectors.previous, platform);
      log('已換回更新前的選擇器資料檔。');
    }
    const current = await head();
    if (current !== previous) {
      const reset = await exec('git', ['reset', '--keep', known], { cwd: repo, inherit: true, timeoutMs: 120_000 });
      if (reset.code === 0) log(`原始碼已回到 ${short}（git reset --keep，你自己改過的檔案保留不動）。`);
      else {
        complete = false;
        log(`[失敗] 原始碼沒能回到 ${short}（git reset --keep 結束碼 ${reset.code}）。請在原始碼資料夾執行：git reset --keep ${previous}`);
      }
    } else if (skipPull && changed.dependencies) {
      log('這次用了 --skip-pull：原始碼是你自己更新的，沒有記錄更早的版本，原始碼維持現狀；下次重開機或崩潰後會執行目前的原始碼。');
    }
    if (changed.dependencies) {
      // The previous lockfile's packages are still in the pnpm store, so this works offline (the network may be why we are here).
      let install = await exec(pnpm, ['install', '--frozen-lockfile', '--offline'], { cwd: repo, inherit: true, timeoutMs: 15 * 60_000 });
      if (install.code !== 0) install = await exec(pnpm, ['install', '--frozen-lockfile'], { cwd: repo, inherit: true, timeoutMs: 15 * 60_000 });
      const relay = install.code === 0 ? await exec(pnpm, ['--filter', '@smartsell/agent-relay', 'build'], { cwd: repo, inherit: true, timeoutMs: 5 * 60_000 }) : install;
      if (install.code === 0 && relay.code === 0) log('相依套件與 relay 已回到更新前的版本。');
      else {
        complete = false;
        log('[失敗] 相依套件沒能回到更新前的版本。請在原始碼資料夾執行：pnpm install --frozen-lockfile，然後 pnpm --filter @smartsell/agent-relay build。');
      }
    }
    return complete;
  }

  const failBeforeRestart = async (message: string) => {
    log(message);
    const complete = await revertFiles();
    log(complete
      ? `中樞服務沒有重新啟動，舊版本繼續執行；原始碼與相依套件已回到更新前的版本（${short}），重開機後也會執行它。`
      : '中樞服務沒有重新啟動，舊版本繼續執行；但回復沒有全部完成，請先照上面的說明處理，再重開機或重新啟動服務。');
    return 1;
  };
  const run = async (step: string, file: string, args: string[], timeoutMs = 15 * 60_000) => {
    log(`${step}：${[file, ...args].join(' ')}`);
    const result = await exec(file, args, { cwd: repo, inherit: true, timeoutMs });
    return result.code === 0 ? undefined : `[失敗] ${step}失敗（結束碼 ${result.code}${result.error ? `，${result.error}` : ''}）。`;
  };

  // 1. Pull. `--ff-only` either moves HEAD or changes nothing.
  if (!skipPull) {
    const failed = await run('1/6 取得最新原始碼', 'git', ['pull', '--ff-only']);
    if (failed) {
      log(`${failed}沒有做任何變更，中樞服務沒有重新啟動，舊版本繼續執行。`);
      log('若是本機有修改或分支已分岔，請先處理（git status），再重跑 pnpm hub:update。');
      return 1;
    }
  }

  // 2–3. Dependencies, relay, Web (into staging; the live dist is untouched until the load check passes).
  changed.dependencies = true;
  rmSync(staging, { recursive: true, force: true });
  for (const [step, args, timeoutMs] of [
    ['2/6 安裝相依套件', ['install', '--frozen-lockfile']],
    // The relay bundle behind GET /agent/relay.mjs (S5 ledger item 6); esbuild writes the file only on success.
    ['2/6 建置 relay', ['--filter', '@smartsell/agent-relay', 'build'], 5 * 60_000],
    ['3/6 檢查 Web 型別', ['--filter', '@smartsell/web', 'exec', 'tsc', '-p', 'tsconfig.json']],
    ['3/6 建置 Web', ['--filter', '@smartsell/web', 'exec', 'vite', 'build', '--outDir', staging, '--emptyOutDir']],
  ] as [string, string[], number?][]) {
    const failed = await run(step, pnpm, args, timeoutMs);
    if (failed) return failBeforeRestart(failed);
  }
  if (!existsSync(join(staging, 'index.html'))) return failBeforeRestart(`[失敗] Web 建置沒有產生 ${join(staging, 'index.html')}。`);

  // 4. Load the new code for real (every module, production semantics, a copy of the data), without listening.
  log('4/6 以新版本載入程式與資料（不啟動、不碰原資料檔）：hub.ts --check --load');
  const check = await exec(node, ['--import', 'tsx', join(repo, 'apps', 'server', 'hub.ts'), '--check', '--hub-dir', hubDir, '--load'],
    { cwd: repo, inherit: true, timeoutMs: 180_000, env: { ...env, SMARTSELL_HUB_DIR: hubDir } });
  if (check.code !== 0) return failBeforeRestart('[失敗] 4/6 新版本的設定、程式或資料檢查沒有通過（原因見上面）。');

  // 5. Only now the running hub starts serving the new Web app, and Workers get the new selectors.
  (deps.swapDirectory ?? ((from: string, to: string) => swapDirectory(from, to, { keepPrevious: true })))(staging, target);
  changed.web = true;
  log(`5/6 Web 已更新：${target}`);
  const selectors = placeSelectors(repo, hubDir, platform);
  if (selectors.status === 'copied') {
    changed.selectors = { target: selectors.target, previous: selectors.previous };
    log(`5/6 選擇器資料檔已放到 ${selectors.target}${selectors.version ? `（版本 ${selectors.version}）` : ''}；Worker 下一次心跳就會更新。`);
  } else if (selectors.status === 'missing') log(`[警告] 5/6 找不到 ${selectors.source}，Worker 會繼續使用內建的選擇器。`);
  else log(`[警告] 5/6 ${selectors.source} 不是有效的 JSON，沒有複製；Worker 會繼續使用上一版。`);

  if (values['no-restart']) {
    dropPrevious(target);
    log('6/6 依 --no-restart 略過重新啟動：網頁已是新版，伺服器要等你重新啟動服務才會換成新版本。');
    return 0;
  }

  // 6. Restart and wait for the new process.
  const home = deps.home ?? homedir();
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const mode: ServiceMode | undefined = platform === 'darwin'
    ? (deps.daemonInstalled?.() ?? existsSync(DAEMON_PLIST)) ? 'daemon' : installedMode(platform, home) === 'agent' ? 'agent' : undefined
    : platform === 'win32' ? 'windows' : undefined;
  const commands = restartCommands(platform, mode, uid);
  if (!commands.length) {
    dropPrevious(target);
    log('6/6 沒有安裝中樞服務（pnpm hub:service install）；請自己重新啟動 pnpm hub。');
    return 0;
  }
  const port = hubPort(hubDir, platform);
  const beforePid = (() => { const status = readHubStatus(hubDir); return status.status === 'ok' && status.value.state === 'running' ? status.value.pid : undefined; })();
  const execAll = async (list: string[][], allowFailure: (argv: string[]) => boolean) => {
    for (const [file, ...args] of list) {
      log(`6/6 ${[file, ...args].join(' ')}`);
      const result = await exec(file!, args, { inherit: file === 'sudo', timeoutMs: 120_000 });
      if (result.code !== 0 && !allowFailure([file!, ...args])) return result.code;
    }
    return 0;
  };

  let restarted: number;
  const plist = mode === 'daemon' ? DAEMON_PLIST : mode === 'agent' ? agentPlistPath(home) : undefined;
  const nodeIssue = plist ? serviceNodeIssue(plist, { read: deps.readFile, exists: deps.exists }) : undefined;
  // AO-3: the service file names a node binary brew removed (or will remove). Rewrite it with the stable path; loading it
  // restarts the hub. A still-versioned path (no opt link) is only rewritten when the old one is gone, never in a loop.
  if (plist && nodeIssue && (mode === 'agent' || mode === 'daemon') && (nodeIssue.level === 'error' || !versionedNodePath(node))) {
    log(`[提示] 服務設定檔指向的 Node（${nodeIssue.node}）${nodeIssue.level === 'error' ? '已不存在' : '帶有版本號，brew upgrade 後會失效'}；改寫服務設定檔，改用 ${node} 並重新載入。`);
    const userName = (() => { try { return userInfo().username; } catch { return env.USER ?? ''; } })();
    const result = await runPlan(planInstall({ platform, mode, nodePath: node, repo, hubDir, home, uid, userName, userId: userName }),
      { exec, log, writeFile: deps.writeFile ?? writeServiceFile, removeFile: deps.removeFile ?? (path => rmSync(path, { force: true })) }, false);
    restarted = result.ok ? 0 : 1;
    if (!result.ok) log(result.message);
  } else {
    if (platform === 'win32') {
      const task = await exec('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME, '/XML'], { timeoutMs: 15_000 });
      if (task.code === 0 && !/--supervise/.test(task.stdout)) {
        log('[警告] 排程工作是舊版設定，中樞崩潰後不會自動重啟。更新完成後請執行 pnpm hub:service install --mode boot（或 --mode logon）重新安裝。');
      }
      // /End then /Run: wait for the old hub to let go of the port before the new one starts.
      restarted = await execAll([commands[0]!], () => true);
      for (let waited = 0; waited < STOP_TIMEOUT_MS && await readyz(port, deps.fetch); waited += 1000) await sleep(1000);
      restarted = await execAll(commands.slice(1), () => false);
    } else {
      restarted = await execAll(commands, () => false);
    }
  }
  const isAlive = deps.isAlive ?? defaultAlive;
  const newHubReady = async () => {
    for (let waited = 0; waited <= READY_TIMEOUT_MS; waited += 2000) {
      const status = readHubStatus(hubDir);
      const fresh = status.status !== 'ok' || !beforePid || (status.value.state === 'running' && status.value.pid !== beforePid);
      if (fresh && await readyz(port, deps.fetch)) return true;
      await sleep(2000);
    }
    return false;
  };
  if (restarted === 0 && await newHubReady()) {
    dropPrevious(target);
    log(`中樞已更新並在執行中（http://127.0.0.1:${port}/readyz 正常）。更新前的資料備份留在 ${backup.status === 'created' ? backup.path : '（沒有）'}。`);
    return 0;
  }

  // 7. The new version did not come up: stop it, put the old version (and, if it was changed, the data) back, start again.
  log(restarted === 0
    ? `[失敗] 新版本在 60 秒內沒有回應。${describeHubStatus(readHubStatus(hubDir))}`
    : `[失敗] 重新啟動服務失敗（結束碼 ${restarted}）。`);
  log(`自動回到更新前的版本 ${short}…`);
  const { stop, start } = stopStartCommands(platform, mode, uid, home);
  await execAll(stop, () => true);
  const failedPid = (() => { const status = readHubStatus(hubDir); return status.status === 'ok' && status.value.pid !== beforePid ? status.value.pid : undefined; })();
  let gone = false;
  for (let waited = 0; waited <= STOP_TIMEOUT_MS; waited += 1000) {
    gone = !await readyz(port, deps.fetch) && (!failedPid || !isAlive(failedPid));
    if (gone) break;
    await sleep(1000);
  }
  const complete = await revertFiles();
  if (backup.status === 'created') {
    const current = snapshotDigest(statePath);
    if (current !== snapshotDigest(backup.path)) {
      if (!gone) log(`[警告] 新版本的程序還沒結束，所以沒有動資料檔；確認中樞已停止後，可把 ${backup.path} 複製回 ${statePath}。`);
      else {
        const aside = restoreDatabase(backup.path, statePath, { now: now(), platform });
        log(`新版本改過資料，已換回更新前的備份；新版本寫過的資料保留在 ${aside}（沒有刪除）。`);
      }
    } else log('資料沒有被新版本改過，保留原樣。');
  }
  await execAll(start, () => false);
  const back = await (async () => {
    for (let waited = 0; waited <= READY_TIMEOUT_MS; waited += 2000) {
      if (await readyz(port, deps.fetch)) return true;
      await sleep(2000);
    }
    return false;
  })();
  log(back && complete
    ? `[已回復] 中樞已回到更新前的版本 ${short} 並在執行中，更新沒有套用。請把上面的錯誤告訴開發者，或執行 pnpm hub:doctor。`
    : back ? `中樞已回到執行中，但回復沒有全部完成（見上面）；重開機前請先照上面的說明處理。`
      : `[失敗] 回到更新前的版本後，中樞仍沒有回應。${describeHubStatus(readHubStatus(hubDir))} 請執行 pnpm hub:doctor。`);
  return 1;
}
