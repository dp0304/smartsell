// BrowserLauncher for own-Chrome mode: every channel's "profile" is a Chrome profile of the owner that has the SmartSell
// extension, reached through the bridge. Profiles (runtime/profiles.ts) keeps its locks and one page per channel; here a
// page is a tab in the SmartSell window of the owner's Chrome, and closing the handle closes only SmartSell's tabs.
//
// Which Chrome profile a channel uses is remembered per profile key in browser-bindings.json. A channel never moves to
// another Chrome profile on its own: that profile may be signed in to a different account.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ChromeCdpPage } from '../drivers/cdp-page.ts';
import type { CdpPage } from '../drivers/types.ts';
import { ProfileError, type BrowserLauncher } from '../runtime/profiles.ts';
import type { BridgeBrowser, BrowserBridge } from './bridge.ts';
import { ExtensionCdpPipe } from './pipe.ts';

export class BrowserBindings {
  constructor(private readonly path: string) {}
  static in(dataDir: string) { return new BrowserBindings(join(dataDir, 'browser-bindings.json')); }

  all(): Record<string, string> {
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch { return {}; }
  }
  get(profileKey: string): string | undefined { return this.all()[profileKey]; }
  set(profileKey: string, installId: string | null) {
    const next = this.all();
    if (installId === null) delete next[profileKey];
    else next[profileKey] = installId;
    const temp = `${this.path}.part`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

export interface OwnChromeLauncherOptions {
  bridge: Pick<BrowserBridge, 'browser' | 'browsers' | 'waitForBrowser' | 'onChange'>;
  bindings: BrowserBindings;
  allowUrl(url: URL): boolean;
  sleep(ms: number): Promise<void>;
  /** How long openPage waits for the extension to (re)connect, e.g. right after the Worker started (default 45 s). */
  connectWaitMs?: number;
}

async function waitForInstall(bridge: OwnChromeLauncherOptions['bridge'], installId: string, timeoutMs: number) {
  const found = bridge.browser(installId);
  if (found) return found;
  return await new Promise<BridgeBrowser | undefined>(resolve => {
    const timer = setTimeout(() => { stop(); resolve(undefined); }, timeoutMs);
    const stop = bridge.onChange(() => {
      const next = bridge.browser(installId);
      if (next) { clearTimeout(timer); stop(); resolve(next); }
    });
  });
}

/** The Chrome profile for this channel: its binding, or the only connected one (then remembered). */
export async function browserFor(options: OwnChromeLauncherOptions, profileKey: string): Promise<BridgeBrowser> {
  const wait = options.connectWaitMs ?? 45_000;
  const bound = options.bindings.get(profileKey);
  if (bound) {
    const browser = await waitForInstall(options.bridge, bound, wait);
    if (!browser) throw new ProfileError('chrome_unavailable', 'The Chrome profile bound to this channel is not connected', 'extension_not_connected');
    return browser;
  }
  const first = await options.bridge.waitForBrowser(wait);
  if (!first) throw new ProfileError('chrome_unavailable', 'No Chrome with the SmartSell extension is connected', 'extension_not_connected');
  const connected = options.bridge.browsers();
  if (connected.length > 1) throw new ProfileError('chrome_unavailable', 'Several Chrome profiles are connected', 'extension_ambiguous');
  options.bindings.set(profileKey, first.installId);
  return first;
}

export function ownChromeLauncher(options: OwnChromeLauncherOptions): BrowserLauncher {
  return dir => {
    const profileKey = basename(dir);
    const pages = new Set<CdpPage>();
    let browser: BridgeBrowser | undefined;
    let closed = false;
    return {
      get closed() { return closed || (browser !== undefined && !browser.connected); },
      async openPage() {
        browser = await browserFor(options, profileKey);
        const page = await ChromeCdpPage.open(new ExtensionCdpPipe(browser), {
          allowUrl: url => url.protocol === 'about:' || options.allowUrl(url), sleep: options.sleep,
        });
        pages.add(page);
        return page;
      },
      close() {
        closed = true;
        for (const page of pages) void page.close().catch(() => {});
        pages.clear();
      },
      async exited() { return true; },
    };
  };
}
