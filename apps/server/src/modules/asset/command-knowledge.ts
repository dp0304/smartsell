import { DomainError, readers, required, reviewers, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { draftFor } from '../content/model.ts';
import { bool, conflict, emit, expectVersion, get, hash, insert, integer, invalid, list, object, option, optional, strings, update } from './command-model.ts';

const entryKinds = ['positioning', 'tone', 'forbidden_phrase', 'glossary_term', 'faq', 'example', 'policy', 'product_pointer'];
const templateKinds = ['text_snippet', 'hashtag_set', 'cta', 'caption_template', 'visual_template'];
const sources = ['product_fact', 'listing', 'promotion', 'link', 'free'];
const placeholder = /\{\{\s*([a-z][a-z0-9_.-]*)\s*\}\}/gi;
const scoped = (choices: string[] | null | undefined, value: string | null) => choices == null || value !== null && choices.includes(value);

async function propose(ctx: Context, input: Fields): Promise<{ entry: Entity; revision: Entity }> {
  const id = optional(input, 'entry_id', 256);
  let entry = id ? await get(ctx, 'knowledge_entry', id) : null;
  if (entry) {
    expectVersion(entry, input);
    if (entry.data.status === 'retired') conflict('Knowledge entry is retired');
  } else {
    const brandId = text(input, 'brand_id', 256);
    await required(ctx, 'workspace', 'brand', brandId);
    entry = await insert(ctx, 'knowledge_entry', {
      brand_id: brandId, kind: option(input, 'kind', entryKinds), title: text(input, 'title', 512),
      market_ids: input.market_ids == null ? null : strings(input.market_ids, 'market_ids'),
      locales: input.locales == null ? null : strings(input.locales, 'locales'),
      priority: integer(input.priority ?? 0, 'priority', -10_000, 10_000),
      status: 'proposed', current_revision_id: null, active_revision_id: null,
    });
  }
  const previous = entry.data.current_revision_id ? await get(ctx, 'knowledge_revision', entry.data.current_revision_id) : null;
  const values = {
    body: text(input, 'body', 40_000), structured: input.structured == null ? null : object(input.structured, 'structured'),
    source: input.source == null ? { type: 'manual' } : object(input.source, 'source'),
  };
  const revision = await insert(ctx, 'knowledge_revision', {
    ...values, entry_id: entry.id, revision_no: (previous?.data.revision_no ?? 0) + 1,
    content_hash: hash(values), created_by_id: ctx.actorId,
  });
  const updated = await update(ctx, entry, {
    current_revision_id: revision.id, status: entry.data.active_revision_id ? 'active' : 'proposed', proposal_status: 'pending',
  });
  return { entry: updated, revision };
}

async function review(ctx: Context, input: Fields, approve: boolean): Promise<Entity> {
  const revision = await get(ctx, 'knowledge_revision', text(input, 'revision_id', 256));
  const entry = await get(ctx, 'knowledge_entry', revision.data.entry_id);
  expectVersion(entry, input);
  if (entry.data.status === 'retired' || entry.data.current_revision_id !== revision.id || entry.data.proposal_status !== 'pending') conflict('Only the current pending revision can be reviewed');
  const result = await update(ctx, entry, {
    status: approve || entry.data.active_revision_id ? 'active' : 'rejected',
    proposal_status: approve ? 'approved' : 'rejected',
    ...(approve ? { active_revision_id: revision.id } : {}),
  });
  await insert(ctx, 'knowledge_review', { entry_id: entry.id, revision_id: revision.id, decision: approve ? 'approved' : 'rejected', reviewed_by: ctx.actorId, reason: optional(input, 'reason') });
  if (approve) await emit(ctx, 'knowledge.activated', { brand_id: entry.data.brand_id, entry_id: entry.id, revision_no: revision.data.revision_no });
  return result;
}

function variables(input: unknown): { key: string; source: string; required: boolean }[] {
  if (!Array.isArray(input) || input.length > 100) invalid('Invalid variables');
  const seen = new Set<string>();
  return input.map(item => {
    const field = object(item, 'variable');
    const key = text(field, 'key', 128);
    if (!/^[a-z][a-z0-9_.-]*$/i.test(key) || seen.has(key)) invalid('Invalid or duplicate template variable key');
    seen.add(key);
    return { key, source: option(field, 'source', sources), required: bool(field, 'required', true) };
  });
}

function replaceTemplate(body: unknown, substitute: (original: string, key: string) => string): unknown {
  if (typeof body === 'string') return body.replace(placeholder, substitute);
  if (Array.isArray(body)) return body.map(child => replaceTemplate(child, substitute));
  if (body && typeof body === 'object') {
    // JSON documents may contain URLs and attributes. Only interpolate text nodes.
    const doc = body as Fields;
    return { ...doc, ...(typeof doc.text === 'string' ? { text: doc.text.replace(placeholder, substitute) } : {}),
      ...(Array.isArray(doc.content) ? { content: doc.content.map(child => replaceTemplate(child, substitute)) } : {}) };
  }
  return body;
}

function templateData(input: Fields): Fields {
  const kind = option(input, 'kind', templateKinds);
  const body = typeof input.body === 'string' ? text(input, 'body', 40_000)
    : Array.isArray(input.body) && kind === 'hashtag_set' ? strings(input.body, 'body') : object(input.body, 'body');
  if (JSON.stringify(body).length > 80_000) invalid('Template body exceeds size limit');
  const schema = variables(input.variables ?? []);
  const keys = new Set(schema.map(variable => variable.key));
  replaceTemplate(body, (match, key) => {
    if (!keys.has(key)) invalid(`Undeclared template variable ${key}`);
    return match;
  });
  return { name: text(input, 'name', 512), kind, body, variables: schema,
    platforms: input.platforms == null ? null : strings(input.platforms, 'platforms'),
    market_ids: input.market_ids == null ? null : strings(input.market_ids, 'market_ids'),
    locales: input.locales == null ? null : strings(input.locales, 'locales'),
  };
}

async function resolveSource(ctx: Context, source: string, value: unknown, brand: string | null, market: string | null, locale: string | null) {
  if (source === 'free') return typeof value === 'string' && value.length <= 4096 ? value : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !brand) return undefined;
  const ref = value as Fields;
  const lookup = async (module: string, kind: string, id: unknown) => typeof id === 'string' ? (await ctx.get(module, kind, id))?.data : undefined;
  if (source === 'product_fact') {
    const revision = await lookup('commerce', 'product_fact_revision', ref.fact_revision_id);
    const fact = await lookup('commerce', 'product_fact', revision?.fact_id);
    if (fact?.brand_id === brand && fact.status === 'active' && fact.category !== 'speculation' &&
      revision?.review_status === 'approved' && revision.category !== 'speculation' && fact.approved_revision_id === ref.fact_revision_id &&
      scoped(fact.applicable_market_ids, market)) {
      const translations = revision.value?.by_locale;
      return (locale && translations && Object.hasOwn(translations, locale) ? translations[locale] : undefined) ?? revision.value?.text ?? revision.value?.number;
    }
  }
  if (source === 'listing') {
    const snapshot = await lookup('commerce', 'listing_snapshot', ref.listing_snapshot_id);
    const variant = await lookup('commerce', 'product_variant', snapshot?.variant_id);
    const product = await lookup('commerce', 'product', variant?.product_id);
    const field = ref.field ?? 'price_amount_minor';
    if (snapshot?.availability === 'observed' && snapshot.is_current === true && snapshot.is_estimate === false && snapshot.price_source !== 'fx_estimate' &&
      market && snapshot.market_id === market && product?.brand_id === brand && !product.archived_at &&
      ['price_amount_minor', 'currency', 'purchase_url', 'inventory_status'].includes(field)) return snapshot[field];
  }
  if (source === 'promotion') {
    const promotion = await lookup('commerce', 'promotion', ref.promotion_id);
    const store = await lookup('commerce', 'store', promotion?.store_id);
    const code = await lookup('commerce', 'promotion_code', ref.promotion_code_id);
    if (promotion && store?.brand_id === brand && promotion.verified_at && ['scheduled', 'active'].includes(promotion.state) &&
      Date.parse(promotion.valid_from) <= Date.parse(ctx.now) && Date.parse(ctx.now) < Date.parse(promotion.valid_until) &&
      (!promotion.market_ids?.length || scoped(promotion.market_ids, market)) && code && code.promotion_id === ref.promotion_id &&
      !code.retired_at && !code.archived_at) return code.code;
  }
  if (source === 'link') {
    const link = await lookup('traffic', 'short_link', ref.short_link_id);
    if (link?.status !== 'active' || link.brand_id !== brand || link.market_id != null && link.market_id !== market ||
      link.expires_at != null && !(Date.parse(link.expires_at) > Date.parse(ctx.now))) return undefined;
    const domain = await lookup('traffic', 'link_domain', link.domain_id);
    if (domain?.verification_status === 'verified' && domain.tls_status === 'active' && /^[a-z0-9.-]+$/i.test(domain.hostname) && typeof link.code === 'string') {
      return `https://${domain.hostname}/${encodeURIComponent(link.code)}`;
    }
  }
  return undefined;
}

export async function renderTemplate(ctx: Context, row: Entity, input: Fields) {
  const requestedBrand = optional(input, 'brand_id', 256);
  const brand = requestedBrand ?? row.data.brand_id ?? null;
  const market = optional(input, 'market_id', 256);
  const locale = optional(input, 'locale', 35);
  const platform = optional(input, 'platform', 256);
  if (row.data.status !== 'active' || row.data.brand_id != null && row.data.brand_id !== brand ||
    !scoped(row.data.platforms, platform) || !scoped(row.data.market_ids, market) || !scoped(row.data.locales, locale)) conflict('Template is out of scope');
  if (market) {
    const row = await required(ctx, 'workspace', 'market', market);
    if (row.data.brand_id != null && row.data.brand_id !== brand) conflict('Template market belongs to another brand');
  }
  const supplied = object(input.values ?? {}, 'values');
  const schema = variables(row.data.variables);
  const resolved = new Map<string, string>();
  const missing = [];
  for (const field of schema) {
    const value = await resolveSource(ctx, field.source, Object.hasOwn(supplied, field.key) ? supplied[field.key] : undefined, brand, market, locale);
    if ((typeof value === 'string' && value.length > 0) || typeof value === 'number' && Number.isFinite(value)) resolved.set(field.key, String(value));
    else if (field.required) missing.push(field.key);
  }
  const revalidate = schema.filter(field => field.source !== 'free').map(({ key, source }) => ({ key, source }));
  const body = replaceTemplate(row.data.body, (match, key) => resolved.get(key) ?? match);
  return { body, template_id: row.id, template_version: row.version, missing, revalidate };
}

function variantScope(variant: Entity) {
  const { brand_id, market_id, locale, platform } = variant.data;
  return { brand_id, market_id, locale, platform };
}

export async function revalidateTemplateApplication(ctx: Context, variant: Entity, application: Fields) {
  const template = await ctx.get('asset', 'template', application.template_id);
  const stale = () => new DomainError('TEMPLATE_VALUES_CHANGED', 'Template values changed or became unavailable. Reapply the template and review the working draft before committing.', 409);
  if (!template || template.version !== application.template_version || template.data.status !== 'active') throw stale();
  const rendered = await renderTemplate(ctx, template, { ...variantScope(variant), values: application.values });
  if (rendered.missing.length || hash(rendered.body) !== application.body_hash) throw stale();
}

async function applyTemplate(ctx: Context, input: Fields) {
  const template = await get(ctx, 'template', text(input, 'template_id', 256));
  const variant = await required(ctx, 'content', 'content_variant', text(input, 'variant_id', 256));
  const item = await required(ctx, 'content', 'content_item', variant.data.content_item_id);
  if (item.data.production_stage === 'archived') conflict('Content item is archived');
  expectVersion(variant, input);
  const values = object(input.values ?? {}, 'values');
  const rendered = await renderTemplate(ctx, template, { ...variantScope(variant), values });
  if (rendered.missing.length) throw new DomainError('TEMPLATE_VALUES_UNAVAILABLE', `Template values unavailable: ${rendered.missing.join(', ')}`, 409);
  const body = rendered.body;
  const fields = typeof body === 'string' ? { body } : Array.isArray(body) ? { body: body.join(' ') } : { body_doc: body };
  const draft = draftFor(fields, variant.data.platform, variant.data.draft_doc);
  const application = rendered.revalidate.length ? {
    template_id: template.id, template_version: template.version, body_hash: hash(body),
    values: Object.fromEntries((template.data.variables as Fields[]).filter(field => Object.hasOwn(values, field.key)).map(field => [field.key, values[field.key]])),
  } : null;
  if (application) draft.template_application = application;
  else delete draft.template_application;
  const updated = await ctx.update('content', 'content_variant', variant.id, {
    draft_doc: draft,
    ...(variant.data.readiness === 'ready' ? { readiness: 'draft', state: 'draft', stale_reasons: [] } : {}),
  }, variant.version);
  if (variant.data.readiness === 'ready') await ctx.emit('content.variant.readiness_changed', { variant_id: variant.id, readiness: 'draft', stale_reasons: [] });
  return updated;
}

export const knowledgeCommands: Commands = {
  knowledge_propose: { roles: readers, run: propose },
  knowledge_import: { roles: writers, async run(ctx, input) {
    if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 50) invalid('Provide between 1 and 50 extracted entries');
    const evidenceId = text(input, 'evidence_id', 256);
    await required(ctx, 'core', 'evidence', evidenceId);
    const output = [];
    for (const item of input.entries) {
      const fields = object(item, 'entry');
      output.push(await propose(ctx, { ...fields, entry_id: undefined, brand_id: input.brand_id, source: { type: 'document_import', evidence_id: evidenceId } }));
    }
    return output;
  } },
  knowledge_approve: { roles: reviewers, run: (ctx, input) => review(ctx, input, true) },
  knowledge_reject: { roles: reviewers, run: (ctx, input) => review(ctx, input, false) },
  knowledge_retire: { roles: reviewers, async run(ctx, input) {
    const entry = await get(ctx, 'knowledge_entry', text(input, 'entry_id', 256));
    expectVersion(entry, input);
    if (entry.data.status !== 'active') conflict('Only active knowledge can be retired');
    const updated = await update(ctx, entry, { status: 'retired' });
    await emit(ctx, 'knowledge.retired', { brand_id: entry.data.brand_id, entry_id: entry.id });
    return updated;
  } },
  knowledge_get_context: { roles: readers, async run(ctx, input) {
    const brandId = text(input, 'brand_id', 256);
    await required(ctx, 'workspace', 'brand', brandId);
    const marketId = optional(input, 'market_id', 256);
    if (marketId) {
      const market = await required(ctx, 'workspace', 'market', marketId);
      if (market.data.brand_id != null && market.data.brand_id !== brandId) invalid('Knowledge market belongs to another brand');
    }
    const locale = optional(input, 'locale', 35);
    const includeProposed = bool(input, 'include_proposed', false);
    let budget = integer(input.max_chars ?? 12_000, 'max_chars', 0, 80_000);
    const kinds = input.kinds == null ? null : strings(input.kinds, 'kinds');
    const entries = (await list(ctx, 'knowledge_entry')).filter(row => row.data.brand_id === brandId &&
      scoped(row.data.market_ids, marketId) && scoped(row.data.locales, locale) && (!kinds || kinds.includes(row.data.kind)) && row.data.status !== 'retired')
      .sort((a,b) => a.data.kind.localeCompare(b.data.kind) || b.data.priority - a.data.priority || a.id.localeCompare(b.id));
    const active: Fields[] = [];
    const proposed: Fields[] = [];
    for (const isProposed of [false, true]) {
      if (isProposed && !includeProposed) break;
      for (const entry of entries) {
        const revId = isProposed ? entry.data.proposal_status === 'pending' && entry.data.current_revision_id : entry.data.active_revision_id;
        if (!revId || budget <= 0) continue;
        const revision = await get(ctx, 'knowledge_revision', revId);
        const header = { entry_id: entry.id, revision_no: revision.data.revision_no, kind: entry.data.kind, title: entry.data.title, status: isProposed ? 'proposed' : 'active' };
        const overhead = JSON.stringify(header).length;
        if (budget <= overhead) continue;
        const body = revision.data.body.slice(0, budget - overhead);
        budget -= overhead + body.length;
        const structuredSize = revision.data.structured ? JSON.stringify(revision.data.structured).length : 0;
        const structured = structuredSize <= budget && body === revision.data.body ? revision.data.structured : null;
        if (structured) budget -= structuredSize;
        (isProposed ? proposed : active).push({ ...header, body, structured });
      }
    }
    return { active, proposed };
  } },
  template_create: { roles: writers, async run(ctx, input) {
    const brandId = optional(input, 'brand_id', 256);
    if (brandId) await required(ctx, 'workspace', 'brand', brandId);
    return insert(ctx, 'template', { ...templateData(input), brand_id: brandId, status: 'active' });
  } },
  template_update: { roles: writers, async run(ctx, input) {
    const row = await get(ctx, 'template', text(input, 'template_id', 256));
    expectVersion(row, input);
    if (row.data.status !== 'active') conflict('Template is archived');
    return update(ctx, row, templateData({ ...row.data, ...input }));
  } },
  template_archive: { roles: writers, async run(ctx, input) {
    const row = await get(ctx, 'template', text(input, 'template_id', 256));
    expectVersion(row, input);
    return row.data.status === 'archived' ? row : update(ctx, row, { status: 'archived' });
  } },
  template_list: { roles: readers, async run(ctx, input) {
    const brand = optional(input, 'brand_id', 256);
    return (await list(ctx, 'template')).filter(row => row.data.status === 'active' && (row.data.brand_id === null || row.data.brand_id === brand) &&
      scoped(row.data.platforms, optional(input, 'platform', 256)) && scoped(row.data.market_ids, optional(input, 'market_id', 256)) && scoped(row.data.locales, optional(input, 'locale', 35)));
  } },
  template_apply: { roles: writers, run: applyTemplate },
  template_render: { roles: readers, async run(ctx, input) {
    const row = await get(ctx, 'template', text(input, 'template_id', 256));
    return renderTemplate(ctx, row, input);
  } },
};
