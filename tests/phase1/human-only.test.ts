// Contract test (phase1-design §4.6, §10.2 "契約測試", S8): every hub_* operation in HUMAN_ONLY
//   (1) is registered under exactly that name by discoverOperations() (never behind the account module's prefix), and
//   (2) refuses an Agent credential with 403 HUMAN_REQUIRED — in the shared operation runner itself and over MCP from a
//       real hub-mode server with a real agent connection token — while the owner's session is not refused for it.
// E21/E32 adds one human-only field to an Agent-callable operation: hub_channels_check {open_login_window} (「重新登入」).
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { start } from '../../apps/server/src/bootstrap.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { AGENT_HUMAN_FIELDS, agentCallable, discoverOperations, HUMAN_ONLY, humanOnly, metadata, runScopedOperation } from '../../apps/server/src/operations.ts';
import { Records } from '../../packages/db/src/index.ts';
import { readHubRecords } from '../e2e-phase1/hub-records.ts';

const HUB_HUMAN_ONLY = [...HUMAN_ONLY].filter(name => name.startsWith('hub_')).sort();
/** §4.6 table, verbatim, plus E41's hub_machines_retire (「撤銷這台機器」): the hub operations that only a person may run. */
const DESIGN_HUMAN_ONLY = ['hub_alerts_test', 'hub_alerts_update_channels', 'hub_channels_ack_automation_notice', 'hub_channels_ack_risk',
  'hub_channels_bind_machine', 'hub_channels_clear_risk_ack', 'hub_channels_dry_run', 'hub_channels_update_settings', 'hub_jobs_force_release',
  'hub_jobs_resume', 'hub_machines_resume', 'hub_machines_retire', 'hub_machines_update', 'hub_posts_confirm_result', 'hub_posts_mark_not_published',
  'hub_posts_retry'];
/** §4.6 "Agent 可呼叫". */
const AGENT_CALLABLE = ['hub_posts_schedule', 'hub_posts_update', 'hub_channels_check', 'hub_publishing_pause', 'hub_machines_pause'];

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
  });
}

test('§4.6: HUMAN_ONLY names exactly the hub operations of the design table, each registered under its full hub_* name', async () => {
  assert.deepEqual(HUB_HUMAN_ONLY, [...DESIGN_HUMAN_ONLY].sort());
  const { operations } = await discoverOperations();
  const byName = new Map(operations.map(op => [op.name, op]));
  for (const name of HUB_HUMAN_ONLY) {
    const op = byName.get(name);
    assert.ok(op, `${name} is registered (not as account_${name})`);
    assert.equal(byName.has(`account_${name}`), false, `${name} is not prefixed`);
    assert.equal(humanOnly(op), true);
    assert.equal(agentCallable(op), false);
    assert.equal(metadata(op).human_only, true);
  }
  for (const name of AGENT_CALLABLE) {
    const op = byName.get(name);
    assert.ok(op, `${name} is registered`);
    assert.equal(agentCallable(op), true, `${name} stays callable by an Agent (it only stops or schedules)`);
  }
});

test('the shared operation runner refuses every hub_* HUMAN_ONLY operation for an Agent grant before running it', async () => {
  const { operations } = await discoverOperations();
  const config = configuration({ NODE_ENV: 'test' });
  for (const name of HUB_HUMAN_ONLY) {
    const op = operations.find(item => item.name === name)!;
    let ran = false;
    const guarded = { ...op, run: () => { ran = true; return {}; } };
    const scope = { workspaceId: randomUUID(), tenantId: randomUUID(), actorId: randomUUID() };
    await assert.rejects(
      runScopedOperation(new Records(new Map(), false), scope as never, { actorId: scope.actorId, grantId: 'agent-connection-1' }, 'owner', 'req-1',
        guarded as never, { params: { id: randomUUID() }, query: {}, body: {} } as never, 'mcp', config),
      (error: { status?: number; code?: string }) => error.status === 403 && error.code === 'HUMAN_REQUIRED',
      `${name}: 403 HUMAN_REQUIRED`);
    assert.equal(ran, false, `${name} never ran`);
  }
});

test('E21/E32: the shared runner refuses hub_channels_check {open_login_window} for an Agent grant before running it, whatever the value', async () => {
  assert.deepEqual(AGENT_HUMAN_FIELDS.hub_channels_check, ['open_login_window']);
  const { operations } = await discoverOperations();
  const config = configuration({ NODE_ENV: 'test' });
  const op = operations.find(item => item.name === 'hub_channels_check')!;
  assert.equal(agentCallable(op), true, 'a plain login check stays Agent-callable');
  async function call(body: Record<string, unknown>, grantId?: string) {
    let ran = false;
    const records = new Records(new Map(), false);
    const guarded = { ...op, run: () => { ran = true; return {}; } };
    const scope = { workspaceId: randomUUID(), tenantId: randomUUID(), actorId: randomUUID() };
    const principal = grantId ? { actorId: scope.actorId, grantId } : { actorId: scope.actorId };
    try {
      await runScopedOperation(records, scope as never, principal as never, 'owner', 'req-1', guarded as never,
        { params: { id: randomUUID() }, query: {}, body } as never, grantId ? 'mcp' : 'rest', config);
      return { ran, records, error: undefined };
    } catch (error) {
      return { ran, records, error: error as { status?: number; code?: string } };
    }
  }
  // Any value is refused (the field itself is the person's decision), for any channel id, before the operation runs.
  for (const value of [true, false, 'yes', null]) {
    const refused = await call({ open_login_window: value }, 'agent-connection-1');
    assert.deepEqual([refused.error?.status, refused.error?.code], [403, 'HUMAN_REQUIRED'], `open_login_window: ${String(value)}`);
    assert.equal(refused.ran, false, `open_login_window: ${String(value)} never ran`);
    assert.equal(refused.records.changes.size, 0, `open_login_window: ${String(value)} wrote nothing`);
  }
  // The gate is the field, not the operation: the Agent's plain check runs, and so does the owner's 「重新登入」.
  const plain = await call({}, 'agent-connection-1');
  assert.equal(plain.error, undefined, String(plain.error?.code));
  assert.equal(plain.ran, true);
  const person = await call({ open_login_window: true });
  assert.equal(person.error, undefined, String(person.error?.code));
  assert.equal(person.ran, true);
});

describe('over MCP, against a hub-mode server with a real agent connection', { concurrency: false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-human-only-'));
  const saved = { ...process.env };
  let app: Awaited<ReturnType<typeof start>>;
  let origin = '';
  let workspaceId = '';
  let owner: Record<string, string> = {};
  let client: Client;
  const hubDir = join(dir, 'hub');

  before(async () => {
    mkdirSync(hubDir, { recursive: true, mode: 0o700 });
    const dist = join(dir, 'web');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>SmartSell</title>');
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    const setupToken = randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = { PATH: saved.PATH, HOME: dir, TMPDIR: saved.TMPDIR, NODE_ENV: 'test', SMARTSELL_MODE: 'hub', SMARTSELL_HUB_TEST_HTTP: '1',
      SMARTSELL_HUB_DIR: hubDir, PUBLIC_ORIGIN: origin, PORT: String(port), APP_SECRET: randomBytes(32).toString('hex'), SETUP_TOKEN: setupToken, SMARTSELL_WEB_DIST: dist };
    process.env = env;
    const config = configuration(env);
    assert.equal(config.production, true, 'hub mode runs with production semantics');
    app = await start(config);
    const setup = await fetch(`${origin}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-setup-token': setupToken },
      body: JSON.stringify({ username: 'owner', password: `human-only-${randomUUID()}`, workspaceName: 'Human only' }) });
    assert.equal(setup.status, 201, await setup.clone().text());
    const session = ((await setup.json()) as { data: { csrf_token?: string; workspaces: { id: string }[] } }).data;
    const cookie = String(setup.headers.get('set-cookie')).split(';')[0];
    const csrf = session.csrf_token ?? ((await (await fetch(`${origin}/api/v1/session/csrf`, { headers: { cookie, origin } })).json()) as { csrf_token: string }).csrf_token;
    owner = { cookie, 'x-csrf-token': csrf, origin };
    workspaceId = session.workspaces[0].id;
    const connection = await fetch(`${origin}/api/v1/workspaces/${workspaceId}/agent-connections`, { method: 'POST', headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ client: 'codex', label: 'human-only contract', expires_days: 1 }) });
    assert.equal(connection.status, 201, await connection.clone().text());
    const token = ((await connection.json()) as { data: { token: string } }).data.token;
    client = new Client({ name: 'smartsell-human-only', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, origin } } }));
  });
  after(async () => {
    await client?.close().catch(() => {});
    await app?.close();
    process.env = saved;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('tools/list does not offer any of them; smartsell_operation_call with each name answers HUMAN_REQUIRED', async () => {
    const listed = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of HUB_HUMAN_ONLY) assert.ok(!listed.includes(name), `${name} is not a listed tool`);
    const { operations } = await discoverOperations();
    for (const name of HUB_HUMAN_ONLY) {
      const op = operations.find(item => item.name === name)!;
      const params = Object.fromEntries([...op.path.matchAll(/:([A-Za-z_]+)/g)].map(match => [match[1], randomUUID()]));
      const result = await client.callTool({ name: 'smartsell_operation_call', arguments: { operation: name, params, body: {} } });
      assert.equal(result.isError, true, `${name} is refused`);
      const text = ((result.content as { text?: string }[])[0]?.text) ?? '';
      const parsed = JSON.parse(text) as { error?: { code?: string }; code?: string };
      assert.equal(parsed.error?.code ?? parsed.code, 'HUMAN_REQUIRED', `${name}: ${text}`);
    }
  });

  test('the owner, with a browser session, is not refused as a human for the same operations', async () => {
    const { operations } = await discoverOperations();
    for (const name of HUB_HUMAN_ONLY) {
      const op = operations.find(item => item.name === name)!;
      const path = op.path.replace(/:([A-Za-z_]+)/g, () => randomUUID());
      const response = await fetch(`${origin}/api/v1/workspaces/${workspaceId}${path}`, { method: op.method,
        headers: { ...owner, 'content-type': 'application/json' }, body: op.method === 'GET' ? undefined : JSON.stringify({}) });
      const body = await response.text();
      assert.ok(!body.includes('HUMAN_REQUIRED'), `${name} (${op.method} ${path}) as the owner: ${response.status} ${body.slice(0, 200)}`);
      assert.notEqual(response.status, 403, `${name} as the owner`);
    }
  });

  const operationCall = async (operation: string, params: Record<string, string>, body: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'smartsell_operation_call', arguments: { operation, params, body } });
    const text = ((result.content as { text?: string }[])[0]?.text) ?? '';
    const parsed = JSON.parse(text) as { error?: { code?: string }; code?: string };
    return { isError: result.isError === true, code: parsed.error?.code ?? parsed.code, text };
  };

  test('E21/E32: smartsell_operation_call hub_channels_check {open_login_window} answers HUMAN_REQUIRED for any channel id', async () => {
    for (const value of [true, false]) {
      // A random id: the runner refuses before the channel is resolved, so the Agent learns nothing about channels either.
      const refused = await operationCall('hub_channels_check', { id: randomUUID() }, { open_login_window: value });
      assert.equal(refused.isError, true, refused.text);
      assert.equal(refused.code, 'HUMAN_REQUIRED', `open_login_window: ${value}: ${refused.text}`);
    }
    // Without the field the same call reaches the handler, which answers for the unknown channel instead.
    const plain = await operationCall('hub_channels_check', { id: randomUUID() }, {});
    assert.equal(plain.isError, true, plain.text);
    assert.equal(plain.code, 'CHANNEL_NOT_FOUND', plain.text);
    // The owner's 「重新登入」 for the same unknown channel is not refused as a human decision.
    const response = await fetch(`${origin}/api/v1/workspaces/${workspaceId}/hub/channels/${randomUUID()}/check`, { method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' }, body: JSON.stringify({ open_login_window: true }) });
    const text = await response.text();
    assert.equal(response.status, 422, text);
    assert.match(text, /CHANNEL_NOT_FOUND/);
  });

  test('nothing was created by the refused calls: the stopped hub has no Worker job or job event', async () => {
    await client.close();
    await app.close();
    app = undefined as never;
    const records = readHubRecords(join(hubDir, 'smartsell.sqlite'));
    assert.deepEqual(records.list('worker_job'), []);
    assert.deepEqual(records.list('worker_job_event'), []);
    assert.equal(records.list('agent_connection').length, 1, 'the reader sees the hub records (the agent connection made in before())');
  });
});
