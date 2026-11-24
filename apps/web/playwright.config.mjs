import { defineConfig } from '@playwright/test';
import { browserUse } from '../../scripts/playwright-browser.mjs';

export default defineConfig({
  testDir: './test',
  workers: 1,
  use: {
    // SMARTSELL_TEST_CHROME, SMARTSELL_PLAYWRIGHT_CHANNEL, bundled Chromium, then the installed Google Chrome.
    ...browserUse(),
    timezoneId: 'UTC',
    actionTimeout: 6000,
  },
});
