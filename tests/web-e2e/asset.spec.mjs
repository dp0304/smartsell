import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

test('AS03 and AS04 through the running workbench', async ({ page, dev }) => {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, { headers: { origin: dev.origin, 'x-setup-token': dev.setupToken }, data: {
    email: 'assets@smartsell.test', name: 'Asset operator', workspaceName: 'Asset acceptance', password: dev.password(),
  } });
  expect(setup.status()).toBe(201);
  const session = await page.request.get(`${dev.origin}/api/v1/session`);
  const wid = (await session.json()).workspaces[0].id;
  const path = (module, action) => `/api/v1/workspaces/${wid}/commands/${module}/${action}`;
  const run = async (module, action, data = {}) => {
    const response = await page.request.post(`${dev.origin}${path(module, action)}`, { data, headers: { origin: dev.origin, 'idempotency-key': randomUUID() } });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).data;
  };
  const brand = await run('workspace', 'create_brand', { name: 'AS Primary', slug: 'as-primary' });
  const other = await run('workspace', 'create_brand', { name: 'AS Other', slug: 'as-other' });
  const market = await run('workspace', 'create_market', { brand_id: brand.id, name: 'US', country_code: 'US', primary_language: 'en', currency: 'USD', timezone: 'UTC' });
  const propose = (brand_id, body, entry_id) => run('asset', 'knowledge_propose', { brand_id, body, entry_id, kind: 'tone', title: 'Voice' });
  const active = await propose(brand.id, 'Primary approved voice');
  const unrelated = await propose(other.id, 'Other brand approved voice');
  for (const entry of [active, unrelated]) await run('asset', 'knowledge_approve', { revision_id: entry.revision.id });
  await propose(brand.id, 'Primary draft voice', active.entry.id);

  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${dev.origin}/compat/workbench/w/${wid}/assets`);
  try { await expect(page.getByRole('button', { name: 'Tools', exact: true })).toBeVisible({ timeout: 15_000 }); }
  catch (error) { throw new Error(`${page.url()} ${pageErrors.join(', ')} ${(await page.locator('body').innerText()).slice(0, 400)}`, { cause: error }); }
  const submit = async (module, action, values, status = 200) => {
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Tools', exact: true });
    await dialog.getByRole('combobox', { name: 'Action', exact: true }).selectOption(`${module}.${action}`);
    for (const [key, value] of Object.entries(values)) {
      const input = dialog.locator(`[name="${key}"]`);
      if (value === true) await input.check();
      else if (typeof value === 'object' && value.select) await input.selectOption(value.select);
      else await input.fill(String(value));
    }
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === path(module, action) && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Run command', exact: true }).click();
    if (action === 'template_apply') await dialog.getByRole('button', { name: 'Confirm operation', exact: true }).click();
    const response = await pending;
    expect(response.status(), await response.text()).toBe(status);
    const json = await response.json();
    if (status === 200) await expect(dialog.locator('pre')).toContainText(JSON.stringify(json.data, null, 2));
    else await expect(dialog.getByRole('alert')).toContainText('Template values changed');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    return json;
  };
  const context = await submit('asset', 'knowledge_get_context', { brand_id: { select: brand.id }, include_proposed: true });
  expect(context.data.active.map(({ body, revision_no }) => [body, revision_no])).toEqual([['Primary approved voice', 1]]);
  expect(context.data.proposed.map(({ body, revision_no }) => [body, revision_no])).toEqual([['Primary draft voice', 2]]);

  const store = await run('commerce', 'create_store', { brand_id: brand.id, name: 'Local store', provider: 'file_import', default_currency: 'USD', default_locale: 'en' });
  const product = await run('commerce', 'create_product', { store_id: store.id, title: 'Local product' });
  const sku = await run('commerce', 'upsert_variant', { product_id: product.id, sku: 'AS04' });
  const scope = { market_id: market.id, channel: 'online_store' };
  await run('commerce', 'configure_store_market', { ...scope, store_id: store.id, price_source: 'manual' });
  const snapshot = price_amount_minor => run('commerce', 'record_listing_snapshot', { ...scope, variant_id: sku.id, price_amount_minor, currency: 'USD' });
  const before = await snapshot(2000);
  const { item } = await run('content', 'content_create_item', { brand_id: brand.id, title: 'AS04 draft' });
  const { variant } = await run('content', 'content_create_variant', { content_item_id: item.id, platform: 'generic', format: 'text', locale: 'en', market_id: market.id });
  const { data: template } = await submit('asset', 'template_create', { brand_id: { select: brand.id }, name: 'AS04 price', kind: { select: 'caption_template' }, body: 'Buy for {{price}}', variables: '[{"key":"price","source":"listing"}]' });
  const apply = (listing_snapshot_id, expected_version) => submit('asset', 'template_apply', {
    template_id: { select: template.id }, variant_id: { select: variant.id }, expected_version, values: JSON.stringify({ price: { listing_snapshot_id } }),
  });
  const { data: draft } = await apply(before.id, variant.version);
  expect(draft.data.draft_doc.body).toBe('Buy for 2000');
  const after = await snapshot(2500);
  const commit = (expected_version, status) => submit('content', 'content_commit_revision', { variant_id: { select: variant.id }, expected_version, base_revision_id: 'null' }, status);
  expect((await commit(draft.version, 409)).error.code).toBe('TEMPLATE_VALUES_CHANGED');
  const { data: refreshed } = await apply(after.id, draft.version);
  expect((await commit(refreshed.version, 200)).data.revision.data.body).toBe('Buy for 2500');

  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  const { csrf_token } = await csrf.json();
  const rest = async (method, path, data, version) => {
    const response = await page.request.fetch(`${dev.origin}/api/v1/workspaces/${wid}${path}`, {
      method, data, headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, ...(version ? { 'If-Match': `"${version}"` } : {}) },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  };
  const mainBrand = await rest('POST', '/brands', { name: 'Default asset brand', slug: 'default-asset-brand' });
  await page.goto(`${dev.origin}/w/${wid}/assets`);
  await page.getByRole('button', { name: 'Asset templates', exact: true }).click();
  await page.getByRole('button', { name: 'Create copy template', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Create copy template' });
  await form.getByRole('combobox', { name: 'Brand', exact: true }).selectOption(mainBrand.id);
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Default entry template');
  await form.getByRole('textbox', { name: 'Template copy', exact: true }).fill('Default workspace copy');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  // The saved form also echoes the new template's name, so look for it in the list.
  await expect(page.getByRole('button', { name: 'Default entry template', exact: true })).toBeVisible();
  const [mainTemplate] = await rest('GET', '/templates');
  const { item: mainItem } = await rest('POST', '/content-items', { brand_id: mainBrand.id, title: 'Default asset draft' });
  const { variant: mainVariant } = await rest('POST', `/content-items/${mainItem.id}/variants`, { platform: 'generic', format: 'text' });
  const applied = await rest('POST', `/content-variants/${mainVariant.id}/apply-template`, { template_id: mainTemplate.id }, mainVariant.version);
  expect(applied.draft_doc.body).toBe('Default workspace copy');
  const saved = await rest('POST', `/content-variants/${mainVariant.id}/revisions`, { base_revision_id: null });
  expect(saved.revision.body).toBe('Default workspace copy');
});
