// 「有新版本」 prompt (§8.18). Not a silent updater: heartbeat v2 carries
// latest_worker; when it is newer the tray shows a badge and one OS
// notification goes out. Only when the owner presses 「更新」 the package is
// downloaded (device-signed GET from the hub), its SHA-256 checked, and the
// installer opened (macOS: the dmg to drag over the old App; Windows: NSIS).
// Updating is refused while a job is running/submitting/result_pending and
// needs an explicit confirmation when a job is due within 30 minutes.
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LocalJobView, UpdateAvailableEvent } from '../runtime/events.ts';
import { COPY, type Notifier } from './notify.ts';

const VERSION = /^(\d{1,5})\.(\d{1,5})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$/;
export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
export const DUE_SOON_MS = 30 * 60_000;
/** Local states during which the platform post may be in flight (§8.18). */
export const UPDATE_BLOCKING_STATES = ['running', 'submitting', 'result_pending'] as const;

/** Orders `major.minor.patch[-pre]`; a pre-release sorts before its release; unparsable versions are never newer. */
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a), right = VERSION.exec(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index++) {
    const delta = Number(left[index]) - Number(right[index]);
    if (delta) return Math.sign(delta);
  }
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  const l = left[4].split('.'), r = right[4].split('.');
  for (let index = 0; index < Math.max(l.length, r.length); index++) {
    if (l[index] === undefined) return -1;
    if (r[index] === undefined) return 1;
    const ln = /^\d+$/.test(l[index]) ? Number(l[index]) : NaN, rn = /^\d+$/.test(r[index]) ? Number(r[index]) : NaN;
    if (!Number.isNaN(ln) && !Number.isNaN(rn) && ln !== rn) return Math.sign(ln - rn);
    if (l[index] !== r[index]) return l[index] < r[index] ? -1 : 1;
  }
  return 0;
}

export type WorkerPackage = 'mac-arm64' | 'mac-x64' | 'win-x64';
const PACKAGES: readonly string[] = ['mac-arm64', 'mac-x64', 'win-x64'];

/** The offered package: `platform` from heartbeat latest_worker when present, else the download URL's last segment. */
export function offeredPackage(event: UpdateAvailableEvent): WorkerPackage | null {
  if (event.platform && PACKAGES.includes(event.platform)) return event.platform;
  const segment = event.url.split(/[?#]/)[0].split('/').pop() ?? '';
  return PACKAGES.includes(segment) ? segment as WorkerPackage : null;
}

export function updateGate(jobs: readonly LocalJobView[], now: number) {
  const running = jobs.filter(job => (UPDATE_BLOCKING_STATES as readonly string[]).includes(job.state));
  const dueSoon = jobs.filter(job => job.kind === 'publish_post' && !running.includes(job) && Date.parse(job.not_before) - now <= DUE_SOON_MS);
  return { blocked: running.length > 0, running, dueSoon };
}

export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'verified' | 'installing' | 'failed';
export type UpdateResult =
  | { ok: true; path: string }
  | { ok: false; code: 'NO_UPDATE' | 'JOB_RUNNING' | 'DUE_SOON' | 'BUSY' | 'DOWNLOAD_FAILED' | 'HASH_MISMATCH' | 'BAD_URL'; message: string };

export interface UpdateDeps {
  currentVersion: string;
  platform: NodeJS.Platform;
  /** Hub origin from the pairing; the package URL must be on it. */
  hubOrigin: string;
  /** Where packages are downloaded (`<userData>/updates`). */
  dir: string;
  /** Device-signed GET of a hub path (`worker_download.read:<platform>`); `platform` is the package the hub offered. */
  download(url: URL, signal: AbortSignal, platform: WorkerPackage | null): Promise<Response>;
  /** Opens the verified package: macOS mounts the dmg, Windows runs the NSIS installer. Then the App quits. */
  openInstaller(path: string): Promise<void>;
  jobs(): LocalJobView[];
  /**
   * This machine's package (`mac-arm64`, `mac-x64`, `win-x64`). Since E9 the hub picks the package by the heartbeat's
   * `arch`; an offer for another package (a hub without E9 offers mac-arm64 to every Mac) is still ignored, because
   * installing it would replace a working App with one this CPU cannot run.
   */
  platformKey?: string | null;
  notifier?: Pick<Notifier, 'notify'>;
  now?(): number;
  onChange?(): void;
  log?(message: string, detail?: object): void;
}

function extensionFor(type: string | null, platform: NodeJS.Platform) {
  if (type?.includes('apple-diskimage')) return 'dmg';
  if (type?.includes('zip')) return 'zip';
  if (platform === 'win32') return 'exe';
  return 'dmg';
}

export class UpdateManager {
  readonly #deps: UpdateDeps;
  #offer: UpdateAvailableEvent | null = null;
  #phase: UpdatePhase = 'idle';
  #message: string | null = null;
  #progress = 0;
  #abort?: AbortController;

  constructor(deps: UpdateDeps) { this.#deps = deps; }

  /** C11 `update_available`. Returns true when this is a newer version than the running App. */
  offer(event: UpdateAvailableEvent): boolean {
    if (compareVersions(event.version, this.#deps.currentVersion) <= 0 || !/^[0-9a-f]{64}$/.test(event.sha256)) return false;
    // Never prompt for a package this machine cannot run (guard against a hub that does not pick by arch yet).
    const offered = offeredPackage(event);
    if (this.#deps.platformKey && offered && offered !== this.#deps.platformKey) {
      this.#deps.log?.('update offer for another platform ignored', { offered, mine: this.#deps.platformKey, version: event.version });
      return false;
    }
    if (this.#offer && compareVersions(event.version, this.#offer.version) < 0) return false;
    const changed = this.#offer?.version !== event.version || this.#offer.sha256 !== event.sha256;
    this.#offer = { ...event };
    if (changed && this.#phase !== 'downloading' && this.#phase !== 'installing') { this.#phase = 'available'; this.#message = null; }
    if (changed) this.#deps.notifier?.notify({ title: COPY.updateAvailableTitle, body: COPY.updateAvailable(event.version), key: `update:${event.version}` });
    this.#deps.onChange?.();
    return true;
  }

  snapshot() {
    const now = (this.#deps.now ?? Date.now)();
    const gate = updateGate(this.#deps.jobs(), now);
    return {
      available: this.#offer ? { version: this.#offer.version } : null, phase: this.#phase, message: this.#message, progress: this.#progress,
      blocked: gate.blocked, due_soon: gate.dueSoon.length,
      keychain_notice: this.#deps.platform === 'darwin' ? '更新後請留在這台機器前，出現鑰匙圈提示時按「永遠允許」；否則 Worker 無法連線。' : null,
    };
  }

  /** Download, verify and open the installer. `confirmDueSoon` answers the 30-minute warning. */
  async install(options: { confirmDueSoon?: boolean } = {}): Promise<UpdateResult> {
    const offer = this.#offer;
    if (!offer) return { ok: false, code: 'NO_UPDATE', message: '目前沒有可更新的版本。' };
    if (this.#phase === 'downloading' || this.#phase === 'installing') return { ok: false, code: 'BUSY', message: '更新正在進行中。' };
    const gate = updateGate(this.#deps.jobs(), (this.#deps.now ?? Date.now)());
    if (gate.blocked) {
      return this.#fail('JOB_RUNNING', `有 ${gate.running.length} 則貼文正在發布（${gate.running.map(job => job.channel_label).join('、')}），發布結束後才能更新。`, false);
    }
    if (gate.dueSoon.length && !options.confirmDueSoon) {
      return { ok: false, code: 'DUE_SOON', message: `30 分鐘內有 ${gate.dueSoon.length} 則貼文到期；更新期間 Worker 會離線，可能錯過。仍要更新嗎？` };
    }
    let url: URL;
    try {
      url = new URL(offer.url, this.#deps.hubOrigin);
      if (url.origin !== new URL(this.#deps.hubOrigin).origin) throw new Error('foreign origin');
    } catch { return this.#fail('BAD_URL', '中樞提供的更新網址不在這個中樞上，已拒絕下載。'); }

    this.#phase = 'downloading';
    this.#progress = 0;
    this.#message = null;
    this.#abort = new AbortController();
    this.#deps.onChange?.();
    mkdirSync(this.#deps.dir, { recursive: true, mode: 0o700 });
    let part: string | undefined;
    try {
      const response = await this.#deps.download(url, this.#abort.signal, offeredPackage(offer));
      if (!response.ok || !response.body) return this.#fail('DOWNLOAD_FAILED', `下載更新失敗（HTTP ${response.status}）。請稍後再試。`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES) return this.#fail('DOWNLOAD_FAILED', '安裝包大小不合理，已拒絕下載。');
      const name = `SmartSell-Worker-${offer.version}.${extensionFor(response.headers.get('content-type'), this.#deps.platform)}`;
      part = join(this.#deps.dir, `${name}.part`);
      const hash = createHash('sha256');
      let bytes = 0;
      const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        hash.update(chunk);
        if (bytes > MAX_PACKAGE_BYTES) source.destroy(new Error('too large'));
        if (Number.isFinite(declared) && declared > 0) this.#progress = Math.min(1, bytes / declared);
      });
      await pipeline(source, createWriteStream(part, { mode: 0o600 }), { signal: this.#abort.signal });
      const digest = hash.digest('hex');
      if (digest !== offer.sha256) {
        rmSync(part, { force: true });
        this.#deps.log?.('update package hash mismatch', { expected: offer.sha256, actual: digest, bytes });
        return this.#fail('HASH_MISMATCH', '下載的安裝包 SHA-256 與中樞公布的不符，已刪除，沒有安裝。');
      }
      const path = join(this.#deps.dir, name);
      renameSync(part, path);
      part = undefined;
      this.#phase = 'installing';
      this.#progress = 1;
      this.#deps.onChange?.();
      await this.#deps.openInstaller(path);
      return { ok: true, path };
    } catch (error) {
      if (part) rmSync(part, { force: true });
      this.#deps.log?.('update download failed', { error: String(error) });
      return this.#fail('DOWNLOAD_FAILED', '下載更新失敗。請確認中樞連得上後再試。');
    } finally { this.#abort = undefined; }
  }

  cancel() { this.#abort?.abort(); }

  #fail(code: Exclude<UpdateResult, { ok: true }>['code'], message: string, failed = true): UpdateResult {
    if (failed) this.#phase = 'failed';
    else if (this.#phase !== 'downloading') this.#phase = this.#offer ? 'available' : 'idle';
    else this.#phase = 'available';
    this.#message = message;
    this.#deps.onChange?.();
    return { ok: false, code, message };
  }
}
