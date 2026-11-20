import { required, text, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { rightsCheck } from './creatives.js';
import { accountAccess, accountFor, ads, check, cmd, currency, draft, eventData, expected, hash, inputRow, integer, jsonObject, matchingCampaign, obj, oneOf, operationKinds, optional, patch, read, refs, review, row, same, state, timestamp, timezone } from './domain.js';

const rules: Record<string, { objectives: string[]; placements: string[] }> = {
  meta_ads: { objectives: ['awareness', 'traffic', 'engagement', 'leads', 'app_promotion', 'sales'], placements: ['facebook_feed', 'instagram_feed', 'facebook_stories', 'instagram_stories', 'facebook_reels', 'instagram_reels'] },
  tiktok_ads: { objectives: ['reach', 'traffic', 'video_views', 'lead_generation', 'app_promotion', 'website_conversions', 'sales'], placements: ['tiktok'] },
  google_ads: { objectives: ['sales', 'leads', 'website_traffic', 'product_and_brand_consideration', 'brand_awareness_and_reach', 'app_promotion'], placements: ['search', 'display', 'youtube', 'shopping'] },
};
const pendingOperations = new Set(['awaiting_manual_result', 'awaiting_reconciliation', 'outcome_unknown', 'accepted', 'platform_review', 'retryable']);

export function unsupportedAdFields(provider: string, objective: string, placements: string[], options: Record<string, unknown>) {
  const rule = Object.hasOwn(rules, provider) ? rules[provider] : undefined;
  const fields = [];
  if (!rule?.objectives.includes(objective)) fields.push({ field: 'objective', value: objective, disabled: true });
  for (const placement of placements) if (!rule?.placements.includes(placement)) fields.push({ field: 'placements', value: placement, disabled: true });
  for (const [key, value] of Object.entries(options)) fields.push({ field: `platform_options.${key}`, value, disabled: true });
  return fields;
}

async function configuration(ctx: Context, account: Entity, campaignId: string, input: Fields) {
  const objective = text(input, 'objective', 100);
  const market_ids = refs(input.market_ids, 'market_ids', 1);
  const regions = [...new Set(await Promise.all(market_ids.map(async id => {
    const market = await required(ctx, 'workspace', 'market', id);
    same(market.data.brand_id, account.data.brand_id, 'Market');
    check(typeof market.data.country_code === 'string' && /^[A-Z]{2}$/.test(market.data.country_code), 'invalid_input', 'Market must have a valid country code');
    return market.data.country_code as string;
  })))].sort();
  const product_variant_ids = refs(input.product_variant_ids ?? [], 'product_variant_ids');
  for (const id of product_variant_ids) {
    const variant = await required(ctx, 'commerce', 'product_variant', id);
    const product = await required(ctx, 'commerce', 'product', variant.data.product_id);
    same(product.data.brand_id ?? (await required(ctx, 'commerce', 'store', variant.data.store_id)).data.brand_id, account.data.brand_id, 'Product variant');
    check(variant.data.status === 'active' && variant.data.rolled_back !== true, 'invalid_state', 'Product variant is unavailable', 409);
  }
  const placements = refs(input.placements, 'placements', 1);
  const sched = obj(input.schedule, 'schedule');
  const schedule = { start_at: timestamp(sched.start_at, 'start_at'), end_at: timestamp(sched.end_at, 'end_at'), timezone: timezone(sched.timezone) };
  check(schedule.end_at > schedule.start_at && Date.parse(schedule.end_at) > Date.parse(ctx.now), 'invalid_input', 'Schedule must have an unexpired, ordered window');
  const rawBudget = obj(input.budget, 'budget');
  const budget = { type: oneOf(rawBudget.type, ['daily', 'lifetime'] as const, 'type'), amount_minor: integer(rawBudget.amount_minor, 'amount_minor', 1),
    currency: currency(rawBudget.currency), cap_minor: integer(rawBudget.cap_minor, 'cap_minor', 1) };
  check(budget.currency === account.data.currency, 'currency_mismatch', 'Budget currency must match the ad account');
  check(budget.amount_minor <= budget.cap_minor, 'spend_limit_exceeded', 'Budget amount exceeds its cap');
  const creative_variant_ids = refs(input.creative_variant_ids, 'creative_variant_ids', 1);
  const creative_versions = await Promise.all(creative_variant_ids.map(async id => {
    const variant = await row(ctx, 'ad_creative_variant', id);
    same(variant.data.ad_account_id, account.id, 'Creative variant');
    same(variant.data.campaign_id, campaignId, 'Creative variant campaign');
    return { id, content_hash: variant.data.content_hash };
  }));
  const rawEstimates = input.estimates ?? [];
  check(Array.isArray(rawEstimates) && rawEstimates.length <= 20, 'invalid_input', 'Invalid estimates');
  const estimates = rawEstimates.map(raw => {
    const value = obj(raw, 'estimate');
    const curr = value.currency == null ? null : currency(value.currency);
    check(!curr || curr === budget.currency, 'currency_mismatch', 'Estimate currency must match the budget');
    return { metric: text(value, 'metric', 100), value: integer(value.value, 'estimate.value'), currency: curr, source: text(value, 'source', 400), estimate: true };
  });
  const audience_spec = jsonObject(input.audience_spec ?? {}, 'audience_spec');
  const platform_options = jsonObject(input.platform_options ?? {}, 'platform_options');
  const unsupported_fields = unsupportedAdFields(account.data.provider, objective, placements, platform_options);
  const op = obj(input.operation ?? { kind: 'launch' }, 'operation');
  const kind = oneOf(op.kind, operationKinds, 'operation.kind');
  const target_entity_id = optional(op, 'target_entity_id', 200);
  check(kind === 'create_external_draft' ? !target_entity_id : kind === 'launch' || !!target_entity_id, 'invalid_input', 'Invalid target for this operation');
  const target = target_entity_id ? await row(ctx, 'ad_entity', target_entity_id) : null;
  if (target) {
    same(target.data.ad_account_id, account.id, 'Operation target');
    same(target.data.campaign_id, campaignId, 'Operation target campaign');
  }
  const prior = target?.data.budget_snapshot;
  if (kind === 'update_budget') {
    check(prior?.type === budget.type && prior?.currency === budget.currency, 'invalid_input', 'Budget update requires a comparable target budget snapshot');
  }
  const spend_delta_minor = kind === 'launch' || kind === 'resume' ? budget.cap_minor
    : kind === 'update_budget' ? Math.max(0, budget.cap_minor - prior.amount_minor) : 0;
  if (kind === 'resume') {
    check(prior?.type === budget.type && prior?.currency === budget.currency && prior.amount_minor <= budget.cap_minor,
      'invalid_input', 'Resume requires a known target budget within the approved spending cap');
  }
  return { objective, market_ids, regions, product_variant_ids, audience_spec, placements, schedule, budget, creative_variant_ids, creative_versions,
    estimates, platform_options, unsupported_fields, operation: { kind, target_entity_id, target_version: target?.version ?? null,
      target_external_id: target?.data.external_id ?? null, spend_delta_minor } };
}

export async function revisionFor(ctx: Context, proposal: Entity, input?: Fields): Promise<Entity> {
  const revision = await row(ctx, 'ad_proposal_revision', proposal.data.current_revision_id);
  same(revision.data.proposal_id, proposal.id, 'Proposal revision');
  if (input) check(text(input, 'revision_hash', 64) === revision.data.content_hash, 'version_conflict', 'Proposal revision hash changed', 409);
  return revision;
}

export async function buildPreview(ctx: Context, account: Entity, revision: Entity) {
  const data = revision.data;
  const rights = await rightsCheck(ctx, account, data);
  const blockers: Fields[] = [...rights.blockers, ...data.unsupported_fields.map((entry: Fields) => ({ ...entry, reason: 'unsupported_field' }))];
  if (account.data.status_snapshot !== 'active' && data.operation.kind !== 'pause') blockers.push({ reason: 'account_unavailable' });
  if (data.budget.currency !== account.data.currency) blockers.push({ reason: 'currency_mismatch' });
  if (data.operation.kind !== 'pause' && (data.budget.cap_minor > account.data.spend_cap_snapshot || data.operation.spend_delta_minor > account.data.spend_cap_snapshot)) {
    blockers.push({ reason: 'account_spend_cap_exceeded' });
  }
  if (Date.parse(data.schedule.end_at) <= Date.parse(ctx.now)) blockers.push({ reason: 'schedule_ended' });
  if (data.operation.target_entity_id) {
    const target = await row(ctx, 'ad_entity', data.operation.target_entity_id);
    if (target.version !== data.operation.target_version || target.data.external_id !== data.operation.target_external_id) blockers.push({ reason: 'target_snapshot_changed' });
  }
  const binding = { revision_hash: data.content_hash, rights: rights.evidence, blockers };
  return { ...binding, preview_hash: hash(binding), rights_check: rights, unsupported_fields: data.unsupported_fields,
    planned_budget: data.budget, estimates: data.estimates, actual_spend_minor: null, operation: data.operation };
}

export async function createRevision(ctx: Context, proposal: Entity, account: Entity, config: Fields) {
  const data = await configuration(ctx, account, proposal.data.campaign_id, config);
  const revision_no = (proposal.data.revision_no ?? 0) + 1;
  const content_hash = hash({ proposal_id: proposal.id, revision_no, ...data });
  return ctx.insert(ads, 'ad_proposal_revision', { ...data, proposal_id: proposal.id, ad_account_id: account.id, brand_id: account.data.brand_id,
    campaign_id: proposal.data.campaign_id, revision_no, content_hash, created_by: ctx.actorId }, hash(['proposal_revision', proposal.id, String(revision_no)]));
}

export async function replaceRevision(ctx: Context, proposal: Entity, account: Entity, config: Fields) {
  state(proposal, 'draft', 'rejected', 'approved', 'exported', 'launched', 'external_draft');
  const old = await revisionFor(ctx, proposal);
  const operations = await ctx.list(ads, 'ad_operation');
  check(!operations.some(item => item.data.proposal_id === proposal.id && pendingOperations.has(item.data.status)),
    'invalid_state', 'Resolve the outstanding manual operation before revising', 409);
  if (proposal.data.approval_request_id) {
    const approval = await required(ctx, 'core', 'approval_request', proposal.data.approval_request_id);
    if (approval.data.status === 'approved') {
      const invalidated = await patch(ctx, approval, { status: 'invalidated', invalidated_at: ctx.now });
      await ctx.emit('core.approval_request.invalidated', eventData(ctx, invalidated, { resource_id: proposal.id, resource_type: 'ads.ad_proposal' }));
    }
  }
  const revision = await createRevision(ctx, proposal, account, config);
  const updated = await patch(ctx, proposal, { status: 'draft', current_revision_id: revision.id, revision_no: revision.data.revision_no,
    approval_request_id: null, current_preview_id: null, current_review_id: null, submitted_by: null,
    author_ids: [...new Set([...proposal.data.author_ids, ctx.actorId])] });
  await ctx.emit('ads.proposal.revision_superseded', eventData(ctx, updated, { previous_revision_id: old.id, revision_id: revision.id, revision_hash: revision.data.content_hash }));
  return { proposal: updated, revision };
}

function independent(ctx: Context, proposal: Entity): void {
  check(!proposal.data.author_ids.includes(ctx.actorId) && proposal.data.submitted_by !== ctx.actorId,
    'separation_of_duties', 'Proposal authors and submitters may not review or approve the proposal', 403);
}

async function currentRequest(ctx: Context, proposal: Entity, revision: Entity) {
  const approval = await required(ctx, 'core', 'approval_request', proposal.data.approval_request_id);
  check(approval.data.resource_type === 'ads.ad_proposal' && approval.data.resource_id === proposal.id &&
    approval.data.resource_hash === revision.data.content_hash && approval.data.revision_id === revision.id,
    'approval_required', 'Approval does not bind the current proposal revision', 409);
  return approval;
}

export async function approvedRevision(ctx: Context, proposal: Entity, revision: Entity, account: Entity) {
  const approval = await currentRequest(ctx, proposal, revision);
  check(approval.data.status === 'approved' && Date.parse(approval.data.expires_at) > Date.parse(ctx.now),
    'approval_required', 'An active approval of this revision is required', 409);
  const preview = await buildPreview(ctx, account, revision);
  check(preview.blockers.length === 0 && preview.preview_hash === approval.data.preview_hash, 'preview_stale', 'Approved preview no longer matches current rights or account state', 409);
  return approval;
}

async function decide(ctx: Context, input: Fields, approve: boolean) {
  const proposal = await inputRow(ctx, 'ad_proposal', input);
  const account = await accountFor(ctx, proposal, 'approve');
  state(proposal, 'in_review');
  expected(proposal, input);
  independent(ctx, proposal);
  const revision = await revisionFor(ctx, proposal, input);
  const approval = await currentRequest(ctx, proposal, revision);
  state(approval, 'pending');
  const note = approve ? optional(input, 'note', 2000) : text(input, 'note', 2000);
  if (approve) {
    check(proposal.data.current_review_id, 'review_required', 'Record an independent review before approval', 409);
    const recorded = await row(ctx, 'ad_proposal_review', proposal.data.current_review_id);
    check(recorded.data.revision_id === revision.id && recorded.data.recommendation === 'approve', 'review_required', 'A favorable review of this revision is required', 409);
    const preview = await buildPreview(ctx, account, revision);
    check(preview.blockers.length === 0 && preview.preview_hash === approval.data.preview_hash, 'preview_stale', 'Reviewed preview changed', 409);
    check(Date.parse(approval.data.expires_at) > Date.parse(ctx.now), 'approval_required', 'Review window has expired', 409);
    if (revision.data.operation.spend_delta_minor > 0) accountAccess(ctx, account, 'spend', revision.data.operation.spend_delta_minor);
  }
  const status = approve ? 'approved' : 'rejected';
  await patch(ctx, approval, { status, decided_by: ctx.actorId, decided_at: ctx.now, note });
  const updated = await patch(ctx, proposal, { status });
  const event = eventData(ctx, updated, { approval_request_id: approval.id, revision_hash: revision.data.content_hash, resource_id: proposal.id, resource_type: 'ads.ad_proposal' });
  await ctx.emit(`core.approval_request.${status}`, event);
  await ctx.emit(`ads.proposal.${status}`, event);
  return updated;
}

export const proposals: Commands = {
  create_proposal: cmd(draft, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'draft');
    const campaign_id = text(input, 'campaign_id', 200);
    await matchingCampaign(ctx, campaign_id, account.data.brand_id);
    const experiment_id = optional(input, 'experiment_id', 200);
    if (experiment_id) {
      const experiment = await required(ctx, 'analytics', 'experiment', experiment_id);
      same(experiment.data.campaign_id, campaign_id, 'Experiment');
    }
    const proposal = await ctx.insert(ads, 'ad_proposal', { ad_account_id: account.id, brand_id: account.data.brand_id, campaign_id, experiment_id,
      name: text(input, 'name', 200), status: 'draft', revision_no: 0, approval_request_id: null, current_preview_id: null, current_review_id: null,
      created_by: ctx.actorId, author_ids: [ctx.actorId] });
    const revision = await createRevision(ctx, proposal, account, obj(input.revision, 'revision'));
    const updated = await patch(ctx, proposal, { current_revision_id: revision.id, revision_no: revision.data.revision_no });
    await ctx.emit('ads.proposal.created', eventData(ctx, updated, { revision_id: revision.id, revision_hash: revision.data.content_hash }));
    return { proposal: updated, revision };
  }),
  revise_proposal: cmd(draft, async (ctx, input) => {
    const proposal = await inputRow(ctx, 'ad_proposal', input);
    const account = await accountFor(ctx, proposal, 'draft');
    expected(proposal, input);
    await revisionFor(ctx, proposal, input);
    return replaceRevision(ctx, proposal, account, obj(input.revision, 'revision'));
  }),
  list_proposals: cmd(read, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'read');
    const campaignId = optional(input, 'campaign_id', 200);
    return { items: (await ctx.list(ads, 'ad_proposal')).filter(item => item.data.ad_account_id === account.id && (!campaignId || item.data.campaign_id === campaignId)) };
  }),
  get_proposal: cmd(read, async (ctx, input) => {
    const proposal = await inputRow(ctx, 'ad_proposal', input);
    await accountFor(ctx, proposal, 'read');
    const items = async (kind: string) => (await ctx.list(ads, kind)).filter(item => item.data.proposal_id === proposal.id);
    return { proposal, revisions: await items('ad_proposal_revision'), previews: await items('ad_proposal_preview'), reviews: await items('ad_proposal_review'),
      exports: await items('ad_proposal_export'), operations: await items('ad_operation') };
  }),
  preview_proposal: cmd(draft, async (ctx, input) => {
    const proposal = await inputRow(ctx, 'ad_proposal', input);
    const account = await accountFor(ctx, proposal, 'draft');
    state(proposal, 'draft');
    expected(proposal, input);
    const revision = await revisionFor(ctx, proposal, input);
    const data = await buildPreview(ctx, account, revision);
    const preview = await ctx.insert(ads, 'ad_proposal_preview', { ...data, proposal_id: proposal.id, revision_id: revision.id,
      ad_account_id: account.id, generated_by: ctx.actorId });
    const updated = await patch(ctx, proposal, { current_preview_id: preview.id });
    await ctx.emit('ads.proposal.previewed', eventData(ctx, updated, { preview_id: preview.id, revision_hash: revision.data.content_hash }));
    return { proposal: updated, preview };
  }),
  submit_proposal: cmd(draft, async (ctx, input) => {
    const proposal = await inputRow(ctx, 'ad_proposal', input);
    const account = await accountFor(ctx, proposal, 'draft');
    state(proposal, 'draft');
    expected(proposal, input);
    const revision = await revisionFor(ctx, proposal, input);
    check(proposal.data.current_preview_id && text(input, 'preview_id', 200) === proposal.data.current_preview_id, 'preview_required', 'Submit the current preview', 409);
    const previous = await row(ctx, 'ad_proposal_preview', proposal.data.current_preview_id);
    const preview = await buildPreview(ctx, account, revision);
    check(preview.blockers.length === 0, 'proposal_blocked', `Preview blockers: ${preview.blockers.map(item => item.reason).join(', ')}`, 409);
    check(preview.preview_hash === previous.data.preview_hash, 'preview_stale', 'Generate a new preview', 409);
    const expires_at = new Date(Math.min(Date.parse(ctx.now) + 7 * 86400000, Date.parse(revision.data.schedule.end_at))).toISOString();
    const approval = await ctx.insert('core', 'approval_request', { resource_type: 'ads.ad_proposal', resource_id: proposal.id,
      resource_hash: revision.data.content_hash, revision_id: revision.id, ad_account_id: account.id, preview_hash: preview.preview_hash,
      requested_by: ctx.actorId, status: 'pending', expires_at });
    const submitted = await patch(ctx, proposal, { status: 'in_review', submitted_by: ctx.actorId, approval_request_id: approval.id });
    await ctx.emit('core.approval_request.created', eventData(ctx, approval, { resource_id: proposal.id, resource_type: 'ads.ad_proposal' }));
    await ctx.emit('ads.proposal.submitted', eventData(ctx, submitted, { approval_request_id: approval.id, revision_hash: revision.data.content_hash }));
    return submitted;
  }),
  review_proposal: cmd(review, async (ctx, input) => {
    const proposal = await inputRow(ctx, 'ad_proposal', input);
    const account = await accountFor(ctx, proposal, 'review');
    state(proposal, 'in_review');
    expected(proposal, input);
    independent(ctx, proposal);
    const revision = await revisionFor(ctx, proposal, input);
    const approval = await currentRequest(ctx, proposal, revision);
    state(approval, 'pending');
    const preview = await buildPreview(ctx, account, revision);
    const recommendation = oneOf(input.recommendation, ['approve', 'reject'] as const, 'recommendation');
    if (recommendation === 'approve') check(preview.blockers.length === 0 && preview.preview_hash === approval.data.preview_hash,
      'preview_stale', 'Current preview no longer matches submitted preview', 409);
    const record = await ctx.insert(ads, 'ad_proposal_review', { proposal_id: proposal.id, ad_account_id: account.id, revision_id: revision.id,
      revision_hash: revision.data.content_hash, preview_hash: preview.preview_hash, recommendation, note: text(input, 'note', 2000), reviewed_by: ctx.actorId });
    const updated = await patch(ctx, proposal, { current_review_id: record.id });
    await ctx.emit('ads.proposal.reviewed', eventData(ctx, updated, { review_id: record.id, recommendation }));
    return { proposal: updated, review: record };
  }),
  approve_proposal: cmd(review, (ctx, input) => decide(ctx, input, true)),
  reject_proposal: cmd(review, (ctx, input) => decide(ctx, input, false)),
  export_proposal: cmd(draft, async (ctx, input) => {
    const proposal = await inputRow(ctx, 'ad_proposal', input);
    const account = await accountFor(ctx, proposal, 'export');
    state(proposal, 'approved');
    expected(proposal, input);
    const revision = await revisionFor(ctx, proposal, input);
    const approval = await approvedRevision(ctx, proposal, revision, account);
    const checklist = { account: { provider: account.data.provider, external_account_id: account.data.external_account_id, timezone: account.data.timezone },
      revision_hash: revision.data.content_hash, objective: revision.data.objective, operation: revision.data.operation, schedule: revision.data.schedule,
      markets: revision.data.market_ids, audience_spec: revision.data.audience_spec, placements: revision.data.placements, budget: revision.data.budget,
      creative_variant_ids: revision.data.creative_variant_ids, estimates: revision.data.estimates };
    const csv = Object.entries(checklist).map(([key, value]) => {
      const cell = typeof value === 'string' ? (/^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value) : JSON.stringify(value);
      return `${key},"${cell.replaceAll('"', '""')}"`;
    }).join('\r\n');
    const record = await ctx.insert(ads, 'ad_proposal_export', { proposal_id: proposal.id, ad_account_id: account.id, revision_id: revision.id,
      approval_request_id: approval.id, exported_by: ctx.actorId, format: 'csv', checklist, csv: `field,value\r\n${csv}\r\n` });
    const updated = await patch(ctx, proposal, { status: 'exported' });
    await ctx.emit('ads.proposal.exported', eventData(ctx, updated, { export_id: record.id, revision_hash: revision.data.content_hash }));
    return { proposal: updated, export: record };
  }),
};
