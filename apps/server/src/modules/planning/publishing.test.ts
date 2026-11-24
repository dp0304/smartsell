import { afterEach, describe, expect, it } from 'vitest';
import { AUTOMATION_NOTICE_VERSION, Problem, RISK_TERMS_VERSION, derivePostStatus, type Context, type Data, type Role, type Row } from '@smartsell/contracts';
import { assessTarget, onRevisionCreated, resolveLocal } from '../../../../../packages/domain/src/publishing/index.js';
import { createAdapter } from '../../../../../packages/adapters/src/official.js';
import { completeOAuth, startOAuth } from '../account/oauth.js';
import { applyPlanningEvent, operations, resubmitIfWaiting, scanPlanningDue, submit as submitTarget, updateTarget } from './index.js';
import { channelOperations } from '../account/channel-ops.js';
import { machineOperations } from '../account/machine-ops.js';
import { approvalDeadline, ensureChannelSettings, setWorkerEngineHooks } from '../account/channel-settings.js';
import { applyChannelDefaults, commitVariantRevision } from '../content/index.js';
import { operations as assets } from '../asset/index.js';
import { operations as contentOperations } from '../content/index.js';
import { operations as execution } from '../execution/index.js';
import { deviceSyncState, setJob } from '../worker/model.js';

function fixture() {
  const rows = new Map<string, Row[]>();
  let next = 0;
  const events: { type: string; payload: Data }[] = [];
  const ctx: Context = {
    actorId: 'owner', role: 'owner', tenantId: 'tenant', workspaceId: 'workspace', now: '2027-01-01T10:00:00.000Z',
    list: kind => rows.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind}: ${id}`);
      return row;
    },
    create(kind, data) {
      const row = { ...structuredClone(data), id: String(++next), version: 1, created_at: ctx.now, updated_at: ctx.now };
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, data) {
      const row = ctx.get(kind, id);
      const updated = { ...row, ...structuredClone(data), id, version: row.version + 1, updated_at: ctx.now };
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? updated : item));
      return updated;
    },
    remove(kind, id) { rows.set(kind, ctx.list(kind).filter(row => row.id !== id)); },
    emit(type, payload) { events.push({ type, payload }); },
  };
  function run(name: string, body: Data = {}, id = '', role: Role = ctx.role, expectedVersion?: number, query: Record<string, string> = {}) {
    const operation = [...operations, ...assets, ...contentOperations, ...execution, ...channelOperations, ...machineOperations].find(item => item.name === name)!;
    if (!operation.roles.includes(role)) throw new Problem(403, 'PERMISSION_DENIED', name);
    if (operation.versionKind && expectedVersion === undefined) throw new Problem(428, 'VERSION_REQUIRED', name);
    return operation.run({ ...ctx, role }, { body, params: { id }, query, expectedVersion });
  }
  const account = ctx.create('social_account', { provider: 'meta_facebook', status: 'active', brand_id: 'brand', default_timezone: 'UTC' });
  const content = ctx.create('content_item', { brand_id: 'brand', title: 'Hello', production_due_at: '2027-01-01T11:00:00.000Z' });
  const variant = ctx.create('content_variant', { content_item_id: content.id, platform: 'facebook', format: 'text', locale: 'en', readiness: 'ready' });
  const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'v1', rendered: { text: 'Hello' }, media: [] });
  ctx.update('content_variant', variant.id, { current_revision_id: revision.id });
  const target = (scheduled_at = '2027-01-02T10:00:00Z') => run('publishing_create_target', { social_account_id: account.id, content_variant_id: variant.id, scheduled_at }) as Row;
  const row = (id: string) => ctx.get('publish_target', id);
  const submit = (id: string) => run('publishing_request_approval', {}, id) as Row;
  const approve = (id: string) => run('publishing_approve', {}, id, ctx.role, row(id).version) as Row;
  return { ctx, run, events, target, row, submit, approve, content, variant, revision, account };
}

describe('publishing planning', () => {
  it('honors submit versions and excludes a completed review step from actionable requests', () => {
    const { ctx, run, target, row, submit } = fixture();
    run('publishing_create_approval_policy', { name: 'Two reviewers', steps: [{ order: 1, approvers: { roles: ['owner', 'reviewer'] }, min_approvals: 2 }] });
    const draft = target();
    run('publishing_update_target', { options: { internal_note: 'Changed' } }, draft.id, 'owner', draft.version);
    expect(() => run('publishing_request_approval', {}, draft.id, 'owner', draft.version)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    const submitted = submit(draft.id);
    expect(run('publishing_list_approvals', {}, '', 'editor', undefined, { view: 'submitted' })).toHaveLength(1);
    expect(run('publishing_batch_approve', { items: [{ target_id: draft.id, approval_request_id: 'old', resource_hash: submitted.frozen_hash }] })).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: 'APPROVAL_STALE' }) }),
    ]);
    run('publishing_approve', {}, draft.id, 'owner', row(draft.id).version);
    expect(run('publishing_list_approvals')).toEqual([]);
    expect(run('publishing_get_target', {}, draft.id)).toMatchObject({ allowed_actions: expect.not.arrayContaining(['approve']) });
    expect(ctx.list('approval_decision')).toHaveLength(1);
  });

  it('leaves previous targets in place when a partial plan has invalid replacement items', () => {
    const { run, row, account, variant } = fixture();
    const valid = { social_account_id: account.id, content_variant_id: variant.id, scheduled_at: '2027-01-02T10:00:00Z' };
    const plan = run('publishing_create_plan', { items: [valid] }) as Row;
    const result = run('publishing_schedule', {}, plan.id) as Row;
    const existing = (result.items as { target_id: string }[])[0].target_id;
    const saved = run('publishing_get_plan', {}, plan.id) as Row;
    run('publishing_update_plan', { items: [{ ...valid, social_account_id: 'missing' }] }, plan.id, 'owner', saved.version);
    const preview = run('publishing_preview_plan', {}, plan.id) as Data;
    expect(preview.removed).toEqual([{ target_id: existing, action: 'remove', blocked: true, error_code: 'PLAN_ITEMS_INVALID' }]);
    run('publishing_schedule', { preview_hash: preview.preview_hash }, plan.id);
    expect(row(existing).plan_status).toBe('awaiting_approval');
  });

  it('rechecks a blocked recurring occurrence and reuses its target after recovery', () => {
    const { ctx, run, row, account, variant } = fixture();
    ctx.update('social_account', account.id, { status: 'disabled' });
    const rule = run('publishing_create_schedule_rule', {
      rrule: { freq: 'daily', local_time: '11:00' }, starts_on: '2027-01-01', horizon_days: 1,
      content_source: { social_account_id: account.id, content_variant_id: variant.id },
    }) as Row;
    const [first] = run('publishing_expand_recurring', {}, rule.id) as { status: string; target: Row }[];
    expect(first.target).toMatchObject({ plan_status: 'draft', precheck_summary: 'blocked' });
    ctx.update('social_account', account.id, { status: 'active' });
    expect(run('publishing_expand_recurring', { dry_run: true }, rule.id)).toMatchObject([{ status: 'risk', target_id: first.target.id }]);
    expect(row(first.target.id).plan_status).toBe('draft');
    expect(run('publishing_expand_recurring', {}, rule.id)).toMatchObject([{ status: 'resubmitted', target_id: first.target.id }]);
    expect(row(first.target.id).plan_status).toBe('awaiting_approval');
    expect(ctx.list('publish_target')).toHaveLength(1);
  });

  it('keeps pause active when a release decision is incomplete or based on a stale target version', () => {
    const { ctx, run, target, row, submit, approve } = fixture();
    const draft = target();
    submit(draft.id);
    approve(draft.id);
    const pause = run('publishing_pause', { reason: 'Review incident' }) as Row;
    const version = row(draft.id).version;
    expect(run('publishing_release_pause', { dry_run: true }, pause.id)).toMatchObject({ version: pause.version, targets: [{ target_id: draft.id, version }] });
    expect(() => run('publishing_release_pause', { decisions: [{ target_id: draft.id, expected_version: version, action: 'reschedule' }] }, pause.id)).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => run('publishing_release_pause', { decisions: [{ target_id: draft.id, expected_version: version - 1, action: 'skip' }] }, pause.id)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(ctx.get('pause_switch', pause.id).released_at).toBeUndefined();
    expect(row(draft.id).plan_status).toBe('paused');
  });

  it('blocks an unsent task when its current approval is invalidated and ignores stale invalidation events', () => {
    const { ctx, run, target, row, submit, approve } = fixture();
    const draft = target();
    const submitted = submit(draft.id);
    approve(draft.id);
    const previous = ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: draft.id, status: 'invalidated' });
    applyPlanningEvent(ctx, { type: 'core.approval_request.invalidated', payload: { request_id: previous.id } });
    expect(ctx.list('execution_task')[0].status).toBe('scheduled');
    ctx.update('approval_request', String(submitted.approval_request_id), { status: 'invalidated' });
    applyPlanningEvent(ctx, { type: 'core.approval_request.invalidated', payload: { request_id: row(draft.id).approval_request_id } });
    expect(ctx.list('execution_task')[0]).toMatchObject({ status: 'blocked', status_reason: 'approval_invalid' });
    expect(run('publishing_get_target', {}, draft.id)).toMatchObject({ display_status: 'awaiting_approval', execution_status: 'blocked', allowed_actions: expect.arrayContaining(['submit']) });
  });
  it('recommends evergreen ordering using only observed performance and leaves the queue unchanged', () => {
    const { ctx, run, content, account } = fixture();
    const queue = ctx.create('evergreen_queue', { social_account_ids: [account.id] });
    const unscored = ctx.create('evergreen_queue_item', { queue_id: queue.id, content_item_id: 'no-data', status: 'active' });
    const scored = ctx.create('evergreen_queue_item', { queue_id: queue.id, content_item_id: content.id, status: 'active' });
    ctx.create('evergreen_queue_item', { queue_id: queue.id, content_item_id: 'expired', status: 'active', expires_at: ctx.now });
    const target = ctx.create('publish_target', { content_item_id: content.id, social_account_id: account.id });
    for (const value of [0, 9, 3, null]) {
      const post = ctx.create('platform_post', { publish_target_id: target.id, social_account_id: account.id, published_at: '2026-12-28T10:00:00Z' });
      ctx.create('metric_observation', { subject_id: post.id, observed_at: ctx.now, metric_key: 'engagements', availability: value == null ? 'source_not_provided' : 'observed', value });
    }
    expect(run('publishing_suggest_evergreen_order', {}, queue.id)).toEqual([
      { item_id: scored.id, content_item_id: content.id, sample_size: 3, average_engagements: 4 },
      { item_id: unscored.id, content_item_id: 'no-data', sample_size: 0, average_engagements: null },
    ]);
    expect(ctx.get('evergreen_queue_item', scored.id).version).toBe(1);
  });

  it('suggests slots only from usable observations recorded after publication', () => {
    const { ctx, run, account } = fixture();
    for (const value of [0, 9, 3]) {
      const post = ctx.create('platform_post', { social_account_id: account.id, published_at: '2026-12-28T10:00:00Z' });
      for (const [observed_at, score] of [[ctx.now, value], ['2027-02-01T11:00:00Z', 999]]) {
        ctx.create('metric_observation', { subject_id: post.id, observed_at, metric_key: 'engagements', availability: 'observed', value: score });
      }
    }
    const post = ctx.create('platform_post', { social_account_id: account.id, published_at: '2026-12-28T10:00:00Z' });
    ctx.create('metric_observation', { subject_id: post.id, observed_at: '2026-12-28T09:00:00Z', metric_key: 'engagements', availability: 'observed', value: 100 });
    expect(run('publishing_suggest_slots', {}, '', 'owner', undefined, { social_account_id: account.id })).toMatchObject([
      { weekday: 1, local_time: '10:00', sample_size: 3, average_engagements: 4 },
    ]);
  });

  it('queues native withdrawal during a crisis pause and exposes unconfirmed status', () => {
    const { ctx, run, target, row } = fixture();
    const scheduled = target();
    ctx.update('publish_target', scheduled.id, { plan_status: 'ready' });
    const task = ctx.create('execution_task', { publish_target_id: scheduled.id, status: 'accepted', sub_status: 'scheduled_on_platform', operation: 'publish' });
    const attempt = ctx.create('execution_attempt', { task_id: task.id, status: 'accepted', receipt: 'platform-reference', side_effect_possible: true });
    const pause = run('publishing_pause', { mode: 'hold_and_unschedule', reason: 'Crisis pause' }) as Row;
    expect(row(scheduled.id).plan_status).toBe('cancel_requested');
    expect(ctx.get('execution_task', task.id).status).toBe('cancel_pending');
    expect(ctx.list('execution_verification')).toEqual([expect.objectContaining({ attempt_id: attempt.id, status: 'requested' })]);
    expect(run('publishing_release_pause', { dry_run: true }, pause.id)).toMatchObject({ platform_withdrawals: [{ target_id: scheduled.id, plan_status: 'cancel_requested', execution_status: 'cancel_pending' }] });
  });

  it('requires explicit DST decisions and resolves both fold occurrences', () => {
    expect(() => resolveLocal('2027-03-14T02:30', 'America/New_York')).toThrowError(expect.objectContaining({ code: 'DST_GAP' }));
    expect(resolveLocal('2027-03-14T02:30', 'America/New_York', 'shift_forward').scheduled_at).toBe('2027-03-14T07:00:00.000Z');
    expect(() => resolveLocal('2027-11-07T01:30', 'America/New_York')).toThrowError(expect.objectContaining({ code: 'DST_FOLD' }));
    expect(resolveLocal('2027-11-07T01:30', 'America/New_York', 'earlier_occurrence').scheduled_at).toBe('2027-11-07T05:30:00.000Z');
    expect(resolveLocal('2027-11-07T01:30', 'America/New_York', 'later_occurrence').scheduled_at).toBe('2027-11-07T06:30:00.000Z');
  });

  it('freezes a human-approved revision, preserves bounded reschedule, and requires reapproval for a new revision', () => {
    const { ctx, run, target, row, submit, approve, variant, revision } = fixture();
    const draft = target();
    expect(submit(draft.id).plan_status).toBe('awaiting_approval');
    expect(() => run('publishing_approve', {}, draft.id, 'agent')).toThrow(Problem);
    const ready = approve(draft.id);
    expect(ready.plan_status).toBe('ready');
    expect(ctx.list('execution_task')).toHaveLength(1);
    const rescheduled = run('publishing_reschedule', { scheduled_at: '2027-01-02T10:45:00Z' }, ready.id, 'owner', ready.version) as Row;
    expect(rescheduled.approval_retained).toBe(true);
    expect(ctx.list('execution_task')[0].due_at).toBe('2027-01-02T10:45:00.000Z');
    const edited = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'v2', rendered: { text: 'Changed' } });
    onRevisionCreated(ctx, ctx.update('content_variant', variant.id, { current_revision_id: edited.id }), edited);
    const stale = row(draft.id);
    expect(stale.plan_status).toBe('awaiting_approval');
    expect(stale.variant_revision_id).toBe(revision.id);
    expect(ctx.get('approval_request', String(stale.approval_request_id)).status).toBe('invalidated');
    expect(assessTarget(ctx, stale, 'execution').overall).toBe('blocked');
  });

  it('bounds repeated reschedules to the approved slot and cancels an unsent task', () => {
    const { ctx, run, target, submit, approve } = fixture();
    const draft = target();
    submit(draft.id);
    const approved = approve(draft.id);
    const once = run('publishing_reschedule', { scheduled_at: '2027-01-02T10:45:00Z' }, approved.id, 'owner', approved.version) as Row;
    expect(once.approval_retained).toBe(true);
    const twice = run('publishing_reschedule', { scheduled_at: '2027-01-02T11:30:00Z' }, once.id, 'owner', once.version) as Row;
    expect(twice.approval_retained).toBe(false);
    expect(twice.plan_status).toBe('awaiting_approval');
    const cancelled = run('publishing_cancel', {}, twice.id, 'owner', twice.version) as Row;
    expect(cancelled.plan_status).toBe('cancelled');
    expect(ctx.list('execution_task')[0].status).toBe('cancelled');
  });

  it('distinguishes paused, unknown, and production deadline markers', () => {
    const { ctx, run, target, submit, approve } = fixture();
    const draft = target();
    submit(draft.id);
    approve(draft.id);
    const paused = run('publishing_pause', { reason: 'Market freeze' }) as Row;
    expect(ctx.get('publish_target', draft.id).plan_status).toBe('paused');
    const task = ctx.list('execution_task')[0];
    ctx.update('execution_task', task.id, { status: 'outcome_unknown' });
    const cal = run('publishing_get_calendar') as { targets: Data[]; production_deadlines: Data[] };
    expect(cal.targets[0].display_status).toBe('outcome_unknown');
    expect(cal.production_deadlines).toHaveLength(1);
    expect(() => run('publishing_release_pause', {}, paused.id, 'agent')).toThrow(Problem);
  });

  it('deduplicates recurring occurrences and excludes explicit exception dates', () => {
    const { ctx, run, account, variant } = fixture();
    const rule = run('publishing_create_schedule_rule', { rrule: { freq: 'daily', local_time: '12:00' }, starts_on: '2027-01-01', exceptions: ['2027-01-02'], horizon_days: 3, content_source: { social_account_id: account.id, content_variant_id: variant.id } }) as Row;
    expect(run('publishing_expand_recurring', {}, rule.id)).toHaveLength(2);
    expect(run('publishing_expand_recurring', {}, rule.id)).toHaveLength(2);
    expect(ctx.list('publish_target').map(row => row.occurrence_day)).toEqual(['2027-01-01', '2027-01-03']);
  });

  it('rejects decisions against a stale version or hash and invalidates superseded policy approvals', () => {
    const { ctx, run, target, row, submit, approve, account } = fixture();
    const draft = target();
    const submitted = submit(draft.id);
    expect(() => run('publishing_approve', {}, draft.id)).toThrowError(expect.objectContaining({ code: 'VERSION_REQUIRED' }));
    expect(() => run('publishing_approve', {}, draft.id, 'owner', draft.version)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(() => run('publishing_approve', { resource_hash: 'outdated' }, draft.id, 'owner', submitted.version)).toThrowError(expect.objectContaining({ code: 'APPROVAL_STALE' }));
    expect(ctx.list('approval_decision')).toHaveLength(0);
    const ready = approve(draft.id);
    expect(run('publishing_create_approval_policy', { name: 'Account review', conditions: { social_account_ids: [account.id] } })).toBeTruthy();
    expect(row(draft.id).plan_status).toBe('awaiting_approval');
    expect(ctx.get('approval_request', String(submitted.approval_request_id)).status).toBe('invalidated');
    expect(ctx.list('execution_task')[0]).toMatchObject({ status: 'blocked', status_reason: 'approval_invalid' });
    const resubmitted = submit(draft.id);
    expect(resubmitted.snapshot_generation).toBe(Number(ready.snapshot_generation) + 1);
    approve(draft.id);
    expect(ctx.list('execution_task')[0].approval_request_id).toBe(resubmitted.approval_request_id);
  });

  it('treats an owner bearer credential as an agent and preserves the assigned portal reviewer flow', () => {
    const { ctx, run, target, row, submit } = fixture();
    const draft = target();
    run('publishing_create_approval_policy', { name: 'Client review', steps: [{ order: 1, approvers: { user_ids: ['client'] }, min_approvals: 1 }] });
    submit(draft.id);
    const approve = operations.find(operation => operation.name === 'publishing_approve')!;
    const input = { params: { id: draft.id }, body: {}, query: {} };
    expect(approve).toMatchObject({ mcp: false, versionKind: 'publish_target' });
    expect(() => approve.run({ ...ctx, ...{ agentCredentialId: 'owner-token' } }, input)).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(() => approve.run(ctx, input)).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(approve.run({ ...ctx, actorId: 'client', role: 'reviewer' }, input)).toMatchObject({ plan_status: 'ready' });
    expect(row(draft.id).plan_status).toBe('ready');
  });

  it('preserves approvals for internal notes and connector downgrades only', () => {
    const { run, target, submit, approve } = fixture();
    const draft = target();
    submit(draft.id);
    const ready = approve(draft.id);
    const assisted = run('publishing_update_target', { connector_mode_pref: 'assist', options: { internal_note: 'Coordinate with sales' } }, draft.id, 'agent', ready.version) as Row;
    expect(assisted.approval_retained).toBe(true);
    expect(() => run('publishing_update_target', { connector_mode_pref: 'inherit' }, draft.id, 'agent', assisted.version)).toThrowError(expect.objectContaining({ code: 'PERMISSION_DENIED' }));
    expect(run('publishing_update_target', { connector_mode_pref: 'inherit' }, draft.id, 'owner', assisted.version)).toMatchObject({ approval_retained: false, plan_status: 'awaiting_approval' });
  });

  it('keeps an explicitly selected draft revision pinned while ordinary drafts follow updates', () => {
    const { ctx, run, target, row, account, variant, revision } = fixture();
    const follows = target();
    const pinned = run('publishing_create_target', { social_account_id: account.id, content_variant_id: variant.id, revision_id: revision.id }) as Row;
    const edited = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'v2', rendered: { text: 'Changed' } });
    onRevisionCreated(ctx, ctx.update('content_variant', variant.id, { current_revision_id: edited.id }), edited);
    expect(row(follows.id).variant_revision_id).toBe(edited.id);
    expect(row(pinned.id).variant_revision_id).toBe(revision.id);
  });

  it('rejects stale preview bindings and preserves per-item outcomes on retry', () => {
    const { ctx, run, account, variant } = fixture();
    const valid = { social_account_id: account.id, content_variant_id: variant.id, scheduled_at: '2027-01-02T10:00:00Z' };
    const plan = run('publishing_create_plan', { items: [valid, { ...valid, social_account_id: 'missing' }] }) as Row;
    const preview = run('publishing_preview_plan', {}, plan.id) as Data;
    const edit = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'v2', rendered: { text: 'Different version' } });
    ctx.update('content_variant', variant.id, { current_revision_id: edit.id });
    expect(() => run('publishing_schedule', { preview_hash: preview.preview_hash }, plan.id)).toThrowError(expect.objectContaining({ code: 'PREVIEW_STALE' }));
    expect(ctx.list('publish_target')).toHaveLength(0);
    const committed = run('publishing_schedule', {}, plan.id) as Row;
    expect(committed.status).toBe('partially_committed');
    expect((committed.items as Row[]).map(row => row.status)).toEqual(['approval_required', 'failed']);
    expect((run('publishing_schedule', {}, plan.id) as Row).id).toBe(committed.id);
    expect(ctx.list('publish_target')).toHaveLength(1);
  });

  it('shows production deadlines before the filtered account’s planned publication', () => {
    const { ctx, run, target, account, content } = fixture();
    target();
    ctx.update('content_item', content.id, { campaign_id: 'one' });
    ctx.create('content_item', { brand_id: 'brand', campaign_id: 'two', production_due_at: '2027-01-01T11:00:00.000Z' });
    const result = run('publishing_get_calendar', {}, '', 'owner', undefined, { from: '2027-01-01', to: '2027-01-02', social_account_id: account.id }) as Data;
    expect(result.targets).toEqual([]);
    expect(result.production_deadlines).toEqual([expect.objectContaining({ content_item_id: content.id })]);
    const overlay = run('publishing_get_calendar', {}, '', 'owner', undefined, { from: '2027-01-01', to: '2027-01-02', campaign_ids: 'one,three' }) as Data;
    expect(overlay.production_deadlines).toEqual([expect.objectContaining({ content_item_id: content.id })]);
  });

  it('invalidates price claims only in the affected market and blocks stock loss without changing the revision', () => {
    const { ctx, events, target, variant, row, submit, approve } = fixture();
    const market = ctx.create('market', { country_code: 'JP' });
    const product = ctx.create('product_variant', { status: 'active' });
    const original = ctx.create('listing_snapshot', { variant_id: product.id, market_id: market.id, observed_at: ctx.now, price_amount_minor: 100, currency: 'JPY', available_for_sale: true, channel: 'shop' });
    const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'price', rendered: { text: 'For 100 yen' }, product_refs: [{ variant_id: product.id, market_id: market.id, listing_snapshot_id: original.id, field: 'price' }] });
    ctx.update('content_variant', variant.id, { current_revision_id: revision.id, market_id: market.id });
    const draft = target();
    submit(draft.id);
    const ready = approve(draft.id);
    ctx.update('listing_snapshot', original.id, { is_current: false });
    ctx.create('listing_snapshot', { variant_id: product.id, market_id: market.id, observed_at: ctx.now, price_amount_minor: 200, currency: 'JPY', available_for_sale: false, channel: 'shop' });
    applyPlanningEvent(ctx, { type: 'commerce.listing.changed', payload: { variant_id: product.id, market_id: 'other', channel: 'shop' } });
    expect(row(draft.id).version).toBe(ready.version);
    applyPlanningEvent(ctx, { type: 'commerce.listing.changed', payload: { variant_id: product.id, market_id: market.id, channel: 'shop' } });
    expect(row(draft.id)).toMatchObject({ plan_status: 'awaiting_approval', precheck_summary: 'blocked', variant_revision_id: revision.id });
    expect(ctx.list('execution_task')[0]).toMatchObject({ status: 'blocked', status_reason: 'approval_invalid' });
    expect(events.some(event => event.type === 'planning.target.commerce_impact')).toBe(true);
  });

  it('blocks execution on stale connected-store facts and keeps import-only snapshots a risk', () => {
    const { ctx, target, variant } = fixture();
    const store = ctx.create('store', { status: 'active', connection_id: 'live-connection' });
    const product = ctx.create('product_variant', { status: 'active', store_id: store.id });
    const snapshot = ctx.create('listing_snapshot', { variant_id: product.id, observed_at: '2026-12-31T10:00:00Z', availability: 'observed', price_amount_minor: 100, currency: 'JPY', available_for_sale: true });
    const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'catalog', rendered: { text: 'Available now' }, product_refs: [{ variant_id: product.id, listing_snapshot_id: snapshot.id, field: 'availability' }] });
    ctx.update('content_variant', variant.id, { current_revision_id: revision.id });
    const draft = target();
    const issue = (stage: 'schedule' | 'execution') => assessTarget(ctx, draft, stage).items.find(check => check.check_key === 'product_fact');
    expect(issue('schedule')).toMatchObject({ severity: 'risk' });
    expect(issue('execution')).toMatchObject({ severity: 'blocker' });
    ctx.update('store', store.id, { status: 'import_only' });
    expect(issue('execution')).toMatchObject({ severity: 'risk' });
  });

  it('generates deduplicated native candidates and only associates them after a person confirms', () => {
    const { ctx, run, target, account } = fixture();
    const draft = target();
    const post = ctx.create('platform_post', { origin: 'native', social_account_id: account.id, verification: 'system_verified', published_at: draft.scheduled_at, caption: 'Hello' });
    const observation = { type: 'execution.platform_post.observed', payload: { platform_post_id: post.id } };
    applyPlanningEvent(ctx, observation);
    applyPlanningEvent(ctx, observation);
    expect(ctx.list('reconciliation_candidate')).toHaveLength(1);
    expect(ctx.get('platform_post', post.id).publish_target_id).toBeUndefined();
    run('publishing_confirm_post_match', {}, ctx.list('reconciliation_candidate')[0].id);
    expect(ctx.get('platform_post', post.id).publish_target_id).toBe(draft.id);
    expect(ctx.get('publish_target', draft.id)).toMatchObject({ plan_status: 'closed', scheduled_at: draft.scheduled_at });
    expect(run('publishing_get_target', {}, draft.id)).toMatchObject({ display_status: 'published' });
  });

  it('compares an authorized Facebook schedule via GET without claiming an ambiguous match or changing plans', async () => {
    const { ctx, run, target, account, revision, submit, approve } = fixture();
    const pageId = '1234';
    const scopes = ['pages_read_engagement', 'pages_manage_posts'];
    const path = '/v24.0/1234/scheduled_posts';
    const reads: string[] = [];
    Object.assign(ctx, { planningAccountServices: {
      encryptionKey: Buffer.alloc(32, 42), oauthRedirectUri: () => 'https://local.example/oauth',
      adapter: () => createAdapter('meta_facebook', { credentials: { clientId: 'client', clientSecret: 'secret', facebookConfigId: 'config' },
        transport: async req => {
          const request = new URL(req.url);
          expect(req.method).toBe('GET');
          if (request.pathname.endsWith('/oauth/access_token')) return { status: 200, body: { access_token: 'user', scope: scopes.join(','), expires_in: 3600 } };
          if (request.pathname.endsWith('/me/permissions')) return { status: 200, body: { data: scopes.map(permission => ({ permission, status: 'granted' })) } };
          if (request.pathname.endsWith('/me/accounts')) return { status: 200, body: { data: [{ id: pageId, name: 'Page', access_token: 'page', tasks: ['CREATE_CONTENT'] }] } };
          expect(request.pathname).toBe(path);
          expect(req.headers?.authorization).toBe('Bearer page');
          reads.push(request.searchParams.get('after') ?? 'first');
          return { status: 200, body: { data: [
            { id: '1234_1', message: 'Hello https://example.com/p?utm_source=calendar', scheduled_publish_time: '2027-01-02T10:05:00Z', is_published: false, from: { id: pageId } },
            { id: '5678_2', scheduled_publish_time: '2027-01-02T10:00:00Z', is_published: false, from: { id: '5678' } },
            { id: '1234_3', scheduled_publish_time: '2027-01-02T10:00:00Z', is_published: true, from: { id: pageId } },
          ], paging: request.searchParams.has('after') ? undefined : { next: 'https://unused.example/', cursors: { after: 'next-page' } } } };
        } }),
    } });
    ctx.update('social_account', account.id, { external_account_id: pageId });
    await expect(run('publishing_reconcile_platform_schedule', {}, account.id)).rejects.toMatchObject({ code: 'PLATFORM_SCHEDULE_AUTHORIZATION_REQUIRED' });
    expect(reads).toEqual([]);
    const services = (ctx as Context & { planningAccountServices: Parameters<typeof startOAuth>[3] }).planningAccountServices;
    const { authorize_url } = startOAuth(ctx, { brand_id: 'brand', scopes }, 'meta_facebook', services);
    const state = new URL(authorize_url).searchParams.get('state')!;
    const { connection } = await completeOAuth(ctx, 'meta_facebook', { state, code: 'fixture' }, services);
    if (typeof connection?.id !== 'string') throw new Error('OAuth fixture did not return a connection');
    ctx.create('social_account_connection', { social_account_id: account.id, connection_id: connection.id, status: 'active' });
    const link = 'https://example.com/p?utm_source=calendar';
    ctx.update('content_revision', revision.id, { rendered: { text: `Hello ${link}` }, link_refs: [{ url: link }] });
    const first = target();
    submit(first.id);
    approve(first.id);
    const getSchedule = (query: Record<string, string> = {}) => run('publishing_reconcile_platform_schedule', {}, account.id, 'owner', undefined, query);
    expect(await getSchedule()).toMatchObject({ next_cursor: 'next-page', entries: [{ external_schedule_id: '1234_1', match_status: 'suggested', candidates: [{ publish_target_id: first.id, highlighted: true }] }] });
    const second = target();
    const before = structuredClone(ctx.list('publish_target'));
    const tasks = structuredClone(ctx.list('execution_task'));
    expect(await getSchedule({ provider_cursor: 'next-page' })).toMatchObject({ next_cursor: null, entries: [{
      external_schedule_id: '1234_1', platform_scheduled_at: '2027-01-02T10:05:00.000Z', status: 'scheduled_on_platform', match_status: 'uncertain',
      candidates: [first, second].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ publish_target_id: row.id, score: 0.9, highlighted: false })),
    }] });
    expect(reads).toEqual(['first', 'next-page']);
    expect(ctx.list('publish_target')).toEqual(before);
    expect(ctx.list('execution_task')).toEqual(tasks);
    expect(ctx.list('platform_post')).toEqual([]);
    expect(ctx.list('reconciliation_candidate')).toEqual([]);
    expect(() => run('publishing_reconcile_platform_schedule', {}, account.id, 'agent')).toThrow(Problem);
  });

  it('rechecks a changed evergreen revision before requesting fresh approval and retires expired unsent occurrences', () => {
    const { ctx, run, row, approve, content, account, variant, revision } = fixture();
    const queue = run('publishing_create_evergreen_queue', { category: 'Guides', social_account_ids: [account.id],
      slots: [{ social_account_id: account.id, weekday: 5, local_time: '12:00' }], horizon_days: 14 }) as Row;
    const entry = run('publishing_add_evergreen_item', { content_item_id: content.id, variant_map: { [account.id]: variant.id }, expires_at: '2027-01-04T00:00:00Z' }, queue.id) as Row;
    expect(run('publishing_expand_evergreen', { dry_run: true }, queue.id)).toEqual([
      expect.objectContaining({ revision_id: revision.id, at: '2027-01-01T12:00:00.000Z' }), expect.objectContaining({ status: 'no_eligible_content' }),
    ]);
    expect(ctx.list('publish_target')).toEqual([]);
    scanPlanningDue(ctx);
    const [expanded] = ctx.list('publish_target');
    expect(expanded).toMatchObject({ variant_revision_id: revision.id, plan_status: 'awaiting_approval', evergreen_queue_item_id: entry.id });
    const ready = approve(expanded.id);
    const originalTask = structuredClone(ctx.list('execution_task')[0]);
    const edited = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'v2', rendered: { text: 'Revised mother content' }, media: [] });
    onRevisionCreated(ctx, ctx.update('content_variant', variant.id, { current_revision_id: edited.id }), edited);
    scanPlanningDue(ctx);
    const replay = row(ready.id);
    expect(replay).toMatchObject({ variant_revision_id: edited.id, plan_status: 'awaiting_approval', scheduled_at: ready.scheduled_at });
    expect(replay.frozen_hash).not.toEqual(ready.frozen_hash);
    expect(ctx.get('precheck_run', String(replay.last_precheck_run_id))).toMatchObject({ stage: 'schedule' });
    expect(ctx.get('approval_request', String(ready.approval_request_id))).toMatchObject({ status: 'invalidated' });
    expect(ctx.get('approval_request', String(replay.approval_request_id))).toMatchObject({ status: 'pending' });
    expect(ctx.list('execution_task')[0]).toMatchObject({ status: 'blocked', frozen: originalTask.frozen });
    expect(() => run('publishing_approve', { resource_hash: ready.frozen_hash }, replay.id, 'owner', replay.version)).toThrowError(expect.objectContaining({ code: 'APPROVAL_STALE' }));
    approve(replay.id);
    ctx.now = '2027-01-04T00:00:00.000Z';
    expect(assessTarget(ctx, row(replay.id), 'execution').items).toContainEqual(expect.objectContaining({ check_key: 'evergreen_expired', severity: 'blocker' }));
    scanPlanningDue(ctx);
    expect(ctx.get('evergreen_queue_item', entry.id)).toMatchObject({ status: 'expired', use_count: 1 });
    expect(row(ready.id)).toMatchObject({ plan_status: 'closed', close_reason: 'expired_skipped', scheduled_at: ready.scheduled_at });
    expect(ctx.list('execution_task')).toContainEqual(expect.objectContaining({ status: 'cancelled', publish_target_id: ready.id }));
    expect(ctx.list('publish_target')).toHaveLength(1);
  });

  it('refreshes a preflight within one hour and skips a still-valid check', () => {
    const { ctx, target, submit, approve, row } = fixture();
    const draft = target('2027-01-01T10:30:00Z');
    submit(draft.id);
    approve(draft.id);
    scanPlanningDue(ctx);
    const runId = row(draft.id).last_precheck_run_id;
    expect(ctx.get('precheck_run', String(runId))).toMatchObject({ stage: 'preflight' });
    scanPlanningDue(ctx);
    expect(row(draft.id).last_precheck_run_id).toBe(runId);
  });

  it('expands recurring rules during the scheduled scan and deduplicates the same day', () => {
    const { ctx, run, account, variant } = fixture();
    run('publishing_create_schedule_rule', { rrule: { freq: 'daily', local_time: '12:00' }, starts_on: '2027-01-01', horizon_days: 2, content_source: { social_account_id: account.id, content_variant_id: variant.id } });
    scanPlanningDue(ctx);
    scanPlanningDue(ctx);
    expect(ctx.list('publish_target').map(row => row.occurrence_day)).toEqual(['2027-01-01', '2027-01-02']);
    expect(ctx.list('planning_expansion_cursor')).toHaveLength(1);
    ctx.now = '2027-01-02T10:00:00.000Z';
    scanPlanningDue(ctx);
    expect(ctx.list('publish_target').map(row => row.occurrence_day)).toEqual(['2027-01-01', '2027-01-02', '2027-01-03']);
  });

  it('takes a licensed asset through a content revision, approval and evidence-backed manual publication', async () => {
    const { ctx, run, submit, approve } = fixture();
    const brand = ctx.create('brand', { name: 'New brand' });
    const account = ctx.create('social_account', { provider: 'meta_facebook', brand_id: brand.id, status: 'active', default_timezone: 'UTC' });
    const file = ctx.create('file_object', { purpose: 'asset', scan_status: 'clean', mime_type: 'image/png', sha256: 'a'.repeat(64) });
    const asset = await run('asset_create', { brand_id: brand.id, file_object_id: file.id, kind: 'image', title: 'Licensed photo' }) as Row;
    const grant = await run('rights_create_draft', { brand_id: brand.id, grant_type: 'owned', asset_ids: [asset.id], usages: ['organic_social'], platforms: ['facebook'], valid_until: '2027-02-01T00:00:00Z' }) as Row;
    await run('rights_activate', {}, grant.id, 'owner', grant.version);
    const result = await run('content_create_draft', { brand_id: brand.id, title: 'Release', variants: [{ platform: 'facebook', format: 'feed_image', body_markdown: 'New release', asset_version_ids: [asset.current_version_id] }] }) as { variants: Row[]; revisions: Row[] };
    const [variant] = result.variants;
    const target = await run('publishing_create_target', { social_account_id: account.id, content_variant_id: variant.id, schedule_kind: 'asap' }) as Row;
    expect(submit(target.id).plan_status).toBe('awaiting_approval');
    expect(approve(target.id).plan_status).toBe('ready');
    expect(ctx.list('publish_target_ref')).toContainEqual(expect.objectContaining({ ref_type: 'rights_grant', ref_id: grant.id }));
    const task = ctx.list('execution_task')[0];
    const evidence = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
    const post = await run('publishing_register_post', { permalink: 'https://www.facebook.com/example/posts/33', evidence_file_ids: [evidence.id] }, target.id) as Row;
    expect(post).toMatchObject({ verification: 'manual_confirmed', publish_target_id: target.id });
    expect(ctx.get('execution_task', task.id).status).toBe('published');
    expect(ctx.get('publish_target', target.id).plan_status).toBe('closed');
  });
});

// ---------- Phase 1 channels: approval policy and resubmission (phase1-design §4, S2) ----------

async function channelFixture(provider: 'x' | 'tiktok' = 'x', approval: 'direct' | 'needs_approval' = 'needs_approval') {
  const base = fixture();
  const { ctx, run } = base;
  ctx.create('workspace', { name: 'Fixture', default_timezone: 'UTC' });
  const device = ctx.create('connector_device', { name: 'mac-b.local', display_name: 'Mac-B', status: 'active', last_seen_at: ctx.now });
  const channel = ctx.create('social_account', { provider, status: 'active', brand_id: 'brand', default_timezone: 'UTC', handle: 'lurelab', external_account_id: provider === 'x' ? 'lurelab' : '7000000001' });
  const binding = ctx.create('account_execution_binding', { social_account_id: channel.id, mode: 'connector', connector_channel: 'browser', device_id: device.id, connector_mode: 'assist' });
  ctx.create('browser_session', { binding_id: binding.id, device_id: device.id, social_account_id: channel.id, status: 'verified' });
  const created = ensureChannelSettings(ctx, channel.id);
  ctx.update('channel_settings', created.id, {
    approval_mode: approval, automation_notice_ack: { at: ctx.now, via: 'worker_app', by: `device:${device.id}`, version: AUTOMATION_NOTICE_VERSION },
    risk_ack: { at: ctx.now, by_user_id: 'owner', terms_version: RISK_TERMS_VERSION, text_sha256: 'f'.repeat(64) },
  });
  const file = ctx.create('file_object', { purpose: 'asset', sha256: 'b'.repeat(64), scan_status: 'skipped', mime_type: 'video/mp4', byte_size: 30_000_000 });
  const asset = ctx.create('asset', { kind: 'video', brand_id: null, ownership: 'owned', origin: 'agent_upload', status: 'ready', title: 'video.mp4' });
  const version = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id, sha256: 'b'.repeat(64), mime_type: 'video/mp4', meta: { duration_ms: 12_000 } });
  ctx.update('asset', asset.id, { current_version_id: version.id });
  const draft = await run('content_create_draft', { brand_id: 'brand', title: 'Lure clip', variants: [{ platform: provider, format: 'short_video', social_account_id: channel.id,
    body: 'New lure test', media: [{ asset_id: asset.id, asset_version_id: version.id, role: 'primary' }] }] }) as { variants: Row[] };
  const clip = draft.variants[0];
  const settings = () => ensureChannelSettings(ctx, channel.id);
  const schedule = (scheduled_at = '2027-01-02T10:00:00Z') => run('publishing_create_target', { social_account_id: channel.id, content_variant_id: clip.id, scheduled_at, late_policy: 'skip', grace_minutes: 30 }) as Row;
  const request = (target: Row) => ctx.list('approval_request').find(row => row.id === base.row(target.id).approval_request_id);
  /** The §4 invariant: a waiting target always holds a pending request. */
  const holdsPending = (target: Row) => {
    const current = base.row(target.id);
    return current.plan_status !== 'awaiting_approval' || request(current)?.status === 'pending';
  };
  const save = (body: Data) => run('hub_channels_update_settings', body, channel.id, 'owner', settings().version) as Promise<Data> | Data;
  return { ...base, device, channel, binding, clip, asset, version, settings, schedule, request, holdsPending, save };
}

describe('phase 1 channel approval', () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  it('approves a direct channel on submit as channel_policy bound to the approval generation', async () => {
    const { ctx, submit, schedule, request, settings, events } = await channelFixture('x', 'direct');
    const target = schedule();
    const ready = submit(target.id);
    expect(ready.plan_status).toBe('ready');
    expect(request(ready)).toMatchObject({ status: 'approved', approved_via: 'channel_policy', channel_approval_generation: settings().approval_generation, standing_grant_id: null });
    expect(ctx.list('execution_task')).toHaveLength(1);
    expect(events.some(event => event.type === 'core.approval_request.approved')).toBe(true);
  });

  // E34 replaces the old min(now + 48 h, scheduled_at + lateness) deadline, which this test used to assert for the far post: a
  // request expired after 48 h while every view still asked for an approval the hub then refused (F3, WV-2, COH-1).
  it('a needs_approval channel waits for the owner until scheduled_at + lateness, however far ahead the post is (E34)', async () => {
    const { ctx, submit, schedule, request, approve, row, holdsPending } = await channelFixture('x');
    const far = schedule('2027-01-05T10:00:00Z');
    expect(submit(far.id).plan_status).toBe('awaiting_approval');
    expect(request(far)).toMatchObject({ status: 'pending', approved_via: null, due_at: '2027-01-05T10:30:00.000Z' });   // no 48 h cap
    expect(request(far)!.due_at).toBe(approvalDeadline(ctx, row(far.id)));
    // 49 hours later the scan keeps it pending, the post still holds its request and the owner can approve it.
    ctx.now = '2027-01-03T11:00:00.000Z';
    scanPlanningDue(ctx);
    expect(request(far)!.status).toBe('pending');
    expect(holdsPending(far)).toBe(true);
    expect(approve(far.id).plan_status).toBe('ready');
    ctx.now = '2027-01-01T10:00:00.000Z';
    const near = schedule('2027-01-02T10:00:00Z');
    submit(near.id);
    expect(request(near)!.due_at).toBe('2027-01-02T10:30:00.000Z');   // scheduled_at + 30 min wins
    expect(approvalDeadline(ctx, ctx.get('publish_target', near.id))).toBe('2027-01-02T10:30:00.000Z');
    expect(approve(near.id).plan_status).toBe('ready');
    expect(request(near)!.approved_via).toBe('human');
  });

  it('a pending request kept under the reschedule tolerance moves its deadline with the post', async () => {
    const { ctx, submit, schedule, request, row } = await channelFixture('x');
    const target = schedule('2027-01-02T10:00:00Z');
    submit(target.id);
    const kept = updateTarget(ctx, row(target.id), { scheduled_at: '2027-01-02T10:40:00Z' }, true);
    expect(kept.approval_retained).toBe(true);
    expect(request(target)).toMatchObject({ status: 'pending', due_at: '2027-01-02T11:10:00.000Z' });
  });

  it('an unapproved post past its deadline expires and derives as missed; rescheduling resubmits it', async () => {
    const { ctx, run, submit, schedule, request, row, holdsPending } = await channelFixture('x');
    const target = schedule('2027-01-01T11:00:00Z');
    submit(target.id);
    ctx.now = '2027-01-01T11:31:00.000Z';
    scanPlanningDue(ctx);
    expect(request(target)!.status).toBe('expired');
    const lapsed = time(approvalDeadline(ctx, row(target.id))!) <= time(ctx.now);
    expect(derivePostStatus({ plan_status: String(row(target.id).plan_status), has_platform_post: false, approval_lapsed: lapsed })).toBe('missed');
    expect(() => run('publishing_approve', {}, target.id, 'owner', row(target.id).version)).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
    const moved = run('publishing_reschedule', { scheduled_at: '2027-01-02T09:00:00Z' }, target.id, 'owner', row(target.id).version) as Row;
    expect(moved.approval_retained).toBe(false);
    expect(request(target)).toMatchObject({ status: 'pending', due_at: '2027-01-02T09:30:00.000Z' });
    expect(holdsPending(target)).toBe(true);
  });

  it('a reschedule outside tolerance resubmits: pending for needs_approval, auto-approved for direct', async () => {
    for (const mode of ['needs_approval', 'direct'] as const) {
      const { ctx, submit, approve, schedule, request, row, holdsPending } = await channelFixture('x', mode);
      const target = schedule();
      const first = submit(target.id);
      if (mode === 'needs_approval') approve(first.id);
      expect(row(target.id).plan_status).toBe('ready');
      // The post_update path (S4): updateTarget, then submit() whenever the approval was not retained.
      const moved = updateTarget(ctx, row(target.id), { scheduled_at: '2027-01-03T15:00:00Z' }, true);
      expect(moved.approval_retained).toBe(false);
      if (!moved.approval_retained) submitTarget(ctx, row(target.id));
      expect(row(target.id).plan_status).toBe(mode === 'direct' ? 'ready' : 'awaiting_approval');
      expect(request(target)).toMatchObject(mode === 'direct' ? { status: 'approved', approved_via: 'channel_policy' } : { status: 'pending' });
      expect(holdsPending(target)).toBe(true);
    }
  });

  it('a caption edit commits a revision, rebinds the target and resubmits it', async () => {
    const { ctx, submit, approve, schedule, request, row, clip, holdsPending } = await channelFixture('x');
    const target = schedule();
    approve(submit(target.id).id);
    const { revision_id, changed } = await commitVariantRevision(ctx, clip.id, { body: 'A sharper caption #lure' });
    expect(changed).toBe(true);
    expect(ctx.get('content_revision', revision_id).rendered).toMatchObject({ text: 'A sharper caption #lure' });
    expect(ctx.get('content_revision', revision_id).media).toHaveLength(1);
    const edited = updateTarget(ctx, row(target.id), { variant_revision_id: revision_id });
    expect(edited.approval_retained).toBe(false);
    submitTarget(ctx, row(target.id));
    expect(row(target.id)).toMatchObject({ plan_status: 'awaiting_approval', variant_revision_id: revision_id });
    expect(request(target)!.status).toBe('pending');
    expect(holdsPending(target)).toBe(true);
    expect(await commitVariantRevision(ctx, clip.id, { body: 'A sharper caption #lure' })).toEqual({ revision_id, changed: false });
  });

  it('switching needs_approval → direct retires the pending request first and then auto-approves', async () => {
    const { ctx, submit, schedule, request, save, settings, events } = await channelFixture('x');
    const target = schedule();
    submit(target.id);
    const pending = request(target)!;
    const before = settings();
    const result = await save({ approval_mode: 'direct' }) as Data;
    expect(result).toMatchObject({ requeued_posts: 1, revoked_posts: 0, changed_fields: ['approval_mode'] });
    expect(ctx.get('approval_request', pending.id)).toMatchObject({ status: 'invalidated', invalidated_reason: 'channel_approval_mode_changed' });
    expect(request(target)).toMatchObject({ status: 'approved', approved_via: 'channel_policy', channel_approval_generation: before.approval_generation + 1 });
    expect(ctx.get('publish_target', target.id).plan_status).toBe('ready');
    expect(events.find(event => event.type === 'account.channel_settings.changed')?.payload).toMatchObject({ social_account_id: target.social_account_id, approval_mode_changed: true, fields: ['approval_mode'] });
  });

  it('switching direct → needs_approval withdraws channel-policy approvals and leaves each post with a pending request', async () => {
    const { ctx, submit, schedule, request, save, holdsPending } = await channelFixture('x', 'direct');
    const revoked: string[] = [];
    // Each call records the post's state as the engine sees it (revoke.ts re-reads the target) and whether it still holds a
    // pending request then.
    restore = setWorkerEngineHooks({ revokeForTarget: (hookCtx, target, reason) => {
      const current = hookCtx.get('publish_target', target.id);
      revoked.push(`${target.id}:${reason}:${String(current.plan_status)}:${String(request(current)?.status)}`);
    } });
    const target = schedule();
    const other = schedule('2027-01-02T12:00:00Z');
    submit(target.id);
    submit(other.id);
    const task = ctx.list('execution_task').find(row => row.publish_target_id === target.id)!;
    ctx.update('execution_task', task.id, { route: [{ executor: 'worker', device_id: 'device' }] });
    const result = await save({ approval_mode: 'needs_approval' }) as Data;
    expect(result).toMatchObject({ requeued_posts: 2, revoked_posts: 2 });
    for (const row of [target, other]) {
      expect(ctx.get('publish_target', row.id).plan_status).toBe('awaiting_approval');
      expect(request(row)).toMatchObject({ status: 'pending', approved_via: null });
      expect(holdsPending(row)).toBe(true);
    }
    // S3 review: ensureTask routes both direct posts to the Worker, so retiring each channel-policy approval asks the engine
    // to revoke while the post is still ready (the engine keeps a matching unstarted job then, §5.10). E23: once the post has
    // left ready, the engine is asked again in the same transaction, before the new request exists, so the unstarted job is
    // withdrawn at once. Exactly one such pair per post, in post order (§4.1 table).
    expect(revoked).toEqual([
      `${target.id}:approval_invalidated:ready:invalidated`, `${target.id}:approval_invalidated:awaiting_approval:invalidated`,
      `${other.id}:approval_invalidated:ready:invalidated`, `${other.id}:approval_invalidated:awaiting_approval:invalidated`,
    ]);
    expect(ctx.get('execution_task', task.id).status).toBe('scheduled');   // the job engine owns Worker task state
  });

  it('a person-approved post keeps its approval when the channel switches to direct and back', async () => {
    const { submit, approve, schedule, request, save } = await channelFixture('x');
    const target = schedule();
    approve(submit(target.id).id);
    await save({ approval_mode: 'direct' });
    expect(request(target)).toMatchObject({ status: 'approved', approved_via: 'human' });
    await save({ approval_mode: 'needs_approval' });
    expect(request(target)).toMatchObject({ status: 'approved', approved_via: 'human' });
  });

  it('posting.unblock: new TikTok defaults become a revision, the target is rebound, and it resubmits with ai_generated', async () => {
    for (const mode of ['needs_approval', 'direct'] as const) {
      const { ctx, schedule, request, row, clip, save, settings, holdsPending } = await channelFixture('tiktok', mode);
      const target = schedule();
      const blocked = submitTarget(ctx, row(target.id));
      expect(blocked.submission_status).toBe('blocked');
      expect(ctx.list('precheck_item').some(item => item.check_key === 'channel_defaults' && item.severity === 'blocker')).toBe(true);
      await save({ platform_defaults: { tiktok: { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: true, allow_stitch: true, commercial_disclosure: 'none', ai_generated: true } } });
      // S4's posting.unblock: applyChannelDefaults → updateTarget(variant_revision_id) → submit().
      const applied = await applyChannelDefaults(ctx, clip.id, settings().platform_defaults);
      expect(applied.changed).toBe(true);
      const revision = ctx.get('content_revision', applied.revision_id);
      expect(revision).toMatchObject({ origin: 'channel_defaults', created_by_type: 'system' });
      expect((revision.settings as { platform_options: Data }).platform_options.tiktok).toMatchObject({ privacy_level: 'SELF_ONLY', allow_duet: true, allow_stitch: true, ai_generated: true });
      updateTarget(ctx, row(target.id), { variant_revision_id: applied.revision_id });
      const resubmitted = submitTarget(ctx, row(target.id));
      expect(resubmitted.submission_status).toBeUndefined();
      expect(row(target.id).plan_status).toBe(mode === 'direct' ? 'ready' : 'awaiting_approval');
      expect(holdsPending(target)).toBe(true);
      expect(request(target)!.status).toBe(mode === 'direct' ? 'approved' : 'pending');
      const payload = assessTarget(ctx, row(target.id), 'schedule').payload;
      expect((payload.options as Data).platform_options).toMatchObject({ tiktok: { ai_generated: true } });
      expect(await applyChannelDefaults(ctx, clip.id, settings().platform_defaults)).toEqual({ revision_id: applied.revision_id, changed: false });
    }
  });

  it('blockUnsent never writes a Worker-route task; an invalid approval asks the job engine to revoke', async () => {
    const { ctx, submit, schedule, row, device } = await channelFixture('x', 'direct');
    const revoked: string[] = [];
    restore = setWorkerEngineHooks({ revokeForTarget: (_ctx, target, reason) => { revoked.push(`${target.id}:${reason}`); } });
    const target = schedule('2027-01-01T10:40:00Z');
    submit(target.id);
    const task = ctx.list('execution_task').find(item => item.publish_target_id === target.id)!;
    ctx.update('execution_task', task.id, { route: [{ executor: 'worker', device_id: device.id }] });
    ctx.update('connector_device', device.id, { paused: true });
    scanPlanningDue(ctx);
    expect(ctx.list('precheck_run').at(-1)).toMatchObject({ stage: 'preflight', overall: 'blocked' });
    expect(ctx.get('execution_task', task.id).status).toBe('scheduled');
    expect(revoked).toEqual([]);
    ctx.update('connector_device', device.id, { paused: false });
    const request = ctx.get('approval_request', String(row(target.id).approval_request_id));
    ctx.update('approval_request', request.id, { status: 'invalidated' });
    applyPlanningEvent(ctx, { type: 'core.approval_request.invalidated', payload: { request_id: request.id } });
    expect(revoked).toEqual([`${target.id}:approval_invalidated`]);
    expect(ctx.get('execution_task', task.id).status).toBe('scheduled');
    // The direct channel resubmits at once, so the post is not left waiting without a request (§4 common rule).
    expect(row(target.id).plan_status).toBe('ready');
  });

  it('pausing and releasing a scope tells the machines of the affected channels to resync', async () => {
    const { run, channel, device, schedule, submit } = await channelFixture('x', 'direct');
    const bumps: string[] = [];
    restore = setWorkerEngineHooks({ bumpSyncGeneration: (_ctx, ids, reason) => { bumps.push(`${ids.join(',')}:${reason}`); return bumps.length; } });
    submit(schedule().id);
    const pause = run('publishing_pause', { scope_type: 'social_account', scope_id: channel.id, reason: 'Owner stop' }) as Row;
    run('publishing_release_pause', {}, pause.id);
    const brandPause = run('publishing_pause', { scope_type: 'workspace', reason: 'Everything' }) as Row;
    expect(brandPause.scope_type).toBe('workspace');
    expect(bumps).toEqual([`${device.id}:pause_activated`, `${device.id}:pause_released`, `${device.id}:pause_activated`]);
  });

  it('with the job engine installed, withdrawing a direct approval revokes the unstarted job in the same transaction (E23) instead of refusing', async () => {
    const { ctx, submit, schedule, save, row, request, approve, device } = await channelFixture('x', 'direct');
    const target = schedule();
    submit(target.id);
    const job = ctx.list('worker_job').find(item => item.publish_target_id === target.id)!;
    expect(job).toMatchObject({ status: 'queued', kind: 'publish_post' });
    expect(row(target.id).worker_job_id).toBe(job.id);
    const task = ctx.list('execution_task').find(item => item.publish_target_id === target.id)!;
    const result = await save({ approval_mode: 'needs_approval' }) as Data;
    expect(result).toMatchObject({ requeued_posts: 1, revoked_posts: 1 });
    // E23: the post left ready, so its queued job is withdrawn now (C3: queued → cancelled at once), not by the lifecycle scan.
    expect(ctx.get('worker_job', job.id)).toMatchObject({ status: 'cancelled', revoke: { reason: 'approval_invalidated', requested_at: ctx.now }, finished_at: ctx.now });
    expect(ctx.list('worker_job_event').filter(event => event.job_id === job.id && event.event !== 'dispatched')
      .map(event => [event.event, (event.detail as Data).reason, (event.detail as Data).outcome]))
      .toEqual([['revoke_requested', 'approval_invalidated', 'cancelled_unclaimed']]);   // one revoke, not one per call
    expect(ctx.list('worker_job').filter(item => item.publish_target_id === target.id && !['cancelled', 'superseded'].includes(String(item.status)))).toEqual([]);
    // Only the job is withdrawn: the post waits for the owner (「待你核准」) and its task is not cancelled.
    expect(row(target.id).plan_status).toBe('awaiting_approval');
    expect(request(target)).toMatchObject({ status: 'pending', approved_via: null });
    expect(ctx.get('execution_task', task.id).status).toBe(task.status);
    expect(ctx.get('execution_task', task.id).cancel_requested_at).toBeFalsy();
    // Approving again sends a new job to the machine; the withdrawn one is never reused.
    approve(target.id);
    const fresh = ctx.list('worker_job').filter(item => item.publish_target_id === target.id && item.status === 'queued');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ kind: 'publish_post', device_id: device.id });
    expect(fresh[0].id).not.toBe(job.id);
    expect(row(target.id)).toMatchObject({ plan_status: 'ready', worker_job_id: fresh[0].id });
  });

  it('direct → needs_approval: a claimed job is released, a started job follows §5.10 and its post is not resubmitted (E23)', async () => {
    for (const state of ['claimed', 'running'] as const) {
      const { ctx, submit, schedule, save, row, request, device } = await channelFixture('x', 'direct');
      const target = schedule();
      submit(target.id);
      const queued = ctx.list('worker_job').find(item => item.publish_target_id === target.id)!;
      const job = setJob(ctx, queued, state === 'claimed' ? { status: 'claimed', claimed_at: ctx.now } : { status: 'running', claimed_at: ctx.now, started_at: ctx.now });
      const generation = deviceSyncState(ctx, device.id).generation;
      const result = await save({ approval_mode: 'needs_approval' }) as Data;
      const after = ctx.get('worker_job', job.id);
      expect(after.revoke).toEqual({ reason: 'approval_invalidated', requested_at: ctx.now });
      expect(deviceSyncState(ctx, device.id)).toMatchObject({ reason: 'job_revoked' });
      expect(deviceSyncState(ctx, device.id).generation).toBeGreaterThan(generation);
      if (state === 'claimed') {
        // Not started: the machine gives it back on its next heartbeat; the post waits for the owner at once.
        expect(after.status).toBe('releasing');
        expect(result).toMatchObject({ requeued_posts: 1, revoked_posts: 1 });
        expect(row(target.id).plan_status).toBe('awaiting_approval');
        expect(request(target)).toMatchObject({ status: 'pending' });
      } else {
        // Started: only the Worker's check before the click can stop it, so the job keeps running with the revoke pending and
        // the post is not resubmitted until the job is resolved (E23 「已開跑的 job 仍依 §5.10」).
        expect(after.status).toBe('running');
        expect(result).toMatchObject({ requeued_posts: 0, revoked_posts: 1 });
        expect(row(target.id).plan_status).toBe('ready');
        expect(request(target)).toMatchObject({ status: 'invalidated', invalidated_reason: 'channel_approval_mode_changed' });
      }
    }
  });
});

const time = (value: string) => Date.parse(value);

// ---------- Wave 6 (G2): E34, E35, E37, F4, F10 ----------

describe('wave 6 posting fixes (planning)', () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  it('E34: a request written with the old 48 h cap that expires before the post can still go out is replaced by a fresh pending one', async () => {
    const { ctx, run, submit, schedule, request, row, holdsPending } = await channelFixture('x');
    const target = schedule('2027-01-05T10:00:00Z');
    submit(target.id);
    const legacy = request(target)!;
    ctx.update('approval_request', legacy.id, { due_at: '2027-01-03T10:00:00.000Z' });   // as submitted before E34
    ctx.now = '2027-01-03T11:00:00.000Z';
    scanPlanningDue(ctx);
    expect(ctx.get('approval_request', legacy.id)).toMatchObject({ status: 'expired', invalidated_reason: 'deadline_elapsed' });
    expect(request(target)).toMatchObject({ status: 'pending', due_at: '2027-01-05T10:30:00.000Z' });
    expect(holdsPending(target)).toBe(true);
    expect((run('publishing_approve', {}, target.id, 'owner', row(target.id).version) as Row).plan_status).toBe('ready');
  });

  it('F4: a direct post whose edit is blocked becomes draft (blocked, not submitted) and its stale job is revoked in the same transaction', async () => {
    const { ctx, submit, schedule, request, row, clip } = await channelFixture('x', 'direct');
    const target = schedule();
    submit(target.id);
    const job = ctx.list('worker_job').find(item => item.publish_target_id === target.id)!;
    const approved = request(target)!;
    expect([row(target.id).plan_status, job.status]).toEqual(['ready', 'queued']);
    // The post_update edit_caption path: commit, rebind (approval dropped), resubmit. 150 CJK characters weigh 300 > 280.
    const { revision_id } = await commitVariantRevision(ctx, clip.id, { body: '新'.repeat(150) });
    const edited = updateTarget(ctx, row(target.id), { variant_revision_id: revision_id });
    expect(edited.approval_retained).toBe(false);
    const result = resubmitIfWaiting(ctx, target.id);
    expect(result.submission_status).toBe('blocked');
    expect(row(target.id)).toMatchObject({ plan_status: 'draft', precheck_summary: 'blocked', frozen_hash: null, auto_submit_on_unblock: true });
    expect(ctx.get('approval_request', approved.id).status).toBe('invalidated');
    expect(ctx.get('worker_job', job.id)).toMatchObject({ status: 'cancelled', revoke: { reason: 'approval_invalidated' } });
    expect(derivePostStatus({ plan_status: String(row(target.id).plan_status), precheck_summary: 'blocked', has_platform_post: false, job_status: 'cancelled' })).toBe('blocked');
    // A caption that fits submits it again: the direct channel approves and a new job goes to the machine.
    const fixed = await commitVariantRevision(ctx, clip.id, { body: '新'.repeat(100) });
    updateTarget(ctx, row(target.id), { variant_revision_id: fixed.revision_id });
    submitTarget(ctx, row(target.id));
    expect(row(target.id).plan_status).toBe('ready');
    expect(ctx.list('worker_job').filter(item => item.publish_target_id === target.id && item.status === 'queued')).toHaveLength(1);
  });

  it('E35: posts scheduled, rescheduled or switched to needs_approval during a pause are submitted again when it is released', async () => {
    const { ctx, run, submit, schedule, request, row, channel, save, holdsPending } = await channelFixture('x', 'direct');
    const ready = schedule('2027-01-02T10:00:00Z');
    const moved = schedule('2027-01-02T12:00:00Z');
    submit(ready.id);
    submit(moved.id);
    const pause = run('publishing_pause', { scope_type: 'social_account', scope_id: channel.id, reason: 'Owner on holiday' }) as Row;
    expect([row(ready.id).plan_status, row(moved.id).plan_status]).toEqual(['paused', 'paused']);
    // (a) The Agent schedules a new post while paused: blocked by the pause, never submitted.
    const fresh = schedule('2027-01-03T10:00:00Z');
    ctx.update('publish_target', fresh.id, { auto_submit_on_unblock: true });   // as post_schedule creates it
    expect(submitTarget(ctx, row(fresh.id)).submission_status).toBe('blocked');
    // (b) The Agent moves a paused post by a day: the approval is dropped and the resubmission is blocked → draft, not 「待你核准」.
    const rescheduled = updateTarget(ctx, row(moved.id), { scheduled_at: '2027-01-03T12:00:00Z' }, true);
    expect(rescheduled.approval_retained).toBe(false);
    resubmitIfWaiting(ctx, moved.id);
    expect(row(moved.id)).toMatchObject({ plan_status: 'draft', precheck_summary: 'blocked' });
    // (c) The owner switches the paused channel to needs_approval: the paused post loses its channel-policy approval.
    await save({ approval_mode: 'needs_approval' });
    expect(row(ready.id)).toMatchObject({ plan_status: 'draft', precheck_summary: 'blocked' });
    run('publishing_release_pause', {}, pause.id);
    for (const target of [ready, moved, fresh]) {
      expect(row(target.id).plan_status).toBe('awaiting_approval');
      expect(request(target)).toMatchObject({ status: 'pending', due_at: approvalDeadline(ctx, row(target.id)) });
      expect(holdsPending(target)).toBe(true);
    }
  });

  it('E35: on a direct channel the released posts are approved by the channel policy and dispatched', async () => {
    const { ctx, run, submit, schedule, row, channel } = await channelFixture('x', 'direct');
    const pause = run('publishing_pause', { scope_type: 'workspace', reason: 'Stop everything' }) as Row;
    const fresh = schedule('2027-01-03T10:00:00Z');
    ctx.update('publish_target', fresh.id, { auto_submit_on_unblock: true });
    expect(submit(fresh.id).plan_status).toBe('draft');
    const other = run('publishing_pause', { scope_type: 'social_account', scope_id: channel.id, reason: 'Check this channel' }) as Row;
    run('publishing_release_pause', {}, pause.id);
    expect(row(fresh.id).plan_status).toBe('draft');   // the channel pause still holds it
    run('publishing_release_pause', {}, other.id);
    expect(row(fresh.id).plan_status).toBe('ready');
    expect(ctx.list('worker_job').filter(item => item.publish_target_id === fresh.id && item.status === 'queued')).toHaveLength(1);
  });

  it('E35: resuming a paused machine submits the posts it held before approval', async () => {
    const { ctx, run, schedule, row, device, request, holdsPending } = await channelFixture('x');
    ctx.update('connector_device', device.id, { paused: true });
    const target = schedule('2027-01-03T10:00:00Z');
    ctx.update('publish_target', target.id, { auto_submit_on_unblock: true });
    expect(submitTarget(ctx, row(target.id)).submission_status).toBe('blocked');
    run('hub_machines_resume', {}, device.id);
    expect(row(target.id).plan_status).toBe('awaiting_approval');
    expect(request(target)!.status).toBe('pending');
    expect(holdsPending(target)).toBe(true);
  });

  it('E35/F10: a hub post that missed its window during a pause is not closed on release; it reports missed and can be rescheduled', async () => {
    const { ctx, run, submit, schedule, row, channel, request } = await channelFixture('x', 'direct');
    const target = schedule('2027-01-01T10:30:00Z');
    submit(target.id);
    const job = ctx.list('worker_job').find(item => item.publish_target_id === target.id)!;
    const pause = run('publishing_pause', { scope_type: 'social_account', scope_id: channel.id, reason: 'Owner stop' }) as Row;
    ctx.now = '2027-01-01T11:30:00.000Z';   // past 10:30 + 30 min
    run('publishing_release_pause', {}, pause.id);
    expect(row(target.id)).toMatchObject({ plan_status: 'ready', paused_by_switch_id: null });
    expect(row(target.id).close_reason).toBeUndefined();
    expect(ctx.list('worker_job').filter(item => item.publish_target_id === target.id).map(item => item.id)).toEqual([job.id]);   // no second run
    setJob(ctx, ctx.get('worker_job', job.id), { status: 'missed', finished_at: ctx.now });   // what the lifecycle reports next
    expect(derivePostStatus({ plan_status: 'ready', has_platform_post: false, job_status: 'missed' })).toBe('missed');
    const moved = run('publishing_reschedule', { scheduled_at: '2027-01-02T09:00:00Z' }, target.id, 'owner', row(target.id).version) as Row;
    expect(moved.approval_retained).toBe(false);
    expect(row(target.id).plan_status).toBe('ready');
    expect(request(target)).toMatchObject({ status: 'approved', approved_via: 'channel_policy' });
  });

  it('E35: skipping a hub post in the release decisions cancels it instead of closing it', async () => {
    const { ctx, run, submit, schedule, row, channel } = await channelFixture('x', 'direct');
    const target = schedule('2027-01-02T10:00:00Z');
    submit(target.id);
    const pause = run('publishing_pause', { scope_type: 'social_account', scope_id: channel.id, reason: 'Owner stop' }) as Row;
    run('publishing_release_pause', { decisions: [{ target_id: target.id, action: 'skip' }] }, pause.id);
    expect(row(target.id)).toMatchObject({ plan_status: 'cancelled', cancellation_reason: 'skipped_on_pause_release' });
    expect(ctx.list('worker_job').filter(item => item.publish_target_id === target.id && !['cancelled', 'superseded'].includes(String(item.status)))).toEqual([]);
  });

  it('E37: an owner rejection stays put through settings changes and a switch to direct; an explicit resubmit sends it again', async () => {
    const { ctx, run, submit, schedule, row, request, save } = await channelFixture('x');
    const target = schedule();
    submit(target.id);
    run('publishing_reject', { reason: 'Not this one' }, target.id, 'owner', row(target.id).version);
    const rejected = request(target)!;
    expect([row(target.id).plan_status, rejected.status]).toEqual(['changes_requested', 'rejected']);
    await save({ daily_cap: 5 });
    await save({ approval_mode: 'direct' });
    expect(row(target.id).plan_status).toBe('changes_requested');
    expect(ctx.list('approval_request').filter(item => item.resource_id === target.id).map(item => item.status)).toEqual(['rejected']);
    expect(ctx.list('worker_job').filter(item => item.publish_target_id === target.id)).toEqual([]);
    // The policy/rights invalidation sweep leaves it alone too.
    const sweep = await import('../../../../../packages/domain/src/publishing/index.js');
    sweep.invalidateTargets(ctx, item => item.id === target.id, 'rights_revoked');
    expect(row(target.id).plan_status).toBe('changes_requested');
    // Only an explicit resubmission sends it again (here the direct channel approves it).
    submit(target.id);
    expect(row(target.id).plan_status).toBe('ready');
    expect(request(target)).toMatchObject({ status: 'approved', approved_via: 'channel_policy' });
  });
});
