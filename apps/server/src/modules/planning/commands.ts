import { admins, readers, reviewers, text, writers, type Command, type Commands, type Context, type Entity, type Fields, type Role } from '../types.ts';
import { APPROVAL, MODULE, PAUSE, PLAN, PROFILE, TARGET, allowed, assertNoExecution, emit, fail, hash, insert, list, object, one, read, scheduleTime, targetFor, timeFields, timestamp, timezone, update, version } from './model.ts';
import { accountFor, inspect, saveCheck } from './precheck.ts';
import { accountPlatform as platformOfAccount } from '../content/validation.ts';
import { calendar, getTarget, listTargets } from './queries.ts';
import { localMinute } from '../../../../../packages/domain/src/publishing/time.ts';
import { makeContext } from '../../context.js';
import { operationRecords } from '../../integration/operation-records.js';

const POLICY = 'approval_policy';
const targetFields = ['account_id', 'social_account_id', 'content_variant_id', 'revision_id', 'plan_id', 'route', 'visibility', 'options', ...timeFields] as const;
const targetMutation = ['target_id', 'expected_version'] as const;

function command(roles: readonly Role[], run: Command['run']): Command {
  return { roles, async run(ctx, input) {
    if (!roles.includes(ctx.role)) fail('forbidden', 'This role cannot perform the action.', 403);
    if (!object(input)) fail('invalid_input', 'The command input must be an object.');
    return run(ctx, input);
  } };
}

async function touchExecutionGuard(ctx: Context) {
  const id = hash(['execution_guard', ctx.workspaceId]);
  const ref = ['execution', 'execution_guard', id] as const;
  const guard = await ctx.get(...ref);
  if (guard) await ctx.update(...ref, { checked_at: ctx.now }, guard.version);
  else await ctx.insert('execution', 'execution_guard', { restore_hold: false, checked_at: ctx.now }, id);
}

function accountId(input: Fields) {
  if (input.account_id !== undefined && input.social_account_id !== undefined && input.account_id !== input.social_account_id) fail('invalid_input', 'Choose one account ID.');
  return text({ account_id: input.account_id ?? input.social_account_id }, 'account_id', 160);
}

function flag(input: Fields, key: string, fallback: boolean) {
  if (input[key] === undefined) return fallback;
  if (typeof input[key] !== 'boolean') fail('invalid_input', `${key} must be a boolean.`);
  return input[key];
}

function targetOptions(value: unknown) {
  if (!object(value) || JSON.stringify(value).length > 16384) fail('invalid_input', 'options must be a JSON object of at most 16 KB.');
  return value;
}

async function createTarget(ctx: Context, input: Fields) {
  allowed(input, targetFields);
  const account_id = accountId(input);
  const { timezone: zone } = await accountFor(ctx, account_id);
  const plan = input.plan_id == null ? null : await read(ctx, PLAN, text(input, 'plan_id', 160));
  if (plan && plan.data.status !== 'draft') fail('invalid_state', 'Add targets to a draft plan.', 409);
  if (plan) await update(ctx, plan, { last_target_added_at: ctx.now });
  const plan_id = plan?.id ?? null;
  const row = await insert(ctx, TARGET, {
    account_id, plan_id, content_variant_id: text(input, 'content_variant_id', 160),
    revision_id: input.revision_id == null ? null : text(input, 'revision_id', 160),
    route: one(input.route, ['official', 'manual'], 'route'), visibility: text(input, 'visibility', 120),
    options: input.options === undefined ? {} : targetOptions(input.options), ...scheduleTime(input, zone),
    status: 'draft', owner_id: ctx.actorId, approval_id: null, frozen: null, frozen_hash: null,
  });
  await emit(ctx, 'target.created', { target_id: row.id, plan_id });
  return row;
}

async function checked(ctx: Context, row: Entity, stage: 'schedule' | 'approval') {
  const check = await inspect(ctx, row, stage);
  if (!check.frozen || check.blockers.length) fail('precheck_blocked', check.blockers.map(issue => `${issue.code}: ${issue.message}`).join(' | ') || 'Cannot freeze the target.', 409);
  await saveCheck(ctx, row, check);
  return { frozen: check.frozen, frozen_hash: hash(check.frozen) };
}

async function recordReferences(ctx: Context, target: Entity, frozen: Fields) {
  const refs: [string, string][] = [];
  for (const asset of frozen.asset_versions) {
    refs.push(['asset_version', asset.id]);
    if (asset.grant_id) refs.push(['rights_grant', asset.grant_id]);
  }
  for (const rendition of frozen.renditions) refs.push(['asset_rendition', rendition.id]);
  for (const ref of frozen.revision.product_refs) {
    if (ref.fact_revision_id) refs.push(['product_fact_revision', ref.fact_revision_id]);
    if (ref.listing_snapshot_id) refs.push(['listing_snapshot', ref.listing_snapshot_id]);
  }
  for (const [ref_type, ref_id] of refs) {
    const key = hash([target.id, frozen.revision.id, ref_type, ref_id]);
    if (!await ctx.get(MODULE, 'publish_target_ref', key)) {
      await insert(ctx, 'publish_target_ref', { target_id: target.id, publish_target_id: target.id, revision_id: frozen.revision.id, ref_type, ref_id }, key);
    }
  }
}

async function submitTarget(ctx: Context, row: Entity) {
  if (!['draft', 'changes_requested', 'rejected'].includes(row.data.status)) fail('invalid_state', 'This target cannot be submitted in its current state.', 409);
  await touchExecutionGuard(ctx);
  const { frozen, frozen_hash } = await checked(ctx, row, 'schedule');
  const policy = (await ctx.get(MODULE, POLICY, 'default'))?.data;
  const approval = await insert(ctx, APPROVAL, {
    target_id: row.id, status: 'pending', requested_by: ctx.actorId, owner_id: row.data.owner_id,
    revision_author_id: frozen.revision.author_id, approver_id: policy?.approver_id ?? null,
    original_scheduled_at: row.data.scheduled_at, reschedule_tolerance_minutes: policy?.reschedule_tolerance_minutes ?? 60,
    requested_at: ctx.now, frozen_hash,
  });
  const result = await update(ctx, row, { status: 'awaiting_approval', submitted_at: ctx.now, revision_id: frozen.revision.id, approval_id: approval.id, frozen, frozen_hash });
  await emit(ctx, 'target.submitted', { target_id: row.id, approval_id: approval.id, frozen_hash });
  return result;
}

function review(status: 'approved' | 'rejected' | 'changes_requested') {
  return command(reviewers, async (ctx, input) => {
    allowed(input, [...targetMutation, 'frozen_hash', 'reason']);
    const row = await targetFor(ctx, input);
    version(row, input);
    if (row.data.status !== 'awaiting_approval') fail('invalid_state', 'This target has no pending approval.', 409);
    const approval = await read(ctx, APPROVAL, row.data.approval_id);
    if (approval.data.status !== 'pending' || approval.data.target_id !== row.id || approval.data.frozen_hash !== row.data.frozen_hash ||
      (input.frozen_hash !== undefined && input.frozen_hash !== row.data.frozen_hash)) fail('approval_invalid', 'The reviewed approval does not match this target.', 409);
    if (approval.data.approver_id && ctx.actorId !== approval.data.approver_id) fail('forbidden', 'Only the assigned reviewer can decide this approval.', 403);
    if ([approval.data.requested_by, approval.data.owner_id, approval.data.revision_author_id].includes(ctx.actorId)) {
      fail('self_review_forbidden', 'A submitter, target owner or revision author cannot review this target.', 403);
    }
    if (status === 'approved') {
      await touchExecutionGuard(ctx);
      const current = await checked(ctx, row, 'approval');
      if (current.frozen_hash !== row.data.frozen_hash || hash(row.data.frozen) !== current.frozen_hash) fail('approval_invalid', 'Publishing inputs changed. Update and resubmit this target.', 409);
      await recordReferences(ctx, row, current.frozen);
    }
    const reason = input.reason === undefined && status === 'approved' ? null : text(input, 'reason', 1000);
    await update(ctx, approval, { status, decided_by: ctx.actorId, decided_at: ctx.now, reason });
    const result = await update(ctx, row, { status: status === 'approved' ? 'scheduled' : status, ...(status === 'approved' ? { approved_at: ctx.now } : {}) });
    await emit(ctx, `approval.${status}`, { target_id: row.id, approval_id: approval.id, actor_id: ctx.actorId, frozen_hash: row.data.frozen_hash });
    if (status === 'approved') await emit(ctx, 'target.ready', { target_id: row.id, approval_id: approval.id, scheduled_at: row.data.scheduled_at, frozen_hash: row.data.frozen_hash });
    return result;
  });
}

async function invalidate(ctx: Context, row: Entity) {
  if (!row.data.approval_id) return;
  const approval = await ctx.get(MODULE, APPROVAL, row.data.approval_id);
  if (approval && ['approved', 'pending'].includes(approval.data.status)) {
    await update(ctx, approval, { status: 'invalidated', invalidated_at: ctx.now, invalidated_by: ctx.actorId });
    await emit(ctx, 'target.approval_invalidated', { target_id: row.id, approval_id: approval.id });
  }
}

async function keepApproval(ctx: Context, before: Entity, proposed: Entity) {
  const d = before.data;
  if (d.status !== 'scheduled' || d.schedule_tz !== proposed.data.schedule_tz || !object(d.frozen) || hash(d.frozen) !== d.frozen_hash) return;
  const approval = await read(ctx, APPROVAL, d.approval_id);
  const a = approval.data;
  if (a.status !== 'approved' || a.frozen_hash !== d.frozen_hash || a.target_id !== before.id ||
    localMinute(a.original_scheduled_at, d.schedule_tz).slice(0, 10) !== localMinute(proposed.data.scheduled_at, d.schedule_tz).slice(0, 10) ||
    Math.abs(Date.parse(a.original_scheduled_at) - Date.parse(proposed.data.scheduled_at)) > a.reschedule_tolerance_minutes * 60_000) return;
  const check = await inspect(ctx, proposed, 'approval');
  if (!check.frozen || check.blockers.length || hash({ ...check.frozen, scheduled_at: d.scheduled_at }) !== d.frozen_hash) return;
  await saveCheck(ctx, proposed, check);
  const frozen_hash = hash(check.frozen);
  await update(ctx, approval, { frozen_hash });
  await emit(ctx, 'target.approval_kept_under_tolerance', { target_id: before.id, approval_id: approval.id, previous_hash: d.frozen_hash, frozen_hash });
  return { frozen: check.frozen, frozen_hash };
}

async function change(ctx: Context, input: Fields, onlyTime: boolean) {
  allowed(input, [...targetMutation, ...(onlyTime ? timeFields : targetFields.filter(field => field !== 'plan_id'))]);
  const row = await targetFor(ctx, input);
  version(row, input);
  if (!['draft', 'awaiting_approval', 'changes_requested', 'rejected', 'scheduled'].includes(row.data.status)) fail('invalid_state', 'This target cannot be changed.', 409);
  await touchExecutionGuard(ctx);
  await assertNoExecution(ctx, row);
  const changes: Fields = {};
  if (input.account_id !== undefined || input.social_account_id !== undefined) changes.account_id = accountId(input);
  if (input.content_variant_id !== undefined) changes.content_variant_id = text(input, 'content_variant_id', 160);
  if (input.route !== undefined) changes.route = one(input.route, ['manual', 'official'], 'route');
  if (input.options !== undefined) changes.options = targetOptions(input.options);
  if (input.visibility !== undefined) changes.visibility = text(input, 'visibility', 120);
  if (input.revision_id !== undefined) changes.revision_id = input.revision_id === null ? null : text(input, 'revision_id', 160);
  else if (changes.content_variant_id !== undefined && changes.content_variant_id !== row.data.content_variant_id) changes.revision_id = null;
  const timeOnly = Object.keys(changes).length === 0;
  const moving = timeFields.some(key => Object.hasOwn(input, key));
  if (moving) Object.assign(changes, scheduleTime(input, row.data.schedule_tz));
  if (moving && Date.parse(changes.scheduled_at) <= Date.parse(ctx.now)) fail('invalid_schedule', 'Choose a future scheduled time.');
  if (!Object.keys(changes).length) fail('invalid_input', 'Provide at least one editable field.');
  const proposed = { ...row, data: { ...row.data, ...changes } };
  const kept = moving && timeOnly ? await keepApproval(ctx, row, proposed) : undefined;
  if (kept) Object.assign(changes, kept);
  else if (row.data.status !== 'draft') {
    await invalidate(ctx, row);
    if (input.revision_id === undefined) changes.revision_id = null;
    Object.assign(changes, { status: 'draft', frozen: null, frozen_hash: null, approval_id: null, approved_at: null });
  }
  const result = await update(ctx, row, changes);
  await emit(ctx, moving ? 'target.rescheduled' : 'target.updated', { target_id: row.id, scheduled_at: result.data.scheduled_at, approval_retained: !!kept });
  return result;
}

function optionalStrings(input: Fields, key: string) {
  const value = input[key];
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.length > 60) fail('invalid_input', `${key} must be a non-empty list with at most 60 values.`);
  return [...new Set(value.map(item => text({ item }, 'item', 120)))];
}

const submit = command(writers, async (ctx, input) => {
  allowed(input, targetMutation);
  const row = await targetFor(ctx, input);
  version(row, input);
  return submitTarget(ctx, row);
});

export const commands: Commands = {
  create_plan: command(writers, async (ctx, input) => {
    allowed(input, ['name']);
    const plan = await insert(ctx, PLAN, { name: text(input, 'name', 240), owner_id: ctx.actorId, status: 'draft' });
    await emit(ctx, 'plan.created', { plan_id: plan.id });
    return plan;
  }),
  create_target: command(writers, createTarget),
  preview_plan: command(readers, async (ctx, input) => {
    allowed(input, ['plan_id']);
    const plan = await read(ctx, PLAN, text(input, 'plan_id', 160));
    const targets = (await list(ctx, TARGET)).filter(row => row.data.plan_id === plan.id && row.data.status === 'draft');
    const items = await Promise.all(targets.map(async target => {
      const { frozen, ...check } = await inspect(ctx, target, 'schedule');
      return { target_id: target.id, expected_version: target.version, ...check };
    }));
    return { plan_id: plan.id, expected_version: plan.version, items };
  }),
  commit_plan: { accepted: true, ...command(writers, async (ctx, input) => {
    allowed(input, ['plan_id', 'expected_version', 'items']);
    const plan = await read(ctx, PLAN, text(input, 'plan_id', 160));
    version(plan, input);
    if (plan.data.status !== 'draft') fail('invalid_state', 'The plan was already committed.', 409);
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) fail('invalid_input', 'Include 1 to 50 target versions from preview_plan.');
    const targets = (await list(ctx, TARGET)).filter(row => row.data.plan_id === plan.id && row.data.status === 'draft');
    const byId = new Map(targets.map(target => [target.id, target]));
    const seen = new Set<string>();
    if (targets.length !== input.items.length) fail('version_conflict', 'Plan membership changed. Preview it again.', 409);
    const selected: Entity[] = [];
    for (const item of input.items) {
      if (!object(item)) fail('invalid_input', 'Each item must include target_id and expected_version.');
      allowed(item, targetMutation);
      const id = text(item, 'target_id', 160);
      const target = byId.get(id);
      if (!target || seen.has(id)) fail('version_conflict', 'Plan membership changed. Preview it again.', 409);
      version(target, item);
      seen.add(id);
      selected.push(target);
    }
    const { records, flush } = await operationRecords(ctx, false);
    const operations = makeContext(records, ctx, ctx.role);
    const results = [];
    for (const target of selected) results.push(await submitTarget(ctx, target));
    const operation = operations.create('operation', { kind: 'publishing.commit_plan', resource_id: plan.id,
      status: 'succeeded', total: results.length, failures: 0 });
    const items = results.map((target, item_no) => operations.create('operation_item', { operation_id: operation.id,
      item_no, target_id: target.id, target_version: target.version, approval_request_id: target.data.approval_id, status: 'approval_required' }));
    const committed = await update(ctx, plan, { status: 'committed', committed_at: ctx.now, operation_id: operation.id });
    await flush();
    await emit(ctx, 'plan.committed', { plan_id: plan.id, target_ids: results.map(target => target.id), operation_id: operation.id });
    return { plan: committed, targets: results, operation_id: operation.id, items };
  }) },
  precheck: command(readers, async (ctx, input) => {
    allowed(input, ['target_id', 'stage']);
    const row = await targetFor(ctx, input);
    const stage = input.stage === undefined ? 'schedule' : one(input.stage, ['schedule', 'approval', 'preflight', 'execution'], 'stage');
    return saveCheck(ctx, row, await inspect(ctx, row, stage));
  }),
  submit,
  approve: review('approved'), reject: review('rejected'), request_changes: review('changes_requested'),
  schedule: command(writers, async (ctx, input) => {
    allowed(input, targetMutation);
    const row = await targetFor(ctx, input);
    version(row, input);
    return ['awaiting_approval', 'scheduled'].includes(row.data.status) ? row : submitTarget(ctx, row);
  }),
  change_target: command(writers, (ctx, input) => change(ctx, input, false)),
  reschedule: command(writers, (ctx, input) => change(ctx, input, true)),
  cancel: command(writers, async (ctx, input) => {
    allowed(input, [...targetMutation, 'reason']);
    const row = await targetFor(ctx, input);
    version(row, input);
    if (['cancelled', 'closed'].includes(row.data.status)) fail('invalid_state', 'This target is already final.', 409);
    const reason = text(input, 'reason', 1000);
    await touchExecutionGuard(ctx);
    await assertNoExecution(ctx, row);
    await invalidate(ctx, row);
    const result = await update(ctx, row, { status: 'cancelled', cancelled_at: ctx.now, cancelled_by: ctx.actorId, cancel_reason: reason });
    await emit(ctx, 'target.cancelled', { target_id: row.id, reason });
    return result;
  }),
  set_publishing_profile: command(admins, async (ctx, input) => {
    allowed(input, ['account_id', 'social_account_id', 'expected_version', 'active', 'platform', 'timezone', 'official_capability', 'manual_capability', 'adapter_key', 'quota_limit', 'connection_expires_at', 'formats', 'markets', 'visibilities', 'account_identity']);
    const id = accountId(input);
    const { account, profile } = await accountFor(ctx, id);
    if (profile) version(profile, input);
    else if (input.expected_version !== undefined) fail('version_conflict', 'No publishing profile exists for this account.', 409);
    if (profile?.data.linked_account && !account) fail('account_unavailable', 'The linked social account is unavailable.', 409);
    const accountPlatform = account ? platformOfAccount(account) : undefined;
    const platform = text({ platform: input.platform ?? accountPlatform }, 'platform', 100);
    if (account && platform !== accountPlatform) fail('account_mismatch', 'The publishing profile must match the social account platform.');
    const official_capability = flag(input, 'official_capability', false);
    const quota_limit = input.quota_limit ?? null;
    const adapter_key = input.adapter_key == null ? null : text(input, 'adapter_key', 160);
    if (quota_limit !== null && (!Number.isSafeInteger(quota_limit) || quota_limit <= 0)) fail('invalid_input', 'quota_limit must be a positive integer.');
    if (official_capability && (!adapter_key || quota_limit === null)) fail('invalid_input', 'Official capability requires adapter_key and quota_limit.');
    if (official_capability && !account) fail('account_unavailable', 'Register the social account before enabling official publishing.', 409);
    const data = {
      account_id: id, linked_account: !!account, platform, timezone: timezone(input.timezone ?? account?.data.default_timezone),
      active: flag(input, 'active', true), official_capability, manual_capability: flag(input, 'manual_capability', true), adapter_key, quota_limit,
      connection_expires_at: input.connection_expires_at == null ? null : timestamp(input.connection_expires_at, 'connection_expires_at'),
      account_identity: input.account_identity == null ? null : text(input, 'account_identity', 256),
      formats: optionalStrings(input, 'formats'), markets: optionalStrings(input, 'markets'), visibilities: optionalStrings(input, 'visibilities'),
    };
    await touchExecutionGuard(ctx);
    const result = profile ? await update(ctx, profile, data) : await insert(ctx, PROFILE, data, id);
    await emit(ctx, 'publishing_profile.updated', { account_id: id, profile_version: result.version });
    return result;
  }),
  set_approval_policy: command(admins, async (ctx, input) => {
    allowed(input, ['expected_version', 'approver_id', 'reschedule_tolerance_minutes']);
    const policy = await ctx.get(MODULE, POLICY, 'default');
    if (policy) version(policy, input);
    else if (input.expected_version !== undefined) fail('version_conflict', 'No policy exists.', 409);
    const limit = input.reschedule_tolerance_minutes ?? 60;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 60) fail('invalid_input', 'reschedule_tolerance_minutes must be between 0 and 60.');
    const data = { approver_id: input.approver_id == null ? null : text(input, 'approver_id', 160), reschedule_tolerance_minutes: limit };
    const result = policy ? await update(ctx, policy, data) : await insert(ctx, POLICY, data, 'default');
    await emit(ctx, 'approval_policy.updated', { policy_id: result.id, policy_version: result.version });
    return result;
  }),
  list_approvals: command(reviewers, async (ctx, input) => {
    allowed(input, []);
    return (await list(ctx, APPROVAL)).filter(({ data }) => data.status === 'pending' && (!data.approver_id || data.approver_id === ctx.actorId) &&
      ![data.requested_by, data.owner_id, data.revision_author_id].includes(ctx.actorId));
  }),
  pause: command(writers, async (ctx, input) => {
    allowed(input, ['scope', 'scope_id', 'reason']);
    const scope = one(input.scope ?? 'workspace', ['workspace', 'campaign', 'account', 'brand'], 'scope');
    const scope_id = scope === 'workspace' ? null : text(input, 'scope_id', 160);
    if (scope === 'workspace' && input.scope_id != null) fail('invalid_input', 'Workspace pause needs no scope_id.');
    const reason = text(input, 'reason', 1000);
    await touchExecutionGuard(ctx);
    const active = (await list(ctx, PAUSE)).find(({ data }) => data.active === true && data.scope === scope && data.scope_id === scope_id);
    if (active) return active;
    const result = await insert(ctx, PAUSE, { scope, scope_id, reason, active: true, activated_by: ctx.actorId, activated_at: ctx.now });
    await emit(ctx, 'pause_switch.activated', { switch_id: result.id, scope, scope_id, reason });
    return result;
  }),
  release_pause: command(admins, async (ctx, input) => {
    allowed(input, ['pause_id', 'expected_version', 'dry_run']);
    const row = await read(ctx, PAUSE, text(input, 'pause_id', 160));
    if (row.data.active !== true) fail('invalid_state', 'This switch is already released.', 409);
    if (flag(input, 'dry_run', false)) {
      const targets = (await list(ctx, TARGET)).filter(({ data }) => data.status === 'scheduled' &&
        Date.parse(data.scheduled_at) >= Date.parse(row.data.activated_at) && Date.parse(data.scheduled_at) <= Date.parse(ctx.now) &&
        (row.data.scope === 'workspace' || row.data.scope === 'account' && row.data.scope_id === data.account_id ||
          row.data.scope === 'campaign' && row.data.scope_id === data.frozen?.campaign_id || row.data.scope === 'brand' && row.data.scope_id === data.frozen?.brand_id));
      return { pause_id: row.id, version: row.version, missed_target_ids: targets.map(target => target.id) };
    }
    version(row, input);
    await touchExecutionGuard(ctx);
    const result = await update(ctx, row, { active: false, released_at: ctx.now, released_by: ctx.actorId });
    await emit(ctx, 'pause_switch.released', { switch_id: row.id, scope: row.data.scope, scope_id: row.data.scope_id });
    return result;
  }),
  list_targets: command(readers, listTargets), get_target: command(readers, getTarget), calendar: command(readers, calendar),
};
