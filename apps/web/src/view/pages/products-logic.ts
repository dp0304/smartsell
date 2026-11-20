import { addDays, dayIn, formatMinor, isNum, pick, type Lang, type Metric, type TimelineLane, type Tuple } from '@smartsell/ui';

// Response shapes of GET /views/products and /views/products/:id as the server builds them
// (apps/server/src/modules/workspace/views/products.ts); everything at the edges stays optional.
export interface MarketPrice {
  min_minor: number | null; max_minor: number | null; currency: string | null;
  publishable?: boolean; stale?: boolean; is_estimate?: boolean; observed_at?: string | null;
}
export interface MarketStock { status: string; quantity: number | null; availability?: string; variants_observed?: number; variants_total?: number }
export interface MarketSummary { market_id: string; market_name: string | null; channel: string | null; price: MarketPrice | null; stock?: MarketStock | null }
export interface AttentionItem { kind: string; severity: string; title?: string | null; change_type?: string | null; count?: number; resource?: { type: string; id: string } | null }
export interface SalesCurrency { currency: string; orders: number; net_minor: number | null }
export interface Sales { visible: boolean; coverage?: string; currencies?: SalesCurrency[] }
export interface LivePlanRef { id: string; name: string | null; status?: string | null; ends_at: string | null }
export interface ProductBase {
  id: string; title: string | null; status: string | null; brand_id?: string | null; image_url?: string | null;
  store?: { id: string; name: string | null; provider: string | null; status: string | null } | null;
  markets?: MarketSummary[];
  plans?: { live?: LivePlanRef[]; upcoming?: number };
  content?: { scheduled_next_7d?: number; published_30d?: number; next_scheduled_at?: string | null };
  performance?: { views?: Metric; engagements?: Metric };
  sales?: Sales; attention?: AttentionItem[]; created_via?: 'agent' | 'human' | null;
  period?: { from: string; to: string }; as_of?: string;
}
export interface ProductItem extends ProductBase { variants?: { total: number; active?: number } }

export interface Listing {
  market_id: string; market_name: string | null; channel: string | null; price_minor: number | null; currency: string | null;
  is_estimate?: boolean; publishable?: boolean; stale?: boolean; inventory_status?: string | null; inventory_quantity: number | null;
  availability?: string | null; observed_at?: string | null;
}
export interface VariantRow { id: string; sku: string | null; title: string | null; status?: string | null; listings?: Listing[] }
export interface TimelineEntry { at: string; kind: string; title: string | null; status: string | null; resource?: { type: string; id: string } | null }
export interface ProductPost {
  platform_post_id: string; social_account_id?: string | null; platform: string | null; permalink: string | null; published_at: string | null;
  title: string | null; campaign_id?: string | null; metrics?: { views?: Metric; engagements?: Metric };
}
export interface ProductPlan {
  id: string; name: string | null; kind?: string | null; status: string | null; starts_at: string | null; ends_at: string | null; timezone?: string | null;
  day?: number | null; days?: number | null;
  matrix?: { planned?: number; filled?: number; published?: number; scheduled?: number; in_production?: number; failed?: number; gap?: number; completeness_ratio?: number | null };
  products?: { product_id: string; title: string | null; role: string | null; stock_status?: string | null }[];
  next_publication?: { publish_target_id: string; scheduled_at: string; title: string | null } | null;
  goals?: PlanGoal[]; needs_decision?: number; created_via?: 'agent' | 'human' | null;
}
export interface PlanGoal {
  goal_id?: string; metric_key: string; unit: string | null; currency: string | null; target_value: number | null;
  value: number | null; progress_percent: number | null; coverage_status?: string | null;
}
const goalText: Record<string, Tuple> = {
  'norm.post.views': ['瀏覽', 'Views'], 'norm.post.engagements': ['互動', 'Engagements'], 'norm.post.reach': ['觸及', 'Reach'],
  'norm.account.followers': ['粉絲', 'Followers'], 'norm.account.follower_delta': ['新增粉絲', 'New followers'],
  'commerce.orders': ['訂單', 'Orders'], 'commerce.revenue': ['營收', 'Revenue'], 'ads.spend': ['投放花費', 'Ad spend'],
};
/** Goal metric name; unknown keys show their last segment rather than the raw key. */
export const goalLabel = (key: string): Tuple => goalText[key] ?? (name => [name, name] as const)((key.split('.').at(-1) ?? key).replace(/_/g, ' '));
/**
 * The detail spreads the card and then replaces `variants` (a count on the card) with variant rows and
 * `plans` (live refs on the card) with full plan cards, so live-plan refs are not on the detail.
 */
export type ProductDetailView = Omit<ProductBase, 'plans'> & {
  variants?: VariantRow[]; timeline?: TimelineEntry[]; posts?: ProductPost[]; plans?: ProductPlan[];
};

const known = (metric: Metric | null | undefined): metric is Metric & { value: number } =>
  !!metric && isNum(metric.value) && (metric.availability === 'observed' || metric.availability === 'estimated');

// ---------------------------------------------------------------- list: flags, filters, sorting, summary

export const productFilters = ['all', 'live', 'attention', 'out'] as const;
export type ProductFilter = typeof productFilters[number];
export const isProductFilter = (value: unknown): value is ProductFilter => (productFilters as readonly unknown[]).includes(value);
export const productSorts = ['recent', 'views', 'orders'] as const;
export type ProductSort = typeof productSorts[number];
export const isProductSort = (value: unknown): value is ProductSort => (productSorts as readonly unknown[]).includes(value);

/** Live promotion, attention and stock state of one card; stock only matters while the product is on sale. */
export function productFlags(item: ProductBase) {
  const selling = item.status === 'active';
  const stock = (item.markets ?? []).map(market => market.stock?.status);
  const out = selling && stock.includes('out_of_stock');
  const low = selling && stock.includes('low');
  const live = (item.plans?.live?.length ?? 0) > 0;
  return { live, out, low, attention: (item.attention?.length ?? 0) > 0 || out || low };
}

export function matchesFilter(item: ProductBase, filter: ProductFilter) {
  if (filter === 'all') return true;
  const flags = productFlags(item);
  return filter === 'live' ? flags.live : filter === 'attention' ? flags.attention : flags.out;
}

export function filterCounts(items: readonly ProductBase[]): Record<ProductFilter, number> {
  return Object.fromEntries(productFilters.map(filter => [filter, items.filter(item => matchesFilter(item, filter)).length])) as Record<ProductFilter, number>;
}

/** Orders recorded with this product in the window; null when the viewer may not see sales. */
export function ordersOf(item: ProductBase): number | null {
  if (!item.sales?.visible) return null;
  return (item.sales.currencies ?? []).reduce((sum, row) => sum + (isNum(row.orders) ? row.orders : 0), 0);
}
export const viewsOf = (item: ProductBase): number | null => known(item.performance?.views) ? item.performance!.views!.value : null;

/** Sorts by a measure; unknown values go after every known one (never ranked as zero) and keep the server order. */
export function sortProducts<T extends ProductBase>(items: readonly T[], sort: ProductSort): T[] {
  if (sort === 'recent') return [...items];
  const measure = sort === 'views' ? viewsOf : ordersOf;
  return items.map((item, index) => ({ item, index, value: measure(item) }))
    .sort((a, b) => (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0) || (b.value ?? 0) - (a.value ?? 0) || a.index - b.index)
    .map(entry => entry.item);
}

export interface ProductSummary {
  total: number; active: number; draft: number; live: number; upcomingOnly: number; attention: number; out: number; low: number;
  views: { leader: { id: string; title: string | null; metric: Metric } | null; known: number; availability: string };
  orders: { visible: boolean; leader: { id: string; title: string | null; orders: number; currencies: SalesCurrency[] } | null; withOrders: number };
  postsWithoutMetrics: boolean;
}

/**
 * What the strip at the top says. Views and orders are not summed across products: one post or order can
 * feature several products, so a total would double count. The leader and the coverage are exact.
 */
export function summarize(items: readonly ProductBase[]): ProductSummary {
  const flags = items.map(productFlags);
  const viewed = items.filter(item => viewsOf(item) !== null);
  const viewLeader = sortProducts(viewed, 'views')[0];
  const unknownViews = items.map(item => item.performance?.views?.availability ?? 'not_collected');
  const visible = items.filter(item => item.sales?.visible);
  const ordered = visible.filter(item => (ordersOf(item) ?? 0) > 0);
  const orderLeader = sortProducts(ordered, 'orders')[0];
  return {
    total: items.length,
    active: items.filter(item => item.status === 'active').length,
    draft: items.filter(item => item.status === 'draft').length,
    live: flags.filter(flag => flag.live).length,
    upcomingOnly: items.filter((item, index) => !flags[index]!.live && (item.plans?.upcoming ?? 0) > 0).length,
    attention: flags.filter(flag => flag.attention).length,
    out: flags.filter(flag => flag.out).length,
    low: flags.filter(flag => flag.low && !flag.out).length,
    views: {
      leader: viewLeader ? { id: viewLeader.id, title: viewLeader.title, metric: viewLeader.performance!.views! } : null,
      known: viewed.length,
      availability: viewed.length ? 'observed' : unknownViews.length && unknownViews.every(value => value === unknownViews[0]) ? unknownViews[0]! : 'not_collected',
    },
    orders: {
      visible: visible.length > 0,
      leader: orderLeader ? { id: orderLeader.id, title: orderLeader.title, orders: ordersOf(orderLeader)!, currencies: orderLeader.sales?.currencies ?? [] } : null,
      withOrders: ordered.length,
    },
    postsWithoutMetrics: !viewed.length && items.some(item => (item.content?.published_30d ?? 0) > 0),
  };
}

// ---------------------------------------------------------------- display helpers

const cjk = /[⺀-鿿가-힯豈-﫿]/;
/**
 * One or two characters for the image fallback tile, from the first word that starts with a letter
 * (so "15% 維他命C精華" gives 維他): CJK keeps two characters, Latin takes two initials.
 */
export function initials(title: string | null | undefined): string {
  const text = (title ?? '').trim();
  if (!text) return '?';
  const words = text.split(/[\s\-_/·|,，、()（）]+/).filter(word => /^\p{L}/u.test(word));
  if (!words.length) return [...text.replace(/\s+/g, '')].slice(0, 2).join('').toUpperCase();
  const first = [...words[0]!];
  if (cjk.test(first[0]!)) return first.filter(char => cjk.test(char)).slice(0, 2).join('');
  const second = words[1] && !cjk.test(words[1][0]!) ? [...words[1]][0] : undefined;
  return (second ? first[0]! + second : first.slice(0, 2).join('')).toUpperCase();
}

/** Only http(s) and same-origin images are rendered; anything else falls back to initials. */
export function safeImage(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  return /^https?:\/\/\S+$/i.test(value) || (value.startsWith('/') && !value.startsWith('//')) ? value : null;
}
export const safeLink = (url: unknown): string | null => typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim()) ? url.trim() : null;

export const changeTypeText: Record<string, Tuple> = {
  price_changed: ['價格變動', 'Price changed'], stock_low: ['庫存跌破門檻', 'Stock crossed the low threshold'], out_of_stock: ['缺貨', 'Out of stock'],
  became_unavailable: ['已停止販售', 'No longer available for sale'], became_available: ['恢復販售', 'Available for sale again'],
  localization_stale: ['在地化內容已過時', 'Localization is stale'], product_removed: ['商品已在店鋪下架', 'Removed at the store'],
  fact_revised: ['商品資訊已修訂', 'Product fact revised'], fact_retracted: ['商品資訊已撤回', 'Product fact retracted'],
};

/** Localized attention text; the server's English title is the fallback for kinds the dashboard does not know yet. */
export function attentionText(item: AttentionItem): Tuple {
  const n = isNum(item.count) ? item.count : 1;
  switch (item.kind) {
    case 'change_event': {
      const type = item.change_type ?? item.title?.split(' · ')[0] ?? '';
      const sku = item.title?.split(' · ').slice(1).join(' · ');
      const base = changeTypeText[type] ?? [type.replace(/_/g, ' ') || '商品變動', type.replace(/_/g, ' ') || 'Product change'];
      return sku ? [`${base[0]} · ${sku}`, `${base[1]} · ${sku}`] : base;
    }
    case 'fact_pending': return [`${n} 項商品資訊草稿待審核`, `${n} product fact draft${n === 1 ? '' : 's'} await review`];
    case 'localization_stale': return [`${n} 項在地化內容已過時`, `${n} localization${n === 1 ? ' is' : 's are'} stale`];
    case 'price_unpublishable': return [`${n} 個市場的價格目前不能用於發布`, `Price can't be used for publishing in ${n} market${n === 1 ? '' : 's'}`];
    default: return [item.title ?? item.kind, item.title ?? item.kind];
  }
}
export const severityTone = (severity: string) => severity === 'blocker' ? 'critical' : severity === 'high' ? 'serious' : 'warning';

export const productStatusText: Record<string, [tone: 'good' | 'neutral' | 'serious', zh: string, en: string]> = {
  active: ['good', '販售中', 'On sale'], draft: ['neutral', '草稿', 'Draft'], archived: ['neutral', '已封存', 'Archived'],
  removed_at_source: ['serious', '店鋪已下架', 'Removed at the store'],
};
export const stockText: Record<string, Tuple> = {
  in_stock: ['有庫存', 'In stock'], low: ['庫存偏低', 'Low stock'], out_of_stock: ['缺貨', 'Out of stock'],
  unknown: ['庫存未採集', 'Stock not collected'], not_tracked: ['未追蹤庫存', 'Stock not tracked'],
};
/** Statuses the shared chip does not know, as they appear on publications, posts, changes and fact revisions. */
export const extraStatusText: Record<string, [tone: 'good' | 'info' | 'warning' | 'serious' | 'neutral', zh: string, en: string]> = {
  executing: ['info', '發布中', 'Publishing'], cancel_requested: ['neutral', '取消中', 'Cancelling'], ready: ['info', '已排程', 'Scheduled'],
  resolved: ['neutral', '已處理', 'Resolved'], dismissed: ['neutral', '已略過', 'Dismissed'], deleted: ['serious', '已刪除', 'Deleted'],
  removed_by_platform: ['serious', '被平台移除', 'Removed by the platform'], system_verified: ['good', '已核實', 'Verified'],
  platform_readback: ['good', '平台回讀', 'Read back from platform'], manual_confirmed: ['good', '人工確認', 'Confirmed by a person'],
  manual_evidence: ['good', '人工佐證', 'Manual evidence'], manual: ['neutral', '人工登記', 'Registered by hand'], agent_reported: ['info', 'Agent 回報', 'Reported by agent'],
};
export const roleText: Record<string, Tuple> = { hero: ['主打', 'Hero'], supporting: ['搭配', 'Supporting'], bundle: ['組合', 'Bundle'], gift: ['贈品', 'Gift'] };
export const providerText: Record<string, string> = {
  shopify: 'Shopify', tiktok_shop: 'TikTok Shop', amazon_sp: 'Amazon', shopee: 'Shopee', file_import: '檔案匯入 / File import',
};
export const channelText: Record<string, Tuple> = {
  online_store: ['官網', 'Online store'], tiktok_shop: ['TikTok Shop', 'TikTok Shop'], marketplace: ['電商平台', 'Marketplace'], other: ['其他通路', 'Other channel'],
};
export const platformText: Record<string, string> = {
  instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', threads: 'Threads', youtube: 'YouTube', x: 'X', twitter: 'X', line: 'LINE',
  xiaohongshu: '小紅書', pinterest: 'Pinterest', linkedin: 'LinkedIn',
};
/** "Store · Provider", leaving the provider out when the store's own name already says it. */
export function storeLine(store: ProductBase['store'], lang: Lang): string {
  if (!store) return '';
  const provider = providerLabel(store.provider, lang);
  const name = store.name?.trim() ?? '';
  return name && provider && name.toLowerCase().includes(provider.toLowerCase()) ? name : [name, provider].filter(Boolean).join(' · ');
}
export function providerLabel(provider: string | null | undefined, lang: Lang) {
  if (!provider) return '';
  const text = providerText[provider];
  if (!text) return provider.replace(/_/g, ' ');
  return text.includes(' / ') ? text.split(' / ')[lang === 'en' ? 1 : 0]! : text;
}
export const platformLabel = (platform: string | null | undefined) => platform ? platformText[platform] ?? platform.replace(/_/g, ' ') : '';

/** "NT$1,000 – NT$1,200", one amount when every variant costs the same, null when it cannot be shown honestly. */
export function priceRange(price: Pick<MarketPrice, 'min_minor' | 'max_minor' | 'currency'> | null | undefined, lang: Lang, compact = false): string | null {
  if (!price) return null;
  const min = formatMinor(price.min_minor, price.currency, lang, compact);
  if (!min) return null;
  const max = price.max_minor !== price.min_minor ? formatMinor(price.max_minor, price.currency, lang, compact) : null;
  return max ? `${min} – ${max}` : min;
}

/** Recorded orders per currency, e.g. "3 筆 · NT$1,500"; a currency whose amount is unreadable says so. */
export function salesLines(sales: Sales | null | undefined, lang: Lang): string[] {
  if (!sales?.visible) return [];
  return (sales.currencies ?? []).filter(row => isNum(row.orders) && row.orders > 0).map(row => {
    const count = lang === 'en' ? `${row.orders} order${row.orders === 1 ? '' : 's'}` : `${row.orders} 筆`;
    return `${count} · ${formatMinor(row.net_minor, row.currency, lang, true) ?? pick([`${row.currency} 金額未知`, `${row.currency} amount unknown`], lang)}`;
  });
}

// ---------------------------------------------------------------- detail: variant × market matrix

export interface MarketColumn { key: string; market_id: string; market_name: string | null; channel: string | null; showChannel: boolean; summary?: MarketSummary }
export const marketKey = (market_id: unknown, channel: unknown) => JSON.stringify([market_id ?? null, channel ?? null]);

/** Market columns from the card summaries plus any listing the summaries do not cover, in first-seen order. */
export function marketColumns(markets: readonly MarketSummary[] = [], variants: readonly VariantRow[] = []): MarketColumn[] {
  const columns = new Map<string, MarketColumn>();
  const add = (row: { market_id: string; market_name: string | null; channel: string | null }, summary?: MarketSummary) => {
    const key = marketKey(row.market_id, row.channel);
    const prior = columns.get(key);
    if (prior) { prior.market_name ??= row.market_name; prior.summary ??= summary; return; }
    columns.set(key, { key, market_id: row.market_id, market_name: row.market_name, channel: row.channel, showChannel: false, summary });
  };
  for (const market of markets) add(market, market);
  for (const variant of variants) for (const listing of variant.listings ?? []) add(listing);
  const list = [...columns.values()];
  const perMarket = new Map<string, number>();
  for (const column of list) perMarket.set(column.market_id, (perMarket.get(column.market_id) ?? 0) + 1);
  for (const column of list) column.showChannel = (perMarket.get(column.market_id) ?? 0) > 1 || (!!column.channel && column.channel !== 'online_store');
  return list;
}

export function listingFor(variant: VariantRow, column: MarketColumn): Listing | undefined {
  return (variant.listings ?? []).find(row => marketKey(row.market_id, row.channel) === column.key);
}

/** Which price flags appear anywhere on the page, so only those get an explanation. */
export function priceFlagsInUse(markets: readonly MarketSummary[] = [], variants: readonly VariantRow[] = []) {
  const prices = [...markets.map(market => market.price).filter((price): price is MarketPrice => !!price),
    ...variants.flatMap(variant => variant.listings ?? []).filter(row => isNum(row.price_minor))];
  return {
    estimate: prices.some(price => price.is_estimate === true),
    stale: prices.some(price => price.stale === true),
    unpublishable: prices.some(price => price.publishable === false),
  };
}

// ---------------------------------------------------------------- detail: promotion timeline

export interface TimelineWindow { from: string; to: string; hidden: number }
/**
 * Covers at least `before`/`after` days around today and stretches to every dated item within `max` days;
 * items entirely outside that are counted as hidden (the list view still shows them).
 */
export function timelineWindow(today: string, spans: readonly { start: string; end?: string | null }[], { before = 30, after = 30, max = 180 } = {}): TimelineWindow {
  const lo = addDays(today, -max), hi = addDays(today, max);
  const days: string[] = [addDays(today, -before), addDays(today, after)];
  let hidden = 0;
  for (const span of spans) {
    const end = span.end && span.end >= span.start ? span.end : span.start;
    if (end < lo || span.start > hi) { hidden++; continue; }
    days.push(span.start < lo ? lo : span.start, end > hi ? hi : end);
  }
  days.sort();
  return { from: days[0]!, to: days[days.length - 1]!, hidden };
}

const laneText = {
  publish: ['發布排期', 'Scheduled posts'], post: ['已發布貼文', 'Published posts'], change: ['商品變動', 'Product changes'], fact: ['商品資訊修訂', 'Fact revisions'],
} satisfies Record<string, Tuple>;

export function timelineEntryLabel(entry: TimelineEntry, lang: Lang): string {
  if (entry.kind === 'change') return pick(changeTypeText[entry.title ?? ''] ?? [entry.title ?? '商品變動', entry.title ?? 'Product change'], lang);
  if (entry.title) return entry.title;
  return pick(entry.kind === 'publish' ? ['未命名的發布', 'Untitled publication'] : entry.kind === 'post' ? ['未命名的貼文', 'Untitled post'] : ['未命名', 'Untitled'], lang);
}

/**
 * Lanes for the Timeline component: one per dated plan (its own period as a bar), then publications, posts,
 * product changes and fact revisions as point marks. Lanes without items are left out.
 */
export function timelineLanes(detail: ProductDetailView, { lang, timeZone, planHref, entryHref }: {
  lang: Lang; timeZone?: string; planHref: (id: string) => string; entryHref?: (entry: TimelineEntry) => string | undefined;
}): { lanes: TimelineLane[]; spans: { start: string; end?: string | null }[]; undatedPlans: number } {
  const day = (value: string | null | undefined) => value ? dayIn(value, timeZone) : '';
  const plans = Array.isArray(detail.plans) ? detail.plans as ProductPlan[] : [];
  const spans: { start: string; end?: string | null }[] = [];
  const lanes: TimelineLane[] = [];
  let undatedPlans = 0;
  for (const plan of plans) {
    if (!plan.starts_at || !day(plan.starts_at)) { undatedPlans++; continue; }
    const label = plan.name ?? pick(['未命名的計劃', 'Untitled plan'], lang);
    spans.push({ start: day(plan.starts_at), end: plan.ends_at ? day(plan.ends_at) : null });
    lanes.push({ id: `plan:${plan.id}`, label, href: planHref(plan.id),
      items: [{ id: plan.id, label, start: plan.starts_at, end: plan.ends_at, status: plan.status, href: planHref(plan.id) }] });
  }
  const entries = (detail.timeline ?? []).filter(entry => entry.at && day(entry.at));
  for (const kind of ['publish', 'post', 'change', 'fact'] as const) {
    const items = entries.filter(entry => entry.kind === kind).map((entry, index) => {
      spans.push({ start: day(entry.at) });
      return { id: `${kind}:${entry.resource?.id ?? index}`, label: timelineEntryLabel(entry, lang), start: entry.at, status: entry.status, href: entryHref?.(entry) };
    });
    if (items.length) lanes.push({ id: kind, label: pick(laneText[kind], lang), items });
  }
  return { lanes, spans, undatedPlans };
}

// ---------------------------------------------------------------- detail: posts and suggestions

/** Posts whose views are known, in the server's ranking; the rest are reported as unranked, never as zero. */
export function rankedPosts(posts: readonly ProductPost[] = []) {
  const ranked = posts.filter(post => known(post.metrics?.views));
  return { ranked, unranked: posts.length - ranked.length };
}

export type PromptKey = 'plan' | 'prices' | 'resync' | 'posts' | 'metrics' | 'localize';
/** Suggestions for the agent, most useful first, from what the product is missing. */
export function detailPrompts(detail: ProductDetailView): PromptKey[] {
  const keys: PromptKey[] = [];
  const plans = Array.isArray(detail.plans) ? detail.plans as ProductPlan[] : [];
  const listings = (detail.variants ?? []).flatMap(variant => variant.listings ?? []);
  const priced = listings.filter(row => isNum(row.price_minor));
  const live = plans.some(plan => ['active', 'paused', 'wrapping'].includes(String(plan.status)));
  if (!live) keys.push('plan');
  if (!priced.length) keys.push('prices');
  else if (priced.some(row => row.stale)) keys.push('resync');
  const posts = detail.posts ?? [];
  if ((detail.content?.scheduled_next_7d ?? 0) === 0) keys.push('posts');
  if (posts.length && posts.some(post => !known(post.metrics?.views))) keys.push('metrics');
  if ((detail.attention ?? []).some(item => item.kind === 'localization_stale')) keys.push('localize');
  if (live) keys.push('plan');
  return keys;
}

export function promptText(key: PromptKey, title: string): { heading: Tuple; prompt: Tuple } {
  const name = title.trim() || '這個商品';
  const en = title.trim() || 'this product';
  switch (key) {
    case 'plan': return { heading: ['規劃下一波推廣', 'Plan the next promotion'], prompt: [`幫「${name}」建立下個月的推廣計劃`, `Create next month’s promotion plan for “${en}”`] };
    case 'prices': return { heading: ['還沒有各市場的價格與庫存', 'No market prices or stock yet'], prompt: [`幫我把「${name}」在各市場的價格和庫存同步進 SmartSell`, `Sync the prices and stock of “${en}” in each market into SmartSell`] };
    case 'resync': return { heading: ['部分價格已過時', 'Some prices are stale'], prompt: [`幫我重新同步「${name}」各市場的價格和庫存`, `Re-sync the prices and stock of “${en}” in every market`] };
    case 'posts': return { heading: ['接下來 7 天沒有排定貼文', 'Nothing scheduled in the next 7 days'], prompt: [`幫「${name}」規劃並排好接下來兩週的社群貼文`, `Plan and schedule social posts for “${en}” for the next two weeks`] };
    case 'metrics': return { heading: ['部分貼文還沒有成效數據', 'Some posts have no performance data'], prompt: [`幫我匯入「${name}」相關貼文的最新成效`, `Import the latest performance for posts featuring “${en}”`] };
    case 'localize': return { heading: ['在地化內容已過時', 'Localizations are stale'], prompt: [`幫我更新「${name}」已過時的在地化內容，送給我審核`, `Update the stale localizations of “${en}” and send them to me for review`] };
  }
}
