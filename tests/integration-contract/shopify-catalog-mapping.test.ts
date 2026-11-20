import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCatalog } from '../../packages/adapters/src/catalog.ts';
import type { Row } from '../../packages/contracts/src/index.ts';
import { Records } from '../../packages/db/src/index.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { applyCatalogPage } from '../../apps/server/src/modules/commerce/catalog-sync.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';

test('Shopify catalog upgrades a legacy handle and option CSV in place', async () => {
  const ctx = makeContext(new Records(new Map(), false), { tenantId: 'tenant', workspaceId: 'workspace', actorId: 'operator' }, 'owner');
  const { operations } = await discoverOperations();
  async function run(name: string, body: Record<string, unknown>, id?: string) {
    const operation = operations.find(op => op.name === name);
    assert.ok(operation, name);
    return await operation.run(ctx, { body, params: id ? { id } : {}, query: {} }) as Row;
  }
  const brand = ctx.create('brand', { name: 'Test brand' });
  const store = await run('commerce_store_create', { brand_id: brand.id, provider: 'shopify', name: 'Test shop', default_currency: 'USD', default_locale: 'en-US' });
  const batch = await run('commerce_store_import', {
    csv: 'Handle,Title,Option1 Name,Option1 Value,Option2 Name,Option2 Value\ncap,Imported Cap,Z Color,Blue,A Size,Small\ncap,Imported Cap,Z Color,Red,A Size,Small',
  }, store.id);
  await run('import_confirm', {}, batch.id);
  const [product] = ctx.list('product');
  const [blue, red] = ctx.list('product_variant');
  assert.ok(product && blue && red);
  assert.equal(product.external_product_id, null);
  assert.deepEqual(blue.options, { option1: 'Blue', option2: 'Small' });
  assert.equal(blue.external_variant_id, null);
  assert.equal(blue.sku, null);

  const shopId = 'gid://shopify/Shop/1';
  const connection = ctx.create('connection', { brand_id: brand.id, purpose: 'store', provider: 'shopify', status: 'active', discovered_accounts: [{ externalAccountId: shopId }] });
  const connected = await run('commerce_store_connect', { connection_id: connection.id }, store.id);
  assert.equal(connected.upgrading_from_import, true);

  const productId = 'gid://shopify/Product/10';
  const blueId = 'gid://shopify/ProductVariant/11';
  const redId = 'gid://shopify/ProductVariant/12';
  const blueOptions = [{ name: 'Z Color', value: 'Blue' }, { name: 'A Size', value: 'Small' }];
  const page = await fetchCatalog('shopify', null, {
    accountId: shopId, state: 'active', accessToken: 'fixture-token', scopes: ['read_products'], configuration: { shop: 'fixture.myshopify.com' },
  }, async request => {
    const { query } = JSON.parse(String(request.body));
    assert.match(query, /\bhandle\b/);
    assert.match(query, /selectedOptions\s*\{\s*name\s+value\s*\}/);
    const pageInfo = { hasNextPage: false, endCursor: null };
    return { headers: {}, payload: { data: { shop: { currencyCode: 'USD' }, products: {
      pageInfo, nodes: [{ id: productId, title: 'Synced Cap', handle: 'cap', variants: { pageInfo, nodes: [
        { id: blueId, selectedOptions: blueOptions },
        { id: redId, selectedOptions: [{ name: 'Z Color', value: 'Red' }, { name: 'A Size', value: 'Small' }, { name: 'Material' }] },
      ] } }],
    } } } };
  });
  assert.equal(page.items[0]?.handle, 'cap');
  assert.deepEqual(page.items[0]?.variants[0]?.selectedOptions, blueOptions);
  assert.equal(page.items[0]?.variants[1]?.selectedOptions, undefined);

  const [saved] = applyCatalogPage(ctx, store.id, page);
  assert.equal(saved?.id, product.id);
  assert.equal(saved?.external_product_id, productId);
  assert.equal(saved?.title, 'Synced Cap');
  assert.equal(ctx.list('product').length, 1);
  assert.equal(ctx.get('product_variant', blue.id).external_variant_id, blueId);
  assert.equal(ctx.get('product_variant', red.id).external_variant_id, null);
  assert.equal(ctx.list('product_variant').length, 3);
  assert.deepEqual(ctx.list('mapping_task').map(row => [row.entity_type, row.external_id, row.reason]), [
    ['product_variant', redId, 'unmatched_or_ambiguous'],
  ]);
});
