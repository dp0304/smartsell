import { text, type Commands } from '../types.js';
import { accountAccess, accountFor, ads, bool, check, cmd, draft, eventData, expected, inputRow, integer, localDay, obj, oneOf, patch, read, refs, row, same, state } from './domain.js';
import { buildPreview, replaceRevision, revisionFor } from './proposals.js';

const kinds = ['pause', 'scale', 'reallocate', 'swap_creative'] as const;
const intentByKind = { pause: 'pause', scale: 'update_budget', reallocate: 'update_budget', swap_creative: 'update_creative' } as const;

export const adjustments: Commands = {
  create_adjustment: cmd(draft, async (ctx, input) => {
    const proposal = await inputRow(ctx, 'ad_proposal', input, 'proposal_id');
    const account = await accountFor(ctx, proposal, 'draft');
    const revision = await revisionFor(ctx, proposal, input);
    const target = await inputRow(ctx, 'ad_entity', input, 'target_entity_id');
    same(target.data.ad_account_id, account.id, 'Adjustment target');
    same(target.data.campaign_id, proposal.data.campaign_id, 'Adjustment campaign');
    const kind = oneOf(input.kind, kinds, 'kind');
    const evidence_refs = refs(input.evidence_refs, 'evidence_refs', 1);
    let sampleSize = 0;
    const observations = new Set<string>();
    for (const id of evidence_refs) {
      const snapshot = await row(ctx, 'ad_performance_snapshot', id);
      same(snapshot.data.ad_account_id, account.id, 'Adjustment evidence account');
      same(snapshot.data.campaign_id, proposal.data.campaign_id, 'Adjustment evidence campaign');
      if (snapshot.data.entity_id) same(snapshot.data.entity_id, target.id, 'Adjustment evidence subject');
      for (const observationId of snapshot.data.observation_ids as string[]) observations.add(observationId);
    }
    for (const id of observations) {
      const observation = await ctx.get('analytics', 'metric_observation', id);
      if (observation?.data.availability === 'observed' && Number.isFinite(observation.data.value)) sampleSize += 1;
    }
    check(sampleSize > 0, 'insufficient_evidence', 'Evidence must contain at least one observed measurement', 409);
    const minimumSample = integer(input.minimum_sample_size, 'minimum_sample_size', 1);
    const concurrentPromotion = bool(input.concurrent_promotion, 'concurrent_promotion');
    const preview = await buildPreview(ctx, account, revision);
    const listingRows = await ctx.list('commerce', 'listing_snapshot');
    const products = revision.data.product_variant_ids as string[];
    const markets = revision.data.market_ids as string[];
    const inventory = products.length ? products.every(variantId => markets.every(marketId => listingRows.some(listing =>
      listing.data.variant_id === variantId && listing.data.market_id === marketId && listing.data.is_current === true &&
      ['available', 'in_stock'].includes(listing.data.availability) && listing.data.is_estimate !== true))) ? 'available' : 'needs_check' : 'not_applicable';
    const rights = preview.rights_check.eligible ? 'eligible' : 'blocked';
    const budget = revision.data.budget.cap_minor <= account.data.spend_cap_snapshot ? 'within_account_cap' : 'exceeds_account_cap';
    const limits = [sampleSize < minimumSample && 'sample_below_minimum', concurrentPromotion && 'concurrent_promotion',
      inventory === 'needs_check' && 'stock_not_confirmed', rights === 'blocked' && 'rights_missing', budget === 'exceeds_account_cap' && 'budget_exceeds_account_cap'].filter(Boolean);
    const suggestion = await ctx.insert(ads, 'adjustment_suggestion', { proposal_id: proposal.id, proposal_revision_id: revision.id,
      ad_account_id: account.id, brand_id: account.data.brand_id, campaign_id: proposal.data.campaign_id, target_entity_id: target.id,
      kind, rationale: text(input, 'rationale', 4000), evidence_refs, status: 'proposed', ai_generated: input.ai_generated == null ? false : bool(input.ai_generated, 'ai_generated'),
      checks: { inventory, rights, budget, sample_size: sampleSize, minimum_sample_size: minimumSample, concurrent_promotion: concurrentPromotion,
        checked_on: localDay(ctx.now, account.data.timezone), limits }, created_by: ctx.actorId, resulting_proposal_revision_id: null });
    await ctx.emit('ads.adjustment.proposed', eventData(ctx, suggestion));
    return suggestion;
  }),
  decide_adjustment: cmd(draft, async (ctx, input) => {
    const suggestion = await inputRow(ctx, 'adjustment_suggestion', input);
    const account = await accountFor(ctx, suggestion, 'draft');
    state(suggestion, 'proposed');
    expected(suggestion, input);
    const status = oneOf(input.decision, ['accepted', 'modified', 'rejected'] as const, 'decision');
    const note = text(input, 'note', 2000);
    let resulting_proposal_revision_id: string | null = null;
    if (status !== 'rejected') {
      const proposal = await row(ctx, 'ad_proposal', suggestion.data.proposal_id);
      expected(proposal, input, 'proposal_expected_version');
      const revision = await revisionFor(ctx, proposal, input);
      same(revision.id, suggestion.data.proposal_revision_id, 'Adjustment revision');
      const config = obj(input.revision, 'revision');
      const intent = obj(config.operation, 'operation');
      const kind = oneOf(suggestion.data.kind, kinds, 'kind');
      same(intent.kind, intentByKind[kind], 'Adjustment operation');
      same(intent.target_entity_id, suggestion.data.target_entity_id, 'Adjustment target');
      const result = await replaceRevision(ctx, proposal, account, config);
      resulting_proposal_revision_id = result.revision.id;
    }
    const decided = await patch(ctx, suggestion, { status, note, decided_by: ctx.actorId, resulting_proposal_revision_id });
    await ctx.emit(`ads.adjustment.${status}`, eventData(ctx, decided));
    return decided;
  }),
  list_adjustments: cmd(read, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'read');
    return { items: (await ctx.list(ads, 'adjustment_suggestion')).filter(item => item.data.ad_account_id === account.id) };
  }),
};
