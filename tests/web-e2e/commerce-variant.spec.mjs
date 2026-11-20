import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

async function workspace(page, dev) {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'pc02@example.invalid', name: 'Catalog owner', workspaceName: 'PC02 workbench', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: { workspaces: [workspace] } } = await setup.json();
  const root = `${dev.origin}/api/v1/workspaces/${workspace.id}`;
  const { csrf_token } = await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json();
  async function call(method, path, data) {
    const reply = await page.request.fetch(root + path, { method, data, headers: {
      Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
    } });
    expect(reply.ok(), await reply.text()).toBe(true);
    return (await reply.json()).data;
  }
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  return { call, catalog: `${dev.origin}/w/${workspace.id}/commerce` };
}

test('PC02 workbench finds same-SKU products and keeps split mappings visible', async ({ page, dev }) => {
  const { call, catalog } = await workspace(page, dev);
  const brand = await call('POST', '/brands', { name: 'PC02 Brand', slug: 'pc02-brand' });
  const shops = [];
  for (const [name, color] of [['North', 'Blue'], ['South', 'Red']]) {
    const store = await call('POST', '/stores', { brand_id: brand.id, name, provider: 'shopify', default_currency: 'USD', default_locale: 'en-US' });
    const batch = await call('POST', `/stores/${store.id}/imports`, {
      csv: `external_product_id,external_variant_id,handle,title,sku,option1\nP-1,V-1,cap,${name} cap,PC02-SHARED,${color}`,
    });
    await call('POST', `/imports/${batch.id}/confirm`, {});
    shops.push(store);
  }
  const products = await call('GET', '/products?query=PC02-SHARED');
  expect(products).toHaveLength(2);
  await page.goto(`${catalog}/products`);
  const search = page.getByRole('searchbox', { name: 'Search by title, handle, or SKU' });
  await search.fill('PC02-NOT-FOUND');
  await expect(page.getByRole('button', { name: 'South cap' })).toHaveCount(0);
  await search.fill('PC02-SHARED');
  await expect(page.getByText('North cap', { exact: true })).toBeVisible();
  await expect(page.getByText('South cap', { exact: true })).toBeVisible();

  await page.goto(`${catalog}/mapping`);
  await page.getByRole('button', { name: 'Create mapping group' }).click();
  let drawer = page.getByRole('dialog');
  await drawer.getByLabel('Group name').fill('Reviewed Caps');
  await drawer.getByRole('combobox', { name: 'Brand', exact: true }).selectOption(brand.id);
  await drawer.getByRole('button', { name: 'Create mapping group' }).click();
  await expect(drawer).toBeHidden();
  for (const shop of shops) {
    const product = products.find(row => row.store_id === shop.id);
    const { variants: [variant] } = await call('GET', `/products/${product.id}`);
    await page.getByRole('button', { name: 'Link variant' }).click();
    drawer = page.getByRole('dialog');
    await drawer.getByRole('searchbox', { name: 'Search by title, handle, or SKU' }).fill('PC02-SHARED');
    await drawer.getByRole('combobox', { name: 'Product', exact: true }).selectOption(product.id);
    await drawer.getByRole('combobox', { name: 'Product variant', exact: true }).selectOption(variant.id);
    await drawer.getByLabel('Mapping evidence').fill(`Reviewed ${shop.name} variant`);
    await drawer.getByRole('button', { name: 'Link variant' }).click();
    await expect(drawer).toBeHidden();
  }
  await page.getByRole('row', { name: /South.*Reviewed South variant/ }).getByRole('button', { name: 'Split mapping' }).click();
  drawer = page.getByRole('dialog');
  await drawer.getByLabel('Split reason').fill('Different color');
  await drawer.getByRole('button', { name: 'Split mapping' }).click();
  await expect(drawer).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mapping history' })).toBeVisible();
  await expect(page.getByRole('row', { name: /South.*Reviewed South variant.*Different color/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /North.*Reviewed North variant/ }).getByRole('button', { name: 'Split mapping' })).toBeVisible();
  const [saved] = await call('GET', '/variant-groups');
  expect(saved.name).toBe('Reviewed Caps');
  expect(saved.members.filter(member => member.unlinked_at)).toMatchObject([{ store_id: shops[1].id, unlink_reason: 'Different color' }]);
});


test('PC02 workspace reviews same-barcode pairs as a batch without merging products', async ({ page, dev }) => {
  const { call, catalog } = await workspace(page, dev);
  const brand = await call('POST', '/brands', { name: 'Review brand', slug: 'review-brand' });
  const barcodes = ['1234567890123', '1234567890130', '1234567890147'];
  const selectedVariants = [];
  for (const name of ['North', 'South']) {
    const store = await call('POST', '/stores', { brand_id: brand.id, name, provider: 'shopify', default_currency: 'USD', default_locale: 'en-US' });
    const product = await call('POST', '/products', { store_id: store.id, title: `${name} cap` });
    for (const [index, barcode] of barcodes.entries()) {
      const variant = await call('POST', `/products/${product.id}/variants`, { sku: `BATCH-${index}`, barcode });
      if (index < 2) selectedVariants.push(variant.id);
    }
  }
  const group = await call('POST', '/variant-groups', { brand_id: brand.id, name: 'Batch reviewed' });
  await page.goto(`${catalog}/mapping`);
  await page.getByRole('button', { name: 'Review barcode matches' }).click();
  const review = page.getByRole('dialog');
  for (const barcode of barcodes.slice(0, 2)) await review.getByLabel(`Same barcode ${barcode}`, { exact: false }).check();
  await expect(review.getByLabel(`Same barcode ${barcodes[2]}`, { exact: false })).not.toBeChecked();
  await review.getByRole('button', { name: 'Review barcode matches' }).click();
  await expect(review).toBeHidden();
  const members = await call('GET', `/variant-groups/${group.id}/members`);
  expect(members.map(row => row.variant_id).sort()).toEqual(selectedVariants.sort());
  expect(new Set(members.map(row => row.store_id)).size).toBe(2);
  expect(members.every(row => row.linked_via === 'suggestion_accepted')).toBe(true);
  expect(await call('GET', '/products?query=BATCH-0')).toHaveLength(2);
});
