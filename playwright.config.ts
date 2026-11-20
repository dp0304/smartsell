export default {
  testDir: './tests/web-e2e',
  // Each test owns its HTTP ports, sessions and data directory.
  workers: process.env.CI ? 2 : 4,
  reporter: 'list',
  timeout: 60_000,
  globalTimeout: 600_000,
  expect: { timeout: 5_000 },
  use: {
    channel: 'chromium',
    viewport: { width: 1280, height: 800 },
    timezoneId: 'UTC',
    actionTimeout: 6_000,
    navigationTimeout: 10_000,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
};
