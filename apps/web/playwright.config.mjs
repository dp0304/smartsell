import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  workers: 1,
  use: {
    ...(process.env.SMARTSELL_TEST_CHROME ? { launchOptions: { executablePath: process.env.SMARTSELL_TEST_CHROME } } : { channel: 'chromium' }),
    locale: 'zh-TW',
    timezoneId: 'UTC',
    actionTimeout: 6000,
  },
});
