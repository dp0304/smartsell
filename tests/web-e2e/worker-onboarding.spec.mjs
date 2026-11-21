import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { createSignedHttpTransport, pairOverHttp, SignedDeviceClient } from '../../apps/connector/src/device-client.ts';
import { textCell, workbookFixture } from '../../apps/server/src/modules/ingest/xlsx-fixture.ts';
import { localRegistration } from './local-dev.mjs';

const test = base.extend({ dev: localRegistration });
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

async function submitAsAgent(page, ws, dev) {
  await page.getByLabel('Name', { exact: true }).fill(agentName);
  await page.getByRole('combobox', { name: 'Agent client', exact: true }).selectOption('codex');
  const created = responseFor(page, 'POST', `${ws.root}/agent-connections`);
  await page.getByRole('button', { name: 'Create connection token' }).click();
  const { token, mcp_url, id } = await dataFrom(await created, 'Create primary Agent connection', 201);
  expect(mcp_url).toBe(`${dev.origin}/mcp`);
  await expect(page.getByText('Credential issued, awaiting first use', { exact: true }).first()).toBeVisible();
  async function rpc(method, params) {
    const response = await ws.localFetch(mcp_url, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    });
    const body = await response.text();
    expect(response.status, `MCP ${method}`).toBe(200);
    const json = response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n') : body;
    const message = JSON.parse(json);
    expect(message.error, `MCP ${method}`).toBeUndefined();
    return message.result;
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'onboarding-e2e', version: '1' } });
  const result = await rpc('tools/call', { name: 'workspace_brand_create', arguments: {
    idempotency_key: randomUUID(), body: { name: 'Onboarding fixture brand', slug: 'onboarding-fixture-brand' },
  } });
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  expect(result.structuredContent.data).toMatchObject({ name: 'Onboarding fixture brand', created_via: 'agent' });
  const connections = await ws.rest('GET', '/agent-connections');
  expect(connections).toContainEqual(expect.objectContaining({ id, label: agentName, last_used_at: expect.any(String) }));
}

async function pairWorker(ws, dev, name, pairingCode) {
  const pairing_code = pairingCode ?? (await ws.rest('POST', '/devices/pairing-codes', { owned_device_confirmed: true })).pairing_code;
  const { privateKey } = generateKeyPairSync('ed25519');
  const id = await pairOverHttp(dev.origin, ws.id, pairing_code, 'darwin', name, privateKey,
    { userInitiated: true, ownsDevice: true }, ws.localFetch);
  const client = new SignedDeviceClient(ws.id, id, privateKey, createSignedHttpTransport(dev.origin, ws.localFetch));
  await client.heartbeat('worker-onboarding-e2e');
  return { id, client };
}

const stepHeading = (page, name) => page.getByRole('heading', { name: new RegExp(`^\\d+\\. ${name}$`) });

async function openSetupStep(page, ws, name) {
  await page.goto(`${ws.app}/get-started`);
  await page.getByRole('navigation', { name: 'Setup steps' }).getByRole('button', { name: new RegExp(name) }).click();
  await expect(stepHeading(page, name)).toBeVisible();
}

async function previewAndMerge(page, ws, importId, storeId, samples, expectedRowStatus) {
  const path = `/imports/${encodeURIComponent(importId)}`;
  expect(await ws.rest('GET', path)).toMatchObject({ store_id: storeId, template_key: 'product_list',
    status: 'awaiting_confirmation', stats: { rows: samples.length, valid: samples.length, invalid: 0 } });
  const rowsRead = responseFor(page, 'GET', `${ws.root}${path}/rows`);
  const pendingImport = page.getByRole('listitem').filter({ hasText: 'Preview ready for merge confirmation' });
  await pendingImport.getByRole('link', { name: 'Open import batch', exact: true }).click();
  const rows = await dataFrom(await rowsRead, 'Browser preview of the Worker import');
  expect(rows).toHaveLength(samples.length);
  const preview = page.getByRole('row').filter({ has: page.locator('summary', { hasText: /^Details$/ }) });
  await expect(preview).toHaveCount(samples.length);
  for (const [index, { sku, title, priceMinor, quantity }] of samples.entries()) {
    const row = rows[index];
    expect(row).toMatchObject({ status: expectedRowStatus, normalized: { sku, title } });
    if (priceMinor === null) {
      expect(row.normalized).not.toHaveProperty('price_minor');
      expect(row.normalized).not.toHaveProperty('available');
    } else {
      expect(row.normalized).toMatchObject({ price_minor: priceMinor, currency: 'USD', available: quantity });
    }
    const visibleRow = preview.nth(index);
    await visibleRow.locator('summary').click();
    await expect(visibleRow.getByText(sku, { exact: true })).toBeVisible();
    await expect(visibleRow.getByText(title, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
  const reviewed = page.getByRole('checkbox', { name: 'I reviewed the preview. Invalid and duplicate rows will be skipped.' });
  await reviewed.check();
  const merged = responseFor(page, 'POST', `${ws.root}${path}/confirm`);
  await reviewed.locator('xpath=ancestor::form').getByRole('button', { name: 'Confirm import', exact: true }).click();
  expect(await dataFrom(await merged, 'Merge reviewed Worker import')).toMatchObject({
    id: importId, status: 'merged', merged_rows: samples.length, failed_rows: 0,
  });
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

test('normal registration opens four-step onboarding, with a real Agent submission and Worker pairing', async ({ page, dev }) => {
  const ws = await register(page, dev);
  await expect(page).toHaveURL(`${ws.app}/get-started`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Get started', exact: true })).toBeVisible();
  const setupNav = main.getByRole('navigation', { name: 'Setup steps' });
  const steps = setupNav.getByRole('button');
  await expect(steps).toHaveText([/Main agent/, /Desktop worker/, /Social accounts/, /Stores and products/]);
  await expect(stepHeading(page, 'Main agent')).toBeVisible();
  await submitAsAgent(page, ws, dev);
  await main.getByRole('button', { name: 'Check status again' }).click();
  await expect(setupNav.getByRole('button', { name: /Main agent/ })).toContainText('MCP connection verified');
  await expect(main.getByText(agentName, { exact: true })).toBeVisible();
  const next = main.getByRole('button', { name: 'Next step', exact: true });
  await next.click();
  await expect(stepHeading(page, 'Desktop worker')).toBeVisible();
  await main.getByRole('checkbox', { name: 'I own this device or am authorized to manage it.' }).check();
  const pairedCode = responseFor(page, 'POST', `${ws.root}/devices/pairing-codes`);
  await main.getByRole('button', { name: 'Generate pairing code' }).click();
  const { pairing_code } = await dataFrom(await pairedCode, 'Generate pairing code in onboarding');
  expect(pairing_code).toMatch(/^[\w-]{32}$/);
  await pairWorker(ws, dev, 'Guided setup Worker', pairing_code);
  await main.getByRole('button', { name: 'Check status again' }).click();
  await expect(main.getByText('Guided setup Worker', { exact: true })).toBeVisible();
  for (const nextHeading of ['Social accounts', 'Stores and products']) {
    await next.click();
    await expect(stepHeading(page, nextHeading)).toBeVisible();
  }
  await main.getByRole('button', { name: 'Previous step', exact: true }).click();
  await expect(stepHeading(page, 'Social accounts')).toBeVisible();
});

async function signIn(page, password) {
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('skip persists on sign-in with an empty workspace and old workbench links still resolve', async ({ page, dev, browser }) => {
  const ws = await register(page, dev);
  await expect(page).toHaveURL(`${ws.app}/get-started`);
  await page.getByRole('link', { name: 'Finish later and go to overview' }).click();
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
    const legacyPage = await context.newPage();
    const legacyLink = `${ws.legacy}/data/imports?tab=imports`;
    await legacyPage.goto(legacyLink);
    await signIn(legacyPage, ws.password);
    await expect(legacyPage).toHaveURL(legacyLink);
    await expect(legacyPage.getByRole('main').getByText('Import batches', { exact: true }).first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('only the bound Worker can import merchant CSV and XLSX through the preview and into Products', async ({ page, dev }) => {
  const ws = await register(page, dev);
  const brand = await ws.rest('POST', '/brands', { name: 'Fixture brand', slug: 'fixture-brand' });
  const readCatalog = () => ws.rest('GET', '/worker-catalog');
  expect(await readCatalog()).toEqual({ bindings: [], jobs: [] });
  const primary = await pairWorker(ws, dev, 'Catalog Worker A');
  const other = await pairWorker(ws, dev, 'Catalog Worker B');
  expect(primary.id).not.toBe(other.id);

  await openSetupStep(page, ws, 'Stores and products');
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
  await dataFrom(await marketSaved, 'Save market and sales channel from onboarding');
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
    if (index > 0) await openSetupStep(page, ws, 'Stores and products');
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
    await page.getByRole('button', { name: 'Check status again' }).click();
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
});

test('a registered social account is verified over signed ingress only by its bound Worker', async ({ page, dev }) => {
  const ws = await register(page, dev);
  await ws.rest('POST', '/brands', { name: 'Social fixture brand', slug: 'social-fixture-brand' });
  const primary = await pairWorker(ws, dev, 'Social Worker A');
  const other = await pairWorker(ws, dev, 'Social Worker B');
  await openSetupStep(page, ws, 'Social accounts');
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
  const [pending] = await sessions();
  expect(pending).toMatchObject({ social_account_id: account.id, device_id: primary.id, status: 'pending_identity' });
  await expect(accountRow).toContainText('Identity verification pending');
  await expect(other.client.reportIdentity('browser', pending.id, account.external_account_id)).rejects.toMatchObject({ status: 403 });
  expect(await sessions()).toEqual([pending]);
  expect(await primary.client.reportIdentity('browser', pending.id, account.external_account_id)).toBe('verified');
  expect(await sessions()).toEqual([expect.objectContaining({ id: pending.id, device_id: primary.id,
    status: 'verified', verified_at: expect.any(String) })]);
  await page.getByRole('button', { name: 'Check status again' }).click();
  await expect(accountRow).toContainText('Identity verified');
});
