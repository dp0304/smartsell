import base from '../../playwright.config.ts';

const browser = process.env.SMARTSELL_ACCEPTANCE_BROWSER ?? 'chromium';
const desktop = {
  chromium: { browserName: 'chromium', channel: 'chromium' },
  chrome: { browserName: 'chromium', channel: 'chrome', launchOptions: { args: ['--disable-background-networking'] } },
  edge: { browserName: 'chromium', channel: 'msedge' },
  firefox: { browserName: 'firefox' },
  webkit: { browserName: 'webkit' },
}[browser];
if (!desktop) throw new Error(`Unknown desktop browser ${browser}`);

export default {
  ...base,
  testDir: '.',
  testMatch: 'workspace-account.spec.mjs',
  use: { ...base.use, channel: undefined, ...desktop, serviceWorkers: 'block' },
};
