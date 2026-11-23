import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { createSignedHttpTransport, pairOverHttp, SignedDeviceClient } from '../../apps/connector/src/device-client.ts';
import { textCell, workbookFixture } from '../../apps/server/src/modules/ingest/xlsx-fixture.ts';
import { localWorkerOnboarding } from './local-dev.mjs';

const test = base.extend({ dev: localWorkerOnboarding });
test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

const username = 'worker-onboarding-e2e';
const agentName = 'Onboarding primary agent';
const storeName = 'Onboarding fixture store';
const externalStoreId = 'onboarding-fixture-shop';
const shopExportHeader = ['Handle', 'Title', 'Variant SKU', 'Variant Price', 'Variant Inventory Qty'];

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
  const rest = async (method, path, data) => dataFrom(await page.request.fetch(`${dev.origin}${root}${path}`, {
    method, data, maxRedirects: 0,
    headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID() },
  }), `${method} ${path}`);
  const localFetch = (url, options) => {
    expect(new URL(url).origin).toBe(dev.origin);
    return fetch(url, { ...options, redirect: 'error' });
  };
  return { id, root, rest, localFetch, password, app: `${dev.origin}/app/${id}`, legacy: `${dev.origin}/w/${id}` };
}

async function connectAgent(page, ws, dev) {
  await page.getByRole('combobox', { name: 'Agent client', exact: true }).selectOption('codex');
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(agentName);
  const created = responseFor(page, 'POST', `${ws.root}/agent-connections/enroll`);
  await page.getByRole('button', { name: 'Generate setup prompt', exact: true }).click();
  const { code, redeem_url, mcp_url, id } = await dataFrom(await created, 'Generate primary Agent prompt', 201);
  expect(mcp_url).toBe(`${dev.origin}/mcp`);
  const command = page.getByRole('textbox', { name: 'Local terminal command', exact: true });
  await expect(command).toBeVisible();
  const codeField = page.getByRole('textbox', { name: 'One-time code (hidden terminal prompt only)', exact: true });
  await expect(codeField).toBeVisible();
  expect((await command.inputValue()).includes(code)).toBe(false);
  const redeemed = await ws.localFetch(redeem_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const { token } = await dataFrom(redeemed, 'Redeem Agent code', 201);
  await page.getByRole('button', { name: 'Check status again', exact: true }).click();
  await expect(page.getByText('Credential issued, awaiting first use', { exact: true }).first()).toBeVisible();
  async function rpc(method, params) {
    const response = await ws.localFetch(mcp_url, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: randomUUID() }), method, params }),
    });
    const body = await response.text();
    if (method.startsWith('notifications/')) {
      expect(response.status, `MCP ${method}`).toBe(202);
      return;
    }
    expect(response.status, `MCP ${method}`).toBe(200);
    const json = response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n') : body;
    const message = JSON.parse(json);
    expect(message.error, `MCP ${method}`).toBeUndefined();
    return message.result;
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'onboarding-e2e', version: '1' } });
  await rpc('notifications/initialized');
  const { tools } = await rpc('tools/list', {});
  expect(tools.map(tool => tool.name)).toContain('smartsell_operations_describe');
  const refresh = page.getByRole('button', { name: 'Check status again', exact: true });
  await refresh.click();
  await expect(page.getByText('MCP connection verified', { exact: true })).toHaveCount(0);
  const verified = async () => (await ws.rest('GET', '/agent-connections')).find(connection => connection.id === id)?.mcp_client_verified_at;
  expect(await verified()).toBeUndefined();
  const result = await rpc('tools/call', { name: 'smartsell_operations_describe', arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(await verified()).toEqual(expect.any(String));
  await refresh.click();
  await expect(page.getByText('MCP connection verified', { exact: true })).toBeVisible();
  return { id, rpc };
}

async function submitAsAgent(page, ws, dev) {
  const { id, rpc } = await connectAgent(page, ws, dev);
  const result = await rpc('tools/call', { name: 'workspace_brand_create', arguments: {
    idempotency_key: randomUUID(), body: { name: 'Onboarding fixture brand', slug: 'onboarding-fixture-brand' },
  } });
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  expect(result.structuredContent.data).toMatchObject({ name: 'Onboarding fixture brand', created_via: 'agent' });
  const connections = await ws.rest('GET', '/agent-connections');
  expect(connections).toContainEqual(expect.objectContaining({ id, label: agentName, last_used_at: expect.any(String) }));
}

async function pairWithoutHeartbeat(ws, dev, name, pairingCode) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const id = await pairOverHttp(dev.origin, ws.id, pairingCode, 'darwin', name, privateKey,
    { userInitiated: true, ownsDevice: true }, ws.localFetch);
  const client = new SignedDeviceClient(ws.id, id, privateKey, createSignedHttpTransport(dev.origin, ws.localFetch));
  return { id, client };
}

async function pairWorker(ws, dev, name, pairingCode) {
  const worker = await pairWithoutHeartbeat(ws, dev, name, pairingCode);
  await worker.client.heartbeat('worker-onboarding-e2e');
  return worker;
}

const setupSteps = { agent: 'Main agent', worker: 'Desktop worker' };
const setupUrl = (ws, step) => `${ws.app}/get-started${step ? `?step=${step}` : ''}`;
const setupNav = page => page.getByRole('navigation', { name: 'Setup steps' });

async function expectStep(page, ws, step, { implicit = false } = {}) {
  const number = Object.keys(setupSteps).indexOf(step) + 1;
  const destination = new URL(setupUrl(ws));
  await expect(page).toHaveURL(url => url.origin === destination.origin && url.pathname === destination.pathname &&
    (url.searchParams.get('step') === step || (implicit && !url.searchParams.has('step'))));
  const main = page.getByRole('main');
  const panel = main.getByRole('region', { name: setupSteps[step], exact: true });
  await expect(panel.getByRole('heading', { name: setupSteps[step], level: 2, exact: true })).toBeVisible();
  for (const [key, label] of Object.entries(setupSteps)) {
    if (key !== step) await expect(main.getByRole('heading', { name: label, level: 2, exact: true })).toHaveCount(0);
  }
  const steps = setupNav(page).getByRole('button');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(number - 1)).toHaveAttribute('aria-current', 'step');
  await expect(panel.getByText(`Step ${number} of 2`, { exact: true })).toBeVisible();
}

async function nextStep(page, ws, step) {
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expectStep(page, ws, step);
}

async function openSetupStep(page, ws, step) {
  await page.goto(setupUrl(ws, step));
  await expectStep(page, ws, step);
}

async function pairFromWizard(page, ws, dev, name, pair = pairWorker) {
  const main = page.getByRole('main');
  const panel = main.getByRole('region', { name: 'Download and connect' });
  if (!await panel.isVisible()) await main.getByText('Download desktop worker', { exact: true }).click();
  const generate = panel.getByRole('button', { name: 'Generate connection URL' });
  if (!await generate.isVisible()) await panel.getByText('Use a one-time connection URL', { exact: true }).click();
  await panel.getByRole('checkbox', { name: 'I own this device or am authorized to manage it.' }).check();
  const pairedCode = responseFor(page, 'POST', `${ws.root}/devices/pairing-codes`);
  await generate.click();
  const { pairing_code } = await dataFrom(await pairedCode, 'Generate pairing code in onboarding');
  expect(pairing_code).toMatch(/^[\w-]{32}$/);
  await expect(panel.getByRole('textbox', { name: 'Connection URL' })).toHaveValue(`${setupUrl(ws, 'worker')}#worker-pair=${pairing_code}`);
  const worker = await pair(ws, dev, name, pairing_code);
  await main.getByRole('button', { name: 'Check status again' }).click();
  const machines = main.getByRole('combobox', { name: 'Select machine' });
  if ((await ws.rest('GET', '/devices')).length > 1) await machines.selectOption(worker.id);
  await expect(main.getByText(name, { exact: true }).filter({ visible: true }).last()).toBeVisible();
  return worker;
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

test('an empty workspace enters onboarding from registration, the signed-in root and ordinary login', async ({ page, dev }) => {
  const ws = await register(page, dev);
  await expectStep(page, ws, 'agent', { implicit: true });
  await page.goto(dev.origin);
  await expectStep(page, ws, 'agent', { implicit: true });
  const agent = page.getByRole('region', { name: 'Main agent', exact: true });
  const statusPaths = new Set(['/agent-connections', '/devices']);
  for (let cycle = 1; cycle <= 3; cycle++) {
    await test.step(`Sign out and sign in again (${cycle}/3)`, async () => {
      const statuses = [];
      const recordStatus = response => {
        const url = new URL(response.url());
        if (url.origin !== dev.origin) return;
        const path = url.pathname.startsWith(`${ws.root}/`) ? url.pathname.slice(ws.root.length) : url.pathname;
        if (path === '/api/v1/session' || statusPaths.has(path)) {
          statuses.push(`${response.request().method()} ${path} ${response.status()}`);
        }
      };
      page.on('response', recordStatus);
      try {
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await expect(page).toHaveURL(`${dev.origin}/login`);
        await signIn(page, ws.password);
        await expectStep(page, ws, 'agent', { implicit: true });
        for (const label of Object.values(setupSteps)) {
          await expect(setupNav(page).getByRole('listitem').filter({ hasText: label })).toContainText('To set up');
        }
        await expect(page.getByText('Status unavailable', { exact: true })).toHaveCount(0);
        await expect(agent.getByRole('button', { name: 'Generate setup prompt', exact: true })).toBeEnabled();
        await expect(agent.getByRole('button', { name: 'Skip this step for now', exact: true })).toBeEnabled();
        await expect(agent.getByRole('button', { name: 'Next step', exact: true })).toHaveCount(0);
      } finally {
        page.off('response', recordStatus);
        console.log(`Re-login ${cycle}/3: ${statuses.join(', ')}`);
      }
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await agent.getByRole('button', { name: 'Skip this step for now', exact: true }).click();
  await expectStep(page, ws, 'worker');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('skipping setup does not complete it, and explicit deep links still resolve', async ({ page, dev, browser }) => {
  const ws = await register(page, dev);
  await expectStep(page, ws, 'agent', { implicit: true });
  await page.getByRole('button', { name: 'Skip this step for now', exact: true }).click();
  await expectStep(page, ws, 'worker');
  const agentProgress = setupNav(page).getByRole('listitem').filter({ hasText: 'Main agent' });
  await expect(agentProgress).toContainText('Skipped for now');
  await page.reload();
  await expectStep(page, ws, 'worker');
  await expect(agentProgress).toContainText('Skipped for now');
  const { user } = await dataFrom(await page.request.get(`${dev.origin}/api/v1/session`), 'Read session for legacy resume');
  await page.evaluate(({ userId, wsId }) => {
    localStorage.setItem(`smartsell.get-started.navigation:${JSON.stringify([userId, wsId])}`,
      JSON.stringify({ location: 'import', skipped: ['agent', 'store'] }));
  }, { userId: user.id, wsId: ws.id });
  await page.goto(setupUrl(ws));
  await expectStep(page, ws, 'worker', { implicit: true });
  await expect(agentProgress).toContainText('Skipped for now');
  await page.getByRole('button', { name: 'Previous step', exact: true }).click();
  await expectStep(page, ws, 'agent');
  await expect(agentProgress).not.toContainText('MCP connection verified');
  expect(await ws.rest('GET', '/agent-connections')).toEqual([]);
  await page.getByRole('button', { name: 'Skip this step for now', exact: true }).click();
  await expectStep(page, ws, 'worker');
  await expect(page.getByText('No machines have been paired.')).toBeVisible();
  await page.getByRole('button', { name: 'Review setup', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Setup summary', exact: true });
  await expect(summary.getByRole('heading', { name: 'Remaining steps' })).toBeVisible();
  await expect(summary.getByRole('listitem').filter({ hasText: 'Main agent' })).toContainText('Skipped for now');
  await expect(summary.getByText('Both steps are complete.')).toHaveCount(0);
  await summary.getByRole('link', { name: 'Finish later and go to overview' }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(`${dev.origin}/login`);
  await signIn(page, ws.password);
  await expect(page).toHaveURL(ws.app);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();

  // A fresh session opening an old workbench link must return to that resource after login.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === dev.origin
      ? route.continue() : route.abort('blockedbyclient'));
    await context.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
    const linkedPage = await context.newPage();
    const productsLink = `${ws.app}/products?q=fixture`;
    await linkedPage.goto(productsLink);
    await signIn(linkedPage, ws.password);
    await expect(linkedPage).toHaveURL(productsLink);
    await expect(linkedPage.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
    for (const oldStep of ['social', 'store', 'import']) {
      await linkedPage.goto(setupUrl(ws, oldStep));
      await expectStep(linkedPage, ws, 'worker');
    }
    await expect(setupNav(linkedPage).getByRole('button', { name: /Main agent/ })).not.toContainText('MCP connection verified');
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

test('download serves the available package and creates a pairing URL only on explicit request', async ({ page, dev }) => {
  const ws = await register(page, dev);
  const mac = '/api/v1/worker-downloads/mac-arm64';
  const list = '/api/v1/worker-downloads';
  expect((await fetch(`${dev.origin}${mac}`)).status).toBe(401);
  expect(await dataFrom(await page.request.get(`${dev.origin}${list}`), 'List unavailable installers')).toEqual([]);
  expect((await page.request.get(`${dev.origin}${mac}`)).status()).toBe(404);
  const bytes = Buffer.from(await workbookFixture('<row r="1"><c r="A1"><v>123</v></c></row>'), 'base64');
  await dev.writeMacWorkerPackage(bytes);
  const issued = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/devices/pairing-codes')) issued.push(request);
  });
  await openSetupStep(page, ws, 'worker');
  const checklist = page.getByRole('list', { name: 'Worker setup checklist' });
  await expect(page.getByText('No machines have been paired.')).toBeVisible();
  await expect(checklist).toContainText('Not authorized');
  const checks = checklist.getByRole('listitem');
  await expect(checks.locator('strong')).toHaveText([
    'Secure storage', 'Workspace authorization', 'Signed heartbeat', 'Connect dedicated Chrome', 'Verify required accounts',
  ]);
  const signed = checks.filter({ has: page.getByText('Signed heartbeat', { exact: true }) });
  await expect(signed).toContainText('Waiting for workspace authorization');
  for (const item of ['Secure storage', 'Connect dedicated Chrome', 'Verify required accounts']) {
    await expect(checks.filter({ has: page.getByText(item, { exact: true }) })).toContainText('Complete in Worker');
  }
  await expect(checks.nth(3)).toContainText('then sign in to the required platforms');
  await page.getByText('Download desktop worker', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Download and connect' });
  await expect(panel).toContainText('reach this service over HTTPS');
  await expect(panel).toContainText('then authorize once in your browser');
  await expect(panel.getByRole('textbox', { name: 'Workbench URL' })).toHaveValue(ws.app);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Generate connection URL' })).toHaveCount(0);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: dev.origin });
  await panel.getByRole('button', { name: 'Copy workbench URL' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(ws.app);
  const link = panel.getByRole('link', { name: 'Download macOS (Apple silicon)', exact: true });
  await expect(link).toHaveAttribute('href', mac);
  await expect(panel.getByRole('link', { name: /Windows/ })).toHaveCount(0);
  expect((await page.request.get(`${dev.origin}${list}/win-x64`)).status()).toBe(404);
  const download = page.waitForEvent('download');
  await link.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('SmartSell-Worker-mac-arm64.zip');
  expect(await readFile(await file.path())).toEqual(bytes);
  expect(issued).toHaveLength(0);
  const worker = await pairFromWizard(page, ws, dev, 'Downloaded Worker', pairWithoutHeartbeat);
  expect(issued).toHaveLength(1);
  const [beforeHeartbeat] = await ws.rest('GET', '/devices');
  expect(beforeHeartbeat).toMatchObject({ id: worker.id, status: 'active', online: false, last_seen_at: null });
  expect(beforeHeartbeat.client_version).toBeUndefined();
  await expect(checklist).toContainText('Authorized and paired');
  await expect(signed).toContainText('Paired, waiting for first heartbeat');
  await expect(checklist).not.toContainText('Last seen');
  const workerStep = setupNav(page).getByRole('button', { name: /Desktop worker/ });
  await expect(workerStep).toContainText('Awaiting verification');

  const brand = await ws.rest('POST', '/brands', { name: 'First heartbeat brand', slug: 'first-heartbeat-brand' });
  const store = await ws.rest('POST', '/stores', { brand_id: brand.id, provider: 'shopify', mode: 'import', name: 'Assigned before heartbeat',
    external_store_id: 'first-heartbeat-shop', default_currency: 'USD', default_locale: 'en-US' });
  expect(await ws.rest('PUT', `/stores/${store.id}/worker`, { device_id: worker.id, external_store_id: 'first-heartbeat-shop' }))
    .toMatchObject({ device_id: worker.id });

  await worker.client.heartbeat('worker-onboarding-e2e');
  expect(await ws.rest('GET', '/devices')).toMatchObject([{ id: worker.id, online: true, client_version: 'worker-onboarding-e2e', last_seen_at: expect.any(String) }]);
  const refresh = page.getByRole('button', { name: 'Check status again' });
  await refresh.click();
  await expect(checklist).toContainText('Verified online');
  await expect(workerStep).toContainText('Complete');
  const observed_at = new Date().toISOString();
  const registered = await worker.client.registerChannels([
    { kind: 'social', platform: 'douyin', external_id: 'download-account', display_name: 'Signed social', observed_at },
    { kind: 'store', platform: 'shopify', external_id: 'download-shop', display_name: 'Signed store', observed_at },
  ]);
  expect(registered.map(item => item.device_id)).toEqual([worker.id, worker.id]);
  await page.getByRole('button', { name: 'Check status again' }).click();
  await expect(page.getByRole('list', { name: 'Social accounts' })).toContainText('Signed social');
  await expect(page.getByRole('list', { name: 'Stores' })).toContainText('Signed store');
  await dev.setTime(Date.now() + 95_000);
  await page.reload();
  await expect(checklist).toContainText('Previously verified, now offline');
  await expect(workerStep).toContainText('Complete');
  await expect(page.getByRole('textbox', { name: 'Connection URL' })).toHaveCount(0);
  expect(issued).toHaveLength(1);
  expect(await ws.rest('GET', '/devices')).toMatchObject([{ id: worker.id, online: false }]);

  const devicesUrl = `${dev.origin}${ws.root}/devices`;
  await page.route(devicesUrl, route => route.abort());
  await refresh.click();
  await expect(checklist).toContainText('Could not read worker status');
  await expect(checklist).not.toContainText('Previously verified, now offline');
  await page.unroute(devicesUrl);
  await ws.rest('POST', `/devices/${worker.id}/revoke`, {});
  await refresh.click();
  await expect(checklist).toContainText('Revoked');
  await expect(workerStep).not.toContainText('Complete');
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
    await pairWorker(ws, dev, 'Authorized Worker', pairing_code);
    await expect(pairWorker(ws, dev, 'Second machine', pairing_code)).rejects.toThrow();

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

test('a workspace admin enables channel registration only for the selected existing worker', async ({ page, dev }) => {
  const ws = await register(page, dev);
  const pairWithoutPermission = async name => {
    const { pairing_code } = await ws.rest('POST', '/devices/pairing-codes', { owned_device_confirmed: true });
    return pairWorker(ws, dev, name, pairing_code);
  };
  const first = await pairWithoutPermission('Existing Worker A');
  const second = await pairWithoutPermission('Existing Worker B');
  const readDevices = () => ws.rest('GET', '/devices');
  const operation = `${ws.root}/devices/${first.id}/channel-registration`;
  const attempts = [];
  page.on('request', request => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/channel-registration')) attempts.push(request);
  });

  await openSetupStep(page, ws, 'worker');
  const machines = page.getByRole('combobox', { name: 'Select machine' });
  const allow = page.getByRole('button', { name: 'Allow this worker to register channels', exact: true });
  await machines.selectOption(second.id);
  await expect(allow).toBeVisible();
  await machines.selectOption(first.id);
  await expect(page.getByText('Verified online', { exact: true })).toBeVisible();
  await expect(allow).toBeVisible();
  expect(attempts).toHaveLength(0);
  const missingCsrf = await page.request.put(`${dev.origin}${operation}`, {
    data: { enabled: true }, headers: { Origin: dev.origin, 'Idempotency-Key': randomUUID() },
  });
  expect(missingCsrf.status()).toBe(403);
  await expect(allow).toBeEnabled();

  const changed = responseFor(page, 'PUT', operation);
  await allow.click();
  expect(await dataFrom(await changed, 'Allow selected Worker to register channels'))
    .toMatchObject({ device_id: first.id, allow_channel_registration: true });
  await expect(allow).toHaveCount(0);
  expect(attempts).toHaveLength(1);
  expect(attempts[0].postDataJSON()).toEqual({ enabled: true });
  expect(attempts[0].headers()['x-csrf-token']).toBeTruthy();
  expect(await readDevices()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.id, allow_channel_registration: true }),
    expect.objectContaining({ id: second.id, allow_channel_registration: false }),
  ]));

  const selection = { kind: 'social', platform: 'douyin', external_id: 'existing-worker-test',
    display_name: 'Existing Worker social', observed_at: new Date().toISOString() };
  await expect(second.client.registerChannels([selection])).rejects.toMatchObject({ status: 403 });
  expect(await first.client.registerChannels([selection])).toMatchObject([{ device_id: first.id }]);
  await page.getByRole('button', { name: 'Check status again' }).click();
  await expect(page.getByRole('list', { name: 'Social accounts' })).toContainText(selection.display_name);
  await dev.setTime(Date.now() + 95_000);
  await page.reload();
  await machines.selectOption(second.id);
  await expect(page.getByText('Previously verified, now offline', { exact: true })).toBeVisible();
  await expect(allow).toBeEnabled();
  await expect(page.getByText(selection.display_name, { exact: true })).toHaveCount(0);
  await machines.selectOption(first.id);
  await expect(allow).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Social accounts' })).toContainText(selection.display_name);
  expect(attempts).toHaveLength(1);
});

test('paired workers complete setup and support signed CSV and XLSX imports from management', async ({ page, dev }) => {
  const ws = await register(page, dev);
  const main = page.getByRole('main');
  await expectStep(page, ws, 'agent', { implicit: true });
  await expect(main.getByRole('heading', { name: 'Get started', exact: true })).toBeVisible();
  await submitAsAgent(page, ws, dev);
  await main.getByRole('button', { name: 'Check status again' }).click();
  await expect(setupNav(page).getByRole('button', { name: /Main agent/ })).toContainText('MCP connection verified');
  await expect(main.getByText(agentName, { exact: true })).toBeVisible();
  const [brand] = await ws.rest('GET', '/brands');
  expect(brand).toMatchObject({ name: 'Onboarding fixture brand' });

  await nextStep(page, ws, 'worker');
  const primary = await pairFromWizard(page, ws, dev, 'Catalog Worker A');
  const other = await pairFromWizard(page, ws, dev, 'Catalog Worker B');
  expect(primary.id).not.toBe(other.id);
  await expect(setupNav(page).getByRole('button', { name: /Desktop worker/ })).toContainText('Complete');
  await page.reload();
  await expectStep(page, ws, 'worker');
  await main.getByRole('link', { name: 'Finish later and go to overview' }).click();
  await expect(page).toHaveURL(ws.app);
  await page.getByRole('navigation', { name: 'Dashboard navigation' }).getByRole('link', { name: 'Get started', exact: true }).click();
  // The saved cursor is Worker even though Social is now the first incomplete step.
  await expectStep(page, ws, 'worker', { implicit: true });
  await expect(setupNav(page).getByRole('button', { name: /Main agent/ })).toContainText('MCP connection verified');
  await expect(main.getByText('Catalog Worker A', { exact: true }).last()).toBeVisible();
  await main.getByRole('combobox', { name: 'Select machine' }).selectOption(other.id);
  await expect(main.getByText('Catalog Worker B', { exact: true }).last()).toBeVisible();
  expect(await ws.rest('GET', '/stores')).toEqual([]);
  expect(await ws.rest('GET', '/products')).toEqual([]);
  await main.getByRole('button', { name: 'Review setup' }).click();
  await expect(main.getByText('Both steps are complete.')).toBeVisible();
  await page.goto(`${ws.app}/settings`);
  await page.getByRole('link', { name: 'Social accounts and dedicated workers' }).click();
  await registerAndVerifySocial(page, ws, primary, other);

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
    expect(await other.client.claimCatalog()).toBeNull();
    expect(await catalogJob()).toEqual(queued);

    const claim = await primary.client.claimCatalog();
    expect(claim).toMatchObject({ ...expectedJob, claim_id: expect.any(String), expires_at: expect.any(String) });
    const claimed = await catalogJob();
    expect(claimed).toMatchObject({ ...expectedJob, status: 'claimed', expires_at: claim.expires_at });
    await expect(other.client.uploadCatalog(claim, externalStoreId, upload)).rejects.toMatchObject({ status: 403 });
    await expect(primary.client.uploadCatalog(claim, 'different-fixture-shop', upload)).rejects.toMatchObject({ status: 409 });
    expect(await catalogJob()).toEqual(claimed);
    expect(claimed.import_id ?? null).toBeNull();
    expect(await ws.rest('GET', '/imports')).toHaveLength(index);

    const result = await primary.client.uploadCatalog(claim, externalStoreId, upload);
    expect(result).toEqual({ import_id: expect.any(String), status: 'previewed' });
    expect(await catalogJob()).toMatchObject({ ...expectedJob, import_id: result.import_id, status: 'previewed' });
    expect(await primary.client.claimCatalog()).toBeNull();
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

  await page.setViewportSize({ width: 390, height: 844 });
  await openSetupStep(page, ws, 'worker');
  const machine = main.getByRole('combobox', { name: 'Select machine' });
  await machine.selectOption(primary.id);
  await expect(main.getByRole('list', { name: 'Social accounts' })).toContainText('Fixture social account');
  await expect(main.getByRole('list', { name: 'Stores' })).toContainText(storeName);
  await machine.selectOption(other.id);
  await expect(main.getByText('Fixture social account')).toHaveCount(0);
  await expect(main.getByText(storeName, { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), {
    message: 'the worker step fits the mobile viewport',
  }).toBeLessThanOrEqual(0);
  await main.getByRole('button', { name: 'Review setup', exact: true }).click();
  await expect(page).toHaveURL(setupUrl(ws, 'summary'));
  await expect(main.getByRole('heading', { name: 'Setup summary', exact: true })).toBeVisible();
  await expect(main.getByText('Both steps are complete.', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), {
    message: 'the completion screen fits the mobile viewport',
  }).toBeLessThanOrEqual(0);
  await main.getByRole('link', { name: 'Go to overview', exact: true }).click();
  await expect(page).toHaveURL(ws.app);
  await expect(main.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
});

async function storeRecoveryFixture(page, dev) {
  const ws = await register(page, dev);
  await expectStep(page, ws, 'agent', { implicit: true });
  await submitAsAgent(page, ws, dev);
  await openSetupStep(page, ws, 'worker');
  const worker = await pairFromWizard(page, ws, dev, 'Recovery Worker');
  const [brand] = await ws.rest('GET', '/brands');
  const store = await ws.rest('POST', '/stores', { brand_id: brand.id, provider: 'shopify', mode: 'import', name: 'Existing recovery fixture',
    external_store_id: 'recovery-existing', default_currency: 'USD', default_locale: 'en-US' });
  await page.goto(`${ws.app}/products/stores`);
  return { ws, brand, store, worker };
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

test('desktop Zhihu jobs route to their signed Workers and leave a Web login incident', async ({ page, dev }) => {
  const ws = await register(page, dev);
  await expectStep(page, ws, 'agent', { implicit: true });
  const { rpc } = await connectAgent(page, ws, dev);
  const names = (await rpc('tools/list', {})).tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(['zhihu_stats_create', 'zhihu_stats_get', 'desktop_request_capability', 'desktop_get_capability_request']));
  expect(names).not.toContain('zhihu_stats_incidents_list');
  const call = async (name, args) => {
    const result = await rpc('tools/call', { name, arguments: args });
    expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeFalsy();
    return result.structuredContent.data;
  };
  await openSetupStep(page, ws, 'worker');
  const a = await pairFromWizard(page, ws, dev, 'Zhihu fixture Worker A');
  const b = await pairFromWizard(page, ws, dev, 'Zhihu fixture Worker B');
  const enqueue = body => call('zhihu_stats_create', { body, idempotency_key: randomUUID() });
  const read = id => call('zhihu_stats_get', { params: { id } });
  const login = await enqueue({ device_id: a.id, mode: 'login_check' });
  expect(login).toMatchObject({ status: 'queued', device_id: a.id, mode: 'login_check' });
  expect(await b.client.claimZhihuStats()).toBeNull();
  const stats = await enqueue({ device_id: b.id, profile_slug: 'fixture-self' });
  const claimA = await a.client.claimZhihuStats();
  const claimB = await b.client.claimZhihuStats();
  expect(claimA).toMatchObject({ id: login.id, device_id: a.id });
  expect(claimB).toMatchObject({ id: stats.id, device_id: b.id });
  const blocked = { status: 'blocked', reason: 'login_required' };
  const observed = { status: 'completed', profile_slug: 'fixture-self', followers_text: '0', upvotes_text: '获得 12 次赞同' };
  await a.client.reportZhihuStats({ id: claimA.id, fencing_token: claimA.fencing_token, result: blocked });
  await b.client.reportZhihuStats({ id: claimB.id, fencing_token: claimB.fencing_token, result: observed });
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
  expect(await a.client.claimZhihuStats()).toBeNull();
  expect(await b.client.claimZhihuStats()).toBeNull();
  expect(await ws.rest('GET', '/worker-catalog')).toEqual({ bindings: [], jobs: [] });

  await page.goto(`${ws.app}/agent`);
  const incidents = page.getByRole('list', { name: 'Zhihu sign-in incidents' });
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
  // This workspace has never dismissed the wizard. It is the real business inventory that prevents the redirect.
  await page.goto(dev.origin);
  await expect(page).toHaveURL(ws.app);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, ws.password);
  await expect(page).toHaveURL(ws.app);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  const target = `${ws.app}/products/${product.id}`;
  await page.goto(target);
  await expect(page).toHaveURL(target);
  await expect(page.getByRole('heading', { name: product.title, exact: true })).toBeVisible();
});

async function registerAndVerifySocial(page, ws, primary, other) {
  await page.getByRole('combobox', { name: 'Platform', exact: true }).selectOption('douyin');
  await page.getByLabel('Display name').fill('Fixture social account');
  await page.getByLabel('Platform account ID').fill('fixture-social-identity');
  await page.getByRole('checkbox', { name: /I confirm this account is owned by/ }).check();
  const registered = responseFor(page, 'POST', `${ws.root}/social-accounts`);
  await page.getByRole('button', { name: 'Register account', exact: true }).click();
  const account = await dataFrom(await registered, 'Register fixture social account');
  const accountRow = page.getByRole('listitem').filter({ hasText: 'Fixture social account' });
  await accountRow.getByLabel('Dedicated worker').selectOption(primary.id);
  await accountRow.getByRole('checkbox', { name: 'I confirm I am authorized to use this account on this machine.' }).check();
  const bound = responseFor(page, 'PUT', `${ws.root}/social-accounts/${account.id}/execution-binding`);
  await accountRow.getByRole('button', { name: 'Save worker assignment' }).click();
  const result = await dataFrom(await bound, 'Bind social account to the selected Worker');
  expect(result.binding).toMatchObject({ device_id: primary.id, social_account_id: account.id, connector_channel: 'browser' });
  const sessions = () => ws.rest('GET', '/browser-sessions');
  const [boundSession] = await sessions();
  expect(boundSession).toMatchObject({ social_account_id: account.id, device_id: primary.id, status: 'pending_identity' });
  await expect(accountRow).toContainText('Identity verification pending');
  const loginRequested = responseFor(page, 'POST', `${ws.root}/browser-sessions/${boundSession.id}/request-login`);
  await accountRow.getByRole('button', { name: 'Request browser sign-in on worker' }).click();
  expect(await dataFrom(await loginRequested, 'Request browser identity verification')).toEqual({ status: 'pending_identity' });
  const [pending] = await sessions();
  expect(pending).toMatchObject({ id: boundSession.id, status: 'pending_identity' });
  await expect(other.client.reportIdentity('browser', pending.id, account.external_account_id)).rejects.toMatchObject({ status: 403 });
  expect(await sessions()).toEqual([pending]);
  expect(await primary.client.reportIdentity('browser', pending.id, account.external_account_id)).toBe('verified');
  expect(await sessions()).toEqual([expect.objectContaining({ id: pending.id, device_id: primary.id,
    status: 'verified', verified_at: expect.any(String) })]);
  await page.getByRole('button', { name: 'Check status again' }).click();
  await expect(accountRow).toContainText('Identity verified');
}
