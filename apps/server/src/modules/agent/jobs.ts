import { cancelTask } from '../execution/ops.js';
import { pending } from '../execution/service.js';
import { cancelIngestOperation } from '../ingest/sync-operations.js';
import { APPROVE, Problem, READ, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { getTask } from '../workspace/tasks.js';
import { array, checkVersion, conflict, integer, object, text, timestamp } from './input.js';

const kind = 'agent_job';
const active = ['claimed', 'in_progress'];
import { assertReportExportVisible, cancelReportExport, reportExportKind, reportExportRoles } from '../analytics/report-export.js';
import { assertReportOperationVisible, cancelReportGeneration, reportGenerationKind } from '../analytics/report-generation.js';
import { assertResearchDigestOperationVisible, cancelResearchDigest, researchDigestKind } from '../intel/digest-operations.js';

const terminal = ['done', 'cancelled'];
const leaseMs = 120_000;
export interface AgentRequestContext extends Context {
  agentCredentialId?: string;
  isActiveWorkspaceMember?: (id: string) => boolean;
  canReadWorkspaceResource?: (kind: string, row: Row) => boolean;
}
const cancelRoles = [...new Set([...APPROVE, ...reportExportRoles])];
const credential = (ctx: Context) => (ctx as AgentRequestContext).agentCredentialId ?? null;

export function getVisibleResource(ctx: AgentRequestContext, type: string, id: string): Row {
  const row = type === 'work_item' ? getTask(ctx, id) : ctx.get(type, id);
  if (ctx.canReadWorkspaceResource && !ctx.canReadWorkspaceResource(type, row)) {
    throw new Problem(404, 'NOT_FOUND', 'Resource not found');
  }
  return row;
}

function canReadJob(ctx: AgentRequestContext, job: Row): boolean {
  if (!ctx.canReadWorkspaceResource) return true;
  const scope = object(job.input_scope ?? {}, 'input_scope');
  if (!ctx.canReadWorkspaceResource(kind, job)) return false;
  const visible = (type: string, id: unknown) => typeof id === 'string' && ctx.list(type).some((row) => row.id === id && ctx.canReadWorkspaceResource!(type, row));
  return array(scope.brand_ids ?? [], 'brand_ids').every((id) => visible('brand', id)) &&
    (scope.campaign_id == null || visible('campaign', scope.campaign_id)) &&
    array(scope.resource_refs ?? [], 'resource_refs').every((value) => {
      const ref = object(value, 'resource_ref');
      return visible(String(ref.kind), ref.id);
    });
}

export function getVisibleJob(ctx: Context, id: string): Row {
  const job = ctx.get(kind, id);
  if (!canReadJob(ctx, job)) throw new Problem(404, 'NOT_FOUND', 'Job not found');
  return job;
}
const refKinds = ['brand', 'campaign', 'product', 'content_item', 'content_variant', 'work_item', 'report', 'change_set', 'operation', 'conversation'];
const jobRefKinds = refKinds.filter((type) => type !== 'change_set' && type !== 'operation');

export function resourceRef(ctx: Context, value: unknown, allowed = refKinds): Data {
  const ref = object(value, 'resource_ref');
  const type = text(ref.kind, 'resource_ref.kind');
  if (!allowed.includes(type)) throw new Problem(400, 'INVALID_INPUT', 'Unsupported resource kind');
  const row = getVisibleResource(ctx, type, text(ref.id, 'resource_ref.id'));
  if (ref.version !== undefined && row.version !== integer(ref.version, 'resource_ref.version')) {
    throw new Problem(409, 'VERSION_CONFLICT', 'A referenced resource changed');
  }
  return { kind: type, id: row.id, version: row.version };
}

function expiry(ctx: Context): string {
  return new Date(Date.parse(ctx.now) + leaseMs).toISOString();
}

function expired(ctx: Context, row: Row): boolean {
  return active.includes(String(row.status)) && !(Date.parse(String(row.lease_expires_at)) > Date.parse(ctx.now));
}

export function jobView(ctx: Context, job: Row): Row {
  const { lease_credential_id, ...visible } = job;
  return { ...visible, status: expired(ctx, job) ? 'lease_expired' : job.status };
}

function update(ctx: Context, job: Row, type: string, patch: Data, event: Data = {}): Row {
  const next = ctx.update(kind, job.id, patch);
  const item = ctx.get('work_item', String(job.work_item_id));
  const status = ({ open: 'open', claimed: 'in_progress', in_progress: 'in_progress', submitted: 'blocked', returned: 'blocked', lease_expired: 'blocked', accepted: 'in_progress', done: 'done', cancelled: 'cancelled' } as Record<string, string>)[String(next.status)];
  const blocked = ({ submitted: 'awaiting_review', lease_expired: 'verify_side_effects', returned: 'changes_requested' } as Record<string, string>)[String(next.status)] ?? null;
  if (item.status !== status || item.assignee_id !== next.assignee_id || item.blocked_reason !== blocked) {
    ctx.update('work_item', item.id, {
      status, blocked_reason: blocked, assignee_id: next.assignee_id, assignee_type: next.assignee_type,
      ...(status === 'done' ? { completed_at: ctx.now, completed_by_id: ctx.actorId, completed_by_type: 'user' } : {}),
    });
    ctx.create('work_item_event', { work_item_id: item.id, kind: type === 'handed_off' ? 'handed_over' : 'status_changed', from_value: item.status, to_value: status, actor_id: ctx.actorId, created_by: ctx.actorId });
  }
  ctx.create('agent_job_event', { agent_job_id: job.id, type, actor_id: ctx.actorId, fencing_token: next.fencing_token, occurred_at: ctx.now, ...event });
  ctx.emit(`agent.job.${type}`, { agent_job_id: job.id, work_item_id: item.id, status: next.status, source_rule_run_id: job.source_rule_run_id ?? null });
  if (job.source_rule_run_id) {
    const run = ctx.get('rule_run', String(job.source_rule_run_id));
    const related = ctx.list(kind).filter((row) => row.source_rule_run_id === run.id);
    const allTerminal = related.every((row) => terminal.includes(String(row.status)));
    const waiting = related.some((row) => ['open', 'returned', 'lease_expired', 'submitted'].includes(String(row.status)));
    const status = allTerminal ? (related.some((row) => row.status === 'cancelled') ? 'failed' : 'succeeded') : (waiting ? 'waiting' : 'acting');
    const reason = waiting ? (related.some((row) => row.status === 'lease_expired') ? 'verify_side_effects' : related.some((row) => row.status === 'submitted') ? 'awaiting_review' : 'awaiting_agent_claim') : null;
    if (status !== run.status || reason !== run.waiting_reason) ctx.update('rule_run', run.id, { status, waiting_reason: allTerminal ? null : reason, finished_at: allTerminal ? ctx.now : null });
  }
  return next;
}

export function createAgentJob(ctx: Context, body: Data, sourceRuleRunId?: string): Row {
  const scope = object(body.input_scope ?? {}, 'input_scope');
  const brands = array(scope.brand_ids ?? (body.brand_id ? [body.brand_id] : []), 'brand_ids').map((id) => getVisibleResource(ctx, 'brand', text(id, 'brand_id')).id);
  const campaign = scope.campaign_id === undefined ? null : getVisibleResource(ctx, 'campaign', text(scope.campaign_id, 'campaign_id'));
  if (campaign && brands.length && !brands.includes(String(campaign.brand_id))) throw new Problem(400, 'INVALID_INPUT', 'Campaign is outside the requested brand scope');
  const refs = array(scope.resource_refs ?? [], 'resource_refs').map((ref) => resourceRef(ctx, ref, jobRefKinds));
  if (brands.length && refs.some((ref) => {
    const row = ctx.get(String(ref.kind), String(ref.id));
    return row.brand_id != null && !brands.includes(String(row.brand_id));
  })) throw new Problem(400, 'INVALID_INPUT', 'Resource is outside the requested brand scope');
  const title = text(body.title, 'title');
  const due = body.due_at === undefined ? null : timestamp(body.due_at, 'due_at');
  const jobKind = text(body.kind ?? 'custom', 'kind');
  const expected = object(body.expected_output ?? { type: 'note' }, 'expected_output');
  const outputType = text(expected.type, 'expected_output.type');
  if (!['note', 'change_set', 'report', 'operation'].includes(outputType)) throw new Problem(400, 'INVALID_INPUT', 'Unsupported output type');
  const work = ctx.create('work_item', {
    title, due_at: due, type: 'agent_task', status: 'open', priority: 'normal',
    source_type: sourceRuleRunId ? 'automation' : 'agent', brand_id: brands.length === 1 ? brands[0] : campaign?.brand_id ?? null, campaign_id: campaign?.id ?? null,
    assignee_id: null, assignee_type: null, created_by: ctx.actorId,
  });
  const job = ctx.create(kind, {
    title, kind: jobKind, due_at: due, status: 'open', fencing_token: 0, work_item_id: work.id,
    input_scope: { brand_ids: brands, campaign_id: campaign?.id ?? null, resource_refs: refs, ...(scope.constraints === undefined ? {} : { constraints: text(scope.constraints, 'constraints', 4000) }) },
    expected_output: { type: outputType }, created_by: ctx.actorId, assignee_id: null, assignee_type: null,
    source_rule_run_id: sourceRuleRunId ?? null, brand_id: work.brand_id, campaign_id: work.campaign_id,
  });
  ctx.update('work_item', work.id, { resource_type: kind, resource_id: job.id, source_ref: { agent_job_id: job.id } });
  ctx.create('agent_job_event', { agent_job_id: job.id, type: 'created', actor_id: ctx.actorId, occurred_at: ctx.now });
  ctx.emit('agent.job.created', { agent_job_id: job.id, work_item_id: work.id, source_rule_run_id: sourceRuleRunId ?? null });
  return job;
}

export function assertAgentLease(ctx: Context, job: Row, body: Data): void {
  if (!active.includes(String(job.status)) || expired(ctx, job)) conflict('The job has no active lease');
  if (job.lease_owner_id !== ctx.actorId || (job.lease_credential_id ?? null) !== credential(ctx) || integer(body.fencing_token, 'fencing_token') !== job.fencing_token) {
    throw new Problem(409, 'LEASE_LOST', 'The lease owner or fencing token has changed');
  }
}

function unknownEffects(ctx: Context, job: Row): string[] {
  return ctx.list('tool_call').filter((call) => call.agent_job_id === job.id && call.side_effect === true &&
    !['success', 'denied', 'require_approval', 'conflict', 'failed_before_submission', 'reconciled'].includes(String(call.outcome)))
    .map((call) => call.id);
}

export function reapJobLeases(ctx: Context): Row[] {
  return ctx.list(kind).filter((job) => expired(ctx, job)).map((job) => update(ctx, job, 'lease_expired', {
    status: 'lease_expired', lease_expires_at: null, pending_side_effects: unknownEffects(ctx, job),
  }));
}

export function expireActorLeases(ctx: Context, actorId: string): Row[] {
  return ctx.list(kind).filter((job) => active.includes(String(job.status)) && job.lease_owner_id === actorId)
    .map((job) => update(ctx, job, 'lease_expired', { status: 'lease_expired', lease_expires_at: null, pending_side_effects: unknownEffects(ctx, job) }));
}

export function expireCredentialLeases(ctx: Context, credentialId: string): Row[] {
  return ctx.list(kind).filter(job => active.includes(String(job.status)) && job.lease_credential_id === credentialId)
    .map(job => update(ctx, job, 'lease_expired', { status: 'lease_expired', lease_expires_at: null, pending_side_effects: unknownEffects(ctx, job) }));
}

const clearLease = { lease_owner_id: null, lease_credential_id: null, lease_expires_at: null };
const unassign = { ...clearLease, assignee_id: null, assignee_type: null };

function transition(action: string, name: string, roles: Operation['roles'], run: (ctx: Context, job: Row, body: Data) => Row): Operation {
  return { method: 'POST', path: `/agent-jobs/:id/${action}`, name, roles, summary: `${action} an Agent job`, versionKind: kind,
    run(ctx, input) {
      const job = getVisibleJob(ctx, input.params.id!);
      checkVersion(job, input.expectedVersion);
      return jobView(ctx, run(ctx, job, input.body));
    } };
}

export const jobOperations: Operation[] = [
  { method: 'GET', path: '/agent-jobs', name: 'agent_jobs_list', roles: READ, summary: 'List Agent jobs', run: (ctx, { query }) => ctx.list(kind).filter((job) => canReadJob(ctx, job)).map((job) => jobView(ctx, job)).filter((row) =>
    (!query.status || row.status === query.status) && (!query.kind || row.kind === query.kind) && (!query.campaign_id || row.campaign_id === query.campaign_id) && (!query.assignee_id || row.assignee_id === query.assignee_id)) },
  { method: 'POST', path: '/agent-jobs', name: 'agent_jobs_create', accepted: true, roles: WRITE, summary: 'Create a work item and Agent job', run: (ctx, { body }) => {
    const job = createAgentJob(ctx, body);
    return { ...job, operation_id: job.id };
  } },
  { method: 'GET', path: '/agent-jobs/:id', name: 'agent_jobs_get', roles: READ, summary: 'Read an Agent job and its history', run: (ctx, { params }) => ({ ...jobView(ctx, getVisibleJob(ctx, params.id!)), events: ctx.list('agent_job_event').filter((event) => event.agent_job_id === params.id) }) },
  transition('claim', 'agent_jobs_claim', WRITE, (ctx, job) => {
    if (!['open', 'returned'].includes(String(job.status)) || job.cancel_requested_at || (job.assignee_id && job.assignee_id !== ctx.actorId)) conflict('The job is not claimable');
    return update(ctx, job, 'claimed', { status: 'claimed', lease_owner_id: ctx.actorId, lease_credential_id: credential(ctx), assignee_id: ctx.actorId, assignee_type: ctx.role === 'agent' || credential(ctx) ? 'agent_client' : 'user', lease_expires_at: expiry(ctx), fencing_token: Number(job.fencing_token) + 1 });
  }),
  transition('heartbeat', 'agent_jobs_heartbeat', WRITE, (ctx, job, body) => {
    assertAgentLease(ctx, job, body);
    if (job.cancel_requested_at) conflict('Cancellation was requested');
    const note = body.progress_note === undefined ? null : text(body.progress_note, 'progress_note', 2000);
    return update(ctx, job, 'heartbeat', { status: 'in_progress', lease_expires_at: expiry(ctx), progress_note: note ?? job.progress_note ?? null }, { note });
  }),
  transition('handoff', 'agent_jobs_handoff', WRITE, (ctx, job, body) => {
    assertAgentLease(ctx, job, body);
    if (job.cancel_requested_at) conflict('Cancellation was requested');
    const note = text(body.done_summary, 'done_summary', 4000);
    const pending = [...new Set([...unknownEffects(ctx, job), ...array(body.pending_side_effects ?? [], 'pending_side_effects').map((id) => text(id, 'side effect', 500))])];
    return update(ctx, job, 'handed_off', { ...unassign, status: pending.length ? 'lease_expired' : 'open', pending_side_effects: pending, handoff_summary: note }, { note, pending_side_effects: pending });
  }),
  transition('reconcile', 'agent_jobs_reconcile', APPROVE, (ctx, job, body) => {
    if (jobView(ctx, job).status !== 'lease_expired') conflict('The job does not need reconciliation');
    if (body.verified_no_pending_side_effects !== true || unknownEffects(ctx, job).length) conflict('Pending side effects must be resolved before reopening');
    const note = text(body.note, 'note', 4000);
    const resume = body.resume === true;
    if (resume && (job.lease_owner_id !== ctx.actorId || (job.lease_credential_id ?? null) !== credential(ctx))) conflict('Only the prior lease owner may resume');
    const patch = job.cancel_requested_at ? { ...unassign, status: 'cancelled' } : resume ? {
      assignee_id: ctx.actorId, lease_owner_id: ctx.actorId, lease_credential_id: credential(ctx), lease_expires_at: expiry(ctx), status: 'in_progress', fencing_token: Number(job.fencing_token) + 1,
    } : { ...unassign, status: 'open' };
    return update(ctx, job, 'reconciled', { ...patch, pending_side_effects: [] }, { note });
  }),
  transition('assign', 'agent_jobs_assign', APPROVE, (ctx, job, body) => {
    if (!['open', 'returned'].includes(String(job.status))) conflict('Only unleased jobs can be assigned');
    const assignee = body.assignee_id === null ? null : text(body.assignee_id, 'assignee_id');
    if (assignee && assignee !== ctx.actorId && !(ctx as AgentRequestContext).isActiveWorkspaceMember?.(assignee)) {
      throw new Problem(409, 'MEMBER_UNAVAILABLE', 'The assignee could not be verified as an active workspace member');
    }
    return update(ctx, job, 'assigned', { assignee_id: assignee, assignee_type: assignee ? 'user' : null });
  }),
  transition('submit', 'agent_jobs_submit_result', WRITE, (ctx, job, body) => {
    assertAgentLease(ctx, job, body);
    if (job.cancel_requested_at || unknownEffects(ctx, job).length) conflict('Resolve cancellation or pending side effects before submitting');
    const result = object(body.result_ref, 'result_ref');
    const expected = object(job.expected_output, 'expected_output').type;
    let ref: Data;
    if (expected === 'change_set') {
      const set = ctx.get('change_set', text(result.change_set_id, 'change_set_id'));
      if (set.agent_job_id !== job.id || set.status !== 'pending') conflict('Submit a pending change set belonging to this job');
      ref = { change_set_id: set.id };
    } else if (expected === 'report' || expected === 'operation') {
      const field = `${expected}_id`;
      ref = { [field]: getVisibleResource(ctx, expected, text(result[field], field)).id };
    } else {
      ref = { note: text(result.note, 'note', 8000) };
    }
    return update(ctx, job, 'submitted', { ...clearLease, status: 'submitted', result_ref: ref });
  }),
  transition('accept', 'agent_jobs_accept', APPROVE, (ctx, job) => {
    if (job.status !== 'submitted' || job.cancel_requested_at) conflict('Only submitted jobs can be accepted');
    return update(ctx, job, 'accepted', { status: 'accepted', accepted_by: ctx.actorId, accepted_at: ctx.now });
  }),
  transition('finish', 'agent_jobs_finish', APPROVE, (ctx, job) => {
    if (job.status !== 'accepted') conflict('Only accepted jobs can be completed');
    return update(ctx, job, 'done', { status: 'done' });
  }),
  transition('return', 'agent_jobs_return', APPROVE, (ctx, job, body) => {
    if (job.status !== 'submitted' || job.cancel_requested_at) conflict('Only submitted jobs can be returned');
    return update(ctx, job, 'returned', { status: 'returned' }, { note: text(body.note, 'note', 4000) });
  }),
  transition('cancel', 'agent_jobs_cancel', APPROVE, (ctx, job) => requestCancel(ctx, job)),
  transition('confirm-cancel', 'agent_jobs_confirm_cancel', WRITE, (ctx, job, body) => {
    assertAgentLease(ctx, job, body);
    if (!job.cancel_requested_at || unknownEffects(ctx, job).length) conflict('Cancellation requires a request and resolved side effects');
    return update(ctx, job, 'cancelled', { ...unassign, status: 'cancelled' });
  }),
  { method: 'GET', path: '/jobs/:id', name: 'jobs_get', roles: READ, summary: 'Resume querying a durable operation', run: readOperation },
  { method: 'POST', path: '/jobs/:id/cancel', name: 'jobs_cancel', roles: cancelRoles, summary: 'Request durable operation cancellation', run: cancelOperation },
  { method: 'GET', path: '/operations/:id', name: 'operation_status_get', roles: READ, summary: 'Read a durable operation', run: readOperation },
  { method: 'POST', path: '/operations/:id/cancel', name: 'operation_status_cancel', roles: cancelRoles, summary: 'Request durable operation cancellation', run: cancelOperation },
];

function readOperation(ctx: Context, { params }: Parameters<Operation['run']>[1]) {
  const id = params.id!;
  const operation = ctx.list(kind).some(job => job.id === id)
    ? jobView(ctx, getVisibleJob(ctx, id)) : findVerification(ctx, id) ?? getVisibleResource(ctx, 'operation', id);
  if (operation.kind === reportGenerationKind) assertReportOperationVisible(ctx, operation);
  if (operation.kind === researchDigestKind) assertResearchDigestOperationVisible(ctx);
  if (operation.kind === reportExportKind) assertReportExportVisible(ctx, operation);
  const result = { ...operationView(operation), progress: operation.progress,
    ...([reportGenerationKind, researchDigestKind, reportExportKind].includes(String(operation.kind)) && { result_ref: operation.result_ref, error_code: operation.error_code }),
    ...(operation.kind === 'publishing.commit_plan' || operation.kind === 'publishing.apply_execution_batch' ? {
      items: ctx.list('operation_item').filter(row => row.operation_id === id)
        .sort((a, b) => Number(a.item_no ?? Infinity) - Number(b.item_no ?? Infinity)),
    } : {}) };
  // Protocol timestamps are used by the MCP Tasks adapter without changing the REST DTO.
  return Object.defineProperties(result, {
    created_at: { value: operation.created_at }, updated_at: { value: operation.updated_at },
  });
}

function cancelOperation(ctx: Context, { params, expectedVersion }: Parameters<Operation['run']>[1]) {
  const id = params.id!;
  if (ctx.list('operation').some(row => row.id === id && row.kind === reportExportKind)) {
    const operation = getVisibleResource(ctx, 'operation', id);
    assertReportExportVisible(ctx, operation);
    checkVersion(operation, expectedVersion);
    return operationView(cancelReportExport(ctx, operation));
  }
  if (!APPROVE.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Insufficient cancellation permissions');
  if (!ctx.list(kind).some(job => job.id === id)) {
    const verification = findVerification(ctx, id);
    if (verification) {
      checkVersion(verification, expectedVersion);
      return cancelVerification(ctx, verification);
    }
    const operation = getVisibleResource(ctx, 'operation', id);
    if (operation.kind === reportGenerationKind) {
      assertReportOperationVisible(ctx, operation);
      checkVersion(operation, expectedVersion);
      return operationView(cancelReportGeneration(ctx, operation));
    }
    if (operation.kind === researchDigestKind) {
      assertResearchDigestOperationVisible(ctx);
      checkVersion(operation, expectedVersion);
      return operationView(cancelResearchDigest(ctx, operation));
    }
    if (operation.kind === 'ingest.sync_run' || operation.kind === 'ingest.backfill') {
      checkVersion(operation, expectedVersion);
      const cancelled = cancelIngestOperation(ctx, operation);
      return { ...operationView(cancelled), progress: cancelled.progress };
    }
    conflict('This operation does not support cancellation');
  }
  const job = getVisibleJob(ctx, id);
  checkVersion(job, expectedVersion);
  return operationView(requestCancel(ctx, job));
}

// Verification requests already have stable public IDs, including requests created before AI05.
function findVerification(ctx: Context, id: string): Row | undefined {
  const request = ctx.list('execution_verification').find(row => row.id === id);
  if (!request) return;
  const task = getVisibleResource(ctx, 'execution_task', String(request.task_id));
  const completed = request.status === 'completed';
  return { ...request, status: completed ? task.status === 'cancelled' && request.cancel_requested_at ? 'cancelled' : 'succeeded'
    : request.cancel_requested_at ? 'cancel_requested' : request.outcome ? 'running' : 'queued',
  progress: { task_id: task.id, attempt_id: request.attempt_id, task_status: task.status, outcome: request.outcome ?? null } };
}

function cancelVerification(ctx: Context, operation: NonNullable<ReturnType<typeof findVerification>>) {
  if (!WRITE.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Insufficient execution permissions');
  if (operation.cancel_requested_at) return { ...operationView(operation), progress: operation.progress };
  const task = getVisibleResource(ctx, 'execution_task', String(operation.task_id));
  if (operation.status === 'succeeded' || pending(ctx, task)?.id !== operation.attempt_id) conflict('The verification is closed');
  // A job cancellation may request read-back, but cannot authorize a provider-side withdrawal.
  cancelTask(ctx, task, true);
  // A previously pending cancellation may predate verification cancellation tracking.
  if (!ctx.get('execution_verification', operation.id).cancel_requested_at) {
    ctx.update('execution_verification', operation.id, { cancel_requested_at: ctx.now });
  }
  const next = findVerification(ctx, operation.id)!;
  return { ...operationView(next), progress: next.progress };
}

function operationView(job: Row) {
  return { operation_id: job.id, status: job.status, version: job.version,
    cancel_requested_at: job.cancel_requested_at ?? null };
}

function requestCancel(ctx: Context, job: Row): Row {
  if (job.cancel_requested_at) return job;
  if ([...terminal, 'accepted'].includes(String(job.status))) conflict('The job is already terminal or accepted');
  if (active.includes(String(job.status)) || job.status === 'lease_expired' || unknownEffects(ctx, job).length) {
    return update(ctx, job, 'cancel_requested', { cancel_requested_at: ctx.now });
  }
  return update(ctx, job, 'cancelled', { ...unassign, status: 'cancelled', cancel_requested_at: ctx.now });
}
