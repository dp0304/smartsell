import { APPROVE, READ, WRITE, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { channels, conflict, enumValue, invalid, object, optional, stringMap, text, upsert } from './domain.js';
import { currentListing, listingView, prepareListing, writeListing } from './listings.js';
import { addFactRevision, listFacts, listLocalizations, localizationDraft, markSourceChanges, newFact, retractFact, reviewFact, reviewLocalization } from './revisions.js';
import { COMMERCE_WRITE } from './store-operations.js';
import { fromAgent } from '../../agent-actor.js';

function variants(ctx: Context, id: string): Row[] {
  return ctx.list('product_variant').filter(row => row.product_id === id);
}
function related(ctx: Context, id: string): Data {
  const members = new Set(variants(ctx, id).map(row => row.id));
  const facts = new Set(ctx.list('product_fact').filter(row => row.product_id === id).map(row => row.id));
  const snapshots = new Set(ctx.list('listing_snapshot').filter(row => members.has(String(row.variant_id))).map(row => row.id));
  const revisions = new Set(ctx.list('product_fact_revision').filter(row => facts.has(String(row.fact_id))).map(row => row.id));
  const references = ctx.list('content_reference').filter(row => row.product_id === id || members.has(String(row.variant_id)) ||
    (row.resource_type === 'product' && row.resource_id === id) || (row.ref_type === 'product' && row.ref_id === id) ||
    (row.ref_type === 'product_variant' && members.has(String(row.ref_id))) ||
    snapshots.has(String(row.listing_snapshot_id)) || revisions.has(String(row.fact_revision_id)));
  const targets = ctx.list('publish_target_ref').filter(row => (row.ref_type === 'product_variant' && members.has(String(row.ref_id))) ||
    (row.ref_type === 'product' && row.ref_id === id) || snapshots.has(String(row.listing_snapshot_id)) || revisions.has(String(row.fact_revision_id)));
  const campaignLinks = ctx.list('campaign_product').filter(row => row.product_id === id);
  const linkedCampaigns = new Set(campaignLinks.map(row => row.campaign_id));
  const assetLinks = ctx.list('asset_link').filter(row => (row.link_type === 'product' && row.link_id === id) ||
    (row.link_type === 'product_variant' && members.has(String(row.link_id))));
  return { references, publish_target_ids: [...new Set(targets.map(row => row.publish_target_id))], campaigns: ctx.list('campaign').filter(row => linkedCampaigns.has(row.id)), campaign_links: campaignLinks, asset_links: assetLinks };
}
function checkedPriceTargets(ctx: Context, snapshotIds: Set<unknown>) {
  const bySnapshot = new Map<unknown, Set<string>>();
  if (!snapshotIds.size) return bySnapshot;
  // Historical prechecks retain the exact listing snapshot that affected each target.
  const runs = new Map(ctx.list('precheck_run').map(run => [run.id, run.publish_target_id]));
  for (const item of ctx.list('precheck_item')) {
    if (item.check_key !== 'product_fact' || !['risk', 'blocker'].includes(String(item.severity))) continue;
    const { old_snapshot_id, snapshot_id } = (item.detail ?? {}) as Data;
    const targetId = runs.get(String(item.run_id));
    if (!old_snapshot_id || !snapshotIds.has(snapshot_id) || typeof targetId !== 'string') continue;
    const ids = bySnapshot.get(snapshot_id) ?? new Set<string>();
    ids.add(targetId);
    bySnapshot.set(snapshot_id, ids);
  }
  return bySnapshot;
}
function getProduct(ctx: Context, id: string): Data {
  const product = ctx.get('product', id);
  const rows = variants(ctx, id);
  const ids = new Set(rows.map(row => row.id));
  const listings = ctx.list('listing_snapshot').filter(row => row.is_current === true && ids.has(String(row.variant_id))).map(row => listingView(ctx, row));
  return { ...product, variants: rows, listings, facts: listFacts(ctx, id, true), localizations: listLocalizations(ctx, id).filter(row => !fromAgent(ctx) || row.status === 'approved'), usage: related(ctx, id) };
}
function search(ctx: Context, input: Input): Data[] {
  const filters = { ...input.body, ...input.query };
  const query = String(filters.query ?? '').trim().toLowerCase();
  const rows = ctx.list('product_variant');
  const listings = ctx.list('listing_snapshot').filter(row => row.is_current === true);
  return ctx.list('product').filter(product => {
    for (const key of ['brand_id', 'store_id', 'status']) if (filters[key] && product[key] !== filters[key]) return false;
    const siblings = rows.filter(row => row.product_id === product.id);
    if (filters.sku && !siblings.some(row => row.sku === filters.sku)) return false;
    if (query && ![product.title, product.handle, ...siblings.map(row => row.sku)].some(value => typeof value === 'string' && value.toLowerCase().includes(query))) return false;
    const available = filters.available_only === 'true' || filters.available_only === true;
    if (filters.market_id || available) return listings.some(row => siblings.some(sibling => sibling.id === row.variant_id) && (!filters.market_id || filters.market_id === row.market_id) && (!available || row.available_for_sale === true && row.availability === 'observed' && listingView(ctx, row).stale === false));
    return true;
  }).map(product => ({ ...product, as_of: ctx.now }));
}
function manualProduct(ctx: Context, body: Data, previous?: Row): Row {
  const store = ctx.get('store', previous ? String(previous.store_id) : text(body.store_id, 'store_id'));
  if (store.status === 'disabled') conflict('store_disabled', 'Store is disabled');
  const patch: Data = {};
  if (!previous) Object.assign(patch, { store_id: store.id, brand_id: store.brand_id, external_product_id: null, source: { kind: 'manual' } });
  if (!previous || 'title' in body) patch.title = text(body.title, 'title');
  if (!previous || 'status' in body) patch.status = enumValue(body.status ?? 'draft', ['active', 'draft', 'archived'], 'status');
  for (const field of ['handle', 'description', 'product_type', 'vendor', 'selling_points', 'size_guide']) if (field in body) patch[field] = optional(body[field], field);
  if ('primary_asset_id' in body) patch.primary_asset_id = body.primary_asset_id == null ? null : ctx.get('asset', text(body.primary_asset_id, 'primary_asset_id')).id;
  const saved = upsert(ctx, 'product', previous, patch);
  if (!previous || saved.version !== previous.version) ctx.emit('commerce.product.upserted', { product_id: saved.id, store_id: store.id });
  if (previous) markSourceChanges(ctx, saved, previous);
  return saved;
}
function groupSuggestions(ctx: Context): Data[] {
  const rows = ctx.list('product_variant').filter(row => row.barcode && row.status === 'active');
  const active = ctx.list('variant_group_member').filter(row => !row.unlinked_at);
  const result: Data[] = [];
  for (const [i, a] of rows.entries()) for (const b of rows.slice(i + 1)) {
    if (a.store_id === b.store_id || a.barcode !== b.barcode) continue;
    if (active.some(link => link.variant_id === a.id || link.variant_id === b.id)) continue;
    if (ctx.get('product', String(a.product_id)).brand_id !== ctx.get('product', String(b.product_id)).brand_id) continue;
    result.push({ id: `${a.id}:${b.id}`, brand_id: ctx.get('product', String(a.product_id)).brand_id, barcode: a.barcode,
      variant_ids: [a.id, b.id], variants: [a, b].map(row => ({ id: row.id, sku: row.sku, store_id: row.store_id, product_id: row.product_id })), reason: 'same_barcode' });
  }
  return result;
}
function groupMembers(ctx: Context): Data[] {
  const variantsById = new Map(ctx.list('product_variant').map(variant => [variant.id, variant]));
  return ctx.list('variant_group_member').map(row => {
    const variant = variantsById.get(String(row.variant_id));
    return { ...row, store_id: row.store_id ?? variant?.store_id, product_id: variant?.product_id, sku: variant?.sku };
  });
}
function linkGroupMembers(ctx: Context, group: Row, inputs: Data[], via: 'manual' | 'suggestion_accepted'): Row[] {
  const active = new Set(ctx.list('variant_group_member').filter(row => !row.unlinked_at).map(row => row.variant_id));
  const members = inputs.map(input => {
    const variant = ctx.get('product_variant', text(input.variant_id, 'variant_id'));
    if (ctx.get('product', String(variant.product_id)).brand_id !== group.brand_id) invalid('variant_id');
    if (active.has(variant.id)) conflict('variant_already_linked', 'Variant already has an active mapping');
    active.add(variant.id);
    return { group_id: group.id, variant_id: variant.id, store_id: variant.store_id, linked_by: ctx.actorId,
      linked_via: via, evidence: optional(input.evidence, 'evidence'), unlinked_at: null };
  });
  return members.map(member => ctx.create('variant_group_member', member));
}
export const catalogOperations: Operation[] = [
  { path: '/products', method: 'GET', name: 'catalog_search', roles: READ, summary: 'Search catalog by store, SKU, market or availability', run: search },
  { path: '/products', method: 'POST', name: 'commerce_product_create', roles: COMMERCE_WRITE, summary: 'Create an internal catalog product', run: (ctx, { body }) => manualProduct(ctx, body) },
  { path: '/products/:id', method: 'GET', name: 'catalog_get_product', roles: READ, summary: 'Read product, variants, approved facts and listings', run: (ctx, { params, body }) => getProduct(ctx, params.id ?? text(body.product_id, 'product_id')) },
  { path: '/products/:id', method: 'PATCH', name: 'commerce_product_update', roles: COMMERCE_WRITE, versionKind: 'product', summary: 'Update internal catalog fields', run: (ctx, { params, body }) => manualProduct(ctx, body, ctx.get('product', params.id!)) },
  { path: '/products/:id/usage', method: 'GET', name: 'commerce_product_usage', roles: READ, summary: 'Read catalog usage', run(ctx, { params }) { return related(ctx, ctx.get('product', params.id!).id); } },
  { path: '/products/:id/variants', method: 'POST', name: 'commerce_variant_create', roles: COMMERCE_WRITE, summary: 'Create a local variant', run(ctx, { params, body }) {
    const product = ctx.get('product', params.id!);
    const row = ctx.create('product_variant', { product_id: product.id, store_id: product.store_id, external_variant_id: null, sku: optional(body.sku, 'sku'), barcode: optional(body.barcode, 'barcode'), options: stringMap(body.options ?? {}, 'options'), status: enumValue(body.status ?? 'active', ['active', 'archived'], 'status'), source: { kind: 'manual' } });
    ctx.emit('commerce.product.upserted', { product_id: product.id, variant_id: row.id });
    return row;
  } },
  { path: '/variants/:id', method: 'PATCH', name: 'commerce_variant_update', roles: COMMERCE_WRITE, versionKind: 'product_variant', summary: 'Update local variant information', run(ctx, { params, body }) {
    const variant = ctx.get('product_variant', params.id!);
    const patch: Data = {};
    for (const field of ['sku', 'barcode']) if (field in body) patch[field] = optional(body[field], field);
    if ('options' in body) patch.options = stringMap(body.options, 'options');
    if ('status' in body) patch.status = enumValue(body.status, ['active', 'archived'], 'status');
    return upsert(ctx, 'product_variant', variant, patch);
  } },
  { path: '/variants/:id/listings', method: 'GET', name: 'market_snapshot', roles: READ, summary: 'Read current and historical listing observations', run(ctx, { params, query, body }) {
    const ids = params.id ? [params.id] : Array.isArray(body.variant_ids) ? body.variant_ids.map(value => text(value, 'variant_id')) : invalid('variant_ids');
    ids.forEach(id => ctx.get('product_variant', id));
    const filters = { ...body, ...query };
    return ctx.list('listing_snapshot').filter(row => ids.includes(String(row.variant_id)) && (params.id || row.is_current === true) && (!filters.market_id || row.market_id === filters.market_id) && (!filters.channel || row.channel === filters.channel)).sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at))).map(row => listingView(ctx, row));
  } },
  { path: '/variants/:id/listings', method: 'POST', name: 'commerce_record_listing', roles: COMMERCE_WRITE, summary: 'Record a local market observation', run(ctx, { params, body }) {
    const variant = ctx.get('product_variant', params.id!);
    const store = ctx.get('store', String(variant.store_id));
    const marketId = text(body.market_id, 'market_id');
    const channel = enumValue(body.channel, channels, 'channel');
    const config = ctx.list('store_market').find(row => row.store_id === store.id && row.market_id === marketId && row.channel === channel && row.enabled === true) ?? invalid('store_market');
    const snapshot = prepareListing(ctx, store, config, body, currentListing(ctx, variant.id, config), { kind: 'manual', actor_id: ctx.actorId }, false);
    return listingView(ctx, writeListing(ctx, variant, config, snapshot, true));
  } },
  { path: '/variant-groups/suggestions', method: 'GET', name: 'commerce_variant_group_suggest', roles: READ, summary: 'Suggest same-barcode variant pairs for manual review', run: groupSuggestions },
  { path: '/variant-groups', method: 'GET', name: 'commerce_variant_group_list', roles: READ, summary: 'List mapping groups and their history', run(ctx) {
    const members = groupMembers(ctx);
    return ctx.list('variant_group').map(group => ({ ...group, members: members.filter(row => row.group_id === group.id) }));
  } },
  { path: '/variant-groups', method: 'POST', name: 'commerce_variant_group_create', roles: COMMERCE_WRITE, summary: 'Create a human-managed mapping group', run(ctx, { body }) {
    const brand = ctx.get('brand', text(body.brand_id, 'brand_id'));
    return ctx.create('variant_group', { brand_id: brand.id, name: text(body.name, 'name'), note: optional(body.note, 'note') });
  } },
  { path: '/variant-groups/:id/members', method: 'GET', name: 'commerce_variant_group_member_list', roles: READ, summary: 'Read active and historical group members', run(ctx, { params }) {
    const group = ctx.get('variant_group', params.id!);
    return ctx.list('variant_group_member').filter(row => row.group_id === group.id);
  } },
  { path: '/variant-groups/:id/members', method: 'POST', name: 'commerce_variant_group_link', roles: COMMERCE_WRITE, summary: 'Confirm a manual variant mapping', run(ctx, { params, body }) {
    const group = ctx.get('variant_group', params.id!);
    const via = enumValue(body.linked_via ?? 'manual', ['manual', 'suggestion_accepted'], 'linked_via');
    return linkGroupMembers(ctx, group, [body], via)[0];
  } },
  { path: '/variant-groups/:id/members/batch', method: 'POST', name: 'commerce_variant_group_link_batch', roles: COMMERCE_WRITE, summary: 'Confirm a reviewed batch of variant mappings', run(ctx, { params, body }) {
    const group = ctx.get('variant_group', params.id!);
    const members = body.members;
    if (!Array.isArray(members) || members.length < 2 || members.length > 100) return invalid('members');
    const via = enumValue(body.linked_via ?? 'manual', ['manual', 'suggestion_accepted'], 'linked_via');
    return linkGroupMembers(ctx, group, members.map(member => object(member, 'member')), via);
  } },
  { path: '/variant-groups/:id/members/:memberId', method: 'DELETE', name: 'commerce_variant_group_unlink', roles: COMMERCE_WRITE, summary: 'Unlink a mapping without removing its history', run(ctx, { params, body }) {
    const row = ctx.get('variant_group_member', params.memberId!);
    if (row.group_id !== params.id) invalid('memberId');
    return row.unlinked_at ? row : ctx.update('variant_group_member', row.id, { unlinked_at: ctx.now, unlinked_by: ctx.actorId, unlink_reason: optional(body.reason, 'reason') });
  } },
  { path: '/products/:id/facts', method: 'GET', name: 'catalog_list_facts', roles: READ, summary: 'Read approved facts or review fact history', run: (ctx, { params, query, body }) => listFacts(ctx, params.id ?? text(body.product_id, 'product_id'), fromAgent(ctx) || (query.approved_only !== 'false' && body.approved_only !== false), Array.isArray(body.category) ? body.category.map(String) : query.category?.split(',')) },
  { path: '/products/:id/facts', method: 'POST', name: 'catalog_propose_fact', roles: WRITE, summary: 'Propose a draft product fact', run: (ctx, { params, body }) => newFact(ctx, params.id ?? text(body.product_id, 'product_id'), body) },
  { path: '/facts/:id/revisions', method: 'POST', name: 'commerce_fact_revise', roles: WRITE, versionKind: 'product_fact', summary: 'Add a draft revision to a fact', run: (ctx, { params, body }) => addFactRevision(ctx, ctx.get('product_fact', params.id!), body) },
  ...([['approve', true], ['reject', false]] as const).map(([action, approve]): Operation => ({ path: `/fact-revisions/:id/${action}`, method: 'POST', name: `commerce_fact_${action}`, roles: APPROVE, summary: `${action} the current fact draft`, run: (ctx, { params }) => reviewFact(ctx, params.id!, approve) })),
  { path: '/facts/:id/retract', method: 'POST', name: 'commerce_fact_retract', roles: APPROVE, versionKind: 'product_fact', summary: 'Retract an active fact', run: (ctx, { params }) => retractFact(ctx, params.id!) },
  { path: '/products/:id/localizations', method: 'GET', name: 'commerce_localization_list', roles: READ, summary: 'Read localization matrix and revision history', run: (ctx, { params }) => listLocalizations(ctx, params.id!) },
  { path: '/products/:id/localizations', method: 'PUT', name: 'catalog_update_localization', roles: WRITE, summary: 'Draft a translation without changing the approved revision', run: (ctx, input) => localizationDraft(ctx, input.params.id ?? text(input.body.product_id, 'product_id'), input) },
  ...([['submit', 'submit'], ['approve', 'approve'], ['reject', 'reject'], ['accept-source-change', 'accept']] as const).map(([path, action]): Operation => ({ path: `/localizations/:id/${path}`, method: 'POST', name: `commerce_localization_${action}`, roles: action === 'submit' ? COMMERCE_WRITE : APPROVE, versionKind: 'product_localization', summary: `Review localization: ${path}`, run: (ctx, { params }) => reviewLocalization(ctx, params.id!, action) })),
  { path: '/change-events', method: 'GET', name: 'commerce_list_changes', roles: READ, summary: 'List detected catalog changes', run(ctx, { body, query }) {
    const filters = { ...body, ...query };
    const campaignProducts = filters.campaign_id ? new Set(ctx.list('campaign_product').filter(row => row.campaign_id === filters.campaign_id).map(row => row.product_id)) : null;
    const changes = ctx.list('change_event').filter(row => (!filters.status || row.status === filters.status) && (!filters.since || String(row.detected_at) >= String(filters.since)) && (!filters.product_id || row.product_id === filters.product_id) && (!campaignProducts || campaignProducts.has(row.product_id)));
    if (!changes.length) return [];
    const targetRefs = changes.some(row => row.change_type !== 'price_changed') ? ctx.list('publish_target_ref') : [];
    const priceTargets = checkedPriceTargets(ctx, new Set(changes.filter(row => row.change_type === 'price_changed').map(row => row.snapshot_id)));
    const targets = new Map(priceTargets.size ? ctx.list('publish_target').map(row => [row.id, row]) : []);
    const content = new Map(priceTargets.size ? ctx.list('content_item').map(row => [row.id, row.title]) : []);
    const products = new Map(ctx.list('product').map(row => [row.id, row.title]));
    const skus = new Map(ctx.list('product_variant').map(row => [row.id, row.sku]));
    return changes.map(row => {
      const change = { ...row, product_title: products.get(String(row.product_id)), sku: skus.get(String(row.variant_id)) };
      if (row.change_type !== 'price_changed') return { ...change, affected_target_count: new Set(targetRefs.filter(ref =>
        (ref.ref_type === 'product' && ref.ref_id === row.product_id) || (row.variant_id != null && ref.ref_type === 'product_variant' && ref.ref_id === row.variant_id),
      ).map(ref => ref.publish_target_id)).size };
      const affected_targets = [...(priceTargets.get(row.snapshot_id) ?? [])].flatMap(id => {
        const target = targets.get(id);
        if (!target) return [];
        return [{ id, title: target.title ?? content.get(String(target.content_item_id)), scheduled_at: target.scheduled_at, local_scheduled_at: target.local_scheduled_at }];
      });
      return { ...change, affected_target_count: affected_targets.length, affected_targets };
    });
  } },
  ...([['acknowledge', 'acknowledged'], ['resolve', 'resolved'], ['dismiss', 'dismissed']] as const).map(([action, status]): Operation => ({ path: `/change-events/:id/${action}`, method: 'POST', name: `commerce_change_${action}`, roles: COMMERCE_WRITE, versionKind: 'change_event', summary: `${action} a commerce change`, run(ctx, { params, body }) {
    const row = ctx.get('change_event', params.id!);
    if (row.status === status) return row;
    if (!['open', 'acknowledged'].includes(String(row.status))) conflict('change_closed', 'Change event is closed');
    return ctx.update('change_event', row.id, { status, resolution_note: optional(body.note, 'note'), ...(status === 'acknowledged' ? { acknowledged_by: ctx.actorId, acknowledged_at: ctx.now } : { resolved_by: ctx.actorId, resolved_at: ctx.now }) });
  } })),
];
