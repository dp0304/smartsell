import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CheckLoginPayload, Context, Problem } from '@smartsell/contracts';
import { buildApp } from '../../app.js';
import { configuration } from '../../config.js';
import { makeContext } from '../../context.js';
import { operationRecords } from '../../integration/operation-records.js';
import { MemoryStore } from '../../memory.js';
import { registerOperationRoutes } from '../../operation-server.js';
import { discoverOperations } from '../../operations.js';
import { discover } from '../../registry.js';
import { ensureChannelSettings } from '../account/channel-settings.js';
import { hubFixture } from '../worker/fixtures.js';
import { checkChannel } from './check.js';
import { operations } from './index.js';
import { parseOperationBody, parseToolArgs } from './schemas.js';

/** E21 「重新登入」: hub_channels_check with open_login_window, a person's decision only (phase1-design Appendix E, §8.16 step 7, §5.12). */

type Json = Record<string, any>;
const problem = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error as Problem; }
  return assert.fail('expected a Problem');
};
const payloadOf = (job: Json) => job.payload as CheckLoginPayload;
const asAgent = (ctx: Context) => Object.assign(Object.create(ctx), { agentCredentialId: 'credential-a' }) as Context;

test('a person\'s 重新登入 creates check_login{open_login_window:true} on the bound machine through the real job engine', () => {
  const f = hubFixture();
  const result = checkChannel(f.ctx, f.account.id, { open_login_window: true });
  const job = f.job(result.task_id);
  assert.deepEqual([job.kind, job.device_id, job.social_account_id, job.status], ['check_login', f.device.id, f.account.id, 'queued']);
  assert.equal(payloadOf(job).open_login_window, true);
  assert.deepEqual([result.status, result.open_login_window, result.machine?.name, result.channel_id], ['pending', true, 'Mac-B', f.account.id]);
  assert.deepEqual(f.ctx.list('worker_job_event').filter(row => row.job_id === job.id).map(row => [row.event, (row.detail as Json).open_login_window]),
    [['dispatched', true]]);
  // Pressing it again reuses the open check: one job per channel.
  assert.equal(checkChannel(f.ctx, f.account.id, { open_login_window: true }).task_id, job.id);
  assert.equal(f.ctx.list('worker_job').filter(row => row.kind === 'check_login').length, 1);
  // The machine claims exactly that payload.
  const claimed = f.claim() as unknown as { jobs: { job_id: string; payload: CheckLoginPayload }[] };
  assert.equal(claimed.jobs.find(row => row.job_id === job.id)?.payload.open_login_window, true);
});

test('a plain check never opens the window; 重新登入 upgrades it while queued and says so honestly once the machine holds it', () => {
  const f = hubFixture();
  const plain = checkChannel(f.ctx, f.account.id, {});
  assert.equal(payloadOf(f.job(plain.task_id)).open_login_window, false);
  assert.equal('open_login_window' in plain, false, 'the channel_check output (§7.2.4) is unchanged without the field');
  // Still queued: the same job now opens the window (C3 createCheckLoginJob upgrade), with a new payload hash.
  const before = f.job(plain.task_id).payload_hash;
  const upgraded = checkChannel(f.ctx, f.account.id, { open_login_window: true });
  assert.deepEqual([upgraded.task_id, upgraded.open_login_window], [plain.task_id, true]);
  assert.equal(payloadOf(f.job(plain.task_id)).open_login_window, true);
  assert.notEqual(f.job(plain.task_id).payload_hash, before);

  const g = hubFixture();
  const held = checkChannel(g.ctx, g.account.id, {});
  g.claim();
  assert.equal(g.job(held.task_id).status, 'claimed');
  const late = checkChannel(g.ctx, g.account.id, { open_login_window: true });
  // The machine already runs the plain check: no window this time, and the answer says so instead of pretending.
  assert.deepEqual([late.task_id, late.open_login_window, late.status], [held.task_id, false, 'pending']);
  assert.equal(payloadOf(g.job(held.task_id)).open_login_window, false);
  // An offline machine: the request is queued and reported as machine_offline.
  const h = hubFixture();
  h.ctx.update('connector_device', h.device.id, { last_seen_at: '2026-12-31T00:00:00.000Z' });
  const offline = checkChannel(h.ctx, h.account.id, { open_login_window: true });
  assert.deepEqual([offline.status, offline.open_login_window], ['machine_offline', true]);
});

test('an Agent credential that sends open_login_window gets 403 HUMAN_REQUIRED whatever the value, and nothing is created', () => {
  const f = hubFixture();
  const agent = asAgent(f.ctx);
  for (const value of [true, false, 'yes']) {
    const refused = problem(() => checkChannel(agent, f.account.id, { open_login_window: value }));
    assert.deepEqual([refused.status, refused.code], [403, 'HUMAN_REQUIRED'], String(value));
  }
  // The legacy agent role is an Agent too.
  assert.equal(problem(() => checkChannel(Object.assign(Object.create(f.ctx), { role: 'agent' }) as Context, f.account.id, { open_login_window: true })).code, 'HUMAN_REQUIRED');
  assert.equal(f.ctx.list('worker_job').length, 0);
  // The Agent's own login check still works and does not open a window.
  const own = checkChannel(agent, f.account.id, {});
  assert.equal(payloadOf(f.job(own.task_id)).open_login_window, false);
});

test('the hub_channels_check body stays strict; the MCP channel_check tool has no open_login_window at all', () => {
  assert.deepEqual(parseOperationBody('hub_channels_check', { open_login_window: true }), { open_login_window: true });
  assert.deepEqual(parseOperationBody('hub_channels_check', undefined), {});
  const unknown = problem(() => parseOperationBody('hub_channels_check', { open_login_window: true, wait_seconds: 5 }));
  assert.equal(unknown.code, 'INVALID_ARGUMENTS');
  assert.deepEqual((unknown.details as Json).issues.map((issue: Json) => [issue.path, issue.allowed]), [['wait_seconds', ['open_login_window']]]);
  assert.deepEqual((problem(() => parseOperationBody('hub_channels_check', { open_login_window: 'yes' })).details as Json).issues.map((issue: Json) => issue.path),
    ['open_login_window']);
  const f = hubFixture();
  assert.equal(problem(() => checkChannel(f.ctx, f.account.id, { open_login_window: true, extra: 1 })).code, 'INVALID_ARGUMENTS');
  assert.equal(f.ctx.list('worker_job').length, 0);
  const tool = problem(() => parseToolArgs('channel_check', { channel_id: '7c2f3a4b-5d6e-4f70-9a8b-0c1d2e3f4a5b', open_login_window: true }));
  assert.deepEqual((tool.details as Json).issues.map((issue: Json) => issue.path), ['open_login_window']);
  // The REST contract the catalog shows: one optional boolean, nothing else.
  const body = operations.find(op => op.name === 'hub_channels_check')!.contract!.body as Json;
  assert.deepEqual([body.additionalProperties, Object.keys(body.properties), body.properties.open_login_window.type, body.required], [false, ['open_login_window'], 'boolean', undefined]);
});

// ---------- Through the real hub: owner REST, Agent MCP (shared runner) ----------

const accept = 'application/json, text/event-stream';

async function hub(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-lfix-'));
  const config = configuration({ SETUP_TOKEN: 'l-fix-relogin-setup-token', MEDIA_DIRECTORY: join(dir, 'media') });
  const store = new MemoryStore();
  const [{ operations: all }, discovered] = await Promise.all([discoverOperations(), discover()]);
  const { app } = buildApp({ ...config, ...discovered, store, operationApi: { config, operations: all, register: registerOperationRoutes } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(path: string, { method = 'GET', body, headers = {} }: { method?: string; body?: unknown; headers?: Json } = {}) {
    const response = await fetch(base + path, { method, headers: { ...headers, ...body !== undefined && { 'content-type': 'application/json' } },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) as Json : {} };
  }
  const setup = await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': config.setupToken! },
    body: JSON.stringify({ email: 'relogin-owner@example.test', name: 'Owner', workspaceName: 'Relogin', password: 'acceptance-only-1234' }) });
  assert.equal(setup.status, 201);
  const { data: { workspaces: [{ id: wid }] } } = await setup.json();
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  const session = createHash('sha256').update(decodeURIComponent(cookie.split('=')[1]!)).digest('hex');
  const csrf = (await request('/api/v1/session/csrf', { headers: { cookie } })).body.csrf_token as string;
  const owner = { cookie, 'x-csrf-token': csrf };
  const root = `/api/v1/workspaces/${wid}`;
  const write = <T>(fn: (ctx: Context) => T) => store.workspace(session, wid, unit => unit.command({ module: 'test', action: 'seed', key: `test/${randomUUID()}`, fingerprint: '' }, async () => {
    const { records, flush } = await operationRecords(unit.context, false);
    const result = fn(makeContext(records, unit.context, unit.context.role));
    await flush();
    return result;
  })) as Promise<T>;
  const read = <T>(fn: (ctx: Context) => T) => store.workspace(session, wid, async unit => {
    const { records } = await operationRecords(unit.context, true);
    return fn(makeContext(records, unit.context, unit.context.role));
  });
  const brand = (await request(`${root}/brands`, { method: 'POST', body: { name: 'Lure Lab', slug: 'lurelab' }, headers: owner })).body.data as Json;
  const seeded = await write(ctx => {
    const channel = (provider: string, handle: string, machine: string) => {
      const device = ctx.create('connector_device', { name: `${machine.toLowerCase()}.local`, display_name: machine, status: 'active', platform: 'darwin',
        last_seen_at: ctx.now, owner_id: ctx.actorId });
      const account = ctx.create('social_account', { provider, status: 'active', brand_id: brand.id, external_account_id: handle, handle, display_name: handle, default_timezone: 'UTC' });
      const binding = ctx.create('account_execution_binding', { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: device.id,
        mobile_device_id: null, mobile_app: null, connector_mode: 'assist', paused: false });
      ctx.create('browser_session', { social_account_id: account.id, binding_id: binding.id, device_id: device.id, status: 'login_required', checked_at: ctx.now });
      ensureChannelSettings(ctx, account.id);
      return { device: device.id, account: account.id };
    };
    return { x: channel('x', 'makemylure', 'Mac-B'), tiktok: channel('tiktok', 'lurelab', 'Win-C') };
  });
  const connection = (await request(`${root}/agent-connections`, { method: 'POST', body: { label: 'MacBook Claude', client: 'claude_code' }, headers: owner })).body.data as Json;
  const call = async (name: string, args: Json) => {
    const response = await request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } },
      headers: { authorization: `Bearer ${connection.token}`, accept } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.result, JSON.stringify(response.body));
    return response.body.result as Json;
  };
  const jobs = () => read(ctx => ctx.list('worker_job').filter(row => row.kind === 'check_login'));
  return { request, call, owner, root, seeded, jobs };
}

test('through the hub: the owner\'s REST 重新登入 opens the window; an Agent over MCP gets HUMAN_REQUIRED and keeps its plain check', async t => {
  const h = await hub(t);
  const path = (id: string) => `${h.root}/hub/channels/${id}/check`;
  // Agent, through smartsell_operation_call (the shared runner): refused for true and for false, nothing created.
  for (const value of [true, false]) {
    const refused = await h.call('smartsell_operation_call', { operation: 'hub_channels_check', params: { id: h.seeded.x.account }, body: { open_login_window: value } });
    assert.equal(refused.isError, true, JSON.stringify(refused));
    assert.equal(refused.structuredContent.error.code, 'HUMAN_REQUIRED', JSON.stringify(refused));
  }
  // Agent, through the hub tool: the strict schema has no such field.
  const tool = await h.call('channel_check', { channel_id: h.seeded.x.account, open_login_window: true, wait_seconds: 0 });
  assert.equal(tool.isError, true);
  assert.deepEqual([tool.structuredContent.error.code, tool.structuredContent.error.issues.map((issue: Json) => issue.path)], ['INVALID_ARGUMENTS', ['open_login_window']]);
  assert.equal((await h.jobs()).length, 0);
  // The Agent's ordinary check still works (no window).
  const plain = await h.call('channel_check', { channel_id: h.seeded.tiktok.account, wait_seconds: 0 });
  assert.equal(plain.isError, undefined, JSON.stringify(plain));
  assert.equal('open_login_window' in plain.structuredContent, false);

  // The owner, through REST with session + CSRF.
  const relogin = await h.request(path(h.seeded.x.account), { method: 'POST', body: { open_login_window: true }, headers: h.owner });
  assert.equal(relogin.status, 200, JSON.stringify(relogin.body));
  const data = relogin.body.data as Json;
  assert.deepEqual([data.status, data.open_login_window, data.machine.name, data.login], ['pending', true, 'Mac-B', 'checking']);
  const job = (await h.jobs()).find(row => row.id === data.task_id)!;
  assert.deepEqual([job.device_id, job.social_account_id, payloadOf(job).open_login_window], [h.seeded.x.device, h.seeded.x.account, true]);
  // The owner's 重新登入 on the channel whose plain check the Agent queued turns that queued check into a window check.
  const upgrade = (await h.request(path(h.seeded.tiktok.account), { method: 'POST', body: { open_login_window: true }, headers: h.owner })).body.data as Json;
  assert.deepEqual([upgrade.task_id, upgrade.open_login_window], [plain.structuredContent.task_id, true]);
  // Unknown fields still fail strictly on REST.
  const strict = await h.request(path(h.seeded.x.account), { method: 'POST', body: { open_login_window: true, wait_seconds: 5 }, headers: h.owner });
  assert.equal(strict.status, 422, JSON.stringify(strict.body));
  assert.equal((await h.jobs()).length, 2);
});
