import { DomainError, admins, readers, writers, type Commands, type Context, type Entity, type Fields } from '../types';
import { active, bad, bool, channels, conflict, currency, get, guard, hash, id, insert, integer, list, live, locale, one, options, priceSources, productStatuses, providers, purchaseUrl, stableId, store, str, update, variantStatuses, version } from './model';
import { mutations } from './mutation';
import { isStale, listingInput, priceEligible, recordChange, snapshotKey, writeSnapshot } from './snapshots';

const storeStates = ['import_only', 'connecting', 'active', 'degraded', 'needs_reauth', 'disabled'] as const;
const transitions: Record<string, string[]> = {
  import_only: ['connecting', 'disabled'], connecting: ['active', 'needs_reauth', 'disabled'],
  active: ['degraded', 'needs_reauth', 'disabled'], degraded: ['active', 'needs_reauth', 'disabled'],
  needs_reauth: ['active', 'disabled'], disabled: [],
};
const currentListings = async (ctx: Context) => (await list(ctx, 'listing_snapshot')).filter(row => active(row) && row.data.is_current);
const selector = (input: Fields) => ({ marketId: id(input.market_id, 'market_id'), channel: one(input.channel, 'channel', channels) });
const marketKey = (ctx: Context, storeId: string, marketId: string, channel: string) => stableId(ctx.workspaceId, 'store_market', storeId, marketId, channel);
const optional = (value: unknown, field: string, validator = str) => value == null ? null : validator(value, field);
const simpleSource = (ctx: Context) => ({ kind: 'manual', actor_id: ctx.actorId });
async function linked(ctx: Context, module: string, kind: string, value: unknown, field: string) {
  const key = id(value, field);
  const row = await ctx.get(module, kind, key);
  if (!active(row) || ['archived', 'disabled'].includes(row.data.status)) throw new DomainError('not_found', `${kind} not found`, 404);
  return row;
}

export const catalogCommands: Commands = {
  create_store: { roles: admins, async run(ctx, input) {
    const provider = one(input.provider, 'provider', providers);
    const externalStoreId = optional(input.external_store_id, 'external_store_id', id);
    const region = optional(input.region, 'region');
    const brandId = input.brand_id == null ? null : (await linked(ctx, 'workspace', 'brand', input.brand_id, 'brand_id')).id;
    const key = externalStoreId ? stableId(ctx.workspaceId, 'store', provider, externalStoreId, provider === 'amazon_sp' ? region : null) : undefined;
    const entity = await insert(ctx, 'store', {
      provider, external_store_id: externalStoreId, region, brand_id: brandId, name: str(input.name, 'name'),
      default_currency: currency(input.default_currency), default_locale: locale(input.default_locale, 'default_locale'),
      status: 'import_only', status_reason: null, sync_scope: { products: true, inventory: provider === 'shopify', orders: false },
      connection_id: null, data_source_id: null, last_snapshot_at: null,
    }, key);
    await ctx.emit('commerce.store.status_changed', { store_id: entity.id, status: 'import_only' });
    return entity;
  } },
  set_store_status: { roles: admins, async run(ctx, input) {
    const key = id(input.store_id, 'store_id');
    await guard(ctx, key);
    const s = await store(ctx, key, false);
    version(input, s);
    const status = one(input.status, 'status', storeStates);
    if (!transitions[s.data.status]?.includes(status)) return conflict('invalid_state', 'Store status transition is unavailable');
    const connectionId = input.connection_id ? (await linked(ctx, 'account', 'connection', input.connection_id, 'connection_id')).id : s.data.connection_id;
    const why = input.status_reason === undefined ? null : one(input.status_reason, 'status_reason', ['ip_not_allowed', 'authorization_failed', 'permission_reduced', 'sync_failed', 'manual']);
    if (status === 'connecting' && (s.data.provider === 'file_import' || !connectionId)) return bad('connection_id');
    const snapshot = input.snapshot_completed === true;
    if (status === 'active' && (!connectionId || (!snapshot && !s.data.last_snapshot_at))) return conflict('snapshot_required', 'Complete an initial snapshot before marking the store active');
    const row = await update(ctx, s, { status, status_reason: why, connection_id: connectionId, ...(snapshot && status === 'active' ? { last_snapshot_at: ctx.now } : {}) });
    await ctx.emit('commerce.store.status_changed', { store_id: s.id, status, status_reason: why });
    return row;
  } },
  create_product: { roles: writers, async run(ctx, input) {
    const storeId = id(input.store_id, 'store_id');
    await guard(ctx, storeId);
    const s = await store(ctx, storeId);
    const row = await insert(ctx, 'product', {
      store_id: s.id, brand_id: s.data.brand_id ?? null, title: str(input.title, 'title', 1000), handle: optional(input.handle, 'handle'),
      product_type: optional(input.product_type, 'product_type'), vendor: optional(input.vendor, 'vendor'),
      status: one(input.status ?? 'draft', 'status', ['draft', 'active']), external_product_id: null, source: simpleSource(ctx), rolled_back: false,
    });
    await ctx.emit('commerce.product.upserted', { product_id: row.id, store_id: s.id });
    return row;
  } },
  update_product: { roles: writers, async run(ctx, input) {
    const productId = id(input.product_id, 'product_id');
    const initial = await live(ctx, 'product', productId);
    await guard(ctx, initial.data.store_id);
    await store(ctx, initial.data.store_id);
    const product = await live(ctx, 'product', productId);
    version(input, product);
    const patch: Fields = {};
    for (const key of ['handle', 'product_type', 'vendor']) if (Object.hasOwn(input, key)) patch[key] = optional(input[key], key);
    if (Object.hasOwn(input, 'title')) patch.title = str(input.title, 'title', 1000);
    if (Object.hasOwn(input, 'status')) patch.status = one(input.status, 'status', ['draft', 'active', 'archived']);
    if (!Object.keys(patch).length) return bad('product fields');
    const row = await update(ctx, product, patch);
    if (patch.title && patch.title !== product.data.title) {
      const view = await mutations(ctx, ['product_localization', 'change_event'], product.data.store_id);
      for (const localization of view.rows('product_localization').filter(row => row.data.product_id === productId && row.data.field_key === 'title')) {
        view.put('product_localization', localization.id, { status: 'stale', source_ref: { ...localization.data.source_ref, content_hash: hash(patch.title) } });
        recordChange(ctx, view, { store_id: product.data.store_id, change_type: 'localization_stale', product_id: productId, severity: 'review' }, {}, { localization_id: localization.id }, `${localization.id}:${row.version}`);
        view.event('commerce.localization.stale', { product_id: productId, localization_id: localization.id });
      }
      await view.persist();
    }
    await ctx.emit('commerce.product.upserted', { product_id: row.id, store_id: product.data.store_id });
    return row;
  } },
  upsert_variant: { roles: writers, async run(ctx, input) {
    const productId = id(input.product_id, 'product_id');
    const initial = await live(ctx, 'product', productId);
    await guard(ctx, initial.data.store_id);
    await store(ctx, initial.data.store_id);
    const product = await live(ctx, 'product', productId);
    const existing = input.variant_id ? await live(ctx, 'product_variant', id(input.variant_id, 'variant_id')) : undefined;
    if (existing && existing.data.product_id !== product.id) return conflict('variant_product_conflict', 'Variant belongs to a different product');
    if (existing) version(input, existing);
    const patch: Fields = {};
    for (const key of ['sku', 'barcode']) if (Object.hasOwn(input, key)) patch[key] = optional(input[key], key);
    if (Object.hasOwn(input, 'options')) { patch.options = options(input.options); patch.option_values = Object.values(patch.options); }
    if (Object.hasOwn(input, 'status')) patch.status = one(input.status, 'status', variantStatuses.slice(0, 2));
    if (existing && !Object.keys(patch).length) return bad('variant fields');
    const row = existing ? await update(ctx, existing, patch) : await insert(ctx, 'product_variant', { store_id: product.data.store_id, product_id: productId, external_variant_id: null, source: simpleSource(ctx), status: 'active', options: {}, rolled_back: false, ...patch });
    await ctx.emit('commerce.product_variant.upserted', { product_id: productId, product_variant_id: row.id, store_id: product.data.store_id });
    return row;
  } },
  configure_store_market: { roles: writers, async run(ctx, input) {
    const storeId = id(input.store_id, 'store_id');
    await guard(ctx, storeId);
    const s = await store(ctx, storeId);
    const { marketId, channel } = selector(input);
    const market = await linked(ctx, 'workspace', 'market', marketId, 'market_id');
    if (market.data.brand_id != null && market.data.brand_id !== s.data.brand_id) return bad('market_id');
    const key = marketKey(ctx, s.id, marketId, channel);
    const existing = await get(ctx, 'store_market', key);
    if (existing) version(input, existing);
    const enabled = input.enabled === undefined ? existing?.data.enabled ?? true : bool(input.enabled, 'enabled');
    if (enabled && ['tiktok_shop', 'shopee'].includes(s.data.provider) && (await list(ctx, 'store_market')).some(row => row.data.store_id === s.id && row.data.enabled && row.data.market_id !== marketId)) return conflict('single_market', 'This provider supports one market per store');
    const pattern = input.purchase_url_template === undefined ? existing?.data.purchase_url_template ?? null : optional(input.purchase_url_template, 'purchase_url_template');
    if (pattern) {
      const validTokens: Fields = { sku: '123', variant_id: '123', handle: 'product', locale: 'en', market_id: '456' };
      const example = pattern.replace(/\{([a-z_]+)\}/g, (_: string, token: string) => validTokens[token] ?? bad('purchase_url_template'));
      if (/[{}]/.test(example)) return bad('purchase_url_template');
      purchaseUrl(s.data.provider, example, 'purchase_url_template');
    }
    const locations = input.inventory_locations;
    if (locations != null && (!Array.isArray(locations) || !locations.length || locations.length > 100 || s.data.provider !== 'shopify')) return bad('inventory_locations');
    const data = { store_id: s.id, market_id: marketId, channel, enabled, purchase_url_template: pattern,
      locale: market.data.locale ?? market.data.language ?? s.data.default_locale,
      price_source: one(input.price_source ?? existing?.data.price_source, 'price_source', priceSources.slice(0, 3)),
      low_stock_threshold: input.low_stock_threshold === undefined ? existing?.data.low_stock_threshold ?? null : input.low_stock_threshold === null ? null : integer(input.low_stock_threshold, 'low_stock_threshold'),
      snapshot_ttl_minutes: integer(input.snapshot_ttl_minutes ?? existing?.data.snapshot_ttl_minutes ?? 1440, 'snapshot_ttl_minutes', 1, 525600),
      inventory_locations: locations === undefined ? existing?.data.inventory_locations ?? null : locations === null ? null : [...new Set(locations.map((value: unknown) => str(value, 'inventory_location')))],
    };
    const row = existing ? await update(ctx, existing, data) : await insert(ctx, 'store_market', data, key);
    await ctx.emit('commerce.store_market.configured', { store_market_id: row.id, store_id: storeId, market_id: marketId, channel });
    return row;
  } },
  record_listing_snapshot: { roles: writers, async run(ctx, input) {
    const variantId = id(input.variant_id, 'variant_id');
    const initial = await live(ctx, 'product_variant', variantId);
    await guard(ctx, initial.data.store_id);
    const variant = await live(ctx, 'product_variant', variantId);
    const s = await store(ctx, variant.data.store_id);
    const { marketId, channel } = selector(input);
    const setting = await live(ctx, 'store_market', marketKey(ctx, s.id, marketId, channel));
    if (!setting.data.enabled) return conflict('store_market_disabled', 'Store market is disabled');
    const view = await mutations(ctx, ['listing_snapshot', 'change_event'], s.id);
    const fxRateId = input.fx_rate_id == null ? null : id(input.fx_rate_id, 'fx_rate_id');
    const listing = listingInput({ ...input, fx_rate_id: fxRateId }, setting, s);
    const prev = view.rows('listing_snapshot').find(row => row.data.is_current && snapshotKey(row, variant.id, marketId, channel));
    if (prev?.data.source_updated_at && listing.source_updated_at && listing.source_updated_at < prev.data.source_updated_at) return conflict('stale_source', 'Source observation predates the current snapshot');
    const snapshot = writeSnapshot(ctx, view, variant, setting, { ...listing, source: simpleSource(ctx) }, `${prev?.id ?? 'initial'}:${ctx.now}:${hash(listing)}`);
    await view.persist();
    return live(ctx, 'listing_snapshot', snapshot.id);
  } },
  market_snapshot: { roles: readers, async run(ctx, input) {
    const { marketId, channel } = selector(input);
    if (!Array.isArray(input.variant_ids) || !input.variant_ids.length || input.variant_ids.length > 100) return bad('variant_ids');
    const variants = [...new Set(input.variant_ids.map(value => id(value, 'variant_id')))];
    const all = (await list(ctx, 'listing_snapshot')).filter(active);
    const rank = (source: string) => priceSources.findIndex(name => name === source);
    return Promise.all(variants.map(async variantId => {
      const variant = await live(ctx, 'product_variant', variantId);
      const setting = await get(ctx, 'store_market', marketKey(ctx, variant.data.store_id, marketId, channel));
      const matching = all.filter(row => snapshotKey(row, variantId, marketId, channel));
      const latest = matching.find(row => row.data.is_current);
      const dimensions = { variant_id: variantId, market_id: marketId, channel };
      if (!latest || !setting?.data.enabled) return { ...dimensions, availability: 'not_collected', current: false, is_stale: false, publishable_price: false };
      const price = latest.data.availability === 'observed' ? matching
        .filter(row => row.data.availability === 'observed' && row.data.price_amount_minor != null && priceEligible(row.data.price_source, setting))
        .sort((a, b) => Number(isStale(a, setting, ctx.now)) - Number(isStale(b, setting, ctx.now)) || rank(a.data.price_source) - rank(b.data.price_source) || (b.data.observation_no ?? 0) - (a.data.observation_no ?? 0))[0] : undefined;
      const priceStale = !!price && isStale(price, setting, ctx.now);
      return { ...latest.data, snapshot_id: latest.id, price_snapshot_id: price?.id ?? null, price_amount_minor: price?.data.price_amount_minor ?? null,
        compare_at_amount_minor: price?.data.compare_at_amount_minor ?? null, currency: price?.data.currency ?? null, price_source: price?.data.price_source ?? null,
        price_observed_at: price?.data.observed_at ?? null, is_estimate: price?.data.is_estimate ?? false,
        is_stale: isStale(latest, setting, ctx.now) || priceStale, publishable_price: !!price && !priceStale && !price.data.is_estimate && !isStale(latest, setting, ctx.now), as_of: ctx.now };
    }));
  } },
  catalog_search: { roles: readers, async run(ctx, input) {
    const query = input.query === undefined ? '' : str(input.query, 'query').toLowerCase();
    const storeId = input.store_id === undefined ? undefined : id(input.store_id, 'store_id');
    const brandId = input.brand_id === undefined ? undefined : id(input.brand_id, 'brand_id');
    const marketId = input.market_id === undefined ? undefined : id(input.market_id, 'market_id');
    const available = input.available_only === undefined ? false : bool(input.available_only, 'available_only');
    const productStatus = input.status === undefined ? undefined : one(input.status, 'status', productStatuses);
    const variants = (await list(ctx, 'product_variant')).filter(active);
    const listings = available || marketId ? await currentListings(ctx) : [];
    const rows = (await list(ctx, 'product')).filter(row => active(row) && (!storeId || row.data.store_id === storeId) && (!brandId || row.data.brand_id === brandId) && (!productStatus || row.data.status === productStatus));
    return { as_of: ctx.now, items: rows.filter(row => {
      const members = variants.filter(variant => variant.data.product_id === row.id);
      return (!query || [row.data.title, row.data.handle, ...members.map(variant => variant.data.sku)].some(value => value?.toLowerCase().includes(query)))
        && (!(available || marketId) || listings.some(listing => (!marketId || listing.data.market_id === marketId) && (!available || (listing.data.available_for_sale === true && listing.data.availability === 'observed')) && members.some(variant => listing.data.variant_id === variant.id)));
    }).slice(0, integer(input.limit ?? 100, 'limit', 1, 100)) };
  } },
  catalog_get_product: { roles: readers, async run(ctx, input) {
    const product = await live(ctx, 'product', id(input.product_id, 'product_id'));
    const variants = (await list(ctx, 'product_variant')).filter(row => active(row) && row.data.product_id === product.id);
    const variantIds = new Set(variants.map(row => row.id));
    const snapshots = (await currentListings(ctx)).filter(row => variantIds.has(row.data.variant_id));
    const facts = (await list(ctx, 'product_fact')).filter(row => active(row) && row.data.product_id === product.id && row.data.status === 'active' && row.data.category !== 'speculation' && row.data.approved_revision_id);
    return { product, variants, listing_snapshots: snapshots, approved_facts: await Promise.all(facts.map(async fact => ({ fact, revision: await live(ctx, 'product_fact_revision', fact.data.approved_revision_id) }))), as_of: ctx.now };
  } },
  variant_group_suggestions: { roles: readers, async run(ctx, input) {
    const limit = integer(input.limit ?? 40, 'limit', 1, 100);
    const variants = (await list(ctx, 'product_variant')).filter(row => active(row) && row.data.status === 'active' && row.data.barcode);
    const products = new Map((await list(ctx, 'product')).filter(row => active(row) && row.data.status === 'active').map(row => [row.id, row]));
    const linked = new Set((await list(ctx, 'variant_group_member')).filter(row => !row.data.unlinked_at).map(row => row.data.variant_id));
    const candidates = new Map<string, Entity[]>();
    for (const variant of variants) {
      const product = products.get(variant.data.product_id);
      if (!product || linked.has(variant.id)) continue;
      const key = JSON.stringify([product.data.brand_id, variant.data.barcode]);
      const matches = candidates.get(key) ?? [];
      matches.push(variant);
      candidates.set(key, matches);
    }
    const suggestions = [];
    for (const matches of candidates.values()) {
      if (new Set(matches.map(row => row.data.store_id)).size < 2) continue;
      suggestions.push({ variant_ids: matches.map(row => row.id), evidence: 'matching_barcode' });
      if (suggestions.length >= limit) break;
    }
    return { items: suggestions };
  } },
  create_variant_group: { roles: writers, async run(ctx, input) {
    const brandId = input.brand_id == null ? null : (await linked(ctx, 'workspace', 'brand', input.brand_id, 'brand_id')).id;
    const row = await insert(ctx, 'variant_group', { name: str(input.name, 'name'), brand_id: brandId, note: optional(input.note, 'note') });
    await ctx.emit('commerce.variant_group.created', { group_id: row.id });
    return row;
  } },
  link_variant_group: { roles: writers, async run(ctx, input) {
    const variantId = id(input.variant_id, 'variant_id');
    const initial = await live(ctx, 'product_variant', variantId);
    await guard(ctx, initial.data.store_id);
    const variant = await live(ctx, 'product_variant', variantId);
    await store(ctx, variant.data.store_id);
    const product = await live(ctx, 'product', variant.data.product_id);
    const group = await live(ctx, 'variant_group', id(input.group_id, 'group_id'));
    if (group.data.brand_id && group.data.brand_id !== product.data.brand_id) return conflict('brand_mismatch', 'Group and variant brands differ');
    const history = (await list(ctx, 'variant_group_member')).filter(row => active(row) && row.data.variant_id === variantId);
    if (history.some(row => !row.data.unlinked_at)) return conflict('variant_already_linked', 'Variant already belongs to a group');
    const row = await insert(ctx, 'variant_group_member', { group_id: group.id, variant_id: variantId, store_id: variant.data.store_id, linked_via: one(input.linked_via ?? 'manual', 'linked_via', ['manual', 'suggestion_accepted']), evidence: optional(input.evidence, 'evidence'), unlinked_at: null });
    await ctx.emit('commerce.variant_group.linked', { group_id: group.id, variant_id: variantId, member_id: row.id });
    return row;
  } },
  unlink_variant_group: { roles: writers, async run(ctx, input) {
    const memberId = id(input.member_id, 'member_id');
    const initial = await live(ctx, 'variant_group_member', memberId);
    await guard(ctx, initial.data.store_id);
    const member = await live(ctx, 'variant_group_member', memberId);
    version(input, member);
    if (member.data.unlinked_at) return conflict('invalid_state', 'Variant is already unlinked');
    const row = await update(ctx, member, { unlinked_at: ctx.now, unlinked_by: ctx.actorId, unlink_reason: str(input.reason, 'reason') });
    await ctx.emit('commerce.variant_group.unlinked', { group_id: member.data.group_id, variant_id: member.data.variant_id, member_id: member.id });
    return row;
  } },
  transition_change: { roles: writers, async run(ctx, input) {
    const row = await live(ctx, 'change_event', id(input.change_event_id, 'change_event_id'));
    await guard(ctx, row.data.store_id ?? (await live(ctx, 'product', row.data.product_id)).data.store_id);
    const current = await live(ctx, 'change_event', row.id);
    version(input, current);
    if (!['open', 'acknowledged'].includes(current.data.status)) return conflict('invalid_state', 'Change is already closed');
    const status = one(input.status, 'status', ['acknowledged', 'resolved', 'dismissed']);
    if (status === current.data.status) return conflict('invalid_state', 'Change already has the requested status');
    const resolution = status === 'acknowledged' ? {} : { resolved_at: ctx.now, resolved_by: ctx.actorId, resolution_note: str(input.note, 'note') };
    const result = await update(ctx, current, { status, ...resolution });
    await ctx.emit('commerce.change_event.status_changed', { change_event_id: result.id, status });
    return result;
  } },
};
