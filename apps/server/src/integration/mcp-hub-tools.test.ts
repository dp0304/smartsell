import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { AUTOMATION_NOTICE_VERSION, Problem, RISK_TERMS_VERSION, type Context, type Row, type WorkerJobRecord } from '@smartsell/contracts';
import { runRelay } from '../../../../packages/agent-relay/src/relay.ts';
import { buildApp } from '../app.js';
import { configuration } from '../config.js';
import { makeContext } from '../context.js';
import { MemoryStore } from '../memory.js';
import { registerOperationRoutes } from '../operation-server.js';
import { discoverOperations } from '../operations.js';
import { discover } from '../registry.js';
import { ensureChannelSettings, setWorkerEngineHooks } from '../modules/account/channel-settings.js';
import { localMinute } from '../../../../packages/domain/src/publishing/index.js';
import { HUB_INSTRUCTIONS_MAX_BYTES, hubInstructions } from './mcp-hub-instructions.js';
import { operationRecords } from './operation-records.js';

type Json = Record<string, any>;
const accept = 'application/json, text/event-stream';
const ZONE = 'Asia/Shanghai';
const HUB_TOOLS = ['smartsell_overview', 'machines_list', 'channels_list', 'channel_check', 'media_upload', 'post_schedule', 'post_update',
  'posts_list', 'post_get', 'task_get', 'publishing_pause'];
const tiktokDefaults = { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false };

/** A small mp4 the relay's magic-number check accepts: ftyp + mdat filler (ffprobe may not parse it; §6.5 E3 keeps it ready). */
function fakeMp4(size: number) {
  const bytes = Buffer.alloc(size);
  bytes.write('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2', 0, 'latin1');
  bytes.writeUInt32BE(size - 24, 24);
  bytes.write('mdat', 28, 'latin1');
  for (let index = 32; index < size; index++) bytes[index] = (index * 31) & 0xff;
  return bytes;
}

/** An in-process hub: the real app, Operation routes, /mcp, the agent upload routes and a real agent connection. */
async function hub(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-s4-hub-'));
  const config = configuration({ SETUP_TOKEN: 'mcp-hub-tools-setup-token', MEDIA_DIRECTORY: join(dir, 'media') });
  const store = new MemoryStore();
  const [{ operations }, discovered] = await Promise.all([discoverOperations(), discover()]);
  const { app } = buildApp({ ...config, ...discovered, store, operationApi: { config, operations, register: registerOperationRoutes } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(path: string, { method = 'GET', body, headers = {}, status = 200 }: { method?: string; body?: unknown; headers?: Json; status?: number } = {}) {
    const response = await fetch(base + path, { method, headers: { ...headers, ...body !== undefined && { 'content-type': 'application/json' } },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    return raw ? JSON.parse(raw) : undefined;
  }
  const setup = await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': config.setupToken! },
    body: JSON.stringify({ email: 'hub-owner@example.test', name: 'Owner', workspaceName: 'MakeMyLure', password: 'acceptance-only-1234' }) });
  assert.equal(setup.status, 201);
  const { data: { workspaces: [{ id: wid }] } } = await setup.json();
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  const session = createHash('sha256').update(decodeURIComponent(cookie.split('=')[1]!)).digest('hex');
  const { csrf_token } = await request('/api/v1/session/csrf', { headers: { cookie } });
  const owner = { cookie, 'x-csrf-token': csrf_token };
  const root = `/api/v1/workspaces/${wid}`;
  /** One short write transaction on the Operation records, as the owner. */
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

  // The §7.6 world: workspace in Asia/Shanghai; Mac-B holds X (direct, risk accepted); Win-C holds TikTok (needs_approval, assist).
  await request(root, { method: 'PATCH', body: { default_timezone: ZONE }, headers: owner });
  const brand = (await request(`${root}/brands`, { method: 'POST', body: { name: 'MakeMyLure', slug: 'makemylure' }, headers: owner })).data;
  const now = Date.now();
  const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const seeded = await write(ctx => {
    const channel = (provider: string, handle: string, machine: string, checkedHoursAgo: number) => {
      const device = ctx.create('connector_device', { name: `${machine.toLowerCase()}.local`, display_name: machine, status: 'active', platform: 'darwin',
        last_seen_at: ctx.now, owner_id: ctx.actorId });
      const account = ctx.create('social_account', { provider, status: 'active', brand_id: brand.id, external_account_id: handle, handle, display_name: handle, default_timezone: ZONE });
      const binding = ctx.create('account_execution_binding', { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: device.id,
        mobile_device_id: null, mobile_app: null, connector_mode: 'assist', paused: false });
      ctx.create('browser_session', { social_account_id: account.id, binding_id: binding.id, device_id: device.id, status: 'verified',
        verified_at: ago(checkedHoursAgo), checked_at: ago(checkedHoursAgo) });
      ensureChannelSettings(ctx, account.id);
      return { device: device.id, account: account.id };
    };
    return { x: channel('x', 'makemylure', 'Mac-B', 3), tiktok: channel('tiktok', 'lurelab', 'Win-C', 13) };
  });
  // The owner's own settings, through the human-only REST operations.
  const hubChannel = `${root}/hub/channels`;
  await request(`${hubChannel}/${seeded.x.account}/settings`, { method: 'PATCH', body: { approval_mode: 'direct' }, headers: { ...owner, 'if-match': '1' } });
  await request(`${hubChannel}/${seeded.x.account}/automation-notice`, { method: 'POST', body: { version: AUTOMATION_NOTICE_VERSION }, headers: owner });
  await request(`${hubChannel}/${seeded.x.account}/risk-ack`, { method: 'POST', body: { terms_version: RISK_TERMS_VERSION, typed_handle: '@makemylure' }, headers: owner });
  await request(`${hubChannel}/${seeded.tiktok.account}/settings`, { method: 'PATCH', body: { approval_mode: 'needs_approval', platform_defaults: { tiktok: tiktokDefaults } },
    headers: { ...owner, 'if-match': '1' } });
  await request(`${hubChannel}/${seeded.tiktok.account}/automation-notice`, { method: 'POST', body: { version: AUTOMATION_NOTICE_VERSION }, headers: owner });
  const connection = (await request(`${root}/agent-connections`, { method: 'POST', status: 201, body: { label: 'MacBook Claude', client: 'claude_code' }, headers: owner })).data;

  // A stand-in for the S3 job engine's check_login creation (C3), recorded so tests can see each call.
  const checks: string[] = [];
  const restore = setWorkerEngineHooks({
    createCheckLoginJob(ctx, accountId) {
      checks.push(accountId);
      const device = ctx.list('account_execution_binding').find(row => row.social_account_id === accountId)!.device_id;
      return ctx.create('worker_job', { kind: 'check_login', status: 'queued', social_account_id: accountId, device_id: device, publish_target_id: null,
        not_before: ctx.now, not_after: new Date(Date.parse(ctx.now) + 600_000).toISOString(), dry_run: false, revoke: null, blocker: null, result: null }) as unknown as WorkerJobRecord;
    },
  });
  t.after(restore);

  let calls = 0;
  const rpc = async (method: string, params: Json = {}, token = connection.token) => {
    if (method === 'tools/call') calls++;
    const value = await request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: randomUUID(), method, params }, headers: { authorization: `Bearer ${token}`, accept } });
    assert.ok(value.result, JSON.stringify(value));
    return value.result;
  };
  const call = (name: string, args: Json = {}) => rpc('tools/call', { name, arguments: args });
  return { base, config, store, request, write, read, rpc, call, owner, root, wid, session, seeded, connection, checks, dir, toolCalls: () => calls };
}

const ok = (result: Json) => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
};
const failure = (result: Json) => {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), { error: result.structuredContent.error });
  return result.structuredContent.error;
};

/** The S5 relay over in-memory stdio, pointing at the in-process hub: what Claude Code or Codex would spawn. */
function relayClient(t: TestContext, hubOrigin: string, token: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: Json[] = [];
  const waiters: (() => void)[] = [];
  let buffer = '';
  stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) { output.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); waiters.splice(0).forEach(fn => fn()); }
  });
  const done = runRelay({ hubOrigin, token, stdin, stdout, stderr, pollMs: 50, waitForUploads: false });
  t.after(async () => { stdin.end(); await done; });
  const toolCalls: string[] = [];
  async function send(method: string, params: Json = {}) {
    const id = randomUUID();
    if (method === 'tools/call') toolCalls.push(String(params.name));
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (;;) {
      const found = output.find(item => item.id === id && !item.method);
      if (found) { assert.ok(found.result, JSON.stringify(found)); return found.result as Json; }
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  }
  return { send, call: (name: string, args: Json) => send('tools/call', { name, arguments: args }), toolCalls };
}

const tomorrow = () => {
  const today = localMinute(new Date().toISOString(), ZONE).slice(0, 10);
  return new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
};

test('§7.6 done criterion over real MCP: overview → media_upload through the relay → one post_schedule to X on Mac-B and TikTok on Win-C', async t => {
  const h = await hub(t);
  const video = join(h.dir, 'work', 'video.mp4');
  mkdirSync(join(h.dir, 'work'), { recursive: true });
  writeFileSync(video, fakeMp4(3 * 1024 * 1024 + 123));
  const client = relayClient(t, h.base, h.connection.token);
  const init = await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'done-criterion', version: '1' } });
  assert.equal(init.serverInfo.name, 'smartsell');
  assert.equal(init.instructions, hubInstructions);
  const listed = (await client.send('tools/list')).tools as Json[];
  assert.deepEqual(listed.map(tool => tool.name), HUB_TOOLS);

  // 1. smartsell_overview: channel_ids and the workspace time zone.
  const overview = ok(await client.call('smartsell_overview', {}));
  assert.equal(overview.workspace.timezone, ZONE);
  // S8 item 4: the name the owner gave at setup, although the workspace settings record (made by the time zone PATCH) has none.
  assert.equal(overview.workspace.name, 'MakeMyLure');
  assert.equal((await h.request(`${h.root}/views/overview`, { headers: h.owner })).data.workspace.name, 'MakeMyLure', 'the web overview too');
  assert.equal((await h.request(h.root, { headers: h.owner })).data.name, 'MakeMyLure', 'workspace_get (the get-started form prefill)');
  const xChannel = overview.channels.find((row: Json) => row.provider === 'x' && row.machine === 'Mac-B');
  const tiktokChannel = overview.channels.find((row: Json) => row.provider === 'tiktok' && row.machine === 'Win-C');
  assert.deepEqual([xChannel.channel_id, xChannel.mode, xChannel.approval, xChannel.can_schedule], [h.seeded.x.account, 'auto', 'direct', true]);
  assert.deepEqual([tiktokChannel.channel_id, tiktokChannel.mode, tiktokChannel.approval, tiktokChannel.can_schedule], [h.seeded.tiktok.account, 'assist', 'needs_approval', true]);
  assert.deepEqual(overview.machines.map((row: Json) => [row.name, row.online, row.channels]).sort(), [['Mac-B', true, 1], ['Win-C', true, 1]]);

  // 2. media_upload: the relay reads the file locally and uploads it through the hub's agent upload routes (C4/C5).
  const media = ok(await client.call('media_upload', { path: video }));
  assert.equal(media.status, 'ready', JSON.stringify(media));
  assert.equal(media.bytes, 3 * 1024 * 1024 + 123);
  assert.equal(media.kind, 'video');

  // 3. post_schedule: one call, tomorrow 09:00, workspace time zone, no caption (never invented).
  const day = tomorrow();
  const scheduled = ok(await client.call('post_schedule', { media_ids: [media.media_id], channel_ids: [xChannel.channel_id, tiktokChannel.channel_id], when: `${day} 09:00` }));
  assert.equal(client.toolCalls.length, 3);
  assert.ok(client.toolCalls.length <= 6, 'the done criterion allows at most 6 MCP tool calls');
  assert.equal(scheduled.replayed, false);
  const [x, tiktok] = scheduled.posts as Json[];
  assert.deepEqual([x.channel_id, x.provider, x.status, x.approval, x.route.machine_name, x.route.mode, x.local_time],
    [h.seeded.x.account, 'x', 'scheduled', 'approved_by_channel_policy', 'Mac-B', 'auto', `${day} 09:00 ${ZONE}`]);
  assert.deepEqual([tiktok.channel_id, tiktok.provider, tiktok.status, tiktok.approval, tiktok.approval_deadline_local, tiktok.route.machine_name],
    [h.seeded.tiktok.account, 'tiktok', 'awaiting_approval', 'awaiting_owner', `${day} 09:30`, 'Win-C']);
  assert.deepEqual(tiktok.owner_action, { kind: 'click_post', machine: 'Win-C', from_local: `${day} 09:00`, until_local: `${day} 09:30`, remote_url: null });
  for (const post of [x, tiktok]) assert.ok(post.warnings.some((warning: Json) => warning.code === 'caption_empty'));
  // TikTok's login is 13 h old → one check_login through the job engine hook, in the same transaction.
  assert.deepEqual(h.checks, [h.seeded.tiktok.account]);
  assert.match(tiktok.login.check_task_id, /^[0-9a-f-]{36}$/);
  assert.equal(x.login.check_task_id, null);
  assert.match(scheduled.web_url, new RegExp(`/app/${h.wid}/calendar\\?view=week&week=\\d{4}-\\d{2}-\\d{2}&event=publish:${x.post_id}$`));

  // The records behind it: two publish_targets, the direct approval by channel policy and the pending request with its deadline.
  const state = await h.read(ctx => {
    const targets = ctx.list('publish_target') as (Row & Json)[];
    return {
      targets, requests: targets.map(target => ctx.get('approval_request', target.approval_request_id) as Row & Json),
      revisions: targets.map(target => ctx.get('content_revision', target.variant_revision_id) as Row & Json),
      asset: ctx.get('asset', media.media_id) as Row & Json,
      credential: ctx.list('agent_connection')[0],
    };
  });
  assert.equal(state.targets.length, 2);
  const scheduledAt = `${day}T01:00:00.000Z`;
  for (const [index, account] of [h.seeded.x.account, h.seeded.tiktok.account].entries()) {
    const target = state.targets.find(row => row.social_account_id === account)!;
    assert.equal(target.scheduled_at, scheduledAt);
    assert.equal(target.schedule_tz, ZONE);
    assert.equal(target.created_via, 'agent');
    const revision = state.revisions[state.targets.indexOf(target)]!;
    assert.equal(revision.rendered.text, '');
    assert.deepEqual(revision.media.map((item: Json) => item.asset_id), [media.media_id]);
    void index;
  }
  const xTarget = state.targets.find(row => row.social_account_id === h.seeded.x.account)!;
  const tiktokTarget = state.targets.find(row => row.social_account_id === h.seeded.tiktok.account)!;
  const xRequest = state.requests[state.targets.indexOf(xTarget)] as Row & Json;
  const tiktokRequest = state.requests[state.targets.indexOf(tiktokTarget)] as Row & Json;
  assert.deepEqual([xTarget.plan_status, xRequest.status, xRequest.approved_via], ['ready', 'approved', 'channel_policy']);
  assert.deepEqual([tiktokTarget.plan_status, tiktokRequest.status, tiktokRequest.approved_via, tiktokRequest.due_at],
    ['awaiting_approval', 'pending', null, new Date(Date.parse(scheduledAt) + 30 * 60_000).toISOString()]);
  assert.deepEqual([state.asset.ownership, state.asset.status], ['owned', 'ready']);

  // §7.4 B07: any successful tool call verifies the connection.
  const [listedConnection] = (await h.request(`${h.root}/agent-connections`, { headers: h.owner })).data;
  assert.ok(listedConnection.mcp_client_verified_at);

  // 4 (optional): post_get confirms it back to the owner.
  const detail = ok(await client.call('post_get', { post_id: tiktok.post_id }));
  assert.deepEqual([detail.post.status, detail.approval, detail.media[0].media_id, detail.media[0].status], ['awaiting_approval', 'awaiting_owner', media.media_id, 'ready']);
  assert.ok(client.toolCalls.length <= 6);
});

test('tools/list shows only the 11 hub tools; legacy tools stay callable and a hub tool wins a name clash', async t => {
  const h = await hub(t);
  const init = await h.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.instructions, hubInstructions);
  assert.ok(Buffer.byteLength(init.instructions, 'utf8') <= HUB_INSTRUCTIONS_MAX_BYTES);
  const tools = (await h.rpc('tools/list')).tools as Json[];
  assert.deepEqual(tools.map(tool => tool.name), HUB_TOOLS);
  for (const tool of tools) {
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.ok(Buffer.byteLength(JSON.stringify(tool.inputSchema)) < 4096, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.equal(tools.find(tool => tool.name === 'channel_check')!.annotations.idempotentHint, true);
  assert.equal(tools.find(tool => tool.name === 'posts_list')!.annotations.readOnlyHint, true);
  // Legacy tools are hidden but callable.
  assert.ok(Array.isArray(ok(await h.call('smartsell_operations_describe', {})).data));
  assert.ok(ok(await h.call('workspace_brands_list', {})).data.length >= 1);
  // posts_list is a legacy name too; the hub tool answers with its own shape.
  const posts = ok(await h.call('posts_list', {}));
  assert.deepEqual(Object.keys(posts).sort(), ['from', 'posts', 'timezone', 'to', 'total', 'truncated']);
  // Debug switch: list everything again.
  process.env.SMARTSELL_MCP_LIST_LEGACY = '1';
  try {
    const all = ((await h.rpc('tools/list')).tools as Json[]).map(tool => tool.name);
    assert.ok(all.length > 11 && all.includes('smartsell_operation_call') && all.includes('post_schedule'));
  } finally { delete process.env.SMARTSELL_MCP_LIST_LEGACY; }
});

test('strict validation answers INVALID_ARGUMENTS with issue paths; media_upload on the hub answers RELAY_REQUIRED without a URL', async t => {
  const h = await hub(t);
  const error = failure(await h.call('post_schedule', { media_ids: ['0b8e6c2a-1f7d-4c39-9a51-6f0c2d7e8a11'], channel_ids: [h.seeded.tiktok.account],
    when: '2026-12-01 09:00', captions: { tiktok: { text: 'hi', desc: 'no' } } }));
  assert.deepEqual(error, { code: 'INVALID_ARGUMENTS', message: "captions.tiktok has an unknown field 'desc'. Allowed: text, title, tags.",
    issues: [{ path: 'captions.tiktok.desc', code: 'unrecognized_keys', allowed: ['text', 'title', 'tags'], message: "captions.tiktok has an unknown field 'desc'. Allowed: text, title, tags." }] });
  assert.equal(failure(await h.call('channels_list', { platform: 'x' })).issues[0].path, 'platform');
  assert.equal(failure(await h.call('post_get', { post_id: 'POST-1' })).issues[0].path, 'post_id');
  const relay = failure(await h.call('media_upload', { path: '/Users/owner/video.mp4' }));
  assert.equal(relay.code, 'RELAY_REQUIRED');
  assert.match(relay.details.owner_message, /relay/);
  assert.match(relay.details.install.download, /\/agent\/relay\.mjs/);
  // E47: the path form cannot work without the relay, so the hub points at the direct form instead of a URL for a path.
  assert.match(relay.message, /\{filename, bytes, sha256\}/);
  assert.ok(!JSON.stringify(relay).includes('/uploads/direct/'), 'no upload link for a path the hub cannot read');
  // Business errors carry code, message, details and web_url.
  const missing = failure(await h.call('post_schedule', { media_ids: ['0b8e6c2a-1f7d-4c39-9a51-6f0c2d7e8a11'], channel_ids: [h.seeded.x.account], when: 'now' }));
  assert.deepEqual([missing.code, missing.details.media_ids], ['MEDIA_NOT_FOUND', ['0b8e6c2a-1f7d-4c39-9a51-6f0c2d7e8a11']]);
  assert.equal(failure(await h.call('post_update', { post_id: '0b8e6c2a-1f7d-4c39-9a51-6f0c2d7e8a11', action: 'cancel' })).code, 'POST_NOT_FOUND');
});

test('E47 direct form over plain MCP: {filename, bytes, sha256} returns a one-use curl PUT link; the uploaded media can be scheduled', async t => {
  const h = await hub(t);
  const bytes = fakeMp4(2 * 1024 * 1024 + 9);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const described = { filename: 'video.mp4', bytes: bytes.length, sha256: sha };
  // Mixing the forms, or a partial direct form, is refused with the missing or extra fields named.
  assert.deepEqual(failure(await h.call('media_upload', { path: '/tmp/video.mp4', sha256: sha })).issues.map((issue: Json) => issue.path), ['sha256']);
  assert.deepEqual(failure(await h.call('media_upload', { filename: 'video.mp4' })).issues.map((issue: Json) => issue.path), ['bytes', 'sha256']);
  const first = ok(await h.call('media_upload', described));
  assert.equal(first.status, 'receiving');
  assert.ok(first.upload.command.includes('-T "<path>"') && first.upload.command.endsWith(`"${first.upload.url}"`), first.upload.command);
  assert.ok(first.upload.url.startsWith(`${h.config.origin}/api/v1/agent/uploads/direct/`));
  assert.ok(!JSON.stringify(first).includes(h.connection.token), 'the agent token never reaches the model');
  // What the agent runs: one PUT of the whole file (the command's curl -T, done here with fetch).
  const put = await fetch(first.upload.url.replace(h.config.origin, h.base), { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
  assert.equal(put.status, 202, await put.text());
  let status = first;
  for (let attempt = 0; attempt < 200 && status.status !== 'ready'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    status = ok(await h.call('media_upload', described));
  }
  assert.deepEqual([status.status, status.media_id, status.upload], ['ready', first.media_id, null]);
  const scheduled = ok(await h.call('post_schedule', { media_ids: [first.media_id], channel_ids: [h.seeded.x.account], when: 'now', captions: { default: { text: 'direct upload' } } }));
  assert.equal(scheduled.posts.length, 1);
});

test('E47 through the relay: the path form uploads locally and the direct form is passed to the hub unchanged', async t => {
  const h = await hub(t);
  const client = relayClient(t, h.base, h.connection.token);
  await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const bytes = fakeMp4(1024 * 1024 + 5);
  const direct = await client.call('media_upload', { filename: 'clip.mp4', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.equal(direct.isError, undefined, JSON.stringify(direct));
  assert.ok(String(direct.structuredContent.upload.url).includes('/api/v1/agent/uploads/direct/'), 'answered by the hub, not the relay');
});

/** A ready owned video already in the hub (the "pre-uploaded owned asset" path of the done criterion). */
async function readyVideo(h: Awaited<ReturnType<typeof hub>>) {
  return h.write(ctx => {
    const sha = createHash('sha256').update(randomUUID()).digest('hex');
    const file = ctx.create('file_object', { purpose: 'asset', sha256: sha, scan_status: 'skipped', mime_type: 'video/mp4', size_bytes: 1024, original_filename: 'clip.mp4' });
    const asset = ctx.create('asset', { kind: 'video', brand_id: null, ownership: 'owned', origin: 'agent_upload', status: 'ready', title: 'clip.mp4' });
    const version = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id, sha256: sha, mime_type: 'video/mp4', version_no: 1 });
    ctx.update('asset', asset.id, { current_version_id: version.id });
    return asset.id;
  });
}

test('a whole post_schedule failure rolls back every write; request_id replays the stored result', async t => {
  const h = await hub(t);
  const media = await readyVideo(h);
  const args = { media_ids: [media], channel_ids: [h.seeded.x.account, h.seeded.tiktok.account], when: `${tomorrow()} 10:00` };
  // X is written first; the TikTok login check then fails, so the X post and the content item must roll back too.
  const restore = setWorkerEngineHooks({ createCheckLoginJob() { throw new Problem(409, 'CHECK_REFUSED', 'login check refused for the test'); } });
  const refused = failure(await h.call('post_schedule', args));
  restore();
  assert.equal(refused.code, 'CHECK_REFUSED');
  const counts = () => h.read(ctx => ['publish_target', 'content_item', 'content_variant', 'posting_request', 'approval_request'].map(kind => ctx.list(kind).length));
  assert.deepEqual(await counts(), [0, 0, 0, 0, 0]);
  const first = ok(await h.call('post_schedule', { ...args, request_id: 'retry-safe-0001' }));
  const again = ok(await h.call('post_schedule', { ...args, request_id: 'retry-safe-0001' }));
  assert.equal(again.replayed, true);
  assert.deepEqual(again.posts.map((post: Json) => post.post_id), first.posts.map((post: Json) => post.post_id));
  assert.deepEqual((await counts()).slice(0, 2), [2, 1]);
  assert.equal(failure(await h.call('post_schedule', { ...args, request_id: 'retry-safe-0001', plan_tag: 'changed' })).code, 'IDEMPOTENCY_MISMATCH');
  // post_update resubmits when the approval is not kept (direct → approved again by channel policy).
  const moved = ok(await h.call('post_update', { post_id: first.posts[0].post_id, action: 'reschedule', when: `${tomorrow()} 18:00` }));
  assert.deepEqual([moved.approval_retained, moved.post.status, moved.post.approval], [false, 'scheduled', 'approved_by_channel_policy']);
});

test('channel_check waits outside every transaction: other calls and the Worker report run meanwhile', async t => {
  const h = await hub(t);
  const started = Date.now();
  const pending = h.call('channel_check', { channel_id: h.seeded.x.account, wait_seconds: 8 });
  await new Promise(resolve => setTimeout(resolve, 400));
  // Another MCP call answers at once while the check waits.
  const quick = Date.now();
  ok(await h.call('machines_list', {}));
  assert.ok(Date.now() - quick < 1500, `machines_list took ${Date.now() - quick} ms while channel_check waited`);
  // The "Worker" reports the login in its own write transaction; the waiting tool sees it on its next poll.
  await h.write(ctx => {
    const job = ctx.list('worker_job').find(row => row.kind === 'check_login')!;
    ctx.update('worker_job', job.id, { status: 'succeeded', finished_at: ctx.now });
    const session = ctx.list('browser_session').find(row => row.social_account_id === h.seeded.x.account)!;
    ctx.update('browser_session', session.id, { status: 'verified', checked_at: ctx.now, verified_at: ctx.now });
  });
  const result = ok(await pending);
  assert.ok(Date.now() - started < 8000, 'returned as soon as the check finished');
  assert.deepEqual([result.status, result.login, result.channel_id, result.machine.name], ['done', 'verified', h.seeded.x.account, 'Mac-B']);
  assert.deepEqual(h.checks, [h.seeded.x.account]);
  // An open check is reused; wait_seconds 0 answers immediately.
  const again = ok(await h.call('channel_check', { channel_id: h.seeded.tiktok.account, wait_seconds: 0 }));
  const reused = ok(await h.call('channel_check', { channel_id: h.seeded.tiktok.account, wait_seconds: 0 }));
  assert.deepEqual([again.status, reused.task_id], ['pending', again.task_id]);
  const task = ok(await h.call('task_get', { task_id: again.task_id }));
  assert.deepEqual([task.kind, task.status, task.channel.channel_id, task.machine.name], ['check_login', 'queued', h.seeded.tiktok.account, 'Win-C']);
});

test('publishing_pause stops a channel through MCP and the agent upload and alert routes share the Agent credential', async t => {
  const h = await hub(t);
  const paused = ok(await h.call('publishing_pause', { scope: 'channel', id: h.seeded.x.account, reason: 'owner asked to stop' }));
  assert.deepEqual([paused.scope, paused.resume], ['channel', 'Only the owner can resume in the web app.']);
  const channels = ok(await h.call('channels_list', { provider: 'x' })).channels;
  assert.equal(channels[0].pause.scope, 'channel');
  // C4: upload config and the alert stream accept the connection token and refuse anything else.
  const bearer = { authorization: `Bearer ${h.connection.token}` };
  const config = await h.request('/api/v1/agent/uploads/config', { headers: bearer });
  assert.equal(config.chunk_bytes ?? config.data?.chunk_bytes, 1024 * 1024);
  await h.request('/api/v1/agent/uploads/config', { headers: { authorization: 'Bearer ss_command_nope' }, status: 401 });
  const denied = await fetch(`${h.base}/api/v1/agent/alerts/stream`, { headers: { accept: 'text/event-stream' } });
  assert.equal(denied.status, 401);
  await denied.text();
  // A cancelled stream no longer holds the hub's close (buildApp destroys never-used sockets on shutdown; hub/shutdown.test.ts).
  const controller = new AbortController();
  const stream = await fetch(`${h.base}/api/v1/agent/alerts/stream`, { headers: { ...bearer, accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  await stream.body?.cancel();
  controller.abort();
});
