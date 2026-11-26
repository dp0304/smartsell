import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';
import { agentConnection, mcpClient, ownerWorkspace, pairMachine, schedulePost, uploadMedia } from './phase1-fixture.mjs';

// Screenshots for the owner's manual (docs/user-guide.md), taken from the real web app and the real Worker App screen
// (apps/connector-desktop/ui) with made-up data. Skipped unless asked for:
//   SMARTSELL_DOCS_SCREENSHOTS=1 pnpm exec playwright test tests/web-e2e/docs-screenshots.spec.mjs
// The images land in docs/images/. Only fixture names appear in them (Mac-B, Win-C, @lurelab_x); no real paths or hosts.
const test = base.extend({ dev: localDev });
test.skip(process.env.SMARTSELL_DOCS_SCREENSHOTS !== '1', 'set SMARTSELL_DOCS_SCREENSHOTS=1 to refresh the manual\'s screenshots');
test.use({ viewport: { width: 1280, height: 800 }, timezoneId: 'Asia/Taipei', locale: 'zh-TW' });
test.setTimeout(120_000);

const out = new URL('../../docs/images/', import.meta.url);
const HUB = 'https://hub.tail1234.ts.net';
/** The dev server's loopback origin is shown as the tailnet address a real hub has; focus rings from page load are dropped. */
const shot = async (target, name, options = {}) => {
  await mkdir(out, { recursive: true });
  if (target.evaluate) {
    await target.evaluate(([origin, hub]) => {
      document.activeElement?.blur?.();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue.includes(origin)) node.nodeValue = node.nodeValue.replaceAll(origin, hub);
      for (const input of document.querySelectorAll('input, textarea')) if (input.value.includes(origin)) input.value = input.value.replaceAll(origin, hub);
    }, [new URL(target.url()).origin, HUB]);
  }
  await target.screenshot({ path: new URL(name, out).pathname, ...options });
};

test('web app: today, post, account, machine, calendar, agent and setup pages', async ({ page, dev }) => {
  await page.context().addInitScript(() => localStorage.setItem('smartsell-language', 'zh-Hant'));
  const ws = await ownerWorkspace(page, dev, { workspaceName: 'Lure Lab 釣具', name: '店長' });
  await ws.rest('PUT', '/hub/alerts/channels', { preferences: { daily_summary: false } });
  const machine = await pairMachine(dev, ws, 'Mac-B');
  await machine.heartbeat();
  const channelId = await machine.addChannel('x', 'lurelab_x');
  await machine.heartbeat();
  const connection = await agentConnection(ws, '筆電的 Codex');
  const agent = mcpClient(connection.mcp_url, connection.token);
  await agent.initialize();
  const fixture = { ws, machine, channelId, agent, media: await uploadMedia(dev, connection.token) };
  const winC = await pairMachine(dev, ws, 'Win-C', { platform: 'win32' });
  await winC.heartbeat();
  const tiktok = await winC.addChannel('tiktok', 'lurelab_tt', '7301234567890123456');   // TikTok's identity is the numeric user id
  await winC.heartbeat();
  const { post } = await schedulePost(fixture, { caption: '新路亞實測 🎣 #fishing #lure', channels: [fixture.channelId, tiktok] });
  await ws.rest('PUT', `/hub/machines/${fixture.machine.id}/remote-control`,
    { browser: { enabled: true, sites: ['seller.example.com'] }, phone: { enabled: false, apps: [] } });

  await page.goto(ws.app);
  await expect(page.getByRole('main')).toContainText('lurelab_x');
  await shot(page, 'web-today.png', { fullPage: true });

  await page.goto(`${ws.app}/posts/${post.post_id}`);
  await expect(page.getByRole('main')).toContainText('新路亞實測');
  await shot(page, 'web-post.png', { fullPage: true });

  await page.goto(`${ws.app}/channels/${fixture.channelId}`);
  await expect(page.getByRole('heading', { level: 2, name: '代按發布', exact: true })).toBeVisible();
  await shot(page, 'web-channel.png', { fullPage: true });

  await page.goto(`${ws.app}/machines/${fixture.machine.id}`);
  await expect(page.getByRole('form', { name: /遙控/ })).toBeVisible();
  await shot(page, 'web-machine.png', { fullPage: true });

  await page.goto(`${ws.app}/calendar`);
  await expect(page.getByRole('main')).toContainText('lurelab');
  await shot(page, 'web-calendar.png');

  await page.goto(`${ws.app}/agent`);
  await expect(page.getByRole('main')).toBeVisible();
  await shot(page, 'web-agent.png', { fullPage: true });

  await page.goto(`${ws.app}/get-started`);
  await expect(page.getByRole('main')).toBeVisible();
  await shot(page, 'web-setup.png', { fullPage: true });

  // The English README shows the same page in English.
  await page.context().addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(ws.app);
  await expect(page.getByRole('main')).toContainText('lurelab_x');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Today');
  await shot(page, 'web-today-en.png', { fullPage: true });
});

// The Worker App's own screen with a stand-in for its main process (preload's window.smartsell).
const workerBase = {
  hub_origin: 'https://hub.tail1234.ts.net', machine_name: 'Mac-B', connection: 'online', clock_offset_ms: 120, clock_warning: false,
  machine_paused: false, pause_all: false, outbox_depth: 0, posture: { os: 'darwin' }, posture_advice: [], update: null, autostart: true,
  emergency_stop: false, phase: 'running', enrollment: null, remote: null,
};
const extensionDir = '/Users/you/Documents/SmartSell Worker/chrome-extension';
const channel = { social_account_id: 'c1', provider: 'x', handle: 'lurelab_x', profile_key: 'ch-1', blocked: false, paused: false,
  effective_mode: 'auto', last_login_check_at: '2026-11-26T01:10:00Z' };
const scenes = {
  'worker-role.png': { settings: { role: null } },
  'worker-pair.png': { settings: { role: 'worker' }, worker: { ...workerBase, phase: 'unpaired' } },
  'worker-chrome-setup.png': { settings: { role: 'worker' }, worker: { ...workerBase, channels: [], jobs: [],
    browser: { mode: 'own_chrome', chosen: true, extension_dir: extensionDir, host_registered: true, connected: [], bindings: {} } } },
  'worker-running.png': { settings: { role: 'worker' }, worker: { ...workerBase, channels: [channel],
    browser: { mode: 'own_chrome', chosen: true, extension_dir: extensionDir, host_registered: true, bindings: {},
      connected: [{ install_id: 'a1b2c3d4e5f6', version: '0.3.0', chrome: '142.0.7444.60', file_access: true, webdriver: false, connected_at: '2026-11-26T01:00:00Z' }] },
    remote: { browser: { enabled: true, sites: ['seller.example.com'] }, phone: { enabled: false, apps: [] } },
    jobs: [{ job_id: 'j1', kind: 'publish_post', dry_run: false, state: 'claimed', not_before: '2026-11-27T01:00:00Z', channel_label: 'X @lurelab_x', needs_owner: false }] } },
  'worker-laptop.png': { settings: { role: 'agent' }, agent: { hub_origin: 'https://hub.tail1234.ts.net', alerts_state: 'open', connected_client: 'claude_code',
    uploads: [{ filename: 'video.mp4', status: 'uploading', received: 61_000_000, bytes: 96_000_000 }],
    alerts: [{ severity: 'warning', title: 'X @lurelab_x 要你核准', body: '明天 09:00 的貼文在等你核准。', at: '2026-11-26T01:20:00Z', web_url: 'https://hub.tail1234.ts.net/' }] } },
};

test('Worker App: choosing the role, pairing, installing the extension, running, laptop mode', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 780 } });
  const index = pathToFileURL(new URL('../../apps/connector-desktop/ui/index.html', import.meta.url).pathname).href;
  for (const [name, scene] of Object.entries(scenes)) {
    const state = { product: 'SmartSell Worker', version: '0.3.0', platform: 'darwin', default_machine_name: 'Mac-B', now: new Date().toISOString(),
      notifications: [], power: { blocking_sleep: false, reasons: [] }, worker: null, agent: null, ...scene,
      settings: { autostart: true, legacy_lines: false, ...scene.settings } };
    await page.addInitScript(value => { window.smartsell = { call: async () => ({ state: value }), onChange() {} }; }, state);
    await page.goto(index);
    await expect(page.locator('#app .card').first()).toBeVisible();
    await shot(page, name, { fullPage: true });
  }
  await page.close();
});
