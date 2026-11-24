import { ADMIN, APPROVE, READ, TERMINAL_JOB_STATUSES, WRITE, Problem, type Context, type Data, type Input, type Operation, type Row, type WorkerJobStatus } from '@smartsell/contracts';
import { activePause, assessTarget, assertVersion, closeTarget, digest, entries, evergreenExpiry, findStandingGrant, hasExecutionRisk, instant, list, localMinute, locate, object, platformKey, resolveLocal, taskFor, time, type Stage } from '../../../../../packages/domain/src/publishing/index.js';
import { platformScheduleOperation, readPlatformSchedule } from './schedule-reconciliation.js';
import { acceptsVerification, cancellationTracking, ensureTask, pending, postAttribution, registerManualPost, requestCancellation, transition } from '../execution/service.js';
import { isSafeMode } from '../ops/controls.js';
import { assertLicenseAllowed, getLicenseState } from '../ops/metering.js';
import { DAY, date, dow, integer, minute, queueSlots, recurringDates, similarity } from './expansion.js';
import { approvalDeadline, channelSettings, isChannelDirect, registerPlanningHooks, workerEngine } from '../account/channel-settings.js';

export { commands, commands as planningCommands } from './commands.ts';
export { checkExecution } from './precheck.ts';

const KIND = 'publish_target';
const RESOURCE = 'planning.publish_target';
const TARGETS = '/publish-targets';
const HUMAN_WRITE = WRITE.filter(role => role !== 'agent');
const POLICY_ADMIN = [...ADMIN, 'manager'] as const;
const agentCredential = (ctx: Context) => (ctx as Context & { agentCredentialId?: string }).agentCredentialId;
const fromAgent = (ctx: Context) => ctx.role === 'agent' || !!agentCredential(ctx);
function standingGrant(ctx: Context, target: Data, overall: string) {
  const credential = agentCredential(ctx);
  return findStandingGrant(credential ? { ...ctx, role: 'agent', actorId: credential } : ctx, target, overall);
}
const FINAL = ['cancelled', 'superseded', 'closed'];
const FORMATS: Data = { feed_image: 'image', carousel: 'carousel', reel: 'reel', story: 'story', short_video: 'short', long_video: 'video', text: 'text', note: 'image', live_teaser: 'video', image: 'image', video: 'video', short: 'short' };
const fail = (message: string, details?: Data): never => { throw new Problem(422, 'VALIDATION_FAILED', message, details); };
const conflict = (message: string, code = 'INVALID_STATE'): never => { throw new Problem(409, code, message); };
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) return fail(`${field} is required`);
  return value.trim();
}
function pick<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return fail(`Invalid ${field}`, { allowed });
  return value as T;
}
function select(body: Data, fields: string[]): Data {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(body, field)).map(field => [field, body[field]]));
}
function expect(ctx: Context, input: Input, kind = KIND) {
  const row = ctx.get(kind, input.params.id);
  assertVersion(row, input.expectedVersion);
  return row;
}
function checkEditable(ctx: Context, target: Row) {
  if (FINAL.includes(String(target.plan_status)) || target.plan_status === 'cancel_requested') conflict('This target cannot be edited');
  if (hasExecutionRisk(ctx, target)) conflict('An execution may already have started. Reconcile or cancel it first.', 'LEASE_HELD');
}
function schedule(body: Data, account: Row, now: string, previous?: Row) {
  const changed = ['scheduled_at', 'local_scheduled_at', 'schedule_tz', 'tz', 'schedule_kind', 'dst_choice'].some(key => Object.hasOwn(body, key));
  if (!changed && previous) return select(previous, ['scheduled_at', 'local_scheduled_at', 'schedule_tz', 'schedule_kind', 'dst_resolution']);
  const schedule_kind = pick(body.schedule_kind ?? (body.scheduled_at != null || body.local_scheduled_at != null ? 'exact' : previous?.schedule_kind ?? 'asap'), ['exact', 'asap', 'manual_date'], 'schedule_kind');
  if (body.schedule_tz != null && body.tz != null && body.schedule_tz !== body.tz) fail('Provide one schedule time zone');
  const schedule_tz = text(body.schedule_tz ?? body.tz ?? previous?.schedule_tz ?? account.default_timezone ?? 'UTC', 'schedule_tz');
  localMinute(now, schedule_tz);
  if (body.scheduled_at != null && body.local_scheduled_at != null) fail('Provide one time representation');
  const dstChoice = body.dst_choice == null ? undefined : pick(body.dst_choice, ['shift_forward', 'earlier_occurrence', 'later_occurrence'], 'dst_choice');
  if (dstChoice && (body.local_scheduled_at == null || schedule_kind !== 'exact')) fail('dst_choice requires a local date and time');
  if (schedule_kind === 'asap' && (body.scheduled_at != null || body.local_scheduled_at != null) || schedule_kind === 'manual_date' && body.scheduled_at != null) fail('Time representation does not match schedule_kind');
  if (schedule_kind === 'manual_date') {
    const day = date(body.local_scheduled_at ?? previous?.local_scheduled_at, 'local_scheduled_at');
    return { schedule_kind, schedule_tz, local_scheduled_at: day, scheduled_at: null, dst_resolution: 'none' };
  }
  if (body.local_scheduled_at != null) {
    const local = text(body.local_scheduled_at, 'local_scheduled_at');
    return { schedule_kind, schedule_tz, local_scheduled_at: local, ...resolveLocal(local, schedule_tz, dstChoice) };
  }
  const scheduled_at = schedule_kind === 'asap'
    ? instant(previous?.schedule_kind === 'asap' && body.schedule_kind == null ? previous.scheduled_at : now, 'scheduled_at')
    : instant(body.scheduled_at ?? previous?.scheduled_at, 'scheduled_at');
  return { schedule_kind, schedule_tz, scheduled_at, local_scheduled_at: localMinute(scheduled_at, schedule_tz), dst_resolution: 'none' };
}
export function targetValues(ctx: Context, body: Data, previous?: Row): Data {
  const account = ctx.get('social_account', text(body.social_account_id ?? previous?.social_account_id, 'social_account_id'));
  const variant = ctx.get('content_variant', text(body.content_variant_id ?? previous?.content_variant_id, 'content_variant_id'));
  const item = ctx.get('content_item', text(variant.content_item_id, 'content_item_id'));
  if (body.variant_revision_id != null && body.revision_id != null && body.variant_revision_id !== body.revision_id) fail('Choose one revision ID');
  const selectedRevision = body.variant_revision_id ?? body.revision_id;
  const sameVariant = variant.id === previous?.content_variant_id;
  const follow_latest_revision = selectedRevision != null ? false : sameVariant ? previous?.follow_latest_revision !== false : true;
  const revision = ctx.get('content_revision', text(selectedRevision ?? (sameVariant ? previous?.variant_revision_id : undefined) ?? variant.current_revision_id, 'variant_revision_id'));
  if (revision.variant_id !== variant.id || (variant.platform !== 'generic' && platformKey(variant.platform) !== platformKey(account.platform ?? account.provider)) || (variant.social_account_id && variant.social_account_id !== account.id) || account.brand_id && account.brand_id !== item.brand_id || item.archived_at || item.production_stage === 'archived') fail('Revision, account and content must match the same publishing scope');
  const campaign = body.campaign_id ?? previous?.campaign_id ?? item.campaign_id;
  if (campaign != null) {
    const row = ctx.get('campaign', text(campaign, 'campaign_id'));
    if (row.brand_id && row.brand_id !== item.brand_id) fail('Campaign belongs to another brand');
  }
  const mode = pick(body.connector_mode_pref ?? previous?.connector_mode_pref ?? 'inherit', ['inherit', 'assist'], 'connector_mode_pref');
  if (previous?.connector_mode_pref === 'assist' && mode === 'inherit' && fromAgent(ctx)) throw new Problem(403, 'PERMISSION_DENIED', 'Only a person can restore account connector settings');
  const options = body.options === undefined ? object(previous?.options) : object(body.options);
  if (body.options != null && options !== body.options) fail('options must be an object');
  if (Object.keys(options).some(key => !['first_comment', 'location', 'user_tags', 'collaborators', 'internal_note'].includes(key))) fail('Platform settings must be selected on the content revision');
  const policy = body.late_policy ?? previous?.late_policy;
  const late_policy = policy == null ? null : pick(policy, ['skip', 'notify', 'grace_window'], 'late_policy');
  const grace = body.grace_minutes ?? previous?.grace_minutes;
  const grace_minutes = grace == null ? null : integer(grace, 0, 1440, 'grace_minutes');
  const format = FORMATS[String(variant.format)];
  if (typeof format !== 'string') fail('Unsupported variant format');
  const promotions = body.promotion_ids ?? previous?.promotion_ids ?? [];
  if (!Array.isArray(promotions) || promotions.some(id => typeof id !== 'string')) fail('promotion_ids must be an array of IDs');
  return {
    social_account_id: account.id, content_variant_id: variant.id, content_item_id: item.id, brand_id: item.brand_id, campaign_id: campaign ?? null,
    variant_revision_id: revision.id, follow_latest_revision, visibility: pick(body.visibility ?? previous?.visibility ?? 'public', ['public', 'private', 'unlisted', 'followers', 'scheduled_private'], 'visibility'),
    operation: pick(body.operation ?? previous?.operation ?? 'publish', ['publish', 'publish_story', 'publish_short', 'publish_schedule'], 'operation'),
    content_format: format, ...schedule(body, account, ctx.now, previous), late_policy, grace_minutes, connector_mode_pref: mode,
    options, promotion_ids: promotions, owner_user_id: text(body.owner_user_id ?? previous?.owner_user_id ?? ctx.actorId, 'owner_user_id'),
  };
}
export function createTarget(ctx: Context, values: Data, metadata: Data = {}) {
  const row = ctx.create(KIND, { ...values, ...metadata, plan_status: 'draft', snapshot_generation: 1, precheck_summary: 'not_run' });
  ctx.emit('planning.target.created', { target_id: row.id });
  return row;
}
function recordCheck(ctx: Context, target: Row, stage: Stage, assessment = assessTarget(ctx, target, stage)) {
  const run = ctx.create('precheck_run', { publish_target_id: target.id, stage, target_version: target.version, overall: assessment.overall, checked_at: ctx.now, valid_until: assessment.valid_until, route: assessment.route, effective_mode: assessment.effective_mode });
  const items = assessment.items.map(item => ctx.create('precheck_item', { ...item, run_id: run.id }));
  ctx.update(KIND, target.id, { last_precheck_run_id: run.id, precheck_summary: assessment.overall });
  ctx.emit('planning.precheck.completed', { target_id: target.id, run_id: run.id, blocked: assessment.overall === 'blocked', blockers: items.filter(row => row.severity === 'blocker').length, recipient_user_id: target.owner_user_id });
  return { ...run, items };
}
function bindReferences(ctx: Context, target: Row, assessment: ReturnType<typeof assessTarget>) {
  for (const row of ctx.list('publish_target_ref').filter(ref => ref.publish_target_id === target.id)) ctx.remove('publish_target_ref', row.id);
  const revision = locate(ctx, 'content_revision', target.variant_revision_id);
  const directAssets = entries(revision?.media).flatMap(item => {
    const assetId = locate(ctx, 'asset_version', item.asset_version_id)?.asset_id;
    return typeof assetId === 'string' ? [{ ref_type: 'asset', ref_id: assetId }] : [];
  });
  const refs = [...assessment.payload.refs, ...directAssets];
  for (const ref of new Map(refs.map(ref => [digest(ref), ref])).values()) {
    ctx.create('publish_target_ref', { ...ref, publish_target_id: target.id, bound_at_revision: target.variant_revision_id });
  }
}
function policyFor(ctx: Context, target: Data) {
  const keys: Data = { brand_ids: target.brand_id, social_account_ids: target.social_account_id, campaign_ids: target.campaign_id, content_types: target.content_format };
  return ctx.list('approval_policy').filter(policy => policy.resource_type === RESOURCE && policy.active === true && Object.entries(object(policy.conditions)).every(([key, values]) => key in keys && list(values).includes(keys[key])))
    .sort((a, b) => Object.keys(object(b.conditions)).length - Object.keys(object(a.conditions)).length || Number(b.mode === 'required') - Number(a.mode === 'required') || a.id.localeCompare(b.id))[0];
}
const defaultSteps = [{ order: 1, approvers: { roles: APPROVE }, min_approvals: 1, due_hours: 48 }];
const due = (ctx: Context, step: Data) => new Date(time(ctx.now) + Number(step.due_hours ?? 48) * 3_600_000).toISOString();
/**
 * Approval request deadline. E34: for a hub channel it is always scheduled_at + lateness_limit_min, the last moment the
 * post could still go out (phase1-design §4.2). There is no now + 48 h cap: a post planned days ahead stays approvable, and
 * request.due_at, approvalDeadline, the reminders and approval_lapsed all use the same deadline. Other targets keep the
 * step's hours.
 */
export function approvalDue(ctx: Context, target: Row | Data, step: Data): string {
  return approvalDeadline(ctx, target as Row) ?? due(ctx, step);
}
const workerTask = (task: Row | undefined) => Array.isArray(task?.route) && object(task.route[0]).executor === 'worker';
function matchesPolicy(request: Row, policy?: Row) {
  return (request.policy_id ?? null) === (policy?.id ?? null) && (request.policy_version ?? null) === (policy?.version ?? null);
}
function blockUnsent(ctx: Context, target: Row, reason: string) {
  const task = taskFor(ctx, target);
  // Worker-route task state is written only by the job engine (syncTaskFromJob). An invalid approval withdraws the live job;
  // other precheck failures are held by the go check and heartbeat hold instead (phase1-design §4.4, §5.10).
  if (workerTask(task)) {
    if (reason === 'approval_invalid') workerEngine().revokeForTarget(ctx, ctx.get(KIND, target.id), 'approval_invalidated');
    return;
  }
  // Keep the authorization hold through preflight refreshes and read-only reauthorization.
  if (reason === 'precheck_blocked' && task?.status === 'blocked' && task.status_reason === 'connection_revoked') return;
  if (task && ['scheduled', 'queued', 'blocked'].includes(String(task.status)) && !hasExecutionRisk(ctx, target)) {
    transition(ctx, task, 'blocked', reason);
  }
}
export function retireRequest(ctx: Context, row: Row, reason: string, status = 'invalidated') {
  const request = locate(ctx, 'approval_request', row.approval_request_id);
  if (!request || request.resource_type !== RESOURCE || request.resource_id !== row.id || !['approved', 'pending'].includes(String(request.status))) return;
  ctx.update('approval_request', request.id, { status, invalidated_reason: reason });
  ctx.emit(`core.approval_request.${status}`, { request_id: request.id, resource_id: row.id, reason });
  if (status === 'invalidated') {
    blockUnsent(ctx, row, 'approval_invalid');
    ctx.emit('planning.target.approval_invalidated', { target_id: row.id, approval_request_id: request.id, reason });
  }
}
function ready(ctx: Context, target: Row) {
  const row = ctx.update(KIND, target.id, { plan_status: 'ready', paused_by_switch_id: null });
  ensureTask(ctx, row);
  ctx.emit('planning.target.ready', { target_id: row.id, generation: row.snapshot_generation });
  return ctx.get(KIND, row.id);
}
/**
 * F4/F2: a hub-channel submission that precheck blocks leaves the post in draft (derived 「已擋下」, approval not_submitted),
 * not in awaiting_approval without a pending request, where every view would ask the owner for an approval the hub then
 * refuses. A changes_requested post that was explicitly resubmitted has left the owner's rejection behind, so it becomes
 * draft too. auto_submit_on_unblock carries the submission on: fixing the blocker, releasing the pause or resuming the
 * machine submits it again (E35). Like E23, the job of the withdrawn approval is revoked in the same transaction: it was
 * kept while the post was still ready, and nothing else would withdraw it before the lifecycle scan.
 */
function blockedResubmission(ctx: Context, target: Row, prior: Row | undefined): Row {
  if (!channelSettings(ctx, String(target.social_account_id)) || hasExecutionRisk(ctx, target)) return target;
  const validPending = prior?.status === 'pending' && prior.resource_id === target.id && prior.resource_hash === target.frozen_hash && time(prior.due_at) > time(ctx.now);
  if (!(target.plan_status === 'changes_requested' || target.plan_status === 'awaiting_approval' && !validPending)) return target;
  // A pending request that no longer binds this post (stale hash or past its deadline) is retired, never left behind.
  if (prior?.status === 'pending') {
    const elapsed = time(prior.due_at) <= time(ctx.now);
    retireRequest(ctx, target, elapsed ? 'deadline_elapsed' : 'resubmitted', elapsed ? 'expired' : 'invalidated');
  }
  const row = ctx.update(KIND, target.id, { plan_status: 'draft', frozen_hash: null, paused_by_switch_id: null, auto_submit_on_unblock: true });
  workerEngine().revokeForTarget(ctx, row, 'approval_invalidated');
  return ctx.get(KIND, target.id);
}
export function submit(ctx: Context, target: Row, assessment = assessTarget(ctx, target, 'schedule')): Row & { submission_status?: 'blocked'; precheck?: unknown } {
  if (!['draft', 'changes_requested', 'awaiting_approval'].includes(String(target.plan_status))) conflict('Target cannot be submitted');
  if (hasExecutionRisk(ctx, target)) conflict('Resolve the prior attempt before requesting approval');
  const prior = locate(ctx, 'approval_request', target.approval_request_id);
  const policy = policyFor(ctx, target);
  if (assessment.overall !== 'blocked' && prior?.status === 'pending' && prior.resource_id === target.id && prior.resource_type === RESOURCE && prior.resource_hash === assessment.hash && target.frozen_hash === assessment.hash && matchesPolicy(prior, policy) && time(prior.due_at) > time(ctx.now)) return target;
  const precheck = recordCheck(ctx, target, 'schedule', assessment);
  if (assessment.overall === 'blocked') return { ...blockedResubmission(ctx, ctx.get(KIND, target.id), prior), submission_status: 'blocked', precheck };
  retireRequest(ctx, target, prior?.status === 'pending' && time(prior.due_at) <= time(ctx.now) ? 'deadline_elapsed' : 'resubmitted', prior?.status === 'pending' && time(prior.due_at) <= time(ctx.now) ? 'expired' : 'invalidated');
  // A channel the owner set to "direct" is approved by that channel policy (§4.1); it is auditable via approved_via.
  const channelDirect = isChannelDirect(ctx, target, assessment);
  const grant = channelDirect.ok ? undefined : standingGrant(ctx, target, assessment.overall);
  const automatic = !!grant || policy?.mode === 'optional' && !fromAgent(ctx) || channelDirect.ok;
  const steps = policy ? entries(policy.steps) : defaultSteps;
  const request = ctx.create('approval_request', {
    resource_type: RESOURCE, resource_id: target.id, resource_hash: assessment.hash, policy_id: policy?.id ?? null, policy_version: policy?.version ?? null,
    status: automatic ? 'approved' : 'pending', current_step: 1, steps, due_at: approvalDue(ctx, target, steps[0]),
    approved_via: automatic ? (channelDirect.ok ? 'channel_policy' : 'policy') : null,
    channel_approval_generation: channelDirect.ok ? channelDirect.generation : null,
    standing_grant_id: grant?.id ?? null, decided_at: automatic ? ctx.now : null,
    context: { precheck_run_id: precheck.id, anchor_scheduled_at: target.scheduled_at, submitted_by: agentCredential(ctx) ?? ctx.actorId, submitted_by_type: fromAgent(ctx) ? 'agent_client' : 'user' },
  });
  bindReferences(ctx, target, assessment);
  const row = ctx.update(KIND, target.id, {
    plan_status: 'awaiting_approval', frozen_hash: assessment.hash, approval_request_id: request.id,
    approval_invalidated_reason: null, paused_by_switch_id: null,
    snapshot_generation: Number(target.snapshot_generation ?? 1) + Number(!!taskFor(ctx, target)),
  });
  ctx.emit('core.approval_request.created', { request_id: request.id, resource_id: target.id });
  ctx.emit('planning.target.submitted', { target_id: target.id, approval_request_id: request.id, requires_approval: !automatic });
  if (automatic) {
    ctx.emit('core.approval_request.approved', { request_id: request.id, resource_id: target.id });
    return ready(ctx, row);
  }
  return row;
}
/**
 * Common rule of phase1-design §4: a hub-channel target left in awaiting_approval must hold a pending request, otherwise the
 * owner cannot approve it and a direct channel is never re-approved. Legacy (non-channel) targets keep their old behaviour.
 */
export function resubmitIfWaiting(ctx: Context, targetId: string): Row & { submission_status?: 'blocked'; precheck?: unknown } {
  const target = ctx.get(KIND, targetId);
  if (target.plan_status !== 'awaiting_approval' || !channelSettings(ctx, String(target.social_account_id)) || hasExecutionRisk(ctx, target)) return target;
  const deadline = approvalDeadline(ctx, target);
  if (deadline && time(deadline) <= time(ctx.now)) return target;   // derived as missed (not_approved); rescheduling resubmits
  const request = locate(ctx, 'approval_request', target.approval_request_id);
  if (request?.status === 'pending' && request.resource_id === target.id && request.resource_hash === target.frozen_hash && time(request.due_at) > time(ctx.now)) return target;
  return submit(ctx, target);
}
function canDecide(ctx: Context, request: Row) {
  if (fromAgent(ctx) || !APPROVE.includes(ctx.role) || request.status !== 'pending') return false;
  const step = entries(request.steps)[Number(request.current_step) - 1];
  const approvers = object(step?.approvers);
  return !!step && (list(approvers.roles).includes(ctx.role) || list(approvers.user_ids).includes(ctx.actorId));
}
function pendingForActor(ctx: Context, request: Row, target?: Row) {
  return !!target && target.plan_status === 'awaiting_approval' && target.approval_request_id === request.id &&
    request.resource_type === RESOURCE && request.resource_id === target.id && request.resource_hash === target.frozen_hash &&
    canDecide(ctx, request) && time(request.due_at) > time(ctx.now) && matchesPolicy(request, policyFor(ctx, target)) &&
    !ctx.list('approval_decision').some(row => row.request_id === request.id && row.step_no === request.current_step && row.decided_by_user_id === ctx.actorId);
}
function decide(ctx: Context, target: Row, decision: 'approve' | 'reject' | 'request_changes', body: Data) {
  if (target.plan_status !== 'awaiting_approval') conflict('Target is not awaiting approval');
  const request = locate(ctx, 'approval_request', target.approval_request_id);
  if (!request || request.resource_type !== RESOURCE || request.resource_id !== target.id || request.status !== 'pending') return conflict('Resubmit the target to obtain a pending request');
  if (!canDecide(ctx, request)) throw new Problem(403, 'PERMISSION_DENIED', 'You are not assigned to this approval step');
  if (decision === 'approve' && hasExecutionRisk(ctx, target)) conflict('Resolve the prior attempt before approving this target', 'LEASE_HELD');
  if (time(request.due_at) <= time(ctx.now)) {
    retireRequest(ctx, target, 'deadline_elapsed', 'expired');
    return { ...target, decision_status: 'expired' };
  }
  const assessment = assessTarget(ctx, target, 'approval');
  if (assessment.hash !== request.resource_hash || target.frozen_hash !== request.resource_hash ||
    body.resource_hash != null && body.resource_hash !== request.resource_hash ||
    body.approval_request_id != null && body.approval_request_id !== request.id || !matchesPolicy(request, policyFor(ctx, target))) {
    return conflict('The request no longer binds the current target and policy', 'APPROVAL_STALE');
  }
  const step = Number(request.current_step);
  const decisions = ctx.list('approval_decision').filter(row => row.request_id === request.id && row.step_no === step);
  if (decisions.some(row => row.decided_by_user_id === ctx.actorId)) return conflict('This reviewer already decided this step', 'DUPLICATE_DECISION');
  if (decision === 'approve') {
    const precheck = recordCheck(ctx, target, 'approval', assessment);
    if (assessment.overall === 'blocked') return { ...ctx.get(KIND, target.id), decision_status: 'blocked', precheck };
  }
  ctx.create('approval_decision', { request_id: request.id, step_no: step, decision, decided_by_user_id: ctx.actorId, decided_via: 'web', comment: typeof (body.comment ?? body.reason ?? body.note) === 'string' ? body.comment ?? body.reason ?? body.note : null, decided_at: ctx.now });
  const steps = entries(request.steps);
  if (decision === 'approve' && decisions.filter(row => row.decision === 'approve').length + 1 < Number(steps[step - 1].min_approvals)) return ctx.update(KIND, target.id, { last_approval_decision_at: ctx.now });
  if (decision === 'approve' && steps.length > step) {
    ctx.update('approval_request', request.id, { current_step: step + 1, due_at: approvalDue(ctx, target, steps[step]) });
    ctx.emit('core.approval_request.step_advanced', { request_id: request.id, current_step: step + 1 });
    return ctx.update(KIND, target.id, { last_approval_decision_at: ctx.now });
  }
  const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested';
  ctx.update('approval_request', request.id, { status, decided_at: ctx.now, approved_via: decision === 'approve' ? 'human' : null });
  ctx.emit(`core.approval_request.${status}`, { request_id: request.id, resource_id: target.id });
  // E37: changes_requested (the request says rejected or changes_requested) is the owner's decision against this version. Nothing
  // resubmits it on its own (posting.unblock, approval-mode switches, pause release, invalidateTargets); only an explicit edit
  // or reschedule (updateTarget → draft, then submit) or an explicit publishing_request_approval sends it back.
  return decision === 'approve' ? ready(ctx, target) : ctx.update(KIND, target.id, { plan_status: 'changes_requested' });
}
export function updateTarget(ctx: Context, row: Row, body: Data, reschedule = false, values = targetValues(ctx, body, row)): Row & { approval_retained: boolean } {
  checkEditable(ctx, row);
  const next = { ...row, ...values };
  const prior = locate(ctx, 'approval_request', row.approval_request_id);
  const assessment = assessTarget(ctx, next, 'schedule');
  const previous = assessTarget(ctx, row, 'schedule');
  const anchor = object(prior?.context).anchor_scheduled_at ?? row.scheduled_at;
  const minutes = Math.abs(time(values.scheduled_at) - time(anchor)) / 60_000;
  const movement = row.scheduled_at !== next.scheduled_at || row.schedule_tz !== next.schedule_tz || row.local_scheduled_at !== next.local_scheduled_at || row.schedule_kind !== next.schedule_kind;
  if (movement && next.schedule_kind === 'exact' && time(next.scheduled_at) < time(ctx.now)) fail('Choose a scheduled time at or after now');
  const policy = locate(ctx, 'approval_policy', prior?.policy_id);
  const tolerance = object(policy?.change_tolerance);
  const limit = typeof tolerance.schedule_shift_minutes === 'number' ? Math.min(60, Math.max(0, tolerance.schedule_shift_minutes)) : 60;
  const assisted = row.connector_mode_pref !== 'assist' && next.connector_mode_pref === 'assist';
  const contentUnchanged = previous.hash === assessment.hash || assisted && assessTarget(ctx, { ...next, connector_mode_pref: row.connector_mode_pref }, 'schedule').hash === previous.hash;
  const sameSlotDay = String(row.local_scheduled_at).slice(0, 10) === String(next.local_scheduled_at).slice(0, 10);
  const validMovement = !movement || sameSlotDay && row.schedule_tz === next.schedule_tz && minutes <= limit;
  const keep = !!prior && prior.resource_type === RESOURCE && prior.resource_id === row.id &&
    (prior.status === 'approved' || prior.status === 'pending' && time(prior.due_at) > time(ctx.now)) &&
    matchesPolicy(prior, policyFor(ctx, next)) && prior.resource_hash === row.frozen_hash && row.frozen_hash === previous.hash &&
    row.variant_revision_id === next.variant_revision_id && contentUnchanged && validMovement &&
    !(prior.standing_grant_id && (movement || assisted || row.campaign_id !== next.campaign_id));
  if (prior && !keep) retireRequest(ctx, row, reschedule ? 'rescheduled_outside_tolerance' : 'target_changed');
  if (keep && prior && (movement || assisted)) {
    // A hub channel's pending request follows the post: its deadline is the new scheduled_at + lateness (E34, no hours cap).
    const due_at = prior.status === 'pending' && movement ? approvalDeadline(ctx, next as Row) ?? undefined : undefined;
    ctx.update('approval_request', prior.id, { resource_hash: assessment.hash, previous_resource_hash: previous.hash, ...(due_at ? { due_at } : {}) });
    ctx.emit('planning.target.approval_kept_under_tolerance', { target_id: row.id, request_id: prior.id, old_hash: previous.hash, resource_hash: assessment.hash });
  }
  const executionChanged = movement || digest(previous.payload) !== digest(assessment.payload) || row.connector_mode_pref !== next.connector_mode_pref || row.grace_minutes !== next.grace_minutes || row.late_policy !== next.late_policy;
  const plan_status = prior && !keep && ['ready', 'awaiting_approval', 'paused'].includes(String(row.plan_status)) ? 'awaiting_approval' : row.plan_status === 'changes_requested' ? 'draft' : row.plan_status;
  const updated = ctx.update(KIND, row.id, { ...values, plan_status, paused_by_switch_id: plan_status === 'paused' ? row.paused_by_switch_id : null, ...(movement ? { assist_reminder_at: null } : {}), frozen_hash: keep ? assessment.hash : null, snapshot_generation: Number(row.snapshot_generation ?? 1) + Number(executionChanged), precheck_summary: 'stale' });
  bindReferences(ctx, updated, assessment);
  if (updated.plan_status === 'ready' && executionChanged) ensureTask(ctx, updated);
  ctx.emit(`planning.target.${reschedule ? 'rescheduled' : 'updated'}`, { target_id: row.id, approval_retained: keep });
  return { ...ctx.get(KIND, row.id), approval_retained: keep };
}
/** After an edit that dropped the approval, a hub channel resubmits at once (direct approves, needs_approval waits for the owner). */
function withResubmit(ctx: Context, updated: Row & { approval_retained: boolean }) {
  if (updated.approval_retained) return updated;
  return { ...resubmitIfWaiting(ctx, updated.id), approval_retained: false };
}
export function cancel(ctx: Context, target: Row, reason?: unknown) {
  if (FINAL.includes(String(target.plan_status))) return conflict('Target is already final');
  const task = taskFor(ctx, target);
  if (target.plan_status === 'cancel_requested') return { ...target, ...cancellationTracking(ctx, task) };
  retireRequest(ctx, target, 'target_cancelled', 'cancelled');
  const row = ctx.update(KIND, target.id, { plan_status: task ? 'cancel_requested' : 'cancelled', cancellation_reason: typeof reason === 'string' ? reason : null });
  ctx.emit(`planning.target.${task ? 'cancel_requested' : 'cancelled'}`, { target_id: row.id });
  const next = task && requestCancellation(ctx, row);
  if (next?.status === 'cancelled') {
    const current = ctx.get(KIND, target.id);
    if (current.plan_status === 'cancel_requested') {
      ctx.update(KIND, target.id, { plan_status: 'cancelled' });
      ctx.emit('planning.target.cancelled', { target_id: target.id });
    }
  }
  return { ...ctx.get(KIND, target.id), ...cancellationTracking(ctx, next) };
}

function display(ctx: Context, target: Row, task?: Row) {
  if (target.plan_status === 'cancel_requested') return 'cancel_requested';
  const unresolved = task && ctx.list('execution_attempt').some(attempt => (attempt.task_id ?? attempt.execution_task_id) === task.id && attempt.status === 'unknown' && attempt.side_effect_possible !== false);
  if (task?.status === 'outcome_unknown' || unresolved || list(task?.pending_side_effects).length && task?.status === 'manual') return 'outcome_unknown';
  if (target.plan_status === 'closed') {
    return ({ matched_native: 'published', manual_done: 'published', published: 'published', expired_skipped: 'expired', failed_final: 'failed' } as Data)[String(target.close_reason)] ?? task?.status ?? target.close_reason ?? 'closed';
  }
  if (target.plan_status === 'ready') {
    if (['queued', 'running', 'accepted'].includes(String(task?.status))) return 'executing';
    return task?.status ?? 'scheduled';
  }
  return target.plan_status;
}
function targetSummary(ctx: Context, target: Row): Row & { display_status: unknown; execution_status: unknown; execution_substatus: unknown } {
  const task = taskFor(ctx, target);
  const post = ctx.list('platform_post').find(row => row.publish_target_id === target.id && ['system_verified', 'manual_confirmed'].includes(String(row.verification)));
  const check = locate(ctx, 'precheck_run', target.last_precheck_run_id);
  const precheck_summary = check && time(check.valid_until) <= time(ctx.now) ? 'stale' : target.precheck_summary;
  return {
    ...target, title: target.title ?? locate(ctx, 'content_item', target.content_item_id)?.title,
    precheck_summary, display_status: display(ctx, target, task), execution_status: task?.status ?? null,
    execution_substatus: task?.substatus ?? task?.sub_status ?? null,
    platform_post_id: post?.id ?? null, published_at: post?.published_at ?? null, post_verification: post?.verification ?? null,
  };
}
function calendarBoundary(value: unknown, field: string) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return time(`${date(value, field)}T00:00:00Z`);
  return time(instant(value, field));
}
function listTargets(ctx: Context, query: Data) {
  const from = query.from ? calendarBoundary(query.from, 'from') : -Infinity;
  const to = query.to ? calendarBoundary(query.to, 'to') : Infinity;
  if (from >= to) fail('Calendar range requires from before to');
  const inRange = (row: Row) => {
    const at = time(row.scheduled_at ?? (row.local_scheduled_at ? `${row.local_scheduled_at}T00:00:00Z` : null));
    return (from === -Infinity && to === Infinity) || at >= from && at < to;
  };
  const selectedCampaigns = typeof query.campaign_ids === 'string' ? query.campaign_ids.split(',') : [];
  return ctx.list(KIND).filter(row => inRange(row) && ['brand_id', 'social_account_id', 'campaign_id'].every(key => !query[key] || query[key] === row[key]) && (!query.owner_id || query.owner_id === row.owner_user_id) && (!selectedCampaigns.length || selectedCampaigns.includes(String(row.campaign_id))))
    .map(row => targetSummary(ctx, row)).filter(row => !query.status || query.status === row.display_status || query.status === row.plan_status).sort((a, b) => String(a.scheduled_at ?? a.local_scheduled_at).localeCompare(String(b.scheduled_at ?? b.local_scheduled_at)));
}
function calendar(ctx: Context, query: Data) {
  const view = pick(query.view ?? 'week', ['day', 'week', 'month', 'list', 'lane'], 'view');
  const targets = listTargets(ctx, query);
  const matchingTargets = listTargets(ctx, { ...query, from: undefined, to: undefined });
  const targetIds = new Set(matchingTargets.map(row => row.id));
  const from = query.from ? calendarBoundary(query.from, 'from') : -Infinity;
  const to = query.to ? calendarBoundary(query.to, 'to') : Infinity;
  const inDate = (value: unknown) => typeof value === 'string' && time(value) >= from && time(value) < to;
  const selectedCampaigns = typeof query.campaign_ids === 'string' ? query.campaign_ids.split(',') : [];
  const relatedItems = new Set(matchingTargets.map(target => target.content_item_id));
  const matchesContent = (row: Row) => !row.archived_at &&
    (!query.brand_id || row.brand_id === query.brand_id) && (!query.campaign_id || row.campaign_id === query.campaign_id) &&
    (!selectedCampaigns.length || selectedCampaigns.includes(String(row.campaign_id))) &&
    (!(query.social_account_id || query.status) || relatedItems.has(row.id));
  const posts = ctx.list('platform_post').filter(row => inDate(row.published_at) && (targetIds.has(String(row.publish_target_id)) || !row.publish_target_id && !query.campaign_id && !query.campaign_ids && !query.brand_id && !query.owner_id && !query.status && (!query.social_account_id || row.social_account_id === query.social_account_id)));
  const production = ctx.list('content_item').filter(row => matchesContent(row) && inDate(row.production_due_at) && (!query.owner_id || row.owner_user_id === query.owner_id));
  const productionTasks = ctx.list('work_item').flatMap(row => {
    if ((row.type ?? row.kind) !== 'production_task' || !inDate(row.due_at) || ['done', 'cancelled'].includes(String(row.status))) return [];
    const itemId = row.content_item_id ?? object(row.subject_ref).id;
    const item = locate(ctx, 'content_item', itemId);
    if (!item || !matchesContent(item) || query.owner_id && query.owner_id !== (row.assignee_user_id ?? row.assignee_id)) return [];
    return [{ content_item_id: item.id, work_item_id: row.id, title: row.title, due_at: row.due_at, production_stage: item.production_stage }];
  });
  return { view, targets, executions: targets.flatMap(target => { const task = taskFor(ctx, target); return task ? [{ target_id: target.id, task_id: task.id, status: task.status, substatus: target.execution_substatus }] : []; }), posts, production_deadlines: [...production.map(row => ({ content_item_id: row.id, title: row.title, due_at: row.production_due_at, production_stage: row.production_stage })), ...productionTasks] };
}
function detail(ctx: Context, target: Row) {
  const request = locate(ctx, 'approval_request', target.approval_request_id);
  const task = taskFor(ctx, target);
  const run = locate(ctx, 'precheck_run', target.last_precheck_run_id);
  const accountZone = locate(ctx, 'social_account', target.social_account_id)?.default_timezone;
  const scheduleTimezoneDifference = typeof accountZone === 'string' && target.schedule_tz && target.schedule_tz !== accountZone
    ? { scheduled_timezone: target.schedule_tz, account_timezone: accountZone }
    : null;
  const editable = WRITE.includes(ctx.role) && !FINAL.includes(String(target.plan_status)) && target.plan_status !== 'cancel_requested';
  return { ...targetSummary(ctx, target), schedule_timezone_difference: scheduleTimezoneDifference, revision: locate(ctx, 'content_revision', target.variant_revision_id), precheck: run ? { ...run, items: ctx.list('precheck_item').filter(row => row.run_id === run.id) } : null, approval: request,
    execution: task ?? null, execution_timeline: task ? ctx.list('execution_attempt').filter(row => row.execution_task_id === task.id || row.task_id === task.id) : [],
    planning_timeline: ctx.list('approval_request').filter(row => row.resource_type === RESOURCE && row.resource_id === target.id),
    allowed_actions: [...(editable ? ['cancel'] : []), ...(editable && !hasExecutionRisk(ctx, target) ? ['update', 'reschedule'] : []), ...(editable && !hasExecutionRisk(ctx, target) && ['draft', 'changes_requested', 'awaiting_approval'].includes(String(target.plan_status)) ? ['submit'] : []), ...(request && pendingForActor(ctx, request, target) ? ['approve', 'reject', 'request-changes'] : [])],
  };
}
function policyValues(body: Data, previous?: Row) {
  const source = { ...previous, ...select(body, ['name', 'conditions', 'steps', 'mode', 'active', 'change_tolerance']) };
  const conditions = object(source.conditions);
  if (source.conditions != null && conditions !== source.conditions || Object.entries(conditions).some(([key, values]) => !['brand_ids', 'social_account_ids', 'campaign_ids', 'content_types'].includes(key) || !Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string'))) fail('Invalid policy conditions');
  if (source.steps != null && (!Array.isArray(source.steps) || source.steps.some(step => step !== object(step)))) fail('Invalid approval steps');
  const steps = entries(source.steps ?? defaultSteps).sort((a, b) => Number(a.order) - Number(b.order));
  if (!steps.length || steps.length > 10 || steps.some((step, index) => {
    const approvers = object(step.approvers);
    return step.order !== index + 1 || !Number.isInteger(step.min_approvals) || Number(step.min_approvals) < 1 || !Number.isFinite(step.due_hours ?? 48) || Number(step.due_hours ?? 48) <= 0 || Number(step.due_hours ?? 48) > 8760 || !list(approvers.roles).length && !list(approvers.user_ids).length || list(approvers.roles).some(role => !APPROVE.includes(role as never)) || list(approvers.user_ids).some(id => typeof id !== 'string');
  })) fail('Invalid approval steps');
  if (source.active != null && typeof source.active !== 'boolean') fail('active must be a boolean');
  const change_tolerance = object(source.change_tolerance);
  if (source.change_tolerance != null && change_tolerance !== source.change_tolerance) fail('Invalid change tolerance');
  if (change_tolerance.schedule_shift_minutes !== undefined) integer(change_tolerance.schedule_shift_minutes, 0, 60, 'schedule_shift_minutes');
  return { name: text(source.name, 'name'), conditions, steps, mode: pick(source.mode ?? 'required', ['required', 'optional'], 'mode'), active: source.active ?? true, change_tolerance, resource_type: RESOURCE };
}
function checkPolicyImpact(ctx: Context) {
  for (const target of ctx.list(KIND)) {
    if (!['awaiting_approval', 'ready', 'paused'].includes(String(target.plan_status))) continue;
    const request = locate(ctx, 'approval_request', target.approval_request_id);
    if (!request || !['pending', 'approved'].includes(String(request.status)) || matchesPolicy(request, policyFor(ctx, target))) continue;
    retireRequest(ctx, target, 'policy_changed');
    if (!hasExecutionRisk(ctx, target)) ctx.update(KIND, target.id, { plan_status: 'awaiting_approval', paused_by_switch_id: null, frozen_hash: null, precheck_summary: 'stale', approval_invalidated_reason: 'policy_changed' });
    resubmitIfWaiting(ctx, target.id);
  }
}

function validatePlanItems(items: unknown) {
  if (!Array.isArray(items) || !items.length || items.length > 250 || items.some(item => item !== object(item))) fail('Supply between 1 and 250 plan item objects');
}
function makePlan(ctx: Context, body: Data) {
  const source = fromAgent(ctx) ? 'agent' : pick(body.source ?? 'manual', ['manual', 'batch', 'recurring', 'evergreen'], 'source');
  if (body.campaign_id) ctx.get('campaign', text(body.campaign_id, 'campaign_id'));
  validatePlanItems(body.items);
  return ctx.create('publish_plan', { campaign_id: body.campaign_id ?? null, title: body.title ?? null, source, commit_mode: pick(body.commit_mode ?? 'partial', ['partial', 'all_or_nothing'], 'commit_mode'), items: body.items, status: 'draft' });
}
function previewPlan(ctx: Context, plan: Data) {
  const existing = plan.id == null ? [] : ctx.list(KIND).filter(row => row.plan_id === plan.id && !['cancelled', 'superseded'].includes(String(row.plan_status)));
  const seen = new Set<string>();
  const matched = new Set<string>();
  const items = entries(plan.items).map((body, index) => {
    try {
      const previous = body.target_id ? existing.find(row => row.id === body.target_id) : undefined;
      if (body.target_id && !previous) return fail('target_id is not part of this plan');
      const payload = { campaign_id: plan.campaign_id, ...body };
      const proposed = targetValues(ctx, payload, previous);
      const slot = (row: Data) => row.schedule_kind === 'asap' ? 'asap' : row.scheduled_at ?? row.local_scheduled_at;
      const key = digest([proposed.social_account_id, proposed.content_variant_id, slot(proposed)]);
      if (seen.has(key)) return fail('Duplicate account, variant and slot in this plan');
      seen.add(key);
      const match = previous ?? existing.find(row => row.social_account_id === proposed.social_account_id && row.content_variant_id === proposed.content_variant_id && slot(row) === slot(proposed));
      if (match && matched.has(match.id)) return fail('A plan item can only match one target once');
      if (match) matched.add(match.id);
      const values = targetValues(ctx, payload, match);
      if (match?.schedule_kind === 'asap' && values.schedule_kind === 'asap') Object.assign(values, select(match, ['scheduled_at', 'local_scheduled_at']));
      const assessment = assessTarget(ctx, { ...match, ...values }, 'schedule');
      const action = match ? (digest(select(match, Object.keys(values))) === digest(values) ? 'unchanged' : 'change') : 'add';
      if (match && action === 'change') checkEditable(ctx, match);
      return { index, action, values, target_id: match?.id, target_version: match?.version, precheck: assessment, requires_approval: !standingGrant(ctx, values, assessment.overall) && !(policyFor(ctx, values)?.mode === 'optional' && !fromAgent(ctx)) };
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      return { index, action: 'error', error: { code: error.code, message: error.message } };
    }
  });
  const incomplete = items.some(item => item.action === 'error' || item.precheck?.overall === 'blocked');
  const removed = existing.filter(row => !matched.has(row.id)).map(row => ({
    target_id: row.id, action: 'remove', blocked: incomplete || !!taskFor(ctx, row) || FINAL.includes(String(row.plan_status)),
    ...(incomplete ? { error_code: 'PLAN_ITEMS_INVALID' } : {}),
  }));
  const binding = items.map(item => {
    const values = item.values?.schedule_kind === 'asap' ? { ...item.values, scheduled_at: null, local_scheduled_at: null } : item.values;
    return { index: item.index, action: item.action, values, target_id: item.target_id, target_version: item.target_version, approval_hash: item.precheck?.hash, error: item.error };
  });
  const existingVersions = new Map(existing.map(row => [row.id, row.version]));
  const removalBinding = removed.map(item => ({ ...item, target_version: existingVersions.get(item.target_id) }));
  return { items, removed, preview_hash: digest({ binding, removalBinding }) };
}
function commitPlan(ctx: Context, plan: Row, previewHash?: unknown) {
  if (typeof plan.operation_id === 'string') return { ...ctx.get('operation', plan.operation_id), operation_id: plan.operation_id,
    items: ctx.list('operation_item').filter(row => row.operation_id === plan.operation_id) };
  const preview = previewPlan(ctx, plan);
  if (previewHash != null && previewHash !== preview.preview_hash) conflict('The plan changed since preview. Preview it again.', 'PREVIEW_STALE');
  if (plan.commit_mode === 'all_or_nothing' && (preview.items.some(item => item.error || item.precheck?.overall === 'blocked') || preview.removed.some(item => item.blocked))) throw new Problem(422, 'PRECHECK_BLOCKED', 'No plan items were committed', preview);
  const operation = ctx.create('operation', { kind: 'publishing.commit_plan', resource_id: plan.id, status: 'running' });
  const results: Row[] = [];
  const save = (fields: Data) => results.push(ctx.create('operation_item', { operation_id: operation.id, ...fields }));
  for (const item of preview.items) {
    if (item.error || !item.values || item.precheck?.overall === 'blocked') {
      save({ item_no: item.index, status: 'failed', error: item.error ?? { code: 'PRECHECK_BLOCKED', checks: item.precheck?.items } });
      continue;
    }
    const row = item.target_id ? ctx.get(KIND, item.target_id) : createTarget(ctx, item.values, { plan_id: plan.id, origin: plan.source });
    const updated = item.action === 'change' ? updateTarget(ctx, row, {}, false, item.values) : row;
    const submitted = ['draft', 'changes_requested', 'awaiting_approval'].includes(String(updated.plan_status)) ? submit(ctx, updated) : updated;
    const blocked = 'submission_status' in submitted && submitted.submission_status === 'blocked';
    if (blocked && plan.commit_mode === 'all_or_nothing') throw new Problem(422, 'PRECHECK_BLOCKED', 'Plan conflicts emerged during commit', { target_id: row.id });
    save({ item_no: item.index, status: blocked ? 'failed' : submitted.plan_status === 'awaiting_approval' ? 'approval_required' : 'succeeded', target_id: row.id, approval_request_id: submitted.approval_request_id, ...(blocked ? { error: { code: 'PRECHECK_BLOCKED' } } : {}) });
  }
  for (const item of preview.removed) {
    if (item.blocked) save({ target_id: item.target_id, status: 'failed', error: { code: item.error_code ?? 'CANCEL_REQUIRED' } });
    else {
      const target = ctx.get(KIND, item.target_id);
      retireRequest(ctx, target, 'superseded');
      ctx.update(KIND, item.target_id, { plan_status: 'superseded' });
      ctx.emit('planning.target.updated', { target_id: item.target_id, plan_status: 'superseded' });
      save({ target_id: item.target_id, status: 'succeeded', action: 'remove' });
    }
  }
  const failures = results.filter(row => row.status === 'failed').length;
  const status = failures === 0 ? 'committed' : failures === results.length ? 'failed' : 'partially_committed';
  ctx.update('publish_plan', plan.id, { preview, status, operation_id: operation.id, committed_at: ctx.now });
  const result = ctx.update('operation', operation.id, { status: failures ? status : 'succeeded', total: results.length, failures });
  ctx.emit('planning.plan.committed', { plan_id: plan.id, operation_id: operation.id, total: results.length, failures });
  return { ...result, operation_id: result.id, items: results };
}

function latestEngagements(ctx: Context) {
  const observations = new Map<string, Row>();
  for (const row of ctx.list('metric_observation')) {
    if (typeof row.subject_id !== 'string' || row.metric_key !== 'engagements' || row.availability !== 'observed' ||
      typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value < 0) continue;
    const observed = time(row.observed_at);
    if (!Number.isFinite(observed) || observed > time(ctx.now)) continue;
    const previous = observations.get(row.subject_id);
    if (!previous || observed > time(previous.observed_at)) observations.set(row.subject_id, row);
  }
  return observations;
}

/** Machines whose heartbeat carries a hub channel affected by a pause in this scope (phase1-design §5.4.1 sync_generation). */
function pausedChannelDevices(ctx: Context, scopeType: string, scopeId: string): string[] {
  const campaignAccounts = scopeType === 'campaign' ? new Set(ctx.list(KIND).filter(row => row.campaign_id === scopeId).map(row => row.social_account_id)) : undefined;
  const accounts = ctx.list('social_account').filter(account => channelSettings(ctx, account.id) && (scopeType === 'workspace' ||
    scopeType === 'brand' && account.brand_id === scopeId || scopeType === 'social_account' && account.id === scopeId || !!campaignAccounts?.has(account.id)));
  const ids = accounts.map(account => ctx.list('account_execution_binding').find(row => row.social_account_id === account.id)?.device_id);
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}
function bumpPausedDevices(ctx: Context, scopeType: string, scopeId: string, reason: string) {
  const devices = pausedChannelDevices(ctx, scopeType, scopeId);
  if (devices.length) workerEngine().bumpSyncGeneration(ctx, devices, reason);
}
function activatePause(ctx: Context, body: Data) {
  const scope_type = pick(body.scope_type ?? 'workspace', ['workspace', 'brand', 'campaign', 'social_account'], 'scope_type');
  const scope_id = scope_type === 'workspace' ? ctx.workspaceId : ctx.get(scope_type, text(body.scope_id, 'scope_id')).id;
  const reason = text(body.reason, 'reason');
  const mode = pick(body.mode ?? 'hold', ['hold', 'hold_and_unschedule'], 'mode');
  const current = ctx.list('pause_switch').find(row => row.scope_type === scope_type && row.scope_id === scope_id && !row.released_at);
  if (current) return current;
  const row = ctx.create('pause_switch', { scope_type, scope_id, reason, mode, activated_at: ctx.now, activated_by: ctx.actorId });
  const matchesScope = (target: Row) => ({ workspace: ctx.workspaceId, brand: target.brand_id, campaign: target.campaign_id, social_account: target.social_account_id }[scope_type]) === scope_id;
  for (const target of ctx.list(KIND).filter(target => matchesScope(target) && ['ready', 'paused'].includes(String(target.plan_status)))) {
    const task = taskFor(ctx, target);
    if (mode === 'hold_and_unschedule' && task?.status === 'accepted' && task.sub_status === 'scheduled_on_platform' && !task.restore_hold && pending(ctx, task)) {
      ctx.update(KIND, target.id, { unschedule_requested_by_switch_id: row.id, paused_by_switch_id: null });
      cancel(ctx, target, reason);
      continue;
    }
    if (target.plan_status !== 'ready') continue;
    ctx.update(KIND, target.id, { plan_status: 'paused', paused_by_switch_id: row.id });
    ctx.emit('planning.target.paused', { target_id: target.id, pause_switch_id: row.id, mode });
  }
  ctx.emit('planning.pause_switch.activated', { pause_switch_id: row.id, scope_type, scope_id, mode });
  bumpPausedDevices(ctx, scope_type, scope_id, 'pause_activated');
  return row;
}
function pauseWithdrawals(ctx: Context, pauseId: string) {
  return ctx.list(KIND).filter(target => target.unschedule_requested_by_switch_id === pauseId).map(target => ({
    target_id: target.id, title: target.title, plan_status: target.plan_status, execution_status: taskFor(ctx, target)?.status,
  }));
}
/** The Worker job a hub target points at, else its newest publish job (the same rule as the post views). */
function latestPublishJob(ctx: Context, target: Row): Row | undefined {
  const jobs = ctx.list('worker_job').filter(job => job.publish_target_id === target.id && job.kind === 'publish_post' && job.dry_run !== true);
  return jobs.find(job => job.id === target.worker_job_id)
    ?? [...jobs].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))[0];
}
/**
 * E35: submit again the hub-channel targets that a pause or a paused machine held before they were ever approved: draft ones the
 * Agent scheduled (auto_submit_on_unblock) and awaiting_approval ones without a valid pending request (§4 common rule). Never
 * changes_requested (E37: the owner's rejection stands), never a post past its lateness limit (derived missed; 「改到…」
 * resubmits it) and never one another active pause still holds. Returns how many were submitted.
 */
export function resubmitWaiting(ctx: Context, match: (target: Row) => boolean): number {
  let count = 0;
  for (const row of ctx.list(KIND).filter(match)) {
    const target = ctx.get(KIND, row.id);
    if (!['draft', 'awaiting_approval'].includes(String(target.plan_status)) || !channelSettings(ctx, String(target.social_account_id))) continue;
    if (target.plan_status === 'draft' && target.auto_submit_on_unblock !== true) continue;
    if (activePause(ctx, target) || hasExecutionRisk(ctx, target)) continue;
    const deadline = approvalDeadline(ctx, target);
    if (deadline && time(deadline) <= time(ctx.now)) continue;
    const before = target.approval_request_id;
    const result = target.plan_status === 'draft' ? submit(ctx, target) : resubmitIfWaiting(ctx, target.id);
    if (result.approval_request_id !== before) count++;
  }
  return count;
}
function releasePause(ctx: Context, row: Row, body: Data) {
  if (row.released_at) return conflict('Pause is already released');
  const targets = ctx.list(KIND).filter(target => target.paused_by_switch_id === row.id && target.plan_status === 'paused');
  // A hub channel post is late only after its lateness limit (scheduled_at + lateness_limit_min, §5.6): released within it,
  // the Worker still runs it (§5.4.4 item 4). Closing it as skipped at scheduled_at would cancel a post that can still go out.
  const missed = (target: Row) => {
    const deadline = approvalDeadline(ctx, target);
    if (deadline) return time(deadline) < time(ctx.now);
    return target.schedule_kind === 'manual_date'
      ? String(target.local_scheduled_at) < localMinute(ctx.now, String(target.schedule_tz ?? 'UTC')).slice(0, 10)
      : time(target.scheduled_at) < time(ctx.now);
  };
  if (body.dry_run === true) return {
    pause_switch_id: row.id, version: row.version,
    targets: targets.map(target => ({ target_id: target.id, version: target.version, missed: missed(target), scheduled_at: target.scheduled_at, local_scheduled_at: target.local_scheduled_at, execution_locked: hasExecutionRisk(ctx, target) })),
    platform_withdrawals: pauseWithdrawals(ctx, row.id),
  };
  if (body.decisions != null && (!Array.isArray(body.decisions) || body.decisions.some((choice: unknown) => choice !== object(choice)))) fail('decisions must be an array of objects');
  const choices = entries(body.decisions);
  const seen = new Set<unknown>();
  for (const choice of choices) {
    const target = targets.find(target => target.id === choice.target_id);
    if (!target || seen.has(choice.target_id)) return fail('Invalid or duplicate release target');
    if (choice.expected_version !== undefined) {
      if (typeof choice.expected_version !== 'number') return fail('Invalid release target version');
      assertVersion(target, choice.expected_version);
    }
    seen.add(choice.target_id);
    const action = pick(choice.action, ['skip', 'asap', 'reschedule'], 'release decision');
    if (action === 'reschedule' && choice.scheduled_at == null && choice.local_scheduled_at == null) fail('A release reschedule requires a new time');
    if (hasExecutionRisk(ctx, target)) conflict('A target with a possible external result cannot be rescheduled or skipped', 'LEASE_HELD');
    if (ctx.list('pause_switch').some(other => other.id !== row.id && !other.released_at && other.scope_id === ({ workspace: ctx.workspaceId, brand: target.brand_id, campaign: target.campaign_id, social_account: target.social_account_id } as Data)[String(other.scope_type)])) {
      conflict('Another active switch still pauses this target', 'PUBLISHING_PAUSED');
    }
  }
  const released = ctx.update('pause_switch', row.id, { released_at: ctx.now, released_by: ctx.actorId, release_decisions: choices });
  for (const target of targets) {
    const another = activePause(ctx, target);
    if (another) { ctx.update(KIND, target.id, { paused_by_switch_id: another.id }); continue; }
    const choice = choices.find(entry => entry.target_id === target.id);
    if (hasExecutionRisk(ctx, target)) {
      if (choice) conflict('A target with a possible external result cannot be rescheduled or skipped', 'LEASE_HELD');
      ctx.update(KIND, target.id, { plan_status: 'ready', paused_by_switch_id: null });
      continue;
    }
    const hub = !!channelSettings(ctx, String(target.social_account_id));
    // E35/F10: a hub-channel post is never closed by a release. Skipped on purpose it is cancelled (derived 「已取消」); past its
    // lateness limit it goes back to ready and its job's lifecycle reports missed, so 「改到…」 (post_update reschedule) still works.
    if (hub && choice?.action === 'skip') {
      ctx.update(KIND, target.id, { paused_by_switch_id: null });
      cancel(ctx, ctx.get(KIND, target.id), 'skipped_on_pause_release');
      continue;
    }
    // A job that is still live (or already missed) is reported by the lifecycle as is; without one, the ready() below dispatches
    // one in the past window, which the lifecycle reports missed (never a second run: not_after has passed).
    const job = hub ? latestPublishJob(ctx, target) : undefined;
    if (hub && !choice && missed(target) && job && (job.status === 'missed' || !TERMINAL_JOB_STATUSES.includes(job.status as WorkerJobStatus))) {
      ctx.update(KIND, target.id, { plan_status: 'ready', paused_by_switch_id: null });
      ctx.emit('planning.target.resumed', { target_id: target.id, pause_switch_id: row.id });
      continue;
    }
    if (choice?.action === 'skip' || !hub && !choice && missed(target) && (target.late_policy ?? taskFor(ctx, target)?.late_policy) === 'skip') {
      if (taskFor(ctx, target)) requestCancellation(ctx, target);
      closeTarget(ctx, target, 'expired_skipped');
      continue;
    }
    const updated = choice ? updateTarget(ctx, target, choice.action === 'asap' ? { scheduled_at: ctx.now } : select(choice, ['scheduled_at', 'local_scheduled_at', 'schedule_tz', 'tz', 'dst_choice']), true) : target;
    if (updated.plan_status === 'paused') {
      const assessment = assessTarget(ctx, { ...updated, plan_status: 'ready' }, 'execution');
      if (assessment.items.some(item => item.check_key === 'approval_valid' && item.severity === 'blocker')) {
        retireRequest(ctx, updated, 'approval_invalid_after_pause');
        ctx.update(KIND, target.id, { plan_status: 'awaiting_approval', frozen_hash: null, paused_by_switch_id: null, precheck_summary: 'stale' });
        resubmitIfWaiting(ctx, target.id);
      } else ready(ctx, updated);
    } else {
      ctx.update(KIND, updated.id, { paused_by_switch_id: null });
      resubmitIfWaiting(ctx, updated.id);
    }
    ctx.emit('planning.target.resumed', { target_id: target.id, pause_switch_id: row.id });
  }
  // E35: posts scheduled, rescheduled or sent back for approval while the pause held them were never paused (they stayed draft or
  // awaiting approval with no request); submit them again now, in the release transaction.
  const resumed = new Set(targets.map(target => target.id));
  const scope = (target: Row) => ({ workspace: ctx.workspaceId, brand: target.brand_id, campaign: target.campaign_id, social_account: target.social_account_id } as Data)[String(row.scope_type)];
  resubmitWaiting(ctx, target => !resumed.has(target.id) && scope(target) === row.scope_id);
  ctx.emit('planning.pause_switch.released', { pause_switch_id: row.id });
  bumpPausedDevices(ctx, String(row.scope_type), String(row.scope_id), 'pause_released');
  return released;
}

function slotValues(ctx: Context, body: Data) {
  const account = ctx.get('social_account', text(body.social_account_id, 'social_account_id'));
  const tz = text(body.tz ?? account.default_timezone ?? 'UTC', 'tz');
  localMinute(ctx.now, tz);
  return { social_account_id: account.id, weekday: integer(body.weekday, 1, 7, 'weekday'), local_time: minute(body.local_time, 'local_time'), tz, label: body.label == null ? null : text(body.label, 'label') };
}
function ruleValues(ctx: Context, body: Data) {
  const rrule = object(body.rrule);
  const freq = pick(rrule.freq, ['daily', 'weekly'], 'frequency');
  const byday = [...new Set(list(rrule.byday).map(day => integer(day, 1, 7, 'byday')))];
  if (freq === 'weekly' && !byday.length) fail('Weekly rules require at least one weekday');
  const starts_on = date(body.starts_on, 'starts_on');
  const ends_on = body.ends_on == null ? null : date(body.ends_on, 'ends_on');
  if (ends_on && ends_on < starts_on) fail('ends_on precedes starts_on');
  const content_source = select(object(body.content_source), ['social_account_id', 'content_variant_id', 'visibility', 'options', 'connector_mode_pref', 'campaign_id']);
  const account = ctx.get('social_account', text(content_source.social_account_id, 'social_account_id'));
  ctx.get('content_variant', text(content_source.content_variant_id, 'content_variant_id'));
  const tz = text(body.tz ?? account.default_timezone ?? 'UTC', 'tz');
  localMinute(ctx.now, tz);
  return { rrule: { freq, byday, local_time: minute(rrule.local_time, 'local_time') }, tz, starts_on, ends_on, content_source,
    exceptions: list(body.exceptions).map(value => date(value, 'exception')), horizon_days: integer(body.horizon_days ?? 14, 1, 90, 'horizon_days'),
    dst_policy: pick(body.dst_policy ?? 'shift_forward', ['shift_forward', 'skip', 'earlier_occurrence', 'later_occurrence'], 'dst_policy'), paused: body.paused === true };
}
function assertExpansionAllowed(ctx: Context) {
  if (isSafeMode(ctx)) conflict('Restore safe mode pauses schedule expansion', 'job_paused');
  assertLicenseAllowed(ctx, 'new_side_effect');
}

function expandRule(ctx: Context, rule: Row, preview: boolean) {
  if (!preview) assertExpansionAllowed(ctx);
  if (rule.paused || rule.archived_at) return [];
  return recurringDates(ctx, rule).map(({ day, local, choice }) => {
    const existing = ctx.list(KIND).find(row => row.schedule_rule_id === rule.id && row.occurrence_day === day);
    if (existing) {
      if (existing.plan_status !== 'draft' || existing.precheck_summary !== 'blocked' || !(time(existing.scheduled_at) >= time(ctx.now))) {
        return { day, status: 'existing', target_id: existing.id };
      }
      const check = assessTarget(ctx, existing, 'schedule');
      if (preview || check.overall === 'blocked') return { day, status: check.overall, target_id: existing.id, precheck: check };
      const target = submit(ctx, existing, check);
      return { day, status: 'resubmitted', target_id: target.id, target };
    }
    let values: Data;
    try { values = targetValues(ctx, { ...object(rule.content_source), local_scheduled_at: local, schedule_tz: rule.tz, dst_choice: choice }); }
    catch (error) {
      if (!(error instanceof Problem)) throw error;
      return { day, status: 'error', error: { code: error.code, message: error.message } };
    }
    const assessment = assessTarget(ctx, values, 'schedule');
    if (preview) return { day, status: assessment.overall, values, precheck: assessment };
    const target = createTarget(ctx, values, { origin: 'recurring', schedule_rule_id: rule.id, occurrence_day: day });
    return { day, status: 'created', target: submit(ctx, target) };
  });
}
function queueValues(ctx: Context, body: Data) {
  const accounts = [...new Set(list(body.social_account_ids).map(id => ctx.get('social_account', text(id, 'social_account_id')).id))];
  const slots = entries(body.slots).map(slot => slotValues(ctx, slot));
  if (!accounts.length || !slots.length || slots.some(slot => !accounts.includes(slot.social_account_id))) fail('Queue slots must match selected accounts');
  return { category: text(body.category, 'category'), social_account_ids: accounts, slots, paused: body.paused === true,
    min_interval_days: integer(body.min_interval_days ?? 7, 1, 365, 'min_interval_days'), max_uses: integer(body.max_uses ?? 3, 1, 1000, 'max_uses'),
    horizon_days: integer(body.horizon_days ?? 14, 1, 90, 'horizon_days'), expires_at: body.expires_at == null ? null : instant(body.expires_at, 'expires_at') };
}
function addQueueItem(ctx: Context, queue: Row, body: Data) {
  const content = ctx.get('content_item', text(body.content_item_id, 'content_item_id'));
  const variant_map = object(body.variant_map);
  if (!Object.keys(variant_map).length) fail('Supply at least one account variant');
  for (const [accountId, variantId] of Object.entries(variant_map)) {
    if (!list(queue.social_account_ids).includes(accountId)) fail('Account is outside this queue');
    const variant = ctx.get('content_variant', text(variantId, 'variant_id'));
    if (variant.content_item_id !== content.id) fail('Variant belongs to another content item');
  }
  if (ctx.list('evergreen_queue_item').some(row => row.queue_id === queue.id && row.content_item_id === content.id && row.status === 'active')) conflict('Content is already in this queue');
  ctx.update('evergreen_queue', queue.id, { items_changed_at: ctx.now });
  return ctx.create('evergreen_queue_item', { queue_id: queue.id, content_item_id: content.id, variant_map, use_count: 0, status: 'active', expires_at: body.expires_at == null ? null : instant(body.expires_at, 'expires_at') });
}
function expandQueue(ctx: Context, queue: Row, preview: boolean) {
  if (!preview) assertExpansionAllowed(ctx);
  if (queue.paused || queue.archived_at || queue.expires_at && time(queue.expires_at) <= time(ctx.now)) return [];
  const candidates = ctx.list('evergreen_queue_item').filter(row => row.queue_id === queue.id && row.status === 'active' && (!row.expires_at || time(row.expires_at) > time(ctx.now)));
  const simulated = new Map(candidates.map(row => [row.id, { count: Number(row.use_count), last: time(row.last_used_at) }]));
  return queueSlots(ctx, queue).map(slot => {
    const existing = ctx.list(KIND).find(row => row.evergreen_queue_id === queue.id && row.social_account_id === slot.social_account_id && row.scheduled_at === slot.at);
    if (existing) return { ...slot, status: 'existing', target_id: existing.id, revision_id: existing.variant_revision_id };
    for (const item of [...candidates].sort((a, b) => (simulated.get(a.id)!.last || 0) - (simulated.get(b.id)!.last || 0) || a.id.localeCompare(b.id))) {
      const usage = simulated.get(item.id)!;
      const variant = locate(ctx, 'content_variant', object(item.variant_map)[slot.social_account_id]);
      const content = locate(ctx, 'content_item', item.content_item_id);
      if (!variant?.current_revision_id || variant.archived_at || !content || content.archived_at || content.production_stage === 'archived' || usage.count >= Number(queue.max_uses) || time(slot.at) - usage.last < Number(queue.min_interval_days) * DAY || (item.expires_at && time(slot.at) >= time(item.expires_at))) continue;
      let values: Data;
      try { values = targetValues(ctx, { social_account_id: slot.social_account_id, content_variant_id: variant.id, scheduled_at: slot.at, schedule_tz: slot.tz }); }
      catch (error) { if (error instanceof Problem) continue; throw error; }
      const assessment = assessTarget(ctx, values, 'schedule');
      if (assessment.overall === 'blocked') continue;
      usage.count++;
      usage.last = time(slot.at);
      if (preview) return { ...slot, item_id: item.id, status: assessment.overall, revision_id: values.variant_revision_id, precheck: assessment.items };
      const target = submit(ctx, createTarget(ctx, values, { origin: 'evergreen', evergreen_queue_id: queue.id, evergreen_queue_item_id: item.id }));
      ctx.update('evergreen_queue_item', item.id, { last_used_at: slot.at, use_count: usage.count, status: usage.count >= Number(queue.max_uses) ? 'exhausted' : 'active' });
      return { ...slot, item_id: item.id, status: 'created', target };
    }
    return { ...slot, status: 'no_eligible_content' };
  });
}
function candidatesFor(ctx: Context, post: Row) {
  if (post.origin !== 'native' || post.publish_target_id || !['system_verified', 'manual_confirmed'].includes(String(post.verification))) return [];
  return scoreMatches(ctx, post, post.published_at);
}

function scoreMatches(ctx: Context, post: Data, at: unknown) {
  const caption = String(post.caption ?? post.text ?? '');
  return ctx.list(KIND).filter(row => row.social_account_id === post.social_account_id && ![...FINAL, 'cancel_requested'].includes(String(row.plan_status)) && Math.abs(time(row.scheduled_at) - time(at)) <= 6 * 3_600_000 && !hasExecutionRisk(ctx, row)).map(row => {
    const revision = locate(ctx, 'content_revision', row.variant_revision_id);
    const delta = Math.abs(time(row.scheduled_at) - time(at));
    const link = entries(revision?.link_refs).some(item => {
      const short = locate(ctx, 'short_link', item.short_link_id);
      const url = short?.short_url ?? item.url;
      return typeof url === 'string' && (short || url.includes('utm_')) && caption.includes(url);
    });
    const caption_match = similarity(caption, String(object(revision?.rendered).text ?? '')) >= 0.6;
    const media_match = Array.isArray(post.media) && list(post.media).length === list(revision?.media).length && post.content_format === row.content_format;
    const close_in_time = delta <= 30 * 60_000;
    const score = (Number(link) * 5 + Number(caption_match) * 3 + Number(media_match) + Number(close_in_time)) / 10;
    return { publish_target_id: row.id, platform_post_id: post.id, score, signals: { link, caption_match, media_match, close_in_time } };
  }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score || a.publish_target_id.localeCompare(b.publish_target_id));
}
async function reconcilePlatformSchedule(ctx: Context, id: string, cursor: string | undefined) {
  const { entries, next_cursor } = await readPlatformSchedule(ctx, id, cursor);
  return {
    next_cursor,
    entries: entries.map(entry => {
      const matches = scoreMatches(ctx, entry, entry.platform_scheduled_at);
      const confident = matches.filter(match => match.score >= 0.9);
      return {
        ...entry,
        status: 'scheduled_on_platform',
        match_status: confident.length === 1 ? 'suggested' : !matches.length ? 'unmatched' : 'uncertain',
        candidates: matches.map(({ publish_target_id, score, signals }) => ({ publish_target_id, score, signals,
          highlighted: confident.length === 1 && confident[0].publish_target_id === publish_target_id })),
      };
    }),
  };
}
function suggestPostMatches(ctx: Context, post: Row) {
  const matches = candidatesFor(ctx, post);
  return matches.map((match, index) => {
    const existing = ctx.list('reconciliation_candidate').find(row => row.platform_post_id === post.id && row.publish_target_id === match.publish_target_id);
    const highlighted = index === 0 && match.score >= 0.9 && (matches[1]?.score ?? 0) < 0.9;
    if (!existing) return ctx.create('reconciliation_candidate', { ...match, highlighted, status: 'suggested' });
    if (existing.status === 'suggested' && (existing.score !== match.score || existing.highlighted !== highlighted || digest(existing.signals) !== digest(match.signals))) {
      return ctx.update('reconciliation_candidate', existing.id, { ...match, highlighted });
    }
    return existing;
  });
}

function reviewRound(ctx: Context, body: Data) {
  const targets = [...new Set(list(body.target_ids))].map(id => ctx.get(KIND, text(id, 'target_id')));
  if (!targets.length || targets.length > 100 || targets.some(target => FINAL.includes(String(target.plan_status)))) fail('Select active review targets');
  const shares = [...new Set(list(body.share_ids ?? (body.share_id ? [body.share_id] : [])))].map(id => ctx.get('share', text(id, 'share_id')));
  if (shares.length !== targets.length || targets.some(target => !shares.some(share => share.resource_type === 'publish_target' &&
    share.resource_id === target.id && share.revision_id === target.variant_revision_id && share.audience === 'client' &&
    share.status === 'active' && time(share.expires_at) > time(ctx.now) && list(share.permissions).includes('view')))) {
    fail('Each target requires an active client share for its selected revision');
  }
  const due_at = instant(body.due_at, 'due_at');
  if (time(due_at) <= time(ctx.now) || shares.some(share => time(share.expires_at) < time(due_at))) fail('Review deadline must be in the future and within share lifetime');
  const round = ctx.create('review_round', { target_ids: targets.map(row => row.id), revision_ids: targets.map(row => row.variant_revision_id), share_ids: shares.map(row => row.id), status: 'open', due_at, reminders: [], created_by: ctx.actorId });
  ctx.emit('planning.review_round.created', { review_round_id: round.id, target_ids: round.target_ids });
  return round;
}
function roundSummary(ctx: Context, round: Row) {
  const targetIds = list(round.target_ids), revisionIds = list(round.revision_ids);
  const stale = targetIds.some((id, index) => {
    const target = locate(ctx, KIND, id);
    return !target || target.variant_revision_id !== revisionIds[index] || locate(ctx, 'content_variant', target.content_variant_id)?.current_revision_id !== revisionIds[index];
  });
  const closed = list(round.share_ids).some(id => {
    const share = locate(ctx, 'share', id);
    return !share || share.status !== 'active' || time(share.expires_at) <= time(ctx.now);
  });
  return { ...round, status: stale ? 'version_updated' : closed || time(round.due_at) <= time(ctx.now) ? 'expired' : round.status };
}

// The channel settings module applies approval-mode changes with these (phase1-design §4.1); see registerPlanningHooks.
registerPlanningHooks({ submit, retireRequest, resubmitWaiting });

export function planningAcceptsEvent(type: string) {
  return /^(commerce\.(listing\.changed|promotion\.(changed|expired)|fact\.retracted)$|asset\.rights_grant\.(expired|revoked|activated|revised)$|account\.(capability|connection|binding|social_account|device|mobile_device|mobile_app_binding|connector_auto_policy)\.|ops\.connector_auto\.|execution\.platform_post\.observed$|content\.revision\.created$|core\.approval_request\.invalidated$)/.test(type);
}

function targetAffected(ctx: Context, target: Row, type: string, data: Data, refs: Row[]) {
  const revision = locate(ctx, 'content_revision', target.variant_revision_id);
  const variant = locate(ctx, 'content_variant', target.content_variant_id);
  const products = entries(revision?.product_refs);
  if (type === 'commerce.listing.changed') {
    return products.some(product => {
      if ((product.variant_id ?? product.product_variant_id) !== (data.variant_id ?? data.product_variant_id)) return false;
      const baseline = locate(ctx, 'listing_snapshot', product.listing_snapshot_id);
      const market = product.market_id ?? baseline?.market_id ?? variant?.market_id;
      return (!data.market_id || !market || data.market_id === market) && (!data.channel || !baseline?.channel || data.channel === baseline.channel);
    });
  }
  if (type.startsWith('commerce.promotion.')) return list(target.promotion_ids).includes(data.promotion_id) || products.some(ref => ref.promotion_id === data.promotion_id);
  if (type === 'commerce.fact.retracted') return products.some(ref => ref.fact_revision_id === (data.fact_revision_id ?? data.revision_id));
  if (type.startsWith('asset.')) {
    const grantId = data.rights_grant_id ?? data.grant_id;
    if (!grantId || type.endsWith('.revised') && !['active', 'approved'].includes(String(data.status))) return false;
    if (refs.some(ref => ref.ref_type === 'rights_grant' && ref.ref_id === grantId)) return true;
    const assets = ctx.list('rights_grant_asset').filter(binding => binding.rights_grant_id === grantId);
    return assets.some(binding => refs.some(ref => ref.ref_type === 'asset' && ref.ref_id === binding.asset_id));
  }
  const account = locate(ctx, 'social_account', target.social_account_id);
  const binding = ctx.list('account_execution_binding').find(row => row.social_account_id === target.social_account_id);
  const phone = locate(ctx, 'mobile_device', binding?.mobile_device_id);
  if (data.social_account_id) return data.social_account_id === target.social_account_id;
  if (Array.isArray(data.social_account_ids) && data.social_account_ids.length) return data.social_account_ids.includes(target.social_account_id);
  if (data.mobile_device_id) return data.mobile_device_id === binding?.mobile_device_id;
  if (data.mobile_app_binding_id) return data.mobile_app_binding_id === binding?.mobile_app_binding_id;
  if (data.binding_id) {
    const app = locate(ctx, 'mobile_app_binding', data.binding_id);
    return app ? app.social_account_id === target.social_account_id : data.binding_id === binding?.id || data.binding_id === binding?.mobile_app_binding_id;
  }
  if (data.device_id) return data.device_id === (binding?.connector_device_id ?? binding?.device_id ?? phone?.device_id);
  if (data.connection_id) return data.connection_id === (account?.primary_connection_id ?? account?.connection_id);
  if (type.startsWith('ops.connector_auto.')) return data.scope_value == null || data.scope_value === 'all' || data.scope_value === ctx.workspaceId;
  return type.startsWith('account.connector_auto_policy.');
}

export function applyPlanningEvent(ctx: Context, envelope: Data) {
  const type = String(envelope.type ?? '');
  if (!planningAcceptsEvent(type)) return;
  const data = object(envelope.payload ?? envelope.data ?? envelope);
  if (type === 'core.approval_request.invalidated') {
    const request = locate(ctx, 'approval_request', data.request_id);
    const target = locate(ctx, KIND, request?.resource_id);
    if (request?.resource_type === RESOURCE && request.status === 'invalidated' && target?.approval_request_id === request.id &&
      ['ready', 'paused', 'awaiting_approval'].includes(String(target.plan_status)) && !hasExecutionRisk(ctx, target)) {
      blockUnsent(ctx, target, 'approval_invalid');
      if (target.plan_status !== 'awaiting_approval' || target.frozen_hash != null) {
        ctx.update(KIND, target.id, { plan_status: 'awaiting_approval', frozen_hash: null, precheck_summary: 'stale', paused_by_switch_id: null, approval_invalidated_reason: request.invalidated_reason ?? 'approval_invalid' });
      }
      resubmitIfWaiting(ctx, target.id);
    }
    return;
  }
  if (type === 'execution.platform_post.observed') {
    const post = locate(ctx, 'platform_post', data.platform_post_id);
    if (post) suggestPostMatches(ctx, post);
    return;
  }
  if (type === 'content.revision.created') {
    for (const target of ctx.list(KIND).filter(row => row.content_variant_id === data.variant_id)) refreshEvergreenTarget(ctx, target);
    return;
  }
  const refs = ctx.list('publish_target_ref');
  for (const target of ctx.list(KIND)) {
    if (!['ready', 'awaiting_approval', 'paused'].includes(String(target.plan_status)) || hasExecutionRisk(ctx, target)) continue;
    if (!targetAffected(ctx, target, type, data, refs.filter(ref => ref.publish_target_id === target.id))) continue;
    const previousCheck = locate(ctx, 'precheck_run', target.last_precheck_run_id);
    const stage = target.plan_status === 'awaiting_approval' ? 'approval' : 'preflight';
    const assessment = assessTarget(ctx, target, stage);
    const request = locate(ctx, 'approval_request', target.approval_request_id);
    const bindingChanged = !!target.frozen_hash && assessment.hash !== target.frozen_hash;
    const priceClaimChanged = type === 'commerce.listing.changed' && assessment.items.some(item => item.check_key === 'product_fact' && item.severity === 'blocker' && item.detail.old_snapshot_id);
    if (request && (bindingChanged || priceClaimChanged)) {
      const reason = priceClaimChanged ? 'product_price_claim_changed' : 'publishing_inputs_changed';
      retireRequest(ctx, target, reason);
      ctx.update(KIND, target.id, { plan_status: 'awaiting_approval', paused_by_switch_id: null, frozen_hash: null, approval_invalidated_reason: reason });
    }
    const current = ctx.get(KIND, target.id);
    recordCheck(ctx, current, stage, assessment);
    if (assessment.overall === 'blocked' && current.plan_status === 'ready') blockUnsent(ctx, current, 'precheck_blocked');
    if (request && (bindingChanged || priceClaimChanged)) resubmitIfWaiting(ctx, target.id);
    if (previousCheck?.effective_mode === 'auto' && assessment.effective_mode === 'assist' && time(target.scheduled_at) >= time(ctx.now) && time(target.scheduled_at) <= time(ctx.now) + DAY) {
      ctx.emit('planning.target.connector_downgraded', { target_id: target.id, recipient_user_id: target.owner_user_id, scheduled_at: target.scheduled_at });
    }
    if (type === 'commerce.listing.changed') {
      const issues = assessment.items.filter(item => ['product_fact', 'listing_availability'].includes(item.check_key) && item.severity !== 'info');
      if (issues.length) ctx.emit('planning.target.commerce_impact', { target_id: target.id, recipient_user_id: target.owner_user_id, issues });
    }
  }
}

function refreshEvergreenTarget(ctx: Context, target: Row) {
  if (target.origin !== 'evergreen' || FINAL.includes(String(target.plan_status)) || target.plan_status === 'cancel_requested' || hasExecutionRisk(ctx, target) || taskFor(ctx, target)?.restore_hold) return;
  if (Math.max(time(ctx.now), time(target.scheduled_at)) >= evergreenExpiry(ctx, target)) {
    retireRequest(ctx, target, 'evergreen_expired', 'expired');
    if (taskFor(ctx, target)) requestCancellation(ctx, target);
    closeTarget(ctx, target, 'expired_skipped');
    return;
  }
  if (!['ready', 'paused', 'awaiting_approval'].includes(String(target.plan_status)) || !(time(target.scheduled_at) > time(ctx.now))) return;
  const variant = locate(ctx, 'content_variant', target.content_variant_id);
  const current = locate(ctx, 'content_revision', variant?.current_revision_id);
  if (!current || current.id === target.variant_revision_id || current.variant_id !== variant?.id) return;
  const previous = locate(ctx, 'content_revision', target.variant_revision_id);
  if (current.content_hash === previous?.content_hash) return;
  const next = { ...target, variant_revision_id: current.id };
  const check = assessTarget(ctx, next, 'schedule');
  retireRequest(ctx, target, 'content_revision_changed');
  blockUnsent(ctx, target, 'approval_invalid');
  if (check.overall === 'blocked') {
    if (target.approval_invalidated_reason !== 'content_revision_changed' || target.precheck_summary !== 'blocked') {
      const waiting = ctx.update(KIND, target.id, { plan_status: 'awaiting_approval', frozen_hash: null, approval_invalidated_reason: 'content_revision_changed' });
      recordCheck(ctx, waiting, 'schedule', check);
    }
    return;
  }
  const updated = ctx.update(KIND, target.id, {
    variant_revision_id: current.id, plan_status: 'awaiting_approval', frozen_hash: null,
    approval_invalidated_reason: 'content_revision_changed',
  });
  submit(ctx, updated, check);
}

export function scanPlanningDue(ctx: Context) {
  const refresh = ctx.list('precheck_run');
  for (const planned of ctx.list(KIND)) {
    refreshEvergreenTarget(ctx, planned);
    const target = ctx.get(KIND, planned.id);
    const request = locate(ctx, 'approval_request', target.approval_request_id);
    if (target.plan_status === 'awaiting_approval' && request?.status === 'pending') {
      if (time(request.due_at) <= time(ctx.now)) {
        retireRequest(ctx, target, 'deadline_elapsed', 'expired');
        // E34: a hub request written before E34 could expire (now + 48 h) while the post can still go out. The §4 common rule
        // gives it a fresh pending request until scheduled_at + lateness; past that it derives as missed (not_approved).
        resubmitIfWaiting(ctx, target.id);
      } else if (time(request.due_at) - time(ctx.now) <= DAY && request.reminded_step !== request.current_step) {
        ctx.update('approval_request', request.id, { reminded_step: request.current_step, reminded_at: ctx.now });
        const step = entries(request.steps)[Number(request.current_step) - 1];
        ctx.emit('planning.approval.reminder_requested', { request_id: request.id, target_id: target.id, recipient_user_ids: list(object(step?.approvers).user_ids) });
      }
    }
    if (target.plan_status !== 'ready' || !(time(target.scheduled_at) >= time(ctx.now) && time(target.scheduled_at) <= time(ctx.now) + 3_600_000)) continue;
    if (target.precheck_summary !== 'stale' && refresh.some(row => row.publish_target_id === target.id && row.stage === 'preflight' && time(row.valid_until) > time(ctx.now) && row.id === target.last_precheck_run_id)) continue;
    if (hasExecutionRisk(ctx, target)) continue;
    const assessment = assessTarget(ctx, target, 'preflight');
    recordCheck(ctx, target, 'preflight', assessment);
    if (assessment.overall === 'blocked') {
      blockUnsent(ctx, target, assessment.items.some(item => item.check_key === 'approval_valid' && item.severity === 'blocker') ? 'approval_invalid' : 'precheck_blocked');
      continue;
    }
    // Hub channels get their "click Post" reminders from the owner alerts module (phase1-design §4.5, §5.9).
    if (assessment.effective_mode === 'assist' && !target.assist_reminder_at && !channelSettings(ctx, String(target.social_account_id))) {
      ctx.update(KIND, target.id, { assist_reminder_at: ctx.now });
      ctx.emit('planning.target.assist_reminder', { target_id: target.id, recipient_user_id: target.owner_user_id, scheduled_at: target.scheduled_at, mobile: assessment.items.some(item => item.check_key.startsWith('mobile_')) });
    }
  }
  for (const item of ctx.list('evergreen_queue_item')) {
    if (item.status !== 'active') continue;
    const queue = locate(ctx, 'evergreen_queue', item.queue_id);
    const content = locate(ctx, 'content_item', item.content_item_id);
    if (time(item.expires_at) <= time(ctx.now) || time(queue?.expires_at) <= time(ctx.now) || content?.archived_at || content?.production_stage === 'archived') {
      ctx.update('evergreen_queue_item', item.id, { status: 'expired' });
    }
  }
  expandPlanningDue(ctx);
}

function expandPlanningDue(ctx: Context) {
  if (isSafeMode(ctx) || ['read_only', 'terminated'].includes(getLicenseState(ctx))) return;
  const jobs = [
    { kind: 'schedule_rule', expand: expandRule },
    { kind: 'evergreen_queue', expand: expandQueue },
  ] as const;
  for (const { kind, expand } of jobs) {
    for (const row of ctx.list(kind)) {
      if (row.paused || row.archived_at || time(row.expires_at) <= time(ctx.now)) continue;
      const day = ctx.now.slice(0, 10);
      const marker = ctx.list('planning_expansion_cursor').find(cursor => cursor.resource_type === kind && cursor.resource_id === row.id);
      if (marker?.day === day && marker.resource_version === row.version) continue;
      expand(ctx, row, false);
      const values = { day, resource_type: kind, resource_id: row.id, resource_version: row.version };
      if (marker) ctx.update('planning_expansion_cursor', marker.id, values);
      else ctx.create('planning_expansion_cursor', values);
    }
  }
}

function op(method: Operation['method'], path: string, name: string, roles: Operation['roles'], run: Operation['run'], versionKind?: string): Operation & { mcp?: boolean } {
  const humanOnly = roles === HUMAN_WRITE || roles === POLICY_ADMIN || roles === APPROVE && method !== 'GET';
  return {
    method, path, name, roles, summary: name.replaceAll('_', ' '), ...(versionKind ? { versionKind } : {}),
    ...(humanOnly ? { mcp: false } : {}),
    run(ctx, input) {
      if (humanOnly && fromAgent(ctx)) throw new Problem(403, 'PERMISSION_DENIED', 'Only a person can perform this action');
      return run(ctx, input);
    },
  };
}

export const operations: Operation[] = [
  op('GET', '/calendar', 'publishing_get_calendar', READ, (ctx, input) => calendar(ctx, input.query)),
  op('GET', TARGETS, 'publishing_list_targets', READ, (ctx, input) => listTargets(ctx, input.query)),
  op('GET', `${TARGETS}/:id`, 'publishing_get_target', READ, (ctx, input) => detail(ctx, ctx.get(KIND, input.params.id))),
  op('POST', TARGETS, 'publishing_create_target', WRITE, (ctx, input) => createTarget(ctx, targetValues(ctx, input.body), { origin: fromAgent(ctx) ? 'agent' : 'manual' })),
  op('PATCH', `${TARGETS}/:id`, 'publishing_update_target', WRITE, (ctx, input) => withResubmit(ctx, updateTarget(ctx, expect(ctx, input), input.body)), KIND),
  op('POST', `${TARGETS}/:id/submit`, 'publishing_request_approval', WRITE, (ctx, input) => {
    const row = ctx.get(KIND, input.params.id);
    if (input.expectedVersion !== undefined) assertVersion(row, input.expectedVersion);
    return submit(ctx, row);
  }),
  op('POST', `${TARGETS}/:id/precheck`, 'publishing_run_precheck', READ, (ctx, input) => recordCheck(ctx, ctx.get(KIND, input.params.id), pick(input.body.stage ?? 'preflight', ['schedule', 'approval', 'preflight', 'execution'], 'stage'))),
  op('POST', `${TARGETS}/:id/reschedule`, 'publishing_reschedule', WRITE, (ctx, input) => {
    const target = expect(ctx, input);
    const body = select(input.body, ['scheduled_at', 'local_scheduled_at', 'schedule_tz', 'tz', 'schedule_kind', 'dst_choice']);
    if (!Object.keys(body).length) fail('Provide a schedule change');
    return withResubmit(ctx, updateTarget(ctx, target, body, true));
  }, KIND),
  { ...op('POST', `${TARGETS}/:id/cancel`, 'publishing_cancel', WRITE, (ctx, input) => cancel(ctx, expect(ctx, input), input.body.reason), KIND), accepted: acceptsVerification },
  ...(['approve', 'reject', 'request-changes'] as const).map(decision => op('POST', `${TARGETS}/:id/${decision}`, `publishing_${decision.replace('-', '_')}`, APPROVE, (ctx, input) => {
    const row = ctx.get(KIND, input.params.id);
    if (input.expectedVersion !== undefined) assertVersion(row, input.expectedVersion);
    return decide(ctx, row, decision === 'request-changes' ? 'request_changes' : decision, input.body);
  }, KIND)),
  op('POST', `${TARGETS}/:id/register-post`, 'publishing_register_post', HUMAN_WRITE, (ctx, input) => registerManualPost(ctx, ctx.get(KIND, input.params.id), input.body)),
  op('GET', '/approvals', 'publishing_list_approvals', READ, (ctx, input) => {
    const view = pick(input.query.view ?? 'pending', ['pending', 'submitted', 'expired'], 'approval view');
    return ctx.list('approval_request').filter(row => {
      if (row.resource_type !== RESOURCE) return false;
      const submitted = object(row.context).submitted_by === (agentCredential(ctx) ?? ctx.actorId);
      if (view === 'submitted') return submitted;
      if (view === 'expired') return (submitted || APPROVE.includes(ctx.role) && !fromAgent(ctx)) &&
        (row.status === 'expired' || row.status === 'invalidated' || row.status === 'pending' && time(row.due_at) <= time(ctx.now));
      return pendingForActor(ctx, row, locate(ctx, KIND, row.resource_id));
    });
  }),
  op('POST', '/approvals/batch', 'publishing_batch_approve', APPROVE, (ctx, input) => {
    validatePlanItems(input.body.items);
    const rows = entries(input.body.items);
    if (!rows.length || rows.length > 250 || new Set(rows.map(item => item.target_id)).size !== rows.length) fail('Supply between 1 and 250 distinct target approvals');
    return rows.map(item => {
      try {
        const target = ctx.get(KIND, text(item.target_id, 'target_id'));
        if (item.expected_version !== undefined) assertVersion(target, integer(item.expected_version, 1, Number.MAX_SAFE_INTEGER, 'expected_version'));
        return decide(ctx, target, pick(item.decision ?? 'approve', ['approve', 'reject', 'request_changes'], 'decision'), { ...item, resource_hash: text(item.resource_hash, 'resource_hash') });
      } catch (error) { if (!(error instanceof Problem)) throw error; return { target_id: item.target_id, error: { code: error.code, message: error.message } }; }
    });
  }),
  op('GET', '/approval-policies', 'publishing_list_approval_policies', POLICY_ADMIN, ctx => ctx.list('approval_policy').filter(row => row.resource_type === RESOURCE)),
  op('POST', '/approval-policies', 'publishing_create_approval_policy', POLICY_ADMIN, (ctx, input) => {
    const policy = ctx.create('approval_policy', policyValues(input.body));
    checkPolicyImpact(ctx);
    return policy;
  }),
  op('PATCH', '/approval-policies/:id', 'publishing_update_approval_policy', POLICY_ADMIN, (ctx, input) => {
    const row = expect(ctx, input, 'approval_policy');
    if (row.resource_type !== RESOURCE) throw new Problem(404, 'NOT_FOUND', 'Publishing policy not found');
    const updated = ctx.update('approval_policy', row.id, policyValues(input.body, row));
    checkPolicyImpact(ctx);
    return updated;
  }, 'approval_policy'),
  op('POST', '/publish-plans', 'publishing_create_plan', WRITE, (ctx, input) => makePlan(ctx, input.body)),
  op('PATCH', '/publish-plans/:id', 'publishing_update_plan', WRITE, (ctx, input) => {
    const plan = expect(ctx, input, 'publish_plan');
    const body = select(input.body, ['items', 'title', 'commit_mode']);
    if (body.items !== undefined) validatePlanItems(body.items);
    if (body.commit_mode !== undefined) pick(body.commit_mode, ['partial', 'all_or_nothing'], 'commit_mode');
    return ctx.update('publish_plan', plan.id, { ...body, status: 'draft', operation_id: null, preview: null });
  }, 'publish_plan'),
  op('POST', '/publish-plans/preview', 'publishing_preview_plan_items', READ, (ctx, input) => {
    validatePlanItems(input.body.items);
    return previewPlan(ctx, select(input.body, ['items', 'campaign_id']));
  }),
  op('POST', '/publish-plans/:id/preview', 'publishing_preview_plan', READ, (ctx, input) => previewPlan(ctx, ctx.get('publish_plan', input.params.id))),
  { ...op('POST', '/publish-plans/:id/commit', 'publishing_schedule', WRITE, (ctx, input) => commitPlan(ctx, ctx.get('publish_plan', input.params.id), input.body.preview_hash)), accepted: true },
  op('GET', '/publish-plans/:id', 'publishing_get_plan', READ, (ctx, input) => {
    const plan = ctx.get('publish_plan', input.params.id);
    return { ...plan, results: ctx.list('operation_item').filter(row => row.operation_id === plan.operation_id) };
  }),
  op('GET', '/pause-switches', 'publishing_list_pauses', READ, ctx => ctx.list('pause_switch')),
  op('GET', '/pause-switches/:id', 'publishing_get_pause', READ, (ctx, input) => {
    const row = ctx.get('pause_switch', input.params.id);
    return { ...row, platform_withdrawals: pauseWithdrawals(ctx, row.id) };
  }),
  op('POST', '/pause-switches', 'publishing_pause', WRITE, (ctx, input) => activatePause(ctx, input.body)),
  op('POST', '/pause-switches/:id/release', 'publishing_release_pause', POLICY_ADMIN, (ctx, input) => {
    const row = ctx.get('pause_switch', input.params.id);
    if (input.expectedVersion !== undefined) assertVersion(row, input.expectedVersion);
    return releasePause(ctx, row, input.body);
  }),
  ...([
    ['slot_template', '/slot-templates', slotValues],
    ['schedule_rule', '/schedule-rules', ruleValues],
    ['evergreen_queue', '/evergreen-queues', queueValues],
  ] as const).flatMap(([kind, path, values]) => [
    op('GET', path, `publishing_list_${kind}s`, READ, ctx => ctx.list(kind)),
    op('GET', `${path}/:id`, `publishing_get_${kind}`, READ, (ctx, input) => ctx.get(kind, input.params.id)),
    op('POST', path, `publishing_create_${kind}`, HUMAN_WRITE, (ctx, input) => ctx.create(kind, values(ctx, input.body))),
    op('PATCH', `${path}/:id`, `publishing_update_${kind}`, HUMAN_WRITE, (ctx, input) => {
      const previous = expect(ctx, input, kind);
      return ctx.update(kind, previous.id, values(ctx, { ...previous, ...input.body }));
    }, kind),
    op('DELETE', `${path}/:id`, `publishing_archive_${kind}`, HUMAN_WRITE, (ctx, input) => {
      const previous = expect(ctx, input, kind);
      if (kind === 'slot_template') { ctx.remove(kind, previous.id); return { id: previous.id, deleted: true }; }
      return ctx.update(kind, previous.id, { paused: true, archived_at: ctx.now });
    }, kind),
  ]),
  op('POST', '/schedule-rules/:id/expand', 'publishing_expand_recurring', HUMAN_WRITE, (ctx, input) => expandRule(ctx, ctx.get('schedule_rule', input.params.id), input.body.dry_run === true)),
  op('POST', '/evergreen-queues/:id/items', 'publishing_add_evergreen_item', HUMAN_WRITE, (ctx, input) => addQueueItem(ctx, ctx.get('evergreen_queue', input.params.id), input.body)),
  op('GET', '/evergreen-queues/:id/items', 'publishing_list_evergreen_items', READ, (ctx, input) => ctx.list('evergreen_queue_item').filter(row => row.queue_id === input.params.id)),
  op('POST', '/evergreen-queues/:id/expand', 'publishing_expand_evergreen', HUMAN_WRITE, (ctx, input) => expandQueue(ctx, ctx.get('evergreen_queue', input.params.id), input.body.dry_run === true)),
  op('POST', '/review-rounds', 'publishing_create_review_round', HUMAN_WRITE, (ctx, input) => reviewRound(ctx, input.body)),
  op('GET', '/review-rounds', 'publishing_list_review_rounds', READ, ctx => ctx.list('review_round').map(row => roundSummary(ctx, row))),
  op('GET', '/review-rounds/:id', 'publishing_get_review_round', READ, (ctx, input) => roundSummary(ctx, ctx.get('review_round', input.params.id))),
  op('POST', '/review-rounds/:id/remind', 'publishing_remind_review_round', HUMAN_WRITE, (ctx, input) => {
    const round = ctx.get('review_round', input.params.id);
    if (roundSummary(ctx, round).status !== 'open') return conflict('Review is no longer open');
    const reminders = list(round.reminders);
    if (reminders.some(at => time(ctx.now) - time(at) < 86_400_000)) return round;
    ctx.emit('planning.review_round.reminder_requested', { review_round_id: round.id });
    return ctx.update('review_round', round.id, { reminders: [...reminders, ctx.now] });
  }),
  { ...op('GET', '/reconciliation/platform-schedules/:id', platformScheduleOperation, HUMAN_WRITE,
    (ctx, input) => reconcilePlatformSchedule(ctx, input.params.id, input.query.provider_cursor)),
    summary: 'Read Facebook Page schedules and compare them to local plans without linking them' },
  op('GET', '/reconciliation/candidates', 'publishing_list_post_matches', READ, (ctx, input) => input.query.platform_post_id ? candidatesFor(ctx, ctx.get('platform_post', input.query.platform_post_id)) : ctx.list('reconciliation_candidate')),
  op('GET', '/reconciliation/suggestions/:id', 'publishing_suggest_post_match', READ, (ctx, input) => candidatesFor(ctx, ctx.get('platform_post', input.params.id))),
  op('POST', '/reconciliation/candidates', 'publishing_generate_post_candidates', HUMAN_WRITE, (ctx, input) => {
    const post = ctx.get('platform_post', text(input.body.platform_post_id, 'platform_post_id'));
    return suggestPostMatches(ctx, post);
  }),
  ...(['confirm', 'reject'] as const).map(action => op('POST', `/reconciliation/candidates/:id/${action}`, `publishing_${action}_post_match`, HUMAN_WRITE, (ctx, input) => {
    const candidate = ctx.get('reconciliation_candidate', input.params.id);
    if (candidate.status !== 'suggested') return conflict('Candidate is already decided');
    if (action === 'confirm') {
      const post = ctx.get('platform_post', String(candidate.platform_post_id));
      const target = ctx.get(KIND, String(candidate.publish_target_id));
      if (!candidatesFor(ctx, post).some(match => match.publish_target_id === target.id)) return conflict('Candidate no longer matches');
      const task = taskFor(ctx, target);
      if (task) {
        const cancelled = requestCancellation(ctx, target);
        if (cancelled?.status !== 'cancelled') return conflict('The target execution could not be safely stopped');
      }
      retireRequest(ctx, target, 'matched_native', 'cancelled');
      // A matched native post inherits the target's brand, campaign and content so dashboards can attribute it.
      ctx.update('platform_post', post.id, { publish_target_id: target.id, ...postAttribution(ctx.get('social_account', String(post.social_account_id)), target) });
      closeTarget(ctx, target, 'matched_native');
      ctx.emit('planning.target.matched_post', { target_id: target.id, platform_post_id: post.id });
      for (const other of ctx.list('reconciliation_candidate')) {
        if (other.id !== candidate.id && other.status === 'suggested' && (other.platform_post_id === post.id || other.publish_target_id === target.id)) {
          ctx.update('reconciliation_candidate', other.id, { status: 'superseded', highlighted: false });
        }
      }
    }
    return ctx.update('reconciliation_candidate', candidate.id, { status: action === 'confirm' ? 'confirmed' : 'rejected', decided_by: ctx.actorId, decided_at: ctx.now });
  })),
  op('GET', '/evergreen-queues/:id/suggestions', 'publishing_suggest_evergreen_order', READ, (ctx, input) => {
    const queue = ctx.get('evergreen_queue', input.params.id);
    if (queue.expires_at != null && time(queue.expires_at) <= time(ctx.now)) return [];
    const items = ctx.list('evergreen_queue_item').filter(row => row.queue_id === queue.id && row.status === 'active' && (row.expires_at == null || time(row.expires_at) > time(ctx.now)));
    const accounts = new Set(list(queue.social_account_ids));
    const targets = new Map(ctx.list(KIND).filter(row => accounts.has(row.social_account_id)).map(row => [row.id, row]));
    const observations = latestEngagements(ctx);
    const aggregates = new Map<unknown, { count: number; total: number }>();
    for (const post of ctx.list('platform_post')) {
      const target = targets.get(String(post.publish_target_id));
      const published = time(post.published_at);
      if (!target || target.social_account_id !== post.social_account_id || !(published > time(ctx.now) - 90 * DAY && published <= time(ctx.now))) continue;
      const observation = observations.get(post.id);
      if (!observation || time(observation.observed_at) < published) continue;
      const aggregate = aggregates.get(target.content_item_id) ?? { count: 0, total: 0 };
      aggregate.count++;
      aggregate.total += Number(observation.value);
      aggregates.set(target.content_item_id, aggregate);
    }
    return items.map(row => {
      const { count, total } = aggregates.get(row.content_item_id) ?? { count: 0, total: 0 };
      return { item_id: row.id, content_item_id: row.content_item_id, sample_size: count, average_engagements: count >= 3 ? total / count : null };
    }).sort((a, b) => (b.average_engagements ?? -1) - (a.average_engagements ?? -1) || a.item_id.localeCompare(b.item_id));
  }),
  op('GET', '/slot-suggestions', 'publishing_suggest_slots', READ, (ctx, input) => {
    const account = ctx.get('social_account', text(input.query.social_account_id, 'social_account_id'));
    const zone = String(account.default_timezone ?? 'UTC');
    const grouped = new Map<string, { weekday: number; local_time: string; sample_size: number; total: number }>();
    const observations = latestEngagements(ctx);
    const now = time(ctx.now);
    for (const post of ctx.list('platform_post')) {
      const published = time(post.published_at);
      if (post.social_account_id !== account.id || !(published > now - 90 * DAY && published <= now)) continue;
      const observation = observations.get(post.id);
      if (!observation || time(observation.observed_at) < published) continue;
      const [day, at] = localMinute(String(post.published_at), zone).split('T');
      const slot = { weekday: dow(day), local_time: `${at.slice(0, 2)}:00`, sample_size: 0, total: 0 };
      const key = `${slot.weekday}:${slot.local_time}`;
      const aggregate = grouped.get(key) ?? slot;
      aggregate.sample_size++;
      aggregate.total += Number(observation.value);
      grouped.set(key, aggregate);
    }
    return [...grouped.values()].filter(slot => slot.sample_size >= 3).map(({ total, ...slot }) => ({ ...slot, average_engagements: total / slot.sample_size, basis: 'observed_engagements_last_90_days', tz: zone })).sort((a, b) => b.average_engagements - a.average_engagements);
  }),
];
