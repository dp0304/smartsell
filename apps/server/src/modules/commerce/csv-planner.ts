import { DomainError, type Context, type Entity, type Fields } from '../types';
import { type ImportRow, type Issue, type TemplateKey } from './csv-import';
import { active, hash, same, stableId, statusBucket } from './model';
import { mutations } from './mutation';
import { listingInput, recordChange, snapshotKey, writeSnapshot } from './snapshots';

const kinds = ['product', 'product_variant', 'product_localization', 'store_market', 'inventory_location', 'listing_snapshot', 'change_event', 'order', 'refund'] as const;
type View = Awaited<ReturnType<typeof mutations>>;
const zeroCounts = () => ({ new: 0, changed: 0, unchanged: 0, invalid: 0, duplicate: 0 });
const stale = (row: Entity | undefined, data: Fields) => !!(active(row) && row.data.source_updated_at && data.source_updated_at && row.data.source_updated_at > data.source_updated_at);
const error = (line: number, code: string, message: string): Issue => ({ line, code, message, severity: 'error' });

export async function plan(ctx: Context, store: Entity, batchId: string, key: TemplateKey, parsed: ImportRow[], parseIssues: Issue[], sourceKind: 'csv' | 'store_sync' = 'csv') {
  const view = await mutations(ctx, kinds, store.id);
  const issues = [...parseIssues];
  const counts = zeroCounts();
  counts.invalid = parseIssues.length;
  const rows: { line: number; status: keyof typeof counts; values: Fields }[] = [];
  const seen = new Map<string, string>();
  const source = sourceKind === 'csv' ? { kind: sourceKind, provider: store.data.provider, batch_id: batchId } : { kind: sourceKind, provider: store.data.provider };
  const provenance = sourceKind === 'csv' ? { batch_id: batchId } : {};
  const unique = (kind: string, value: string) => stableId(ctx.workspaceId, kind, store.id, value);
  const settings = view.rows('store_market').filter(row => row.data.enabled);
  const affected = new Map<string, Entity>();
  const productAliases = new Map<string, string>();

  function register(row: ImportRow, key: string) {
    const valueHash = hash(row.values);
    const previous = seen.get(key);
    if (previous === valueHash) {
      issues.push({ line: row.line, code: 'dup_in_file', message: 'Identical duplicate skipped', severity: 'warning' });
      return 'duplicate' as const;
    }
    if (previous !== undefined) {
      issues.push(error(row.line, 'conflicting_duplicate', 'Rows with the same merge key disagree'));
      return 'invalid' as const;
    }
    seen.set(key, valueHash);
    return undefined;
  }
  function merge(kind: string, id: string, data: Fields) {
    const existing = view.get(kind, id);
    if (stale(existing, data) || (active(existing) && same(existing.data, data))) return 'unchanged' as const;
    view.put(kind, id, { ...data, store_id: store.id, source, rolled_back: false });
    view.event(`commerce.${kind}.upserted`, { [`${kind}_id`]: id, store_id: store.id, ...provenance });
    return active(existing) ? 'changed' as const : 'new' as const;
  }
  function current(variant: Entity, setting: Entity) {
    return view.rows('listing_snapshot').find(row => row.data.is_current && snapshotKey(row, variant.id, setting.data.market_id, setting.data.channel));
  }
  function purchaseFromSetting(variant: Entity, setting: Entity) {
    const template = setting.data.purchase_url_template;
    if (!template) return null;
    const product = view.get('product', variant.data.product_id);
    const tokens: Fields = { variant_id: variant.data.external_variant_id ?? variant.id, handle: product?.data.handle, locale: setting.data.locale ?? store.data.default_locale, sku: variant.data.sku, market_id: setting.data.market_id };
    if ([...template.matchAll(/\{([a-z_]+)\}/g)].some(match => !tokens[match[1]])) return null;
    return template.replace(/\{([a-z_]+)\}/g, (_: string, token: string) => encodeURIComponent(tokens[token]));
  }
  function productRow(row: ImportRow): keyof typeof counts {
    const { values: v } = row;
    const productAlias = JSON.stringify([v.external_product_id ?? null, v.handle ?? null, v.external_product_id || v.handle ? null : v.sku]);
    const productId = productAliases.get(productAlias) ?? unique('product', JSON.stringify(v.external_product_id ? ['external', v.external_product_id] : v.handle ? ['handle', v.handle] : ['sku', v.sku]));
    const matchingVariant = !v.external_variant_id && v.sku ? view.rows('product_variant').filter(variant => variant.data.product_id === productId && variant.data.sku === v.sku && (!v.option_values || same(variant.data, { option_values: v.option_values }))) : [];
    if (matchingVariant.length > 1) throw new DomainError('ambiguous_variant', 'More than one existing variant matches the row');
    const variantId = matchingVariant[0]?.id ?? unique('product_variant', JSON.stringify(v.external_variant_id ? ['external', v.external_variant_id] : [productId, v.sku ?? null, v.option_values ?? []]));
    const product = view.get('product', productId);
    const variant = view.get('product_variant', variantId);
    if (active(variant) && variant.data.product_id !== productId) throw new DomainError('variant_product_conflict', 'Variant belongs to a different product');
    if (!active(product) && !v.title) throw new DomainError('title_required', 'Title is required for a new product');
    const selected = settings.filter(setting => (!v.market_id || setting.data.market_id === v.market_id) && (!v.channel || setting.data.channel === v.channel));
    if (v.market_id && !selected.length) throw new DomainError('store_market_not_found', 'No enabled store market matches the row');
    const duplicate = register(row, JSON.stringify([variantId, v.market_id ?? null, v.channel ?? null]));
    if (duplicate) return duplicate;
    if (stale(product, v) || stale(variant, v)) {
      issues.push({ line: row.line, code: 'stale_source', message: 'Older source data skipped', severity: 'warning' });
      return 'unchanged';
    }
    productAliases.set(productAlias, productId);
    const pick = (keys: string[]) => Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
    const patch = { ...pick(['external_product_id', 'handle', 'title', 'product_type', 'vendor', 'status', 'source_updated_at']), brand_id: store.data.brand_id ?? null, status: v.status ?? (active(product) ? product.data.status : 'active') };
    const p = merge('product', productId, patch);
    if (v.title && active(product) && product.data.title !== v.title) {
      for (const localization of view.rows('product_localization')) {
        if (localization.data.product_id !== productId || localization.data.field_key !== 'title' || localization.data.status === 'stale') continue;
        view.put('product_localization', localization.id, { status: 'stale', source_ref: { ...localization.data.source_ref, content_hash: hash(v.title) } });
        const change = { store_id: store.id, product_id: productId, change_type: 'localization_stale', severity: 'review' };
        recordChange(ctx, view, change, { localization_id: localization.id }, { localization_id: localization.id }, `${batchId}:${localization.id}`);
        view.event('commerce.localization.stale', { localization_id: localization.id, product_id: productId });
      }
    }
    if (v.status === 'removed_at_source' && active(product) && product.data.status !== v.status) {
      view.event('commerce.product.removed_at_source', { product_id: productId, store_id: store.id, batch_id: batchId });
      recordChange(ctx, view, { store_id: store.id, product_id: productId, change_type: 'product_removed', severity: 'blocking' }, { status: product.data.status }, { status: v.status }, `${batchId}:${productId}`);
    }
    const q = merge('product_variant', variantId, { ...pick(['external_variant_id', 'sku', 'barcode', 'options', 'option_values', 'source_updated_at']), product_id: productId, status: v.variant_status ?? (active(variant) ? variant.data.status : 'active') });
    const activeVariant = view.get('product_variant', variantId)!;
    let listingChanged = false;
    for (const setting of selected) {
      const prev = current(activeVariant, setting);
      const localized = v.market_id ? v.price_amount_minor ?? v.international_minor : (settings.length === 1 ? v.international_minor : undefined);
      const base = setting.data.price_source === 'store_base_price' ? v.price_amount_minor : undefined;
      const isMultiLocation = store.data.sync_scope?.inventory_source === 'inventory_list';
      const quantity = isMultiLocation ? prev?.data.inventory_quantity : v.inventory_quantity ?? prev?.data.inventory_quantity;
      const forSale = isMultiLocation ? prev?.data.available_for_sale : v.available_for_sale ?? prev?.data.available_for_sale;
      const price = localized ?? base;
      const shouldPublish = price !== undefined || (!isMultiLocation && (v.inventory_quantity !== undefined || v.available_for_sale !== undefined)) || v.purchase_url;
      if (!shouldPublish || stale(prev, v)) continue;
      const priceSource = localized !== undefined ? 'store_market_price' : base !== undefined ? 'store_base_price' : prev?.data.price_source ?? setting.data.price_source;
      const chosenUrl = v.purchase_url ?? prev?.data.purchase_url ?? purchaseFromSetting(activeVariant, setting);
      const details = listingInput({
        price_amount_minor: price ?? prev?.data.price_amount_minor, compare_at_amount_minor: price !== undefined ? v.compare_at_amount_minor : prev?.data.compare_at_amount_minor,
        currency: price !== undefined ? v.currency : prev?.data.currency, price_source: priceSource,
        inventory_quantity: quantity, available_for_sale: forSale, purchase_url: chosenUrl, source_updated_at: v.source_updated_at ?? prev?.data.source_updated_at,
      }, setting, store);
      if (prev && same(prev.data, details)) continue;
      writeSnapshot(ctx, view, activeVariant, setting, { ...details, source: { ...source, locations: prev?.data.source?.locations ?? null } }, `${batchId}:${row.line}`);
      listingChanged = true;
    }
    return p === 'new' || q === 'new' ? 'new' : p === 'changed' || q === 'changed' || listingChanged ? 'changed' : 'unchanged';
  }
  function inventoryRow(row: ImportRow): keyof typeof counts {
    const v = row.values;
    const optionValues = [v.option_1_value, v.option_2_value, v.option_3_value].filter(Boolean);
    const products = new Set(view.rows('product').filter(product => product.data.handle === v.handle).map(product => product.id));
    const variants = view.rows('product_variant');
    const byHandle = v.handle ? variants.filter(variant => products.has(variant.data.product_id) && same({ options: variant.data.option_values ?? [] }, { options: optionValues })) : [];
    const matches = byHandle.length ? byHandle : (v.sku ? variants.filter(variant => variant.data.sku === v.sku) : []);
    if (!matches.length) throw new DomainError('variant_not_found', 'Inventory row has no matching variant');
    if (matches.length !== 1) throw new DomainError('ambiguous_variant', 'Inventory row matches multiple variants');
    const variant = matches[0];
    const locationId = unique('inventory_location', JSON.stringify([variant.id, v.location]));
    const duplicate = register(row, locationId);
    if (duplicate) return duplicate;
    const status = merge('inventory_location', locationId, { variant_id: variant.id, location: v.location, inventory_quantity: v.inventory_quantity });
    if (status !== 'unchanged') affected.set(variant.id, variant);
    return status;
  }
  for (const row of parsed) {
    let status: keyof typeof counts;
    try {
      if (key === 'product_list') status = productRow(row);
      else if (key === 'inventory_list') status = inventoryRow(row);
      else {
        const v = row.values;
        const orderId = unique('order', v.external_order_id);
        if (key === 'order_list') status = register(row, orderId) ?? merge('order', orderId, v);
        else {
          const order = view.get('order', orderId);
          if (!active(order)) throw new DomainError('order_not_found', 'Refund order must be imported first');
          if (order.data.currency !== v.currency) throw new DomainError('currency_mismatch', 'Refund currency differs from order currency');
          const refundId = unique('refund', row.key);
          status = register(row, refundId) ?? merge('refund', refundId, { ...v, order_id: orderId });
        }
      }
    } catch (failure) {
      if (!(failure instanceof DomainError)) throw failure;
      issues.push(error(row.line, failure.code, failure.message));
      status = 'invalid';
    }
    counts[status]++;
    rows.push({ line: row.line, status, values: row.values });
  }
  if (key === 'inventory_list' && !counts.invalid) {
    for (const variant of affected.values()) {
      for (const setting of settings) {
        const prev = current(variant, setting);
        const locations = view.rows('inventory_location').filter(row => row.data.variant_id === variant.id && (!setting.data.inventory_locations || setting.data.inventory_locations.includes(row.data.location)));
        const entries = locations.map(row => [row.data.location, row.data.inventory_quantity] as const).sort(([a], [b]) => a.localeCompare(b));
        const quantity = locations.length ? locations.reduce((sum, row) => sum + row.data.inventory_quantity, 0) : null;
        const ineligibleBase = prev?.data.price_source === 'store_base_price' && setting.data.price_source !== 'store_base_price';
        const details = listingInput({
          price_amount_minor: ineligibleBase ? null : prev?.data.price_amount_minor, compare_at_amount_minor: ineligibleBase ? null : prev?.data.compare_at_amount_minor,
          currency: ineligibleBase ? null : prev?.data.currency, price_source: ineligibleBase ? setting.data.price_source : prev?.data.price_source,
          inventory_quantity: quantity, available_for_sale: quantity === null ? null : quantity > 0,
          purchase_url: prev?.data.purchase_url ?? purchaseFromSetting(variant, setting), source_updated_at: prev?.data.source_updated_at,
        }, setting, store);
        writeSnapshot(ctx, view, variant, setting, { ...details, inventory_status: statusBucket(quantity, setting.data.low_stock_threshold ?? null), source: { ...source, locations: Object.fromEntries(entries) } }, batchId);
      }
    }
  }
  const signature = hash(store.version, settings.map(row => [row.id, row.version]).sort(), counts, issues, view.writes().map(write => [write.kind, write.id, write.before?.version ?? 0, Object.fromEntries(Object.entries(write.patch).filter(([field]) => !['observed_at', 'detected_at'].includes(field)))]));
  return { rows, issues: issues.sort((a, b) => a.line - b.line), counts, signature, view };
}
