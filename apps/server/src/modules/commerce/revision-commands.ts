import { DomainError, readers, reviewers, writers, type Commands, type Context, type Entity, type Fields } from '../types';
import { active, bad, conflict, get, guard, hash, id, insert, list, live, locale, obj, one, stableId, store, str, update, url, version } from './model';
import { mutations } from './mutation';
import { recordChange } from './snapshots';

const categories = ['spec', 'claim', 'selling_point', 'usage_scenario', 'marketing_copy', 'speculation'] as const;
const array = (value: unknown, field: string, convert: (value: unknown) => string) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) return bad(field);
  return [...new Set(value.map(convert))];
};
async function guarded(ctx: Context, kind: string, key: string) {
  const initial = await live(ctx, kind, key);
  await guard(ctx, initial.data.store_id);
  await store(ctx, initial.data.store_id);
  return live(ctx, kind, key);
}
function factValue(input: unknown): Fields {
  const value = obj(input, 'value');
  const type = one(value.type, 'value.type', ['text', 'number', 'locale_text']);
  if (type === 'text') return { type, text: str(value.text, 'value.text', 10000) };
  if (type === 'number') {
    if (typeof value.number !== 'number' || !Number.isFinite(value.number)) return bad('value.number');
    return { type, number: value.number, unit: value.unit == null ? null : str(value.unit, 'unit', 80) };
  }
  const translations = Object.entries(obj(value.by_locale, 'value.by_locale'));
  if (!translations.length || translations.length > 40) return bad('value.by_locale');
  const byLocale = Object.fromEntries(translations.map(([key, text]) => [locale(key), str(text, 'locale text', 10000)]));
  if (Object.keys(byLocale).length !== translations.length) return bad('value.by_locale');
  return { type, by_locale: byLocale };
}
async function workspaceMarket(ctx: Context, market: string) {
  const row = await ctx.get('workspace', 'market', market);
  if (!active(row) || row.data.status === 'archived') throw new DomainError('not_found', 'Market not found', 404);
}
async function change(ctx: Context, row: Entity, type: string, severity: string, before: Fields, after: Fields) {
  const view = await mutations(ctx, ['change_event'], row.data.store_id);
  recordChange(ctx, view, { store_id: row.data.store_id, change_type: type, severity, product_id: row.data.product_id }, before, after, `${row.id}:${row.version}`);
  await view.persist();
}
async function markFactLocalizations(ctx: Context, fact: Entity, sourceHash: string | null) {
  for (const localization of (await list(ctx, 'product_localization')).filter(row => active(row) && row.data.field_key === `fact:${fact.id}`)) {
    if (localization.data.source_ref.content_hash === sourceHash) continue;
    const row = await update(ctx, localization, { status: 'stale', source_ref: { ...localization.data.source_ref, content_hash: sourceHash } });
    await change(ctx, row, 'localization_stale', 'review', {}, { localization_id: row.id });
    await ctx.emit('commerce.localization.stale', { product_id: fact.data.product_id, localization_id: row.id });
  }
}
async function localizationSource(ctx: Context, product: Entity, field: string) {
  if (field === 'title') return { kind: 'store_field', id: product.id, content_hash: hash(product.data.title) };
  if (!field.startsWith('fact:')) return bad('field_key');
  const fact = await live(ctx, 'product_fact', id(field.slice(5), 'fact_id'));
  if (fact.data.product_id !== product.id || fact.data.status !== 'active' || fact.data.category === 'speculation' || !fact.data.approved_revision_id) return conflict('source_unapproved', 'Localization requires an approved public fact');
  const rev = await live(ctx, 'product_fact_revision', fact.data.approved_revision_id);
  return { kind: 'product_fact_revision', id: rev.id, content_hash: rev.data.content_hash };
}

export const revisionCommands: Commands = {
  catalog_propose_fact: { roles: writers, async run(ctx, input) {
    const product = await guarded(ctx, 'product', id(input.product_id, 'product_id'));
    const variantId = input.variant_id == null ? null : id(input.variant_id, 'variant_id');
    if (variantId && (await live(ctx, 'product_variant', variantId)).data.product_id !== product.id) return bad('variant_id');
    const key = id(input.fact_key, 'fact_key');
    const factId = stableId(ctx.workspaceId, 'product_fact', product.id, variantId, key);
    const existing = await get(ctx, 'product_fact', factId);
    if (existing) version(input, existing);
    if (existing?.data.status === 'retracted') return conflict('fact_retracted', 'Retracted facts cannot be edited');
    const category = one(input.category ?? existing?.data.category, 'category', categories);
    if (existing && category !== existing.data.category) return conflict('category_mismatch', 'Fact category is fixed');
    const value = factValue(input.value);
    const evidenceUrls = array(input.evidence_urls, 'evidence_urls', val => url(val, 'evidence_url'));
    const evidenceIds = array(input.evidence_ids, 'evidence_ids', val => id(val, 'evidence_id'));
    for (const evidenceId of evidenceIds) if (!active(await ctx.get('core', 'evidence', evidenceId))) throw new DomainError('not_found', 'Evidence not found', 404);
    const markets = input.applicable_market_ids === undefined ? existing?.data.applicable_market_ids ?? null : input.applicable_market_ids === null ? null : array(input.applicable_market_ids, 'applicable_market_ids', val => id(val, 'market_id'));
    if (markets) for (const marketId of markets) await workspaceMarket(ctx, marketId);
    const number = (existing?.data.revision_no ?? 0) + 1;
    const revisionId = stableId(factId, 'revision', number);
    const data = { current_revision_id: revisionId, revision_no: number, applicable_market_ids: markets };
    const fact = existing ? await update(ctx, existing, data) : await insert(ctx, 'product_fact', { ...data, store_id: product.data.store_id, product_id: product.id, brand_id: product.data.brand_id ?? null, variant_id: variantId, fact_key: key, category, status: 'active', approved_revision_id: null }, factId);
    const fromAgent = 'agentClientId' in ctx && typeof ctx.agentClientId === 'string' && ctx.agentClientId.length > 0;
    const revision = await insert(ctx, 'product_fact_revision', { fact_id: fact.id, store_id: product.data.store_id, revision_no: number, value, category, evidence_urls: evidenceUrls, evidence_ids: evidenceIds, source: { kind: fromAgent ? 'agent' : 'manual', collected_at: ctx.now }, review_status: 'draft', content_hash: hash(value, category, evidenceUrls, evidenceIds), created_by_id: ctx.actorId }, revisionId);
    await ctx.emit('commerce.fact.revised', { fact_id: fact.id, revision_id: revision.id, product_id: product.id });
    return { fact, revision };
  } },
  review_fact_revision: { roles: reviewers, async run(ctx, input) {
    const revision = await guarded(ctx, 'product_fact_revision', id(input.revision_id, 'revision_id'));
    const fact = await live(ctx, 'product_fact', revision.data.fact_id);
    version(input, fact);
    if (fact.data.status !== 'active' || fact.data.current_revision_id !== revision.id || revision.data.review_status !== 'draft') return conflict('invalid_state', 'Only the current draft revision may be reviewed');
    const review = one(input.decision, 'decision', ['approve', 'reject']);
    if (review === 'approve' && revision.data.category === 'claim' && !revision.data.evidence_urls.length && !revision.data.evidence_ids.length) return conflict('evidence_required', 'Claims require supporting evidence');
    const approved = review === 'approve';
    const result = await update(ctx, revision, { review_status: approved ? 'approved' : 'rejected', reviewed_at: ctx.now, reviewed_by: ctx.actorId });
    if (approved && fact.data.approved_revision_id && fact.data.approved_revision_id !== revision.id) {
      const prev = await live(ctx, 'product_fact_revision', fact.data.approved_revision_id);
      if (prev.data.content_hash !== revision.data.content_hash) await change(ctx, fact, 'fact_revised', 'review', { revision_id: prev.id }, { revision_id: revision.id });
      await update(ctx, prev, { review_status: 'superseded' });
    }
    const next = await update(ctx, fact, { approved_revision_id: approved ? revision.id : fact.data.approved_revision_id });
    if (approved) await markFactLocalizations(ctx, next, revision.data.content_hash);
    await ctx.emit(`commerce.fact.${approved ? 'approved' : 'rejected'}`, { fact_id: fact.id, revision_id: revision.id, product_id: fact.data.product_id });
    return { fact: next, revision: result };
  } },
  retract_fact: { roles: reviewers, async run(ctx, input) {
    const fact = await guarded(ctx, 'product_fact', id(input.fact_id, 'fact_id'));
    version(input, fact);
    if (fact.data.status !== 'active') return conflict('invalid_state', 'Fact is already retracted');
    const next = await update(ctx, fact, { status: 'retracted', retraction_reason: str(input.reason, 'reason'), retracted_at: ctx.now });
    await markFactLocalizations(ctx, next, null);
    await change(ctx, next, 'fact_retracted', 'blocking', { revision_id: fact.data.approved_revision_id }, { status: 'retracted' });
    await ctx.emit('commerce.fact.retracted', { fact_id: fact.id, product_id: fact.data.product_id });
    return next;
  } },
  catalog_list_facts: { roles: readers, async run(ctx, input) {
    const product = await live(ctx, 'product', id(input.product_id, 'product_id'));
    if (input.approved_only !== undefined && typeof input.approved_only !== 'boolean') return bad('approved_only');
    const approvedOnly = input.approved_only !== false;
    const selected = array(input.category, 'category', val => one(val, 'category', categories));
    const facts = (await list(ctx, 'product_fact')).filter(row => active(row) && row.data.product_id === product.id && (!selected.length || selected.includes(row.data.category)) && (!approvedOnly || (row.data.status === 'active' && row.data.category !== 'speculation' && row.data.approved_revision_id)));
    return Promise.all(facts.map(async fact => ({ fact, revision: await live(ctx, 'product_fact_revision', approvedOnly ? fact.data.approved_revision_id : fact.data.current_revision_id) })));
  } },
  catalog_update_localization: { roles: writers, async run(ctx, input) {
    const requested = input.localization_id === undefined ? undefined : await live(ctx, 'product_localization', id(input.localization_id, 'localization_id'));
    const product = await guarded(ctx, 'product', requested?.data.product_id ?? id(input.product_id, 'product_id'));
    const field = requested?.data.field_key ?? str(input.field_key, 'field_key');
    const language = requested?.data.locale ?? locale(input.locale);
    const market = requested?.data.market_id ?? (input.market_id == null ? null : id(input.market_id, 'market_id'));
    if (market) await workspaceMarket(ctx, market);
    const key = requested?.id ?? stableId(ctx.workspaceId, 'product_localization', product.id, field, language, market);
    const current = await get(ctx, 'product_localization', key);
    if (current) version(input, current);
    if (current?.data.status === 'in_review') return conflict('invalid_state', 'Return the localization to draft before editing');
    const sourceRef = await localizationSource(ctx, product, field);
    const number = (current?.data.revision_no ?? 0) + 1;
    const text = str(input.text, 'text', 16000);
    const origin = one(input.origin ?? 'human', 'origin', ['human', 'agent']);
    const revisionId = stableId(key, 'revision', number);
    const data = { current_revision_id: revisionId, pending_revision_id: revisionId, revision_no: number, source_ref: sourceRef, status: current?.data.status === 'approved' && origin === 'agent' ? 'approved' : current?.data.status === 'stale' ? 'stale' : 'draft' };
    const localization = current ? await update(ctx, current, data) : await insert(ctx, 'product_localization', { ...data, store_id: product.data.store_id, product_id: product.id, field_key: field, locale: language, market_id: market, source_locale: locale(input.source_locale ?? (await store(ctx, product.data.store_id)).data.default_locale, 'source_locale'), approved_revision_id: null, writeback_status: 'none' }, key);
    const revision = await insert(ctx, 'product_localization_revision', { store_id: product.data.store_id, localization_id: key, revision_no: number, text, origin, source_hash: sourceRef.content_hash, content_hash: hash(text), created_by_id: ctx.actorId }, revisionId);
    await ctx.emit('commerce.localization.revised', { localization_id: key, revision_id: revision.id, product_id: product.id });
    return { localization, revision };
  } },
  submit_localization: { roles: writers, async run(ctx, input) {
    const row = await guarded(ctx, 'product_localization', id(input.localization_id, 'localization_id'));
    version(input, row);
    if (!['draft', 'stale', 'approved'].includes(row.data.status) || !row.data.pending_revision_id) return conflict('invalid_state', 'A pending revision is required');
    const revision = await live(ctx, 'product_localization_revision', row.data.pending_revision_id);
    const product = await live(ctx, 'product', row.data.product_id);
    const source = await localizationSource(ctx, product, row.data.field_key);
    if (source.content_hash !== revision.data.source_hash) return conflict('source_changed', 'Revise translation against the current source');
    const result = await update(ctx, row, { status: 'in_review' });
    await ctx.emit('commerce.localization.in_review', { localization_id: row.id, product_id: product.id });
    return result;
  } },
  review_localization: { roles: reviewers, async run(ctx, input) {
    const row = await guarded(ctx, 'product_localization', id(input.localization_id, 'localization_id'));
    version(input, row);
    const decision = one(input.decision, 'decision', ['approve', 'return', 'accept_source_change']);
    if (decision === 'accept_source_change' ? row.data.status !== 'stale' || !row.data.approved_revision_id : row.data.status !== 'in_review') return conflict('invalid_state', 'Localization is unavailable for this decision');
    if (decision === 'return') {
      const result = await update(ctx, row, { status: 'draft' });
      await ctx.emit('commerce.localization.returned', { localization_id: row.id, product_id: row.data.product_id });
      return result;
    }
    const source = await localizationSource(ctx, await live(ctx, 'product', row.data.product_id), row.data.field_key);
    const approvedRevisionId = decision === 'accept_source_change' ? row.data.approved_revision_id : row.data.pending_revision_id;
    const revision = await live(ctx, 'product_localization_revision', approvedRevisionId);
    if (decision !== 'accept_source_change' && source.content_hash !== revision.data.source_hash) return conflict('source_changed', 'Source changed since translation');
    const result = await update(ctx, row, { status: 'approved', source_ref: source, approved_revision_id: revision.id, approved_source_hash: source.content_hash, pending_revision_id: null, approved_by: ctx.actorId, approved_at: ctx.now });
    await ctx.emit('commerce.localization.approved', { localization_id: row.id, revision_id: revision.id, product_id: row.data.product_id });
    return result;
  } },
};
