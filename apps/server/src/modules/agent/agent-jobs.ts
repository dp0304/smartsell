import { DomainError, readers, required, reviewers, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { agentModule, array, command, conflict, id, integer, invalid, object, time } from './agent-validation.js';

const kind = 'agent_job';
const leaseMs = 120_000;
const active = ['claimed', 'in_progress'];
const claimRoles = [...writers, 'reviewer'] as const;

/** Populated by the host from its verified credential, never from command input. */
export type AgentContext = Context & { agentClientId?: string };
const client = (ctx: Context) => (ctx as AgentContext).agentClientId ?? null;
const expiry = (ctx: Context) => new Date(Date.parse(ctx.now) + leaseMs).toISOString();
const expired = (ctx: Context, row: Entity) => active.includes(row.data.status) && !(Date.parse(row.data.lease_expires_at) > Date.parse(ctx.now));
const view = (ctx: Context, row: Entity) => expired(ctx, row) ? { ...row, data: { ...row.data, status: 'lease_expired' } } : row;
const clearLease = { lease_expires_at: null, lease_owner_id: null, lease_client_id: null };

async function projectWorkItem(ctx: Context, job: Entity) {
  const statuses: Record<string, string> = { open: 'open', claimed: 'in_progress', in_progress: 'in_progress',
    submitted: 'blocked', accepted: 'in_progress', returned: 'open', lease_expired: 'blocked', done: 'done', cancelled: 'cancelled' };
  const data = { title: job.data.title, type: 'agent_task', source_type: 'agent', resource_type: 'agent_job', resource_id: job.id,
    status: statuses[job.data.status], priority: 'normal', due_at: job.data.due_at, assignee_id: job.data.assignee_id,
    assignee_type: job.data.assignee_id ? 'user' : null, brand_id: job.data.input_scope.brand_id,
    campaign_id: job.data.input_scope.campaign_id, created_by_id: job.data.created_by,
    blocked_reason: job.data.status === 'lease_expired' ? 'verify_side_effects' : job.data.status === 'submitted' ? 'awaiting_review' : null };
  const workId = `agent-job:${job.id}`;
  const previous = await ctx.get('workspace', 'work_item', workId);
  if (!previous) await ctx.insert('workspace', 'work_item', data, workId);
  else if (Object.entries(data).some(([key, value]) => previous.data[key] !== value)) {
    await ctx.update('workspace', 'work_item', workId, data, previous.version);
  }
}

async function recordJobEvent(ctx: Context, job: Entity, event: string, detail: Fields = {}) {
  await projectWorkItem(ctx, job);
  const payload = { agent_job_id: job.id, status: job.data.status, title: job.data.title,
    assignee_id: job.data.assignee_id, due_at: job.data.due_at, fencing_token: job.data.fencing_token };
  await ctx.insert(agentModule, 'agent_job_event', { ...payload, event, actor_id: ctx.actorId, ...detail });
  await ctx.emit(`agent.job.${event}`, payload);
}

export async function createAgentJob(ctx: Context, input: Fields, ruleRunId?: string) {
  const scope = object(input.input_scope ?? {}, 'input_scope');
  const jobKind = text({ kind: input.kind ?? 'custom' }, 'kind', 64);
  if (!/^[a-z][a-z0-9_]*$/.test(jobKind)) invalid('kind');
  const expected = object(input.expected_output ?? { type: 'note' }, 'expected_output');
  if (!['note', 'change_set'].includes(expected.type)) invalid('expected_output.type');
  const job = await ctx.insert(agentModule, kind, {
    title: text(input, 'title', 200), kind: jobKind, status: 'open', created_by: ctx.actorId,
    due_at: input.due_at == null ? null : time(input.due_at, 'due_at'),
    input_scope: {
      campaign_id: scope.campaign_id == null ? null : (await required(ctx, 'campaign', 'campaign', id(scope.campaign_id))).id,
      brand_id: scope.brand_id == null ? null : (await required(ctx, 'workspace', 'brand', id(scope.brand_id))).id,
      brief: scope.brief == null ? null : text(scope, 'brief', 4000),
    }, expected_output: { type: expected.type }, assignee_id: null, fencing_token: 0,
    pending_side_effects: [], source_rule_run_id: ruleRunId ?? null, ...clearLease,
  });
  await recordJobEvent(ctx, job, 'created');
  return job;
}

async function transition(ctx: Context, job: Entity, patch: Fields, event: string, detail?: Fields) {
  const next = await ctx.update(agentModule, kind, job.id, patch, job.version);
  await recordJobEvent(ctx, next, event, detail);
  if (next.data.source_rule_run_id && ['done', 'cancelled'].includes(next.data.status)) {
    const run = await required(ctx, agentModule, 'rule_run', next.data.source_rule_run_id);
    const succeeded = next.data.status === 'done';
    const status = succeeded ? 'succeeded' : 'failed';
    await ctx.update(agentModule, 'rule_run', run.id, { status, waiting_reason: null,
      failure_reason: succeeded ? null : 'agent_job_cancelled' }, run.version);
    await ctx.emit(`agent.rule_run.${succeeded ? 'completed' : 'failed'}`, { rule_run_id: run.id, status, agent_job_id: next.id });
  }
  return next;
}

async function jobFor(ctx: Context, input: Fields) {
  const job = await required(ctx, agentModule, kind, id(input.agent_job_id));
  if (input.expected_version !== undefined && integer(input.expected_version, 'expected_version') !== job.version) {
    throw new DomainError('version_conflict', 'Agent job changed since it was read', 409);
  }
  return job;
}

export async function requireAgentLease(ctx: Context, jobId: unknown, token: unknown, expectedVersion?: unknown) {
  const job = await jobFor(ctx, { agent_job_id: jobId, expected_version: expectedVersion });
  if (!active.includes(job.data.status) || expired(ctx, job) || job.data.lease_owner_id !== ctx.actorId ||
      job.data.lease_client_id !== client(ctx) || job.data.fencing_token !== integer(token, 'fencing_token')) {
    throw new DomainError('lease_lost', 'The job lease has expired or changed', 409);
  }
  return job;
}

async function unresolvedEffects(ctx: Context, job: Entity) {
  return (await ctx.list(agentModule, 'tool_call')).filter(row => row.data.agent_job_id === job.id && row.data.side_effect === true &&
    !['succeeded', 'denied', 'conflict', 'failed_before_submission', 'reconciled'].includes(row.data.outcome)).map(row => row.id);
}

export async function reapAgentJobLeases(ctx: Context, revokedClientId?: string) {
  const rows = (await ctx.list(agentModule, kind)).filter(row => expired(ctx, row) ||
    (revokedClientId !== undefined && active.includes(row.data.status) && row.data.lease_client_id === revokedClientId));
  for (const job of rows) await transition(ctx, job, {
    status: 'lease_expired', lease_expires_at: null, pending_side_effects: await unresolvedEffects(ctx, job),
  }, 'lease_expired');
  return { expired: rows.length };
}

function operationView(job: Entity) {
  return { operation_id: job.id, status: job.data.status, version: job.version,
    cancel_requested_at: job.data.cancel_requested_at ?? null };
}

async function requestCancellation(ctx: Context, job: Entity) {
  if (job.data.cancel_requested_at) return job;
  if (['done', 'cancelled', 'accepted'].includes(job.data.status)) conflict('Job cannot be cancelled');
  if ([...active, 'lease_expired'].includes(job.data.status) || (await unresolvedEffects(ctx, job)).length) {
    return transition(ctx, job, { cancel_requested_at: ctx.now }, 'cancel_requested');
  }
  return transition(ctx, job, { ...clearLease, assignee_id: null, status: 'cancelled', cancel_requested_at: ctx.now }, 'cancelled');
}

export const jobCommands: Commands = {
  jobs_create: command(writers, async (ctx, input) => {
    const job = await createAgentJob(ctx, input);
    return { ...job, operation_id: job.id };
  }),
  operations_get: command(readers, async (ctx, input) => {
    const job = view(ctx, await jobFor(ctx, { agent_job_id: input.operation_id }));
    return Object.defineProperties(operationView(job), {
      created_at: { value: job.created_at }, updated_at: { value: job.updated_at },
    });
  }),
  operations_cancel: command(reviewers, async (ctx, input) => {
    const job = await jobFor(ctx, { agent_job_id: input.operation_id, expected_version: integer(input.expected_version, 'expected_version') });
    return operationView(await requestCancellation(ctx, job));
  }),
  jobs_list: command(readers, async (ctx, input) => {
    const status = input.status === undefined ? undefined : text(input, 'status', 64);
    const jobKind = input.kind === undefined ? undefined : text(input, 'kind', 64);
    const campaignId = input.campaign_id === undefined ? undefined : id(input.campaign_id);
    return { items: (await ctx.list(agentModule, kind)).map(row => view(ctx, row)).filter(row =>
      (!status || row.data.status === status) && (!jobKind || row.data.kind === jobKind) &&
      (!campaignId || row.data.input_scope.campaign_id === campaignId)).slice(0, 100) };
  }),
  jobs_get: command(readers, async (ctx, input) => {
    const job = await jobFor(ctx, input);
    return { job: view(ctx, job), events: (await ctx.list(agentModule, 'agent_job_event')).filter(row => row.data.agent_job_id === job.id) };
  }),
  jobs_claim: command(claimRoles, async (ctx, input) => {
    const job = await jobFor(ctx, input);
    if (!['open', 'returned'].includes(job.data.status) || (job.data.assignee_id && job.data.assignee_id !== ctx.actorId)) conflict('Job is not claimable');
    return transition(ctx, job, { status: 'claimed', assignee_id: ctx.actorId, lease_owner_id: ctx.actorId,
      lease_client_id: client(ctx), lease_expires_at: expiry(ctx), fencing_token: job.data.fencing_token + 1 }, 'claimed');
  }),
  jobs_heartbeat: command(claimRoles, async (ctx, input) => {
    const job = await requireAgentLease(ctx, input.agent_job_id, input.fencing_token, input.expected_version);
    if (job.data.cancel_requested_at) conflict('Cancellation requested');
    const note = input.progress_note === undefined ? {} : { progress_note: text(input, 'progress_note', 2000) };
    return transition(ctx, job, { status: 'in_progress', lease_expires_at: expiry(ctx), ...note }, 'heartbeat', note);
  }),
  jobs_handoff: command(claimRoles, async (ctx, input) => {
    const job = await requireAgentLease(ctx, input.agent_job_id, input.fencing_token, input.expected_version);
    if (job.data.cancel_requested_at) conflict('Cancellation requested');
    const summary = text(input, 'done_summary', 4000);
    const pending = [...new Set([...await unresolvedEffects(ctx, job), ...array(input.pending_side_effects ?? [], 'pending_side_effects').map(id)])];
    return transition(ctx, job, { ...clearLease, assignee_id: null, status: pending.length ? 'lease_expired' : 'open',
      pending_side_effects: pending }, 'handed_off', { summary, pending_side_effects: pending });
  }),
  jobs_submit_result: command(claimRoles, async (ctx, input) => {
    const job = await requireAgentLease(ctx, input.agent_job_id, input.fencing_token, input.expected_version);
    if (job.data.cancel_requested_at || (await unresolvedEffects(ctx, job)).length) conflict('Resolve cancellation or pending effects before submission');
    const result = object(input.result_ref, 'result_ref');
    let resultRef: Fields;
    if (job.data.expected_output.type === 'change_set') {
      const set = await required(ctx, agentModule, 'change_set', id(result.change_set_id));
      if (set.data.agent_job_id !== job.id || set.data.status !== 'pending') conflict('Submit a pending change set for this job');
      resultRef = { change_set_id: set.id };
    } else resultRef = { note: text(result, 'note', 4000) };
    return transition(ctx, job, { ...clearLease, status: 'submitted', result_ref: resultRef }, 'submitted');
  }),
  jobs_accept: command(reviewers, async (ctx, input) => {
    const job = await jobFor(ctx, input);
    if (job.data.status !== 'submitted') conflict('Job has not been submitted');
    return transition(ctx, job, { status: 'accepted', accepted_by: ctx.actorId }, 'accepted');
  }),
  jobs_finish: command(reviewers, async (ctx, input) => {
    const job = await jobFor(ctx, input);
    if (job.data.status !== 'accepted') conflict('Job has not been accepted');
    return transition(ctx, job, { status: 'done' }, 'done');
  }),
  jobs_return: command(reviewers, async (ctx, input) => {
    const job = await jobFor(ctx, input);
    if (job.data.status !== 'submitted') conflict('Job has not been submitted');
    return transition(ctx, job, { status: 'returned', assignee_id: null }, 'returned', { note: text(input, 'note', 2000) });
  }),
  jobs_cancel: command(reviewers, async (ctx, input) => {
    const job = await jobFor(ctx, input);
    return requestCancellation(ctx, job);
  }),
  jobs_confirm_cancel: command(claimRoles, async (ctx, input) => {
    const job = await requireAgentLease(ctx, input.agent_job_id, input.fencing_token, input.expected_version);
    if (!job.data.cancel_requested_at || (await unresolvedEffects(ctx, job)).length) conflict('Resolve pending effects and request cancellation first');
    return transition(ctx, job, { ...clearLease, assignee_id: null, status: 'cancelled' }, 'cancelled');
  }),
  jobs_reconcile: command(reviewers, async (ctx, input) => {
    const job = await jobFor(ctx, input);
    if (view(ctx, job).data.status !== 'lease_expired' || (await unresolvedEffects(ctx, job)).length) conflict('No reconcilable lease, or unresolved tool calls remain');
    const note = text(input, 'note', 2000);
    if (job.data.pending_side_effects.length && input.effects_verified !== true) conflict('Confirm that pending effects have been verified');
    return transition(ctx, job, { ...clearLease, assignee_id: null, pending_side_effects: [],
      status: job.data.cancel_requested_at ? 'cancelled' : 'open' }, 'reconciled', { note });
  }),
};
