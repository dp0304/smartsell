// Browser selection shared by the Playwright configs (root and apps/web). Never downloads a browser.
//   SMARTSELL_TEST_CHROME=<path>              use that executable
//   SMARTSELL_PLAYWRIGHT_CHANNEL=<channel>    use that channel (for example 'chrome', the installed Google Chrome)
//   otherwise                                 Playwright's bundled Chromium when it is installed, else the installed
//                                             Google Chrome (channel 'chrome'), else 'chromium' so Playwright reports
//                                             the missing browser itself.
// Only the browser binary changes: no flags, no stealth, no automation-detection changes.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

export function installedChromePaths(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')];
  }
  if (platform === 'win32') {
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(base => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
}

function bundledChromiumInstalled() {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
}

/** The `use` fragment that picks the browser; `reason` says why (printed once by the configs). */
export function playwrightBrowser(env = process.env, deps = { bundled: bundledChromiumInstalled, exists: existsSync }) {
  if (env.SMARTSELL_TEST_CHROME) return { use: { launchOptions: { executablePath: env.SMARTSELL_TEST_CHROME } }, reason: `SMARTSELL_TEST_CHROME=${env.SMARTSELL_TEST_CHROME}` };
  if (env.SMARTSELL_PLAYWRIGHT_CHANNEL) return { use: { channel: env.SMARTSELL_PLAYWRIGHT_CHANNEL }, reason: `SMARTSELL_PLAYWRIGHT_CHANNEL=${env.SMARTSELL_PLAYWRIGHT_CHANNEL}` };
  if (deps.bundled()) return { use: { channel: 'chromium' }, reason: 'bundled Chromium' };
  if (installedChromePaths(process.platform, env).some(path => deps.exists(path))) {
    return { use: { channel: 'chrome' }, reason: 'bundled Chromium is not installed; using the installed Google Chrome' };
  }
  return { use: { channel: 'chromium' }, reason: 'no browser found; run `pnpm exec playwright install chromium` or set SMARTSELL_PLAYWRIGHT_CHANNEL' };
}

let announced = false;
/** `use` options for a config; prints the choice once per process when it is not the bundled Chromium. */
export function browserUse(env = process.env) {
  const choice = playwrightBrowser(env);
  if (!announced && choice.reason !== 'bundled Chromium' && !env.PLAYWRIGHT_JSON_OUTPUT_FILE) {
    announced = true;
    console.log(`[playwright] ${choice.reason}`);
  }
  return choice.use;
}
