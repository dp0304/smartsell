import assert from 'node:assert/strict';
import test from 'node:test';
import { installedChromePaths, playwrightBrowser } from './playwright-browser.mjs';

const none = { bundled: () => false, exists: () => false };

test('browser choice: explicit executable, explicit channel, bundled Chromium, installed Chrome, then chromium', () => {
  assert.deepEqual(playwrightBrowser({ SMARTSELL_TEST_CHROME: '/x/chrome', SMARTSELL_PLAYWRIGHT_CHANNEL: 'chrome' }, none).use,
    { launchOptions: { executablePath: '/x/chrome' } });
  assert.deepEqual(playwrightBrowser({ SMARTSELL_PLAYWRIGHT_CHANNEL: 'chrome' }, { bundled: () => true, exists: () => true }).use, { channel: 'chrome' });
  assert.deepEqual(playwrightBrowser({}, { bundled: () => true, exists: () => true }).use, { channel: 'chromium' });
  const chrome = installedChromePaths()[0];
  assert.deepEqual(playwrightBrowser({}, { bundled: () => false, exists: path => path === chrome }).use, { channel: 'chrome' });
  const missing = playwrightBrowser({}, none);
  assert.deepEqual(missing.use, { channel: 'chromium' }, 'nothing installed: Playwright reports the missing browser');
  assert.match(missing.reason, /playwright install/);
});

test('installed Chrome locations per platform', () => {
  assert.ok(installedChromePaths('darwin').includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(installedChromePaths('win32', { PROGRAMFILES: 'C:\\Program Files' }).some(path => path.endsWith('chrome.exe')));
  assert.ok(installedChromePaths('linux').includes('/opt/google/chrome/chrome'));
});
