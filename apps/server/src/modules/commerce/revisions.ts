import { createHash } from 'node:crypto';
import { type Context, type Data, type Input, type Row, Problem } from '@smartsell/contracts';
import { conflict, enumValue, https, invalid, object, one, optional, stringMap, strings, text } from './domain.js';
import { change } from './listings.js';
import { fromAgent } from '../../agent-actor.js';

const factCategories = ['spec', 'claim', 'selling_point', 'usage_scenario', 'marketing_copy', 'speculation'] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const children = (ctx: Context, kind: string, key: string, id: string) => ctx.list(kind).filter(row => row[key] === id);

export function listFacts(ctx: Context, productId: string, approvedOnly: boolean, categories?: string[]): Data[] {
  ctx.get('product', productId);
  return children(ctx, 'product_fact', 'product_id', productId).filter(row => !categories || categories.includes(String(row.category))).flatMap<Data>(row => {
    if (!approvedOnly) return [{ ...row, revisions: children(ctx, 'product_fact_revision', 'fact_id', row.id) }];
    if (row.status !== 'active' || !row.approved_revision_id || row.category === 'speculation') return [];
    const approved = ctx.get('product_fact_revision', String(row.approved_revision_id));
    if (approved.fact_id !== row.id || approved.review_status !== 'approved') return [];
    const { current_revision_id, ...fact } = row;
    return [{ ...fact, ...(current_revision_id === approved.id && { current_revision_id }), approved_revision: approved }];
  });
}
function factValue(input: unknown): Data {
  if (typeof input === 'string') return { type: 'text', text: text(input, 'value') };
  const value = object(input, 'value');
  if (value.type === 'text') return { type: 'text', text: text(value.text, 'value.text') };
  if (value.type === 'locale_text') return { type: 'locale_text', by_locale: stringMap(value.by_locale, 'value.by_locale') };
  if (value.type === 'number' && typeof value.number === 'number' && Number.isFinite(value.number)) return { type: 'number', number: value.number, unit: optional(value.unit, 'value.unit') };
  return invalid('value');
}
export function newFact(ctx: Context, productId: string, body: Data): Row {
  const product = ctx.get('product', productId);
  const variantId = optional(body.variant_id, 'variant_id');
  if (variantId && ctx.get('product_variant', variantId).product_id !== product.id) invalid('variant_id');
  const category = enumValue(body.category, factCategories, 'category');
  const factKey = text(body.fact_key, 'fact_key', 128);
  const marketIds = body.applicable_market_ids == null ? null : strings(body.applicable_market_ids, 'applicable_market_ids');
  marketIds?.forEach(id => ctx.get('market', id));
  if (children(ctx, 'product_fact', 'product_id', product.id).some(row => row.variant_id === variantId && row.fact_key === factKey)) conflict('duplicate_fact', 'Fact key already exists for this product and variant');
  const fact = ctx.create('product_fact', { product_id: product.id, brand_id: product.brand_id, variant_id: variantId, category, fact_key: factKey, applicable_market_ids: marketIds, approved_revision_id: null, status: 'active' });
  return addFactRevision(ctx, fact, body);
}
export function addFactRevision(ctx: Context, fact: Row, body: Data): Row {
  if (fact.status !== 'active') conflict('fact_retracted', 'Fact has been retracted');
  const value = factValue(body.value);
  const evidenceUrls = body.evidence_urls == null ? [] : strings(body.evidence_urls, 'evidence_urls').map(url => https(url, 'evidence_urls').toString());
  const evidenceIds = body.evidence_ids == null ? [] : strings(body.evidence_ids, 'evidence_ids');
  evidenceIds.forEach(id => ctx.get('evidence', id));
  const revision = ctx.create('product_fact_revision', {
    fact_id: fact.id, revision_no: children(ctx, 'product_fact_revision', 'fact_id', fact.id).length + 1, category: fact.category,
    value, evidence_urls: evidenceUrls, evidence_ids: evidenceIds, source: { kind: fromAgent(ctx) ? 'agent' : 'manual', collected_at: ctx.now },
    review_status: 'draft', content_hash: hash({ value, evidenceUrls, evidenceIds, category: fact.category }), created_by_id: ctx.actorId,
  });
  const saved = ctx.update('product_fact', fact.id, { current_revision_id: revision.id });
  ctx.emit('commerce.fact.revised', { product_id: fact.product_id, fact_id: fact.id, revision_id: revision.id });
  return saved;
}
export function reviewFact(ctx: Context, id: string, approved: boolean): Row {
  const revision = ctx.get('product_fact_revision', id);
  const fact = ctx.get('product_fact', String(revision.fact_id));
  if (fact.status !== 'active' || fact.current_revision_id !== id || revision.review_status !== 'draft') conflict('revision_not_reviewable', 'Only the current draft on an active fact is reviewable');
  if (approved && revision.category === 'claim' && !(revision.evidence_urls as string[]).length && !(revision.evidence_ids as string[]).length) invalid('claim evidence');
  const reviewed = ctx.update('product_fact_revision', id, { review_status: approved ? 'approved' : 'rejected', reviewed_by: ctx.actorId, reviewed_at: ctx.now });
  if (approved) {
    const previous = fact.approved_revision_id == null ? undefined : ctx.get('product_fact_revision', String(fact.approved_revision_id));
    ctx.update('product_fact', fact.id, { approved_revision_id: id });
    ctx.emit('commerce.fact.approved', { product_id: fact.product_id, fact_id: fact.id, revision_id: id });
    if (previous && previous.content_hash !== reviewed.content_hash) {
      change(ctx, 'fact_revised', 'review', { product_id: fact.product_id }, previous.id, id);
      markRelatedStale(ctx, String(fact.product_id), `fact:${fact.id}`, String(reviewed.content_hash));
    }
  }
  return reviewed;
}
export function retractFact(ctx: Context, id: string): Row {
  const fact = ctx.get('product_fact', id);
  if (fact.status === 'retracted') return fact;
  const saved = ctx.update('product_fact', id, { status: 'retracted' });
  ctx.emit('commerce.fact.retracted', { product_id: fact.product_id, fact_id: id });
  change(ctx, 'fact_retracted', 'blocking', { product_id: fact.product_id }, fact.approved_revision_id, null);
  markRelatedStale(ctx, String(fact.product_id), `fact:${id}`, hash(null));
  return saved;
}
function sourceRef(ctx: Context, product: Row, field: string): Data {
  if (field.startsWith('fact:')) {
    const fact = ctx.get('product_fact', field.slice(5));
    if (fact.product_id !== product.id || fact.status !== 'active' || !fact.approved_revision_id) invalid('field_key');
    const revision = ctx.get('product_fact_revision', String(fact.approved_revision_id));
    return { kind: 'product_fact_revision', id: revision.id, content_hash: revision.content_hash };
  }
  enumValue(field, ['title', 'description', 'selling_points', 'size_guide'], 'field_key');
  return { kind: 'store_field', id: product.id, content_hash: hash(product[field]) };
}
function markRelatedStale(ctx: Context, productId: string, field: string, sourceHash: string): void {
  for (const row of children(ctx, 'product_localization', 'product_id', productId).filter(row => row.field_key === field && row.status === 'approved')) {
    const active = ctx.get('product_localization_revision', String(row.approved_revision_id));
    if (active.source_hash === sourceHash && (row.source_ref as Data).content_hash === sourceHash) continue;
    ctx.update('product_localization', row.id, { status: 'stale' });
    ctx.emit('commerce.localization.stale', { product_id: productId, localization_id: row.id });
    change(ctx, 'localization_stale', 'review', { product_id: productId, market_id: row.market_id }, (row.source_ref as Data).content_hash, sourceHash);
  }
}
export function markSourceChanges(ctx: Context, product: Row, previous: Row): void {
  for (const field of ['title', 'description', 'selling_points', 'size_guide']) {
    if (hash(product[field]) !== hash(previous[field])) markRelatedStale(ctx, product.id, field, hash(product[field]));
  }
}
/** Agents see every localization's state but only the text a person approved. */
export function listLocalizations(ctx: Context, productId: string): Data[] {
  ctx.get('product', productId);
  const agent = fromAgent(ctx);
  return children(ctx, 'product_localization', 'product_id', productId).map(row => ({ ...row,
    revisions: children(ctx, 'product_localization_revision', 'localization_id', row.id).filter(item => !agent || item.id === row.approved_revision_id) }));
}
export function localizationDraft(ctx: Context, productId: string, input: Input): Row {
  const body = input.body;
  const product = ctx.get('product', productId);
  const field = text(body.field_key, 'field_key', 128);
  const localeInput = text(body.locale, 'locale', 35);
  let locale: string;
  try { locale = Intl.getCanonicalLocales(localeInput)[0] ?? invalid('locale'); } catch { invalid('locale'); }
  const marketId = optional(body.market_id, 'market_id');
  if (marketId) ctx.get('market', marketId);
  const origin = fromAgent(ctx) ? 'agent' : enumValue(body.origin ?? 'human', ['human', 'agent'], 'origin');
  const source = sourceRef(ctx, product, field);
  const revisionText = text(body.text, 'text', 20000);
  const existing = one(children(ctx, 'product_localization', 'product_id', product.id).filter(row => row.field_key === field && row.locale === locale && row.market_id === marketId), 'duplicate_localization', 'Localization key is ambiguous');
  if (existing && (input.expectedVersion ?? body.expected_version) !== existing.version) {
    throw new Problem(input.expectedVersion == null && body.expected_version == null ? 428 : 412, 'version_mismatch', 'A matching localization version is required');
  }
  const row = existing ?? ctx.create('product_localization', {
    product_id: productId, field_key: field, locale, market_id: marketId, source_locale: ctx.get('store', String(product.store_id)).default_locale,
    source_ref: source, status: 'draft', current_revision_id: null, approved_revision_id: null, pending_revision_id: null, writeback_status: 'none',
  });
  const revision = ctx.create('product_localization_revision', {
    localization_id: row.id, revision_no: children(ctx, 'product_localization_revision', 'localization_id', row.id).length + 1,
    text: revisionText, origin, source_hash: source.content_hash, content_hash: hash(revisionText), created_by_id: ctx.actorId,
  });
  return ctx.update('product_localization', row.id, row.status === 'approved'
    ? { pending_revision_id: revision.id }
    : { current_revision_id: revision.id, pending_revision_id: null, status: 'draft', source_ref: source });
}
export function reviewLocalization(ctx: Context, id: string, action: 'submit' | 'approve' | 'reject' | 'accept'): Row {
  const row = ctx.get('product_localization', id);
  const product = ctx.get('product', String(row.product_id));
  if (action === 'submit') {
    if (row.status === 'approved' && row.pending_revision_id) return ctx.update('product_localization', id, { status: 'in_review', current_revision_id: row.pending_revision_id, pending_revision_id: null });
    if (!['draft', 'stale', 'machine_translated'].includes(String(row.status))) conflict('invalid_localization_state', 'Localization cannot be submitted');
    return ctx.update('product_localization', id, { status: 'in_review' });
  }
  if (action === 'reject') {
    if (row.status !== 'in_review') conflict('invalid_localization_state', 'Localization is not in review');
    return ctx.update('product_localization', id, { status: 'draft' });
  }
  if (action === 'accept' ? row.status !== 'stale' || !row.approved_revision_id : row.status !== 'in_review') conflict('invalid_localization_state', 'Localization cannot be approved in this state');
  const revisionId = String(action === 'accept' ? row.approved_revision_id : row.current_revision_id);
  const revision = ctx.get('product_localization_revision', revisionId);
  const source = sourceRef(ctx, product, String(row.field_key));
  if (action === 'approve' && revision.source_hash !== source.content_hash) conflict('source_stale', 'Source changed during review');
  const saved = ctx.update('product_localization', id, { status: 'approved', source_ref: source, approved_revision_id: revisionId });
  ctx.emit('commerce.localization.approved', { product_id: product.id, localization_id: id, revision_id: revisionId });
  return saved;
}
