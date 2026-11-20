import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Problem, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { applyCatalogPage, applyStoreSyncResult, createCommerceOperations, operations, prepareImport, reconcileStoreCatalog } from './index.js';
import { importOperations } from '../ingest/import-operations.js';
import { observeShopifyCoupons } from './promotion-usage.js';
import { normalizeCommerceCatalogPage } from '../../../../../packages/adapters/src/catalog.js';

function setup() {
  const records = new Map<string, Row[]>();
  const events: { type: string; data: Data }[] = [];
  let next = 0;
  const ctx: Context = {
    workspaceId: 'workspace', tenantId: 'tenant', actorId: 'operator', role: 'owner', now: '2026-11-19T12:00:00.000Z',
    list: kind => records.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(row => row.id === id);
      if (!row) throw new Problem(404, 'not_found', `${kind} not found`);
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: `row-${++next}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      records.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, values) {
      const previous = ctx.get(kind, id);
      const row = { ...previous, ...values, id, version: previous.version + 1, updated_at: ctx.now };
      records.set(kind, ctx.list(kind).map(item => item.id === id ? row : item));
      return row;
    },
    remove(kind, id) { records.set(kind, ctx.list(kind).filter(row => row.id !== id)); },
    emit(type, data) { events.push({ type, data }); },
  };
  const handlers: Operation[] = [...operations, ...importOperations];
  async function run<T = Row>(name: string, body: Data = {}, id?: string, expectedVersion?: number): Promise<T> {
    const operation = handlers.find(item => item.name === name);
    assert.ok(operation, `missing operation ${name}`);
    if (!operation.roles.includes(ctx.role)) throw new Problem(403, 'forbidden', 'Forbidden');
    if (operation.versionKind && ctx.get(operation.versionKind, id!).version !== expectedVersion) throw new Problem(412, 'version_mismatch', 'Version mismatch');
    return await operation.run(ctx, { body, params: id ? { id } : {}, query: {}, expectedVersion }) as T;
  }
  const brand = ctx.create('brand', { name: 'Test brand' });
  const market = ctx.create('market', { brand_id: brand.id, currency: 'USD' });
  const store = (provider = 'shopify') => run('commerce_store_create', { brand_id: brand.id, provider, name: provider, default_currency: 'USD', default_locale: 'en-US' });
  const settings = (id: string, extras: Data = {}) => run<Row[]>('commerce_store_market_configure', { market_id: market.id, channel: 'online_store', price_source: 'store_base_price', ...extras }, id);
  return { ctx, events, run, brand, market, store, settings };
}

const catalogCsv = 'Handle,Title,Variant SKU,Option1 Value,Variant Price,Currency,Variant Inventory Qty\nbeanie,Beanie,B-001,Blue,4.50,USD,99';

test('CSV preview and confirmation write SKU and USD price, then Shopify inventory overrides just its locations', async () => {
  const { ctx, run, store, settings, events } = setup();
  const shop = await store();
  await settings(shop.id, { inventory_locations: ['Retail'], low_stock_threshold: 2 });
  const catalog = await run('commerce_store_import', { csv: catalogCsv }, shop.id);
  assert.equal(ctx.list('product').length, 0);
  assert.equal((catalog.stats as Data).new, 1);
  await run('import_confirm', {}, catalog.id);
  const [variant] = ctx.list('product_variant');
  assert.equal(variant!.sku, 'B-001');
  assert.equal(ctx.list('listing_snapshot')[0]!.price_amount_minor, 450);
  const inventory = await run('commerce_store_import', { template_key: 'inventory_list', csv: 'Handle,Option1 Value,Location,Available\nbeanie,Blue,Retail,1\nbeanie,Blue,Backroom,500' }, shop.id);
  assert.equal((inventory.stats as Data).changed, 2);
  await run('import_confirm', {}, inventory.id);
  const active = () => ctx.list('listing_snapshot').find(row => row.is_current === true)!;
  assert.equal(active().inventory_quantity, 1);
  assert.equal(active().price_amount_minor, 450);
  const updated = await run('commerce_store_import', { csv: catalogCsv.replace('4.50', '4.75') }, shop.id);
  await run('import_confirm', {}, updated.id);
  assert.equal(active().inventory_quantity, 1);
  assert.equal(active().price_amount_minor, 475);
  assert.ok(events.some(event => event.type === 'commerce.change_event.created' && event.data.change_type === 'price_changed'));
});

test('store authorization preserves imported IDs and remains connecting until a completed snapshot', async () => {
  const { ctx, run, store, brand } = setup();
  const shop = await store();
  const product = prepareImport(ctx, 'product_list', shop.id, { handle: 'cap', title: 'Cap', sku: 'SKU' })();
  const [variant] = ctx.list('product_variant');
  const other = await store();
  prepareImport(ctx, 'product_list', other.id, { handle: 'other', title: 'Other', sku: 'SKU' })();
  const connection = ctx.create('connection', { purpose: 'store', provider: 'shopify', brand_id: brand.id, status: 'active', discovered_accounts: [{ externalAccountId: 'authorized' }] });
  await assert.rejects(run('commerce_store_connect', { connection_id: connection.id, external_store_id: 'unverified' }, shop.id), { code: 'store_identity_unverified' });
  const connected = await run('commerce_store_connect', { connection_id: connection.id }, shop.id);
  assert.equal(connected.status, 'connecting');
  const prep = prepareImport(ctx, 'product_list', shop.id, { external_product_id: 'P', handle: 'cap', title: 'Cap new', variants: [{ external_variant_id: 'V', sku: 'SKU' }] }, { mode: 'api' });
  assert.equal(prep.status, 'changed');
  assert.equal(ctx.get('product', product.id).title, 'Cap');
  assert.equal(prep().id, product.id);
  assert.equal(ctx.get('product_variant', variant!.id).external_variant_id, 'V');
  assert.equal(ctx.get('store', shop.id).status, 'connecting');
  assert.equal(applyStoreSyncResult(ctx, shop.id, { state: 'full' }).status, 'active');
});

test('unavailable inventory and stale snapshots never appear as publishable prices', async () => {
  const { ctx, run, store, settings, market } = setup();
  const shop = await store();
  await settings(shop.id, { price_source: 'manual', snapshot_ttl_minutes: 1 });
  const product = await run('commerce_product_create', { store_id: shop.id, title: 'Cap', status: 'active' });
  const variant = await run('commerce_variant_create', { sku: 'test' }, product.id);
  const fields = { market_id: market.id, channel: 'online_store' };
  const rate = ctx.create('fx_rate', { quote_currency: 'USD' });
  const estimate = await run('commerce_record_listing', { ...fields, price_source: 'fx_estimate', fx_rate_id: rate.id, price_minor: 1750 }, variant.id);
  assert.equal(estimate.is_estimate, true);
  assert.equal(estimate.publishable_price, false);
  const manual = await run('commerce_record_listing', { ...fields, price_minor: 1800, available_for_sale: true }, variant.id);
  assert.equal(manual.publishable_price, true);
  ctx.now = '2026-11-19T12:02:00.000Z';
  const history = await run<Data[]>('market_snapshot', {}, variant.id);
  assert.equal(history.find(row => row.id === manual.id)!.stale, true);
  await run('commerce_record_listing', { ...fields, availability: 'no_permission' }, variant.id);
  assert.ok(!ctx.list('change_event').some(row => row.change_type === 'out_of_stock' || row.change_type === 'became_unavailable'));
});

test('claim evidence is required and approved localization stays pinned until source changes', async () => {
  const { ctx, run, store } = setup();
  const shop = await store();
  const product = await run('commerce_product_create', { store_id: shop.id, title: 'Cap' });
  const fact = await run('catalog_propose_fact', { fact_key: 'washable', category: 'claim', value: 'Machine washable' }, product.id);
  await assert.rejects(run('commerce_fact_approve', {}, String(fact.current_revision_id)), { code: 'invalid_input' });
  const revised = await run('commerce_fact_revise', { value: 'Machine washable', evidence_urls: ['https://evidence.example/washing'] }, fact.id, fact.version);
  await run('commerce_fact_approve', {}, String(revised.current_revision_id));
  assert.equal((await run<Data[]>('catalog_list_facts', {}, product.id)).length, 1);
  const draft = await run('catalog_update_localization', { field_key: 'title', locale: 'fr-FR', text: 'Casquette' }, product.id);
  const pending = await run('commerce_localization_submit', {}, draft.id, draft.version);
  const approved = await run('commerce_localization_approve', {}, pending.id, pending.version);
  ctx.role = 'agent';
  const proposed = await run('catalog_update_localization', { field_key: 'title', locale: 'fr-FR', text: 'Chapeau' }, product.id, approved.version);
  assert.equal(proposed.approved_revision_id, approved.approved_revision_id);
  assert.notEqual(proposed.pending_revision_id, approved.approved_revision_id);
  ctx.role = 'owner';
  await run('commerce_product_update', { title: 'Baseball Cap' }, product.id, product.version);
  assert.equal(ctx.get('product_localization', draft.id).status, 'stale');
});

test('Amazon reports discard PII and only settled refunds reduce recorded order totals', async () => {
  const { ctx, run, store } = setup();
  const shop = await store('amazon_sp');
  const batch = await run('commerce_store_import', { template_key: 'order_list', csv: 'amazon-order-id,placed_at,total_minor,currency,buyer-email,postalCode\nAB-1,2026-11-18T00:00:00Z,1000,USD,buyer@example.com,99991' }, shop.id);
  assert.equal((batch.stats as Data).new, 1);
  await run('import_confirm', {}, batch.id);
  assert.ok(!JSON.stringify(ctx.list('import_row')).includes('99991'));
  const refund = { external_order_id: 'AB-1', external_refund_id: 'R1', amount_minor: 300, status: 'pending', deliveryAddress: { postalCode: '99991' } };
  prepareImport(ctx, 'refund_list', shop.id, refund)();
  let report = await run<Data>('orders_summary');
  assert.equal((report.currencies as Data[])[0]!.recorded_total_less_refund_minor, 1000);
  prepareImport(ctx, 'refund_list', shop.id, { ...refund, status: 'succeeded' })();
  assert.equal(prepareImport(ctx, 'refund_list', shop.id, refund).status, 'unchanged');
  report = await run<Data>('orders_summary');
  assert.equal((report.currencies as Data[])[0]!.recorded_total_less_refund_minor, 700);
  assert.doesNotMatch(JSON.stringify(await run('commerce_order_get', {}, ctx.list('order')[0]!.id)), /buyer|postalCode|99991/i);
});


test('read-only catalog worker refreshes unchanged observations and reconciles authoritative removals', async () => {
  const { ctx, run, store, brand, settings } = setup();
  const shop = await store();
  await settings(shop.id);
  const connection = ctx.create('connection', { purpose: 'store', provider: 'shopify', brand_id: brand.id, status: 'active', discovered_accounts: [{ externalAccountId: 'external-shop' }] });
  await run('commerce_store_connect', { connection_id: connection.id }, shop.id);
  const catalog = { items: [{ externalId: 'P', title: 'Cap', variants: [{ externalId: 'V', currency: 'USD', price: '10.00', available: 4 }] }], nextCursor: null };
  const [product] = applyCatalogPage(ctx, shop.id, catalog);
  assert.equal(ctx.list('listing_snapshot')[0]!.price_amount_minor, 1000);
  assert.deepEqual(reconcileStoreCatalog(ctx, shop.id, []), []);
  applyStoreSyncResult(ctx, shop.id, { state: 'full' });
  ctx.now = '2026-11-19T14:00:00.000Z';
  assert.equal(applyCatalogPage(ctx, shop.id, catalog)[0]!.id, product!.id);
  assert.equal(ctx.list('listing_snapshot').find(row => row.is_current)!.observed_at, ctx.now);
  assert.equal(reconcileStoreCatalog(ctx, shop.id, [])[0]!.status, 'removed_at_source');
  const [variant] = ctx.list('product_variant');
  assert.equal((await run<Data[]>('market_snapshot', {}, variant!.id)).every(row => row.publishable_price === false), true);
});


test('PC02 connector pages update identical external IDs and SKUs independently per store', async () => {
  const { ctx, run, store, settings, brand } = setup();
  const pages = {
    shopify: (price: string) => normalizeCommerceCatalogPage('shopify', { items: [{ id: 'P', title: 'Cap', currency: 'USD',
      variants: { nodes: [{ id: 'V', sku: 'SHARED', price }] } }], nextCursor: null }),
    tiktok_shop: (price: string) => normalizeCommerceCatalogPage('tiktok_shop', { items: [{ id: 'P', title: 'Cap',
      skus: [{ id: 'V', seller_sku: 'SHARED', price: { sale_price: price, currency: 'USD' } }] }], nextCursor: null }),
    amazon_sp: (price: string) => normalizeCommerceCatalogPage('amazon_sp', { items: [{ sku: 'SHARED', summaries: [{ title: 'Cap' }],
      offers: [{ offerType: 'B2C', amount: price, currency: 'USD' }] }], nextCursor: null }),
    shopee: (price: string) => ({ items: [{ externalId: '1', title: 'Cap', variants: [{ externalId: '2', sku: 'SHARED', currency: 'USD', price }] }], nextCursor: null }),
  };
  for (const [provider, page] of Object.entries(pages)) {
    const north = await store(provider), south = await store(provider);
    for (const shop of [north, south]) {
      await settings(shop.id);
      const connection = ctx.create('connection', { provider, brand_id: brand.id, purpose: 'store', status: 'active',
        discovered_accounts: [{ externalAccountId: shop.id }] });
      await run('commerce_store_connect', { connection_id: connection.id }, shop.id);
    }
    const [a] = applyCatalogPage(ctx, north.id, page('10.00'));
    const [b] = applyCatalogPage(ctx, south.id, page('20.00'));
    assert.notEqual(a.id, b.id, provider);
    assert.equal(a.external_product_id, b.external_product_id);
    const variants = ctx.list('product_variant');
    const av = variants.find(row => row.product_id === a.id)!;
    const bv = variants.find(row => row.product_id === b.id)!;
    assert.notEqual(av.id, bv.id);
    assert.equal(av.external_variant_id, bv.external_variant_id);
    assert.equal(av.sku, bv.sku);
    assert.equal(applyCatalogPage(ctx, north.id, page('11.25'))[0].id, a.id);
    const price = async (id: string) => (await run<Data[]>('market_snapshot', {}, id)).find(row => row.is_current)?.price_amount_minor;
    assert.equal(await price(av.id), 1125);
    assert.equal(await price(bv.id), 2000);
    assert.equal(ctx.list('product_variant').find(row => row.id === av.id)?.store_id, north.id);
    assert.equal(ctx.list('product_variant').find(row => row.id === bv.id)?.store_id, south.id);
  }
  assert.deepEqual(ctx.list('variant_group_member'), []);
});


test('promotions distinguish scheduled plans, mismatched readback, and verified active offers', async () => {
  const { ctx, run, store } = setup();
  const shop = await store();
  const validFrom = '2026-11-20T12:00:00.000Z';
  const validUntil = '2026-11-21T12:00:00.000Z';
  const promotion = await run('commerce_promotion_create', {
    store_id: shop.id, name: 'Winter sale', external_discount_id: 'ext-offer', state: 'scheduled',
    valid_from: validFrom, valid_until: validUntil, rule: { percent_off: 15 }, codes: [{ code: 'WINTER' }],
  });
  assert.equal(promotion.state, 'scheduled');
  assert.equal(promotion.offer_verified, false);
  await assert.rejects(run('commerce_promotion_verify', {}, promotion.id, promotion.version), { code: 'integration_unavailable' });
  let percent = 10;
  const verify = createCommerceOperations({ readPromotion: async () => ({ rule: { percent_off: percent }, valid_from: validFrom, valid_until: validUntil, codes: ['WINTER'] }) })
    .find(operation => operation.name === 'commerce_promotion_verify')!;
  const input = { body: {}, params: { id: promotion.id }, query: {} };
  const mismatch = await verify.run(ctx, input) as Row;
  assert.equal(mismatch.verification_status, 'mismatch');
  ctx.now = validFrom;
  percent = 15;
  const verified = await verify.run(ctx, input) as Row;
  assert.equal(verified.offer_verified, true);
  ctx.now = validUntil;
  assert.equal((await run('promotion_get', {}, promotion.id)).offer_verified, false);
});


test('Shopify coupon attribution is store-specific, deduplicated, and preserved for a still-observed order code', async () => {
  const { ctx, store } = setup();
  const shop = await store();
  const other = await store();
  const offer = { external_discount_id: 'offer', valid_from: '2026-11-01T00:00:00.000Z', valid_until: '2026-12-01T00:00:00.000Z' };
  const promo = ctx.create('promotion', { ...offer, store_id: shop.id });
  const another = ctx.create('promotion', { ...offer, store_id: other.id });
  for (const promotion of [promo, another]) ctx.create('promotion_code', { code: 'SAVE', promotion_id: promotion.id });
  assert.deepEqual(observeShopifyCoupons(ctx, shop, ctx.now, ['save', 'SAVE']), [{ code: 'SAVE', amount_minor: null, promotion_id: promo.id }]);
  const order = ctx.create('order', { store_id: shop.id, source: { kind: 'store_sync' } });
  ctx.create('discount_usage', { code: 'SAVE', amount_minor: null, promotion_id: promo.id, order_id: order.id });
  ctx.update('promotion', promo.id, { external_discount_id: null });
  assert.equal(observeShopifyCoupons(ctx, shop, ctx.now, ['SAVE'])[0]?.promotion_id, null);
  assert.equal(observeShopifyCoupons(ctx, shop, ctx.now, ['SAVE'], order)[0]?.promotion_id, promo.id);
  assert.deepEqual(observeShopifyCoupons(ctx, shop, ctx.now, [], order), []);
});

test('phase and role gates apply to the import sink independently of the route used', async () => {
  const { ctx, run, store } = setup();
  const shop = await store('amazon_sp');
  const oldPhase = process.env.SMARTSELL_COMMERCE_PHASE;
  try {
    process.env.SMARTSELL_COMMERCE_PHASE = 'P0a';
    assert.throws(() => prepareImport(ctx, 'order_list', shop.id, {}), { code: 'phase_unavailable' });
    await assert.rejects(store('lazada'), { code: 'phase_unavailable' });
    process.env.SMARTSELL_COMMERCE_PHASE = 'P1';
    ctx.role = 'editor';
    assert.throws(() => prepareImport(ctx, 'order_list', shop.id, {}), { code: 'forbidden' });
    await assert.rejects(run('commerce_store_import', { template_key: 'order_list' }, shop.id), { code: 'forbidden' });
  } finally {
    if (oldPhase == null) delete process.env.SMARTSELL_COMMERCE_PHASE;
    else process.env.SMARTSELL_COMMERCE_PHASE = oldPhase;
  }
});
