import type { Context, Entity, Fields } from '../types.ts';
import { revalidateTemplateApplication } from '../asset/command-knowledge.ts';
import { baseRevision, changedFields, choice, clearHumanSettings, draftFor, emit, fail, formats, get, hash, id, insert, kinds, list, machineActor, optionalText, platforms, references, render, snapshot, text, update, version } from './model.ts';
import { accountPlatform, assetUsage, loadProductSources, pinProductFacts, usableProductSource } from './validation.ts';
import { guard, patch as patchExecution } from '../execution/state.ts';
import { rejectNewEstimatedPrices, requirePricePin } from './product-prices.ts';

export const variantFor = (ctx: Context, input: Fields) => get(ctx, kinds.variant, id(input, 'variant_id'));
export const revisionFor = (ctx: Context, input: Fields) => get(ctx, kinds.revision, id(input, 'revision_id'));
export const currentRevision = (ctx: Context, variant: Entity) => variant.data.current_revision_id ? get(ctx, kinds.revision, variant.data.current_revision_id) : null;
const formatAliases: Record<string, string> = { image: 'feed_image', video: 'long_video', short: 'short_video' };
export const readinessData = (readiness: string, stale_reasons: Fields[] = []) => ({ readiness, state: readiness, stale_reasons });

export async function activeItem(ctx: Context, itemId: string) {
  const item = await get(ctx, kinds.item, itemId);
  if (item.data.production_stage === 'archived') fail('archived', 'Content item is archived', 409);
  return item;
}
export async function createVariant(ctx: Context, item: Entity, input: Fields, options: { agent?: boolean; copy?: Entity; initialize?: boolean; lineage?: Fields; dryRun?: boolean } = {}) {
  if (input.copy_from_variant_id && options.copy) fail('invalid_input', 'Only one variant source may be specified');
  const copy = options.copy ?? (input.copy_from_variant_id ? await get(ctx, kinds.variant, text(input.copy_from_variant_id, 'copy_from_variant_id')) : undefined);
  const platform = choice(input.platform ?? copy?.data.platform, 'platform', platforms);
  const requestedFormat = input.format ?? copy?.data.format;
  const format = choice(typeof requestedFormat === 'string' && Object.hasOwn(formatAliases, requestedFormat) ? formatAliases[requestedFormat] : requestedFormat, 'format', formats);
  const locale = text(input.locale ?? copy?.data.locale ?? 'und', 'locale', 35);
  const market = optionalText(Object.hasOwn(input, 'market_id') ? input.market_id : Object.hasOwn(input, 'market') ? input.market : copy?.data.market_id ?? copy?.data.market, 'market_id');
  const account = optionalText(input.social_account_id, 'social_account_id');
  if (account) {
    const row = await get(ctx, 'social_account', account, 'account');
    if (accountPlatform(row) !== platform || (row.data.brand_id && row.data.brand_id !== item.data.brand_id)) fail('invalid_input', 'Account platform and brand must match the variant');
  }
  const owner_user_id = optionalText(input.owner_user_id, 'owner_user_id');
  const candidate = draftFor(input, platform, copy ? clearHumanSettings(copy.data.draft_doc, platform) : {}, !!options.agent || machineActor(ctx) || !!copy || options.lineage?.origin === 'translation');
  await rejectNewEstimatedPrices(ctx, candidate.product_refs, []);
  const draft = await pinProductFacts(ctx, { brand_id: item.data.brand_id, locale, market }, candidate, []);
  const data = {
    content_item_id: item.id, brand_id: item.data.brand_id, campaign_id: item.data.campaign_id ?? null, platform, format, locale, market, market_id: market,
    social_account_id: account, owner_user_id, draft_doc: draft, current_revision_id: null, ...readinessData('draft'),
    ...(copy ? { parent_variant_id: copy.id, derived_from_revision_id: copy.data.current_revision_id } : {}), ...options.lineage,
  };
  if (options.dryRun) return { variant: { ...item, id: '', kind: kinds.variant, data }, revision: null };
  const variant = await insert(ctx, kinds.variant, data);
  await emit(ctx, 'variant.created', { variant_id: variant.id, content_item_id: item.id });
  return options.initialize ? commit(ctx, variant, draft, options.lineage?.origin ?? (options.agent ? 'agent' : 'human')) : { variant, revision: null };
}

export async function setReadiness(ctx: Context, variant: Entity, readiness: string, reasons: Fields[] = []) {
  if (variant.data.readiness === readiness && variant.data.state === readiness && hash(variant.data.stale_reasons) === hash(reasons)) return variant;
  const result = await update(ctx, variant, readinessData(readiness, reasons));
  await emit(ctx, 'variant.readiness_changed', { variant_id: variant.id, readiness, stale_reasons: reasons });
  return result;
}
export async function stale(ctx: Context, variant: Entity, reason: Fields) {
  const reasons: Fields[] = variant.data.stale_reasons ?? [];
  return setReadiness(ctx, variant, 'stale', reasons.some(old => hash(old) === hash(reason)) ? reasons : [...reasons, reason]);
}

async function propagateRevision(ctx: Context, variant: Entity, revision: Entity) {
  for (const link of await list(ctx, kinds.translation)) {
    if (link.data.target_variant_id === variant.id) await update(ctx, link, { target_revision_id: revision.id });
    if (link.data.source_variant_id !== variant.id || link.data.source_revision_id === revision.id) continue;
    await update(ctx, link, { status: 'source_changed' });
    const target = await get(ctx, kinds.variant, link.data.target_variant_id);
    await stale(ctx, target, { kind: 'translation_source_changed', ref_id: link.id });
    await emit(ctx, 'translation.source_changed', { translation_link_id: link.id, target_variant_id: target.id, source_revision_id: revision.id });
  }
}

// The REST adapter invalidates its own plan_status/approval_request records via onRevisionCreated.
async function invalidateCommandApprovals(ctx: Context, variant: Entity, revision: Entity) {
  const targets = (await list(ctx, 'publish_target', 'planning')).filter(target =>
    target.data.content_variant_id === variant.id && ['awaiting_approval', 'scheduled'].includes(target.data.status) &&
    target.data.revision_id !== revision.id && typeof target.data.approval_id === 'string');
  if (!targets.length) return;
  await patchExecution(ctx, await guard(ctx), { checked_at: ctx.now });
  const ownedTargets = new Set((await list(ctx, 'execution_task', 'execution')).map(task => task.data.target_id));
  const reason = 'content_revision_changed';
  for (const target of targets) {
    const approval = await ctx.get('planning', 'approval', target.data.approval_id);
    if (!approval || approval.data.target_id !== target.id || !['pending', 'approved'].includes(approval.data.status)) continue;
    await ctx.update('planning', approval.kind, approval.id, { status: 'invalidated', invalidated_at: ctx.now, invalidated_by: ctx.actorId, invalidated_reason: reason }, approval.version);
    // Keep the frozen payload available when execution already owns the target for reconciliation.
    await ctx.update('planning', target.kind, target.id, { approval_invalidated_reason: reason, ...(!ownedTargets.has(target.id) ? {
      status: 'draft', revision_id: null, frozen: null, frozen_hash: null, approval_id: null, approved_at: null,
    } : {}) }, target.version);
    await ctx.emit('planning.target.approval_invalidated', { target_id: target.id, approval_id: approval.id, reason });
  }
}

export async function commit(ctx: Context, variant: Entity, draft: Fields, origin: string, restoredFrom?: string) {
  if (draft.template_application) await revalidateTemplateApplication(ctx, variant, draft.template_application);
  const head = await currentRevision(ctx, variant);
  const oldProducts = new Set((head?.data.product_refs ?? []).map((ref: Fields) => hash(ref)));
  const newProducts = (draft.product_refs as Fields[]).filter(ref => !oldProducts.has(hash(ref)));
  const sources = await loadProductSources(ctx, newProducts.filter(ref => ref.listing_snapshot_id));
  for (const ref of newProducts) {
    if (!restoredFrom && ref.listing_snapshot_id && !usableProductSource(sources.get(`listing_snapshot:${ref.listing_snapshot_id}:${ref.variant_id}`), ref, false, variant.data.brand_id)) fail('invalid_product_reference', 'Listing snapshot is unavailable or estimated');
  }
  const media: Fields[] = [];
  for (const attachment of draft.media as Fields[]) {
    const version = await ctx.get('asset', 'asset_version', attachment.asset_version_id);
    const assetId = version?.data.asset_id;
    if (assetId && attachment.asset_id && assetId !== attachment.asset_id) fail('invalid_input', 'Media asset_id does not match the selected version');
    media.push(assetId ? { ...attachment, asset_id: assetId } : attachment);
  }
  const pinned = await pinProductFacts(ctx, variant.data, draft, [...(head?.data.product_refs ?? []), ...(variant.data.draft_doc?.product_refs ?? [])], !!restoredFrom);
  const frozen = { ...pinned, media };
  // A channel_defaults revision only applies the owner's account defaults to the head content (phase1-design §4.4).
  const createdByType = origin === 'agent' ? 'agent' : origin === 'channel_defaults' ? 'system' : 'user';
  const aiGenerated = origin === 'agent' || origin === 'channel_defaults' && head?.data.ai_generated === true;
  const revision = await insert(ctx, kinds.revision, {
    ...frozen, variant_id: variant.id, author_id: ctx.actorId, created_by_id: ctx.actorId, created_by_type: createdByType,
    platform: variant.data.platform, format: variant.data.format, locale: variant.data.locale, market: variant.data.market,
    market_id: variant.data.market, campaign_id: variant.data.campaign_id, revision_no: (head?.data.revision_no ?? 0) + 1,
    based_on_revision_id: head?.id ?? null, ...(restoredFrom ? { restored_from_revision_id: restoredFrom } : {}),
    ...(!head && variant.data.derived_from_revision_id ? { derived_from_revision_id: variant.data.derived_from_revision_id } : {}),
    origin, ai_generated: aiGenerated, rendered: render(frozen), content_hash: hash(frozen),
  });
  for (const reference of references(frozen)) await insert(ctx, kinds.reference, { revision_id: revision.id, ...reference });
  const readiness = variant.data.readiness === 'stale' || head?.data.content_hash === revision.data.content_hash ? variant.data.readiness : 'draft';
  const updated = await update(ctx, variant, { draft_doc: frozen, current_revision_id: revision.id, ...readinessData(readiness, variant.data.stale_reasons) });
  await emit(ctx, 'revision.created', { revision_id: revision.id, variant_id: variant.id, content_item_id: variant.data.content_item_id, based_on_revision_id: head?.id ?? null });
  if (readiness !== variant.data.readiness) await emit(ctx, 'variant.readiness_changed', { variant_id: variant.id, readiness, stale_reasons: updated.data.stale_reasons });
  if (restoredFrom) await invalidateCommandApprovals(ctx, updated, revision);
  await propagateRevision(ctx, updated, revision);
  return { variant: updated, revision };
}

export async function prepareEdit(ctx: Context, input: Fields, mode: 'draft' | 'human' | 'agent' | 'restore', restored?: Entity) {
  const variant = restored ? await get(ctx, kinds.variant, restored.data.variant_id) : await variantFor(ctx, input);
  await activeItem(ctx, variant.data.content_item_id);
  const base = baseRevision(input, mode !== 'draft');
  const expected = version(input, mode !== 'human');
  const current = await currentRevision(ctx, variant);
  const baseRow = base && base !== current?.id ? await ctx.get('content', kinds.revision, base) : base ? current : null;
  if (baseRow && baseRow.data.variant_id !== variant.id) fail('invalid_input', 'Base revision belongs to a different variant');
  const editsWorkingDraft = mode === 'human' && expected === undefined &&
    (current ? hash(variant.data.draft_doc) !== current.data.content_hash : variant.version > 1) &&
    hash(draftFor(input, variant.data.platform, variant.data.draft_doc)) !== hash(variant.data.draft_doc);
  const conflict = (base !== undefined && base !== (current?.id ?? null)) ||
    (expected !== undefined && expected !== variant.version) || !!editsWorkingDraft;
  const prior = conflict && base !== undefined ? baseRow ? snapshot(baseRow) : {} : variant.data.draft_doc;
  const draft = restored ? snapshot(restored) : draftFor(input, variant.data.platform, prior, mode === 'agent' || machineActor(ctx));
  if (conflict) {
    const baseSnapshot = baseRow ? snapshot(baseRow) : null;
    const currentSnapshot = current ? snapshot(current) : null;
    fail('VERSION_CONFLICT', 'Content has changed since editing started', 409, {
      base_revision_id: base, current_revision_id: current?.id ?? null, current_version: variant.version,
      base: baseSnapshot, mine: draft, current: currentSnapshot, current_draft: variant.data.draft_doc,
      diff: { base_to_mine: changedFields(baseSnapshot, draft), base_to_current: changedFields(baseSnapshot, currentSnapshot),
        mine_to_current_draft: changedFields(draft, variant.data.draft_doc) },
    });
  }
  return { variant, draft };
}

export async function autosave(ctx: Context, input: Fields) {
  const { variant, draft } = await prepareEdit(ctx, input, 'draft');
  const prior = variant.data.draft_doc.product_refs ?? [];
  await rejectNewEstimatedPrices(ctx, draft.product_refs, prior);
  const pinned = await pinProductFacts(ctx, variant.data, draft, prior);
  return saveDraft(ctx, variant, pinned);
}

export async function insertProductFact(ctx: Context, input: Fields) {
  const { variant, draft } = await prepareEdit(ctx, { variant_id: input.variant_id, expected_version: input.expected_version }, 'draft');
  const ref = { variant_id: text(input.product_variant_id, 'product_variant_id'), fact_revision_id: text(input.fact_revision_id, 'fact_revision_id') };
  const added = await pinProductFacts(ctx, variant.data, { product_refs: [ref] }, []);
  return appendProductPin(ctx, variant, draft, added.product_refs[0]);
}

export async function insertProductPrice(ctx: Context, input: Fields) {
  const { variant, draft } = await prepareEdit(ctx, { variant_id: input.variant_id, expected_version: input.expected_version }, 'draft');
  const pin = await requirePricePin(ctx, variant, text(input.listing_snapshot_id, 'listing_snapshot_id'));
  return appendProductPin(ctx, variant, draft, pin);
}

function appendProductPin(ctx: Context, variant: Entity, draft: Fields, pin: Fields) {
  if (draft.product_refs.length >= 100) fail('invalid_input', 'Too many product references');
  const body_doc = { ...draft.body_doc, content: [...(draft.body_doc.content ?? []), { type: 'paragraph', content: [{ type: 'text', text: pin.inserted_text }] }] };
  const product_refs = [...draft.product_refs, pin];
  const edited = draftFor({ body_doc }, variant.data.platform, draft);
  return saveDraft(ctx, variant, { ...edited, product_refs });
}

async function saveDraft(ctx: Context, variant: Entity, draft: Fields) {
  if (hash(draft) === hash(variant.data.draft_doc)) return variant;
  if (variant.data.readiness !== 'ready') return update(ctx, variant, { draft_doc: draft });
  const result = await update(ctx, variant, { draft_doc: draft, ...readinessData('draft') });
  await emit(ctx, 'variant.readiness_changed', { variant_id: variant.id, readiness: 'draft', stale_reasons: [] });
  return result;
}
export async function diffRevisions(ctx: Context, input: Fields) {
  const a = await get(ctx, kinds.revision, id(input, 'revision_a'));
  const b = await get(ctx, kinds.revision, id(input, 'revision_b'));
  const before = snapshot(a);
  const after = snapshot(b);
  const fields = changedFields(before, after);
  return { revision_a: a.id, revision_b: b.id, changed_fields: fields, changes: Object.fromEntries(fields.map(field => [field, { before: before[field], after: after[field] }])) };
}

const staleEvents: Record<string, { kind: string; types: string[]; keys: string[] }> = {
  'commerce.fact.revised': { kind: 'fact_revised', types: ['product_fact_revision'], keys: ['previous_revision_id', 'previous_fact_revision_id', 'fact_revision_id'] },
  'commerce.fact.approved': { kind: 'fact_revised', types: ['product_fact_revision'], keys: ['previous_revision_id'] },
  'commerce.fact.retracted': { kind: 'fact_revised', types: ['product_fact_revision'], keys: ['fact_revision_id', 'revision_id'] },
  'commerce.listing.changed': { kind: 'listing_changed', types: ['listing_snapshot'], keys: ['previous_snapshot_id', 'previous_listing_snapshot_id', 'listing_snapshot_id'] },
  'asset.rights_grant.expiring': { kind: 'rights_expiring', types: ['asset', 'asset_version'], keys: ['asset_id', 'asset_version_id'] },
  'asset.rights_grant.expired': { kind: 'rights_expired', types: ['asset', 'asset_version'], keys: ['asset_id', 'asset_version_id'] },
  'asset.rights_grant.revoked': { kind: 'rights_revoked', types: ['asset', 'asset_version'], keys: ['asset_id', 'asset_version_id'] },
  'asset.version.created': { kind: 'asset_updated', types: ['asset', 'asset_version'], keys: ['asset_id', 'previous_asset_version_id'] },
};

function glossaryApplies(entry: Fields, variant: Fields) {
  return (!Array.isArray(entry.locales) || entry.locales.includes(variant.locale)) &&
    (!Array.isArray(entry.market_ids) || entry.market_ids.includes(variant.market_id ?? variant.market));
}

async function refreshGlossaryReview(ctx: Context, event: string, payload: Fields) {
  const entryId = payload.knowledge_entry_id ?? payload.entry_id;
  const entries = await list(ctx, 'knowledge_entry', 'asset');
  const entry = entries.find(row => row.id === entryId);
  const kind = entry?.data.kind ?? payload.kind;
  if (kind !== 'glossary' && kind !== 'glossary_term') return;
  if (entry && (event === 'asset.knowledge.retired' ? entry.data.status !== 'retired'
    : entry.data.status !== 'active' || (payload.knowledge_revision_id && entry.data.active_revision_id !== payload.knowledge_revision_id))) return;
  const brand = entry?.data.brand_id ?? payload.brand_id;
  if (typeof brand !== 'string') return;
  const active = entries.filter(row => row.data.brand_id === brand && row.data.status === 'active' &&
    ['glossary', 'glossary_term'].includes(row.data.kind) && row.data.active_revision_id)
    .sort((a, b) => (b.data.priority ?? 0) - (a.data.priority ?? 0) || a.id.localeCompare(b.id));
  const variants = new Map((await list(ctx, kinds.variant)).map(variant => [variant.id, variant]));
  const items = new Map((await list(ctx, kinds.item)).map(item => [item.id, item]));
  for (const link of await list(ctx, kinds.translation)) {
    const target = variants.get(link.data.target_variant_id);
    const source = variants.get(link.data.source_variant_id);
    if (!target || items.get(target.data.content_item_id)?.data.brand_id !== brand) continue;
    if (entry && !glossaryApplies(entry.data, target.data) && !(source && glossaryApplies(entry.data, source.data))) continue;
    if (!entry && payload.locale && target.data.locale !== payload.locale) continue;
    const glossaryVersion = entry ? hash(active.filter(row => glossaryApplies(row.data, target.data) ||
      (source && glossaryApplies(row.data, source.data))).map(row => row.data.active_revision_id)) : payload.glossary_version ?? payload.knowledge_revision_id;
    if (typeof glossaryVersion !== 'string' || glossaryVersion === link.data.glossary_version) continue;
    if (!['source_changed', 'needs_review'].includes(link.data.status)) await update(ctx, link, { status: 'needs_review' });
    const previous: Fields[] = target.data.stale_reasons ?? [];
    const reason = { kind: 'glossary_changed', ref_id: entryId ?? link.id, glossary_version: glossaryVersion };
    const reasons = previous.filter(value => value.kind !== 'glossary_changed');
    await setReadiness(ctx, target, 'stale', [...reasons, reason]);
  }
}

/** Dispatch these workspace-scoped handlers from the trusted event consumer. */
export async function handleContentEvent(ctx: Context, event: string, payload: Fields) {
  if (event === 'asset.knowledge.activated' || event === 'asset.knowledge.retired') {
    await refreshGlossaryReview(ctx, event, payload);
    return;
  }
  const mapping = Object.hasOwn(staleEvents, event) ? staleEvents[event] : undefined;
  if (!mapping) return;
  // An agent upload's first version is the bytes of an asset that was already referenced while uploading (§6.4 step 3.4),
  // not a content change: posts scheduled during the upload must not go stale when it completes (S5 ledger item 11).
  if (event === 'asset.version.created' && payload.source === 'agent_upload') return;
  const referenceIds = new Set(mapping.keys.map(key => payload[key]).filter(Boolean));
  if (payload.fact_id && ['commerce.fact.approved', 'commerce.fact.retracted'].includes(event)) {
    const fact = await ctx.get('commerce', 'product_fact', payload.fact_id);
    if (event === 'commerce.fact.approved' && fact?.data.approved_revision_id !== payload.revision_id) return;
    for (const revision of await list(ctx, 'product_fact_revision', 'commerce')) {
      if (revision.data.fact_id === payload.fact_id && (event === 'commerce.fact.retracted' || revision.id !== payload.revision_id)) referenceIds.add(revision.id);
    }
  }
  if (event === 'commerce.listing.changed' && payload.variant_id && payload.market_id) {
    for (const snapshot of await list(ctx, 'listing_snapshot', 'commerce')) {
      if (snapshot.data.variant_id === payload.variant_id && snapshot.data.market_id === payload.market_id &&
          (!payload.channel || snapshot.data.channel === payload.channel) && snapshot.id !== payload.snapshot_id && snapshot.data.is_current !== true) referenceIds.add(snapshot.id);
    }
  }
  const grantId = event.startsWith('asset.rights_grant.') ? payload.rights_grant_id : undefined;
  if (grantId) {
    const grant = await ctx.get('asset', 'rights_grant', grantId);
    if (grant && grant.data.status !== event.split('.').at(-1)) return;
    const scopes = (await list(ctx, 'rights_grant_asset', 'asset')).filter(link => link.data.rights_grant_id === grantId);
    const versions = await list(ctx, 'asset_version', 'asset');
    for (const link of scopes) {
      if (link.data.version_scope === 'specific_version') referenceIds.add(link.data.asset_version_id);
      else {
        referenceIds.add(link.data.asset_id);
        for (const version of versions) if (version.data.asset_id === link.data.asset_id) referenceIds.add(version.id);
      }
    }
  }
  if (!referenceIds.size) return;
  const matching = (await list(ctx, kinds.reference)).filter(row => mapping.types.includes(row.data.ref_type) && referenceIds.has(row.data.ref_id));
  for (const variant of await list(ctx, kinds.variant)) {
    const affected = matching.filter(row => row.data.revision_id === variant.data.current_revision_id);
    if (mapping.kind === 'fact_revised') {
      const workingRefs = (variant.data.draft_doc?.product_refs ?? []) as Fields[];
      const factIds = new Set([...affected.map(row => row.data.ref_id), ...workingRefs.map(ref => ref.fact_revision_id).filter(id => referenceIds.has(id))]);
      if (factIds.size) await setReadiness(ctx, variant, 'stale', [...(variant.data.stale_reasons ?? []),
        ...[...factIds].filter(id => !(variant.data.stale_reasons ?? []).some((reason: Fields) => reason.kind === mapping.kind && reason.ref_id === id))
          .map(ref_id => ({ kind: mapping.kind, ref_id }))]);
      continue;
    }
    if (!affected.length) continue;
    if (grantId || (mapping.kind === 'asset_updated' && payload.asset_version_id)) {
      const head = await currentRevision(ctx, variant);
      const media = (head?.data.media ?? []) as Fields[];
      if (grantId) {
        const attachments = media.filter(entry => referenceIds.has(entry.asset_id) || referenceIds.has(entry.asset_version_id));
        const coverage = await Promise.all(attachments.map(entry => assetUsage(ctx, entry, variant.data.platform,
          variant.data.market_id ?? variant.data.market, head?.data.body ?? '', ctx.now, variant.data.brand_id)));
        const expiring = mapping.kind === 'rights_expiring';
        const relevant = expiring ? coverage.some(result => result.allowed && result.grant_id === grantId)
          : coverage.some(result => !result.allowed);
        const notices: Fields[] = variant.data.notices ?? [];
        const hadNotice = notices.some(notice => notice.kind === 'rights_expiring' && notice.ref_id === grantId);
        const needsNotice = expiring && relevant;
        const next = needsNotice ? [...notices, { kind: 'rights_expiring', ref_id: grantId }]
          : notices.filter(notice => notice.kind !== 'rights_expiring' || notice.ref_id !== grantId);
        const updated = hadNotice === needsNotice ? variant : await update(ctx, variant, { notices: next });
        if (!expiring && relevant) await stale(ctx, updated, { kind: mapping.kind, ref_id: grantId });
        continue;
      }
      const version = await ctx.get('asset', 'asset_version', payload.asset_version_id);
      const asset = payload.asset_id && await ctx.get('asset', 'asset', payload.asset_id);
      if (asset?.data.current_version_id && asset.data.current_version_id !== payload.asset_version_id) continue;
      if (!media.some(entry => (entry.asset_id === payload.asset_id || entry.asset_id === version?.data.asset_id || entry.asset_version_id === payload.previous_asset_version_id) &&
        entry.asset_version_id !== payload.asset_version_id)) continue;
      const ref_id = payload.asset_id ?? version?.data.asset_id ?? payload.previous_asset_version_id;
      const notices: Fields[] = variant.data.notices ?? [];
      const next = [...notices.filter(notice => notice.kind !== 'asset_updated' || notice.ref_id !== ref_id),
        { kind: 'asset_updated', ref_id, asset_version_id: payload.asset_version_id }];
      if (hash(notices) !== hash(next)) await update(ctx, variant, { notices: next });
      continue;
    }
    for (const refId of new Set(affected.map(row => row.data.ref_id))) {
      const reason = { kind: mapping.kind, ref_id: refId };
      if (['rights_expiring', 'asset_updated'].includes(mapping.kind)) {
        const notices: Fields[] = variant.data.notices ?? [];
        if (!notices.some(notice => hash(notice) === hash(reason))) Object.assign(variant, await update(ctx, variant, { notices: [...notices, reason] }));
      } else Object.assign(variant, await stale(ctx, variant, reason));
    }
  }
}
