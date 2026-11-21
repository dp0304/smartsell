import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Commands, Context, Entity, Fields, Role } from '../types.ts';
import { commands as planning } from '../planning/index.ts';
import { commands as campaign } from '../campaign/index.ts';
import { commands as asset } from '../asset/index.ts';
import { commands as content } from '../content/index.ts';
import { commands, createOfficialWorker } from './index.ts';
import type { OfficialAdapter } from './official.ts';

function fixture() {
  let records = new Map<string, Entity>();
  let sequence = 0;
  let now = '2026-11-19T15:00:00.000Z';
  let tail = Promise.resolve();
  const events: string[] = [];
  const tx = <T>(work: (ctx: Context) => Promise<T>, actorId = 'operator', role: Role = 'owner', workspaceId = 'ws') => {
    const result = tail.then(async () => {
      const draft = structuredClone(records);
      const changes: string[] = [];
      const tenantId = 'tenant';
      const key = (module: string, kind: string, id: string) => JSON.stringify([tenantId, workspaceId, module, kind, id]);
      const ctx: Context = {
        tenantId, workspaceId, actorId, role, now,
        async get(module, kind, id) { return structuredClone(draft.get(key(module, kind, id))); },
        async list(module, kind) {
          return structuredClone([...draft.values()].filter(row => row.module === module && row.kind === kind && row.tenant_id === tenantId && row.workspace_id === workspaceId));
        },
        async insert(module, kind, data, id = `row-${++sequence}`) {
          const identity = key(module, kind, id);
          assert.ok(!draft.has(identity), 'unique record identity');
          const row = { id, module, kind, data, version: 1, tenant_id: tenantId, workspace_id: workspaceId, created_at: now, updated_at: now };
          draft.set(identity, structuredClone(row));
          return structuredClone(row);
        },
        async update(module, kind, id, patch, version) {
          const identity = key(module, kind, id);
          const previous = draft.get(identity);
          assert.equal(previous?.version, version, 'compare and swap');
          const row = { ...previous!, version: version + 1, updated_at: now, data: { ...previous!.data, ...patch } };
          draft.set(identity, structuredClone(row));
          return structuredClone(row);
        },
        async emit(name) { changes.push(name); },
      };
      const output = await work(ctx);
      records = draft;
      events.push(...changes);
      return output;
    });
    tail = result.then(() => {}, () => {});
    return result;
  };
  const invoke = (collection: Commands, action: string, input: Fields, actor?: string, role?: Role, workspace?: string) =>
    tx(ctx => collection[action].run(ctx, input) as Promise<Fields>, actor, role, workspace);
  return {
    tx, events, invoke,
    execution: (action: string, input: Fields) => invoke(commands, action, input),
    planning: (action: string, input: Fields) => invoke(planning, action, input),
    time(iso: string) { now = iso; },
  };
}

type Fixture = ReturnType<typeof fixture>;
const due = '2026-11-19T16:00:00.000Z';

async function target(f: Fixture, route: 'official' | 'manual', suffix: string, quota = 2) {
  const account = 'account';
  const variant = `variant-${suffix}`;
  const revision = `revision-${suffix}`;
  await f.tx(async ctx => {
    if (!await ctx.get('account', 'social_account', account)) {
      await ctx.insert('account', 'social_account', {
        platform: 'meta_facebook', external_account_id: 'page-1234', status: 'active', default_timezone: 'Asia/Taipei',
      }, account);
      const connection = await ctx.insert('account', 'connection', {
        purpose: 'social', provider: 'meta_facebook', status: 'active', expires_at: '2026-12-01T00:00:00.000Z', external_account_ids: ['page-1234'],
      });
      await ctx.insert('account', 'social_account_connection', { social_account_id: account, connection_id: connection.id });
    }
    await ctx.insert('content', 'content_variant', { current_revision_id: revision, readiness: 'ready', state: 'ready' }, variant);
    await ctx.insert('content', 'content_revision', {
      variant_id: variant, author_id: 'editor', platform: 'facebook', market: 'TW', format: 'text', body: `Post ${suffix}`, asset_version_ids: [],
    }, revision);
  });
  if (suffix === 'one') await f.planning('set_publishing_profile', {
    account_id: account, platform: 'facebook', timezone: 'Asia/Taipei', formats: ['text'],
    active: true, official_capability: true, manual_capability: true, adapter_key: 'sandbox', quota_limit: quota,
  });
  const draft = await f.planning('create_target', { account_id: account, content_variant_id: variant, route, scheduled_at: due, visibility: 'public' });
  const submitted = await f.planning('submit', { target_id: draft.id, expected_version: draft.version });
  await assert.rejects(f.planning('approve', { target_id: draft.id, expected_version: submitted.version }), { code: 'self_review_forbidden' });
  return f.invoke(planning, 'approve', { target_id: draft.id, expected_version: submitted.version }, 'reviewer', 'reviewer');
}

test('an operator turns a campaign and a licensed asset into an approved manual post', async () => {
  const f = fixture();
  await f.tx(async ctx => {
    await ctx.insert('workspace', 'brand', { name: 'Launch brand' }, 'brand');
    await ctx.insert('analytics', 'metric_definition', { key: 'reach' });
    await ctx.insert('core', 'file_object', { purpose: 'asset', scan_status: 'clean', mime_type: 'image/jpeg', sha256: 'a'.repeat(64) }, 'hero-file');
  });
  let launch = await f.invoke(campaign, 'create_draft', { brand_id: 'brand', name: 'Launch', kind: 'launch', starts_at: '2026-11-19T15:00:00Z', ends_at: '2026-11-20T00:00:00Z', goals: [{ metric_key: 'reach', unit: 'count', baseline_value: 0, target_value: 100, due_at: '2026-11-20T00:00:00Z' }] });
  for (const to of ['planned', 'active']) launch = await f.invoke(campaign, 'transition', { campaign_id: launch.id, expected_version: launch.version, to });
  const { version } = await f.invoke(asset, 'asset_create', { brand_id: 'brand', title: 'Launch image', file_object_id: 'hero-file', kind: 'image' });
  const rights = await f.invoke(asset, 'rights_create_draft', {
    brand_id: 'brand', grant_type: 'owned', grantor_kind: 'brand', asset_version_id: version.id,
    terms: { usages: ['organic_social'], platforms: ['facebook'], regions: ['TW'], valid_from: '2026-11-19T15:00:00Z', valid_until: '2026-11-19T17:00:00Z' },
  });
  await f.invoke(asset, 'rights_activate', { rights_grant_id: rights.id, revision_id: rights.data.current_revision_id }, 'rights-reviewer', 'reviewer');
  const { variants: [variant] } = await f.invoke(content, 'content_create_item', {
    brand_id: 'brand', campaign_id: launch.id, title: 'Launch post', variants: [{ platform: 'facebook', market: 'TW', format: 'feed_image' }],
  });
  const { revision } = await f.invoke(content, 'content_commit_revision', {
    variant_id: variant.id, base_revision_id: null, expected_version: variant.version,
    body: 'New collection', asset_version_ids: [version.id],
  });
  await f.planning('set_publishing_profile', { account_id: 'page', platform: 'facebook', timezone: 'Asia/Taipei', formats: ['feed_image'], active: true, manual_capability: true });
  const draft = await f.planning('create_target', { account_id: 'page', content_variant_id: variant.id, route: 'manual', scheduled_at: due, visibility: 'public' });
  const review = await f.planning('submit', { target_id: draft.id, expected_version: draft.version });
  assert.equal(review.data.frozen.revision.id, revision.id);
  assert.equal(review.data.frozen.asset_versions[0].grant_id, rights.id);
  const plan = await f.invoke(planning, 'approve', { target_id: review.id, expected_version: review.version, frozen_hash: review.data.frozen_hash }, 'reviewer', 'reviewer');
  f.time(due);
  const result = await f.execution('due_scan', {});
  const { attempt } = await f.execution('begin_manual', { task_id: result.tasks[0].id });
  const { post } = await f.execution('reconcile_manual', {
    task_id: result.tasks[0].id, attempt_id: attempt.id, fencing_token: attempt.data.fencing_token,
    outcome: 'published', permalink: 'https://facebook.example/post/launch', evidence: 'Matched the frozen image and copy on the target page',
  });
  assert.equal(post.data.target_id, plan.id);
  assert.equal(post.data.verification, 'manual_confirmed');
});

test('manual execution respects pause, due time, assignee, fencing and recorded evidence', async () => {
  const f = fixture();
  const plan = await target(f, 'manual', 'one');
  const task = await f.execution('enqueue', { target_id: plan.id });
  assert.equal((await f.execution('enqueue', { target_id: plan.id })).id, task.id);
  assert.equal((await f.execution('begin_manual', { task_id: task.id })).task.data.reason, 'not_due');
  f.time(due);
  const pause = await f.planning('pause', { scope: 'workspace', reason: 'Review incident' });
  assert.equal((await f.execution('begin_manual', { task_id: task.id })).task.data.reason, 'publishing_paused');
  await f.planning('release_pause', { pause_id: pause.id, expected_version: pause.version });
  const { attempt } = await f.execution('begin_manual', { task_id: task.id });
  const result = { task_id: task.id, attempt_id: attempt.id, fencing_token: attempt.data.fencing_token, outcome: 'published', permalink: 'https://facebook.example/post/1', evidence: 'Operator viewed the page and matched the approved copy' };
  await assert.rejects(f.execution('reconcile_manual', { ...result, fencing_token: result.fencing_token + 1 }), { code: 'stale_fence' });
  await assert.rejects(f.invoke(commands, 'get_task', { task_id: task.id }, 'operator', 'owner', 'other-ws'), { code: 'not_found' });
  const published = await f.execution('reconcile_manual', result);
  assert.equal(published.task.data.status, 'published');
  assert.equal(published.post.data.verification, 'manual_confirmed');
  assert.equal(published.post.data.target_id, plan.id);
});

test('official timeout holds the account and quota and observes once without resubmitting', async () => {
  const f = fixture();
  const first = await target(f, 'official', 'one', 1);
  const second = await target(f, 'official', 'two', 1);
  const firstTask = await f.execution('enqueue', { target_id: first.id });
  const secondTask = await f.execution('enqueue', { target_id: second.id });
  f.time(due);
  const [claim, blocked] = await Promise.all([firstTask, secondTask].map(task => f.execution('prepare_official', { task_id: task.id })));
  assert.equal(blocked.task.data.reason, 'account_busy');
  let submits = 0;
  let observes = 0;
  const adapter: OfficialAdapter = {
    async submit(request) {
      submits++;
      assert.equal(request.frozen.revision.body, 'Post one');
      throw new Error('Connection dropped after receiving the request');
    },
    async observe() {
      observes++;
      return { status: 'published', external_post_id: 'platform-id-1', evidence: 'Matched exact client request ID in the page feed' };
    },
  };
  const worker = createOfficialWorker({ run: f.tx }, new Map([['sandbox', adapter]]));
  const fence = claim.attempt.data.fencing_token;
  assert.equal((await worker.dispatch(firstTask.id, fence)).task.data.status, 'outcome_unknown');
  await worker.dispatch(firstTask.id, fence);
  assert.equal(submits, 1);
  await assert.rejects(f.execution('handover_manual', { task_id: firstTask.id, assignee_id: 'operator', reason: 'Network error' }), { code: 'verification_required' });
  assert.equal((await f.tx(ctx => ctx.list('execution', 'quota_reservation')))[0].data.status, 'reserved');
  assert.equal((await worker.verify(firstTask.id)).task.data.status, 'published');
  assert.equal(observes, 1);
  assert.equal((await f.tx(ctx => ctx.list('execution', 'quota_reservation')))[0].data.status, 'consumed');
  assert.equal((await f.execution('prepare_official', { task_id: secondTask.id })).task.data.reason, 'quota_exhausted');
});

test('prepared lease expires with released quota and a new fence while unsent restore work needs evidence', async () => {
  const f = fixture();
  const plan = await target(f, 'official', 'one', 1);
  const task = await f.execution('enqueue', { target_id: plan.id });
  f.time(due);
  const claim = await f.execution('prepare_official', { task_id: task.id });
  f.time('2026-11-19T16:16:00.000Z');
  assert.equal((await f.execution('recover_lease', { task_id: task.id })).task.data.status, 'retryable');
  assert.equal((await f.tx(ctx => ctx.list('execution', 'quota_reservation')))[0].data.status, 'released');
  await f.execution('start_restore_hold', { reason: 'Restored snapshot' });
  await assert.rejects(f.execution('release_restore_hold', { reason: 'Resume' }), { code: 'restore_pending' });
  const [check] = await f.tx(ctx => ctx.list('execution', 'recovery_check'));
  await f.execution('record_recovery', { check_id: check.id, outcome: 'verified_absent', confirm_no_pending_submission: true, evidence: 'Platform list checked after the visibility window and old workers stopped' });
  await f.execution('release_restore_hold', { reason: 'Reconciliation complete' });
  f.time('2026-11-19T16:17:00.000Z');
  const retry = await f.execution('prepare_official', { task_id: task.id });
  assert.ok(retry.attempt.data.fencing_token > claim.attempt.data.fencing_token);
  const worker = createOfficialWorker({ run: f.tx }, new Map());
  await assert.rejects(worker.dispatch(task.id, claim.attempt.data.fencing_token), { code: 'stale_fence' });
});


test('legacy official dispatch releases its quota and hands over when its adapter is unconfigured', async () => {
  const f = fixture();
  const plan = await target(f, 'official', 'one', 1);
  const task = await f.execution('enqueue', { target_id: plan.id });
  f.time(due);
  const claim = await f.execution('prepare_official', { task_id: task.id });
  const worker = createOfficialWorker({ run: f.tx }, new Map());
  const result = await worker.dispatch(task.id, claim.attempt.data.fencing_token);
  assert.equal(result.task.data.route, 'manual');
  assert.equal(result.task.data.reason, 'official_adapter_unconfigured');
  assert.equal((await f.tx(ctx => ctx.list('execution', 'quota_reservation')))[0].data.status, 'released');
  const manual = await f.execution('begin_manual', { task_id: task.id });
  assert.equal(manual.attempt.data.route, 'manual');
  assert.ok(manual.attempt.data.fencing_token > claim.attempt.data.fencing_token);
});
