// CdpPipe over the SmartSell extension: ChromeCdpPage and every driver run unchanged on the owner's own Chrome.
// Browser-level Target.* calls become the extension's tab operations; page-level calls (with a sessionId) go to
// chrome.debugger.sendCommand on that tab. Session ids are `tab-<tabId>`.
import { CdpCallError, type CdpEvent, type CdpPipe } from '../chrome.ts';
import { ProfileError } from '../runtime/profiles.ts';
import { BridgeRequestError, BrowserDisconnected, type BridgeBrowser, type BrowserEvent } from './bridge.ts';

const sessionOf = (tabId: number) => `tab-${tabId}`;
function tabOf(id: unknown): number {
  const match = typeof id === 'string' ? /^tab-(\d+)$/.exec(id) : null;
  if (!match) throw new CdpCallError('不是 SmartSell 開的分頁。', 'Target', `Unknown target ${String(id)}`);
  return Number(match[1]);
}

export class ExtensionCdpPipe implements CdpPipe {
  /** Tabs whose debugger the owner cancelled from Chrome's bar: that job stops and is not retried on its own. */
  readonly #cancelled = new Set<number>();
  /** Tabs this pipe attached; once they are all closed the pipe stops listening (one pipe per page, long uptimes). */
  readonly #tabs = new Set<number>();
  #stopListening?: () => void;

  constructor(private readonly browser: BridgeBrowser) {
    this.#stopListening = browser.onEvent(event => {
      if (!this.#tabs.has(event.tabId)) return;
      if (event.type === 'detached' && event.reason === 'canceled_by_user') this.#cancelled.add(event.tabId);
      if (event.type === 'closed') this.#forget(event.tabId);
    });
  }

  #forget(tabId: number) {
    this.#tabs.delete(tabId);
    this.#cancelled.delete(tabId);
    if (this.#tabs.size === 0) { this.#stopListening?.(); this.#stopListening = undefined; }
  }

  get closed() { return !this.browser.connected; }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeout = 5000): Promise<T> {
    try { return await this.#send<T>(method, params, sessionId, timeout); }
    catch (error) {
      if (error instanceof BrowserDisconnected || error instanceof CdpCallError || error instanceof ProfileError) throw error;
      if (error instanceof BridgeRequestError) throw new CdpCallError('Chrome 頁面或分頁已變化，請重試。', method, error.message);
      throw error;
    }
  }

  async #send<T>(method: string, params: Record<string, unknown>, sessionId: string | undefined, timeout: number): Promise<T> {
    if (sessionId !== undefined) {
      const tabId = tabOf(sessionId);
      if (this.#cancelled.has(tabId)) throw new ProfileError('chrome_unavailable', 'The owner cancelled debugging in Chrome', 'extension_cancelled');
      return await this.browser.request<T>('cdp', { tabId, method, params }, timeout);
    }
    switch (method) {
      case 'Target.createTarget': {
        const { tabId } = await this.browser.request<{ tabId: number }>('open', { url: String(params.url ?? 'about:blank') }, Math.max(timeout, 10_000));
        return { targetId: sessionOf(tabId) } as T;
      }
      case 'Target.attachToTarget': {
        const tabId = tabOf(params.targetId);
        await this.browser.request('attach', { tabId }, Math.max(timeout, 10_000));
        this.#tabs.add(tabId);
        // The SmartSell window is usually not the focused one; without this, focus/blur-driven editors (X's composer)
        // behave as in a background window. Same as when the owner works in that window.
        await this.browser.request('cdp', { tabId, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }, timeout).catch(() => {});
        // Read-only diagnostics for the owner (§3.5): the page's own view of navigator.webdriver, in its main world.
        await this.browser.request<{ result?: { value?: unknown } }>('cdp', { tabId, method: 'Runtime.evaluate', params: { expression: 'navigator.webdriver', returnByValue: true } }, timeout)
          .then(reply => { if (typeof reply.result?.value === 'boolean') this.browser.webdriver = reply.result.value; }, () => {});
        return { sessionId: sessionOf(tabId) } as T;
      }
      case 'Target.getTargets': {
        const { tabs } = await this.browser.request<{ tabs: { tabId: number; url: string }[] }>('tabs', {}, timeout);
        return { targetInfos: tabs.map(tab => ({ targetId: sessionOf(tab.tabId), type: 'page', url: tab.url, attached: false })) } as T;
      }
      case 'Target.closeTarget': {
        const tabId = tabOf(params.targetId);
        try { await this.browser.request('close', { tabId }, timeout); } finally { this.#forget(tabId); }
        return { success: true } as T;
      }
      case 'Target.activateTarget':
        await this.browser.request('activate', { tabId: tabOf(params.targetId) }, timeout);
        return {} as T;
      // The owner's browser is never closed by SmartSell.
      case 'Browser.close': return {} as T;
      default: throw new CdpCallError('SmartSell 擴充功能不支援這個操作。', method, `${method} is not available through the extension`);
    }
  }

  onEvent(listener: (event: CdpEvent) => void) {
    return this.browser.onEvent((event: BrowserEvent) => {
      if (event.type === 'event') listener({ method: event.method, params: event.params ?? {}, sessionId: sessionOf(event.tabId) });
      else listener({ method: event.type === 'detached' ? 'Inspector.detached' : 'Target.targetDestroyed',
        params: event.type === 'detached' ? { reason: event.reason } : { targetId: sessionOf(event.tabId) }, sessionId: sessionOf(event.tabId) });
    });
  }
}
