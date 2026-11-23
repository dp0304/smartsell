import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HTTPMethods } from 'fastify';
import { workerSocialPlatforms } from '@smartsell/contracts';
import { fileStore } from '@smartsell/db';
import { buildApp } from '../../app.js';
import { configuration } from '../../config.js';
import { makeContext } from '../../context.js';
import { commandBackgroundStore } from '../../integration/command-background.js';
import { createCommerceProviders } from '../../integration/commerce-providers.js';
import { createPublishHost } from '../../integration/publish-host.js';
import { localStore } from '../../local.js';
import { registerOperationRoutes } from '../../operation-server.js';
import { discoverOperations } from '../../operations.js';
import { kernelBackgroundStore } from '../../runtime.js';
import { createServer } from '../../server.js';
import { deviceRequestBytes } from './device-control.js';

type Json = Record<string, any>;
const requestTool = 'worker_social_status_request';
const getTool = 'worker_social_status_get';
const urls = {
  heartbeat: 'heartbeat', claim: 'claim', 'zhihu.stats.claim': 'zhihu-stats/claim', 'catalog.claim': 'catalog/claim',
  'social.status.claim': 'social-status/claim', 'social.status.report': 'social-status/report',
};

for (const runtime of ['Commands', 'Operations']) test(`${runtime}: MCP, signed Worker and Web share a scoped social status task`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-social-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = configuration({ SETUP_TOKEN: 'social-status-fixture-setup' });
  const { operations } = await discoverOperations();
  const commands = runtime === 'Commands';
  const kernel = commands ? undefined : await fileStore(join(dir, 'kernel.json'));
  const command = commands ? localStore(join(dir, 'command.sqlite')) : undefined;
  const background = kernel ? kernelBackgroundStore(kernel) : commandBackgroundStore(command!);
  const providers = createCommerceProviders(config);
  const bound = operations.map(op => providers.bindOperation(op));
  const app = kernel ? createServer({ config, store: kernel, operations }) : buildApp({ ...config, registry: new Map(), store: command!,
    operationApi: { config, operations: bound, register: registerOperationRoutes } }).app;
  if (command) createPublishHost(providers.account).mount(app, background);
  t.after(() => app.close());

  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': config.setupToken! }, payload: {
    username: 'social-status-owner', name: 'Owner', password: 'fixture-only-password',
    ...(commands ? { workspaceName: 'Social statuses' } : { workspace_name: 'Social statuses' }),
  } });
  assert.equal(setup.statusCode, 201, setup.body);
  const wid = setup.json().data.workspaces[0].id as string;
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const csrf = await app.inject({ url: '/api/v1/session/csrf', headers: { cookie } });
  const owner = { cookie, 'x-csrf-token': csrf.json().csrf_token, origin: config.origin };
  const root = `/api/v1/workspaces/${wid}`;
  async function rest(path: string, status = 200, payload?: Json, headers: Record<string, string> = owner,
    method: HTTPMethods = payload === undefined ? 'GET' : 'POST') {
    const response = await app.inject({ url: !path.startsWith('/api/') ? root + path : path, method, payload, headers });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  }
  const token = (await rest('/tokens', 201, { access: 'write', tools: [requestTool, getTool] })).data.token;
  const reader = (await rest('/tokens', 201, { access: 'read', tools: [requestTool, getTool] })).data.token;
  const limited = (await rest('/tokens', 201, { access: 'write', tools: commands ? ['smartsell_operation_call'] : [] })).data.token;
  async function rpc(method: string, params: Json = {}, bearer = token) {
    const response = await app.inject({ url: '/mcp', method: 'POST', headers: {
      authorization: `Bearer ${bearer}`, accept: 'application/json, text/event-stream',
    }, payload: { jsonrpc: '2.0', id: randomUUID(), method, params } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  const names = async (bearer?: string) => (await rpc('tools/list', {}, bearer)).result.tools.map((tool: Json) => tool.name);
  assert.deepEqual(new Set(await names()), new Set([requestTool, getTool]));
  assert.deepEqual(await names(reader), [getTool]);
  if (commands) {
    const generic = await rpc('tools/call', { name: 'smartsell_operation_call', arguments: { operation: requestTool, idempotency_key: 'not-granted' } }, limited);
    assert.equal(generic.result.structuredContent.error.code, 'PERMISSION_DENIED');
  } else assert.deepEqual(await names(limited), []);
  async function call(name: string, args: Json = {}, error?: string) {
    const reply = await rpc('tools/call', { name, arguments: { workspace_id: wid, ...args } });
    const result = reply.result?.structuredContent;
    if (error) {
      assert.equal(reply.result.isError, true, JSON.stringify(reply));
      const problem = result.error ?? result.data;
      assert.equal(problem.code, error, JSON.stringify(reply));
      return problem;
    }
    assert.ok(result?.data && !reply.result.isError, JSON.stringify(reply));
    assert.deepEqual(JSON.parse(reply.result.content[0].text), result);
    return result.data;
  }
  const request = (key: string, body?: Json, error?: string) => call(requestTool, { idempotency_key: key, ...(body && { body }) }, error);
  await request('no-pairing', undefined, 'SOCIAL_STATUS_WORKER_UNPAIRED');

  async function pair(name: string) {
    const { pairing_code } = (await rest('/devices/pairing-codes', 200, { owned_device_confirmed: true })).data;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const public_key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const proof = sign(null, Buffer.from(JSON.stringify(['smartsell.pair.v1', wid, pairing_code, public_key, 'darwin', name])), privateKey).toString('base64url');
    const { device_id: id } = (await rest('/api/v1/device/pair', 200, { pairing_code, public_key, platform: 'darwin', name, proof },
      { 'x-smartsell-workspace': wid })).data;
    return { id: id as string, privateKey };
  }
  const first = await pair('First fixture Worker');
  const second = await pair('Second fixture Worker');
  function signed(device: typeof first, action: keyof typeof urls, data: Json, signedAs = action) {
    const payload = Buffer.from(JSON.stringify(data));
    const at = new Date().toISOString();
    const nonce = randomBytes(18).toString('base64url');
    const proof = sign(null, deviceRequestBytes(wid, device.id, signedAs, at, nonce, payload), device.privateKey).toString('base64url');
    return { method: 'POST' as const, url: `/api/v1/device/${urls[action]}`, payload, headers: {
      'content-type': 'application/json', 'x-smartsell-workspace': wid, 'x-smartsell-device': device.id,
      'x-smartsell-timestamp': at, 'x-smartsell-nonce': nonce, 'x-smartsell-signature': proof,
    } };
  }
  async function deviceReq(input: ReturnType<typeof signed>, status = 200, code?: string) {
    const response = await app.inject(input);
    assert.equal(response.statusCode, status, `${input.url}: ${response.body}`);
    if (code) assert.equal(response.json().error.code, code);
    return response.json().data;
  }
  const ws = (await background.workspaces()).find(workspace => workspace.id === wid)!;
  const change = <T,>(run: (ctx: ReturnType<typeof makeContext>) => T) => background.transact(ws, false, (records, scope) => run(makeContext(records, scope, 'owner')));
  assert.deepEqual(await deviceReq(signed(first, 'heartbeat', { client_version: 'old-worker' })), { status: 'online' });
  await request('old-worker', undefined, 'SOCIAL_STATUS_WORKER_UNSUPPORTED');
  await deviceReq(signed(first, 'social.status.claim', {}), 409, 'SOCIAL_STATUS_WORKER_UNSUPPORTED');
  await change(ctx => ctx.update('connector_device', first.id, { last_seen_at: '2000-01-01T00:00:00Z' }));
  await request('offline', { device_id: first.id }, 'SOCIAL_STATUS_WORKER_OFFLINE');
  await request('wrong-device', { device_id: randomUUID() }, 'SOCIAL_STATUS_WORKER_NOT_FOUND');
  await deviceReq(signed(first, 'heartbeat', { client_version: 'new', social_status_version: 1 }, 'claim'), 401, 'INVALID_DEVICE_PROOF');
  const heartbeat = signed(first, 'heartbeat', { client_version: 'new', social_status_version: 1, include_bindings: true });
  assert.equal((await deviceReq(heartbeat)).social_status_version, 1);
  await deviceReq(heartbeat, 401, 'DEVICE_PROOF_REPLAYED');

  const defaultTask = await request('default-task');
  assert.equal(defaultTask.mode, 'account_status');
  assert.equal(defaultTask.device_id, first.id);
  assert.equal(defaultTask.result, undefined);
  await change(ctx => ctx.update('worker_social_status_task', defaultTask.id, { queue_expires_at: ctx.now }));
  assert.equal((await call(getTool, { params: { id: defaultTask.id } })).status, 'expired');
  assert.deepEqual(await deviceReq(signed(first, 'social.status.claim', {})), { claim: null });
  assert.equal((await deviceReq(signed(second, 'heartbeat', { client_version: 'new', social_status_version: 1 }))).social_status_version, 1);
  await request('ambiguous', undefined, 'SOCIAL_STATUS_WORKER_AMBIGUOUS');
  await request('foreign-platform', { device_id: first.id, mode: 'recent_posts', platform: 'youtube' }, 'INVALID_INPUT');
  await request('extra-command', { url: 'https://example.test/', device_id: first.id }, 'INVALID_INPUT');
  await call(requestTool, { body: { device_id: first.id } }, 'VALIDATION_FAILED');
  const foreign = await rpc('tools/call', { name: requestTool, arguments: { workspace_id: randomUUID(), idempotency_key: 'foreign-workspace' } });
  assert.equal(foreign.result.isError, true);

  const ownerId = await change(ctx => {
    const ownerId = ctx.get('connector_device', first.id).owner_id;
    const own = ctx.create('social_account', { provider: 'x', owner_id: ownerId, status: 'active', external_account_id: 'fixture_owner' });
    const foreign = ctx.create('social_account', { provider: 'x', owner_id: randomUUID(), status: 'active', external_account_id: 'fixture_foreign' });
    for (const account of [own, foreign]) ctx.create('account_execution_binding', { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: first.id });
    return ownerId;
  });
  await request('foreign-account', { device_id: first.id, mode: 'recent_posts', expected_identity: 'fixture_foreign' }, 'SOCIAL_STATUS_IDENTITY_SCOPE');
  const body = { device_id: first.id, mode: 'recent_posts' };
  const queued = await request('my-recent-posts', body);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.platform, 'x');
  assert.equal(queued.expected_identity, 'fixture_owner');
  assert.equal((await request('my-recent-posts', body)).id, queued.id);
  await request('my-recent-posts', { ...body, expected_identity: '@fixture_owner' }, 'IDEMPOTENCY_MISMATCH');
  const path = `/worker-social-status/${queued.id}`;
  assert.equal((await rest(path)).data.status, 'queued');
  assert.equal((await rest(path, 200, undefined, { authorization: `Bearer ${reader}` })).data.id, queued.id);
  await call(getTool, { params: { id: queued.id }, idempotency_key: 'read-key' }, 'INVALID_INPUT');
  const otherTask = await change(ctx => ctx.create('worker_social_status_task', { mode: 'account_status', owner_id: randomUUID(), device_id: first.id, status: 'queued' }));
  await call(getTool, { params: { id: otherTask.id } }, 'NOT_FOUND');

  const holds = await change(ctx => ['connector_task', 'worker_catalog_job', 'zhihu_stats_task'].map(kind => ({ kind, id: ctx.create(kind, {
    device_id: first.id, owner_id: ownerId, status: 'claimed', ...(kind === 'worker_catalog_job'
      ? { expires_at: new Date(Date.now() + 60_000).toISOString() } : { lease_expires_at: new Date(Date.now() + 60_000).toISOString() }),
  }).id })));
  for (const hold of holds) {
    assert.deepEqual(await deviceReq(signed(first, 'social.status.claim', {})), { claim: null });
    await change(ctx => ctx.remove(hold.kind, hold.id));
  }
  const attempts = await Promise.all([deviceReq(signed(first, 'social.status.claim', {})), deviceReq(signed(first, 'social.status.claim', {}))]);
  assert.equal(attempts.filter(result => result.claim).length, 1);
  const { claim } = attempts.find(result => result.claim);
  assert.equal(claim.id, queued.id);
  assert.equal(claim.workspace_id, wid);
  assert.equal(claim.device_id, first.id);
  assert.equal(claim.expected_identity, 'fixture_owner');
  assert.equal((await rest(path)).data.status, 'claimed');
  const waiting = await change(ctx => {
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const store = ctx.create('store', { external_store_id: 'fixture-store', provider: 'shopify', status: 'active' });
    const binding = ctx.create('worker_catalog_binding', { device_id: first.id, store_id: store.id, external_store_id: store.external_store_id, provider: store.provider });
    return [
      ['connector_task', ctx.create('connector_task', { device_id: first.id, status: 'queued', lease_expires_at: deadline }).id],
      ['zhihu_stats_task', ctx.create('zhihu_stats_task', { device_id: first.id, owner_id: ownerId, mode: 'login_check', status: 'queued' }).id],
      ['worker_catalog_job', ctx.create('worker_catalog_job', { device_id: first.id, store_id: store.id, external_store_id: store.external_store_id,
        provider: store.provider, binding_id: binding.id, binding_version: binding.version, status: 'queued', expires_at: deadline }).id],
    ] as const;
  });
  for (const action of ['claim', 'catalog.claim', 'zhihu.stats.claim'] as const) {
    assert.deepEqual(await deviceReq(signed(first, action, {})), action === 'catalog.claim' ? { job: null } : { claim: null });
  }
  await change(ctx => {
    for (const [kind, id] of waiting) {
      assert.equal(ctx.get(kind, id).status, 'queued');
      ctx.remove(kind, id);
    }
  });

  const post = { id: '12345', url: 'https://x.com/fixture_owner/status/12345', text: 'A fixture lure video', has_video: true };
  const channel = { platform: 'x', status: 'verified', identity: 'fixture_owner', posts: [post] };
  const report = { id: claim.id, fencing_token: claim.fencing_token, result: { channels: [channel] } };
  const reportWith = (change: Json) => ({ ...report, result: { channels: [{ ...channel, ...change }] } });
  await deviceReq(signed(second, 'social.status.report', report), 403, 'DEVICE_SCOPE_MISMATCH');
  await deviceReq(signed(first, 'social.status.report', { ...report, fencing_token: 2 ** 48 }), 409, 'SOCIAL_STATUS_FENCE_MISMATCH');
  await deviceReq(signed(first, 'social.status.report', reportWith({ identity: 'fixture_foreign' })), 422, 'SOCIAL_STATUS_IDENTITY_MISMATCH');
  await deviceReq(signed(first, 'social.status.report', reportWith({ status: 'login_required' })), 422, 'INVALID_INPUT');
  for (const badPost of [{ url: 'https://example.test/status/12345' }, { url: 'https://x.com/other/status/12345' },
    { url: 'https://x.com/fixture_owner/status/12346' }, { has_video: 'true' }, { text: 'x'.repeat(501) }]) {
    await deviceReq(signed(first, 'social.status.report', reportWith({ posts: [{ ...post, ...badPost }] })), 422, 'INVALID_SOCIAL_STATUS_POST');
  }
  await deviceReq(signed(first, 'social.status.report', reportWith({ posts: Array(6).fill(post) })), 422, 'INVALID_INPUT');
  await deviceReq(signed(first, 'social.status.report', reportWith({ posts: [post, post] })), 422, 'INVALID_SOCIAL_STATUS_POST');
  const receipt = { id: queued.id, status: 'completed' };
  assert.deepEqual(await deviceReq(signed(first, 'social.status.report', report)), receipt);
  assert.deepEqual(await deviceReq(signed(first, 'social.status.report', report)), receipt);
  await deviceReq(signed(first, 'social.status.report', reportWith({ posts: [] })), 409, 'SOCIAL_STATUS_RESULT_CONFLICT');
  const saved = (await rest(path)).data;
  assert.equal(saved.id, queued.id);
  assert.equal(saved.device_id, first.id);
  assert.equal(saved.status, 'completed');
  assert.ok(Date.parse(saved.reported_at) > 0);
  assert.deepEqual(saved.result, report.result);
  assert.deepEqual(await call(getTool, { params: { id: queued.id } }), saved);

  const denied = await request('login-required', { device_id: first.id, mode: 'account_status', platform: 'x' });
  const deniedClaim = (await deviceReq(signed(first, 'social.status.claim', {}))).claim;
  assert.equal(deniedClaim.id, denied.id);
  assert.deepEqual(await deviceReq(signed(first, 'social.status.report', { id: denied.id, fencing_token: deniedClaim.fencing_token,
    result: { channels: [{ platform: 'x', status: 'login_required' }] } })), { id: denied.id, status: 'blocked' });
  assert.equal((await rest(`/worker-social-status/${denied.id}`)).data.status, 'blocked');
  const audit = (await rest('/mcp-tool-calls?tool=worker_social_status_report')).data;
  assert.deepEqual(new Set(audit.map(({ task_id, status }: Json) => `${task_id}:${status}`)), new Set([`${queued.id}:completed`, `${denied.id}:blocked`]));
  assert.equal(audit.length, 2);
  assert.ok(audit.every((row: Json) => row.device_id === first.id && row.actor_id === ownerId));
  assert.ok(!JSON.stringify(audit).includes(post.text));

  const late = await request('late-report', body);
  const lateClaim = (await deviceReq(signed(first, 'social.status.claim', {}))).claim;
  assert.equal(lateClaim.id, late.id);
  await change(ctx => ctx.update('worker_social_status_task', late.id, { lease_expires_at: ctx.now }));
  await deviceReq(signed(first, 'social.status.report', { ...report, id: late.id, fencing_token: lateClaim.fencing_token }), 409, 'SOCIAL_STATUS_LEASE_EXPIRED');
  assert.equal((await call(getTool, { params: { id: late.id } })).status, 'expired');

  const unbound = await request('unbound-recent-posts', { mode: 'recent_posts', device_id: second.id });
  const unboundClaim = (await deviceReq(signed(second, 'social.status.claim', {}))).claim;
  assert.equal(unboundClaim.id, unbound.id);
  assert.equal(unboundClaim.expected_identity, undefined);
  await deviceReq(signed(second, 'social.status.report', { id: unbound.id, fencing_token: unboundClaim.fencing_token,
    result: { channels: [channel] } }), 422, 'SOCIAL_STATUS_IDENTITY_SCOPE');
  const unboundResult = { channels: [{ platform: 'x', status: 'verified', identity: 'only_on_worker', posts: [] }] };
  await deviceReq(signed(second, 'social.status.report', { id: unbound.id, fencing_token: unboundClaim.fencing_token, result: unboundResult }));
  assert.deepEqual((await rest(`/worker-social-status/${unbound.id}`)).data.result, unboundResult);

  const all = (await rest('/worker-social-status', 202, { device_id: second.id }, {
    authorization: `Bearer ${token}`, 'idempotency-key': 'web-all-channels',
  })).data;
  const allClaim = (await deviceReq(signed(second, 'social.status.claim', {}))).claim;
  const channels = workerSocialPlatforms.map(platform => platform === 'x' ? { platform, status: 'verified', identity: 'only_on_worker' }
    : { platform, status: 'unverified' });
  const allReport = { id: allClaim.id, fencing_token: allClaim.fencing_token, result: { channels } };
  await deviceReq(signed(second, 'social.status.report', { ...allReport, result: { channels: channels.slice(1) } }), 422, 'INVALID_INPUT');
  assert.deepEqual(await deviceReq(signed(second, 'social.status.report', allReport)), { id: all.id, status: 'blocked' });
  assert.deepEqual((await rest(`/worker-social-status/${all.id}`)).data.result.channels, channels);
});
