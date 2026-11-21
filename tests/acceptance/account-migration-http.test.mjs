import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorRun } from '../../apps/connector/src/workflow.ts';
import { createSignedHttpTransport, pairOverHttp, SignedDeviceClient } from '../../apps/connector/src/device-client.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { connectorReady } from '../../apps/server/src/modules/account/device-control.ts';
import { mountAccountIngress } from '../../apps/server/src/modules/account/index.ts';
import { authorizeConnectorAttempt } from '../../apps/server/src/modules/execution/connector.ts';
import { ensureTask } from '../../apps/server/src/modules/execution/service.ts';
import { createExecutionWorker, scanExecution } from '../../apps/server/src/modules/execution/worker.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { createServer } from '../../apps/server/src/server.ts';
import { frozenRevisionHash } from '../../packages/connector-tasks/src/index.ts';
import { fileStore } from '../../packages/db/src/index.ts';
import { assessTarget } from '../../packages/domain/src/publishing/index.ts';

const Fastify = createRequire(new URL('../../apps/server/package.json', import.meta.url))('fastify');
const identity = 'owned-ac07-account';
const sha256 = 'a'.repeat(64);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-ac07-'));
  const store = await fileStore(join(directory, 'metadata.sqlite'));
  const setupToken = 'ac07-local-setup';
  const { operations } = await discoverOperations();
  const terms = { version: 'local-test-v1', text: 'Local synthetic connector terms' };
  const services = { connectorConfigured: () => true, terms: () => terms };
  const config = configuration({ SETUP_TOKEN: setupToken, HOST: '127.0.0.1', ROLE: 'all' });
  // The test owns dispatch so the host's background worker cannot race the manually driven signed worker.
  const app = createServer({
    config: { ...config, roles: new Set(['api']) }, store, operations,
    accountConnectorServices: services,
  });
  // The main server and account ingress both own an OAuth callback path.
  const ingress = Fastify();
  t.after(async () => {
    try { await ingress.close(); }
    finally {
      try { await app.close(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

  let scope;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-19T12:00:00Z') });
  const now = Date.now.bind(Date);
  const transact = (run, readOnly = false) => store.transaction({ readOnly }, async tx =>
    run({ ...makeContext(await tx.workspace(scope), scope, 'owner'), now: new Date(now()).toISOString() }));
  // Host routing for a single isolated workspace. The real ingress verifies pairing and signatures.
  const findWorkspace = (kind, match) => transact(ctx =>
    ctx.list(kind).some(match) ? scope.workspaceId : undefined, true);
  mountAccountIngress(ingress, {
    account: services,
    connector: {
      ...services, authorizeTask: authorizeConnectorAttempt,
      verifyEvidence: (ctx, evidence) => ctx.list('file_object').some(row => row.id === evidence.object_id &&
        row.purpose === 'evidence' && row.sha256 === evidence.sha256 && row.scan_status === 'clean'),
    },
    transaction: (workspaceId, run) => {
      assert.equal(workspaceId, scope.workspaceId);
      return transact(run);
    },
    pairingWorkspace: hash => findWorkspace('device_pairing_code', row => row.code_hash === hash),
    deviceWorkspace: id => findWorkspace('connector_device', row => row.id === id),
    oauthWorkspace: async () => undefined,
    webhookWorkspace: async () => undefined,
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const setup = await fetch(`${origin}/api/v1/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': setupToken },
    body: JSON.stringify({ email: 'owner@example.test', name: 'Owner', workspaceName: 'AC07', password: 'acceptance-only-1234' }),
  });
  assert.equal(setup.status, 201);
  const { csrf_token: csrf, workspaces: [workspace], user } = (await setup.json()).data;
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  scope = await store.transaction({ readOnly: true }, ({ identity: records }) => ({
    workspaceId: workspace.id, actorId: user.id, tenantId: records.get(`workspace/${workspace.id}`).tenantId,
  }));
  const prefix = `/api/v1/workspaces/${workspace.id}`;
  const call = async (method, path, body, { status = 200, code, version } = {}) => {
    const response = await fetch(`${origin}${prefix}${path}`, {
      method, headers: { cookie, 'x-csrf-token': csrf, ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(version !== undefined && { 'if-match': String(version) }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const content = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${content}`);
    const result = JSON.parse(content);
    if (code) assert.equal(result.code, code, `${method} ${path}`);
    return result.data;
  };
  const ingressOrigin = await ingress.listen({ host: '127.0.0.1', port: 0 });
  const transport = createSignedHttpTransport(ingressOrigin);
  async function pair(name) {
    const { pairing_code } = await call('POST', '/devices/pairing-codes', { owned_device_confirmed: true });
    const { privateKey } = generateKeyPairSync('ed25519');
    const id = await pairOverHttp(ingressOrigin, workspace.id, pairing_code, 'darwin', name, privateKey,
      { userInitiated: true, ownsDevice: true });
    const client = new SignedDeviceClient(workspace.id, id, privateKey, transport, now);
    await client.heartbeat('ac07-test');
    return { id, client };
  }
  const worker = createExecutionWorker(transact, [], {
    services,
    encode(ctx, task, binding) {
      const revision = { id: task.variant_revision_id, title: '', body: task.frozen.rendered.text, tags: [], visibility: 'public',
        media: task.frozen.media_bindings.map(media => ({ id: media.asset_version_id, sha256: media.sha256 })) };
      const frozen_hash = frozenRevisionHash(revision);
      const mobile = binding.connector_channel === 'mobile';
      return {
        schema_version: 1, workspace_id: ctx.workspaceId, connector_device_id: binding.device_id, account_id: task.social_account_id,
        binding_id: binding.id, platform_identity: identity, kind: mobile ? 'xhs.app.publish' : 'xhs.note.publish',
        target: mobile ? { channel: 'mobile', app: 'xhs', mobile_device_id: binding.mobile_device_id }
          : { channel: 'browser', app: 'xhs', profile_id: ctx.list('browser_session').find(row =>
            row.binding_id === binding.id && row.device_id === binding.device_id && row.status === 'verified').id },
        payload: { revision, approval: { id: task.approval_request_id, resource_hash: frozen_hash }, frozen_hash },
      };
    },
  });
  return { call, pair, transact, worker, origin, prefix, workspaceId: workspace.id, transport, terms,
    advance: ms => t.mock.timers.tick(ms) };
}

function seedApprovedTasks(ctx, account) {
  const accountId = account.id;
  const asset = ctx.create('asset', { status: 'ready', brand_id: account.brand_id });
  const file = ctx.create('file_object', { sha256, mime_type: 'image/jpeg', scan_status: 'clean' });
  const version = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id, sha256 });
  const grant = ctx.create('rights_grant', { status: 'active', brand_id: account.brand_id });
  const terms = ctx.create('rights_grant_revision', { rights_grant_id: grant.id, usages: ['organic_social'], valid_from: ctx.now });
  ctx.update('rights_grant', grant.id, { active_revision_id: terms.id });
  ctx.create('rights_grant_asset', { rights_grant_id: grant.id, asset_id: asset.id, version_scope: 'all_versions' });
  ctx.create('capability', { social_account_id: accountId, operation: 'publish', content_format: 'image', status: 'available', executor: 'connector' });
  const item = ctx.create('content_item', { brand_id: account.brand_id, title: 'Fixture note' });
  const variant = ctx.create('content_variant', { platform: 'xiaohongshu', format: 'image', content_item_id: item.id });
  const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'ac07-revision',
    rendered: { text: 'Approved AC07 test note' }, settings: { platform_options: { xiaohongshu: { visibility: 'public' } } },
    media: [{ asset_version_id: version.id }] });
  ctx.update('content_variant', variant.id, { current_revision_id: revision.id });
  function task() {
    const target = ctx.create('publish_target', { social_account_id: accountId, brand_id: account.brand_id, content_item_id: item.id, content_variant_id: variant.id,
      variant_revision_id: revision.id, content_format: 'image', operation: 'publish', plan_status: 'ready', scheduled_at: ctx.now,
      schedule_kind: 'exact', schedule_tz: 'UTC', snapshot_generation: 1 });
    const { hash } = assessTarget(ctx, target, 'approval');
    const approval = ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: target.id, resource_hash: hash, status: 'approved' });
    return ensureTask(ctx, ctx.update('publish_target', target.id, { frozen_hash: hash, approval_request_id: approval.id }));
  }
  const evidence = ctx.create('file_object', { sha256, purpose: 'evidence', scan_status: 'clean' });
  return { claimed: task(), queued: task(), unknown: task(), fresh: task(), evidence, grant, variant, revision };
}

function assertPreview(preview, bindingId, buckets) {
  assert.equal(preview.binding_id, bindingId);
  for (const key of ['queued', 'draining', 'retained']) {
    assert.deepEqual(preview[key].map(({ id, status }) => [id, status]).sort(), buckets[key].sort(), key);
  }
}

test('AC07 drains signed source claims, keeps unresolved attempts and verifies the new location before activation', async t => {
  const { call, pair, transact, worker, origin, prefix, workspaceId, transport, advance } = await fixture(t);
  const [source, target] = [await pair('Source computer'), await pair('Target computer')];
  const brand = await transact(ctx => ctx.create('brand', { name: 'AC07 brand', status: 'active' }));
  const account = await call('POST', '/social-accounts', { provider: 'xiaohongshu', external_account_id: identity,
    display_name: 'AC07 account', brand_id: brand.id, owned_account_confirmed: true });
  // Only local signed metadata is sent. There is no connected phone or platform submission.
  const phoneReport = { hardware_id_hash: 'b'.repeat(64), connection: 'usb', model: 'Fixture Android', serial_suffix: 'AC07',
    os_version: '13', driver_version: 'fixture' };
  const { mobile_device_id: phoneId } = await source.client.reportAndroid(phoneReport);
  const phone = await call('POST', `/mobile-devices/${phoneId}/approve`, { model: phoneReport.model,
    serial_suffix: phoneReport.serial_suffix, owned_device_confirmed: true });
  assert.equal(phone.status, 'ready');
  const appBinding = await call('POST', `/mobile-devices/${phoneId}/app-bindings`, {
    social_account_id: account.id, app: 'xhs', owned_account_confirmed: true,
  });
  assert.equal(await source.client.reportIdentity('mobile', appBinding.id, identity), 'verified');
  const bindingPath = `/social-accounts/${account.id}/execution-binding`;
  const { binding } = await call('PUT', bindingPath, { mode: 'connector', connector_channel: 'mobile', device_id: source.id,
    mobile_device_id: phoneId, mobile_app: 'xhs', owned_account_confirmed: true });

  const tasks = await transact(ctx => seedApprovedTasks(ctx, account));
  await worker.dispatch(tasks.claimed.id);
  const dispatched = await call('GET', `/execution-tasks/${tasks.claimed.id}`);
  assert.equal(dispatched.status, 'running', JSON.stringify({ reason: dispatched.status_reason, blockers: dispatched.precheck_blockers }));
  const claim = await source.client.claim(binding.id);
  assert.ok(claim, 'source must have claimed real queued work before migration');
  assert.equal(claim.task.target.mobile_device_id, phoneId);
  const rows = await transact(ctx => {
    const claimed = ctx.list('connector_task').find(row => row.attempt_id === claim.task.attempt_id);
    // Model a backlog plus an older unresolved attempt beside the live claim. Normal
    // enqueue serializes submissions per account, so only the claimed row uses the live slot.
    const fixtureRow = (task, connectorStatus, attemptStatus) => {
      const attempt = ctx.create('execution_attempt', { task_id: task.id, attempt_no: 1, executor: 'connector',
        status: attemptStatus, device_id: source.id, connector_channel: 'mobile', mobile_device_id: phoneId });
      const unknown = attemptStatus === 'unknown';
      ctx.update('execution_task', task.id, { status: unknown ? 'outcome_unknown' : 'running',
        attempt_count: 1, ...(unknown ? { latest_attempt_id: attempt.id } : { active_attempt_id: attempt.id, lease_expires_at: claim.lease_expires_at }) });
      const connector = ctx.create('connector_task', { task: { ...claim.task, attempt_id: attempt.id }, attempt_id: attempt.id,
        social_account_id: account.id, binding_id: binding.id, device_id: source.id, mobile_device_id: phoneId,
        status: connectorStatus, lease_expires_at: claim.lease_expires_at,
        ...(unknown && { result: { kind: 'outcome_unknown', attempt_id: attempt.id } }) });
      return { connector, attempt };
    };
    return { claimed, queued: fixtureRow(tasks.queued, 'queued', 'claimed'), unknown: fixtureRow(tasks.unknown, 'outcome_unknown', 'unknown') };
  });

  const migrationPath = `${bindingPath}/migration`;
  const appPath = `/mobile-app-bindings/${appBinding.id}`;
  const unauthenticated = await fetch(`${origin}${prefix}${migrationPath}/preview`);
  assert.equal(unauthenticated.status, 401);
  const mobileImpact = await call('GET', `${appPath}/impact`);
  assert.equal(mobileImpact.can_unbind, false);
  assert.deepEqual(mobileImpact.social_account_ids, [account.id]);
  const preview = await call('GET', `${migrationPath}/preview`);
  assertPreview(preview, binding.id, { queued: [[tasks.queued.id, 'running'], [tasks.fresh.id, 'queued']],
    draining: [[tasks.claimed.id, 'running']], retained: [[tasks.unknown.id, 'outcome_unknown']] });
  assert.deepEqual(new Set(preview.connector_task_ids), new Set([rows.queued.connector.id, rows.claimed.id, rows.unknown.connector.id]));
  assert.deepEqual(await call('GET', migrationPath), { migration: null, impact: preview });
  await call('DELETE', appPath, undefined, { status: 409, code: 'MOVE_EXECUTION_BINDING_FIRST' });

  const { migration, impact: startImpact } = await call('POST', migrationPath, { device_id: target.id, connector_channel: 'browser', owned_account_confirmed: true });
  assert.deepEqual(startImpact, preview);
  assert.equal(migration.status, 'draining');
  assert.equal(migration.source_binding_id, binding.id);
  assert.equal(migration.source_device_id, source.id);
  assert.equal(migration.source_connector_channel, 'mobile');
  assert.equal(migration.source_mobile_device_id, phoneId);
  assert.equal(migration.target_device_id, target.id);
  assert.equal(migration.target_connector_channel, 'browser');
  assert.ok(migration.target_session_id);
  const browserSession = async () => (await call('GET', '/browser-sessions')).find(row => row.id === migration.target_session_id);
  assert.equal((await browserSession()).status, 'pending_identity');
  const activeLocation = () => transact(ctx => {
    const row = ctx.get('account_execution_binding', binding.id);
    return { device: row.device_id, channel: row.connector_channel, ready: connectorReady(ctx, row) };
  }, true);
  assert.deepEqual(await activeLocation(), { device: source.id, channel: 'mobile', ready: false });
  await worker.dispatch(tasks.fresh.id);
  const detail = task => call('GET', `/execution-tasks/${task.id}`);
  const freshDuringDrain = await detail(tasks.fresh);
  assert.equal(freshDuringDrain.status, 'blocked');
  assert.deepEqual(freshDuringDrain.attempts, []);
  assert.equal(await source.client.claim(), null, 'queued work must stop being claimable on the source');
  assert.equal(await target.client.claim(), null, 'target must remain inactive during drain');
  const complete = options => call('POST', `${migrationPath}/complete`, {}, options);
  await complete({ status: 409, code: 'EXECUTION_DRAIN_REQUIRED' });
  await source.client.ready(claim, identity);

  const receipt = await source.client.report({ kind: 'accepted', submitted_by: 'human', attempt_id: claim.task.attempt_id,
    fencing_token: claim.fencing_token, write_slot_token: claim.write_slot_token, platform_post_id: 'synthetic-receipt',
    evidence: [{ kind: 'masked_screenshot', object_id: tasks.evidence.id, sha256 }] });
  assert.deepEqual(receipt, { status: 'outcome_unknown' });
  await transact(scanExecution);
  const draining = await call('GET', migrationPath);
  assert.equal(draining.migration.status, 'draining');
  assertPreview(draining.impact, binding.id, { queued: [[tasks.fresh.id, 'blocked'], [tasks.queued.id, 'queued']], draining: [],
    retained: [[tasks.claimed.id, 'accepted'], [tasks.unknown.id, 'outcome_unknown']] });
  assert.deepEqual(new Map(draining.impact.retained.map(row => [row.id, row.attempt_id])), new Map([
    [tasks.claimed.id, claim.task.attempt_id], [tasks.unknown.id, rows.unknown.attempt.id],
  ]));
  await complete({ status: 409, code: 'FRESH_IDENTITY_CHECK_REQUIRED' });
  await assert.rejects(source.client.reportIdentity('browser', migration.target_session_id, identity), { status: 403 });
  const wrongKey = new SignedDeviceClient(workspaceId, target.id, generateKeyPairSync('ed25519').privateKey, transport);
  await assert.rejects(wrongKey.reportIdentity('browser', migration.target_session_id, identity), { status: 401 });
  await complete({ status: 409, code: 'FRESH_IDENTITY_CHECK_REQUIRED' });
  assert.equal((await browserSession()).status, 'pending_identity');
  assert.deepEqual(await activeLocation(), { device: source.id, channel: 'mobile', ready: false });
  assert.equal(await target.client.reportIdentity('browser', migration.target_session_id, 'different-account'), 'blocked');
  await complete({ status: 409, code: 'FRESH_IDENTITY_CHECK_REQUIRED' });
  advance(1); // Block resolution requires verification strictly after the mismatch.
  assert.equal(await target.client.reportIdentity('browser', migration.target_session_id, identity), 'verified');
  assert.equal((await browserSession()).status, 'verified');
  assert.deepEqual(await activeLocation(), { device: source.id, channel: 'mobile', ready: false });
  const completed = await complete();
  assert.equal(completed.migration.status, 'completed');
  assert.equal((await call('GET', migrationPath)).migration.status, 'completed');
  assert.deepEqual(await activeLocation(), { device: target.id, channel: 'browser', ready: true });

  for (const [task, attemptId, status] of [[tasks.claimed, claim.task.attempt_id, 'accepted'],
    [tasks.unknown, rows.unknown.attempt.id, 'outcome_unknown']]) {
    const result = await detail(task);
    assert.equal(result.status, status);
    assert.deepEqual(result.attempts.map(attempt => [attempt.id, attempt.device_id]), [[attemptId, source.id]]);
    assert.deepEqual(result.pending_side_effects, [attemptId]);
    assert.equal(result.platform_post, null);
    await call('POST', `/execution-tasks/${task.id}/retry`, {}, { status: 409, code: 'OUTCOME_UNKNOWN' });
    await worker.dispatch(task.id);
    assert.deepEqual((await detail(task)).attempts.map(attempt => attempt.id), [attemptId]);
  }
  assert.equal(await source.client.claim(), null);
  assert.equal(await target.client.claim(), null, 'retained outcomes must never be redelivered to the target');

  // The deliberately mismatched identity opened a normal account block. Resolve it with the verified target session.
  const blocks = await call('GET', `/account-blocks?social_account_id=${account.id}`);
  const mismatch = blocks.find(row => row.kind === 'identity_mismatch');
  assert.ok(mismatch);
  await call('POST', `/account-blocks/${mismatch.id}/resolve`, {});
  const queued = await detail(tasks.queued);
  assert.equal(queued.status, 'queued');
  assert.deepEqual(queued.attempts.map(row => [row.id, row.status]), [[rows.queued.attempt.id, 'abandoned']]);
  await worker.dispatch(tasks.queued.id);
  assert.equal(await source.client.claim(), null);
  const targetClaim = await target.client.claim(binding.id);
  assert.ok(targetClaim, 'the target must receive the abandoned work on a fresh attempt');
  assert.notEqual(targetClaim.task.attempt_id, rows.queued.attempt.id);
  assert.equal(targetClaim.task.connector_device_id, target.id);
  assert.deepEqual(targetClaim.task.target, { channel: 'browser', app: 'xhs', profile_id: migration.target_session_id });
  assert.deepEqual(new Set((await detail(tasks.queued)).attempts.map(row => row.id)), new Set([rows.queued.attempt.id, targetClaim.task.attempt_id]));
  await assert.rejects(source.client.ready(claim, identity), { status: 409 });
  await assert.rejects(source.client.request(permitInput(targetClaim)), { status: 409 });
  await assert.rejects(source.client.report({ ...claimTokens(targetClaim), kind: 'outcome_unknown' }), { status: 409 });
  assert.equal(targetClaim.effective_mode, 'assist');
  await target.client.ready(targetClaim, identity);
  assert.deepEqual((await detail(tasks.claimed)).pending_side_effects, [claim.task.attempt_id]);
  assert.deepEqual((await detail(tasks.unknown)).pending_side_effects, [rows.unknown.attempt.id]);
  const unbindImpact = await call('GET', `${appPath}/impact`);
  assert.deepEqual(unbindImpact.social_account_ids, [account.id]);
  assert.equal(unbindImpact.can_unbind, true);
  const unbound = await call('DELETE', appPath);
  assert.equal(unbound.status, 'revoked');
  assert.match(unbound.guidance.join(' '), /revok.*debug/i);
  const appBindings = await call('GET', '/mobile-app-bindings');
  assert.equal(appBindings.find(row => row.id === appBinding.id)?.status, 'revoked');

  await source.client.heartbeat('ac07-before-revoke');
  await call('POST', `/devices/${source.id}/revoke`, {});
  await assert.rejects(source.client.heartbeat('ac07-after-revoke'), { status: 401 });
  await assert.rejects(source.client.claim(), { status: 401 });
  await target.client.heartbeat('ac07-active-target');
});

test('AC07 phone-to-phone cutover requires a new signed identity check even on the same host', async t => {
  const { call, pair, transact } = await fixture(t);
  const host = await pair('Shared host');
  const brand = await transact(ctx => ctx.create('brand', { name: 'AC07 brand', status: 'active' }));
  const account = await call('POST', '/social-accounts', { provider: 'xiaohongshu', external_account_id: identity,
    display_name: 'AC07 account', brand_id: brand.id, owned_account_confirmed: true });
  async function stagePhone(hex, serial_suffix) {
    const model = `Fixture Android ${serial_suffix}`;
    const { mobile_device_id } = await host.client.reportAndroid({ hardware_id_hash: hex.repeat(64), connection: 'usb',
      model, serial_suffix, os_version: '13', driver_version: 'fixture' });
    await call('POST', `/mobile-devices/${mobile_device_id}/approve`, { model, serial_suffix, owned_device_confirmed: true });
    const session = await call('POST', `/mobile-devices/${mobile_device_id}/app-bindings`, {
      social_account_id: account.id, app: 'xhs', owned_account_confirmed: true,
    });
    return { device_id: host.id, connector_channel: 'mobile', mobile_device_id, mobile_app: 'xhs',
      owned_account_confirmed: true, session };
  }
  const { session: source, ...initial } = await stagePhone('c', 'AC01');
  assert.equal(await host.client.reportIdentity('mobile', source.id, identity), 'verified');
  const path = `/social-accounts/${account.id}/execution-binding`;
  const { binding } = await call('PUT', path, { ...initial, mode: 'connector' });
  const { session: destination, ...target } = await stagePhone('d', 'AC02');
  assert.equal(await host.client.reportIdentity('mobile', destination.id, identity), 'verified');
  await call('PUT', path, { ...target, mode: 'connector' }, { status: 409, code: 'USE_BINDING_MIGRATION' });
  await call('POST', `${path}/migration`, target);
  await call('POST', `${path}/migration/complete`, {}, { status: 409, code: 'FRESH_IDENTITY_CHECK_REQUIRED' });
  await call('DELETE', `/mobile-app-bindings/${destination.id}`, undefined, { status: 409, code: 'MOVE_EXECUTION_BINDING_FIRST' });
  assert.equal(await host.client.reportIdentity('mobile', destination.id, identity), 'verified');
  const { migration } = await call('POST', `${path}/migration/complete`, {});
  assert.equal(migration.status, 'completed');
  assert.equal(migration.target_mobile_device_id, target.mobile_device_id);
  assert.equal(await transact(ctx => connectorReady(ctx, ctx.get('account_execution_binding', binding.id)), true), true);
  assert.equal((await call('DELETE', `/mobile-app-bindings/${source.id}`)).status, 'revoked');
  await assert.rejects(host.client.reportIdentity('mobile', source.id, identity), { status: 403 });
  await host.client.heartbeat('shared-host-still-active');
});

async function browserPublication(f) {
  const device = await f.pair('Local publication fixture');
  const brand = await f.transact(ctx => ctx.create('brand', { name: 'Publishing fixture', status: 'active' }));
  const account = await f.call('POST', '/social-accounts', { provider: 'xiaohongshu', external_account_id: identity,
    display_name: 'Owned fixture account', brand_id: brand.id, owned_account_confirmed: true, default_timezone: 'UTC' });
  const path = `/social-accounts/${account.id}/execution-binding`;
  const { binding } = await f.call('PUT', path, { mode: 'connector', connector_channel: 'browser', device_id: device.id, owned_account_confirmed: true });
  const session = (await f.call('GET', '/browser-sessions')).find(row => row.social_account_id === account.id && row.device_id === device.id);
  assert.equal(await device.client.reportIdentity('browser', session.id, identity), 'verified');
  const tasks = await f.transact(ctx => seedApprovedTasks(ctx, account));
  const claim = async (task = tasks.claimed) => {
    await f.worker.dispatch(task.id);
    const result = await device.client.claim(binding.id);
    assert.ok(result, 'worker must deliver a signed connector claim');
    await device.client.ready(result, identity);
    return result;
  };
  const detail = (task = tasks.claimed) => f.call('GET', `/execution-tasks/${task.id}`);
  const enableAuto = (overrides = {}) => f.call('POST', `${path}/auto-mode`, { terms_version: f.terms.version, risk_acknowledged: true,
    max_per_hour: 2, min_interval_seconds: 120, daily_cap: 8, allowed_windows: [{ start: '00:00', end: '23:59' }, { start: '23:00', end: '01:00' }], ...overrides });
  return { ...device, binding, account, path, tasks, claim, detail, enableAuto };
}

test('AC07 browser-to-phone cutover fences the old host and delivers safe work to the verified phone', async t => {
  const f = await fixture(t);
  const source = await browserPublication(f);
  const destination = await f.pair('Destination Android host');
  const phone = { hardware_id_hash: 'e'.repeat(64), connection: 'usb', model: 'Fixture Android', serial_suffix: 'AC07',
    os_version: '13', driver_version: 'fixture' };
  const { mobile_device_id } = await destination.client.reportAndroid(phone);
  await f.call('POST', `/mobile-devices/${mobile_device_id}/approve`, {
    model: phone.model, serial_suffix: phone.serial_suffix, owned_device_confirmed: true,
  });
  const app = await f.call('POST', `/mobile-devices/${mobile_device_id}/app-bindings`, {
    social_account_id: source.account.id, app: 'xhs', owned_account_confirmed: true,
  });
  const path = `${source.path}/migration`;
  await f.call('POST', path, { device_id: destination.id, connector_channel: 'mobile', mobile_device_id,
    mobile_app: 'xhs', owned_account_confirmed: true });
  await f.worker.dispatch(source.tasks.fresh.id);
  assert.equal(await source.client.claim(source.binding.id), null);
  assert.equal(await destination.client.claim(source.binding.id), null);
  await f.call('POST', `${path}/complete`, {}, { status: 409, code: 'FRESH_IDENTITY_CHECK_REQUIRED' });
  await assert.rejects(source.client.reportIdentity('mobile', app.id, identity), { status: 403 });
  assert.equal(await destination.client.reportIdentity('mobile', app.id, identity), 'verified');
  await f.call('POST', `${path}/complete`, {});
  await f.transact(scanExecution);
  await f.worker.dispatch(source.tasks.fresh.id);
  const claim = await destination.client.claim(source.binding.id);
  assert.ok(claim, JSON.stringify(await source.detail(source.tasks.fresh)));
  assert.deepEqual(claim.task.target, { channel: 'mobile', app: 'xhs', mobile_device_id });
  await assert.rejects(source.client.request(permitInput(claim)), { status: 409 });
  await destination.client.ready(claim, identity);
  assert.equal(await source.client.claim(source.binding.id), null);
});

const claimTokens = claim => ({ attempt_id: claim.task.attempt_id, fencing_token: claim.fencing_token, write_slot_token: claim.write_slot_token });
const permitInput = claim => ({ ...claimTokens(claim), request_hash: claim.task.payload.frozen_hash });

test('signed auto permits defer by frequency, consume once, and isolate a lost result', async t => {
  const f = await fixture(t);
  const s = await browserPublication(f);
  await s.enableAuto();
  const retry_at = await f.transact(ctx => {
    // A recent grant still counts even though the previous attempt did not consume it.
    const now = Date.parse(ctx.now);
    ctx.create('auto_submit_permit', { attempt_id: 'prior-fixture-attempt', social_account_id: s.account.id,
      status: 'denied', granted_at: new Date(now - 60_000).toISOString() });
    return new Date(now + 60_000).toISOString();
  });
  const claim = await s.claim();
  assert.equal(claim.effective_mode, 'auto');
  const input = permitInput(claim);
  assert.deepEqual(await s.client.request(input), { decision: 'deferred', deny_reason: 'min_interval', retry_at });
  assert.equal(await f.transact(ctx => ctx.list('auto_submit_permit').length, true), 1);
  f.advance(61_000);
  await s.client.heartbeat('after-frequency-window');
  await s.client.ready(claim, identity);
  await assert.rejects(s.client.request({ ...input, request_hash: '0'.repeat(64) }), { status: 403 });
  const permit = await s.client.request(input);
  assert.equal(permit.decision, 'granted');
  assert.deepEqual(await s.client.request(input), permit);
  const consume = { ...input, permit_id: permit.permit_id };
  assert.deepEqual(await s.client.consume(consume), { decision: 'granted' });
  await assert.rejects(s.client.consume(consume), { status: 409 });
  const report = { ...claimTokens(claim), kind: 'outcome_unknown', submitted_by: 'auto' };
  assert.deepEqual(await s.client.report(report), { status: 'outcome_unknown' });
  await assert.rejects(s.client.report(report), { status: 409 });
  await f.transact(scanExecution);
  const task = await s.detail();
  assert.equal(task.status, 'outcome_unknown');
  assert.deepEqual(task.pending_side_effects, [claim.task.attempt_id]);
  assert.equal(task.attempts[0].submitted_by, 'auto');
  assert.equal(task.platform_post, null);
  assert.equal(task.verifications.length, 1);
  for (const action of ['retry', 'handover']) {
    await f.call('POST', `/execution-tasks/${task.id}/${action}`, {}, { status: 409, code: 'OUTCOME_UNKNOWN' });
  }
  await f.worker.dispatch(task.id);
  assert.equal(await s.client.claim(s.binding.id), null);
  assert.equal((await s.detail()).attempts.length, 1);
});

test('stop between permit and consume leaves a confirmed assist timeout for manual handover', async t => {
  const f = await fixture(t);
  const s = await browserPublication(f);
  await s.enableAuto();
  const claim = await s.claim();
  const { task: wire } = claim;
  let closeCount = 0;
  const client = {
    request: input => s.client.request(input),
    async consume(input) {
      await f.call('POST', `${s.path}/auto-halt`, {});
      return s.client.consume(input);
    },
  };
  const driver = {
    state: () => ({ host: 'darwin', pairing: { device_id: s.id, workspace_id: f.workspaceId, owned: true, revoked: false },
      bindings: [{ ...wire.target, id: s.binding.id, workspace_id: f.workspaceId, account_id: s.account.id,
        connector_device_id: s.id, platform_identity: identity, owned: true, verified: true, consent_confirmed: true, dedicated: true }] }),
    identity: () => ({ kind: 'signed_in', platform_identity: identity }),
    approvalValid: () => true,
    mediaAvailable: () => true,
    stage() {},
    openAssist() {},
    observeAssist: () => 'waiting',
    closeAssist() { closeCount++; return 'closed'; },
    submitAuto() { assert.fail('The halted attempt must never submit'); },
  };
  const run = new ConnectorRun(claim, driver, client, Date.now, undefined, (current, observed) => s.client.ready(current, observed));
  const timeout = Date.now() + 30 * 60_000;
  assert.deepEqual(await run.advance(), { kind: 'awaiting_user_click', expires_at: new Date(timeout).toISOString(), downgrade_reason: 'emergency_halt' });
  f.advance(30 * 60_000 - 1);
  assert.equal((await run.advance()).kind, 'awaiting_user_click');
  assert.equal(closeCount, 0);
  f.advance(1);
  await f.transact(scanExecution);
  assert.equal((await s.detail()).status, 'running');
  assert.deepEqual(await run.advance(), { kind: 'blocked', reason: 'assist_submit_timeout', handoff: 'manual' });
  assert.equal(closeCount, 1);
  const report = run.report();
  assert.deepEqual(await s.client.report(report), { status: 'completed' });
  await f.transact(scanExecution);
  const task = await s.detail();
  assert.equal(task.status, 'manual');
  assert.equal(task.sub_status, 'awaiting_assignee');
  assert.ok(task.fencing_token > claim.fencing_token);
  assert.deepEqual(task.pending_side_effects, []);
  assert.deepEqual(task.attempts.map(({ id, status, submitted_by }) => [id, status, submitted_by ?? null]), [[claim.task.attempt_id, 'abandoned', null]]);
  assert.equal(task.handovers[0].from_attempt_id, claim.task.attempt_id);
  assert.equal(task.handovers[0].reason, 'assist_submit_timeout');
  assert.ok(task.steps.some(step => step.step === 'assist_timeout' && step.detail.page_closed_without_submission));
  assert.equal(task.platform_post, null);
  await assert.rejects(s.client.report(report), { status: 409 });
  await f.worker.dispatch(task.id);
  assert.equal((await s.detail()).attempts.length, 1);
  assert.equal(await f.transact(ctx => ctx.list('account_write_slot')[0].holder_id, true), null);
  assert.equal(await f.transact(ctx => ctx.get('account_execution_binding', s.binding.id).auto_failure_streak, true), 0);
});

test('workspace auto stop and release preserve account settings but invalidate an outstanding permit', async t => {
  const f = await fixture(t);
  const s = await browserPublication(f);
  await assert.rejects(s.enableAuto({ risk_acknowledged: false }), /AUTO_TERMS_REQUIRED/);
  assert.equal(await f.transact(ctx => ctx.get('account_execution_binding', s.binding.id).connector_mode, true), 'assist');
  const enabled = await s.enableAuto();
  assert.ok(enabled.auto_ack_by);
  assert.ok(enabled.auto_ack_at);
  assert.equal(enabled.auto_ack_terms_version, f.terms.version);
  const claim = await s.claim();
  const input = permitInput(claim);
  const permit = await s.client.request(input);
  assert.equal(permit.decision, 'granted');
  assert.deepEqual(await f.call('POST', '/connector-auto-policy/halt', {}), { halt_sources: ['workspace'] });
  assert.deepEqual(await f.call('POST', '/connector-auto-policy/release', {}), { halt_sources: [] });
  assert.deepEqual(await s.client.consume({ ...input, permit_id: permit.permit_id }), { decision: 'denied', deny_reason: 'emergency_halt' });
  const state = await f.transact(ctx => ({ binding: ctx.get('account_execution_binding', s.binding.id),
    permit: ctx.get('auto_submit_permit', permit.permit_id), connector: ctx.list('connector_task')[0] }), true);
  assert.equal(state.binding.connector_mode, 'auto');
  assert.equal(state.permit.status, 'denied');
  assert.equal(state.connector.effective_mode, 'assist');
});

test('rights revoked after connector readiness blocks consume and preserves the frozen revision', async t => {
  const f = await fixture(t);
  const s = await browserPublication(f);
  await s.enableAuto();
  const claim = await s.claim();
  const input = permitInput(claim);
  const permit = await s.client.request(input);
  assert.equal(permit.decision, 'granted');
  await f.call('POST', `/rights-grants/${s.tasks.grant.id}/revoke`, { revocation_effect: 'stop_new_use' }, { version: s.tasks.grant.version + 1 });
  await assert.rejects(s.client.consume({ ...input, permit_id: permit.permit_id }), { status: 403 });
  assert.equal(await f.transact(ctx => ctx.get('auto_submit_permit', permit.permit_id).status, true), 'granted');
  await f.worker.dispatch(s.tasks.fresh.id);
  const task = await s.detail(s.tasks.fresh);
  assert.equal(task.status, 'blocked');
  assert.deepEqual(task.attempts, []);
  assert.equal(task.variant_revision_id, s.tasks.revision.id);
  assert.equal(task.frozen_hash, s.tasks.fresh.frozen_hash);
  assert.equal(task.platform_post, null);
  const state = await f.transact(ctx => ({ variant: ctx.get('content_variant', s.tasks.variant.id),
    approval: ctx.get('approval_request', s.tasks.fresh.approval_request_id) }), true);
  assert.equal(state.variant.readiness, 'stale');
  assert.equal(state.approval.status, 'invalidated');
});


test('PL–EX reapproval refreezes one task and the connector receives only the new revision', async t => {
  const f = await fixture(t);
  const s = await browserPublication(f);
  const { fresh: before, revision, variant } = s.tasks;
  const path = `/publish-targets/${before.publish_target_id}`;
  const original = await f.call('GET', path);
  const updatedRevision = await f.transact(ctx => {
    const updated = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'replacement-revision',
      rendered: { text: 'Replacement fixture caption' }, settings: revision.settings, media: revision.media });
    ctx.update('content_variant', variant.id, { current_revision_id: updated.id });
    return updated;
  });
  const update = { variant_revision_id: updatedRevision.id };
  await f.call('PATCH', path, update, { version: original.version - 1, status: 409, code: 'VERSION_CONFLICT' });
  const changed = await f.call('PATCH', path, update, { version: original.version });
  assert.equal(changed.plan_status, 'awaiting_approval');
  assert.equal(changed.frozen_hash, null);
  await f.worker.dispatch(before.id);
  assert.equal(await s.client.claim(s.binding.id), null);
  const blocked = await s.detail(before);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.frozen_hash, before.frozen_hash);
  assert.equal(blocked.variant_revision_id, revision.id);
  assert.deepEqual(blocked.attempts, []);
  const stale = { approval_request_id: original.approval_request_id, resource_hash: original.frozen_hash };
  const submitted = await f.call('POST', `${path}/submit`, {}, { version: changed.version });
  assert.notEqual(submitted.approval_request_id, stale.approval_request_id);
  await f.call('POST', `${path}/approve`, stale, { version: submitted.version, status: 409, code: 'APPROVAL_STALE' });
  await f.call('POST', `${path}/approve`, { approval_request_id: submitted.approval_request_id, resource_hash: submitted.frozen_hash }, { version: submitted.version });
  const refrozen = await s.detail(before);
  assert.equal(refrozen.id, before.id);
  assert.ok(refrozen.snapshot_generation > before.snapshot_generation);
  assert.equal(refrozen.frozen_version, before.frozen_version + 1);
  assert.equal(refrozen.variant_revision_id, updatedRevision.id);
  assert.equal(refrozen.frozen_hash, submitted.frozen_hash);
  assert.notEqual(refrozen.frozen_hash, before.frozen_hash);
  const claim = await s.claim(before);
  assert.equal(claim.task.payload.revision.id, updatedRevision.id);
  assert.equal(claim.task.payload.revision.body, 'Replacement fixture caption');
  assert.equal(claim.task.payload.approval.id, submitted.approval_request_id);
  assert.equal((await s.detail(before)).attempts.length, 1);
});


test('auto permit denies publication outside the local window without creating a grant', async t => {
  const f = await fixture(t);
  const s = await browserPublication(f);
  await s.enableAuto({ allowed_windows: [{ start: '13:00', end: '14:00' }] });
  const claim = await s.claim();
  assert.deepEqual(await s.client.request(permitInput(claim)), { decision: 'denied', deny_reason: 'outside_window' });
  assert.equal(await f.transact(ctx => ctx.list('auto_submit_permit').length, true), 0);
});

test('auto permit denies publication at the daily cap without creating a grant', async t => {
  const f = await fixture(t);
  const s = await browserPublication(f);
  await s.enableAuto({ daily_cap: 1 });
  await seedPreviousAutoGrant(f, s.account.id);
  const claim = await s.claim();
  assert.deepEqual(await s.client.request(permitInput(claim)), { decision: 'denied', deny_reason: 'daily_cap' });
  assert.equal(await f.transact(ctx => ctx.list('auto_submit_permit').length, true), 1);
});

function seedPreviousAutoGrant(f, accountId) {
  return f.transact(ctx => ctx.create('auto_submit_permit', {
    attempt_id: 'prior-fixture-attempt', social_account_id: accountId, status: 'consumed',
    granted_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  }));
}

test('auto permit hourly deferral beyond grace requires an explicit late decision', async t => {
  const f = await fixture(t);
  const s = await browserPublication(f);
  await s.enableAuto({ max_per_hour: 1 });
  await seedPreviousAutoGrant(f, s.account.id);
  const claim = await s.claim();
  await assert.rejects(s.client.request(permitInput(claim)), { status: 409 });
  await f.transact(scanExecution);
  const late = await s.detail();
  assert.equal(late.status, 'blocked');
  assert.equal(late.sub_status, 'late_awaiting_decision');
  assert.deepEqual(late.attempts.map(attempt => attempt.status), ['abandoned']);
  assert.deepEqual(late.pending_side_effects, []);
  assert.equal(await f.transact(ctx => ctx.list('auto_submit_permit').length, true), 1);
});

test('assist lease expiration without a closure report keeps the original attempt uncertain', async t => {
  const f = await fixture(t);
  const s = await browserPublication(f);
  const claim = await s.claim();
  assert.equal(claim.effective_mode, 'assist');
  f.advance(Date.parse(claim.lease_expires_at) - Date.now());
  await f.transact(scanExecution);
  const task = await s.detail();
  assert.equal(task.status, 'outcome_unknown');
  assert.deepEqual(task.pending_side_effects, [claim.task.attempt_id]);
  assert.deepEqual(task.handovers, []);
  assert.equal(task.platform_post, null);
  await assert.rejects(s.client.report({ ...claimTokens(claim), kind: 'blocked', reason: 'assist_submit_timeout' }), { status: 409 });
  await f.call('POST', `/execution-tasks/${task.id}/handover`, {}, { status: 409, code: 'OUTCOME_UNKNOWN' });
});
