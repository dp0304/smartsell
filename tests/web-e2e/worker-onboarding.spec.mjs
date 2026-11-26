import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { createSignedHttpTransport, pairOverHttp, SignedDeviceClient } from '../../apps/connector/src/device-client.ts';
import { textCell, workbookFixture } from '../../apps/server/src/modules/ingest/xlsx-fixture.ts';
import { localWorkerOnboarding } from './local-dev.mjs';
import { mcpClient, pairMachine, workerPairingBody } from './phase1-fixture.mjs';
import { expectStepStatus, expectToday, expectWizardStep, finishLater, showMoreModules, wizardEntry, wizardPanel, wizardSteps } from './phase1-shell.mjs';

const test = base.extend({ dev: localWorkerOnboarding });
test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

// Onboarding through the phase-1 first-run wizard (phase1-design §2.9): workspace → machines → channels → notifications →
// Codex. Machines pair from their own Worker App (/worker-connect); the wizard never issues pairing links (§2.9 step 3,
// Appendix B.3). Older entry points (store management, imports, Zhihu jobs) stay reachable outside the core navigation.
const username = 'worker-onboarding-e2e';
const storeName = 'Onboarding fixture store';
const externalStoreId = 'onboarding-fixture-shop';
const shopExportHeader = ['Handle', 'Title', 'Variant SKU', 'Variant Price', 'Variant Inventory Qty'];
const HUB_TOOLS = ['smartsell_overview', 'machines_list', 'channels_list', 'channel_check', 'media_upload', 'post_schedule', 'post_update',
  'posts_list', 'post_get', 'task_get', 'publishing_pause'];

function shopExportRows(samples) {
  return [shopExportHeader, ...samples.map(({ handle, title, sku, priceMinor, quantity }) => [
    handle, title, sku, priceMinor === null ? '' : (priceMinor / 100).toFixed(2), String(quantity ?? ''),
  ])];
}

function responseFor(page, method, path) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

async function dataFrom(response, action, status) {
  const text = await response.text();
  const code = typeof response.status === 'function' ? response.status() : response.status;
  if (status === undefined) expect(code, `${action}: ${text}`).toBeGreaterThanOrEqual(200);
  expect(code, `${action}: ${text}`).toBeLessThan(300);
  if (status !== undefined) expect(code, action).toBe(status);
  return JSON.parse(text).data;
}

async function register(page, dev) {
  const origin = new URL(dev.origin);
  expect(origin.hostname).toBe('127.0.0.1');
  expect(['5173', '5174']).not.toContain(origin.port);
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin.origin
    ? route.continue() : route.abort('blockedbyclient'));
  await page.context().addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  const password = dev.password();
  await page.goto(dev.origin);
  await expect(page.getByRole('heading', { name: 'Register', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const setup = responseFor(page, 'POST', '/api/v1/setup');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  const { workspaces: [{ id }] } = await dataFrom(await setup, 'Register fixture workspace', 201);
  const root = `/api/v1/workspaces/${encodeURIComponent(id)}`;
  const { csrf_token } = await (await page.request.get(`${dev.origin}/api/v1/session/csrf`, { maxRedirects: 0 })).json();
  expect(csrf_token).toEqual(expect.any(String));
  const rest = async (method, path, data, status) => dataFrom(await page.request.fetch(`${dev.origin}${root}${path}`, {
    method, data, maxRedirects: 0,
    headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID() },
  }), `${method} ${path}`, status);
  const localFetch = (url, options) => {
    expect(new URL(url).origin).toBe(dev.origin);
    return fetch(url, { ...options, redirect: 'error' });
  };
  return { id, root, rest, localFetch, password, app: `${dev.origin}/app/${id}`, legacy: `${dev.origin}/w/${id}` };
}

const setupUrl = (ws, step) => `${ws.app}/get-started${step ? `?step=${step}` : ''}`;

/** The wizard is on `step`; the URL carries `?step=<param>` (or no step at all when `implicit`). */
async function expectStep(page, ws, step, { implicit = false, param = step } = {}) {
  const destination = new URL(setupUrl(ws));
  await expect(page).toHaveURL(url => url.origin === destination.origin && url.pathname === destination.pathname &&
    (url.searchParams.get('step') === param || (implicit && !url.searchParams.has('step'))));
  return expectWizardStep(page, step, { locale: 'en' });
}

async function nextStep(page, ws, step) {
  await page.getByRole('main').getByRole('button', { name: 'Next', exact: true }).click();
  return expectStep(page, ws, step);
}

async function openSetupStep(page, ws, step) {
  await page.goto(setupUrl(ws, step));
  return expectStep(page, ws, step);
}

/** The machine pairs from its Worker App with the /worker-connect grant and sends a v2 heartbeat (§5.4.1). */
async function pairWorker(ws, dev, name, { heartbeat = true, grant = workerPairingBody } = {}) {
  const machine = await pairMachine(dev, ws, name, { grant });
  if (heartbeat) await machine.heartbeat();
  return machine;
}

/** The wizard's list of paired machines and one machine's row in it. */
const pairedRow = (page, name) => wizardPanel(page, 'machines', 'en').getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });

/**
 * Connect Codex the §6.2 way from the wizard's last step: create a connection, take its token file, and verify it with
 * one MCP tool call. Returns an MCP client with that token.
 */
async function connectAgent(page, ws, label) {
  const panel = await openSetupStep(page, ws, 'agent');
  await expectStepStatus(page, 'agent', 'todo', 'en');
  await panel.getByRole('textbox', { name: 'Connection name', exact: true }).fill(label);
  const created = responseFor(page, 'POST', `${ws.root}/agent-connections`);
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Create a connection and download the token file', exact: true }).click();
  const connection = await dataFrom(await created, 'Create the relay connection', 201);
  expect(connection).toMatchObject({ label, client: 'codex', token: expect.stringMatching(/^ss_command_/) });
  expect(await readFile(await (await download).path(), 'utf8')).toBe(`${connection.token}\n`);
  await expect(panel.getByRole('status')).toContainText(`Created "${label}".`);
  const agent = mcpClient(connection.mcp_url, connection.token);
  await agent.initialize('onboarding-e2e');
  // Phase 1 lists only the 11 hub tools (§7.1); older tools stay callable by name (§7.4).
  expect((await agent.rpc('tools/list')).tools.map(tool => tool.name)).toEqual(HUB_TOOLS);
  const verified = async () => (await ws.rest('GET', '/agent-connections')).find(row => row.id === connection.id)?.mcp_client_verified_at;
  expect(await verified()).toBeUndefined();
  await expectStepStatus(page, 'agent', 'todo', 'en');
  return { connection, agent, verified };
}

async function submitAsAgent(page, ws, label = 'Onboarding primary agent') {
  const { connection, agent, verified } = await connectAgent(page, ws, label);
  const result = await agent.rpc('tools/call', { name: 'workspace_brand_create', arguments: {
    idempotency_key: randomUUID(), body: { name: 'Onboarding fixture brand', slug: 'onboarding-fixture-brand' },
  } });
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  expect(result.structuredContent.data).toMatchObject({ name: 'Onboarding fixture brand', created_via: 'agent' });
  expect(await verified()).toEqual(expect.any(String));
  const panel = wizardPanel(page, 'agent', 'en');
  await expect(panel.getByText('An Agent has called SmartSell over MCP.', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expectStepStatus(page, 'agent', 'done', 'en');
  expect(await ws.rest('GET', '/agent-connections')).toContainEqual(expect.objectContaining({ id: connection.id, label, last_used_at: expect.any(String) }));
  return { connection, agent };
}

/** An Agent connection made over REST, for tests whose subject is not the connect step. */
async function agentOverRest(ws, label) {
  const connection = await ws.rest('POST', '/agent-connections', { label, client: 'codex', expires_days: 30 }, 201);
  const agent = mcpClient(connection.mcp_url, connection.token);
  await agent.initialize('onboarding-e2e');
  return { connection, agent };
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('an empty workspace enters onboarding from registration, the signed-in root and ordinary login', async ({ page, dev }) => {
  const ws = await register(page, dev);
  await expectStep(page, ws, 'workspace', { implicit: true });
  await page.goto(dev.origin);
  await expectStep(page, ws, 'workspace', { implicit: true });
  // The wizard's own reads (§2.9): the workspace, machines, channels, push channels and Agent connections.
  const wizardReads = ['', '/views/machines', '/views/channels', '/hub/alerts/channels', '/agent-connections'];
  for (let cycle = 1; cycle <= 3; cycle++) {
    await test.step(`Sign out and sign in again (${cycle}/3)`, async () => {
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page).toHaveURL(`${dev.origin}/login`);
      const statuses = [];
      const recordStatus = response => {
        const url = new URL(response.url());
        if (url.origin !== dev.origin || response.request().method() !== 'GET') return;
        const path = url.pathname === ws.root ? '' : url.pathname.startsWith(`${ws.root}/`) ? url.pathname.slice(ws.root.length) : undefined;
        if (path !== undefined && wizardReads.includes(path)) statuses.push([path, response.status()]);
      };
      page.on('response', recordStatus);
      try {
        await signIn(page, ws.password);
        const panel = await expectStep(page, ws, 'workspace', { implicit: true });
        for (const step of wizardSteps) await expectStepStatus(page, step, step === 'notifications' ? 'optional' : 'todo', 'en');
        await expect(panel.getByRole('button', { name: 'Save and continue', exact: true })).toBeEnabled();
        await expect(panel.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
        await expect(panel.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
        await expect.poll(() => wizardReads.every(path => statuses.some(([read]) => read === path))).toBe(true);
        expect(statuses.filter(([, status]) => status !== 200)).toEqual([]);
      } finally {
        page.off('response', recordStatus);
      }
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await nextStep(page, ws, 'machines');
  await expect.poll(() => overflow(page)).toBeLessThanOrEqual(0);
});

test('skipping setup does not complete it, and explicit deep links still resolve', async ({ page, dev, browser }) => {
  const ws = await register(page, dev);
  await expectStep(page, ws, 'workspace', { implicit: true });
  // 「下一步」 moves on without saving; the skipped step stays 待設定 (nothing is completed by skipping).
  await nextStep(page, ws, 'machines');
  await expectStepStatus(page, 'workspace', 'todo', 'en');
  await page.reload();
  await expectStep(page, ws, 'machines');
  await expectStepStatus(page, 'workspace', 'todo', 'en');
  await page.getByRole('main').getByRole('button', { name: 'Back', exact: true }).click();
  await expectStep(page, ws, 'workspace');
  expect(await ws.rest('GET', '/agent-connections')).toEqual([]);
  let panel = await nextStep(page, ws, 'machines');
  await expect(panel.getByText('No machines yet. Follow the steps above on that machine.', { exact: true })).toBeVisible();
  panel = await nextStep(page, ws, 'channels');
  await expect(panel.getByText('Connect a machine first.', { exact: true })).toBeVisible();
  await nextStep(page, ws, 'notifications');
  panel = await nextStep(page, ws, 'agent');
  // The last step has no 「下一步」, only 「完成，前往今日」.
  await expect(panel.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Done, go to Today', exact: true })).toHaveAttribute('href', `/app/${ws.id}`);
  for (const step of wizardSteps) await expectStepStatus(page, step, step === 'notifications' ? 'optional' : 'todo', 'en');
  expect(await finishLater(page, 'en')).toBe(ws.app);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(`${dev.origin}/login`);
  await signIn(page, ws.password);
  // The wizard was left, so the next sign-in opens Today (§9.1) without passing through it.
  await expect(page).toHaveURL(ws.app);
  await expectToday(page, 'en');

  // A fresh session opening an old dashboard or workbench link must return to that resource after login.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === dev.origin
      ? route.continue() : route.abort('blockedbyclient'));
    await context.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
    const linkedPage = await context.newPage();
    // Products is hidden from the phase-1 navigation, but its route stays (§9.1).
    const productsLink = `${ws.app}/products?q=fixture`;
    await linkedPage.goto(productsLink);
    await signIn(linkedPage, ws.password);
    await expect(linkedPage).toHaveURL(productsLink);
    await expect(linkedPage.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
    await expect(linkedPage.getByRole('navigation', { name: 'Dashboard navigation' }).getByRole('link', { name: 'Products', exact: true })).toBeVisible();
    // Links to the previous wizard's steps open the machine step (§2.9: one pairing path); others open the first open step.
    for (const oldStep of ['worker', 'social', 'store', 'import']) {
      await linkedPage.goto(setupUrl(ws, oldStep));
      await expectStep(linkedPage, ws, 'machines', { param: oldStep });
    }
    await linkedPage.goto(setupUrl(ws, 'summary'));
    await expectStep(linkedPage, ws, 'workspace', { param: 'summary' });
    await expect(wizardEntry(linkedPage, 'agent', 'en').locator('small')).toHaveText('To do');
    await linkedPage.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(linkedPage).toHaveURL(`${dev.origin}/login`);
    const legacyLink = `${ws.legacy}/data/imports?tab=imports`;
    await linkedPage.goto(legacyLink);
    await signIn(linkedPage, ws.password);
    await expect(linkedPage).toHaveURL(legacyLink);
    await expect(linkedPage.getByRole('main').getByText('Import batches', { exact: true }).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the machine step lists the built package and shows machines that pair themselves, without pairing links', async ({ page, dev }) => {
  const ws = await register(page, dev);
  const mac = '/api/v1/worker-downloads/mac-arm64';
  const list = '/api/v1/worker-downloads';
  expect((await fetch(`${dev.origin}${mac}`)).status).toBe(401);
  expect(await dataFrom(await page.request.get(`${dev.origin}${list}`), 'List unavailable installers')).toEqual([]);
  expect((await page.request.get(`${dev.origin}${mac}`)).status()).toBe(404);
  const bytes = Buffer.from(await workbookFixture('<row r="1"><c r="A1"><v>123</v></c></row>'), 'base64');
  await dev.writeMacWorkerPackage(bytes);
  // Phase 1 never shows a pairing code or link in the web (§2.9 step 3, Appendix B.3): pairing happens on the machine.
  const issued = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/devices/pairing-codes')) issued.push(request);
  });
  let panel = await openSetupStep(page, ws, 'machines');
  await expect(panel.getByText('No machines yet. Follow the steps above on that machine.', { exact: true })).toBeVisible();
  await expectStepStatus(page, 'machines', 'todo', 'en');
  // The hub address in large type with a copy button; in development there is no hub info, so this page's origin.
  await expect(panel.getByText(dev.origin, { exact: true })).toBeVisible();
  await expect(panel).toContainText('Development mode: no hub information, so this page\'s address is used.');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: dev.origin });
  await panel.getByRole('button', { name: 'Copy the hub address' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(dev.origin);
  // Where each step happens.
  const steps = panel.getByRole('list').filter({ hasText: 'Install Tailscale' }).getByRole('listitem');
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(1)).toHaveText('Install and open SmartSell Worker and paste the hub address above.');
  await expect(steps.nth(3)).toContainText('Pairing always happens on that machine; no links to send.');
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /connection URL/i })).toHaveCount(0);
  // Downloads: the built package links to the signed download; missing ones say how to build them.
  const downloads = panel.locator('.hub-downloads').getByRole('listitem');
  await expect(downloads).toHaveCount(3);
  const link = downloads.filter({ hasText: 'macOS (Apple silicon)' }).getByRole('link', { name: 'Download', exact: true });
  await expect(link).toHaveAttribute('href', mac);
  for (const missing of ['macOS (Intel)', 'Windows']) {
    await expect(downloads.filter({ hasText: missing })).toContainText('Not built yet');
    await expect(downloads.filter({ hasText: missing }).getByRole('link')).toHaveCount(0);
  }
  await expect(panel).toContainText('run pnpm worker:release on the hub');
  expect((await page.request.get(`${dev.origin}${list}/win-x64`)).status()).toBe(404);
  const download = page.waitForEvent('download');
  await link.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('SmartSell-Worker-mac-arm64.zip');
  expect(await readFile(await file.path())).toEqual(bytes);

  // The machine pairs from its own Worker App (/worker-connect grant) and shows up by itself, before any heartbeat.
  const worker = await pairWorker(ws, dev, 'Downloaded Worker', { heartbeat: false });
  const row = pairedRow(page, 'Downloaded Worker');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText('Offline');
  await expectStepStatus(page, 'machines', 'todo', 'en');
  const [beforeHeartbeat] = await ws.rest('GET', '/devices');
  expect(beforeHeartbeat).toMatchObject({ id: worker.id, status: 'active', online: false, last_seen_at: null, allow_channel_registration: true });
  expect(beforeHeartbeat.client_version).toBeUndefined();

  // A store can be assigned to the machine before its first heartbeat.
  const brand = await ws.rest('POST', '/brands', { name: 'First heartbeat brand', slug: 'first-heartbeat-brand' });
  const store = await ws.rest('POST', '/stores', { brand_id: brand.id, provider: 'shopify', mode: 'import', name: 'Assigned before heartbeat',
    external_store_id: 'first-heartbeat-shop', default_currency: 'USD', default_locale: 'en-US' });
  expect(await ws.rest('PUT', `/stores/${store.id}/worker`, { device_id: worker.id, external_store_id: 'first-heartbeat-shop' }))
    .toMatchObject({ device_id: worker.id });

  await worker.heartbeat();
  expect(await ws.rest('GET', '/devices')).toMatchObject([{ id: worker.id, online: true, client_version: '0.2.0', last_seen_at: expect.any(String) }]);
  await expect(row).toContainText('Online', { timeout: 15_000 });
  await expect(row).toContainText('0.2.0');
  await expectStepStatus(page, 'machines', 'done', 'en');
  await expect(row.getByRole('link', { name: 'Downloaded Worker', exact: true })).toHaveAttribute('href', `/app/${ws.id}/machines/${worker.id}`);
  // A channel the machine registers appears under that machine in the next step.
  const channelId = await worker.addChannel('x', 'download_acct');
  panel = await nextStep(page, ws, 'channels');
  const group = panel.locator('section').filter({ has: page.getByRole('heading', { level: 3, name: /^Downloaded Worker/ }) });
  await expect(group.getByRole('link', { name: /@download_acct$/ })).toHaveAttribute('href', `/app/${ws.id}/channels/${channelId}`);
  await expect(group).toContainText('Signed in');

  // After the presence window the machine is offline; it stays paired and the step stays done.
  await dev.setTime(Date.now() + 95_000);
  await page.goto(setupUrl(ws, 'machines'));
  await expectStep(page, ws, 'machines');
  await expect(row).toContainText('Offline');
  await expectStepStatus(page, 'machines', 'done', 'en');
  expect(await ws.rest('GET', '/devices')).toMatchObject([{ id: worker.id, online: false }]);

  // A revoked machine leaves the list and the step is open again.
  await ws.rest('POST', `/devices/${worker.id}/revoke`, {});
  await page.reload();
  await expectStep(page, ws, 'machines');
  await expect(row).toHaveCount(0);
  await expect(wizardPanel(page, 'machines', 'en').getByText('No machines yet. Follow the steps above on that machine.', { exact: true })).toBeVisible();
  await expectStepStatus(page, 'machines', 'todo', 'en');
  expect(issued).toHaveLength(0);
});

test('desktop authorization resumes after login and returns a scoped one-time grant to loopback', async ({ page, dev }) => {
  const ws = await register(page, dev);
  let callback;
  const listener = createServer((request, reply) => {
    callback = { url: request.url, referer: request.headers.referer };
    reply.setHeader('Content-Type', 'text/html');
    reply.end('<p>Received by test desktop listener</p>');
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  const state = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ port: String(port), state, name: 'Test laptop' });
  const entry = `${dev.origin}/worker-connect?${params}`;
  const issuePath = `${ws.root}/devices/pairing-codes`;
  const issued = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === issuePath) issued.push(request);
  });
  try {
    await page.route(`http://127.0.0.1:${port}/smartsell-worker`, route => route.continue());
    await page.goto(`${entry}&return_url=https%3A%2F%2Fexample.test`);
    await expect(page.getByRole('alert')).toContainText('Invalid connection request');
    for (const [key, value] of [['port', '65536'], ['state', 'short'], ['workspace', 'invalid']]) {
      const invalid = new URLSearchParams(params);
      invalid.set(key, value);
      await page.goto(`${dev.origin}/worker-connect?${invalid}`);
      await expect(page.getByRole('alert')).toContainText('Invalid connection request');
    }
    await page.goto(`${entry}&workspace=${randomUUID()}`);
    await expect(page.getByRole('alert')).toContainText('owner or admin access');
    await page.goto(`${entry}&workspace=${ws.id}`);
    const workspace = page.getByRole('combobox', { name: 'Workspace' });
    await expect(workspace).toHaveValue(ws.id);
    await expect(workspace).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(issued).toHaveLength(0);
    const missingCsrf = await page.request.post(`${dev.origin}${issuePath}`, {
      data: { owned_device_confirmed: true }, headers: { Origin: dev.origin, 'Idempotency-Key': randomUUID() },
    });
    expect(missingCsrf.status()).toBe(403);

    await page.goto(setupUrl(ws));
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(`${dev.origin}/login`);
    await page.goto(entry);
    await expect(page).toHaveURL(url => url.pathname === '/login' && url.searchParams.get('next') === `/worker-connect?${params}`);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await signIn(page, ws.password);
    await expect(page).toHaveURL(entry);
    await expect(page.getByRole('heading', { name: 'Authorize desktop worker' })).toBeVisible();
    await expect(page.getByText('Test laptop', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Workspace' })).toHaveValue(ws.id);
    expect(issued).toHaveLength(0);
    await expect(page.getByText('By authorizing, you confirm', { exact: false })).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    const grant = responseFor(page, 'POST', issuePath);
    await page.getByRole('button', { name: 'Authorize and return to desktop' }).click();
    const response = await grant;
    expect(response.ok()).toBe(true);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(issued[0].headers()['x-csrf-token']).toBeTruthy();
    const destination = `http://127.0.0.1:${port}/smartsell-worker`;
    await expect(page).toHaveURL(url => `${url.origin}${url.pathname}` === destination && !url.search && !!url.hash);
    const fragment = new URLSearchParams(new URL(page.url()).hash.slice(1));
    const pairing_code = fragment.get('code');
    expect(pairing_code).toMatch(/^[\w-]{32}$/);
    expect([...fragment]).toEqual([['state', state], ['workspace', ws.id], ['code', pairing_code]]);
    expect(callback).toEqual({ url: '/smartsell-worker', referer: undefined });
    await pairWithCode(ws, dev, 'Authorized Worker', pairing_code);
    await expect(pairWithCode(ws, dev, 'Second machine', pairing_code)).rejects.toThrow();

    dev.updateSnapshot(snapshot => { snapshot.scope.role = 'editor'; });
    await page.goto(`${entry}&workspace=${ws.id}`);
    await expect(page.getByRole('alert')).toContainText('owner or admin access');
    await expect(page.getByRole('combobox', { name: 'Workspace' })).toHaveCount(0);
    const session = await (await page.request.get(`${dev.origin}/api/v1/session`)).json();
    const denied = await page.request.post(`${dev.origin}${issuePath}`, {
      data: { owned_device_confirmed: true }, headers: { Origin: dev.origin, 'Idempotency-Key': randomUUID(), 'X-CSRF-Token': session.data.csrf_token },
    });
    expect(denied.status()).toBe(403);
    expect(issued).toHaveLength(1);
  } finally {
    listener.close();
    listener.closeAllConnections();
  }
});

/** The /worker-connect hand-off: a pairing code granted in the browser, redeemed by the desktop with its own key. */
async function pairWithCode(ws, dev, name, pairingCode) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const id = await pairOverHttp(dev.origin, ws.id, pairingCode, 'darwin', name, privateKey, { userInitiated: true, ownsDevice: true }, ws.localFetch);
  const client = new SignedDeviceClient(ws.id, id, privateKey, createSignedHttpTransport(dev.origin, ws.localFetch));
  await client.heartbeat('worker-onboarding-e2e');
  return { id, client };
}

// Phase 1 pairs only through /worker-connect, whose grant always allows channel registration (§2.9 step 3; worker-connect.tsx
// workerPairingBody), and the hub starts from a new data file (§1.2), so the old wizard's per-machine "allow channel
// registration" switch is gone. What stays: only a machine holding that grant can add channels, and every channel lands
// under the machine that registered it.
test('only a machine paired with the registration grant adds channels, and each channel lands under its own machine', async ({ page, dev }) => {
  const ws = await register(page, dev);
  const first = await pairWorker(ws, dev, 'Existing Worker A');
  const second = await pairWorker(ws, dev, 'Existing Worker B', { grant: { owned_device_confirmed: true } });
  expect(await ws.rest('GET', '/devices')).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.id, allow_channel_registration: true }),
    expect.objectContaining({ id: second.id, allow_channel_registration: false }),
  ]));
  const attempts = [];
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/channel-registration')) attempts.push(request);
  });
  await expect(second.addChannel('x', 'existing_worker')).rejects.toMatchObject({ status: 403 });
  const channelId = await first.addChannel('x', 'existing_worker');
  expect(await ws.rest('GET', '/views/channels')).toEqual([expect.objectContaining({ channel_id: channelId, handle: 'existing_worker',
    machine: expect.objectContaining({ id: first.id }) })]);

  const panel = await openSetupStep(page, ws, 'channels');
  const group = name => panel.locator('section').filter({ has: page.getByRole('heading', { level: 3, name: new RegExp(`^${name}`) }) });
  await expect(group('Existing Worker A').getByRole('link', { name: /@existing_worker$/ })).toHaveAttribute('href', `/app/${ws.id}/channels/${channelId}`);
  await expect(group('Existing Worker A')).toContainText('Signed in');
  await expect(group('Existing Worker B').getByText('No channels on this machine yet.', { exact: true })).toBeVisible();
  await expect(group('Existing Worker B').getByRole('link')).toHaveCount(0);

  // The channels page filters by machine the same way.
  await page.goto(`${ws.app}/channels`);
  const machine = page.getByRole('combobox', { name: 'Machine', exact: true });
  await machine.selectOption(second.id);
  await expect(page).toHaveURL(`${ws.app}/channels?machine_id=${second.id}`);
  await expect(page.getByRole('main').getByText(/^No channels yet\./)).toBeVisible();
  await machine.selectOption(first.id);
  const card = page.getByRole('main').getByRole('article').filter({ has: page.getByRole('link', { name: /@existing_worker$/ }) });
  await expect(card).toContainText('Existing Worker A');
  await dev.setTime(Date.now() + 95_000);
  await page.reload();
  await expect(card).toContainText('Offline');
  expect(attempts).toHaveLength(0);
});

test('the wizard completes with an Agent and two machines, and paired workers run signed CSV and XLSX imports', async ({ page, dev }) => {
  const ws = await register(page, dev);
  const main = page.getByRole('main');
  await expectStep(page, ws, 'workspace', { implicit: true });
  await submitAsAgent(page, ws);
  const [brand] = await ws.rest('GET', '/brands');
  expect(brand).toMatchObject({ name: 'Onboarding fixture brand' });

  await openSetupStep(page, ws, 'machines');
  const primary = await pairWorker(ws, dev, 'Catalog Worker A');
  const other = await pairWorker(ws, dev, 'Catalog Worker B');
  expect(primary.id).not.toBe(other.id);
  for (const name of ['Catalog Worker A', 'Catalog Worker B']) await expect(pairedRow(page, name)).toContainText('Online', { timeout: 15_000 });
  await expectStepStatus(page, 'machines', 'done', 'en');
  expect(await finishLater(page, 'en')).toBe(ws.app);
  // 開始設定 from the navigation reopens the first open step; finished steps keep their status.
  await page.getByRole('navigation', { name: 'Dashboard navigation' }).getByRole('link', { name: 'Get started', exact: true }).click();
  await expectStep(page, ws, 'workspace', { implicit: true });
  await expectStepStatus(page, 'machines', 'done', 'en');
  await expectStepStatus(page, 'agent', 'done', 'en');
  expect(await ws.rest('GET', '/stores')).toEqual([]);
  expect(await ws.rest('GET', '/products')).toEqual([]);

  // Channels are in the dashboard navigation (§9.1; Settings no longer repeats the link in phase 1, U6); they come from the Worker (§8.16).
  await page.goto(`${ws.app}/settings`);
  await page.getByRole('navigation', { name: 'Dashboard navigation' }).getByRole('link', { name: 'Channels', exact: true }).click();
  await expect(page).toHaveURL(`${ws.app}/channels`);
  await expect(main.getByText(/^No channels yet\. Add them in SmartSell Worker on the machine that posts/)).toBeVisible();
  const channelId = await primary.addChannel('x', 'catalog_fixture');
  await page.reload();
  const channelCard = main.getByRole('article').filter({ has: page.getByRole('link', { name: /@catalog_fixture$/ }) });
  await expect(channelCard).toContainText('Catalog Worker A');
  await expect(channelCard).toContainText('Signed in');
  // The legacy settings path still lands on the channels page.
  await page.goto(`${ws.app}/settings/worker-accounts`);
  await expect(page).toHaveURL(`${ws.app}/channels`);

  const readCatalog = () => ws.rest('GET', '/worker-catalog');
  expect(await readCatalog()).toEqual({ bindings: [], jobs: [] });
  await page.goto(`${ws.app}/products`);
  await page.getByRole('link', { name: 'Store', exact: true }).click();
  await page.getByLabel('Store platform').selectOption('shopify');
  await page.getByRole('combobox', { name: 'Brand', exact: true }).selectOption(brand.id);
  await page.getByRole('textbox', { name: 'Store name', exact: true }).fill(storeName);
  await page.getByLabel('Actual store ID on the platform').fill(externalStoreId);
  const created = responseFor(page, 'POST', `${ws.root}/stores`);
  await page.getByRole('button', { name: 'Add an import-mode store' }).click();
  const store = await dataFrom(await created, 'Register import-mode fixture store');
  expect(store).toMatchObject({ brand_id: brand.id, provider: 'shopify', external_store_id: externalStoreId, status: 'import_only' });
  await page.getByLabel('Dedicated worker').selectOption(primary.id);
  const bound = responseFor(page, 'PUT', `${ws.root}/stores/${store.id}/worker`);
  await page.getByRole('button', { name: 'Save worker assignment' }).click();
  await dataFrom(await bound, 'Bind store to the selected Worker');
  const binding = { store_id: store.id, device_id: primary.id, device_name: 'Catalog Worker A', external_store_id: externalStoreId };
  expect((await readCatalog()).bindings).toEqual([expect.objectContaining(binding)]);
  await expect(main.getByRole('button', { name: 'Start product import' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Product import', exact: true }).click();
  await expect(main.getByRole('combobox', { name: 'Choose a store with a dedicated worker' })).toHaveValue(store.id);
  await expect(main.getByRole('button', { name: 'Add an import-mode store' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Set up a market for prices and stock (optional)', exact: true }).click();
  await page.getByRole('button', { name: 'Create market · USD', exact: true }).click();
  await page.getByRole('textbox', { name: 'Market name', exact: true }).fill('Fixture US market');
  await page.getByRole('textbox', { name: 'Country code (two letters)', exact: true }).fill('US');
  await page.getByRole('textbox', { name: 'Market locale', exact: true }).fill('en-US');
  await page.getByRole('textbox', { name: 'Time zone (IANA)', exact: true }).fill('America/New_York');
  const brandMarkets = `/brands/${brand.id}/markets`;
  const marketCreated = responseFor(page, 'POST', `${ws.root}${brandMarkets}`);
  await page.getByRole('button', { name: 'Create market · USD', exact: true }).click();
  const market = await dataFrom(await marketCreated, 'Create market from the onboarding form');
  expect(market).toMatchObject({ name: 'Fixture US market', brand_id: brand.id, currency: 'USD', country_code: 'US' });
  await expect(page.getByRole('combobox', { name: 'Market', exact: true })).toHaveValue(market.id);
  await page.getByRole('combobox', { name: 'Sales channel', exact: true }).selectOption({ label: 'Online store' });
  const marketPath = `/stores/${store.id}/markets`;
  const marketConfig = { market_id: market.id, channel: 'online_store', price_source: 'store_base_price', enabled: true };
  const marketSaved = responseFor(page, 'PUT', `${ws.root}${marketPath}`);
  await page.getByRole('button', { name: 'Save store base price setup', exact: true }).click();
  await dataFrom(await marketSaved, 'Save market and sales channel from store management');
  await expect(page.getByRole('status').filter({ hasText: 'Market and channel saved' })).toBeVisible();
  expect(await ws.rest('GET', marketPath)).toMatchObject([{ ...marketConfig, store_id: store.id }]);

  const tea = { handle: 'onboarding-fixture-tea', sku: '00042-ONBOARDING' };
  const unknown = { handle: 'onboarding-fixture-mug', sku: '00043-ONBOARDING', priceMinor: null, quantity: null,
    priceText: 'Not collected', stockStatus: 'unknown', stockText: 'Stock not collected' };
  const csvSamples = [
    { ...tea, title: 'Fixture tea from CSV', priceMinor: 1230, quantity: 5,
      priceText: 'US$12.30', stockStatus: 'in_stock', stockText: 'In stock 5' },
    { ...unknown, title: 'Fixture mug from CSV' },
  ];
  const xlsxSamples = [
    { ...tea, title: 'Fixture tea updated by XLSX', priceMinor: 0, quantity: 0,
      priceText: 'US$0', stockStatus: 'out_of_stock', stockText: 'Out of stock' },
    { ...unknown, title: 'Fixture mug updated by XLSX' },
  ];
  const sheetData = shopExportRows(xlsxSamples).map((row, index) =>
    `<row r="${index + 1}">${row.map((value, column) => textCell(`${'ABCDE'[column]}${index + 1}`, value)).join('')}</row>`).join('');
  const files = [
    { samples: csvSamples, rowStatus: 'new', upload: { csv: shopExportRows(csvSamples).map(row => row.join(',')).join('\r\n') } },
    { samples: xlsxSamples, rowStatus: 'changed', upload: { xlsx_base64: await workbookFixture(sheetData) } },
  ];

  const initialVariants = new Map();
  let priorProducts = [];
  for (const [index, { samples, rowStatus, upload }] of files.entries()) {
    if (index > 0) {
      await page.goto(`${ws.app}/products/stores/imports?store=${store.id}`);
      await page.getByRole('button', { name: 'Import another product export' }).click();
    }
    const enqueued = responseFor(page, 'POST', `${ws.root}/stores/${store.id}/worker/imports`);
    await page.getByRole('button', { name: 'Start product import' }).click();
    const job = await dataFrom(await enqueued, 'Queue fixture catalog import', 202);
    const expectedJob = { id: job.id, store_id: store.id, device_id: primary.id, store_name: storeName,
      provider: 'shopify', external_store_id: externalStoreId };
    const catalogJob = async () => (await readCatalog()).jobs.find(row => row.id === job.id);
    expect(job.id).toEqual(expect.any(String));
    const queued = await catalogJob();
    expect(queued).toMatchObject({ ...expectedJob, status: 'queued', expires_at: expect.any(String) });
    expect(await other.signed.claimCatalog()).toBeNull();
    expect(await catalogJob()).toEqual(queued);

    const claim = await primary.signed.claimCatalog();
    expect(claim).toMatchObject({ ...expectedJob, claim_id: expect.any(String), expires_at: expect.any(String) });
    const claimed = await catalogJob();
    expect(claimed).toMatchObject({ ...expectedJob, status: 'claimed', expires_at: claim.expires_at });
    await expect(other.signed.uploadCatalog(claim, externalStoreId, upload)).rejects.toMatchObject({ status: 403 });
    await expect(primary.signed.uploadCatalog(claim, 'different-fixture-shop', upload)).rejects.toMatchObject({ status: 409 });
    expect(await catalogJob()).toEqual(claimed);
    expect(claimed.import_id ?? null).toBeNull();
    expect(await ws.rest('GET', '/imports')).toHaveLength(index);

    const result = await primary.signed.uploadCatalog(claim, externalStoreId, upload);
    expect(result).toEqual({ import_id: expect.any(String), status: 'previewed' });
    expect(await catalogJob()).toMatchObject({ ...expectedJob, import_id: result.import_id, status: 'previewed' });
    expect(await primary.signed.claimCatalog()).toBeNull();
    const beforeMerge = await ws.rest('GET', '/products');
    expect(beforeMerge).toHaveLength(priorProducts.length);
    expect(beforeMerge).toEqual(expect.arrayContaining(priorProducts.map(({ id, title }) => expect.objectContaining({ id, title }))));
    await main.getByRole('region', { name: 'Product import', exact: true }).getByRole('button', { name: 'Check status again' }).first().click();
    await previewAndMerge(page, ws, result.import_id, store.id, samples, rowStatus);
    expect(await catalogJob()).toMatchObject({ ...expectedJob, import_id: result.import_id, status: 'imported' });
    const products = await ws.rest('GET', '/products');
    expect(products).toHaveLength(samples.length);
    for (const sample of samples) {
      const product = products.find(row => row.title === sample.title);
      expect(product).toMatchObject({ id: expect.any(String), store_id: store.id });
      const variantId = await expectProductOnDashboard(page, ws, market, product.id, sample);
      if (index === 0) initialVariants.set(sample.sku, { productId: product.id, variantId });
      else expect({ productId: product.id, variantId }).toEqual(initialVariants.get(sample.sku));
    }
    priorProducts = products;
  }

  // Back in the wizard at phone width: each machine lists only its own channels, then 「完成，前往今日」.
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openSetupStep(page, ws, 'channels');
  const group = name => panel.locator('section').filter({ has: page.getByRole('heading', { level: 3, name: new RegExp(`^${name}`) }) });
  await expect(group('Catalog Worker A').getByRole('link', { name: /@catalog_fixture$/ })).toHaveAttribute('href', `/app/${ws.id}/channels/${channelId}`);
  await expect(group('Catalog Worker B').getByText('No channels on this machine yet.', { exact: true })).toBeVisible();
  await expect.poll(() => overflow(page), { message: 'the channel step fits the mobile viewport' }).toBeLessThanOrEqual(0);
  await openSetupStep(page, ws, 'agent');
  await expect.poll(() => overflow(page), { message: 'the last step fits the mobile viewport' }).toBeLessThanOrEqual(0);
  await main.getByRole('link', { name: 'Done, go to Today', exact: true }).click();
  await expect(page).toHaveURL(ws.app);
  await expectToday(page, 'en');
});

async function storeRecoveryFixture(page, dev) {
  const ws = await register(page, dev);
  await expectStep(page, ws, 'workspace', { implicit: true });
  const { agent } = await agentOverRest(ws, 'Recovery agent');
  const result = await agent.rpc('tools/call', { name: 'workspace_brand_create', arguments: {
    idempotency_key: randomUUID(), body: { name: 'Onboarding fixture brand', slug: 'onboarding-fixture-brand' },
  } });
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  const worker = await pairWorker(ws, dev, 'Recovery Worker');
  const [brand] = await ws.rest('GET', '/brands');
  const store = await ws.rest('POST', '/stores', { brand_id: brand.id, provider: 'shopify', mode: 'import', name: 'Existing recovery fixture',
    external_store_id: 'recovery-existing', default_currency: 'USD', default_locale: 'en-US' });
  await page.goto(`${ws.app}/products/stores`);
  return { ws, brand, store, worker };
}

async function previewAndMerge(page, ws, importId, storeId, samples, expectedRowStatus) {
  const path = `/imports/${encodeURIComponent(importId)}`;
  expect(await ws.rest('GET', path)).toMatchObject({ store_id: storeId, template_key: 'product_list',
    status: 'awaiting_confirmation', stats: { rows: samples.length, valid: samples.length, invalid: 0 } });
  await expect(page.getByRole('heading', { name: 'Review product import preview' })).toBeVisible();
  const rows = await ws.rest('GET', `${path}/rows`);
  expect(rows).toHaveLength(samples.length);
  const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Source price' }) });
  await expect(table.getByRole('row')).toHaveCount(samples.length + 1);
  for (const [index, { sku, title, priceMinor, quantity }] of samples.entries()) {
    const row = rows[index];
    expect(row).toMatchObject({ status: expectedRowStatus, normalized: { sku, title } });
    if (priceMinor === null) {
      expect(row.normalized).not.toHaveProperty('price_minor');
      expect(row.normalized).not.toHaveProperty('available');
    } else {
      expect(row.normalized).toMatchObject({ price_minor: priceMinor, currency: 'USD', available: quantity });
    }
    const visibleRow = table.getByRole('row').filter({ hasText: sku });
    await expect(visibleRow.getByText(sku, { exact: true })).toBeVisible();
    await expect(visibleRow).toContainText(title);
    const cells = visibleRow.getByRole('cell');
    await expect(cells.nth(1)).toHaveText(priceMinor === null ? 'Not collected' : new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD',
    }).format(priceMinor / 100));
    await expect(cells.nth(2)).toHaveText(quantity === null ? 'Unknown' : String(quantity));
  }
  const confirm = page.getByRole('button', { name: 'Confirm merge', exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByRole('checkbox', { name: /^I reviewed the preview and confirm/ }).check();
  const merged = responseFor(page, 'POST', `${ws.root}${path}/confirm`);
  await confirm.click();
  await expect(page).toHaveURL(`${ws.app}/products/stores/imports?store=${storeId}`);
  expect(await dataFrom(await merged, 'Merge reviewed Worker import')).toMatchObject({
    id: importId, status: 'merged', merged_rows: samples.length, failed_rows: 0,
  });
  await expect(page.getByText(`Merged / unchanged / left out · ${samples.length} / 0 / 0`, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View products in a new tab' })).toBeVisible();
}

async function expectProductOnDashboard(page, ws, market, productId, sample) {
  const { title, sku, priceMinor, quantity, priceText, stockStatus, stockText } = sample;
  await page.goto(`${ws.app}/products`);
  await page.getByRole('searchbox', { name: 'Search by product name or SKU' }).fill(sku);
  await expect(page).toHaveURL(`${ws.app}/products?q=${sku}`);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Products', exact: true })).toBeVisible();
  const detailRead = responseFor(page, 'GET', `${ws.root}/views/products/${productId}`);
  await page.getByRole('main').getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${productId}(?:\\?|$)`));
  const detail = await dataFrom(await detailRead, `Read product detail for ${sku}`);
  const marketKey = { market_id: market.id, market_name: market.name, channel: 'online_store' };
  const availability = quantity === null ? 'not_collected' : 'observed';
  expect(detail).toMatchObject({ id: productId, title, markets: [{ ...marketKey,
    price: priceMinor === null ? null : { min_minor: priceMinor, max_minor: priceMinor, currency: 'USD' },
    stock: { status: stockStatus, quantity, availability, variants_total: 1, variants_observed: quantity === null ? 0 : 1 },
  }], variants: [{ id: expect.any(String), sku, listings: priceMinor === null ? [] : [{
    ...marketKey, price_minor: priceMinor, currency: 'USD', inventory_quantity: quantity, inventory_status: stockStatus, availability,
  }] }] });

  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
  const matrix = page.getByRole('region', { name: 'Market prices and stock' });
  await expect(matrix.getByRole('columnheader', { name: market.name, exact: true })).toBeVisible();
  const variant = matrix.getByRole('row').filter({ has: page.getByRole('rowheader', { name: sku, exact: true }) });
  await expect(variant.getByText(priceText, { exact: true })).toBeVisible();
  const summary = matrix.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'All variants', exact: true }) });
  await expect(summary.getByText(stockText, { exact: true })).toBeVisible();
  if (quantity !== null) await expect(variant.getByText(stockText, { exact: true })).toBeVisible();
  return detail.variants[0].id;
}

async function signIn(page, password) {
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

function addStore(page) {
  return page.getByRole('button', { name: 'Add an import-mode store', exact: true });
}

async function fillStore(page, brand, name, externalId) {
  await addStore(page).click();
  await page.getByLabel('Store platform').selectOption('shopify');
  await page.getByRole('combobox', { name: 'Brand', exact: true }).selectOption(brand.id);
  await page.getByRole('textbox', { name: 'Store name', exact: true }).fill(name);
  await page.getByLabel('Actual store ID on the platform').fill(externalId);
}

async function expectSelectedStore(page, ws, id) {
  await expect(page.getByRole('combobox', { name: 'Choose an existing store', exact: true })).toHaveValue(id);
  await expect(page).toHaveURL(url => url.pathname === new URL(`${ws.app}/products/stores`).pathname && url.searchParams.get('store') === id);
}

test('store management recovers a committed create whose response was lost, then resumes after reload', async ({ page, dev }) => {
  const { ws, brand, store, worker } = await storeRecoveryFixture(page, dev);
  const externalId = 'recovery-lost-response';
  await fillStore(page, brand, 'Lost response fixture', externalId);
  let upstreamStatus;
  const dropped = Promise.withResolvers();
  await page.route(`${dev.origin}${ws.root}/stores`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    try {
      upstreamStatus = (await route.fetch({ maxRedirects: 0, maxRetries: 0 })).status();
      await route.abort('failed');
      dropped.resolve();
    } catch (error) { dropped.reject(error); }
  });
  await addStore(page).click();
  await dropped.promise;
  expect(upstreamStatus, 'the real server accepted the write before the browser response was dropped').toBe(200);
  const stores = await ws.rest('GET', '/stores');
  const [saved] = stores.filter(item => item.external_store_id === externalId);
  expect(stores.map(item => item.id).sort()).toEqual([store.id, saved.id].sort());
  await expectSelectedStore(page, ws, saved.id);
  await expect(page.getByLabel('Dedicated worker')).toBeVisible();
  await page.reload();
  await expectSelectedStore(page, ws, saved.id);
  await page.getByLabel('Dedicated worker').selectOption(worker.id);
  await page.getByRole('button', { name: 'Save worker assignment', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Product import', exact: true })).toBeVisible();
  expect((await ws.rest('GET', '/worker-catalog')).bindings).toEqual([expect.objectContaining({ store_id: saved.id, device_id: worker.id })]);
  expect((await ws.rest('GET', '/stores')).filter(item => item.external_store_id === externalId)).toEqual([saved]);
  await page.getByRole('link', { name: 'Product import', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Choose a store with a dedicated worker' })).toHaveValue(saved.id);
});

test('two management tabs recover the same store from competing registrations without duplicating it', async ({ page, dev }) => {
  const { ws, brand, store } = await storeRecoveryFixture(page, dev);
  const second = await page.context().newPage();
  const externalId = 'recovery-two-tabs';
  try {
    await second.goto(`${ws.app}/products/stores`);
    await Promise.all([page, second].map(tab => fillStore(tab, brand, 'Two tabs fixture', externalId)));
    const bothRequests = Promise.withResolvers();
    const statuses = [];
    let arrivals = 0;
    for (const tab of [page, second]) await tab.route(`${dev.origin}${ws.root}/stores`, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (++arrivals === 2) bothRequests.resolve();
      await bothRequests.promise;
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      statuses.push(response.status());
      await route.fulfill({ response });
    });
    const replies = [page, second].map(tab => responseFor(tab, 'POST', `${ws.root}/stores`));
    await Promise.all([page, second].map(tab => addStore(tab).click()));
    await Promise.all(replies);
    expect(statuses.sort()).toEqual([200, 409]);
    const stores = await ws.rest('GET', '/stores');
    const [saved] = stores.filter(item => item.external_store_id === externalId);
    expect(stores.map(item => item.id).sort()).toEqual([store.id, saved.id].sort());
    for (const tab of [page, second]) {
      await expectSelectedStore(tab, ws, saved.id);
      await expect(tab.getByLabel('Dedicated worker')).toBeVisible();
      await tab.unroute(`${dev.origin}${ws.root}/stores`);
    }
    await fillStore(second, brand, 'Different configuration', externalId);
    const conflict = responseFor(second, 'POST', `${ws.root}/stores`);
    await addStore(second).click();
    expect((await conflict).status()).toBe(409);
    await expect(second.getByRole('alert').first()).toBeVisible();
    await expect(second.getByRole('textbox', { name: 'Store name', exact: true })).toHaveValue('Different configuration');
    expect((await ws.rest('GET', '/stores')).filter(item => item.external_store_id === externalId)).toEqual([saved]);
  } finally { await second.close(); }
});

test('desktop Zhihu jobs route to their signed Workers and leave a Web login incident behind 顯示其他模組', async ({ page, dev }) => {
  const ws = await register(page, dev);
  await expectStep(page, ws, 'workspace', { implicit: true });
  const { agent } = await agentOverRest(ws, 'Zhihu agent');
  // Phase 1 lists only the hub tools (§7.1); the Zhihu tools are hidden but still callable by name (§7.4).
  const names = (await agent.rpc('tools/list', {})).tools.map(tool => tool.name);
  expect(names).toEqual(HUB_TOOLS);
  const call = async (name, args) => {
    const result = await agent.rpc('tools/call', { name, arguments: args });
    expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeFalsy();
    return result.structuredContent.data;
  };
  const a = await pairWorker(ws, dev, 'Zhihu fixture Worker A');
  const b = await pairWorker(ws, dev, 'Zhihu fixture Worker B');
  const enqueue = body => call('zhihu_stats_create', { body, idempotency_key: randomUUID() });
  const read = id => call('zhihu_stats_get', { params: { id } });
  const login = await enqueue({ device_id: a.id, mode: 'login_check' });
  expect(login).toMatchObject({ status: 'queued', device_id: a.id, mode: 'login_check' });
  expect(await b.signed.claimZhihuStats()).toBeNull();
  const stats = await enqueue({ device_id: b.id, profile_slug: 'fixture-self' });
  const claimA = await a.signed.claimZhihuStats();
  const claimB = await b.signed.claimZhihuStats();
  expect(claimA).toMatchObject({ id: login.id, device_id: a.id });
  expect(claimB).toMatchObject({ id: stats.id, device_id: b.id });
  const blocked = { status: 'blocked', reason: 'login_required' };
  const observed = { status: 'completed', profile_slug: 'fixture-self', followers_text: '0', upvotes_text: '获得 12 次赞同' };
  await a.signed.reportZhihuStats({ id: claimA.id, fencing_token: claimA.fencing_token, result: blocked });
  await b.signed.reportZhihuStats({ id: claimB.id, fencing_token: claimB.fencing_token, result: observed });
  const incident = await read(login.id);
  expect(incident).toMatchObject({ id: login.id, device_id: a.id, status: 'blocked', result: blocked, reported_at: expect.any(String) });
  expect(await read(stats.id)).toMatchObject({ status: 'completed', device_id: b.id, result: observed });

  const brand = await ws.rest('POST', '/brands', { name: 'Desktop fixture brand', slug: 'desktop-fixture-brand' });
  const store = await ws.rest('POST', '/stores', { brand_id: brand.id, provider: 'shopify', mode: 'import', name: 'Desktop fixture store',
    external_store_id: 'desktop-fixture-shop', default_currency: 'USD', default_locale: 'en-US' });
  const product = await ws.rest('POST', '/products', { store_id: store.id, title: 'Desktop fixture product', status: 'active' });
  const request = { body: { capability: 'product_listing', product_id: product.id, store_id: store.id }, idempotency_key: randomUUID() };
  const receipt = await call('desktop_request_capability', request);
  expect(receipt).toMatchObject({ product_id: product.id, status: 'unsupported', reason: 'product_listing_not_supported' });
  expect(await call('desktop_request_capability', request)).toEqual(receipt);
  expect(await call('desktop_get_capability_request', { params: { id: receipt.id } })).toEqual(receipt);
  expect(await a.signed.claimZhihuStats()).toBeNull();
  expect(await b.signed.claimZhihuStats()).toBeNull();
  expect(await ws.rest('GET', '/worker-catalog')).toEqual({ bindings: [], jobs: [] });

  // The core Agent page does not show the hidden Zhihu module (§9.1) ...
  const incidents = page.getByRole('list', { name: 'Zhihu sign-in incidents' });
  await page.goto(`${ws.app}/agent`);
  await expect(page.getByRole('heading', { level: 1, name: 'Agent', exact: true })).toBeVisible();
  await expect(incidents).toHaveCount(0);
  // ... until Settings → Interface → Show other modules brings it back.
  await showMoreModules(page, ws.app, 'en');
  await page.goto(`${ws.app}/agent`);
  for (let visit = 0; visit < 2; visit++) {
    if (visit > 0) await page.reload();
    const row = incidents.getByRole('listitem');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Zhihu sign-in required');
    await expect(row).toContainText(login.id);
    await expect(row).toContainText(a.id);
    await expect(row).toContainText(incident.reported_at);
  }
});

test('existing business data keeps normal entry points on the dashboard', async ({ page, dev }) => {
  const ws = await register(page, dev);
  const brand = await ws.rest('POST', '/brands', { name: 'Existing fixture brand', slug: 'existing-fixture-brand' });
  const store = await ws.rest('POST', '/stores', { brand_id: brand.id, provider: 'shopify', mode: 'import', name: 'Existing fixture store',
    external_store_id: 'existing-fixture-shop', default_currency: 'USD', default_locale: 'en-US' });
  const product = await ws.rest('POST', '/products', { store_id: store.id, title: 'Existing fixture product', status: 'active' });
  // This workspace has never dismissed the wizard. It is the real business inventory that prevents the redirect;
  // the dashboard index is Today in phase 1 (§9.1).
  await page.goto(dev.origin);
  await expect(page).toHaveURL(ws.app);
  await expectToday(page, 'en');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, ws.password);
  await expect(page).toHaveURL(ws.app);
  await expectToday(page, 'en');
  const target = `${ws.app}/products/${product.id}`;
  await page.goto(target);
  await expect(page).toHaveURL(target);
  await expect(page.getByRole('heading', { name: product.title, exact: true })).toBeVisible();
});
