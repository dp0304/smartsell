import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { choose, hash, object, str, strings } from './values.js';

const ENTRY = 'knowledge_entry';
const REVISION = 'knowledge_revision';
const kinds = ['positioning', 'tone', 'forbidden_phrase', 'glossary_term', 'faq', 'example', 'policy', 'product_pointer'];
const scopes = (row: Row, market: unknown, locale: unknown) =>
  (!Array.isArray(row.market_ids) || row.market_ids.includes(market)) && (!Array.isArray(row.locales) || row.locales.includes(locale));

export function proposeKnowledge(ctx: Context, body: Data, existing?: Row) {
  const brand_id = existing?.brand_id ?? ctx.get('brand', str(body.brand_id, 'brand_id')).id;
  const kind = existing?.kind ?? choose(body.kind, 'kind', kinds);
  if (existing?.status === 'retired') throw new Problem(409, 'KNOWLEDGE_RETIRED', 'Retired knowledge is read-only');
  const previous = existing?.current_revision_id ? ctx.get(REVISION, String(existing.current_revision_id)) : undefined;
  const localeFilters = body.locales == null ? null : strings(body.locales, 'locales');
  const marketFilters = body.market_ids == null ? null : strings(body.market_ids, 'market_ids').map(id => ctx.get('market', id).id);
  if (existing && ['title', 'locales', 'market_ids', 'priority', 'kind', 'brand_id'].some(key => Object.hasOwn(body, key) && hash(body[key]) !== hash(existing[key]))) throw new Problem(422, 'KNOWLEDGE_SCOPE_FIXED', 'Create a new entry to change knowledge scope or metadata');
  const priority = body.priority ?? 0;
  if (!Number.isSafeInteger(priority)) throw new Problem(422, 'INVALID_INPUT', 'Invalid priority');
  const text = str(body.body ?? previous?.body, 'body', 100_000);
  const structured = body.structured == null ? previous?.structured ?? null : object(body.structured, 'structured');
  if (kind === 'glossary_term') {
    const term = object(structured, 'glossary term');
    str(term.term, 'term');
    const translations = object(term.translations ?? {}, 'translations');
    for (const translation of Object.values(translations)) str(translation, 'translation');
    if (term.do_not_translate !== undefined && typeof term.do_not_translate !== 'boolean') throw new Problem(422, 'INVALID_INPUT', 'Invalid do_not_translate');
  }
  if (kind === 'forbidden_phrase' && structured) {
    const terms = object(structured, 'forbidden phrases');
    if (terms.patterns !== undefined) strings(terms.patterns, 'patterns');
  }
  const source = body.source == null ? { kind: ctx.role === 'agent' ? 'agent' : 'human' } : object(body.source, 'source');
  const entry = existing ?? ctx.create(ENTRY, { brand_id, kind, priority, title: str(body.title, 'title', 250), market_ids: marketFilters, locales: localeFilters, status: 'proposed', active_revision_id: null });
  const revision = ctx.create(REVISION, { entry_id: entry.id, revision_no: Number(previous?.revision_no ?? 0) + 1, body: text, structured, source, review_status: 'draft', content_hash: hash({ body: text, structured, source }), created_by_type: ctx.role === 'agent' ? 'agent' : 'user', created_by_id: ctx.actorId });
  const row = ctx.update(ENTRY, entry.id, { current_revision_id: revision.id, status: entry.active_revision_id ? 'active' : 'proposed' });
  ctx.emit('asset.knowledge.proposed', { knowledge_entry_id: entry.id, knowledge_revision_id: revision.id });
  return { ...row, knowledge_revision: revision };
}
function pending(ctx: Context, id: string) {
  const revision = ctx.get(REVISION, id);
  const entry = ctx.get(ENTRY, String(revision.entry_id));
  if (revision.review_status !== 'draft' || entry.current_revision_id !== revision.id || entry.status === 'retired') throw new Problem(409, 'KNOWLEDGE_DRAFT_REQUIRED', 'Review the latest proposed revision');
  return { entry, revision };
}
function glossaryChanged(ctx: Context, entry: Row) {
  if (entry.kind !== 'glossary_term') return;
  const variants = new Map(ctx.list('content_variant').map(row => [row.id, row]));
  const items = new Map(ctx.list('content_item').map(row => [row.id, row]));
  for (const link of ctx.list('translation_link')) {
    const target = variants.get(String(link.target_variant_id));
    const source = variants.get(String(link.source_variant_id));
    if (!target || items.get(String(target.content_item_id))?.brand_id !== entry.brand_id || (!scopes(entry, target.market_id, target.locale) && (!source || !scopes(entry, source.market_id, source.locale)))) continue;
    if (link.status !== 'source_changed') ctx.update('translation_link', link.id, { status: 'needs_review' });
    const reasons = Array.isArray(target.stale_reasons) ? target.stale_reasons as Data[] : [];
    ctx.update('content_variant', target.id, { readiness: 'stale', stale_reasons: [...reasons.filter(reason => reason.kind !== 'glossary_changed' || reason.ref_id !== entry.id), { kind: 'glossary_changed', ref_id: entry.id }] });
    ctx.emit('content.variant.readiness_changed', { content_variant_id: target.id, readiness: 'stale', reason: 'glossary_changed', ref_id: entry.id });
  }
}
export function approveKnowledge(ctx: Context, id: string) {
  const { entry, revision } = pending(ctx, id);
  if (entry.active_revision_id) ctx.update(REVISION, String(entry.active_revision_id), { review_status: 'superseded' });
  ctx.update(REVISION, revision.id, { review_status: 'approved', reviewed_by: ctx.actorId, reviewed_at: ctx.now });
  const out = ctx.update(ENTRY, entry.id, { status: 'active', active_revision_id: revision.id });
  ctx.emit('asset.knowledge.activated', { knowledge_entry_id: entry.id, knowledge_revision_id: revision.id, brand_id: entry.brand_id, kind: entry.kind });
  glossaryChanged(ctx, out);
  return out;
}
export function rejectKnowledge(ctx: Context, id: string) {
  const { entry, revision } = pending(ctx, id);
  ctx.update(REVISION, revision.id, { review_status: 'rejected', reviewed_by: ctx.actorId, reviewed_at: ctx.now });
  const row = ctx.update(ENTRY, entry.id, { status: entry.active_revision_id ? 'active' : 'rejected' });
  ctx.emit('asset.knowledge.rejected', { knowledge_entry_id: entry.id, knowledge_revision_id: revision.id });
  return row;
}
export function retireKnowledge(ctx: Context, id: string) {
  const entry = ctx.get(ENTRY, id);
  if (entry.status !== 'active') throw new Problem(409, 'KNOWLEDGE_NOT_ACTIVE', 'Only active knowledge can be retired');
  const row = ctx.update(ENTRY, id, { status: 'retired' });
  glossaryChanged(ctx, row);
  ctx.emit('asset.knowledge.retired', { knowledge_entry_id: id, brand_id: entry.brand_id, kind: entry.kind });
  return row;
}
export function knowledgeDetail(ctx: Context, row: Row) {
  return { ...row, revisions: ctx.list(REVISION).filter(revision => revision.entry_id === row.id).sort((a, b) => Number(b.revision_no) - Number(a.revision_no)) };
}
export function approvedKnowledgeRevision(entry: Row, revision: Row | undefined): Row | undefined {
  if (revision && entry.status === 'active' && revision.id === entry.active_revision_id &&
    revision.entry_id === entry.id && revision.review_status === 'approved') return revision;
}

export function context(ctx: Context, brand: string, query: Record<string, string>) {
  ctx.get('brand', brand);
  if (query.market_id) {
    const market = ctx.get('market', query.market_id);
    if (market.brand_id != null && market.brand_id !== brand) throw new Problem(422, 'BRAND_MISMATCH', 'Knowledge market belongs to another brand');
  }
  const budget = query.max_chars == null ? 24_000 : Number(query.max_chars);
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 100_000) throw new Problem(422, 'INVALID_INPUT', 'Invalid max_chars');
  const candidates = ctx.list(ENTRY)
    .filter(row => row.brand_id === brand && row.status !== 'retired' && scopes(row, query.market_id, query.locale))
    .sort((a, b) => kinds.indexOf(String(a.kind)) - kinds.indexOf(String(b.kind)) || Number(b.priority) - Number(a.priority) || a.id.localeCompare(b.id));
  const revisions = new Map(ctx.list(REVISION).map(row => [row.id, row]));
  const items = [];
  const glossary = [];
  let used = 0;
  let truncated = false;
  for (const row of candidates) {
    const ids = [row.status === 'active' ? row.active_revision_id : null];
    if (query.include_proposed === 'true' && row.current_revision_id !== row.active_revision_id) ids.push(row.current_revision_id);
    for (const id of ids) {
      const revision = revisions.get(String(id));
      if (!revision || revision.entry_id !== row.id) continue;
      const approved = approvedKnowledgeRevision(row, revision);
      if (!approved && !(query.include_proposed === 'true' && id === row.current_revision_id &&
        id !== row.active_revision_id && revision.review_status === 'draft')) continue;
      if (approved && row.kind === 'glossary_term') glossary.push(revision.id);
      const item = { entry_id: row.id, revision_id: revision.id, revision_no: revision.revision_no, kind: row.kind, title: row.title, body: revision.body, structured: revision.structured, status: approved ? 'active' : 'proposed' };
      const size = JSON.stringify(item).length;
      if (truncated || used + size > budget) { truncated = true; continue; }
      used += size;
      items.push(item);
    }
  }
  return { brand_id: brand, items, glossary_version: hash(glossary), truncated };
}
