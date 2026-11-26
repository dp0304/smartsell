// Remote control on this machine (core-automation-proposal §2 item 2, step 4): the owner's Agent looks at a page in the
// owner's own Chrome and acts on it one step at a time — for long-tail work no driver covers (a store backend, a reply).
// The hub relays each command; this file turns it into page actions and answers with a fresh snapshot.
//
// Boundaries (the hub enforces them too):
// - only sites the owner allowed for this machine (https; exact host or a subdomain of it);
// - only in SmartSell's own tabs in the owner's Chrome (own-Chrome mode), never the owner's other tabs;
// - every step answers with what the page shows now: a screenshot, the visible text and the interactive elements, each
//   with a ref valid until the next snapshot. A stale ref is refused rather than guessed.
// - Page text is data for the Agent, not instructions (the hub's rule 9).
import { randomUUID } from 'node:crypto';
import type { ChromeCdpPage } from '../drivers/cdp-page.ts';
import { NodeNotClickable, OffOriginError } from '../drivers/cdp-page.ts';

export type RemoteAction =
  | { kind: 'click'; ref?: string; x?: number; y?: number }
  | { kind: 'type'; ref?: string; text: string; submit?: boolean }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; dy: number; dx?: number }
  | { kind: 'back' }
  | { kind: 'wait'; ms: number };

export type RemoteCommand =
  | { op: 'open'; url: string }
  | { op: 'snapshot'; session_id: string }
  | { op: 'act'; session_id: string; action: RemoteAction }
  | { op: 'close'; session_id: string };

export interface RemoteElement { ref: string; role: string; name: string; value?: string; disabled: boolean; checked?: unknown; box: [number, number, number, number] | null; in_viewport: boolean }
export interface RemoteSnapshot {
  session_id: string; url: string; title: string; viewport: { width: number; height: number };
  elements: RemoteElement[]; text: string; screenshot: { mime: 'image/jpeg'; base64: string }; taken_at: string;
}

export class RemoteError extends Error {
  constructor(readonly code: 'SITE_NOT_ALLOWED' | 'SESSION_NOT_FOUND' | 'STALE_REF' | 'NOT_CLICKABLE' | 'INVALID_ACTION' | 'BROWSER_UNAVAILABLE', message: string) {
    super(message); this.name = 'RemoteError';
  }
}

/** Owner-allowed sites: `seller.shopee.tw` allows that host and its subdomains; https only (http for loopback in tests). */
export function siteAllowed(url: URL, sites: readonly string[], options: { allowLoopbackHttp?: boolean } = {}) {
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(options.allowLoopbackHttp && loopback && url.protocol === 'http:')) return false;
  const host = url.hostname.toLowerCase();
  return sites.some(site => {
    const clean = site.trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!clean) return false;
    if (clean.includes(':')) return `${host}:${url.port}` === clean;
    return host === clean || host.endsWith(`.${clean}`);
  });
}

const TEXT_LIMIT = 4000;
const SETTLE_MS = 700;

interface Session { id: string; page: ChromeCdpPage; refs: Map<string, number>; lastUsed: number }

export interface RemoteSessionsOptions {
  /** Opens a SmartSell tab in the owner's Chrome whose navigation is limited by `allowUrl`. */
  openPage(): Promise<ChromeCdpPage>;
  /** Sites the owner allowed for this machine, read on every command (the owner may change them). */
  sites(): readonly string[];
  allowLoopbackHttp?: boolean;
  sleep(ms: number): Promise<void>;
  now?(): number;
  /** Sessions close after this much idle time (default 10 minutes). */
  idleMs?: number;
  /** At most this many open sessions (tabs) per machine (default 3). */
  maxSessions?: number;
}

export class RemoteSessions {
  readonly #sessions = new Map<string, Session>();
  constructor(private readonly options: RemoteSessionsOptions) {}

  #now() { return this.options.now?.() ?? Date.now(); }

  allowed(url: URL) { return siteAllowed(url, this.options.sites(), { allowLoopbackHttp: this.options.allowLoopbackHttp }); }

  #session(id: string) {
    const session = this.#sessions.get(id);
    if (!session) throw new RemoteError('SESSION_NOT_FOUND', 'This browser session has ended; open the page again with browser_open.');
    session.lastUsed = this.#now();
    return session;
  }

  async handle(command: RemoteCommand): Promise<RemoteSnapshot | { closed: true }> {
    await this.closeIdle();
    switch (command.op) {
      case 'open': {
        let url: URL;
        try { url = new URL(command.url); } catch { throw new RemoteError('INVALID_ACTION', 'url must be an absolute https URL.'); }
        if (!this.allowed(url)) throw new RemoteError('SITE_NOT_ALLOWED', `${url.hostname} is not in the sites the owner allowed for this machine. Ask the owner to add it on the machine page.`);
        if (this.#sessions.size >= (this.options.maxSessions ?? 3)) {
          const oldest = [...this.#sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
          await this.#close(oldest.id);
        }
        let page: ChromeCdpPage;
        try { page = await this.options.openPage(); }
        catch (error) { throw new RemoteError('BROWSER_UNAVAILABLE', error instanceof Error ? error.message : String(error)); }
        const session: Session = { id: randomUUID(), page, refs: new Map(), lastUsed: this.#now() };
        this.#sessions.set(session.id, session);
        try { await page.goto(url.href); }
        catch (error) {
          if (error instanceof OffOriginError) throw new RemoteError('SITE_NOT_ALLOWED', `The page went to ${URL.parse(error.url)?.hostname ?? error.url}, which the owner did not allow.`);
          throw error;
        }
        await this.options.sleep(SETTLE_MS);
        return this.#snapshot(session);
      }
      case 'snapshot': return this.#snapshot(this.#session(command.session_id));
      case 'close': await this.#close(command.session_id); return { closed: true };
      case 'act': {
        const session = this.#session(command.session_id);
        await this.#act(session, command.action);
        await this.options.sleep(SETTLE_MS);
        return this.#snapshot(session);
      }
    }
  }

  #node(session: Session, ref: string | undefined) {
    if (!ref) return undefined;
    const backendNodeId = session.refs.get(ref);
    if (backendNodeId === undefined) throw new RemoteError('STALE_REF', `${ref} is not on the last snapshot. Take a new snapshot and use its refs.`);
    return { backendNodeId };
  }

  async #act(session: Session, action: RemoteAction) {
    const { page } = session;
    try {
      switch (action.kind) {
        case 'click': {
          const node = this.#node(session, action.ref);
          if (node) { await page.click(node); return; }
          if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) throw new RemoteError('INVALID_ACTION', 'click needs a ref or x and y (CSS pixels of the screenshot).');
          const { width, height } = await page.viewport();
          if (action.x! < 0 || action.y! < 0 || action.x! > width || action.y! > height) throw new RemoteError('INVALID_ACTION', 'x and y must be inside the viewport.');
          await page.clickAt(action.x!, action.y!);
          return;
        }
        case 'type': {
          if (typeof action.text !== 'string' || action.text.length > 5000) throw new RemoteError('INVALID_ACTION', 'type needs text (at most 5000 characters).');
          const node = this.#node(session, action.ref);
          if (node) await page.click(node);
          await page.insertText(action.text);
          if (action.submit) await page.press('Enter');
          return;
        }
        case 'press': {
          if (!/^(Enter|Escape|Backspace|Tab|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|End|Home|PageDown|PageUp|Space)$/.test(action.key)) {
            throw new RemoteError('INVALID_ACTION', 'press supports Enter, Escape, Backspace, Tab, the arrow keys, Home, End, PageUp, PageDown and Space.');
          }
          await page.press(action.key);
          return;
        }
        case 'scroll': await page.scrollBy(Math.max(-5000, Math.min(5000, action.dx ?? 0)), Math.max(-5000, Math.min(5000, action.dy))); return;
        case 'back': await page.back(); return;
        case 'wait': await this.options.sleep(Math.max(0, Math.min(10_000, action.ms))); return;
        default: throw new RemoteError('INVALID_ACTION', 'Unknown action.');
      }
    } catch (error) {
      if (error instanceof NodeNotClickable) throw new RemoteError('NOT_CLICKABLE', `That element cannot be clicked now (${error.reason}). Take a new snapshot.`);
      if (error instanceof OffOriginError) throw new RemoteError('SITE_NOT_ALLOWED', 'That leads to a site the owner did not allow.');
      throw error;
    }
  }

  async #snapshot(session: Session): Promise<RemoteSnapshot> {
    const { page } = session;
    const url = await page.url();
    if (!this.allowed(new URL(url)) && !url.startsWith('about:')) {
      // A click or a redirect left the allowed sites: stop here and leave the tab blank.
      await page.goto('about:blank').catch(() => {});
      session.refs.clear();
      throw new RemoteError('SITE_NOT_ALLOWED', `The page went to ${URL.parse(url)?.hostname ?? url}, which the owner did not allow; it was closed.`);
    }
    const [title, viewport, elements, text, shot] = await Promise.all([
      page.title(), page.viewport(), page.interactiveElements(200), page.bodyText(), page.screenshot({ quality: 60, maxWidth: 1280 }),
    ]);
    session.refs = new Map();
    const listed: RemoteElement[] = elements.map((element, index) => {
      const ref = `e${index + 1}`;
      session.refs.set(ref, element.backendNodeId);
      return { ref, role: element.role, name: element.name, ...(element.value !== undefined && { value: element.value }), disabled: element.disabled,
        ...(element.checked !== undefined && { checked: element.checked }), box: element.box, in_viewport: element.inViewport };
    });
    return {
      session_id: session.id, url, title, viewport, elements: listed,
      text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text,
      screenshot: { mime: 'image/jpeg', base64: shot.toString('base64') }, taken_at: new Date(this.#now()).toISOString(),
    };
  }

  async #close(id: string) {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    await session.page.close().catch(() => {});
  }

  async closeIdle() {
    const idle = this.options.idleMs ?? 10 * 60_000;
    for (const session of [...this.#sessions.values()]) if (this.#now() - session.lastUsed > idle) await this.#close(session.id);
  }

  async closeAll() { for (const id of [...this.#sessions.keys()]) await this.#close(id); }

  get open() { return this.#sessions.size; }
}
