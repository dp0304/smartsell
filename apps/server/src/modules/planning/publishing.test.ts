import { describe, expect, it } from 'vitest';
import { Problem, type Context, type Data, type Role, type Row } from '@smartsell/contracts';
import { assessTarget, onRevisionCreated, resolveLocal } from '../../../../../packages/domain/src/publishing/index.js';
import { createAdapter } from '../../../../../packages/adapters/src/official.js';
import { completeOAuth, startOAuth } from '../account/oauth.js';
import { applyPlanningEvent, operations, scanPlanningDue } from './index.js';
import { operations as assets } from '../asset/index.js';
import { operations as contentOperations } from '../content/index.js';
import { operations as execution } from '../execution/index.js';

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
    const operation = [...operations, ...assets, ...contentOperations, ...execution].find(item => item.name === name)!;
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
