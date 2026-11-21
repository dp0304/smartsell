import { Problem, READ, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { compareMetrics, metricQueryInput } from '../../analytics/metrics.js';
import { phase } from '../../commerce/domain.js';
import { isEstimatedPrice, listingPriceState } from '../../commerce/listings.js';
import { brandScope } from '../shared.js';
import { displayStatus, executionIndex, planCards } from './campaigns.js';

// Read-model for the agent-first web view. Contract: docs/agent-first-design.md 3.2.
const DAY = 86_400_000;
const WINDOW_DAYS = 30;
// Mirrors ORDER_READ in commerce/trade-operations.ts, which is not exported.
const ORDER_READ = ['owner', 'admin', 'manager', 'analyst'];
const LIVE = ['active', 'paused', 'wrapping'];
const UPCOMING = ['draft', 'planned'];
const CLOSED_TARGET = ['cancelled', 'superseded', 'closed', 'cancel_requested'];
const KNOWN_STOCK = ['in_stock', 'low', 'out_of_stock'];
const METRICS = { views: 'norm.post.views', engagements: 'norm.post.engagements' } as const;
const severities: Record<string, string> = { blocking: 'blocker', review: 'high', info: 'normal' };

export type Metric = { value: number | null; availability: string };
type PostMetrics = Record<keyof typeof METRICS, Metric>;

/** Memoizes table reads for one read-only request so composed helpers do not re-read whole kinds. */
export function snapshot(ctx: Context): Context {
  const cache = new Map<string, Row[]>();
  return { ...ctx, list(kind) {
    let rows = cache.get(kind);
    if (!rows) cache.set(kind, rows = ctx.list(kind));
    return [...rows];
  } };
}
export const createdVia = (row: Data) => row.created_via === 'agent' || row.created_via === 'human' ? row.created_via : null;
export const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
export const group = <T>(items: T[], key: (item: T) => unknown) => {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    if (typeof id !== 'string') continue;
    const list = map.get(id);
    if (list) list.push(item); else map.set(id, [item]);
  }
  return map;
};
const byId = (rows: Row[]) => new Map(rows.map(row => [row.id, row]));

/** Product, variant and listing lookups shared by product and plan cards. */
export function catalogIndex(ctx: Context) {
  const products = byId(ctx.list('product'));
  const variants = group(ctx.list('product_variant'), row => row.product_id);
  const listings = group(ctx.list('listing_snapshot').filter(row => row.is_current === true), row => row.variant_id);
  return { products, variants, listings, configs: group(ctx.list('store_market'), row => row.store_id), markets: byId(ctx.list('market')), stores: byId(ctx.list('store')) };
}
export type CatalogIndex = ReturnType<typeof catalogIndex>;
export const activeVariants = (index: CatalogIndex, productId: string) => (index.variants.get(productId) ?? []).filter(row => row.status !== 'archived');

/** Combines variant stock observations; a variant without an observed listing never counts as in or out of stock. */
export function stockSummary(listings: (Row | undefined)[]) {
  const observed = listings.filter((row): row is Row => row?.availability === 'observed');
  const known = observed.filter(row => KNOWN_STOCK.includes(String(row.inventory_status))).map(row => String(row.inventory_status));
  const status = !known.length ? (listings.length && observed.length === listings.length && observed.every(row => row.inventory_status === 'not_tracked') ? 'not_tracked' : 'unknown')
    : known.every(value => value === 'out_of_stock') ? 'out_of_stock' : known.some(value => value !== 'in_stock') ? 'low' : 'in_stock';
  const quantities = listings.map(row => row?.availability === 'observed' && Number.isSafeInteger(row.inventory_quantity) ? Number(row.inventory_quantity) : null);
  const gap = listings.findIndex(row => row?.availability !== 'observed');
  return {
    status, quantity: listings.length && quantities.every(value => value !== null) ? quantities.reduce((sum, value) => sum! + value!, 0) : null,
    availability: !listings.length ? 'not_collected' : gap === -1 ? 'observed' : String(listings[gap]?.availability ?? 'not_collected'),
    variants_observed: observed.length, variants_total: listings.length,
  };
}

function marketSummaries(ctx: Context, index: CatalogIndex, product: Row) {
  const variants = activeVariants(index, product.id);
  const configs = (index.configs.get(String(product.store_id)) ?? []).filter(row => row.enabled === true);
  const keys = new Map<string, { market_id: unknown; channel: unknown }>();
  for (const row of [...configs, ...variants.flatMap(variant => index.listings.get(variant.id) ?? [])]) keys.set(JSON.stringify([row.market_id, row.channel]), { market_id: row.market_id, channel: row.channel });
  return [...keys.values()].map(({ market_id, channel }) => {
    const config = configs.find(row => row.market_id === market_id && row.channel === channel);
    const market = index.markets.get(String(market_id));
    const pairs = variants.map(variant => ({ variant, listing: (index.listings.get(variant.id) ?? []).find(row => row.market_id === market_id && row.channel === channel) }));
    const priced = pairs.filter((pair): pair is { variant: Row; listing: Row } => !!pair.listing && Number.isSafeInteger(pair.listing.price_amount_minor));
    const currencies = [...new Set(priced.map(pair => pair.listing.currency))];
    const currency = currencies.includes(market?.currency) ? market!.currency : currencies[0];
    const same = priced.filter(pair => pair.listing.currency === currency);
    const amounts = same.map(pair => Number(pair.listing.price_amount_minor));
    const states = same.map(pair => listingPriceState(pair.listing, pair.variant, product, config, ctx.now));
    return {
      market_id, market_name: market?.name ?? null, channel,
      price: same.length ? { min_minor: Math.min(...amounts), max_minor: Math.max(...amounts), currency,
        publishable: states.every(state => state.publishable_price), stale: states.some(state => state.stale || state.price_stale),
        is_estimate: same.some(pair => isEstimatedPrice(pair.listing)), observed_at: same.map(pair => String(pair.listing.price_observed_at ?? pair.listing.observed_at)).sort().at(-1) ?? null } : null,
      stock: stockSummary(pairs.map(pair => pair.listing)),
    };
  });
}

/** Per-post views and engagements from Analytics; posts without observations stay unknown. */
export function postMetrics(ctx: Context, postIds: Set<string>, from: number, to: number): (id: string) => PostMetrics {
  const unknown = (availability = 'not_collected'): PostMetrics => ({ views: { value: null, availability }, engagements: { value: null, availability } });
  const found = new Map<string, PostMetrics>();
  let fallback = unknown();
  if (postIds.size) {
    const keys = Object.values(METRICS) as string[];
    const observations = ctx.list('metric_observation').filter(row => row.subject_type === 'platform_post' && postIds.has(String(row.subject_id)) && keys.includes(String(row.metric_key)));
    try {
      const result = compareMetrics(ctx, metricQueryInput(ctx, { metrics: keys, subject: { type: 'platform_post' }, group_by: ['subject_id'],
        time: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), tz: 'UTC', basis: 'published_at' } }), undefined, observations);
      for (const row of result.rows) {
        const cell = (key: string): Metric => {
          const value = row.values[key] as Data | undefined;
          return { value: typeof value?.value === 'number' ? value.value : null, availability: String(value?.availability ?? 'not_collected') };
        };
        found.set(row.group.subject_id!, { views: cell(METRICS.views), engagements: cell(METRICS.engagements) });
      }
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      fallback = unknown(error.status === 403 ? 'no_permission' : 'sync_failed');
    }
  }
  return id => found.get(id) ?? fallback;
}
/** Sums known values the way Analytics does; an all-unknown or empty set stays null. */
export function sumMetric(cells: Metric[]): Metric {
  const known = cells.filter(cell => cell.value !== null && (cell.availability === 'observed' || cell.availability === 'estimated'));
  if (!known.length) {
    const first = cells[0]?.availability;
    return { value: null, availability: first && cells.every(cell => cell.availability === first) ? first : 'not_collected' };
  }
  return { value: known.reduce((sum, cell) => sum + cell.value!, 0), availability: known.some(cell => cell.availability === 'estimated') ? 'estimated' : 'observed' };
}

/** Request-scoped joins from products to campaigns, publications, posts, attention and orders. */
function productContext(ctx: Context, index: CatalogIndex) {
  const variantProduct = new Map<string, string>();
  for (const [productId, rows] of index.variants) for (const row of rows) variantProduct.set(row.id, productId);
  const snapshots = new Map(ctx.list('listing_snapshot').map(row => [row.id, row.variant_id]));
  const facts = byId(ctx.list('product_fact'));
  const factRevisions = byId(ctx.list('product_fact_revision'));
  const refProduct = (type: unknown, id: unknown): string | undefined => {
    if (type === 'product') return typeof id === 'string' ? id : undefined;
    if (type === 'product_variant') return variantProduct.get(String(id));
    if (type === 'listing_snapshot') return variantProduct.get(String(snapshots.get(String(id))));
    if (type === 'product_fact_revision') return facts.get(String(factRevisions.get(String(id))?.fact_id))?.product_id as string | undefined;
  };
  const targets = byId(ctx.list('publish_target'));
  const targetsByItem = group([...targets.values()], row => row.content_item_id);
  const productTargets = new Map<string, Set<string>>();
  const link = (productId: string | undefined, targetId: string) => {
    if (!productId || !targets.has(targetId)) return;
    const set = productTargets.get(productId) ?? new Set<string>();
    productTargets.set(productId, set.add(targetId));
  };
  for (const ref of ctx.list('publish_target_ref')) {
    link(refProduct(ref.ref_type, ref.ref_id), String(ref.publish_target_id));
    if (ref.listing_snapshot_id) link(refProduct('listing_snapshot', ref.listing_snapshot_id), String(ref.publish_target_id));
  }
  // Content references bind a product to a revision; every publication of that content item features it.
  const revisions = byId(ctx.list('content_revision'));
  const contentVariants = byId(ctx.list('content_variant'));
  for (const ref of ctx.list('content_reference')) {
    const productId = refProduct(ref.ref_type, ref.ref_id);
    const item = contentVariants.get(String(revisions.get(String(ref.revision_id))?.variant_id))?.content_item_id;
    for (const target of targetsByItem.get(String(item)) ?? []) link(productId, target.id);
  }
  const posts = ctx.list('platform_post');
  const postsByTarget = group(posts, row => row.publish_target_id);
  const campaigns = byId(ctx.list('campaign'));
  const links = group(ctx.list('campaign_product'), row => row.product_id);
  const changes = group(ctx.list('change_event').filter(row => row.status === 'open'), row => row.product_id);
  const pendingFacts = group([...facts.values()].filter(row => row.status === 'active' && factRevisions.get(String(row.current_revision_id))?.review_status === 'draft'), row => row.product_id);
  const staleLocalizations = group(ctx.list('product_localization').filter(row => row.status === 'stale'), row => row.product_id);
  return { targets, productTargets, postsByTarget, campaigns, links, changes, pendingFacts, staleLocalizations, factRevisions, variantProduct,
    postsFor(productId: string) {
      return [...new Map([...productTargets.get(productId) ?? []].flatMap(id => postsByTarget.get(id) ?? []).map(row => [row.id, row])).values()];
    } };
}
type ProductContext = ReturnType<typeof productContext>;

function salesIndex(ctx: Context, from: number) {
  if (!ORDER_READ.includes(ctx.role) || ['p0a', 'p0b'].includes(phase(ctx))) return undefined;
  const orders = byId(ctx.list('order').filter(row => time(row.placed_at) >= from));
  const refunds = new Map<string, number | null>();
  for (const row of ctx.list('refund')) {
    if (row.status !== 'succeeded') continue;
    const prior = refunds.get(String(row.order_id)) ?? 0;
    refunds.set(String(row.order_id), prior === null || !Number.isSafeInteger(row.amount_minor) ? null : prior + Number(row.amount_minor));
  }
  const lines = group(ctx.list('order_line'), row => row.variant_id);
  return (variantIds: string[]) => {
    const ids = new Set(variantIds.flatMap(id => (lines.get(id) ?? []).map(line => String(line.order_id))));
    const totals = new Map<string, { currency: string; orders: number; net_minor: number | null }>();
    for (const id of ids) {
      const order = orders.get(id);
      if (!order) continue;
      const currency = String(order.currency);
      const entry = totals.get(currency) ?? { currency, orders: 0, net_minor: 0 };
      const refunded = refunds.get(id) ?? 0;
      entry.orders++;
      // An order with an unreadable amount makes the currency total unknown rather than understated.
      entry.net_minor = entry.net_minor === null || refunded === null || !Number.isSafeInteger(order.total_minor) ? null : entry.net_minor + Number(order.total_minor) - refunded;
      totals.set(currency, entry);
    }
    return { visible: true, coverage: 'recorded_only', currencies: [...totals.values()] };
  };
}

function attention(product: Row, links: ProductContext, markets: ReturnType<typeof marketSummaries>, index: CatalogIndex) {
  const skus = new Map(activeVariants(index, product.id).map(row => [row.id, row.sku]));
  const items: Data[] = (links.changes.get(product.id) ?? []).map(row => ({ kind: 'change_event', severity: severities[String(row.severity)] ?? 'normal',
    title: [row.change_type, skus.get(String(row.variant_id))].filter(Boolean).join(' · '), change_type: row.change_type, resource: { type: 'change_event', id: row.id } }));
  const facts = links.pendingFacts.get(product.id)?.length ?? 0;
  if (facts) items.push({ kind: 'fact_pending', severity: 'normal', title: `${facts} product fact draft(s) await review`, count: facts });
  const stale = links.staleLocalizations.get(product.id)?.length ?? 0;
  if (stale) items.push({ kind: 'localization_stale', severity: 'high', title: `${stale} localization(s) are stale`, count: stale });
  const unpublishable = markets.filter(market => market.price && !market.price.publishable).length;
  if (product.status === 'active' && unpublishable) items.push({ kind: 'price_unpublishable', severity: 'normal', title: `Price cannot be published in ${unpublishable} market(s)`, count: unpublishable });
  const rank: Record<string, number> = { blocker: 0, high: 1, normal: 2 };
  return items.sort((a, b) => rank[String(a.severity)]! - rank[String(b.severity)]!);
}

function productCard(ctx: Context, product: Row, index: CatalogIndex, links: ProductContext, metrics: (id: string) => PostMetrics, sales: ReturnType<typeof salesIndex>) {
  const now = time(ctx.now);
  const from = now - WINDOW_DAYS * DAY;
  const store = index.stores.get(String(product.store_id));
  const all = index.variants.get(product.id) ?? [];
  const markets = marketSummaries(ctx, index, product);
  const campaigns = (links.links.get(product.id) ?? []).flatMap(link => links.campaigns.get(String(link.campaign_id)) ?? []);
  const targets = [...links.productTargets.get(product.id) ?? []].flatMap(id => links.targets.get(id) ?? []);
  const upcoming = targets.filter(row => !CLOSED_TARGET.includes(String(row.plan_status)) && time(row.scheduled_at) >= now).sort((a, b) => time(a.scheduled_at) - time(b.scheduled_at));
  const recent = links.postsFor(product.id).filter(row => time(row.published_at) >= from && time(row.published_at) <= now);
  return {
    id: product.id, title: product.title ?? null, status: product.status ?? null, brand_id: product.brand_id ?? null,
    image_url: typeof product.image_url === 'string' ? product.image_url : null, primary_asset_id: product.primary_asset_id ?? null,
    store: store ? { id: store.id, name: store.name ?? null, provider: store.provider ?? null, status: store.status ?? null } : null,
    variants: { total: all.length, active: activeVariants(index, product.id).length },
    markets,
    plans: { live: campaigns.filter(row => LIVE.includes(String(row.status))).map(row => ({ id: row.id, name: row.name, status: row.status, ends_at: row.ends_at ?? null })),
      upcoming: campaigns.filter(row => UPCOMING.includes(String(row.status))).length },
    content: { scheduled_next_7d: upcoming.filter(row => time(row.scheduled_at) < now + 7 * DAY).length, published_30d: recent.length,
      next_scheduled_at: upcoming[0]?.scheduled_at ?? null },
    performance: { views: sumMetric(recent.map(row => metrics(row.id).views)), engagements: sumMetric(recent.map(row => metrics(row.id).engagements)) },
    sales: sales ? sales(all.map(row => row.id)) : { visible: false },
    attention: attention(product, links, markets, index),
    period: { from: new Date(from).toISOString(), to: ctx.now },
    created_via: createdVia(product), as_of: ctx.now,
  };
}

function cards(ctx: Context, products: Row[], postWindow: number) {
  const index = catalogIndex(ctx);
  const links = productContext(ctx, index);
  const posts = new Set(products.flatMap(product => links.postsFor(product.id).map(row => row.id)));
  const metrics = postMetrics(ctx, posts, postWindow, time(ctx.now) + 1);
  const sales = salesIndex(ctx, time(ctx.now) - WINDOW_DAYS * DAY);
  return { index, links, metrics, cards: products.map(product => productCard(ctx, product, index, links, metrics, sales)) };
}

function listProducts(raw: Context, { query }: Input) {
  const ctx = snapshot(raw);
  const brand = brandScope(ctx, query.brand_id);
  const search = query.q?.trim().toLowerCase();
  const skus = search ? group(ctx.list('product_variant'), row => row.product_id) : undefined;
  const products = ctx.list('product').filter(row => (brand === undefined || row.brand_id === brand) && (!query.store_id || row.store_id === query.store_id) &&
    (!query.status || row.status === query.status) &&
    (!search || [row.title, row.handle, ...(skus!.get(row.id) ?? []).map(variant => variant.sku)].some(value => typeof value === 'string' && value.toLowerCase().includes(search))))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  const result = cards(ctx, products, time(ctx.now) - WINDOW_DAYS * DAY).cards;
  return query.attention === 'true' ? result.filter(card => card.attention.length) : result;
}

function productDetail(raw: Context, { params }: Input) {
  const ctx = snapshot(raw);
  const product = ctx.get('product', params.id!);
  // Detail posts cover the longest period Analytics accepts.
  const { index, links, metrics, cards: [card] } = cards(ctx, [product], time(ctx.now) - 3 * 365 * DAY);
  const execution = executionIndex(ctx);
  const accounts = byId(ctx.list('social_account'));
  const items = byId(ctx.list('content_item'));
  const variants = index.variants.get(product.id) ?? [];
  const targetTitle = (row: Row | undefined) => row?.title ?? items.get(String(row?.content_item_id))?.title ?? null;
  const postRows = links.postsFor(product.id);
  // Ranked by known views only; posts with unknown views follow, newest first.
  const posts = postRows.map(post => {
    const target = links.targets.get(String(post.publish_target_id));
    return { platform_post_id: post.id, social_account_id: post.social_account_id ?? null, platform: post.provider ?? post.platform ?? accounts.get(String(post.social_account_id))?.provider ?? null,
      permalink: post.permalink ?? null, published_at: post.published_at ?? null, title: targetTitle(target) ?? post.caption_snapshot ?? null,
      campaign_id: post.campaign_id ?? target?.campaign_id ?? null, metrics: metrics(post.id) };
  }).sort((a, b) => Number(b.metrics.views.value !== null) - Number(a.metrics.views.value !== null) || (b.metrics.views.value ?? 0) - (a.metrics.views.value ?? 0)
    || String(b.published_at).localeCompare(String(a.published_at)));
  const campaigns = (links.links.get(product.id) ?? []).flatMap(link => links.campaigns.get(String(link.campaign_id)) ?? []);
  const factIds = new Set(ctx.list('product_fact').filter(row => row.product_id === product.id).map(row => row.id));
  const facts = byId(ctx.list('product_fact'));
  const timeline = [
    ...campaigns.map(row => ({ at: row.starts_at ?? row.created_at, kind: 'plan', title: row.name ?? null, status: row.status ?? null, resource: { type: 'campaign', id: row.id } })),
    ...[...links.productTargets.get(product.id) ?? []].flatMap(id => links.targets.get(id) ?? []).map(row => ({ at: row.scheduled_at ?? row.created_at, kind: 'publish', title: targetTitle(row),
      status: displayStatus(row, execution), resource: { type: 'publish_target', id: row.id } })),
    ...postRows.map(row => ({ at: row.published_at, kind: 'post', title: posts.find(post => post.platform_post_id === row.id)?.title ?? null, status: row.post_status ?? row.verification ?? null, resource: { type: 'platform_post', id: row.id } })),
    ...ctx.list('change_event').filter(row => row.product_id === product.id).map(row => ({ at: row.detected_at ?? row.created_at, kind: 'change', title: row.change_type ?? null, status: row.status ?? null, resource: { type: 'change_event', id: row.id } })),
    ...[...links.factRevisions.values()].filter(row => factIds.has(String(row.fact_id))).map(row => ({ at: row.created_at, kind: 'fact', title: facts.get(String(row.fact_id))?.fact_key ?? null, status: row.review_status ?? null, resource: { type: 'product_fact_revision', id: row.id } })),
  ].filter(entry => entry.at != null).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    ...card,
    variants: variants.map(variant => ({ id: variant.id, sku: variant.sku ?? null, status: variant.status ?? null,
      title: variant.title ?? (Object.values(variant.options ?? {}).filter(value => typeof value === 'string').join(' / ') || null),
      listings: (index.listings.get(variant.id) ?? []).map(row => {
        const config = (index.configs.get(String(product.store_id)) ?? []).find(item => item.market_id === row.market_id && item.channel === row.channel);
        const state = listingPriceState(row, variant, product, config, ctx.now);
        return { market_id: row.market_id, market_name: index.markets.get(String(row.market_id))?.name ?? null, channel: row.channel,
          price_minor: Number.isSafeInteger(row.price_amount_minor) ? row.price_amount_minor : null, currency: row.currency ?? null, is_estimate: isEstimatedPrice(row),
          publishable: state.publishable_price, stale: state.stale || state.price_stale, inventory_status: row.inventory_status ?? 'unknown',
          inventory_quantity: Number.isSafeInteger(row.inventory_quantity) ? row.inventory_quantity : null, availability: row.availability ?? 'not_collected', observed_at: row.observed_at ?? null };
      }) })),
    timeline, posts, plans: planCards(ctx, campaigns, index),
  };
}

const query = ['brand_id', 'store_id', 'q', 'status', 'attention'] as const;
export const productsViewOperations: Operation[] = [
  { method: 'GET', path: '/views/products', name: 'views_products_list', roles: READ, contract: { query },
    summary: 'Product cards with market prices and stock, plans, content, performance, sales and attention', run: listProducts },
  { method: 'GET', path: '/views/products/:id', name: 'views_product_get', roles: READ,
    summary: 'Product card with variant × market listings, promotion timeline, related posts and plans', run: productDetail },
];
