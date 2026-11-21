import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

test('CO04 retrieves the original revision after a catalog price observation', async ({ page, dev }) => {
  const headers = { Origin: dev.origin };
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { ...headers, 'X-Setup-Token': dev.setupToken },
    data: { email: 'publishing-price@smartsell.test', name: 'Catalog reviewer', workspaceName: 'Catalog acceptance', password: dev.password() },
  });
  expect(setup.status()).toBe(201);
  const workspace = (await setup.json()).workspaces[0].id;
  const root = `${dev.origin}/api/v1/workspaces/${workspace}`;
  const command = async (module, action, data) => {
    const result = await page.request.post(`${root}/commands/${module}/${action}`, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() }, data,
    });
    expect(result.ok(), `${module}/${action}: ${await result.text()}`).toBe(true);
    return (await result.json()).data;
  };

  const brand = await command('workspace', 'create_brand', { name: 'Catalog test brand', slug: 'catalog-test' });
  const market = await command('workspace', 'create_market', {
    brand_id: brand.id, name: 'US', country_code: 'US', primary_language: 'en', currency: 'USD', timezone: 'America/New_York',
  });
  const store = await command('commerce', 'create_store', {
    brand_id: brand.id, name: 'Catalog test store', provider: 'shopify', default_currency: 'USD', default_locale: 'en',
  });
  const marketKey = { market_id: market.id, channel: 'online_store' };
  await command('commerce', 'configure_store_market', { store_id: store.id, ...marketKey, price_source: 'store_base_price' });
  const product = await command('commerce', 'create_product', { store_id: store.id, title: 'Cup', status: 'active' });
  const sku = await command('commerce', 'upsert_variant', { product_id: product.id, sku: 'CUP-1' });
  const first = await command('commerce', 'record_listing_snapshot', { variant_id: sku.id, ...marketKey, price_amount_minor: 1000, currency: 'USD' });

  const body = 'Cup costs $10.00';
  const { variants: [variant] } = await command('content', 'content_create_item', {
    brand_id: brand.id, title: 'Catalog price content', variants: [{ platform: 'facebook', format: 'text', locale: 'en', body,
      product_refs: [{ variant_id: sku.id, listing_snapshot_id: first.id, market_id: market.id, currency: 'USD', field: 'price', inserted_text: '$10.00' }],
    }],
  });
  const { revision: { id: revisionId } } = await command('content', 'content_commit_revision', {
    variant_id: variant.id, expected_version: variant.version, base_revision_id: null,
  });
  const original = await command('content', 'content_get_revision', { revision_id: revisionId });
  expect(original.data).toMatchObject({ body, product_refs: [expect.objectContaining({ listing_snapshot_id: first.id })] });

  const current = await command('commerce', 'record_listing_snapshot', { variant_id: sku.id, ...marketKey, price_amount_minor: 1200, currency: 'USD' });
  expect(current).toMatchObject({ data: { price_amount_minor: 1200, is_current: true } });
  expect(current.id).not.toBe(first.id);
  await page.goto(`${dev.origin}/compat/workbench/w/${workspace}/content`);
  await expect(page.getByText('Catalog price content', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Catalog price content', { exact: true })).toBeVisible();
  const retrieved = await command('content', 'content_get_variant', { variant_id: variant.id });
  expect(retrieved.variant.data).toMatchObject({ readiness: 'stale', current_revision_id: revisionId, stale_reasons: [{ kind: 'listing_changed', ref_id: first.id }] });
  expect(await command('content', 'content_get_revision', { revision_id: revisionId })).toEqual(original);
});

test('CO04 running Operations worker applies the price change from the outbox', async ({ page, dev }) => {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'operation-price@smartsell.test', name: 'Catalog reviewer', workspaceName: 'Catalog operations', password: dev.password() },
  });
  expect(setup.status()).toBe(201);
  const workspace = (await setup.json()).workspaces[0].id;
  const root = `${dev.origin}/api/v1/workspaces/${workspace}`;
  const { csrf_token } = await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json();
  expect(csrf_token).toEqual(expect.any(String));
  const operation = async (method, path, data) => {
    const response = await page.request.fetch(`${root}${path}`, {
      method, data, headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID() },
    });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  };
  const brand = await operation('POST', '/brands', { name: 'Operation price brand', slug: 'operation-price' });
  const market = await operation('POST', `/brands/${brand.id}/markets`, {
    name: 'US', country_code: 'US', primary_language: 'en', currency: 'USD', timezone: 'America/New_York',
  });
  const store = await operation('POST', '/stores', {
    brand_id: brand.id, name: 'Operation price store', external_store_id: 'fixture-shop', provider: 'shopify', default_currency: 'USD', default_locale: 'en',
  });
  const marketKey = { market_id: market.id, channel: 'online_store' };
  await operation('PUT', `/stores/${store.id}/markets`, { ...marketKey, price_source: 'manual' });
  const product = await operation('POST', '/products', { store_id: store.id, title: 'Cup', status: 'active' });
  const sku = await operation('POST', `/products/${product.id}/variants`, { sku: 'CUP-1' });
  const observePrice = price_amount_minor => operation('POST', `/variants/${sku.id}/listings`, { ...marketKey, price_amount_minor, currency: 'USD' });
  const before = await observePrice(1000);
  const { variants: [variant] } = await operation('POST', '/content-items/draft', {
    brand_id: brand.id, title: 'Outbox price content', variants: [{ platform: 'facebook', format: 'text', locale: 'en', body: 'Cup costs $10.00',
      product_refs: [{ variant_id: sku.id, listing_snapshot_id: before.id, market_id: market.id, currency: 'USD', field: 'price', inserted_text: '$10.00' }],
    }],
  });
  const variantPath = `/content-variants/${variant.id}`;
  const revisionPath = `/content-revisions/${variant.current_revision_id}`;
  const original = await operation('GET', revisionPath);
  expect((await operation('GET', variantPath)).variant.readiness).toBe('draft');
  expect((await observePrice(1200)).price_amount_minor).toBe(1200);
  await expect.poll(async () => (await operation('GET', variantPath)).variant, { timeout: 15_000 }).toMatchObject({
    readiness: 'stale', current_revision_id: original.id, stale_reasons: [{ kind: 'listing_changed', ref_id: before.id }],
  });
  expect(await operation('GET', revisionPath)).toEqual(original);
});
