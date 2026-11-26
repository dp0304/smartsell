// CdpPage over the Chrome pipe (§8.7). Reads run in an isolated world; input
// uses trusted CDP Input events at normal speed. Nothing here touches
// navigator, webdriver flags or any fingerprint surface.
import { createHash } from 'node:crypto';
import type { CdpEvent, CdpPipe } from '../chrome.ts';
import type { CdpPage, Modifier, NodeRef, ResponseWatcher, WatchedResponse } from './types.ts';

export class NavigationError extends Error {
  constructor(message: string, readonly url: string) { super(message); this.name = 'NavigationError'; }
}
export class OffOriginError extends Error {
  constructor(readonly url: string) { super('The page left the platform origin'); this.name = 'OffOriginError'; }
}
export class NodeNotClickable extends Error {
  constructor(readonly reason: 'detached' | 'disabled' | 'obscured' | 'no_box' | 'offscreen') { super(`Node is not clickable (${reason})`); this.name = 'NodeNotClickable'; }
}

type AXValue = { type: string; value?: unknown };
type AXNode = { nodeId: string; ignored?: boolean; role?: AXValue; name?: AXValue; properties?: { name: string; value: AXValue }[]; backendDOMNodeId?: number };
type Frame = { id: string; url: string; urlFragment?: string; loaderId: string };

const keyTable: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, Backspace: { code: 'Backspace', keyCode: 8 },
  End: { code: 'End', keyCode: 35 }, Home: { code: 'Home', keyCode: 36 }, Tab: { code: 'Tab', keyCode: 9 }, ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Space: { code: 'Space', keyCode: 32, text: ' ' }, a: { code: 'KeyA', keyCode: 65, text: 'a' }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};
const modifierBits: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
/** Below the hub's 4 MiB evidence limit (§8.13), with room to spare. */
export const SCREENSHOT_BUDGET_BYTES = Math.floor(3.5 * 1024 * 1024);

export interface ChromePageOptions {
  /** Every navigation must end on an allowed origin (§8.7 goto). */
  allowUrl(url: URL): boolean;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

export class ChromeCdpPage implements CdpPage {
  #world?: { loaderId: string; contextId: number };
  #networkEnabled = false;
  #watchers = new Set<{ pattern: RegExp; requests: Map<string, { url: string; status: number }>; responses: WatchedResponse[]; wake: Set<() => void> }>();
  #unsubscribe: () => void;
  #closed = false;

  private constructor(private readonly pipe: CdpPipe, readonly targetId: string, readonly sessionId: string, private readonly options: ChromePageOptions) {
    this.#unsubscribe = pipe.onEvent(event => this.#onEvent(event));
  }

  /** Opens a new tab in the profile's Chrome and attaches to it. */
  static async open(pipe: CdpPipe, options: ChromePageOptions, existingTargetId?: string): Promise<ChromeCdpPage> {
    const targetId = existingTargetId ?? (await pipe.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await pipe.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new ChromeCdpPage(pipe, targetId, sessionId, options);
    await page.#send('Page.enable');
    await page.#send('Page.setLifecycleEventsEnabled', { enabled: true });
    await page.#send('DOM.enable');
    await page.#send('Accessibility.enable').catch(() => {});
    return page;
  }

  #send<T = unknown>(method: string, params: object = {}, timeout = 10_000) {
    return this.pipe.send<T>(method, params, this.sessionId, timeout);
  }

  #now() { return this.options.now?.() ?? Date.now(); }

  #onEvent(event: CdpEvent) {
    if (event.sessionId !== this.sessionId) return;
    if (event.method === 'Network.responseReceived') {
      const { requestId, response } = event.params as { requestId: string; response: { url: string; status: number } };
      for (const watcher of this.#watchers) if (watcher.pattern.test(response.url)) watcher.requests.set(requestId, { url: response.url, status: response.status });
    } else if (event.method === 'Network.loadingFinished') {
      const { requestId } = event.params as { requestId: string };
      for (const watcher of this.#watchers) {
        const request = watcher.requests.get(requestId);
        if (!request) continue;
        watcher.requests.delete(requestId);
        void this.#send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId }).then(
          ({ body, base64Encoded }) => base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body, () => null,
        ).then(body => {
          watcher.responses.push({ ...request, body, at: this.#now() });
          for (const wake of watcher.wake) wake();
        });
      }
    }
  }

  #waitEvent(match: (event: CdpEvent) => boolean, timeoutMs: number) {
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { stop(); resolve(false); }, timeoutMs);
      timer.unref?.();
      const stop = this.pipe.onEvent(event => {
        if (event.sessionId === this.sessionId && match(event)) { clearTimeout(timer); stop(); resolve(true); }
      });
    });
  }

  async #mainFrame(): Promise<Frame> {
    const { frameTree } = await this.#send<{ frameTree: { frame: Frame } }>('Page.getFrameTree');
    return frameTree.frame;
  }

  async #context() {
    const frame = await this.#mainFrame();
    if (this.#world?.loaderId === frame.loaderId) return this.#world.contextId;
    const { executionContextId } = await this.#send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: frame.id, worldName: 'smartsell-driver',
    });
    this.#world = { loaderId: frame.loaderId, contextId: executionContextId };
    return executionContextId;
  }

  async #evaluate<T>(expression: string): Promise<T> {
    const contextId = await this.#context();
    const reply = await this.#send<{ result: { value?: T }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression, contextId, returnByValue: true, timeout: 2000,
    });
    if (reply.exceptionDetails) throw new Error('Page evaluation failed');
    return reply.result.value as T;
  }

  async #callOn<T>(node: NodeRef, fn: string, args: { value?: unknown; objectId?: string }[] = []): Promise<T> {
    const contextId = await this.#context();
    const { object } = await this.#send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId: contextId });
    try {
      const reply = await this.#send<{ result: { value?: T }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration: fn, arguments: args, returnByValue: true, awaitPromise: true,
      });
      if (reply.exceptionDetails) throw new Error('Node function failed');
      return reply.result.value as T;
    } finally {
      await this.#send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  }

  async goto(url: string, options: { timeoutMs?: number } = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const target = new URL(url);
    if (!this.options.allowUrl(target)) throw new OffOriginError(url);
    const frameId = (await this.#mainFrame()).id;
    const stopped = this.#waitEvent(event => (event.method === 'Page.frameStoppedLoading' && (event.params as { frameId: string }).frameId === frameId) ||
      (event.method === 'Page.lifecycleEvent' && (event.params as { name: string; frameId: string }).name === 'load' && (event.params as { frameId: string }).frameId === frameId), timeoutMs);
    const result = await this.#send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url: target.href }, timeoutMs);
    if (result.errorText) throw new NavigationError(result.errorText, url);
    if (result.loaderId) await stopped;
    this.#world = undefined;
    const now = await this.url();
    if (!this.options.allowUrl(new URL(now))) throw new OffOriginError(now);
    return now;
  }

  async url() {
    const frame = await this.#mainFrame();
    return frame.url + (frame.urlFragment ?? '');
  }

  async #documentObject(): Promise<string> {
    const contextId = await this.#context();
    const reply = await this.#send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: 'document', contextId, returnByValue: false });
    if (!reply.result.objectId) throw new Error('No document');
    return reply.result.objectId;
  }

  /**
   * CSS query evaluated in the isolated world in one round trip; `text` filters by
   * innerText. Elements are returned as backend node ids, which survive DOM rebuilds.
   */
  async queryCss(selector: string, options: { within?: NodeRef; visible?: boolean; text?: RegExp } = {}) {
    const fn = `function (selector, visibleOnly, textSource, textFlags) {
      const root = this.contentDocument || this;
      const re = textSource ? new RegExp(textSource, textFlags) : null;
      const shown = element => {
        if (!element.isConnected) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      };
      return Array.from(root.querySelectorAll(selector)).filter(element => (!visibleOnly || shown(element)) &&
        (!re || re.test(String(element.innerText ?? element.textContent ?? '').trim())));
    }`;
    let arrayId: string | undefined;
    let ownerId: string | undefined;
    try {
      const contextId = await this.#context();
      if (options.within) {
        ({ object: { objectId: ownerId } } = await this.#send<{ object: { objectId: string } }>('DOM.resolveNode', {
          backendNodeId: options.within.backendNodeId, executionContextId: contextId,
        }));
      } else ownerId = await this.#documentObject();
      const reply = await this.#send<{ result: { objectId?: string }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
        objectId: ownerId, functionDeclaration: fn, returnByValue: false,
        arguments: [{ value: selector }, { value: options.visible !== false }, { value: options.text?.source ?? null }, { value: options.text?.flags ?? '' }],
      });
      if (reply.exceptionDetails || !reply.result.objectId) return [];
      arrayId = reply.result.objectId;
      const { result } = await this.#send<{ result: { name: string; value?: { objectId?: string } }[] }>('Runtime.getProperties', { objectId: arrayId, ownProperties: true });
      const nodes: NodeRef[] = [];
      for (const item of result) {
        if (!/^\d+$/.test(item.name) || !item.value?.objectId) continue;
        try {
          const { node } = await this.#send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: item.value.objectId });
          nodes.push({ backendNodeId: node.backendNodeId });
        } catch { /* Gone between query and description. */ }
      }
      return nodes;
    } catch { return []; }
    finally {
      if (arrayId) await this.#send('Runtime.releaseObject', { objectId: arrayId }).catch(() => {});
      if (ownerId) await this.#send('Runtime.releaseObject', { objectId: ownerId }).catch(() => {});
    }
  }

  async queryRole(role: string, name: RegExp, options: { within?: NodeRef } = {}) {
    let backendNodeId = options.within?.backendNodeId;
    if (backendNodeId === undefined) {
      const { root } = await this.#send<{ root: { backendNodeId: number } }>('DOM.getDocument', { depth: 0 });
      backendNodeId = root.backendNodeId;
    }
    let nodes: AXNode[];
    try { ({ nodes } = await this.#send<{ nodes: AXNode[] }>('Accessibility.queryAXTree', { backendNodeId, role })); }
    catch { return []; }
    const property = (node: AXNode, key: string) => node.properties?.find(item => item.name === key)?.value?.value;
    return nodes.filter(node => !node.ignored && node.backendDOMNodeId && name.test(String(node.name?.value ?? '').trim())).map(node => ({
      backendNodeId: node.backendDOMNodeId!, name: String(node.name?.value ?? ''),
      disabled: property(node, 'disabled') === true, checked: property(node, 'checked') as NodeRef['checked'], expanded: property(node, 'expanded') as boolean | undefined,
    }));
  }

  /** Resolves the click point after checking the node is attached, enabled and not covered (§8.7). */
  async #clickPoint(node: NodeRef): Promise<{ x: number; y: number }> {
    const state = await this.#callOn<string>(node, `function () {
      if (!this.isConnected) return 'detached';
      if (this.disabled === true || this.getAttribute('aria-disabled') === 'true' || this.getAttribute('data-disabled') === 'true') return 'disabled';
      return 'ok';
    }`).catch(() => 'detached');
    if (state !== 'ok') throw new NodeNotClickable(state as 'detached' | 'disabled');
    await this.#send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }).catch(() => {});
    let quad: number[];
    try { quad = (await this.#send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId: node.backendNodeId })).model.content; }
    catch { throw new NodeNotClickable('no_box'); }
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    // Never click through an overlay: the node under the point must be the target or inside it. When no node can be hit
    // at the point (it is outside the viewport, e.g. below a fixed dialog that cannot scroll), the mouse events would land
    // on nothing while the caller counts a click: refuse instead (E2E-1, closure-S8).
    const hit = await this.#send<{ backendNodeId: number }>('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false })
      .catch(() => null);
    if (!hit) throw new NodeNotClickable('offscreen');
    if (hit.backendNodeId !== node.backendNodeId) {
      const contextId = await this.#context();
      const { object } = await this.#send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: hit.backendNodeId, executionContextId: contextId });
      try {
        const inside = await this.#callOn<boolean>(node, 'function (hit) { return this.contains(hit) || !!(this.control && this.control.contains(hit)); }', [{ objectId: object.objectId }]);
        if (!inside) throw new NodeNotClickable('obscured');
      } finally { await this.#send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
    }
    return { x, y };
  }

  async clickable(node: NodeRef) {
    try { await this.#clickPoint(node); return true; } catch { return false; }
  }

  async click(node: NodeRef) {
    const { x, y } = await this.#clickPoint(node);
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  async focus(node: NodeRef) { await this.#send('DOM.focus', { backendNodeId: node.backendNodeId }); }

  async insertText(text: string) { await this.#send('Input.insertText', { text }); }

  async press(key: string, modifiers: Modifier[] = []) {
    const info = keyTable[key] ?? { code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined };
    const bits = modifiers.reduce((sum, value) => sum | modifierBits[value], 0);
    const selectAll = key.toLowerCase() === 'a' && (modifiers.includes('Control') || modifiers.includes('Meta'));
    const text = bits & (modifierBits.Control | modifierBits.Meta | modifierBits.Alt) ? undefined : info.text;
    await this.#send('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown', key, code: info.code, windowsVirtualKeyCode: info.keyCode,
      modifiers: bits, ...(text && { text, unmodifiedText: text }), ...(selectAll && { commands: ['selectAll'] }),
    });
    await this.#send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers: bits });
  }

  async typeChars(text: string, perCharDelayMs: number) {
    for (const char of text) {
      await this.#send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char, unmodifiedText: char });
      await this.#send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
      await this.options.sleep(perCharDelayMs);
    }
  }

  async setFiles(node: NodeRef, paths: string[]) {
    await this.#send('DOM.setFileInputFiles', { files: paths, backendNodeId: node.backendNodeId });
  }

  innerText(node: NodeRef) { return this.#callOn<string>(node, 'function () { return this.innerText ?? this.textContent ?? ""; }').then(value => value ?? ''); }

  attribute(node: NodeRef, name: string) {
    return this.#callOn<string | null>(node, 'function (name) { return this.getAttribute(name); }', [{ value: name }]);
  }

  bodyText() { return this.#evaluate<string>('document.body ? document.body.innerText : ""').then(value => value ?? '').catch(() => ''); }

  frameSources() {
    return this.#evaluate<string[]>('Array.from(document.querySelectorAll("iframe")).map(frame => frame.getAttribute("src") || "")')
      .then(value => value ?? []).catch(() => []);
  }

  /**
   * §8.13 evidence: JPEG, at most `maxWidth` image pixels wide. Chrome captures in device pixels, so on a 2× (Retina)
   * screen the scale is divided by devicePixelRatio (WA-4); a capture still above SCREENSHOT_BUDGET_BYTES is taken again
   * smaller, because the hub stores evidence only up to 4 MiB.
   */
  async screenshot(options: { quality?: number; maxWidth?: number } = {}) {
    const metrics = await this.#send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics');
    const { clientWidth, clientHeight } = metrics.cssLayoutViewport;
    const ratio = await this.#evaluate<number>('window.devicePixelRatio').catch(() => 1);
    let scale = Math.min(1, (options.maxWidth ?? 1600) / Math.max(1, clientWidth)) / (Number.isFinite(ratio) && ratio > 1 ? ratio : 1);
    let quality = options.quality ?? 70;
    for (let attempt = 0; ; attempt++) {
      const { data } = await this.#send<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg', quality, clip: { x: 0, y: 0, width: clientWidth, height: clientHeight, scale },
      }, 20_000);
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length <= SCREENSHOT_BUDGET_BYTES || attempt >= 3) return bytes;
      quality = Math.max(30, quality - 20);
      scale *= 0.75;
    }
  }

  watchResponses(pattern: RegExp): ResponseWatcher {
    const watcher = { pattern, requests: new Map<string, { url: string; status: number }>(), responses: [] as WatchedResponse[], wake: new Set<() => void>() };
    this.#watchers.add(watcher);
    if (!this.#networkEnabled) {
      this.#networkEnabled = true;
      void this.#send('Network.enable', { maxResourceBufferSize: 4 * 1024 * 1024 }).catch(() => { this.#networkEnabled = false; });
    }
    return {
      responses: () => [...watcher.responses],
      next: (match, timeoutMs, signal) => new Promise<WatchedResponse | null>(resolve => {
        const seen = watcher.responses.find(match);
        if (seen) { resolve(seen); return; }
        const finish = (value: WatchedResponse | null) => { clearTimeout(timer); watcher.wake.delete(check); signal?.removeEventListener('abort', abort); resolve(value); };
        const check = () => { const found = watcher.responses.find(match); if (found) finish(found); };
        const abort = () => finish(null);
        const timer = setTimeout(() => finish(null), timeoutMs);
        timer.unref?.();
        watcher.wake.add(check);
        signal?.addEventListener('abort', abort, { once: true });
      }),
      stop: () => { this.#watchers.delete(watcher); },
    };
  }

  async axSnapshotHash() {
    try {
      const { nodes } = await this.#send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', {}, 20_000);
      const shape = nodes.filter(node => !node.ignored).map(node => `${node.role?.value ?? ''}:${String(node.name?.value ?? '').slice(0, 80)}`).join('\n');
      return createHash('sha256').update(shape).digest('hex').slice(0, 32);
    } catch { return 'unavailable'; }
  }

  // ---------- remote control (core-automation-proposal §2 item 2, step 4): look and act for the owner's Agent ----------

  /** Document title of the main frame. */
  title() { return this.#evaluate<string>('document.title').then(value => value ?? '').catch(() => ''); }

  /** CSS viewport size. */
  async viewport() {
    const metrics = await this.#send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics');
    return { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight };
  }

  /**
   * Interactive elements from the accessibility tree, in document order, with their CSS box (rounded) when they have
   * one. Up to `limit` elements; `inViewport` marks the ones whose centre is on screen.
   */
  async interactiveElements(limit = 200) {
    const roles = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'tab', 'option', 'listbox', 'slider', 'spinbutton', 'treeitem']);
    let nodes: AXNode[];
    try { ({ nodes } = await this.#send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', {}, 20_000)); } catch { return []; }
    const { width, height } = await this.viewport().catch(() => ({ width: 0, height: 0 }));
    const property = (node: AXNode, key: string) => node.properties?.find(item => item.name === key)?.value?.value;
    const out: { backendNodeId: number; role: string; name: string; value?: string; disabled: boolean; checked?: unknown; box: [number, number, number, number] | null; inViewport: boolean }[] = [];
    for (const node of nodes) {
      if (out.length >= limit) break;
      const role = String(node.role?.value ?? '');
      if (node.ignored || !node.backendDOMNodeId || !roles.has(role)) continue;
      let box: [number, number, number, number] | null = null;
      try {
        const quad = (await this.#send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId })).model.content;
        const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
        box = [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs) - Math.min(...xs)), Math.round(Math.max(...ys) - Math.min(...ys))];
      } catch { /* not rendered */ }
      if (box && (box[2] === 0 || box[3] === 0)) continue;
      const centre = box ? [box[0] + box[2] / 2, box[1] + box[3] / 2] : null;
      const value = (node as AXNode & { value?: AXValue }).value?.value;
      out.push({
        backendNodeId: node.backendDOMNodeId, role, name: String(node.name?.value ?? '').trim().slice(0, 120),
        ...(typeof value === 'string' && value && { value: value.slice(0, 120) }),
        disabled: property(node, 'disabled') === true, ...(property(node, 'checked') !== undefined && { checked: property(node, 'checked') }),
        box, inViewport: !!centre && centre[0] >= 0 && centre[1] >= 0 && centre[0] <= width && centre[1] <= height,
      });
    }
    return out;
  }

  /** A trusted click at CSS coordinates (the Agent picked a point on the screenshot). */
  async clickAt(x: number, y: number) {
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /** Wheel scroll by (dx, dy) CSS pixels at a point (default: the viewport centre). */
  async scrollBy(dx: number, dy: number, at?: { x: number; y: number }) {
    const { width, height } = await this.viewport();
    const point = at ?? { x: Math.round(width / 2), y: Math.round(height / 2) };
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: dx, deltaY: dy });
  }

  /** Browser history back (Page.navigateToHistoryEntry); the allowlist still applies to where it lands. */
  async back() {
    const { currentIndex, entries } = await this.#send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory');
    const previous = entries[currentIndex - 1];
    if (!previous) return this.url();
    if (!this.options.allowUrl(new URL(previous.url))) throw new OffOriginError(previous.url);
    await this.#send('Page.navigateToHistoryEntry', { entryId: previous.id });
    this.#world = undefined;
    return this.url();
  }

  async bringToFront() {
    await this.#send('Page.bringToFront').catch(() => {});
    await this.pipe.send('Target.activateTarget', { targetId: this.targetId }).catch(() => {});
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    await this.pipe.send('Target.closeTarget', { targetId: this.targetId }, undefined, 2000).catch(() => {});
  }
}
