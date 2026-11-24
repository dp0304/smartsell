import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BUSY_TIMEOUT_MS } from '../local.js';

/**
 * E45 (AO-8, AO-1): copies of the hub's SQLite file in `<hubDir>/backups/`. One a day (the newest 7 are kept), one before
 * every `pnpm hub:update` (the newest 3 are kept). Each copy is a consistent `VACUUM INTO` snapshot, written to a 0600
 * file and renamed into place, so a crash never leaves a half-written copy that looks like a backup.
 */
export const BACKUP_DIR = 'backups';
export const DAILY_BACKUPS_KEPT = 7;
export const UPDATE_BACKUPS_KEPT = 3;
/** hub:doctor warns when the newest copy is older than this. */
export const BACKUP_STALE_MS = 48 * 3_600_000;
export const BACKUP_CHECK_INTERVAL_MS = 3_600_000;
const DAILY = /^smartsell-(\d{4}-\d{2}-\d{2})\.sqlite$/;
const UPDATE = /^pre-update-(\d{8}T\d{6}Z)\.sqlite$/;
const LEFTOVER = /(?:\.partial|^\.load-check-.*\.sqlite(?:-journal)?)$/;

export const backupDirectory = (hubDir: string) => join(hubDir, BACKUP_DIR);

function ensurePrivateDirectory(directory: string, platform: NodeJS.Platform) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform !== 'win32' && (statSync(directory).mode & 0o077) !== 0) chmodSync(directory, 0o700);
}

/** A consistent copy of `source` at `target` (0600), through a `.partial` file renamed into place. */
export function copyDatabase(source: string, target: string, platform: NodeJS.Platform = process.platform) {
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  // VACUUM INTO needs a missing or empty file; creating it first fixes its mode before any data is written.
  closeSync(openSync(partial, 'wx', 0o600));
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.prepare('VACUUM INTO ?').run(partial);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  } finally {
    db.close();
  }
  if (platform !== 'win32') chmodSync(partial, 0o600);
  renameSync(partial, target);
  return target;
}

/** YYYY-MM-DD in the hub machine's own time zone (or `timeZone`). */
export const localDay = (at: Date, timeZone?: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

const stamp = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface BackupFile { path: string; name: string; kind: 'daily' | 'pre_update'; at: number }

export function listBackups(hubDir: string): BackupFile[] {
  const directory = backupDirectory(hubDir);
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  return names.flatMap(name => {
    const kind = DAILY.test(name) ? 'daily' as const : UPDATE.test(name) ? 'pre_update' as const : undefined;
    if (!kind) return [];
    const path = join(directory, name);
    try { return [{ path, name, kind, at: statSync(path).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
}

export const latestBackup = (hubDir: string) => listBackups(hubDir)[0];

/** Keeps the newest DAILY_BACKUPS_KEPT daily and UPDATE_BACKUPS_KEPT pre-update copies; removes leftovers of interrupted runs. */
export function pruneBackups(hubDir: string, now = new Date()) {
  const removed: string[] = [];
  const all = listBackups(hubDir);
  for (const [kind, keep] of [['daily', DAILY_BACKUPS_KEPT], ['pre_update', UPDATE_BACKUPS_KEPT]] as const) {
    // Names sort by date, so a copy whose mtime was touched still rotates by its own day.
    for (const file of all.filter(item => item.kind === kind).sort((a, b) => b.name.localeCompare(a.name)).slice(keep)) {
      rmSync(file.path, { force: true });
      removed.push(file.path);
    }
  }
  const directory = backupDirectory(hubDir);
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { /* no directory yet */ }
  for (const name of names.filter(item => LEFTOVER.test(item))) {
    const path = join(directory, name);
    try { if (now.getTime() - statSync(path).mtimeMs > 86_400_000) { rmSync(path, { force: true }); removed.push(path); } } catch { /* gone */ }
  }
  return removed;
}

export type BackupResult = { status: 'created' | 'exists'; path: string } | { status: 'missing_database'; path: string };

/** Today's daily copy, unless it already exists. */
export function dailyBackup(statePath: string, hubDir: string, options: { now?: Date; timeZone?: string; platform?: NodeJS.Platform } = {}): BackupResult {
  const now = options.now ?? new Date();
  const platform = options.platform ?? process.platform;
  if (!existsSync(statePath)) return { status: 'missing_database', path: statePath };
  const directory = backupDirectory(hubDir);
  const target = join(directory, `smartsell-${localDay(now, options.timeZone)}.sqlite`);
  if (existsSync(target)) return { status: 'exists', path: target };
  ensurePrivateDirectory(directory, platform);
  copyDatabase(statePath, target, platform);
  pruneBackups(hubDir, now);
  return { status: 'created', path: target };
}

/** The copy `pnpm hub:update` takes before it changes anything (AO-1). */
export function preUpdateBackup(statePath: string, hubDir: string, options: { now?: Date; platform?: NodeJS.Platform } = {}): BackupResult {
  const now = options.now ?? new Date();
  const platform = options.platform ?? process.platform;
  if (!existsSync(statePath)) return { status: 'missing_database', path: statePath };
  const directory = backupDirectory(hubDir);
  ensurePrivateDirectory(directory, platform);
  const target = join(directory, `pre-update-${stamp(now)}.sqlite`);
  copyDatabase(statePath, target, platform);
  pruneBackups(hubDir, now);
  return { status: 'created', path: target };
}

/** A throwaway private copy for `hub.ts --check --load`: the new code decodes this, never the live file. */
export function scratchCopy(statePath: string, hubDir: string, platform: NodeJS.Platform = process.platform) {
  const directory = backupDirectory(hubDir);
  ensurePrivateDirectory(directory, platform);
  const target = join(directory, `.load-check-${process.pid}-${randomBytes(4).toString('hex')}.sqlite`);
  copyDatabase(statePath, target, platform);
  return {
    path: target,
    remove() { for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true }); },
  };
}

/** sha256 of the stored snapshot, or null when there is none; undefined when the file cannot be read at all. */
export function snapshotDigest(path: string): string | null | undefined {
  if (!existsSync(path)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const row = db.prepare('SELECT payload FROM snapshot WHERE id = 1').get() as { payload?: string } | undefined;
    return typeof row?.payload === 'string' ? createHash('sha256').update(row.payload).digest('hex') : null;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/**
 * Puts `backup` back as the live data file. The current file (and its journal) is kept next to it as
 * `<file>.failed-update-<time>` so nothing written since the backup is lost for good. The hub must be stopped.
 */
export function restoreDatabase(backup: string, statePath: string, options: { now?: Date; platform?: NodeJS.Platform } = {}) {
  const platform = options.platform ?? process.platform;
  const aside = `${statePath}.failed-update-${stamp(options.now ?? new Date())}`;
  if (existsSync(statePath)) renameSync(statePath, aside);
  for (const suffix of ['-journal', '-wal', '-shm']) if (existsSync(`${statePath}${suffix}`)) renameSync(`${statePath}${suffix}`, `${aside}${suffix}`);
  const restoring = `${statePath}.restoring`;
  rmSync(restoring, { force: true });
  copyFileSync(backup, restoring);
  if (platform !== 'win32') chmodSync(restoring, 0o600);
  renameSync(restoring, statePath);
  return aside;
}

/**
 * The running hub's daily copy: checked a minute after startup and then every hour; makes today's copy when it is
 * missing. Failures are logged and retried at the next check; they never stop the hub.
 */
export function createBackupSchedule(options: { statePath: string; hubDir: string; log?: (line: string) => void; intervalMs?: number;
  firstDelayMs?: number; now?: () => Date; timeZone?: string; platform?: NodeJS.Platform }) {
  const log = options.log ?? ((line: string) => console.log(line));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  function runNow(): BackupResult | undefined {
    try {
      const result = dailyBackup(options.statePath, options.hubDir, { now: options.now?.(), timeZone: options.timeZone, platform: options.platform });
      if (result.status === 'created') log(`已備份資料：${result.path}`);
      return result;
    } catch (error) {
      log(`[警告] 每日備份失敗，一小時後再試：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => { runNow(); schedule(options.intervalMs ?? BACKUP_CHECK_INTERVAL_MS); }, ms);
    timer.unref?.();
  };
  return {
    runNow,
    start() { if (!timer && !stopped) schedule(options.firstDelayMs ?? 60_000); },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = undefined; },
  };
}
