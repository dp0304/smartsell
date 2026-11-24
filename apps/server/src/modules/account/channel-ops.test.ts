import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  AUTOMATION_NOTICE_VERSION, Problem, RISK_TERMS, RISK_TERMS_VERSION, type Context, type Data, type Input, type Role, type Row,
} from '@smartsell/contracts';
import { Records } from '@smartsell/db';
import { configuration } from '../../config.js';
import { makeContext } from '../../context.js';
import { HUMAN_ONLY, agentCallable, discoverOperations, runScopedOperation } from '../../operations.js';
import '../planning/index.js';
import { channelOperations } from './channel-ops.js';
import { ensureChannelSettings, setWorkerEngineHooks } from './channel-settings.js';
import { createOperations, operations as accountOperations } from './index.js';
import { machineOperations } from './machine-ops.js';

function memory(now = '2026-11-24T10:00:00.000Z') {
  const rows = new Map<string, Row[]>();
  let serial = 0;
  const events: { type: string; payload: Data }[] = [];
  const ctx: Context = {
    actorId: 'owner', role: 'owner', tenantId: 'tenant', workspaceId: 'workspace', now,
    list: (kind: string) => rows.get(kind) ?? [],
    get(kind: string, id: string) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind}: ${id}`);
      return row;
    },
    create(kind: string, data: Data) {
      const row = { ...structuredClone(data), id: `${kind}-${++serial}`, version: 1, created_at: ctx.now, updated_at: ctx.now } as Row;
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind: string, id: string, data: Data) {
      const row = ctx.get(kind, id);
      const updated = { ...row, ...structuredClone(data), id, version: row.version + 1, updated_at: ctx.now } as Row;
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? updated : item));
      return updated;
    },
    remove(kind: string, id: string) { rows.set(kind, ctx.list(kind).filter(row => row.id !== id)); },
    emit(type: string, payload: Data) { events.push({ type, payload }); },
  };
  const ops = [...channelOperations, ...machineOperations];
  const run = (name: string, params: Record<string, string>, body: Data = {}, extra: Partial<Input> & { as?: Context } = {}) => {
    const operation = ops.find(op => op.name === name) ?? assert.fail(`missing ${name}`);
    return operation.run(extra.as ?? ctx, { body, params, query: {}, expectedVersion: extra.expectedVersion }) as Data;
  };
  const device = ctx.create('connector_device', { name: 'mac-b.local', display_name: 'Mac-B', status: 'active', last_seen_at: ctx.now });
  const x = ctx.create('social_account', { provider: 'x', status: 'active', brand_id: 'brand', external_account_id: 'lurelab', handle: 'lurelab', display_name: 'Lure Lab' });
  const tiktok = ctx.create('social_account', { provider: 'tiktok', status: 'active', brand_id: 'brand', external_account_id: '7000000001', handle: null, display_name: 'Lure Lab' });
  const settings = (id = x.id) => ensureChannelSettings(ctx, id);
  const fails = (codeName: string) => (error: Problem) => { assert.equal(error.code, codeName, error.message); return true; };
  return { ctx, events, run, device, x, tiktok, settings, fails };
}

test('every S2 hub operation is registered under its full hub_* name and the human-only ones refuse Agents', async () => {
  const names = ['hub_channels_update_settings', 'hub_channels_ack_automation_notice', 'hub_channels_ack_risk', 'hub_channels_clear_risk_ack',
    'hub_channels_bind_machine', 'hub_machines_update', 'hub_machines_pause', 'hub_machines_resume'];
  assert.deepEqual([...channelOperations, ...machineOperations].map(op => op.name).sort(), [...names].sort());
  for (const name of names) assert.ok(accountOperations.some(op => op.name === name), `${name} is merged into account operations`);
  assert.ok(!accountOperations.some(op => op.name.startsWith('account_hub_')), 'never prefixed by op()');
  const { operations } = await discoverOperations();
  for (const name of names) {
    const op = operations.find(item => item.name === name) ?? assert.fail(`${name} is not discovered`);
    assert.equal(op.module, 'account');
    assert.equal(HUMAN_ONLY.has(name), name !== 'hub_machines_pause', name);
    assert.equal(agentCallable(op), name === 'hub_machines_pause', name);
  }
  // Through the shared runner an Agent credential gets HUMAN_REQUIRED before the operation runs.
  const records = new Records(new Map(), false);
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const seed = makeContext(records, scope, 'owner');
  const account = seed.create('social_account', { provider: 'x', status: 'active', brand_id: 'b', external_account_id: 'lurelab', handle: 'lurelab' });
  const device = seed.create('connector_device', { name: 'm', status: 'active' });
  const config = configuration({ SETUP_TOKEN: 'channel-ops-fixture-token' });
  const call = async (name: string, params: Record<string, string>, body: Data, grantId?: string, expectedVersion?: number) =>
    (await runScopedOperation(records, scope, { actorId: scope.actorId, grantId }, 'owner', randomUUID(), operations.find(op => op.name === name)!,
      { params, query: {}, body, expectedVersion, idempotencyKey: `k-${randomUUID()}` }, grantId ? 'mcp' : 'rest', config)).body.data as Data;
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: Problem) => error.code);
  const inputs: Record<string, [Record<string, string>, Data]> = {
    hub_channels_update_settings: [{ id: account.id }, { daily_cap: 5 }],
    hub_channels_ack_automation_notice: [{ id: account.id }, { version: AUTOMATION_NOTICE_VERSION }],
    hub_channels_ack_risk: [{ id: account.id }, { terms_version: RISK_TERMS_VERSION, typed_handle: '@lurelab' }],
    hub_channels_clear_risk_ack: [{ id: account.id }, {}],
    hub_channels_bind_machine: [{ id: account.id }, { device_id: device.id, owned_account_confirmed: true }],
    hub_machines_update: [{ id: device.id }, { display_name: 'Mac-B' }],
    hub_machines_resume: [{ id: device.id }, {}],
  };
  for (const [name, [params, body]] of Object.entries(inputs)) assert.equal(await code(call(name, params, body, 'credential-a', 1)), 'HUMAN_REQUIRED', name);
  assert.equal((await call('hub_machines_pause', { id: device.id }, { reason: 'Agent stop' }, 'credential-a')).paused, true);
  assert.equal(await code(call('hub_machines_resume', { id: device.id }, {}, 'credential-a')), 'HUMAN_REQUIRED');
  assert.equal((await call('hub_machines_resume', { id: device.id }, {})).paused, false, 'a person may resume');
  assert.equal(((await call('hub_channels_update_settings', { id: account.id }, { daily_cap: 5 }, undefined, 1)).settings as Data).daily_cap, 5);
  // The legacy role and a credential on the context are refused inside the operation as well.
  const { run, x, fails } = memory();
  assert.throws(() => run('hub_channels_ack_risk', { id: x.id }, {}, { as: { ...memory().ctx, role: 'agent' } }), fails('HUMAN_REQUIRED'));
});

test('settings updates require If-Match, validate strictly and bump settings_generation and approval_generation by their rules', () => {
  const { run, x, settings, events, fails } = memory();
  const base = settings();
  assert.equal(base.version, 1);
  assert.throws(() => run('hub_channels_update_settings', { id: x.id }, { daily_cap: 5 }), fails('VERSION_REQUIRED'));
  assert.throws(() => run('hub_channels_update_settings', { id: x.id }, { daily_cap: 5 }, { expectedVersion: 9 }), fails('VERSION_CONFLICT'));
  assert.throws(() => run('hub_channels_update_settings', { id: x.id }, { execution_mode: 'api' }, { expectedVersion: 1 }), fails('EXECUTION_MODE_UNAVAILABLE'));
  assert.throws(() => run('hub_channels_update_settings', { id: x.id }, { daily_cap: 51, window: { start: '25:00', end: '09:00', days: [8] }, paused: true,
    platform_defaults: { tiktok: {} } }, { expectedVersion: 1 }), (error: Problem) => {
    assert.equal(error.code, 'INVALID_ARGUMENTS');
    assert.deepEqual((error.details!.issues as { path: string }[]).map(issue => issue.path).sort(),
      ['daily_cap', 'paused', 'platform_defaults.tiktok', 'window.days', 'window.start'].sort());
    return true;
  });
  // A limit change bumps settings_generation only.
  let result = run('hub_channels_update_settings', { id: x.id }, { daily_cap: 4, window: { start: '08:00', end: '22:00', days: [5, 1, 2] }, lateness_limit_min: 45 }, { expectedVersion: 1 });
  let next = result.settings as typeof base;
  assert.deepEqual([next.settings_generation, next.approval_generation, next.window?.days], [2, 1, [1, 2, 5]]);
  assert.deepEqual(result.changed_fields, ['daily_cap', 'window', 'lateness_limit_min']);
  assert.equal(next.approval_mode_confirmed_at, null);
  // Saving the unchanged approval mode records the owner's choice without a new generation.
  result = run('hub_channels_update_settings', { id: x.id }, { approval_mode: 'needs_approval', daily_cap: 4 }, { expectedVersion: next.version });
  next = result.settings as typeof base;
  assert.deepEqual([next.settings_generation, next.approval_generation, result.changed_fields], [2, 1, []]);
  assert.equal(next.approval_mode_confirmed_at, '2026-11-24T10:00:00.000Z');
  // Changing the approval mode bumps both generations and reports it in the event.
  result = run('hub_channels_update_settings', { id: x.id }, { approval_mode: 'direct' }, { expectedVersion: next.version });
  next = result.settings as typeof base;
  assert.deepEqual([next.settings_generation, next.approval_generation, next.approval_mode], [3, 2, 'direct']);
  assert.deepEqual(events.filter(event => event.type === 'account.channel_settings.changed').map(event => [event.payload.generation, event.payload.approval_mode_changed]),
    [[2, false], [3, true]]);
  // X defaults are X-only; the TikTok shape is checked field by field.
  assert.throws(() => run('hub_channels_update_settings', { id: x.id }, { platform_defaults: { x: { reply_settings: 'nobody' } } }, { expectedVersion: next.version }), fails('INVALID_ARGUMENTS'));
  result = run('hub_channels_update_settings', { id: x.id }, { platform_defaults: { x: { reply_settings: 'following' } }, caption_limit: 25_000, timezone: 'Asia/Shanghai' }, { expectedVersion: next.version });
  assert.deepEqual((result.settings as typeof base).platform_defaults, { x: { reply_settings: 'following' } });
  assert.equal((result.settings as typeof base).settings_generation, 4);
});

test('TikTok defaults must be complete; ai_generated defaults to false; branded content cannot be private', () => {
  const { run, tiktok, settings, fails } = memory();
  const version = settings(tiktok.id).version;
  const defaults = { privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true, allow_duet: true, allow_stitch: true, commercial_disclosure: 'none' };
  assert.throws(() => run('hub_channels_update_settings', { id: tiktok.id }, { platform_defaults: { tiktok: { ...defaults, privacy_level: 'SELF_ONLY', commercial_disclosure: 'branded_content' } } }, { expectedVersion: version }), fails('INVALID_ARGUMENTS'));
  assert.throws(() => run('hub_channels_update_settings', { id: tiktok.id }, { platform_defaults: { x: { reply_settings: 'everyone' } } }, { expectedVersion: version }), fails('INVALID_ARGUMENTS'));
  const result = run('hub_channels_update_settings', { id: tiktok.id }, { platform_defaults: { tiktok: defaults } }, { expectedVersion: version });
  assert.deepEqual((result.settings as Data).platform_defaults, { tiktok: { ...defaults, ai_generated: false } });
});

test('the risk acceptance needs the current terms and the typed handle; HANDLE_UNKNOWN until the handle is known', () => {
  const { ctx, run, x, tiktok, settings, fails, events } = memory();
  assert.throws(() => run('hub_channels_ack_risk', { id: tiktok.id }, { terms_version: RISK_TERMS_VERSION, typed_handle: '@lurelab' }), (error: Problem) => {
    assert.equal(error.code, 'HANDLE_UNKNOWN');
    assert.equal(error.status, 409);
    assert.equal(error.message, '請先在帳號頁按「檢查登入」');
    return true;
  });
  assert.throws(() => run('hub_channels_ack_risk', { id: x.id }, { terms_version: 'browser-automation-risk-2025-01', typed_handle: '@lurelab' }), fails('RISK_TERMS_OUTDATED'));
  assert.throws(() => run('hub_channels_ack_risk', { id: x.id }, { terms_version: RISK_TERMS_VERSION, typed_handle: '@lurelab2' }), fails('HANDLE_MISMATCH'));
  assert.throws(() => run('hub_channels_ack_risk', { id: x.id }, { terms_version: RISK_TERMS_VERSION }), fails('INVALID_ARGUMENTS'));
  const youtube = ctx.create('social_account', { provider: 'youtube', status: 'active', brand_id: 'brand', external_account_id: 'UCxxxxxxxxxxxxxxxxxxxxxx', handle: 'lurelab' });
  assert.throws(() => run('hub_channels_ack_risk', { id: youtube.id }, { terms_version: RISK_TERMS_VERSION, typed_handle: 'lurelab' }), fails('RISK_ACK_NOT_APPLICABLE'));
  const before = settings().settings_generation;
  const accepted = run('hub_channels_ack_risk', { id: x.id }, { terms_version: RISK_TERMS_VERSION, typed_handle: '  @LureLab ' });
  assert.equal(accepted.effective_mode, 'auto');
  const ack = (accepted.settings as Data).risk_ack as Data;
  assert.equal(ack.terms_version, RISK_TERMS_VERSION);
  assert.equal(ack.by_user_id, 'owner');
  assert.match(String(ack.text_sha256), /^[0-9a-f]{64}$/);
  assert.notEqual(ack.text_sha256, RISK_TERMS.x.zh_hant);
  assert.equal(settings().settings_generation, before + 1);
  assert.equal(settings().approval_generation, 1, 'a risk acceptance never invalidates approvals');
  const cleared = run('hub_channels_clear_risk_ack', { id: x.id });
  assert.equal(cleared.effective_mode, 'assist');
  assert.equal(settings().risk_ack, null);
  assert.equal(run('hub_channels_clear_risk_ack', { id: x.id }).effective_mode, 'assist', 'idempotent');
  assert.equal(settings().settings_generation, before + 2);
  assert.deepEqual(events.filter(event => event.type === 'account.audit.recorded').map(event => event.payload.action).filter(action => String(action).includes('risk')),
    ['account.channel_risk.acknowledged', 'account.channel_risk.cleared']);
});

test('the web acknowledgement of the automation notice records the shown version once', () => {
  const { run, x, settings, events, fails } = memory();
  assert.throws(() => run('hub_channels_ack_automation_notice', { id: x.id }, { version: 'automation-notice-2025-01' }), fails('AUTOMATION_NOTICE_OUTDATED'));
  const result = run('hub_channels_ack_automation_notice', { id: x.id }, { version: AUTOMATION_NOTICE_VERSION });
  assert.deepEqual((result.settings as Data).automation_notice_ack, { at: '2026-11-24T10:00:00.000Z', via: 'web', by: 'owner', version: AUTOMATION_NOTICE_VERSION });
  run('hub_channels_ack_automation_notice', { id: x.id }, { version: AUTOMATION_NOTICE_VERSION });
  assert.equal(settings().settings_generation, 2);
  assert.equal(events.filter(event => event.type === 'account.automation_notice.acked').length, 1);
});

test('binding a machine refuses while jobs are active, moves queued jobs and asks for a login on the new machine', () => {
  const { ctx, run, x, device, events, fails } = memory();
  const other = ctx.create('connector_device', { name: 'win-c', status: 'active' });
  assert.throws(() => run('hub_channels_bind_machine', { id: x.id }, { device_id: device.id }), fails('ACCOUNT_OWNERSHIP_REQUIRED'));
  // S3 review: the job engine is installed with the execution module, so binding really creates the check_login job (§5.10 step 4).
  const real = memory();
  const bound = real.run('hub_channels_bind_machine', { id: real.x.id }, { device_id: real.device.id, owned_account_confirmed: true });
  assert.ok(real.ctx.list('worker_job').some(job => job.id === bound.check_login_job_id && job.kind === 'check_login' && job.device_id === real.device.id &&
    (job.payload as Data).open_login_window === true));
  const calls: string[] = [];
  const restore = setWorkerEngineHooks({
    moveQueuedChannelJobs: (_ctx, accountId, deviceId) => { calls.push(`move:${accountId}:${deviceId}`); return { moved: 2 }; },
    createCheckLoginJob: (scoped, accountId, opts) => { calls.push(`check:${accountId}:${opts.openLoginWindow}`); return scoped.create('worker_job', { kind: 'check_login', status: 'queued', social_account_id: accountId }) as never; },
    bumpSyncGeneration: (_ctx, ids, reason) => { calls.push(`sync:${ids.join(',')}:${reason}`); return 1; },
  });
  try {
    const first = run('hub_channels_bind_machine', { id: x.id }, { device_id: device.id, owned_account_confirmed: true });
    assert.equal((first.binding as Data).device_id, device.id);
    assert.equal((first.session as Data).status, 'pending_identity');
    assert.equal(first.moved_jobs, 2);
    assert.ok(first.check_login_job_id);
    assert.deepEqual(calls.splice(0), [`move:${x.id}:${device.id}`, `check:${x.id}:true`, `sync:${device.id}:binding_changed`]);
    assert.equal(run('hub_channels_bind_machine', { id: x.id }, { device_id: device.id, owned_account_confirmed: true }).unchanged, true);
    const job = ctx.create('worker_job', { kind: 'publish_post', status: 'claimed', social_account_id: x.id, publish_target_id: 'post-1' });
    assert.throws(() => run('hub_channels_bind_machine', { id: x.id }, { device_id: other.id, owned_account_confirmed: true }), (error: Problem) => {
      assert.equal(error.code, 'CHANNEL_HAS_ACTIVE_JOBS');
      assert.deepEqual(error.details?.post_ids, ['post-1']);
      assert.match(error.message, /請先取消或等這 1 則貼文結束/);
      return true;
    });
    ctx.update('worker_job', job.id, { status: 'cancelled' });
    const moved = run('hub_channels_bind_machine', { id: x.id }, { device_id: other.id, owned_account_confirmed: true });
    assert.equal((moved.binding as Data).device_id, other.id);
    assert.deepEqual(ctx.list('browser_session').map(row => row.status), ['revoked', 'pending_identity']);
    assert.deepEqual(calls.at(-1), `sync:${device.id},${other.id}:binding_changed`);
    assert.deepEqual(events.filter(event => event.type === 'account.binding.changed').map(event => event.payload.device_id), [device.id, other.id]);
    ctx.update('connector_device', other.id, { status: 'revoked' });
    assert.throws(() => run('hub_channels_bind_machine', { id: x.id }, { device_id: other.id, owned_account_confirmed: true }), fails('DEVICE_INACTIVE'));
  } finally { restore(); }
});

test('machines: Agents may pause, the first pause is kept, a person resumes; renames are validated', () => {
  const { ctx, run, device, fails } = memory();
  const agent = { ...ctx, agentCredentialId: 'credential-a' } as Context;
  const paused = run('hub_machines_pause', { id: device.id }, { reason: 'Owner asked to stop' }, { as: agent });
  assert.deepEqual([paused.paused, paused.paused_by, paused.paused_reason], [true, 'agent:credential-a', 'Owner asked to stop']);
  assert.equal(run('hub_machines_pause', { id: device.id }, { reason: 'Again' }).paused_reason, 'Owner asked to stop');
  assert.throws(() => run('hub_machines_resume', { id: device.id }, {}, { as: agent }), fails('HUMAN_REQUIRED'));
  assert.equal(run('hub_machines_resume', { id: device.id }).paused, false);
  assert.equal(ctx.get('connector_device', device.id).paused_by, null);
  assert.throws(() => run('hub_machines_update', { id: device.id }, { display_name: 'x'.repeat(61) }), fails('INVALID_ARGUMENTS'));
  assert.throws(() => run('hub_machines_update', { id: device.id }, { display_name: 'Mac-B', status: 'revoked' }), fails('INVALID_ARGUMENTS'));
  assert.equal(run('hub_machines_update', { id: device.id }, { display_name: '  客廳 Mac  ' }).name, '客廳 Mac');
  assert.equal(run('hub_machines_update', { id: device.id }, { display_name: null }).name, 'mac-b.local');
  ctx.update('connector_device', device.id, { status: 'revoked' });
  assert.throws(() => run('hub_machines_pause', { id: device.id }), fails('DEVICE_INACTIVE'));
});

test('a person registering an X account gets the lowercase handle and channel settings right away', () => {
  const { ctx } = memory();
  ctx.create('workspace', { default_timezone: 'Asia/Shanghai' });
  const brand = ctx.create('brand', { name: 'Main', slug: 'main', status: 'active' });
  const register = createOperations({ humanSession: () => true }).find(op => op.name === 'account_register_owned_social_account')!;
  const body = { provider: 'x', external_account_id: '@MakeMyLure', display_name: 'Make My Lure', brand_id: brand.id, owned_account_confirmed: true };
  const row = register.run(ctx, { body, params: {}, query: {} }) as Data;
  assert.deepEqual([row.external_account_id, row.handle, row.default_timezone], ['makemylure', 'makemylure', 'Asia/Shanghai']);
  assert.equal(ctx.list('channel_settings').length, 1);
  assert.throws(() => register.run(ctx, { body, params: {}, query: {} }), (error: Problem) => error.code === 'ACCOUNT_ALREADY_REGISTERED');
  assert.throws(() => register.run(ctx, { body: { ...body, external_account_id: 'make my lure' }, params: {}, query: {} }), (error: Problem) => error.code === 'INVALID_X_HANDLE');
  const facebook = register.run(ctx, { body: { ...body, provider: 'meta_facebook', external_account_id: '4501' }, params: {}, query: {} }) as Data;
  assert.equal(ctx.list('channel_settings').some(settings => settings.social_account_id === facebook.id), false, 'legacy API platforms keep their old route until the hub schedules them');
});

// ---------- Wave 6 (G2): E38 lateness minimum, E42 channel time zone ----------

test('E38: lateness_limit_min below 2 minutes is refused by the settings PATCH and its JSON schema', () => {
  const { run, x, settings, fails } = memory();
  for (const value of [0, 1]) {
    assert.throws(() => run('hub_channels_update_settings', { id: x.id }, { lateness_limit_min: value }, { expectedVersion: settings().version }), (error: Problem) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'INVALID_ARGUMENTS');
      assert.deepEqual(error.details!.issues, [{ path: 'lateness_limit_min', message: '需為 2–240 的整數' }]);
      return true;
    });
  }
  assert.equal(((run('hub_channels_update_settings', { id: x.id }, { lateness_limit_min: 2 }, { expectedVersion: settings().version }).settings) as Data).lateness_limit_min, 2);
  assert.throws(() => run('hub_channels_update_settings', { id: x.id }, { lateness_limit_min: 241 }, { expectedVersion: settings().version }), fails('INVALID_ARGUMENTS'));
  const schema = channelOperations.find(op => op.name === 'hub_channels_update_settings')!.contract!.body as Data;
  assert.deepEqual((schema.properties as Data).lateness_limit_min, { type: 'integer', minimum: 2, maximum: 240 });
});

test('E42: a channel keeps a zone the owner chose; channels still on the old workspace zone follow a workspace zone change', async () => {
  const { ctx, run, x, tiktok, device, settings, events } = memory();
  const { updateWorkspace } = await import('../workspace/brands.js');
  ctx.create('account_execution_binding', { social_account_id: x.id, mode: 'connector', connector_channel: 'browser', device_id: device.id });
  const bumps: string[] = [];
  const restore = setWorkerEngineHooks({ bumpSyncGeneration: (_ctx, ids, reason) => { bumps.push(`${ids.join(',')}:${reason}`); return bumps.length; } });
  try {
    // Both channels were registered while the workspace zone was still the default UTC.
    assert.deepEqual([settings(x.id).timezone, settings(tiktok.id).timezone], ['UTC', 'UTC']);
    // The owner sets TikTok to Tokyo on the channel page (the existing settings PATCH takes timezone).
    run('hub_channels_update_settings', { id: tiktok.id }, { timezone: 'Asia/Tokyo' }, { expectedVersion: settings(tiktok.id).version });
    const before = settings(x.id);
    const mark = events.length;
    updateWorkspace(ctx, { body: { default_timezone: 'Asia/Shanghai' }, params: {}, query: {} });
    assert.deepEqual([settings(x.id).timezone, settings(tiktok.id).timezone], ['Asia/Shanghai', 'Asia/Tokyo']);
    assert.equal(settings(x.id).settings_generation, before.settings_generation + 1, 'the Worker resyncs the new zone');
    assert.deepEqual(bumps.at(-1), `${device.id}:channel_settings`);
    assert.deepEqual(events.slice(mark).filter(event => event.type === 'account.channel_settings.changed').map(event => [event.payload.social_account_id, event.payload.fields]),
      [[x.id, ['timezone']]]);
    // Saving the same zone again moves nothing.
    const generation = settings(x.id).settings_generation;
    updateWorkspace(ctx, { body: { default_timezone: 'Asia/Shanghai' }, params: {}, query: {}, expectedVersion: ctx.list('workspace')[0]!.version });
    assert.equal(settings(x.id).settings_generation, generation);
  } finally { restore(); }
});
