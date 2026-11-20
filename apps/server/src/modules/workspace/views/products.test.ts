import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Context, type Data, type Input, type Role, type Row } from '@smartsell/contracts';
import { productsViewOperations } from './products.js';

const now = '2026-11-19T08:00:00.000Z';
const hours = (n: number) => new Date(Date.parse(now) + n * 3_600_000).toISOString();
type Card = Data & { id: string; markets: Data[]; attention: Data[]; plans: Data; content: Data; performance: Data; sales: Data };

function seed() {
  const rows = new Map<string, Row[]>();
  let seq = 0;
  const ctx: Context = {
    workspaceId: 'w1', tenantId: 't1', actorId: 'me', role: 'owner', now,
    list: kind => rows.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Missing row');
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: `${kind}-${++seq}`, version: 1, created_at: now, updated_at: now };
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, patch) {
      const row = { ...ctx.get(kind, id), ...patch, id, updated_at: now };
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? row : item));
      return row;
    },
    remove(kind, id) { rows.set(kind, ctx.list(kind).filter(item => item.id !== id)); },
    emit() {},
  };
  const add = (kind: string, values: Data) => ctx.create(kind, values);
  function run<T = Card[]>(name: string, input: Partial<Input> = {}, role: Role = 'owner') {
    const op = productsViewOperations.find(item => item.name === name)!;
    assert.ok(op.roles.includes(role));
    return op.run({ ...ctx, role }, { body: {}, params: {}, query: {}, ...input }) as T;
  }

  const brand = add('brand', { name: 'Brand', slug: 'brand', status: 'active' });
  const other = add('brand', { name: 'Other', slug: 'other', status: 'active' });
  const tw = add('market', { brand_id: brand.id, name: 'Taiwan', currency: 'TWD', status: 'active' });
  const jp = add('market', { brand_id: brand.id, name: 'Japan', currency: 'JPY', status: 'active' });
  const store = add('store', { brand_id: brand.id, name: 'Shop', provider: 'shopify', status: 'active', default_currency: 'TWD' });
  for (const market of [tw, jp]) add('store_market', { store_id: store.id, market_id: market.id, channel: 'online_store', enabled: true, snapshot_ttl_minutes: 1440, price_source: 'store_market_price' });
  const tee = add('product', { store_id: store.id, brand_id: brand.id, title: 'Tee', handle: 'tee', status: 'active', created_via: 'agent' });
  const blue = add('product_variant', { product_id: tee.id, store_id: store.id, sku: 'TEE-B', options: { color: 'Blue' }, status: 'active' });
  const red = add('product_variant', { product_id: tee.id, store_id: store.id, sku: 'TEE-R', options: { color: 'Red' }, status: 'active' });
  const listing = (variant: Row, market: Row, values: Data) => add('listing_snapshot', { variant_id: variant.id, market_id: market.id, channel: 'online_store', is_current: true,
    is_estimate: false, price_source: 'store_market_price', observed_at: hours(-1), price_observed_at: hours(-1), ...values });
  listing(blue, tw, { price_amount_minor: 1000, currency: 'TWD', availability: 'observed', inventory_status: 'in_stock', inventory_quantity: 5 });
  listing(red, tw, { price_amount_minor: 1200, currency: 'TWD', availability: 'observed', inventory_status: 'low', inventory_quantity: 1 });
  listing(blue, jp, { price_amount_minor: null, currency: null, availability: 'not_collected', inventory_status: 'unknown', inventory_quantity: null });
  listing(red, tw, { is_current: false, price_amount_minor: 1, currency: 'TWD', availability: 'observed', inventory_status: 'out_of_stock', inventory_quantity: 0 });
  const cap = add('product', { store_id: store.id, brand_id: brand.id, title: 'Cap', status: 'active' });
  add('product_variant', { product_id: cap.id, store_id: store.id, sku: 'CAP-1', status: 'active' });
  const foreign = add('product', { store_id: 'store-x', brand_id: other.id, title: 'Other tee', status: 'active' });

  add('change_event', { product_id: tee.id, variant_id: red.id, market_id: tw.id, change_type: 'stock_low', severity: 'review', status: 'open', detected_at: hours(-2) });
  add('change_event', { product_id: tee.id, change_type: 'price_changed', severity: 'review', status: 'resolved', detected_at: hours(-50) });
  const fact = add('product_fact', { product_id: tee.id, brand_id: brand.id, fact_key: 'material', category: 'spec', status: 'active' });
  const draft = add('product_fact_revision', { fact_id: fact.id, review_status: 'draft', revision_no: 1 });
  ctx.update('product_fact', fact.id, { current_revision_id: draft.id });
  add('product_localization', { product_id: tee.id, field_key: 'title', locale: 'ja-JP', status: 'stale' });

  const launch = add('campaign', { brand_id: brand.id, name: 'Launch', kind: 'launch', status: 'active', timezone: 'Asia/Taipei', starts_at: '2026-11-14T16:00:00.000Z', ends_at: '2026-11-28T16:00:00.000Z' });
  const next = add('campaign', { brand_id: brand.id, name: 'Next', kind: 'seasonal', status: 'planned', timezone: 'UTC', starts_at: null, ends_at: null });
  for (const campaign of [launch, next]) add('campaign_product', { campaign_id: campaign.id, product_id: tee.id, role: 'hero', variant_ids: null, market_ids: null });

  const account = add('social_account', { brand_id: brand.id, provider: 'instagram', display_name: 'Brand IG' });
  const item = add('content_item', { brand_id: brand.id, campaign_id: launch.id, title: 'Teaser', production_stage: 'ready' });
  const variant = add('content_variant', { content_item_id: item.id, platform: 'instagram', format: 'feed_image' });
  const revision = add('content_revision', { variant_id: variant.id });
  add('content_reference', { revision_id: revision.id, ref_type: 'product_variant', ref_id: blue.id });
  const target = (values: Data) => add('publish_target', { brand_id: brand.id, campaign_id: launch.id, content_item_id: item.id, content_variant_id: variant.id, social_account_id: account.id, ...values });
  const published = target({ plan_status: 'closed', close_reason: 'published', scheduled_at: hours(-48) });
  const upcoming = target({ plan_status: 'ready', scheduled_at: hours(48) });
  const review = add('content_item', { brand_id: brand.id, title: 'Review', production_stage: 'draft' });
  const later = target({ content_item_id: review.id, campaign_id: null, plan_status: 'awaiting_approval', scheduled_at: hours(240) });
  add('publish_target_ref', { publish_target_id: later.id, ref_type: 'product_variant', ref_id: red.id });
  const post = add('platform_post', { publish_target_id: published.id, social_account_id: account.id, provider: 'instagram', published_at: hours(-48), permalink: 'https://instagram.com/p/1', verification: 'system_verified' });
  add('metric_observation', { subject_type: 'platform_post', subject_id: post.id, metric_key: 'norm.post.views', value: 500, availability: 'observed', period_kind: 'lifetime', observed_at: hours(-1), platform: 'instagram' });

  const order = add('order', { store_id: store.id, currency: 'TWD', total_minor: 2000, placed_at: hours(-24) });
  add('order_line', { order_id: order.id, variant_id: blue.id, quantity: 1 });
  add('refund', { order_id: order.id, status: 'succeeded', amount_minor: 500 });
  add('refund', { order_id: order.id, status: 'pending', amount_minor: 1000 });
  return { ctx, run, brand, other, tw, jp, store, tee, blue, red, cap, foreign, launch, next, post, upcoming, later };
}

const find = (cards: Card[], id: string) => cards.find(card => card.id === id)!;
const status = (code: number) => (reason: unknown) => reason instanceof Problem && reason.status === code;

test('product cards summarize market prices and stock without turning unknowns into zero', () => {
  const { run, brand, tw, jp, store, tee, cap, launch, next, upcoming } = seed();
  const cards = run('views_products_list', { query: { brand_id: brand.id } });
  assert.deepEqual(cards.map(card => card.id).sort(), [tee.id, cap.id].sort());
  const card = find(cards, tee.id);
  assert.deepEqual(card.store, { id: store.id, name: 'Shop', provider: 'shopify', status: 'active' });
  assert.deepEqual(card.variants, { total: 2, active: 2 });
  const [taiwan, japan] = [tw, jp].map(market => card.markets.find(row => row.market_id === market.id)!);
  assert.deepEqual(taiwan.price, { min_minor: 1000, max_minor: 1200, currency: 'TWD', publishable: true, stale: false, is_estimate: false, observed_at: hours(-1) });
  assert.deepEqual(taiwan.stock, { status: 'low', quantity: 6, availability: 'observed', variants_observed: 2, variants_total: 2 });
  assert.equal(japan.market_name, 'Japan');
  assert.equal(japan.price, null);
  assert.deepEqual(japan.stock, { status: 'unknown', quantity: null, availability: 'not_collected', variants_observed: 0, variants_total: 2 });
  assert.deepEqual(card.plans, { live: [{ id: launch.id, name: 'Launch', status: 'active', ends_at: launch.ends_at }], upcoming: 1 });
  assert.notEqual(next.id, launch.id);
  assert.deepEqual(card.content, { scheduled_next_7d: 1, published_30d: 1, next_scheduled_at: upcoming.scheduled_at });
  assert.deepEqual(card.performance, { views: { value: 500, availability: 'observed' }, engagements: { value: null, availability: 'not_collected' } });
  assert.deepEqual(card.sales, { visible: true, coverage: 'recorded_only', currencies: [{ currency: 'TWD', orders: 1, net_minor: 1500 }] });
  assert.deepEqual(card.attention.map(item => [item.kind, item.severity]), [['change_event', 'high'], ['localization_stale', 'high'], ['fact_pending', 'normal']]);
  assert.equal(card.attention[0]!.title, 'stock_low · TEE-R');
  assert.equal(card.created_via, 'agent');
  assert.equal(card.as_of, '2026-11-19T08:00:00.000Z');

  const blank = find(cards, cap.id);
  assert.ok(blank.markets.length === 2 && blank.markets.every(market => market.price === null && (market.stock as Data).quantity === null && (market.stock as Data).status === 'unknown'));
  assert.deepEqual(blank.performance, { views: { value: null, availability: 'not_collected' }, engagements: { value: null, availability: 'not_collected' } });
  assert.deepEqual(blank.content, { scheduled_next_7d: 0, published_30d: 0, next_scheduled_at: null });
  assert.deepEqual(blank.sales, { visible: true, coverage: 'recorded_only', currencies: [] });
  assert.deepEqual(blank.attention, []);
  assert.equal(blank.created_via, null);
});

test('product filters run on the server and sales are hidden from roles without order access', () => {
  const { run, brand, other, store, tee, cap, foreign } = seed();
  assert.deepEqual(run('views_products_list', { query: { brand_id: other.id } }).map(card => card.id), [foreign.id]);
  assert.throws(() => run('views_products_list', { query: { brand_id: 'missing' } }), status(404));
  assert.deepEqual(run('views_products_list', { query: { q: 'tee-r' } }).map(card => card.id), [tee.id]);
  assert.deepEqual(run('views_products_list', { query: { brand_id: brand.id, attention: 'true' } }).map(card => card.id), [tee.id]);
  assert.deepEqual(run('views_products_list', { query: { store_id: store.id, q: 'cap' } }).map(card => card.id), [cap.id]);
  for (const role of ['viewer', 'editor', 'reviewer', 'agent'] as const) {
    assert.deepEqual(find(run('views_products_list', {}, role), tee.id).sales, { visible: false });
  }
  assert.equal((find(run('views_products_list', {}, 'analyst'), tee.id).sales as Data).visible, true);
});

test('an unpublishable listing price is surfaced as attention on an active product', () => {
  const { ctx, run, tee } = seed();
  const listing = ctx.list('listing_snapshot').find(row => row.is_current && row.price_amount_minor === 1200)!;
  ctx.update('listing_snapshot', listing.id, { is_estimate: true, price_source: 'fx_estimate' });
  const card = find(run('views_products_list'), tee.id);
  const taiwan = card.markets.find(market => market.price)!;
  assert.deepEqual([(taiwan.price as Data).publishable, (taiwan.price as Data).is_estimate], [false, true]);
  assert.ok(card.attention.some(item => item.kind === 'price_unpublishable' && item.count === 1));
});

test('product detail adds variant listings, a promotion timeline, ranked posts and plan cards', () => {
  const { run, tee, blue, red, jp, post, launch, next } = seed();
  const detail = run<Card & { variants: Data[]; timeline: Data[]; posts: Data[]; plans: Data[] }>('views_product_get', { params: { id: tee.id } });
  assert.equal(detail.id, tee.id);
  assert.deepEqual(detail.variants.map(row => [row.id, row.sku, row.title, (row.listings as Data[]).length]), [[blue.id, 'TEE-B', 'Blue', 2], [red.id, 'TEE-R', 'Red', 1]]);
  const japan = (detail.variants[0]!.listings as Data[]).find(row => row.market_id === jp.id)!;
  assert.deepEqual([japan.price_minor, japan.inventory_quantity, japan.availability, japan.publishable], [null, null, 'not_collected', false]);
  assert.deepEqual(new Set(detail.timeline.map(row => row.kind)), new Set(['plan', 'publish', 'post', 'change', 'fact']));
  assert.ok(detail.timeline.every((row, i, all) => i === 0 || String(all[i - 1]!.at) >= String(row.at)));
  assert.deepEqual(detail.posts, [{ platform_post_id: post.id, social_account_id: post.social_account_id, platform: 'instagram', permalink: 'https://instagram.com/p/1',
    published_at: post.published_at, title: 'Teaser', campaign_id: launch.id, metrics: { views: { value: 500, availability: 'observed' }, engagements: { value: null, availability: 'not_collected' } } }]);
  assert.deepEqual(detail.plans.map(plan => plan.id).sort(), [launch.id, next.id].sort());
  assert.ok(detail.plans.every(plan => 'matrix' in plan && 'needs_decision' in plan));
  assert.throws(() => run('views_product_get', { params: { id: 'missing' } }), status(404));
});
