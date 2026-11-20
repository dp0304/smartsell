import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localCommercePromotions } from './local-dev.mjs';

const test = base.extend({ dev: localCommercePromotions });

test('PC07 separates a promotion draft, verified active offer, and synced coupon use, and warns on copy conflicts', async ({ page, dev }) => {
  const { email, password, workspaceId, appId, externalStoreId } = dev.browserFixture;
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
    const payload = await reply.json();
    expect(reply.ok(), `${method} ${path}: ${JSON.stringify(payload)}`).toBe(true);
    return payload.data;
  }
  const brand = await call('POST', '/brands', { name: 'PC07 merchant', slug: 'pc07-merchant' });
  const store = await call('POST', '/stores', { brand_id: brand.id, provider: 'shopify', name: 'PC07 Store',
    external_store_id: externalStoreId, default_currency: 'USD', default_locale: 'en-US', sync_scope: { products: true, orders: true } });
  const connection = await call('POST', '/connections/shopify/merchant', { brand_id: brand.id, platform_app_id: appId });
  expect(connection).toMatchObject({ status: 'active', scopes: expect.arrayContaining(['read_orders', 'read_discounts']) });
  await call('POST', `/stores/${store.id}/connect`, { connection_id: connection.id, external_store_id: externalStoreId });
  await call('POST', '/data-sources', { kind: 'store', name: 'PC07 orders', provider: 'shopify', store_id: store.id, connection_id: connection.id, resources: ['orders'] });
  expect(await call('GET', `/orders?store_id=${store.id}`)).toEqual([]);

  await page.goto(`${dev.origin}/w/${workspaceId}/commerce/promotions`);
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Create promotion draft' }).click();
  await dialog.getByLabel('Store', { exact: true }).selectOption(store.id);
  await dialog.getByLabel('Promotion name').fill('PC07 spring offer');
  await dialog.getByLabel('Discount percent').fill('10');
  await dialog.getByLabel('Discount code', { exact: true }).fill('PC07SAVE');
  await dialog.getByLabel('External discount ID').fill('gid://shopify/DiscountCodeNode/707');
  await dialog.getByLabel('Valid from (UTC)').fill('2020-01-01T00:00');
  await dialog.getByLabel('Valid until (UTC)').fill('2099-01-01T00:00');
  await dialog.getByRole('button', { name: 'Create promotion draft' }).click();
  const evidence = page.getByRole('region', { name: 'Promotion evidence' });
  const terms = evidence.locator('dd');
  await expect(terms).toHaveText(['Draft', 'Not verified active', '0', '10%', 'PC07SAVE', /2020-01-01.*2099-01-01/]);
  const [promotion] = await call('GET', `/promotions?store_id=${store.id}`);
  expect(promotion).toMatchObject({ state: 'draft', offer_verified: false, usage_count: 0 });

  async function confirm(label) {
    await evidence.getByRole('button', { name: label }).click();
    await dialog.getByRole('button', { name: label }).click();
    await expect(dialog).not.toBeVisible();
  }
  await confirm('Enable promotion plan');
  await expect(terms.nth(0)).toHaveText('Active');
  await expect(terms.nth(1)).toHaveText('Not verified active');
  await confirm('Verify store offer');
  await expect(terms.nth(1)).toHaveText('Verified active');
  await expect(terms.nth(2)).toHaveText('0');
  expect(await call('GET', `/promotions/${promotion.id}`)).toMatchObject({ state: 'active', offer_verified: true, usage_count: 0 });

  const sync = await call('POST', `/stores/${store.id}/sync`, { resource: 'orders' });
  await expect.poll(async () => (await call('GET', `/sync-runs/${sync.sync_run_id}`)).status, { timeout: 15_000 }).toBe('succeeded');
  const [order] = await call('GET', `/orders?store_id=${store.id}`);
  expect((await call('GET', `/orders/${order.id}`)).discounts).toMatchObject([{ code: 'PC07SAVE', amount_minor: null, promotion_id: promotion.id }]);
  await page.reload();
  await expect(terms.nth(2)).toHaveText('1');
  expect(await call('GET', `/promotions/${promotion.id}`)).toMatchObject({ state: 'active', offer_verified: true, usage_count: 1 });

  const checkCopy = async (code, percent) => {
    await evidence.getByRole('button', { name: 'Check channel copy' }).click();
    await dialog.getByLabel('Advertised code').fill(code);
    await dialog.getByLabel('Advertised discount percent').fill(percent);
    await dialog.getByRole('button', { name: 'Check channel copy' }).click();
    await expect(dialog).not.toBeVisible();
  };
  await checkCopy('PC07WRONG', '25');
  const warning = evidence.getByRole('alert');
  await expect(warning).toContainText('Copy conflicts with the store offer');
  await expect(warning).toContainText('The advertised discount percentage differs');
  await expect(warning).toContainText('The advertised discount code differs');
  await checkCopy('pc07save', '10');
  await expect(warning).toHaveCount(0);
  await expect(evidence.getByRole('status')).toContainText('The advertised code and discount match the verified offer');
  await expect(terms.nth(2)).toHaveText('1');
});
