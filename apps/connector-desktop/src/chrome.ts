import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { xPostsScript, type XPostsObservation } from './x-posts.ts';
import { canInspect, observationScript, type ChannelId, type Observation } from './channels.ts';
import { ZhihuChrome, type ZhihuBrowser } from './zhihu-chrome.ts';
import { zhihuObservationScript, zhihuOrigin, zhihuSignIn, type VisibleZhihu, type ZhihuProfileStep } from './zhihu-dom.ts';

export class ChromeUnavailable extends Error {
  constructor() { super('找不到 Google Chrome。请安装 Chrome 后重试。'); }
}

declare const RELEASE: { packaged?: boolean } | undefined;
/** True only inside an installer build (esbuild defines RELEASE.packaged). Test switches are refused there. */
export function isPackagedBuild() {
  return typeof RELEASE !== 'undefined' && RELEASE?.packaged === true;
}
/** SMARTSELL_TEST_MODE=1 is honoured only outside packaged builds (§8.14). */
export function testModeEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.SMARTSELL_TEST_MODE === '1' && !isPackagedBuild();
}

export async function findChrome(platform = process.platform, env = process.env, home = homedir()) {
  const executable = 'Google Chrome.app/Contents/MacOS/Google Chrome';
  // The override exists for CI and the headless runner; it is ignored outside test mode.
  const override = testModeEnabled(env) && env.SMARTSELL_CHROME_PATH ? [env.SMARTSELL_CHROME_PATH] : [];
  const paths = [...override, ...(platform === 'darwin' ? [join('/Applications', executable), join(home, 'Applications', executable)]
    : platform === 'win32' ? [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
      .filter((value): value is string => Boolean(value && /^[A-Za-z]:[\\/]/.test(value)))
      .map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    : platform === 'linux' ? ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'] : [])];
  for (const path of paths) {
    try { await access(path, constants.X_OK); return path; }
    catch { /* Try the next standard installation directory. */ }
  }
  return undefined;
}

const closedError = () => new Error('Chrome 会话已关闭。请重新打开渠道页面。');
const failedError = () => new Error('无法连接到连接器专用 Chrome。请关闭该专用窗口后重试。');

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; method: string };
export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };
/** Raised for a CDP protocol error; `cdpMessage` keeps Chrome's text for driver diagnostics. */
export class CdpCallError extends Error {
  constructor(message: string, readonly cdpMethod: string, readonly cdpMessage: string) { super(message); this.name = 'CdpCallError'; }
}
/** The subset of the Chrome pipe that drivers/cdp-page.ts uses (§8.1 `pipe()`). */
export interface CdpPipe {
  readonly closed: boolean;
  send<T = unknown>(method: string, params?: object, sessionId?: string, timeout?: number): Promise<T>;
  onEvent(listener: (event: CdpEvent) => void): () => void;
}

class ChromePipe implements CdpPipe {
  #id = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: CdpEvent) => void>();
  #remainder: Buffer = Buffer.alloc(0);
  #input: Duplex;
  #closed = false;

  constructor(private readonly child: ChildProcess) {
    this.#input = child.stdio[3] as Duplex;
    const output = child.stdio[4] as Duplex;
    child.once('error', () => this.#finish(failedError()));
    child.once('exit', () => this.#finish(closedError()));
    this.#input.on('error', () => this.#finish(closedError()));
    output.on('error', () => this.#finish(closedError()));
    output.on('end', () => this.#finish(closedError()));
    output.on('data', (chunk: Buffer) => this.#read(chunk));
  }

  get closed() { return this.#closed; }

  #finish(error: Error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject, timer } of this.#pending.values()) { clearTimeout(timer); reject(error); }
    this.#pending.clear();
  }

  #read(chunk: Buffer) {
    const bytes = this.#remainder.length ? Buffer.concat([this.#remainder, chunk]) : chunk;
    let start = 0, end: number;
    while ((end = bytes.indexOf(0, start)) >= 0) {
      try {
        const reply = JSON.parse(bytes.toString('utf8', start, end));
        const pending = typeof reply.id === 'number' ? this.#pending.get(reply.id) : undefined;
        if (pending) {
          this.#pending.delete(reply.id);
          clearTimeout(pending.timer);
          if (reply.error) pending.reject(new CdpCallError('Chrome 页面或标签页已变化，请重试。', pending.method, String(reply.error.message ?? '')));
          else pending.resolve(reply.result);
        } else if (typeof reply.method === 'string' && reply.id === undefined) {
          const event: CdpEvent = { method: reply.method, params: reply.params ?? {}, sessionId: reply.sessionId };
          for (const listener of this.#listeners) {
            try { listener(event); } catch { /* A listener must not break the pipe. */ }
          }
        }
      } catch { /* Ignore malformed messages. */ }
      start = end + 1;
    }
    this.#remainder = bytes.subarray(start);
    if (this.#remainder.length > 1024 * 1024) this.close();
  }

  async send<T = unknown>(method: string, params = {}, sessionId?: string, timeout = 5000): Promise<T> {
    if (this.#closed) throw closedError();
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Chrome 页面没有及时响应，请切回该标签页后重试。'));
      }, timeout);
      this.#pending.set(id, { resolve: value => resolve(value as T), reject, timer, method });
      this.#input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  onEvent(listener: (event: CdpEvent) => void) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  get pid() { return this.child.pid; }

  close() {
    if (this.#closed) return;
    void this.send('Browser.close', {}, undefined, 1000).catch(() => this.child.kill());
  }
}

/**
 * Launch options. `headless` is set only by the headless runner (§8.1, §8.14);
 * `restoreSession: false` keeps per-channel driver profiles from reopening
 * stale compose tabs. No option adds or removes automation-signalling flags.
 */
export interface ChromeLaunchOptions { headless?: boolean; restoreSession?: boolean }

type Tab = { targetId: string; sessionId: string };
type Target = { targetId: string; type: string; url: string };
export type ChannelBrowser = {
  readonly session: number;
  connect?(signal: AbortSignal): Promise<void>;
  open(id: string, url: string, signal: AbortSignal): Promise<void>;
  hasTab(id: ChannelId): Promise<boolean>;
  recoverTabs?(ids: readonly ChannelId[], signal: AbortSignal): Promise<void>;
  focus(id: string, signal: AbortSignal): Promise<void>;
  inspect(id: ChannelId, signal: AbortSignal): Promise<Observation>;
  readRecentX?(expected: string | undefined, signal: AbortSignal): Promise<XPostsObservation>;
  click(id: ChannelId, point: { x: number; y: number }, signal: AbortSignal): Promise<void>;
};

export class ChromeBrowser implements ChannelBrowser {
  #pipe?: ChromePipe;
  #starting?: Promise<ChromePipe>;
  #tabs = new Map<string, Tab>();
  #generation = 0;
  #disposed = false;
  #openingZhihu = false;
  #zhihuTab?: Tab;
  readonly zhihu: ZhihuBrowser = new ZhihuChrome({
    open: signal => this.#openZhihu(signal),
    observe: (signal, slug, menuOpened, loginCheck) => this.#observeZhihu(signal, slug, menuOpened, loginCheck),
    click: async (step, signal, menuOpened) => (await this.#observeZhihu(signal, undefined, menuOpened, false, step)).kind === 'clicked',
  });

  constructor(private readonly directory: string, private readonly executable = findChrome, private readonly options: ChromeLaunchOptions = {}) {}

  get session() { return this.#pipe?.closed ? 0 : this.#pipe ? this.#generation : 0; }

  /** The profile directory this Chrome instance owns (one per channel, §8.3). */
  get profileDir() { return this.directory; }

  /** Process id of the Chrome this instance launched, when running. */
  get pid() { return this.#pipe && !this.#pipe.closed ? this.#pipe.pid : undefined; }

  /** Starts Chrome when needed and returns its CDP pipe for drivers/cdp-page.ts. */
  async pipe(signal?: AbortSignal): Promise<CdpPipe> {
    return this.#start(signal);
  }

  async #start(signal?: AbortSignal) {
    if (this.#disposed) throw closedError();
    if (this.#pipe && !this.#pipe.closed) return this.#pipe;
    this.#starting ??= this.#launch(signal).finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #hasSavedSession() {
    try { await access(join(this.directory, 'Default', 'Sessions')); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  async #launch(signal?: AbortSignal) {
    const executable = await this.executable();
    if (!executable) throw new ChromeUnavailable();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const restore = this.options.restoreSession !== false && await this.#hasSavedSession();
    const startPage = restore ? '--restore-last-session' : 'about:blank';
    if (this.#disposed) throw closedError();
    signal?.throwIfAborted();
    // Headless runs (CI and E2E only) use a mock keychain so a fresh profile never raises an OS keychain prompt.
    const headless = this.options.headless ? ['--headless=new', '--use-mock-keychain', '--password-store=basic'] : [];
    const pipe = new ChromePipe(spawn(executable, [
      `--user-data-dir=${this.directory}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
      '--disable-background-mode', ...headless, startPage,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false }));
    try {
      const version = await pipe.send<{ product: string }>('Browser.getVersion', {}, undefined, 12_000);
      signal?.throwIfAborted();
      if (this.#disposed) throw closedError();
      if (!/^Chrome\//.test(version.product)) throw failedError();
    } catch (error) { pipe.close(); throw error; }
    this.#tabs.clear();
    this.#zhihuTab = undefined;
    this.#pipe = pipe;
    this.#generation++;
    return pipe;
  }

  async #targets(pipe: ChromePipe) {
    return (await pipe.send<{ targetInfos: Target[] }>('Target.getTargets')).targetInfos;
  }

  async connect(signal: AbortSignal) {
    signal.throwIfAborted();
    const pipe = await this.#start(signal);
    signal.throwIfAborted();
    const targets = await this.#targets(pipe);
    signal.throwIfAborted();
    const page = targets.find(target => target.type === 'page');
    const { targetId } = page ?? await pipe.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    signal.throwIfAborted();
    await pipe.send('Target.activateTarget', { targetId });
    signal.throwIfAborted();
  }

  async hasTab(id: ChannelId) {
    const tab = this.#tabs.get(id), pipe = this.#pipe;
    return Boolean(pipe && !pipe.closed && tab && (await this.#targets(pipe)).some(target =>
      target.targetId === tab.targetId && canInspect(id, target.url)));
  }

  async recoverTabs(ids: readonly ChannelId[], signal: AbortSignal) {
    if (!this.session && !await this.#hasSavedSession()) return;
    const pipe = await this.#start(signal);
    const targets = await this.#targets(pipe);
    const occupied = new Set([...this.#tabs.values(), this.#zhihuTab].map(tab => tab?.targetId));
    for (const id of ids) {
      signal.throwIfAborted();
      if (await this.hasTab(id)) continue;
      const matches = targets.filter(target => target.type === 'page' && !occupied.has(target.targetId) && canInspect(id, target.url));
      if (matches.length !== 1) continue;
      const { targetId } = matches[0];
      const { sessionId } = await pipe.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      this.#tabs.set(id, { targetId, sessionId });
      occupied.add(targetId);
    }
  }

  async #tab(id: string, pipe: ChromePipe, signal: AbortSignal) {
    const targets = await this.#targets(pipe);
    signal.throwIfAborted();
    const current = this.#tabs.get(id);
    if (current && targets.some(target => target.targetId === current.targetId)) return current;
    const occupied = new Set([...this.#tabs.values()].map(tab => tab.targetId));
    // A newly created Zhihu target can momentarily appear as about:blank before navigation.
    const blank = this.#openingZhihu ? undefined : targets.find(target => target.type === 'page' && target.url === 'about:blank' &&
      target.targetId !== this.#zhihuTab?.targetId && !occupied.has(target.targetId));
    const targetId = blank?.targetId ?? (await pipe.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    signal.throwIfAborted();
    const { sessionId } = await pipe.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const tab = { targetId, sessionId };
    this.#tabs.set(id, tab);
    return tab;
  }

  async open(id: string, input: string, signal: AbortSignal) {
    const url = URL.parse(input);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Chrome 渠道需要受支持的 HTTPS 地址。');
    signal.throwIfAborted();
    const pipe = await this.#start();
    const tab = await this.#tab(id, pipe, signal);
    signal.throwIfAborted();
    await pipe.send('Target.activateTarget', { targetId: tab.targetId });
    signal.throwIfAborted();
    // Navigating via CDP opens a real foreground tab. The operator handles every login step.
    const result = await pipe.send<{ errorText?: string }>('Page.navigate', { url: url.href }, tab.sessionId, 15_000);
    signal.throwIfAborted();
    if (result.errorText) throw new Error('Chrome 未能打开官方页面，请检查网络后重试。');
  }

  async focus(id: string, signal: AbortSignal) {
    const pipe = this.#pipe, tab = this.#tabs.get(id);
    if (!pipe || !tab) throw closedError();
    signal.throwIfAborted();
    await pipe.send('Target.activateTarget', { targetId: tab.targetId });
    signal.throwIfAborted();
  }

  async inspect(id: ChannelId, signal: AbortSignal): Promise<Observation> {
    const pipe = this.#pipe, tab = this.#tabs.get(id);
    if (!pipe || !tab || pipe.closed) throw closedError();
    signal.throwIfAborted();
    const { frameTree } = await pipe.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree', {}, tab.sessionId);
    if (!canInspect(id, frameTree.frame.url)) return { kind: 'unknown', invalidated: true };
    signal.throwIfAborted();
    const { executionContextId } = await pipe.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'SmartSell visible identity',
    }, tab.sessionId);
    signal.throwIfAborted();
    const reply = await pipe.send<{ result: { value?: Observation } }>('Runtime.evaluate', {
      expression: observationScript(id), contextId: executionContextId, returnByValue: true, timeout: 1000,
    }, tab.sessionId);
    signal.throwIfAborted();
    return reply.result.value ?? { kind: 'unknown' };
  }

  async readRecentX(expected: string | undefined, signal: AbortSignal): Promise<XPostsObservation> {
    const pipe = this.#pipe, tab = this.#tabs.get('x');
    if (!pipe || !tab || pipe.closed) return { kind: 'unverified' };
    let navigationApproved = false;
    let navigationAttempted = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      signal.throwIfAborted();
      try {
        const { frameTree } = await pipe.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree', {}, tab.sessionId);
        if (frameTree.frame.url === 'about:blank') {
          await pause(300, undefined, { signal });
          continue;
        }
        if (URL.parse(frameTree.frame.url)?.origin !== 'https://x.com') return { kind: 'unverified' };
        signal.throwIfAborted();
        const { executionContextId } = await pipe.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
          frameId: frameTree.frame.id, worldName: 'SmartSell visible X posts',
        }, tab.sessionId);
        signal.throwIfAborted();
        const navigate = navigationApproved && !navigationAttempted;
        if (navigate) navigationAttempted = true;
        const reply = await pipe.send<{ result: { value?: XPostsObservation } }>('Runtime.evaluate', {
          expression: xPostsScript(expected, navigate), contextId: executionContextId, returnByValue: true, timeout: 1000,
        }, tab.sessionId);
        signal.throwIfAborted();
        const observation = reply.result.value;
        if (observation?.kind === 'profile' && !navigationAttempted) {
          expected = observation.identity;
          navigationApproved = true;
        } else if (observation?.kind === 'posts' || observation?.kind === 'identity_mismatch' || observation?.kind === 'login_required') return observation;
      } catch {
        // The page may discard its execution context during the single navigation.
        signal.throwIfAborted();
      }
      await pause(300, undefined, { signal });
    }
    return { kind: 'unverified' };
  }

  async click(id: ChannelId, point: { x: number; y: number }, signal: AbortSignal) {
    const pipe = this.#pipe, tab = this.#tabs.get(id);
    if (!pipe || !tab) throw closedError();
    // Re-check on the current document before a real click in case a redirect just occurred.
    const observed = await this.inspect(id, signal);
    if (observed.kind !== 'unknown' || !observed.control || Math.abs(observed.control.x - point.x) > 2 || Math.abs(observed.control.y - point.y) > 2) return;
    signal.throwIfAborted();
    const { x, y } = observed.control;
    await pipe.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, tab.sessionId);
    await pipe.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, tab.sessionId);
    signal.throwIfAborted();
  }

  async #openZhihu(signal: AbortSignal) {
    signal.throwIfAborted();
    const pipe = await this.#start(signal);
    signal.throwIfAborted();
    const current = this.#zhihuTab;
    if (current && (await this.#targets(pipe)).some(target => target.targetId === current.targetId)) {
      // Preserve any manual sign-in or verification already in progress in this tab.
      signal.throwIfAborted();
      return;
    }
    signal.throwIfAborted();
    this.#openingZhihu = true;
    let targetId: string | undefined;
    try {
      ({ targetId } = await pipe.send<{ targetId: string }>('Target.createTarget', { url: zhihuSignIn }));
      signal.throwIfAborted();
      const { sessionId } = await pipe.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      signal.throwIfAborted();
      this.#zhihuTab = { targetId, sessionId };
    } catch (error) {
      if (targetId) await pipe.send('Target.closeTarget', { targetId }, undefined, 1000).catch(() => {});
      throw error;
    } finally { this.#openingZhihu = false; }
  }

  async #observeZhihu(signal: AbortSignal, slug?: string, menuOpened = false, loginCheck = false, approved?: ZhihuProfileStep): Promise<VisibleZhihu> {
    const pipe = this.#pipe, tab = this.#zhihuTab;
    signal.throwIfAborted();
    if (!pipe || !tab || pipe.closed) return { kind: 'manual' };
    try {
      const { frameTree } = await pipe.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree', {}, tab.sessionId);
      signal.throwIfAborted();
      if (frameTree.frame.url === 'about:blank') return { kind: 'waiting' };
      const url = URL.parse(frameTree.frame.url);
      if (url?.origin !== zhihuOrigin || url.username || url.password) return { kind: 'off-origin' };
      const { executionContextId } = await pipe.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id, worldName: 'SmartSell Zhihu visible stats',
      }, tab.sessionId);
      signal.throwIfAborted();
      const reply = await pipe.send<{ result?: { value?: VisibleZhihu } }>('Runtime.evaluate', {
        expression: zhihuObservationScript(slug, menuOpened, loginCheck, approved), contextId: executionContextId, returnByValue: true, timeout: 1000,
      }, tab.sessionId);
      signal.throwIfAborted();
      return reply.result?.value ?? { kind: 'waiting' };
    } catch {
      signal.throwIfAborted();
      return { kind: 'waiting' }; // Never fall back to a previous document or result.
    }
  }

  close() {
    this.#disposed = true;
    this.#pipe?.close();
  }
}
