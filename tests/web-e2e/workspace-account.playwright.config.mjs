import config from '../../playwright.config.ts';

const firefox = process.env.WORKSPACE_FIREFOX_EXECUTABLE;
export default {
  ...config,
  testDir: '.',
  testMatch: /(?:workspace-account|editorial-workspace|primary)\.spec\.mjs$/,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } },
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
    { name: 'edge', use: { browserName: 'chromium', channel: 'msedge' } },
    { name: 'firefox', use: { browserName: 'firefox', channel: undefined,
      ...(firefox && { launchOptions: { executablePath: firefox } }) } },
    { name: 'webkit', use: { browserName: 'webkit', channel: undefined } },
  ],
};
