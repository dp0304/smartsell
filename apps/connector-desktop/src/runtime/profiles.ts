// One Chrome profile per channel (§8.3): <userData>/chrome-profiles/<profile_key>/
// (0700), one Chrome process per profile, a lock file plus an in-process mutex
// so only one driver uses a profile at a time, and an idle close after 10
// minutes unless the owner is expected at that window.
import { existsSync, mkdirSync, readlinkSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ChromeBrowser, ChromeUnavailable, findChrome, type ChromeLaunchOptions } from '../chrome.ts';
import { ChromeCdpPage } from '../drivers/cdp-page.ts';
import type { CdpPage } from '../drivers/types.ts';

export class ProfileError extends Error {
  constructor(readonly code: 'chrome_unavailable' | 'profile_in_use', message: string) { super(message); this.name = 'ProfileError'; }
}

export interface BrowserHandle {
  openPage(): Promise<CdpPage>;
  close(): void;
  readonly closed: boolean;
  readonly pid?: number;
  /** Resolves true once the Chrome process is gone (false on timeout). Optional for test launchers. */
  exited?(timeoutMs: number): Promise<boolean>;
}
export type BrowserLauncher = (profileDir: string) => BrowserHandle;

export interface ProfileLease {
  readonly profileKey: string;
  readonly dir: string;
  readonly page: CdpPage;
  /** Keeps Chrome open after release (owner must act in this window: assist, a blocker, or a post to finish by hand). */
  pin(on: boolean): void;
  release(): void;
}

export const PROFILE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

function untilAborted(wait: Promise<void>, signal?: AbortSignal) {
  if (!signal) return wait;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    wait.then(() => { signal.removeEventListener('abort', abort); resolve(); });
  });
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

interface Slot { handle?: BrowserHandle; page?: CdpPage; busy: Promise<void>; lastUsed: number; pinned: boolean; leased: boolean }

export interface ProfilesOptions {
  root: string;
  launch: BrowserLauncher;
  idleMs?: number;
  now?: () => number;
}

export class Profiles {
  readonly root: string;
  readonly #launch: BrowserLauncher;
  readonly #idleMs: number;
  readonly #now: () => number;
  readonly #slots = new Map<string, Slot>();

  constructor(options: ProfilesOptions) {
    this.root = options.root;
    this.#launch = options.launch;
    this.#idleMs = options.idleMs ?? 10 * 60_000;
    this.#now = options.now ?? Date.now;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  dirFor(profileKey: string) {
    if (!PROFILE_KEY.test(profileKey)) throw new TypeError('Invalid Chrome profile key');
    return join(this.root, profileKey);
  }

  /** Creates the profile folder for a channel bound to this machine (heartbeat channels[], §5.4.1). */
  ensure(profileKey: string) {
    const dir = this.dirFor(profileKey);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* Windows ignores POSIX modes. */ }
    return dir;
  }

  #lockPath(dir: string) { return join(dir, '.smartsell.lock'); }

  /** Another Chrome (not started by this Worker) holding the folder makes Chrome refuse it (§8.3). */
  #foreignChrome(dir: string, ours?: number) {
    try {
      const target = readlinkSync(join(dir, 'SingletonLock'));
      const pid = Number(/-(\d+)$/.exec(target)?.[1]);
      return Number.isSafeInteger(pid) && pid !== ours && alive(pid);
    } catch { return false; }
  }

  #takeLock(dir: string) {
    const path = this.#lockPath(dir);
    if (existsSync(path)) {
      try {
        const held = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; host?: string };
        if (held.pid && held.pid !== process.pid && held.host === hostname() && alive(held.pid)) {
          throw new ProfileError('profile_in_use', '另一個 SmartSell Worker 正在使用這個 Chrome profile。');
        }
      } catch (error) { if (error instanceof ProfileError) throw error; }
    }
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }), { mode: 0o600 });
  }

  async acquire(profileKey: string, signal?: AbortSignal): Promise<ProfileLease> {
    const dir = this.ensure(profileKey);
    let slot = this.#slots.get(profileKey);
    if (!slot) { slot = { busy: Promise.resolve(), lastUsed: this.#now(), pinned: false, leased: false }; this.#slots.set(profileKey, slot); }
    // In-process mutex: wait for the previous lease of this profile.
    let unlock!: () => void;
    const previous = slot.busy;
    slot.busy = new Promise<void>(resolve => { unlock = resolve; });
    try { await untilAborted(previous, signal); }
    catch (error) {
      // Keep the chain intact: whoever waits behind us gets the profile once the current holder releases it.
      void previous.then(unlock);
      throw error;
    }
    try {
      signal?.throwIfAborted();
      if (!slot.handle || slot.handle.closed) {
        slot.page = undefined;
        if (this.#foreignChrome(dir)) throw new ProfileError('profile_in_use', '這個 Chrome profile 目前被其他 Chrome 視窗占用。');
        this.#takeLock(dir);
        slot.handle = this.#launch(dir);
      }
      if (slot.page) {
        try { await slot.page.url(); } catch { slot.page = undefined; }
      }
      if (!slot.page) {
        try { slot.page = await slot.handle.openPage(); }
        catch (error) {
          slot.handle.close();
          slot.handle = undefined;
          rmSync(this.#lockPath(dir), { force: true });
          if (error instanceof ProfileError) throw error;
          if (error instanceof ChromeUnavailable) throw new ProfileError('chrome_unavailable', error.message);
          if (this.#foreignChrome(dir)) throw new ProfileError('profile_in_use', '這個 Chrome profile 目前被其他 Chrome 視窗占用。');
          throw new ProfileError('chrome_unavailable', error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) { unlock(); throw error; }
    slot.leased = true;
    // A new lease takes the window over: an earlier pin (the owner's 「開啟 Chrome」, a post left for the owner)
    // no longer applies once the Worker uses this profile again; the lease pins again when it needs the owner.
    slot.pinned = false;
    const page = slot.page;
    const lease: ProfileLease = {
      profileKey, dir, page,
      pin: on => { slot!.pinned = on; },
      release: () => {
        if (!slot!.leased) return;
        slot!.leased = false;
        slot!.lastUsed = this.#now();
        unlock();
      },
    };
    return lease;
  }

  /**
   * Brings the profile's open tab to the front without taking the driver lock, and keeps Chrome open for the owner.
   * Focusing a window neither navigates nor reloads, so it is safe while a driver observes that tab read-only.
   * Returns false when this profile's Chrome is not running.
   */
  async bringToFront(profileKey: string) {
    const slot = this.#slots.get(profileKey);
    if (!slot?.handle || slot.handle.closed || !slot.page) return false;
    try { await slot.page.bringToFront(); } catch { return false; }
    slot.pinned = true;
    return true;
  }

  /** Closes Chrome for profiles idle longer than idleMs that are not pinned (§8.3). */
  closeIdle() {
    for (const [key, slot] of this.#slots) {
      if (slot.leased || slot.pinned || !slot.handle || slot.handle.closed) continue;
      if (this.#now() - slot.lastUsed < this.#idleMs) continue;
      this.#close(key, slot);
    }
  }

  #close(key: string, slot: Slot) {
    slot.handle?.close();
    slot.handle = undefined;
    slot.page = undefined;
    try { rmSync(this.#lockPath(this.dirFor(key)), { force: true }); } catch { /* Folder already gone. */ }
  }

  closeAll() { for (const [key, slot] of this.#slots) this.#close(key, slot); }

  /**
   * Closes one profile's Chrome, waits for the process to exit and removes its lock (§8.16: adopting the hub's
   * profile key after re-registration renames the enrolment folder). Refuses while a driver holds the profile.
   */
  async close(profileKey: string, timeoutMs = 10_000) {
    const slot = this.#slots.get(profileKey);
    if (!slot) { try { rmSync(this.#lockPath(this.dirFor(profileKey)), { force: true }); } catch { /* invalid key or folder gone */ } return; }
    if (slot.leased) throw new ProfileError('profile_in_use', '這個 Chrome profile 正在被 SmartSell 使用，稍後再試。');
    const handle = slot.handle;
    this.#close(profileKey, slot);
    this.#slots.delete(profileKey);
    if (handle?.exited && !await handle.exited(timeoutMs)) {
      throw new ProfileError('profile_in_use', '這個 Chrome 沒有在時限內關閉。');
    }
  }

  running() { return [...this.#slots.entries()].filter(([, slot]) => slot.handle && !slot.handle.closed).map(([key]) => key); }
}

/** Real launcher: stock Chrome over the CDP pipe with one --user-data-dir per channel. */
export function chromeLauncher(options: { headless?: boolean; allowUrl(url: URL): boolean; sleep(ms: number): Promise<void>; executable?: typeof findChrome }): BrowserLauncher {
  return dir => {
    const launch: ChromeLaunchOptions = { headless: options.headless, restoreSession: false };
    const browser = new ChromeBrowser(dir, options.executable ?? findChrome, launch);
    let closed = false;
    let started = false;
    let lastPid: number | undefined;
    return {
      get closed() { return closed || (browser.session === 0 && browser.pid === undefined && started); },
      get pid() { return browser.pid; },
      async exited(timeoutMs: number) {
        const pid = browser.pid ?? lastPid;
        if (pid === undefined) return true;
        const deadline = Date.now() + timeoutMs;
        while (alive(pid)) {
          if (Date.now() >= deadline) return false;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return true;
      },
      async openPage() {
        started = true;
        const pipe = await browser.pipe();
        lastPid = browser.pid;
        const { targetInfos } = await pipe.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
        const blank = targetInfos.find(target => target.type === 'page' && target.url === 'about:blank');
        return ChromeCdpPage.open(pipe, { allowUrl: url => url.protocol === 'about:' || options.allowUrl(url), sleep: options.sleep }, blank?.targetId);
      },
      close() { lastPid = browser.pid ?? lastPid; closed = true; browser.close(); },
    };
  };
}
