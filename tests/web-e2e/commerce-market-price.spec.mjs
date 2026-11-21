import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

test('PC03 shows missing prices and inserts only current, eligible market prices', async ({ page, dev }) => {
  const origin = { Origin: dev.origin };
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { ...origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'pc03@example.invalid', name: 'Catalog owner', workspaceName: 'PC03 workbench', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: { workspaces: [workspace] } } = await setup.json();
  const baseUrl = `${dev.origin}/w/${workspace.id}`;
  const root = `${dev.origin}/api/v1/workspaces/${workspace.id}`;
  const { csrf_token } = await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json();
  const request = (method, path, data, version) => page.request.fetch(root + path, { method, data, headers: {
    ...origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(), ...(version && { 'If-Match': `"${version}"` }),
  } });
  async function call(method, path, data, version) {
    const response = await request(method, path, data, version);
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  }
  const brand = await call('POST', '/brands', { name: 'Price brand', slug: 'price-brand' });
  const market = await call('POST', `/brands/${brand.id}/markets`, {
    name: 'Taiwan', country_code: 'TW', primary_language: 'zh-Hant', currency: 'TWD', timezone: 'Asia/Taipei',
  });
  const otherMarket = await call('POST', `/brands/${brand.id}/markets`, {
    name: 'Japan', country_code: 'JP', primary_language: 'ja-JP', currency: 'JPY', timezone: 'Asia/Tokyo',
  });
  const store = await call('POST', '/stores', { brand_id: brand.id, name: 'Price store', provider: 'shopify', default_currency: 'TWD', default_locale: 'zh-Hant' });
  const marketKey = { market_id: market.id, channel: 'online_store' };
  const configure = key => call('PUT', `/stores/${store.id}/markets`, { ...key, price_source: 'manual', snapshot_ttl_minutes: 1 });
  await configure(marketKey);
  await configure({ ...marketKey, market_id: otherMarket.id });
  const product = await call('POST', '/products', { store_id: store.id, title: 'Travel mug', status: 'active' });
  const otherProduct = await call('POST', '/products', { store_id: store.id, title: 'Mug sleeve', status: 'active' });
  const sku = await call('POST', `/products/${product.id}/variants`, { sku: 'PC03-MUG' });
  const missingSku = await call('POST', `/products/${product.id}/variants`, { sku: 'PC03-MISSING' });
  const pricedSku = await call('POST', `/products/${otherProduct.id}/variants`, { sku: 'PC03-SLEEVE' });
  const listing = (variant, fields) => call('POST', `/variants/${variant.id}/listings`, { ...marketKey, ...fields });
  const missing = await listing(missingSku, { availability: 'source_not_provided' });
  const wrongMarket = await listing(sku, { market_id: otherMarket.id, currency: 'JPY', price_amount_minor: 2200 });
  const rate = await call('POST', '/commands/analytics/set_fx_rate', { from_currency: 'JPY', to_currency: 'TWD', date: '2026-11-20', rate: '0.21' });
  // The compatibility FX command and commerce Operations use separate stores.
  // Supply only the synthetic upstream rate to the Operations fixture.
  dev.updateSnapshot(state => {
    const id = `row/fx_rate/${encodeURIComponent(rate.id)}`;
    const key = JSON.stringify(['operation_runtime', 'record', id]);
    const row = { ...rate.data, id: rate.id, version: rate.version, created_at: rate.created_at, updated_at: rate.updated_at, quote_currency: rate.data.to_currency };
    state.records.push([key, { ...rate, module: 'operation_runtime', kind: 'record', id, data: { value: JSON.stringify(row) } }]);
  });
  const estimate = await listing(sku, { price_source: 'fx_estimate', fx_rate_id: rate.id, currency: 'TWD', price_amount_minor: 46200 });
  expect(estimate).toMatchObject({ is_estimate: true, publishable_price: false });

  await page.addInitScript(() => {
    if (!localStorage.getItem('smartsell-language')) localStorage.setItem('smartsell-language', 'zh-Hant');
  });
  await page.goto(`${baseUrl}/commerce/products/${product.id}`);
  const missingRow = page.getByRole('row', { name: /PC03-MISSING.*未取得/ });
  await expect(missingRow.locator('.pill.warning')).toHaveText('未取得');
  await expect(page.getByText('換匯估計不可引用', { exact: true })).toBeVisible();

  const contentVariant = { platform: 'facebook', format: 'text', locale: 'en-US', market_id: market.id, body: 'Pack light' };
  const { item, variants: [variant, secondVariant] } = await call('POST', '/content-items', { brand_id: brand.id, title: 'Travel mug caption',
    variants: [contentVariant, { ...contentVariant, platform: 'instagram' }],
  });
  const variantPath = `/content-variants/${variant.id}`;
  const pickerPath = `${variantPath}/product-prices`;
  const readDraft = async () => (await call('GET', variantPath)).variant;
  const reject = async snapshot => {
    const response = await request('POST', pickerPath, { listing_snapshot_id: snapshot.id }, variant.version);
    expect(response.status(), await response.text()).toBe(422);
    expect((await response.json()).code).toBe('invalid_product_reference');
  };
  await page.evaluate(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(`${baseUrl}/content?id=${item.id}&related=variant&rid=${variant.id}`);
  const picker = page.getByRole('region', { name: 'Insert market price' });
  await picker.getByRole('button', { name: 'Insert market price' }).click();
  await picker.getByRole('combobox', { name: 'Product', exact: true }).selectOption(product.id);
  const choices = picker.getByRole('combobox', { name: 'Eligible market price' });
  const add = picker.getByRole('button', { name: 'Add to working draft' });
  await expect(picker.getByText(/Exchange-rate estimates cannot be inserted/)).toBeVisible();
  await expect(choices.getByRole('option')).toHaveCount(1);
  await expect(add).toBeDisabled();
  await reject(estimate);
  await reject(missing);
  await reject(wrongMarket);
  const directEstimate = await request('PATCH', variantPath, { product_refs: [{ variant_id: sku.id, listing_snapshot_id: estimate.id,
    field: 'price', market_id: market.id, currency: 'TWD', inserted_text: 'TWD 462.00' }] }, variant.version);
  expect(directEstimate.status(), await directEstimate.text()).toBe(422);
  expect(await readDraft()).toMatchObject({ version: variant.version, draft_doc: { body: 'Pack light', product_refs: [] } });

  const stale = await listing(pricedSku, { price_amount_minor: 12000 });
  await dev.setTime(Date.parse(stale.observed_at) + 120_000);
  await reject(stale);
  const current = await listing(pricedSku, { price_amount_minor: 13500 });
  expect(current.publishable_price).toBe(true);
  await reject(stale);
  await picker.getByRole('combobox', { name: 'Product', exact: true }).selectOption(otherProduct.id);
  await choices.selectOption(current.id);
  const insertion = page.waitForResponse(response => response.url() === root + pickerPath && response.request().method() === 'POST');
  await add.click();
  expect((await insertion).ok()).toBe(true);
  await expect(picker.getByRole('status')).toHaveText('Market price added to the working draft.');
  const pinned = { variant_id: pricedSku.id, listing_snapshot_id: current.id, market_id: market.id, currency: 'TWD', field: 'price', inserted_text: 'TWD 135.00' };
  const edited = await readDraft();
  expect(edited.draft_doc).toMatchObject({ body: `Pack light\n${pinned.inserted_text}`, product_refs: [pinned] });
  const forged = await call('POST', `/content-variants/${secondVariant.id}/product-prices`, {
    listing_snapshot_id: current.id, price_amount_minor: 1, currency: 'JPY', inserted_text: 'JPY 1',
    market_id: otherMarket.id, product_variant_id: sku.id,
  }, secondVariant.version);
  expect(forged.draft_doc).toMatchObject({ body: edited.draft_doc.body, product_refs: [pinned] });
  await page.reload();
  await expect(page.getByRole('region', { name: 'Market price references' })).toContainText(current.id);
  await call('POST', `${variantPath}/revisions`, { base_revision_id: null, expected_version: edited.version });
  const committed = await readDraft();
  const revisionPath = `/content-revisions/${committed.current_revision_id}`;
  const original = await call('GET', revisionPath);
  expect(original.product_refs).toEqual([pinned]);
  await listing(pricedSku, { price_amount_minor: 15000 });
  expect(await call('GET', revisionPath)).toEqual(original);
});
