import assert from 'node:assert/strict';
import test from 'node:test';
import { testWorkspace } from '../ingest/test-context.ts';
import { type Commands, type Entity } from '../types.ts';
import { commands, checkExecution } from './index.ts';

const fixtures: Commands = {
  put: { roles: ['owner'], async run(ctx, i) {
    const row = await ctx.get(i.module, i.kind, i.id);
    return row ? ctx.update(i.module, i.kind, i.id, i.data, row.version) : ctx.insert(i.module, i.kind, i.data, i.id);
  } },
  execution_check: { roles: ['owner'], async run(ctx, i) {
    const row = await ctx.get('planning', 'publish_target', i.target_id);
    assert.ok(row);
    return checkExecution(ctx, row);
  } },
};
const reviewer = { role: 'reviewer', actorId: 'reviewer-1' } as const;
const targetInput = { account_id: 'account-1', content_variant_id: 'variant-1', route: 'official', visibility: 'public', scheduled_at: '2026-11-20T10:00:00Z' };
const profileInput = { account_id: 'account-1', platform: 'instagram', timezone: 'America/New_York', official_capability: true, adapter_key: 'instagram', quota_limit: 30, account_identity: 'identity-1' };
const errorCode = (code: string) => ({ code });

async function fixture(withAsset = false) {
  const ws = testWorkspace();
  const run = (name: string, input = {}, options = {}) => ws.run<Entity>(commands, name, input, options);
  const put = (module: string, kind: string, id: string, data: object) => ws.run(fixtures, 'put', { module, kind, id, data });
  const check = (id: string, now?: string) => ws.run(fixtures, 'execution_check', { target_id: id }, { now });
  await put('content', 'content_variant', 'variant-1', { current_revision_id: 'revision-1' });
  await put('content', 'content_revision', 'revision-1', { variant_id: 'variant-1', body: 'Launch', platform: 'instagram', market: 'US', format: 'text', author_id: 'author-1', asset_version_ids: withAsset ? ['asset-version-1'] : [] });
  await put('account', 'social_account', 'account-1', { external_account_id: 'identity-1', provider: 'meta_instagram', status: 'active', default_timezone: 'America/New_York' });
  await put('account', 'social_account_connection', 'link-1', { social_account_id: 'account-1', connection_id: 'connection-1' });
  await put('account', 'connection', 'connection-1', { provider: 'meta_instagram', status: 'active', purpose: 'social', expires_at: '2026-12-01T00:00:00.000Z', external_account_ids: ['identity-1'] });
  await run('set_publishing_profile', profileInput);
  async function schedule() {
    const target = await run('create_target', targetInput);
    const pending = await run('submit', { target_id: target.id, expected_version: target.version });
    return run('approve', { target_id: target.id, expected_version: pending.version }, reviewer);
  }
  return { ws, put, run, check, schedule };
}

test('time input rejects DST gaps and folds unless explicitly resolved', async () => {
  const { run } = await fixture();
  const { scheduled_at: _, ...target } = targetInput;
  const gap = { ...target, local_scheduled_at: '2027-03-14T02:30' };
  const fold = { ...target, local_scheduled_at: '2027-11-07T01:30' };
  await assert.rejects(run('create_target', gap), errorCode('dst_gap'));
  await assert.rejects(run('create_target', fold), errorCode('dst_fold'));
  assert.equal((await run('create_target', { ...gap, dst_choice: 'shift_forward' })).data.scheduled_at, '2027-03-14T07:00:00.000Z');
  const earlier = await run('create_target', { ...fold, dst_choice: 'earlier_occurrence' });
  const later = await run('create_target', { ...fold, dst_choice: 'later_occurrence' });
  assert.equal(Date.parse(later.data.scheduled_at) - Date.parse(earlier.data.scheduled_at), 3600000);
  await assert.rejects(run('create_target', { ...targetInput, scheduled_at: '2027-02-30T01:00Z' }));
  await assert.rejects(run('create_target', { ...targetInput, schedule_tz: '+01:00' }), errorCode('invalid_timezone'));
});

test('plan, submit and approval bind the revision and reject stale and self-review requests', async () => {
  const { run, check, put } = await fixture();
  const plan = await run('create_plan', { name: 'Launch' });
  const target = await run('create_target', { ...targetInput, plan_id: plan.id });
  await assert.rejects(run('submit', { target_id: target.id }), errorCode('version_required'));
  const pending = await run('submit', { target_id: target.id, expected_version: target.version });
  assert.equal(pending.data.status, 'awaiting_approval');
  const mutation = { target_id: target.id, expected_version: pending.version };
  await assert.rejects(run('approve', mutation), errorCode('self_review_forbidden'));
  await assert.rejects(run('approve', mutation, { role: 'reviewer', actorId: 'author-1' }), errorCode('self_review_forbidden'));
  await assert.rejects(run('approve', { ...mutation, expected_version: target.version }, reviewer), errorCode('version_conflict'));
  const approved = await run('approve', { ...mutation, frozen_hash: pending.data.frozen_hash }, reviewer);
  assert.equal(approved.data.status, 'scheduled');
  assert.equal(approved.data.frozen.revision.id, 'revision-1');
  assert.equal(approved.data.frozen.quota_limit, 30);
  assert.equal(approved.data.frozen.adapter_key, 'instagram');
  assert.deepEqual(await check(target.id, '2026-11-21T10:00:00Z'), { blockers: [] });
  await put('content', 'content_variant', 'variant-1', { current_revision_id: 'revision-2' });
  assert.ok((await check(target.id)).blockers.some((issue: { code: string }) => issue.code === 'revision_changed'));
});

test('pause blocks execution and submission, while existing tasks fence changes', async () => {
  const { run, check, put, schedule } = await fixture();
  const target = await schedule();
  const pause = await run('pause', { reason: 'Incident' }, { role: 'editor' });
  assert.ok((await check(target.id)).blockers.some((issue: { code: string }) => issue.code === 'publishing_paused'));
  const other = await run('create_target', { ...targetInput, scheduled_at: '2026-11-20T10:10Z' });
  await assert.rejects(run('submit', { target_id: other.id, expected_version: other.version }), errorCode('precheck_blocked'));
  await assert.rejects(run('release_pause', { pause_id: pause.id, expected_version: pause.version }, { role: 'editor' }), errorCode('forbidden'));
  await run('release_pause', { pause_id: pause.id, expected_version: pause.version });
  assert.deepEqual(await check(target.id), { blockers: [] });
  const changed = await run('reschedule', { target_id: target.id, expected_version: target.version, scheduled_at: '2026-11-20T10:15Z' });
  assert.equal(changed.data.status, 'scheduled');
  assert.equal(changed.data.approval_id, target.data.approval_id);
  assert.notEqual(changed.data.frozen_hash, target.data.frozen_hash);
  await put('execution', 'execution_task', 'task-1', { target_id: target.id, status: 'scheduled' });
  await assert.rejects(run('cancel', { target_id: target.id, expected_version: changed.version, reason: 'Cancel' }), errorCode('execution_already_started'));
  await assert.rejects(run('reschedule', { target_id: target.id, expected_version: changed.version, scheduled_at: '2026-11-20T11:00Z' }), errorCode('execution_already_started'));
});

test('rights expire between the scheduled time and execution, and visibility changes need new approval', async () => {
  const { ws, run, check, put, schedule } = await fixture(true);
  await put('asset', 'asset', 'asset-1', { brand_id: 'brand-1', status: 'ready' });
  await put('asset', 'asset_version', 'asset-version-1', { asset_id: 'asset-1', sha256: 'a'.repeat(64) });
  await put('asset', 'rights_grant', 'grant-1', { brand_id: 'brand-1', status: 'active', active_revision_id: 'grant-rev-1', current_revision_id: 'grant-rev-1' });
  await put('asset', 'rights_grant_asset', 'grant-link-1', { asset_id: 'asset-1', rights_grant_id: 'grant-1', version_scope: 'all_versions' });
  await put('asset', 'rights_grant_revision', 'grant-rev-1', { rights_grant_id: 'grant-1', usages: ['organic_social'], platforms: ['instagram'], regions: ['US'], valid_from: '2026-11-19T00:00:00.000Z', valid_until: '2026-11-20T11:00:00.000Z', revision_no: 1 });
  const target = await schedule();
  assert.ok(ws.list('planning', 'publish_target_ref').some(row => row.data.ref_type === 'rights_grant' && row.data.ref_id === 'grant-1'));
  assert.deepEqual(await check(target.id, '2026-11-20T10:01:00Z'), { blockers: [] });
  assert.ok((await check(target.id, '2026-11-20T11:01:00Z')).blockers.some((issue: { code: string }) => issue.code === 'asset_rights_denied'));
  const changed = await run('change_target', { target_id: target.id, expected_version: target.version, visibility: 'private' });
  assert.equal(changed.data.status, 'draft');
  assert.equal(changed.data.approval_id, null);
  assert.equal(ws.list('planning', 'approval')[0]?.data.status, 'invalidated');
});

test('committing a versioned plan is atomic when a target fails precheck', async () => {
  const { ws, run } = await fixture();
  const plan = await run('create_plan', { name: 'Batch' });
  const first = await run('create_target', { ...targetInput, plan_id: plan.id });
  const invalid = await run('create_target', { ...targetInput, plan_id: plan.id, content_variant_id: 'missing-variant' });
  const preview = await ws.run(commands, 'preview_plan', { plan_id: plan.id });
  const submit = {
    plan_id: plan.id, expected_version: preview.expected_version,
    items: [first, invalid].map(target => ({ target_id: target.id, expected_version: target.version })),
  };
  await assert.rejects(run('commit_plan', submit), errorCode('precheck_blocked'));
  assert.deepEqual(ws.list('planning', 'approval'), []);
  assert.ok(ws.list('planning', 'publish_target').every(target => target.data.status === 'draft'));
  await run('cancel', { target_id: invalid.id, expected_version: invalid.version, reason: 'Invalid variant' });
  const committed = await ws.run(commands, 'commit_plan', { ...submit, items: submit.items.slice(0, 1) });
  assert.equal(committed.plan.data.status, 'committed');
  assert.equal(committed.targets[0].data.status, 'awaiting_approval');
});

test('linked official publishing freezes the real provider and blocks revoked connections', async () => {
  const { run, put, check, schedule } = await fixture();
  await put('account', 'social_account', 'account-1', { external_account_id: 'external-1', provider: 'meta_instagram', status: 'active', default_timezone: 'America/New_York' });
  await put('account', 'social_account_connection', 'link-1', { social_account_id: 'account-1', connection_id: 'connection-1' });
  await put('account', 'connection', 'connection-1', { provider: 'meta_instagram', status: 'active', purpose: 'social', expires_at: '2026-12-01T00:00:00.000Z', external_account_ids: ['external-1'] });
  await run('set_publishing_profile', { ...profileInput, expected_version: 1 });
  const target = await schedule();
  assert.equal(target.data.frozen.platform, 'instagram');
  assert.equal(target.data.frozen.platform_provider, 'meta_instagram');
  assert.equal(target.data.frozen.account_identity, 'external-1');
  await put('account', 'connection', 'connection-1', { status: 'revoked' });
  assert.ok((await check(target.id)).blockers.some((issue: { code: string }) => issue.code === 'connection_unavailable'));
});
