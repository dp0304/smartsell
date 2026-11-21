import { required, text, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { accountAccess, accountFor, ads, check, cmd, currency, eventData, expected, hash, inputRow, integer, obj, oneOf, optional, patch, read, review, row, same, state, timestamp } from './domain.js';
import { approvedRevision, revisionFor } from './proposals.js';

const reporters = ['owner', 'admin', 'editor', 'reviewer'] as const;
const applied = ['active_verified', 'verified'];
const terminal = [...applied, 'failed'];

function requireExecution(ctx: Context, account: Entity, delta: number) {
  accountAccess(ctx, account, 'execute');
  if (delta > 0) {
    check(review.includes(ctx.role as typeof review[number]), 'forbidden', 'Increasing spend requires an approval-capable workspace role', 403);
    accountAccess(ctx, account, 'spend', delta);
  }
}

async function attempt(ctx: Context, operation: Entity, attempt_no: number) {
  return ctx.insert(ads, 'ad_operation_attempt', { operation_id: operation.id, ad_account_id: operation.data.ad_account_id, attempt_no,
    fencing_token: hash([operation.id, String(attempt_no)]), client_reference: operation.data.client_reference,
    client_request_id: `${operation.data.client_reference}-${attempt_no}`, outcome: 'awaiting_manual_result', status: 'awaiting_manual_result',
    prepared_by: ctx.actorId, evidence_ids: [] }, hash(['operation_attempt', operation.id, String(attempt_no)]));
}

function evidenceDTO(ctx: Context, input: Fields, floor: string) {
  const raw = obj(input.evidence, 'evidence');
  const observed_at = timestamp(raw.observed_at, 'evidence.observed_at');
  check(Date.parse(observed_at) >= Date.parse(floor) && Date.parse(observed_at) <= Date.parse(ctx.now),
    'invalid_input', 'Evidence must be observed during or after the attempt and no later than now');
  return { reference: text(raw, 'reference', 1000), note: text(raw, 'note', 5000), observed_at, recorded_by: ctx.actorId,
    source: oneOf(raw.source, ['platform_console', 'platform_receipt', 'report_export'] as const, 'evidence.source') };
}

async function resultEntity(ctx: Context, operation: Entity, id: string | null, externalId: string | null): Promise<Entity | null> {
  if (!id) return null;
  const entity = await row(ctx, 'ad_entity', id);
  same(entity.data.ad_account_id, operation.data.ad_account_id, 'Result entity');
  same(entity.data.campaign_id, operation.data.campaign_id, 'Result campaign');
  same(entity.data.external_id, externalId, 'Result external identifier');
  if (operation.data.target_entity_id) same(id, operation.data.target_entity_id, 'Operation target');
  return entity;
}

export const operations: Commands = {
  prepare_operation: cmd(reporters, async (ctx, input) => {
    const proposal = await inputRow(ctx, 'ad_proposal', input, 'proposal_id');
    const account = await accountFor(ctx, proposal, 'execute');
    const revision = await revisionFor(ctx, proposal, input);
    const { kind, target_entity_id, target_external_id, spend_delta_minor } = revision.data.operation;
    requireExecution(ctx, account, spend_delta_minor);
    const idempotency_key = text(input, 'idempotency_key', 160);
    const id = hash(['manual_operation', idempotency_key]);
    const previous = await ctx.get(ads, 'ad_operation', id);
    if (previous) {
      check(previous.data.proposal_revision_id === revision.id && previous.data.ad_account_id === account.id, 'idempotency_conflict', 'Idempotency key belongs to another request', 409);
      return previous;
    }
    expected(proposal, input);
    state(proposal, 'approved', 'exported');
    const approval = await approvedRevision(ctx, proposal, revision, account);
    const existing = (await ctx.list(ads, 'ad_operation')).filter(item => item.data.ad_account_id === account.id);
    check(!existing.some(item => item.data.proposal_revision_id === revision.id ||
      (item.data.proposal_id === proposal.id && (!terminal.includes(item.data.status) || (kind === 'launch' && item.data.kind === 'launch' && applied.includes(item.data.status)))) ||
      (target_entity_id && (item.data.target_entity_id === target_entity_id || item.data.result_entity_id === target_entity_id) && !terminal.includes(item.data.status))),
    'operation_conflict', 'An operation already exists for this revision, proposal, or target', 409);
    // The account version fences simultaneous preparations on the same target and permission changes.
    await patch(ctx, account, { last_manual_preparation_at: ctx.now });
    const client_reference = `ss-${hash([account.id, proposal.id, revision.id, kind]).slice(0, 24)}`;
    const operation = await ctx.insert(ads, 'ad_operation', { proposal_id: proposal.id, proposal_revision_id: revision.id, revision_hash: revision.data.content_hash,
      ad_account_id: account.id, brand_id: account.data.brand_id, campaign_id: proposal.data.campaign_id, approval_request_id: approval.id,
      kind, target_entity_id, target_external_id, client_reference, idempotency_key, status: 'awaiting_manual_result', mode: 'manual',
      spend_delta_minor, currency: revision.data.budget.currency, budget: revision.data.budget,
      attempt_no: 1, latest_result_id: null, result_entity_id: null, prepared_by: ctx.actorId }, id);
    await attempt(ctx, operation, 1);
    await patch(ctx, proposal, { latest_operation_id: operation.id });
    await ctx.emit('ads.operation.awaiting_manual_result', eventData(ctx, operation, { revision_hash: revision.data.content_hash, attempt_no: 1 }));
    return operation;
  }),
  record_operation_result: cmd(reporters, async (ctx, input) => {
    const operation = await inputRow(ctx, 'ad_operation', input);
    const account = await accountFor(ctx, operation, 'execute');
    requireExecution(ctx, account, operation.data.spend_delta_minor);
    expected(operation, input);
    state(operation, 'awaiting_manual_result', 'accepted', 'platform_review', 'outcome_unknown');
    const activeAttempt = await row(ctx, 'ad_operation_attempt', hash(['operation_attempt', operation.id, String(operation.data.attempt_no)]));
    check(text(input, 'fencing_token', 64) === activeAttempt.data.fencing_token, 'version_conflict', 'Stale operation attempt', 409);
    const priorResult = operation.data.latest_result_id && await row(ctx, 'ad_operation_result', operation.data.latest_result_id);
    const evidence = evidenceDTO(ctx, input, priorResult?.data.observed_at ?? activeAttempt.created_at);
    if (priorResult) check(evidence.observed_at > priorResult.data.observed_at, 'invalid_input', 'Result observation must advance');
    const outcome = oneOf(input.outcome, ['accepted', 'failed', 'outcome_unknown'] as const, 'outcome');
    const external_id = optional(input, 'external_id', 200);
    const result_entity_id = optional(input, 'result_entity_id', 200);
    if (outcome === 'accepted') check(external_id, 'invalid_input', 'An accepted result requires an external identifier');
    if (operation.data.target_external_id && external_id) same(external_id, operation.data.target_external_id, 'Result external identifier');
    if (priorResult?.data.outcome === 'accepted' && external_id) same(external_id, priorResult.data.external_id, 'Previously accepted external identifier');
    await resultEntity(ctx, operation, result_entity_id, external_id);
    const note = optional(input, 'error_class', 100);
    const savedEvidence = await ctx.insert('core', 'evidence', { ...evidence, resource_type: 'ads.ad_operation', resource_id: operation.id,
      ad_account_id: account.id, external_id, purpose: 'manual_result' });
    const result = await ctx.insert(ads, 'ad_operation_result', { operation_id: operation.id, attempt_id: activeAttempt.id, ad_account_id: account.id,
      outcome, external_id, result_entity_id, error_class: note, recorded_by: ctx.actorId, observed_at: evidence.observed_at, evidence_id: savedEvidence.id });
    await patch(ctx, activeAttempt, { outcome, status: 'awaiting_reconciliation', evidence_ids: [...activeAttempt.data.evidence_ids, savedEvidence.id], latest_result_id: result.id });
    const updated = await patch(ctx, operation, { status: 'awaiting_reconciliation', latest_result_id: result.id });
    await ctx.emit('ads.operation.manual_result_recorded', eventData(ctx, updated, { result_id: result.id, outcome }));
    return { operation: updated, result };
  }),
  reconcile_operation: cmd(review, async (ctx, input) => {
    const operation = await inputRow(ctx, 'ad_operation', input);
    const account = await accountFor(ctx, operation, 'reconcile');
    state(operation, 'awaiting_reconciliation');
    expected(operation, input);
    const result = await row(ctx, 'ad_operation_result', text(input, 'result_id', 200));
    same(result.id, operation.data.latest_result_id, 'Current manual result');
    const activeAttempt = await row(ctx, 'ad_operation_attempt', result.data.attempt_id);
    check(![result.data.recorded_by, activeAttempt.data.prepared_by, operation.data.prepared_by].includes(ctx.actorId),
      'separation_of_duties', 'Result recorders and operation preparers may not reconcile this operation', 403);
    const decision = oneOf(input.decision, ['matched', 'confirmed_not_applied', 'inconclusive'] as const, 'decision');
    const evidence = evidenceDTO(ctx, input, result.data.observed_at);
    const initialEvidence = await required(ctx, 'core', 'evidence', result.data.evidence_id);
    check(evidence.reference !== initialEvidence.data.reference, 'independent_evidence_required', 'Record separate readback evidence', 409);
    const raw = obj(input.observations ?? {}, 'observations');
    const external_id = optional(raw, 'external_id', 200);
    const result_entity_id = optional(raw, 'result_entity_id', 200);
    const accepted_at = raw.accepted_at == null ? null : timestamp(raw.accepted_at, 'accepted_at');
    const platform_review = oneOf(raw.platform_review ?? 'unknown', ['unknown', 'pending', 'approved', 'rejected', 'not_required'] as const, 'platform_review');
    const delivery = oneOf(raw.delivery ?? 'unknown', ['unknown', 'active', 'paused', 'draft', 'updated'] as const, 'delivery');
    const first_spend_at = raw.first_spend_at == null ? null : timestamp(raw.first_spend_at, 'first_spend_at');
    const readbackBudget = raw.budget == null ? null : obj(raw.budget, 'observations.budget');
    const budget = readbackBudget && { type: oneOf(readbackBudget.type, ['daily', 'lifetime'] as const, 'type'),
      currency: currency(readbackBudget.currency), amount_minor: integer(readbackBudget.amount_minor, 'amount_minor') };
    if (accepted_at) check(accepted_at >= activeAttempt.created_at && accepted_at <= evidence.observed_at, 'invalid_input', 'Invalid acceptance time');
    if (first_spend_at) check(accepted_at && first_spend_at >= accepted_at && first_spend_at <= evidence.observed_at && delivery === 'active', 'invalid_input', 'Invalid first spend time');
    let status = 'outcome_unknown';
    let entity: Entity | null = null;
    if (decision === 'confirmed_not_applied') {
      check(!operation.data.ever_accepted && result.data.outcome !== 'accepted', 'invalid_state', 'An accepted request requires outcome readback before any replacement', 409);
      check(!accepted_at && !first_spend_at && delivery === 'unknown' && !external_id && !result_entity_id && !budget && platform_review === 'unknown',
        'invalid_input', 'Non-application evidence cannot report application observations');
      check(text(raw, 'client_reference', 100) === operation.data.client_reference, 'invalid_input', 'Confirm absence using the stable client reference');
      status = input.retry === true ? 'retryable' : 'failed';
    } else if (decision === 'matched') {
      check(result.data.outcome !== 'failed' && external_id && accepted_at, 'invalid_input', 'Matched result requires verified acceptance and an external identifier');
      if (result.data.external_id) same(external_id, result.data.external_id, 'Result external identifier');
      if (operation.data.target_external_id) same(external_id, operation.data.target_external_id, 'Operation target identifier');
      check(text(raw, 'external_account_id', 200) === account.data.external_account_id, 'scope_mismatch', 'Readback account does not match the operation', 403);
      entity = await resultEntity(ctx, operation, result_entity_id, external_id);
      const kind = operation.data.kind;
      const match = kind === 'launch' || kind === 'resume' ? delivery === 'active'
        : kind === 'pause' ? delivery === 'paused' : kind === 'create_external_draft' ? delivery === 'draft' : delivery === 'updated';
      if (platform_review === 'rejected') {
        check(!match && !first_spend_at, 'invalid_input', 'Rejected platform review contradicts observed delivery');
        status = 'failed';
      } else if (platform_review === 'pending') status = 'platform_review';
      else if (!match || platform_review === 'unknown') status = 'accepted';
      else {
        check(entity && Date.parse(entity.data.observed_at) >= Date.parse(activeAttempt.created_at) &&
          Date.parse(entity.data.observed_at) <= Date.parse(evidence.observed_at),
        'invalid_input', 'Verified delivery requires a matching structure snapshot observed during the attempt');
        if (kind === 'update_creative') {
          const revision = await row(ctx, 'ad_proposal_revision', operation.data.proposal_revision_id);
          check(revision.data.creative_variant_ids.includes(entity.data.ad_creative_variant_id),
            'invalid_input', 'Readback creative must match an approved variant');
        }
        if (operation.data.spend_delta_minor > 0 || kind === 'update_budget') {
          check(budget && budget.currency === operation.data.currency && budget.type === operation.data.budget.type &&
            budget.amount_minor === operation.data.budget.amount_minor && budget.amount_minor <= operation.data.budget.cap_minor,
          'budget_mismatch', 'Readback budget does not match the approved amount, limit, and currency', 409);
          check(entity.data.budget_snapshot && entity.data.budget_snapshot.currency === budget.currency &&
            entity.data.budget_snapshot.type === budget.type && entity.data.budget_snapshot.amount_minor === budget.amount_minor,
          'budget_mismatch', 'Result structure snapshot differs from readback budget', 409);
        }
        status = (kind === 'launch' || kind === 'resume') ? 'active_verified' : 'verified';
      }
    } else {
      check(!accepted_at && !first_spend_at && delivery === 'unknown' && !external_id && !result_entity_id && !budget && platform_review === 'unknown',
        'invalid_input', 'Inconclusive evidence cannot assert confirmed observations');
    }
    check(input.retry === undefined || (typeof input.retry === 'boolean' && decision === 'confirmed_not_applied'), 'invalid_input', 'Retry requires confirmed non-application');
    const savedEvidence = await ctx.insert('core', 'evidence', { ...evidence, resource_type: 'ads.ad_operation', resource_id: operation.id,
      ad_account_id: account.id, external_id, purpose: 'independent_reconciliation' });
    const observations = { accepted_at, platform_review, delivery, first_spend_at, external_id, budget };
    const reconciliation = await ctx.insert(ads, 'ad_operation_reconciliation', { operation_id: operation.id, ad_account_id: account.id,
      result_id: result.id, attempt_id: activeAttempt.id, decision, status, observations, reconciled_by: ctx.actorId,
      result_entity_id, evidence_id: savedEvidence.id });
    await patch(ctx, activeAttempt, { status, evidence_ids: [...activeAttempt.data.evidence_ids, savedEvidence.id] });
    const updated = await patch(ctx, operation, { status, latest_reconciliation_id: reconciliation.id, observations,
      ever_accepted: operation.data.ever_accepted === true || decision === 'matched' || result.data.outcome === 'accepted',
      result_entity_id: entity?.id ?? null, last_reconciled_at: ctx.now });
    if (applied.includes(status) && ['create_external_draft', 'launch'].includes(operation.data.kind)) {
      const proposal = await row(ctx, 'ad_proposal', operation.data.proposal_id);
      same(proposal.data.current_revision_id, operation.data.proposal_revision_id, 'Reconciled proposal revision');
      await patch(ctx, proposal, { status: operation.data.kind === 'launch' ? 'launched' : 'external_draft' });
    }
    const event = eventData(ctx, updated, { reconciliation_id: reconciliation.id, status });
    await ctx.emit('ads.operation.reconciled', event);
    if (decision === 'matched') await ctx.emit('ads.operation.accepted', event);
    if (applied.includes(status)) await ctx.emit('ads.operation.verified', event);
    if (status === 'failed' || status === 'outcome_unknown') await ctx.emit(`ads.operation.${status}`, event);
    return { operation: updated, reconciliation };
  }),
  retry_operation: cmd(reporters, async (ctx, input) => {
    const operation = await inputRow(ctx, 'ad_operation', input);
    const account = await accountFor(ctx, operation, 'execute');
    requireExecution(ctx, account, operation.data.spend_delta_minor);
    expected(operation, input);
    state(operation, 'retryable');
    const proposal = await row(ctx, 'ad_proposal', operation.data.proposal_id);
    state(proposal, 'approved', 'exported');
    const revision = await revisionFor(ctx, proposal, input);
    same(revision.id, operation.data.proposal_revision_id, 'Operation revision');
    await approvedRevision(ctx, proposal, revision, account);
    const attempt_no = operation.data.attempt_no + 1;
    const next = await attempt(ctx, operation, attempt_no);
    const updated = await patch(ctx, operation, { attempt_no, status: 'awaiting_manual_result', latest_result_id: null, observations: null });
    await ctx.emit('ads.operation.awaiting_manual_result', eventData(ctx, updated, { attempt_no }));
    return { operation: updated, attempt: next };
  }),
  record_first_spend: cmd(review, async (ctx, input) => {
    const operation = await inputRow(ctx, 'ad_operation', input);
    const account = await accountFor(ctx, operation, 'reconcile');
    expected(operation, input);
    state(operation, 'active_verified');
    check(!operation.data.observations.first_spend_at, 'invalid_state', 'First spend is already recorded', 409);
    const attemptId = hash(['operation_attempt', operation.id, String(operation.data.attempt_no)]);
    const activeAttempt = await row(ctx, 'ad_operation_attempt', attemptId);
    const result = await row(ctx, 'ad_operation_result', operation.data.latest_result_id);
    check(![operation.data.prepared_by, activeAttempt.data.prepared_by, result.data.recorded_by].includes(ctx.actorId),
      'separation_of_duties', 'First spend requires independent verification', 403);
    const evidence = evidenceDTO(ctx, input, operation.data.last_reconciled_at);
    const first_spend_at = timestamp(input.first_spend_at, 'first_spend_at');
    check(first_spend_at >= operation.data.observations.accepted_at && first_spend_at <= evidence.observed_at,
      'invalid_input', 'First spend must follow acceptance and precede its observation');
    const observation = await required(ctx, 'analytics', 'metric_observation', text(input, 'observation_id', 200));
    const data = observation.data;
    same(data.subject_id, operation.data.result_entity_id, 'Spend observation entity');
    if (data.brand_id) same(data.brand_id, account.data.brand_id, 'Spend observation brand');
    check(data.subject_type === 'ads.ad_entity' && typeof data.metric_key === 'string' && data.metric_key.split('.').at(-1) === 'spend' &&
      data.availability === 'observed' && data.currency === operation.data.currency && Number.isSafeInteger(data.value_minor ?? data.value) &&
      (data.value_minor ?? data.value) > 0 && Date.parse(data.observed_at) >= Date.parse(first_spend_at) &&
      Date.parse(data.observed_at) <= Date.parse(evidence.observed_at), 'invalid_input', 'Use a verified positive spend observation in the approved currency');
    const recorded = await ctx.insert('core', 'evidence', { ...evidence, resource_type: 'ads.ad_operation', resource_id: operation.id,
      ad_account_id: account.id, external_id: operation.data.observations.external_id, purpose: 'first_spend', observation_id: observation.id });
    const updated = await patch(ctx, operation, { observations: { ...operation.data.observations, first_spend_at }, first_spend_evidence_id: recorded.id });
    await patch(ctx, activeAttempt, { evidence_ids: [...activeAttempt.data.evidence_ids, recorded.id] });
    await ctx.emit('ads.operation.first_spend_observed', eventData(ctx, updated, { first_spend_at, evidence_id: recorded.id, observation_id: observation.id }));
    return updated;
  }),
  get_operation: cmd(read, async (ctx, input) => {
    const operation = await inputRow(ctx, 'ad_operation', input);
    await accountFor(ctx, operation, 'read');
    const items = async (kind: string) => (await ctx.list(ads, kind)).filter(item => item.data.operation_id === operation.id);
    const evidence = (await ctx.list('core', 'evidence')).filter(item => item.data.resource_type === 'ads.ad_operation' && item.data.resource_id === operation.id);
    return { operation, attempts: await items('ad_operation_attempt'), results: await items('ad_operation_result'),
      reconciliations: await items('ad_operation_reconciliation'), evidence };
  }),
};
