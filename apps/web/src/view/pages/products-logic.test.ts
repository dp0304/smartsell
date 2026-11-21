import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attentionText, detailPrompts, filterCounts, initials, listingFor, marketColumns, matchesFilter, ordersOf, priceFlagsInUse, productFlags,
  priceRange, rankedPosts, safeImage, safeLink, salesLines, sortProducts, storeLine, summarize, timelineLanes, timelineWindow, type ProductDetailView, type ProductItem,
} from './products-logic';

const unknown = { value: null, availability: 'not_collected' };
const product = (id: string, values: Partial<ProductItem> = {}): ProductItem => ({
  id, title: id, status: 'active', markets: [], plans: { live: [], upcoming: 0 }, content: { scheduled_next_7d: 0, published_30d: 0, next_scheduled_at: null },
  performance: { views: unknown, engagements: unknown }, sales: { visible: true, currencies: [] }, attention: [], ...values,
});
const market = (status: string) => ({ market_id: `m-${status}`, market_name: status, channel: 'online_store', price: null, stock: { status, quantity: null } });

test('flags: stock only counts while on sale; low or out of stock and server attention all need attention', () => {
  const out = product('out', { markets: [market('in_stock'), market('out_of_stock')] });
  const draftOut = product('draft', { status: 'draft', markets: [market('out_of_stock')] });
  const low = product('low', { markets: [market('low')] });
  const flagged = product('flagged', { attention: [{ kind: 'fact_pending', severity: 'normal', count: 2 }] });
  const live = product('live', { plans: { live: [{ id: 'p1', name: 'Launch', ends_at: null }], upcoming: 0 } });
  assert.deepEqual(productFlags(out), { live: false, out: true, low: false, attention: true });
  assert.deepEqual(productFlags(draftOut), { live: false, out: false, low: false, attention: false });
  assert.equal(productFlags(low).attention, true);
  assert.equal(matchesFilter(flagged, 'attention'), true);
  assert.equal(matchesFilter(flagged, 'out'), false);
  assert.deepEqual(filterCounts([out, draftOut, low, flagged, live]), { all: 5, live: 1, attention: 3, out: 1 });
});

test('sorting puts unknown views and hidden sales after every known value instead of ranking them as zero', () => {
  const a = product('a', { performance: { views: { value: 10, availability: 'observed' } } });
  const b = product('b');
  const c = product('c', { performance: { views: { value: 0, availability: 'observed' } } });
  const d = product('d', { performance: { views: { value: 99, availability: 'estimated' } } });
  assert.deepEqual(sortProducts([b, a, c, d], 'views').map(item => item.id), ['d', 'a', 'c', 'b']);
  assert.deepEqual(sortProducts([b, a, c, d], 'recent').map(item => item.id), ['b', 'a', 'c', 'd']);
  const hidden = product('hidden', { sales: { visible: false } });
  const none = product('none');
  const two = product('two', { sales: { visible: true, currencies: [{ currency: 'TWD', orders: 1, net_minor: 100 }, { currency: 'JPY', orders: 1, net_minor: null }] } });
  assert.equal(ordersOf(hidden), null);
  assert.equal(ordersOf(none), 0);
  assert.equal(ordersOf(two), 2);
  assert.deepEqual(sortProducts([hidden, none, two], 'orders').map(item => item.id), ['two', 'none', 'hidden']);
});

test('summary names the leaders and coverage rather than summing views or orders across products', () => {
  const items = [
    product('tee', { title: 'Tee', performance: { views: { value: 500, availability: 'observed' } }, content: { published_30d: 1 },
      sales: { visible: true, currencies: [{ currency: 'TWD', orders: 3, net_minor: 1500 }] }, plans: { live: [{ id: 'p', name: 'L', ends_at: null }], upcoming: 0 } }),
    product('cap', { title: 'Cap', performance: { views: { value: 50, availability: 'observed' } }, plans: { live: [], upcoming: 2 } }),
    product('mug', { status: 'draft' }),
  ];
  const summary = summarize(items);
  assert.equal(summary.total, 3);
  assert.equal(summary.active, 2);
  assert.equal(summary.draft, 1);
  assert.equal(summary.live, 1);
  assert.equal(summary.upcomingOnly, 1);
  assert.deepEqual(summary.views.leader, { id: 'tee', title: 'Tee', metric: { value: 500, availability: 'observed' } });
  assert.equal(summary.views.known, 2);
  assert.equal(summary.orders.leader?.orders, 3);
  assert.equal(summary.orders.withOrders, 1);
  assert.equal(summary.postsWithoutMetrics, false);

  const blind = summarize([product('x', { sales: { visible: false }, content: { published_30d: 2 }, performance: { views: { value: null, availability: 'no_permission' } } })]);
  assert.equal(blind.views.leader, null);
  assert.equal(blind.views.availability, 'no_permission');
  assert.equal(blind.orders.visible, false);
  assert.equal(blind.postsWithoutMetrics, true);
  assert.equal(summarize([]).views.availability, 'not_collected');
});

test('initials, images and links accept only safe values', () => {
  assert.equal(initials('夏日防曬乳'), '夏日');
  assert.equal(initials('summer tee'), 'ST');
  assert.equal(initials('Cap'), 'CA');
  assert.equal(initials('  '), '?');
  assert.equal(initials('15% 維他命C亮白精華 Vitamin C Bright Serum'), '維他');
  assert.equal(initials('SPF50+ 防曬乳'), 'SP');
  assert.equal(initials('2024'), '20');
  assert.equal(storeLine({ id: 's', name: 'Glow Lab 官方網店（檔案匯入）', provider: 'file_import', status: 'import_only' }, 'zh'), 'Glow Lab 官方網店（檔案匯入）');
  assert.equal(storeLine({ id: 's', name: 'Glow Lab', provider: 'shopify', status: 'active' }, 'zh'), 'Glow Lab · Shopify');
  assert.equal(storeLine(null, 'zh'), '');
  assert.equal(safeImage('https://cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');
  assert.equal(safeImage('/assets/a.png'), '/assets/a.png');
  for (const bad of ['javascript:alert(1)', '//evil.example/a.png', 'data:text/html,x', 42, null]) assert.equal(safeImage(bad), null);
  assert.equal(safeLink('https://instagram.com/p/1'), 'https://instagram.com/p/1');
  assert.equal(safeLink('/calendar'), null);
});

test('attention texts are localized by kind and keep the SKU of a change', () => {
  assert.deepEqual(attentionText({ kind: 'change_event', severity: 'high', title: 'stock_low · 繁體-TEE-R', change_type: 'stock_low' }), ['庫存跌破門檻 · 繁體-TEE-R', 'Stock crossed the low threshold · 繁體-TEE-R', '库存跌破门槛 · 繁體-TEE-R']);
  assert.deepEqual(attentionText({ kind: 'fact_pending', severity: 'normal', count: 2 }), ['2 項商品資訊草稿待審核', '2 product fact drafts await review', '2 项商品信息草稿待审核']);
  assert.deepEqual(attentionText({ kind: 'price_unpublishable', severity: 'normal', count: 1 })[1], 'Price can\'t be used for publishing in 1 market');
  assert.deepEqual(attentionText({ kind: 'new_kind', severity: 'normal', title: 'Server text' }), ['Server text', 'Server text']);
});

const detail: ProductDetailView = {
  id: 'tee', title: 'Tee', status: 'active',
  markets: [
    { market_id: 'tw', market_name: 'Taiwan', channel: 'online_store', price: { min_minor: 1000, max_minor: 1200, currency: 'TWD', publishable: true, stale: false, is_estimate: false }, stock: { status: 'low', quantity: 6 } },
    { market_id: 'jp', market_name: 'Japan', channel: 'online_store', price: null, stock: { status: 'unknown', quantity: null } },
  ],
  variants: [
    { id: 'blue', sku: 'TEE-B', title: 'Blue', listings: [
      { market_id: 'tw', market_name: 'Taiwan', channel: 'online_store', price_minor: 1000, currency: 'TWD', inventory_quantity: 5, publishable: true },
      { market_id: 'jp', market_name: 'Japan', channel: 'online_store', price_minor: null, currency: null, inventory_quantity: null, publishable: false },
      { market_id: 'jp', market_name: 'Japan', channel: 'marketplace', price_minor: 900, currency: 'JPY', inventory_quantity: null, is_estimate: true, publishable: false, stale: true },
    ] },
    { id: 'red', sku: 'TEE-R', title: 'Red', listings: [{ market_id: 'tw', market_name: 'Taiwan', channel: 'online_store', price_minor: 1200, currency: 'TWD', inventory_quantity: 1, publishable: true }] },
  ],
  plans: [
    { id: 'launch', name: 'Launch', status: 'active', starts_at: '2026-11-14T16:00:00.000Z', ends_at: '2026-11-28T16:00:00.000Z' },
    { id: 'next', name: 'Next', status: 'planned', starts_at: null, ends_at: null },
  ],
  timeline: [
    { at: '2026-11-21T08:00:00.000Z', kind: 'publish', title: 'Teaser', status: 'scheduled', resource: { type: 'publish_target', id: 't1' } },
    { at: '2026-11-17T08:00:00.000Z', kind: 'post', title: null, status: 'live', resource: { type: 'platform_post', id: 'p1' } },
    { at: '2026-11-18T06:00:00.000Z', kind: 'change', title: 'stock_low', status: 'open', resource: { type: 'change_event', id: 'c1' } },
    { at: '2025-01-01T00:00:00.000Z', kind: 'change', title: 'price_changed', status: 'resolved', resource: { type: 'change_event', id: 'c0' } },
  ],
  posts: [
    { platform_post_id: 'p1', platform: 'instagram', permalink: 'https://instagram.com/p/1', published_at: '2026-11-17T08:00:00.000Z', title: 'Teaser', metrics: { views: { value: 500, availability: 'observed' }, engagements: unknown } },
    { platform_post_id: 'p2', platform: 'tiktok', permalink: null, published_at: '2026-11-18T08:00:00.000Z', title: 'Clip', metrics: { views: unknown, engagements: unknown } },
  ],
  content: { scheduled_next_7d: 1, published_30d: 2, next_scheduled_at: '2026-11-21T08:00:00.000Z' },
  attention: [{ kind: 'localization_stale', severity: 'high', count: 1 }],
};

test('market columns join summaries and listings, naming the channel only where it disambiguates', () => {
  const columns = marketColumns(detail.markets, detail.variants);
  assert.deepEqual(columns.map(column => [column.market_id, column.channel, column.showChannel]), [['tw', 'online_store', false], ['jp', 'online_store', true], ['jp', 'marketplace', true]]);
  assert.equal(listingFor(detail.variants![1]!, columns[1]!), undefined);
  assert.equal(listingFor(detail.variants![0]!, columns[2]!)?.price_minor, 900);
  // An unpriced listing (Japan online store) is not an unpublishable price; the estimated marketplace price is.
  assert.deepEqual(priceFlagsInUse(detail.markets, detail.variants), { estimate: true, stale: true, unpublishable: true });
  assert.deepEqual(priceFlagsInUse(detail.markets, detail.variants!.slice(1)), { estimate: false, stale: false, unpublishable: false });
});

test('timeline lanes: one per dated plan, then publications, posts and changes; the window stretches to cover them', () => {
  const { lanes, spans, undatedPlans } = timelineLanes(detail, { lang: 'zh', timeZone: 'Asia/Taipei', planHref: id => `/plans/${id}`, entryHref: entry => entry.kind === 'post' ? 'https://instagram.com/p/1' : undefined });
  assert.deepEqual(lanes.map(lane => lane.id), ['plan:launch', 'publish', 'post', 'change']);
  assert.equal(undatedPlans, 1);
  assert.deepEqual(lanes[0]!.items[0], { id: 'launch', label: 'Launch', start: '2026-11-14T16:00:00.000Z', end: '2026-11-28T16:00:00.000Z', status: 'active', href: '/plans/launch' });
  assert.equal(lanes[2]!.items[0]!.label, '未命名的貼文');
  assert.equal(lanes[2]!.items[0]!.href, 'https://instagram.com/p/1');
  assert.deepEqual(lanes[3]!.items.map(item => item.label), ['庫存跌破門檻', '價格變動']);
  assert.deepEqual(spans[0], { start: '2026-11-15', end: '2026-11-29' });
  const window = timelineWindow('2026-11-20', spans);
  assert.deepEqual(window, { from: '2026-10-21', to: '2026-12-20', hidden: 1 });
  assert.deepEqual(timelineWindow('2026-11-20', [{ start: '2026-08-01', end: '2027-09-01' }]), { from: '2026-08-01', to: '2027-05-19', hidden: 0 });
});

test('posts with unknown views are unranked and prompts follow what the product is missing', () => {
  assert.deepEqual(rankedPosts(detail.posts).ranked.map(post => post.platform_post_id), ['p1']);
  assert.equal(rankedPosts(detail.posts).unranked, 1);
  assert.deepEqual(detailPrompts(detail), ['resync', 'metrics', 'localize', 'plan']);
  assert.deepEqual(detailPrompts({ id: 'x', title: 'X', status: 'draft' }), ['plan', 'prices', 'posts']);
});

test('price ranges and recorded sales are formatted from *_minor and never invent an amount', () => {
  assert.equal(priceRange({ min_minor: 100000, max_minor: 120000, currency: 'TWD' }, 'en'), 'NT$1,000 – NT$1,200');
  assert.equal(priceRange({ min_minor: 990, max_minor: 990, currency: 'JPY' }, 'en'), 'JP¥990');
  assert.equal(priceRange({ min_minor: 990, max_minor: 990, currency: null }, 'en'), null);
  assert.equal(priceRange(null, 'zh'), null);
  assert.deepEqual(salesLines({ visible: true, currencies: [{ currency: 'TWD', orders: 3, net_minor: 150000 }, { currency: 'USD', orders: 1, net_minor: null }, { currency: 'JPY', orders: 0, net_minor: 0 }] }, 'en'),
    ['3 orders · NT$1,500', '1 order · USD amount unknown']);
  assert.deepEqual(salesLines({ visible: false }, 'zh'), []);
});
