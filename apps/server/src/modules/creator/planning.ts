import { Problem, READ, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { checkAssetRights } from '../../../../../packages/domain/src/publishing/index.js';
import { array, bad, block, choice, created, date, ids, integer, moneyCurrency, object, operators, optional, signedTerms, text } from './model.js';

const dimensions = ['brand_fit', 'market_fit', 'content_quality', 'audience_evidence', 'cost_fit'] as const;
const decisions = ['shortlist', 'exclude', 'hold'] as const;
const agentCredential = (ctx: Context) => (ctx as Context & { agentCredentialId?: string }).agentCredentialId;

function scoreSummary(scores: Record<string, { score: number | null }>) {
  const known = Object.values(scores).flatMap(item => item.score == null ? [] : [item.score]);
  return { scored_dimensions: known.length, total: known.length ? known.reduce((sum, score) => sum + score, 0) / known.length : null };
}

const shipmentTransitions: Record<string, readonly string[]> = {
  draft: ['requested', 'cancelled'], requested: ['picking', 'cancelled'], picking: ['shipped', 'exception', 'cancelled'],
  shipped: ['delivered', 'exception', 'returned'], exception: ['picking', 'shipped', 'returned', 'cancelled'], delivered: ['returned'],
};
const liveTransitions: Record<string, readonly string[]> = {
  planning: ['scheduled', 'cancelled'], scheduled: ['live', 'cancelled'], live: ['ended'],
};
function warmupTargets(ctx: Context, collaboration: Row, body: Data, scheduledAt: string) {
  return ids(body, 'warmup_publish_target_ids').map(id => {
    const target = ctx.get('publish_target', id);
    if (target.brand_id !== collaboration.brand_id || target.campaign_id !== collaboration.campaign_id ||
        typeof target.scheduled_at !== 'string' || Date.parse(target.scheduled_at) >= Date.parse(scheduledAt) ||
        !Number.isFinite(Date.parse(target.scheduled_at)) || target.plan_status === 'closed') {
      return block('WARMUP_TARGET_MISMATCH', 'Select an open publish target for this campaign scheduled before the live session');
    }
    return target.id;
  });
}

function clipRights(ctx: Context, row: Data, at: string) {
  return checkAssetRights(ctx, String(row.asset_id), {
    platform: String(row.platform), market: String(row.market_id), usage: String(row.usage), at,
    asset_version_id: String(row.asset_version_id), modified: true,
    attribution: typeof row.attribution === 'string' ? row.attribution : undefined,
  });
}

function clipView(ctx: Context, row: Row) {
  const current = clipRights(ctx, row, ctx.now);
  const intended = String(row.reuse_at) > ctx.now ? clipRights(ctx, row, String(row.reuse_at)) : current;
  return { ...row, rights_status: current.allowed && intended.allowed ? 'covered' : 'blocked' };
}

export function shipmentView(row: Row) {
  const { ship_to_ref: _address, ...view } = row;
  return view;
}
export const planningOperations: Operation[] = [
  { method: 'GET', path: '/sample-shipments', name: 'creators_list_shipments', roles: READ, summary: 'List samples with address references masked', run(ctx, { query }) {
    return ctx.list('sample_shipment').filter(row => !query.collaboration_id || row.collaboration_id === query.collaboration_id).map(shipmentView);
  } },
  { method: 'POST', path: '/sample-shipments', name: 'creators_create_shipment', roles: operators, summary: 'Plan the shipment of sample items', run(ctx, { body }) {
    const collaboration = ctx.get('collaboration', text(body, 'collaboration_id'));
    if (['completed', 'cancelled'].includes(String(collaboration.status))) return block('INVALID_STATE', 'Collaboration is closed');
    const lines = array(body.lines, 'lines').map(value => {
      const line = object(value, 'lines');
      return { product_variant_id: ctx.get('product_variant', text(line, 'product_variant_id')).id, qty: integer(line, 'qty', 1) };
    });
    if (!lines.length || new Set(lines.map(line => line.product_variant_id)).size !== lines.length) return bad('lines');
    const amount = body.sample_cost_minor == null ? null : integer(body, 'sample_cost_minor');
    return shipmentView(created(ctx, 'sample_shipment', {
      collaboration_id: collaboration.id, lines, status: 'draft', external_order_ref: optional(body, 'external_order_ref'),
      ship_to_ref: optional(body, 'ship_to_ref'), sample_cost_minor: amount, currency: amount == null ? null : moneyCurrency(body),
    }));
  } },
  { method: 'PATCH', path: '/sample-shipments/:id', name: 'creators_update_shipment', roles: operators, versionKind: 'sample_shipment', summary: 'Record a manual logistics status and its reference', run(ctx, { params, body }) {
    const row = ctx.get('sample_shipment', params.id);
    const allowed = shipmentTransitions[String(row.status)];
    if (!allowed) return block('INVALID_STATE', 'Shipment has no available transition');
    const status = choice(body, 'status', allowed);
    if (status === 'picking') signedTerms(ctx, ctx.get('collaboration', String(row.collaboration_id)));
    const ref = optional(body, 'source_ref');
    if (['shipped', 'delivered', 'returned'].includes(status) && !ref) return bad('source_ref');
    const result = ctx.update('sample_shipment', row.id, {
      status, status_source: { kind: 'manual', reference: ref, observed_at: ctx.now, actor_id: ctx.actorId },
      ...('carrier' in body && { carrier: optional(body, 'carrier') }), ...('tracking_no' in body && { tracking_no: optional(body, 'tracking_no') }),
    });
    ctx.emit('creator.shipment.status_changed', { sample_shipment_id: row.id, collaboration_id: row.collaboration_id, from: row.status, to: status });
    return shipmentView(result);
  } },
  { method: 'GET', path: '/live-sessions', name: 'creators_list_live_sessions', roles: READ, summary: 'List planned creator live sessions', run(ctx, { query }) {
    return ctx.list('live_session').filter(row => !query.collaboration_id || row.collaboration_id === query.collaboration_id);
  } },
  { method: 'GET', path: '/live-sessions/:id', name: 'creators_get_live_session', roles: READ, summary: 'Read the live plan and current clip reuse rights', run(ctx, { params }) {
    return {
      live_session: ctx.get('live_session', params.id),
      clips: ctx.list('live_clip_reuse').filter(row => row.live_session_id === params.id).map(row => clipView(ctx, row)),
    };
  } },
  { method: 'POST', path: '/live-sessions', name: 'creators_plan_live_session', roles: operators, summary: 'Plan a creator live session and run sheet', run(ctx, { body }) {
    const collaboration = ctx.get('collaboration', text(body, 'collaboration_id'));
    if (['completed', 'cancelled'].includes(String(collaboration.status))) return block('INVALID_STATE', 'Collaboration is closed');
    const tz = text(body, 'tz');
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { return bad('tz'); }
    const hosts = body.host_creator_ids == null ? [String(collaboration.creator_id)] : ids(body, 'host_creator_ids');
    if (!hosts.length) return bad('host_creator_ids');
    for (const id of hosts) ctx.get('creator', id);
    const runSheet = body.run_sheet == null ? [] : array(body.run_sheet, 'run_sheet').map(value => {
      const row = object(value, 'run_sheet');
      const product = optional(row, 'product_id');
      if (product) ctx.get('product', product);
      return { title: text(row, 'title'), product_id: product, notes: optional(row, 'notes', 4000) };
    });
    const scheduledAt = date(body, 'scheduled_at');
    return created(ctx, 'live_session', {
      collaboration_id: collaboration.id, campaign_id: collaboration.campaign_id, platform: text(body, 'platform'),
      scheduled_at: scheduledAt, tz, host_creator_ids: hosts, run_sheet: runSheet, status: 'planning',
      warmup_publish_target_ids: body.warmup_publish_target_ids == null ? [] : warmupTargets(ctx, collaboration, body, scheduledAt),
    });
  } },
  { method: 'PATCH', path: '/live-sessions/:id', name: 'creators_update_live_session', roles: operators, versionKind: 'live_session', summary: 'Record live session scheduling and observed progress', run(ctx, { params, body }) {
    const row = ctx.get('live_session', params.id);
    const allowed = liveTransitions[String(row.status)];
    if (!allowed) return block('INVALID_STATE', 'Live session is closed');
    const status = body.status == null || body.status === row.status ? row.status : choice(body, 'status', allowed);
    if (body.scheduled_at != null && !['planning', 'scheduled'].includes(String(row.status))) return bad('scheduled_at');
    if ('warmup_publish_target_ids' in body && !['planning', 'scheduled'].includes(String(row.status))) return bad('warmup_publish_target_ids');
    const scheduledAt = body.scheduled_at == null ? String(row.scheduled_at) : date(body, 'scheduled_at');
    const warmups = 'warmup_publish_target_ids' in body || body.scheduled_at != null ? warmupTargets(
      ctx, ctx.get('collaboration', String(row.collaboration_id)),
      { warmup_publish_target_ids: body.warmup_publish_target_ids ?? row.warmup_publish_target_ids ?? [] }, scheduledAt,
    ) : row.warmup_publish_target_ids ?? [];
    const patch: Data = { status, scheduled_at: scheduledAt, warmup_publish_target_ids: warmups };
    if (status !== row.status && ['live', 'ended'].includes(String(status))) {
      const source = text(body, 'source_ref');
      const history = Array.isArray(row.observations) ? row.observations : row.observation_ref ? [{
        status: row.status, source_ref: row.observation_ref, observed_at: row.observed_at, observed_by: row.observed_by,
      }] : [];
      Object.assign(patch, { observation_ref: source, observed_at: ctx.now, observed_by: ctx.actorId,
        observations: [...history, { status, source_ref: source, observed_at: ctx.now, observed_by: ctx.actorId }] });
    }
    return ctx.update('live_session', row.id, patch);
  } },
  { method: 'POST', path: '/live-sessions/:id/clip-reuse', name: 'creators_plan_clip_reuse', roles: operators, summary: 'Plan reuse of a live clip after checking asset rights', run(ctx, { params, body }) {
    const session = ctx.get('live_session', params.id);
    if (session.status !== 'ended') return block('INVALID_STATE', 'Record the end of the external live session first');
    const collaboration = ctx.get('collaboration', String(session.collaboration_id));
    const asset = ctx.get('asset', text(body, 'asset_id'));
    const version = ctx.get('asset_version', text(body, 'asset_version_id'));
    if (asset.brand_id !== collaboration.brand_id || version.asset_id !== asset.id) {
      return block('CLIP_ASSET_MISMATCH', 'Select a version of an asset in the collaboration brand');
    }
    const market = ctx.get('market', text(body, 'market_id'));
    if (market.brand_id && market.brand_id !== collaboration.brand_id) {
      return block('CLIP_MARKET_MISMATCH', 'Select a market for the collaboration brand');
    }
    const reuseAt = date(body, 'reuse_at');
    if (reuseAt < ctx.now) return bad('reuse_at');
    const clip = {
      live_session_id: session.id, asset_id: asset.id, asset_version_id: version.id, market_id: market.id,
      title: text(body, 'title'), platform: text(body, 'platform'), usage: choice(body, 'usage', ['organic_social', 'paid_ads']),
      reuse_at: reuseAt, attribution: optional(body, 'attribution', 4_000),
    };
    const rights = clipRights(ctx, clip, reuseAt);
    if (!rights.allowed || !clipRights(ctx, clip, ctx.now).allowed) {
      return block('CLIP_RIGHTS_REQUIRED', 'Active rights must cover editing and the intended channel, market and reuse date');
    }
    return { ...created(ctx, 'live_clip_reuse', {
      ...clip, status: 'planned', rights_checked_at: ctx.now,
      rights_grant_id: rights.rights_grant_id, rights_grant_revision_id: rights.rights_grant_revision_id,
    }), rights_status: 'covered' };
  } },
  { method: 'GET', path: '/campaigns/:id/creator-evaluations', name: 'creators_list_evaluations', roles: READ, summary: 'Compare creator evaluations for a campaign', run(ctx, { params }) {
    ctx.get('campaign', params.id);
    return ctx.list('evaluation').filter(row => row.campaign_id === params.id).map(row => ({ ...row,
      creator_display_name: ctx.get('creator', String(row.creator_id)).display_name,
      overrides: ctx.list('evaluation_override').filter(audit => audit.evaluation_id === row.id).sort((a, b) => Number(a.evaluation_version) - Number(b.evaluation_version)),
    }));
  } },
  { method: 'POST', path: '/campaigns/:id/creator-evaluations', name: 'creators_evaluate', roles: WRITE, summary: 'Record scored dimensions and evidence for creator selection', run(ctx, { params, body }) {
    const campaign = ctx.get('campaign', params.id);
    const credential = agentCredential(ctx);
    const input = body.evaluations == null ? [body] : array(body.evaluations, 'evaluations');
    if (!input.length || input.length > 25) return bad('evaluations');
    return input.map(value => {
      const evaluation = object(value, 'evaluations');
      const creator = ctx.get('creator', text(evaluation, 'creator_id'));
      const supplied = object(evaluation.scores, 'scores');
      if (Object.keys(supplied).some(key => !dimensions.some(dimension => dimension === key))) return bad('scores');
      const scores = Object.fromEntries(dimensions.map(key => {
        if (supplied[key] == null) return [key, { score: null, evidence_refs: [], missing_fields: ['evidence'] }];
        const dimension = object(supplied[key], key);
        const refs = dimension.evidence_refs == null ? [] : ids(dimension, 'evidence_refs');
        for (const id of refs) ctx.get('evidence', id);
        const missing = dimension.missing_fields == null ? [] : ids(dimension, 'missing_fields');
        const score = dimension.score == null ? null : integer(dimension, 'score', 0, 100);
        if (!refs.length && score !== null) return bad(`${key}.evidence_refs`);
        return [key, { score, evidence_refs: refs, missing_fields: missing }];
      }));
      return created(ctx, 'evaluation', {
        creator_id: creator.id, campaign_id: campaign.id, decision: choice(evaluation, 'decision', decisions),
        reason: text(evaluation, 'reason', 4000), scores, ...scoreSummary(scores), total_dimensions: dimensions.length,
        scoring_model_version: 'equal_weight_v1', ai_generated: ctx.role === 'agent' || Boolean(credential),
        ...(credential && { agent_credential_id: credential }),
      });
    });
  } },
  { method: 'POST', path: '/creator-evaluations/:id/overrides', name: 'creators_override_evaluation', roles: operators,
    versionKind: 'evaluation', summary: 'Record a human evaluation override with an audit trail', run(ctx, { params, body }) {
    if (ctx.role === 'agent' || agentCredential(ctx)) throw new Problem(403, 'FORBIDDEN', 'Evaluation overrides require an interactive operator');
    const evaluation = ctx.get('evaluation', params.id);
    ctx.get('campaign', String(evaluation.campaign_id));
    const reason = text(body, 'reason', 4000);
    const dimension = body.dimension === undefined ? undefined : choice(body, 'dimension', dimensions);
    const decision = body.decision === undefined ? evaluation.decision : choice(body, 'decision', decisions);
    if (!dimension && (body.decision === undefined || body.score !== undefined || body.evidence_refs !== undefined)) return bad('dimension or decision');
    const currentScores = evaluation.scores as Record<string, { score: number | null; evidence_refs: string[]; missing_fields: string[] }>;
    const scores = { ...currentScores };
    if (dimension) {
      const score = body.score === null ? null : integer(body, 'score', 0, 100);
      const refs = body.evidence_refs === undefined ? [] : ids(body, 'evidence_refs');
      refs.forEach(id => ctx.get('evidence', id));
      if (score !== null && !refs.length) return bad('evidence_refs');
      scores[dimension] = { score, evidence_refs: refs, missing_fields: score === null ? ['evidence'] : [] };
    }
    const snapshot = { decision: evaluation.decision, scores: currentScores, total: evaluation.total, scored_dimensions: evaluation.scored_dimensions };
    const effective = { decision, scores, ...scoreSummary(scores) };
    const original = evaluation.original ?? snapshot;
    const updated = ctx.update('evaluation', evaluation.id, { ...effective, original });
    created(ctx, 'evaluation_override', { evaluation_id: evaluation.id, evaluation_version: updated.version, before: snapshot, after: effective, reason, overridden_at: ctx.now });
    return updated;
  } },
];
