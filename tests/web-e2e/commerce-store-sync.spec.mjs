import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localCommerceStore } from './local-dev.mjs';

const test = base.extend({ dev: localCommerceStore });

async function provision(page, dev) {
  const { email, password, workspaceId, appId, externalStoreId, providerOrigin, controlToken } = dev.browserFixture;
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.context().route('**/*', route => new URL(route.request().url()).origin === dev.origin ? route.continue() : route.abort());
  const login = await page.request.post(`${dev.origin}/api/v1/session`, { headers: { Origin: dev.origin }, data: { email, password } });
  expect(login.ok(), await login.text()).toBe(true);
  const { csrf_token } = await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json();
  const api = `${dev.origin}/api/v1/workspaces/${workspaceId}`;
  async function call(method, path, data) {
    const reply = await page.request.fetch(api + path, { method, data, headers: {
      Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
    } });
    expect(reply.ok(), `${method} ${path}: ${await reply.text()}`).toBe(true);
    return (await reply.json()).data;
  }
  async function provider(path, method = 'GET') {
    expect(new URL(providerOrigin).hostname).toBe('127.0.0.1');
    const reply = await fetch(`${providerOrigin}/__pc01/${path}`, { method, headers: { Authorization: `Bearer ${controlToken}` }, redirect: 'error' });
    expect(reply.ok, `Loopback provider control ${path}: HTTP ${reply.status}`).toBe(true);
    return reply.json();
  }
  const brand = await call('POST', '/brands', { name: 'PC01 Brand', slug: 'pc01-brand' });
  const store = await call('POST', '/stores', { brand_id: brand.id, provider: 'shopify', name: 'PC01 Store',
    external_store_id: externalStoreId, default_currency: 'USD', default_locale: 'en-US' });
  const connection = await call('POST', '/connections/shopify/merchant', { brand_id: brand.id, platform_app_id: appId });
  expect(connection).toMatchObject({ status: 'active', scopes: ['read_products'] });
  return { call, provider, brand, store, connection, ui: `${dev.origin}/w/${workspaceId}` };
}

async function connectAndStart(page, fixture) {
  const { call, provider, store, connection, ui } = fixture;
  await page.goto(`${ui}/commerce/stores/${store.id}`);
  await expect(page.getByRole('heading', { name: 'Store sync center' })).toBeVisible();
  await page.getByLabel('Authorized store connection').selectOption(connection.id);
  await page.getByRole('button', { name: 'Connect existing store' }).click();
  await page.getByRole('button', { name: 'Set up read-only catalog source' }).click();
  await page.getByRole('button', { name: 'Sync catalog', exact: true }).click();
  await expect.poll(() => provider('calls'), { timeout: 15_000 }).toEqual([null]);
  const detail = await call('GET', `/stores/${store.id}`);
  expect(detail).toMatchObject({ id: store.id, connection_id: connection.id, initial_snapshot_pending: true, last_snapshot_at: null });
  const [{ id: runId, status, attempt }] = await call('GET', `/sync-runs?data_source_id=${detail.data_source.id}`);
  expect({ status, attempt }).toEqual({ status: 'running', attempt: 1 });
  await page.getByRole('link', { name: 'View store products' }).click();
  await expect(page).toHaveURL(`${ui}/commerce/products?store=${store.id}`);
  return runId;
}

test('PC01 Products shows pending and failed snapshots before and after the first successful sync', async ({ page, dev }) => {
  const fixture = await provision(page, dev);
  const { call, provider, store, ui } = fixture;
  await page.goto(`${ui}/commerce/products`);
  await expect(page.getByText('No records yet', { exact: true })).toBeVisible();
  const runId = await connectAndStart(page, fixture);
  expect(await call('GET', `/products?store_id=${store.id}`)).toEqual([]);
  const sync = page.getByRole('region', { name: 'Catalog sync status' });
  await expect(sync.getByText('Syncing catalog', { exact: true })).toBeVisible();
  await expect(page.getByText('No records yet', { exact: true })).toHaveCount(0);
  await page.goto(`${ui}/commerce/products`);
  await expect(sync.getByText('Syncing catalog', { exact: true })).toBeVisible();
  await expect(page.getByText('No records yet', { exact: true })).toHaveCount(0);

  await provider('fail', 'POST');
  await expect(sync.getByRole('alert')).toContainText('The platform catalog request failed');
  await expect(sync.getByRole('alert')).toContainText('provider_request_failed');
  expect(await call('GET', `/sync-runs/${runId}`)).toMatchObject({ id: runId, status: 'failed', attempt: 1, error_reason: 'provider_request_failed' });

  await sync.getByRole('button', { name: 'Retry sync' }).click();
  await expect.poll(() => provider('calls'), { timeout: 15_000 }).toEqual([null, null]);
  await expect(sync.getByText('Syncing catalog', { exact: true })).toBeVisible();
  await expect(sync.getByRole('alert')).toHaveCount(0);
  expect(await call('GET', `/sync-runs/${runId}`)).toMatchObject({ id: runId, status: 'running', attempt: 2 });
  await provider('succeed', 'POST');
  await expect(page.getByRole('button', { name: 'Synced PC01 cup', exact: true })).toBeVisible({ timeout: 15_000 });
  expect(await call('GET', `/sync-runs/${runId}`)).toMatchObject({ id: runId, status: 'succeeded', attempt: 2 });
  const initial = await call('GET', `/stores/${store.id}`);
  expect(initial).toMatchObject({ id: store.id, status: 'active', last_snapshot_at: expect.any(String) });
  await expect(sync).toHaveCount(0);

  // Keep the unfiltered page open and let workspace events refresh its status.
  await call('POST', `/stores/${store.id}/sync`, { mode: 'full', resource: 'products' });
  await expect.poll(() => provider('calls'), { timeout: 15_000 }).toEqual([null, null, null]);
  await expect(sync.getByText('Syncing catalog', { exact: true })).toBeVisible();
  await provider('fail', 'POST');
  await expect(sync.getByRole('alert')).toContainText('provider_request_failed');
  await expect(sync.getByRole('link', { name: 'Open store sync settings' })).toHaveAttribute('href', `${new URL(ui).pathname}/commerce/stores/${store.id}`);
  await expect(page.getByRole('button', { name: 'Synced PC01 cup', exact: true })).toBeVisible();
  await expect(page.getByText('No records yet', { exact: true })).toHaveCount(0);
  expect((await call('GET', `/stores/${store.id}`)).last_snapshot_at).toBe(initial.last_snapshot_at);

  await sync.getByRole('button', { name: 'Retry sync' }).click();
  await expect.poll(() => provider('calls'), { timeout: 15_000 }).toEqual([null, null, null, null]);
  await expect(sync.getByText('Syncing catalog', { exact: true })).toBeVisible();
  await provider('succeed', 'POST');
  await expect(sync).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Synced PC01 cup', exact: true })).toBeVisible();
});

test('PC01 upgrades an imported store in place and keeps a committed content reference resolvable', async ({ page, dev }) => {
  const fixture = await provision(page, dev);
  const { call, provider, brand, store, ui } = fixture;
  const batch = await call('POST', `/stores/${store.id}/imports`, {
    csv: 'external_product_id,external_variant_id,handle,title,sku\ngid://shopify/Product/101,gid://shopify/ProductVariant/102,pc01-cup,Imported PC01 cup,PC01-CUP',
  });
  await call('POST', `/imports/${batch.id}/confirm`, {});
  const [product] = await call('GET', `/products?store_id=${store.id}`);
  const { variants: [sku] } = await call('GET', `/products/${product.id}`);
  const market = await call('POST', `/brands/${brand.id}/markets`, {
    name: 'US', locale: 'en-US', currency: 'USD', timezone: 'America/New_York', country_code: 'US', primary_language: 'en',
  });
  const marketKey = { market_id: market.id, channel: 'online_store' };
  await call('PUT', `/stores/${store.id}/markets`, { ...marketKey, price_source: 'store_base_price' });
  const listing = await call('POST', `/variants/${sku.id}/listings`, { ...marketKey, price_amount_minor: 1000, currency: 'USD' });
  const body = 'The PC01 cup costs $10.00.';
  const { variants: [variant] } = await call('POST', '/content-items', {
    brand_id: brand.id, title: 'PC01 committed catalog content', variants: [{ platform: 'facebook', format: 'text', locale: 'en', body,
      product_refs: [{ variant_id: sku.id, listing_snapshot_id: listing.id, market_id: market.id, currency: 'USD', field: 'price', inserted_text: '$10.00' }],
    }],
  });
  const { revision } = await call('POST', `/content-variants/${variant.id}/revisions`, { expected_version: variant.version, base_revision_id: null });
  const original = await call('GET', `/content-revisions/${revision.id}`);
  expect(original).toMatchObject({ id: revision.id, body, product_refs: [expect.objectContaining({ variant_id: sku.id, listing_snapshot_id: listing.id })] });
  const originalReferences = (await call('GET', `/products/${product.id}/usage`)).references;
  expect(originalReferences).toEqual(expect.arrayContaining([expect.objectContaining({ revision_id: revision.id, ref_type: 'product_variant', ref_id: sku.id })]));
  const revisionLabel = `Content revision ${revision.id}`;
  await page.goto(`${ui}/commerce/products/${product.id}`);
  await expect(page.getByRole('heading', { name: 'Content references' })).toBeVisible();
  await expect(page.getByText(revisionLabel, { exact: true })).toBeVisible();

  expect(await call('GET', `/stores/${store.id}`)).toMatchObject({ status: 'import_only' });
  const runId = await connectAndStart(page, fixture);
  await expect(page.getByText('Syncing catalog', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Imported PC01 cup', exact: true })).toBeVisible();
  await provider('succeed', 'POST');
  const sync = page.getByRole('region', { name: 'Catalog sync status' });
  await expect(sync.getByText('Catalog snapshot complete', { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Synced PC01 cup', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]id=${product.id}(?:&|$)`));
  await expect(page.getByRole('heading', { name: 'Content references' })).toBeVisible();
  await page.getByLabel('View usage by variant').selectOption(sku.id);
  await expect(page.getByText(revisionLabel, { exact: true })).toBeVisible();
  expect(await call('GET', `/sync-runs/${runId}`)).toMatchObject({ id: runId, status: 'succeeded' });
  expect(await call('GET', `/products?store_id=${store.id}`)).toMatchObject([{ id: product.id, title: 'Synced PC01 cup' }]);
  expect((await call('GET', `/products/${product.id}`)).variants).toMatchObject([{ id: sku.id, sku: 'PC01-CUP' }]);
  expect((await call('GET', `/variants/${sku.id}/listings`)).some(row => row.id === listing.id)).toBe(true);
  expect(await call('GET', `/content-revisions/${revision.id}`)).toEqual(original);
  expect((await call('GET', `/products/${product.id}/usage`)).references).toEqual(originalReferences);
  await page.goto(`${ui}/content`);
  await expect(page.getByRole('button', { name: 'PC01 committed catalog content', exact: true })).toBeVisible();
});
