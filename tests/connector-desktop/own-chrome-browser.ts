// Test helper: a stand-in for the owner's own Chrome — Playwright's Chromium with the real SmartSell extension
// (apps/connector-desktop/extension) loaded and the native messaging host registered in its user-data folder, pointing
// at one Worker data directory's bridge socket. Nothing is written into the user's real Chrome folders.
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeSocketPath } from '../../apps/connector-desktop/src/browser-bridge/bridge.ts';
import { registerNativeHost } from '../../apps/connector-desktop/src/browser-bridge/native-host.ts';

const require = createRequire(import.meta.url);
export const extensionDir = fileURLToPath(new URL('../../apps/connector-desktop/extension/', import.meta.url));

type Context = { close(): Promise<void>; newPage(): Promise<{ goto(url: string): Promise<unknown>; close(): Promise<void> }>; pages(): unknown[] };

export interface OwnerChrome { context: Context; userDataDir: string; close(): Promise<void> }

/** Why the own-Chrome tests cannot run here, or undefined. */
export function ownChromeUnavailable(): string | undefined {
  if (process.platform === 'win32') return 'the test relay uses nc -U (macOS / Linux)';
  try {
    const { chromium } = require('@playwright/test') as { chromium: { executablePath(): string } };
    const path = chromium.executablePath();
    if (!path || !require('node:fs').existsSync(path)) return 'Playwright Chromium is not installed (pnpm exec playwright install chromium)';
  } catch { return '@playwright/test is not installed'; }
  return undefined;
}

export async function launchOwnerChrome(workerDataDir: string, options: { headless?: boolean } = {}): Promise<OwnerChrome> {
  const { chromium } = require('@playwright/test') as { chromium: { launchPersistentContext(dir: string, options: object): Promise<Context> } };
  const userDataDir = mkdtempSync(join(tmpdir(), 'ss-owner-chrome-'));
  await registerNativeHost({ dataDir: workerDataDir, socketPath: bridgeSocketPath(workerDataDir), hostDirs: [join(userDataDir, 'NativeMessagingHosts')] });
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: options.headless ?? true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  return {
    context, userDataDir,
    async close() {
      await context.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
