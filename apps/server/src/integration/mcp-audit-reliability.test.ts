import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { postgresStore, type Store as KernelStore, type Transaction } from '@smartsell/db';
import { buildApp } from '../app.js';
import { configuration } from '../config.js';
import { localStore } from '../local.js';
import { registerOperationRoutes } from '../operation-server.js';
import { discoverOperations } from '../operations.js';
import { discover } from '../registry.js';
import { createServer as createOperationsServer } from '../server.js';
import type { Unit } from '../store.js';

const protocol = '2025-11-25';
const accept = 'application/json, text/event-stream';
const brandWrite = 'workspace_brand_create';
const draftWrite = 'content_autosave_variant';
const readTool = 'workspace_brand_get';
const fixtureSecret = () => randomBytes(32).toString('hex');
const timeout = () => AbortSignal.timeout(10_000);

async function serveFixture() {
  const config = configuration();
  const interrupt = process.env.MCP_AUDIT_STOP_BEFORE_FINISH === '1';
  config.roles = new Set(['api', 'mcp']);
  const discovered = await discoverOperations();
  let requestId: string | undefined;
  const beforeFinish = async () => {
    process.send?.({ requestId, stage: 'before-audit-finish' });
    // The operation has committed. The test stops the process before the separate audit update.
    await new Promise<never>(() => {});
  };
  async function commandApp() {
    const store = localStore(config.statePath);
    const workspace = store.workspace.bind(store);
    if (interrupt) {
      store.workspace = <T>(hash: string | undefined, wid: string, run: (unit: Unit) => Promise<T>, credential?: string) =>
        workspace(hash, wid, unit => run({ ...unit, async command(info, execute) {
          if (info.module === 'agent' && info.action === 'mcp_audit_finish') await beforeFinish();
          return unit.command(info, execute);
        } }), credential);
    }
    const modules = await discover();
    return buildApp({ ...config, ...modules, store,
      operationApi: { config, operations: discovered.operations, register: registerOperationRoutes } }).app;
  }
  async function operationApp(database: string) {
    const store = await postgresStore(database);
    const transaction = store.transaction.bind(store);
    if (interrupt) {
      store.transaction = <T>(options: Parameters<KernelStore['transaction']>[0], run: (tx: Transaction) => Promise<T> | T) =>
        transaction(options, async tx => {
          let changes: Map<string, string | null> | undefined;
          const result = await run({ ...tx, async workspace(scope) {
            const records = await tx.workspace(scope);
            changes = records.changes;
            return records;
          } });
          for (const [key, value] of changes ?? []) {
            if (!value || !key.startsWith('mcp-tool-call/')) continue;
            const { data } = JSON.parse(value);
            if (data.tool === draftWrite && data.outcome === 'success') await beforeFinish();
          }
          return result;
        });
    }
    return createOperationsServer({ ...discovered, config, store });
  }
  const app = await (config.databaseUrl ? operationApp(config.databaseUrl) : commandApp());
  if (interrupt) app.addHook('preHandler', async request => {
    if (request.url === '/mcp' && (request.body as { method?: string } | null)?.method === 'tools/call') requestId = request.id;
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  process.once('message', async () => {
    app.server.closeAllConnections();
    await app.close();
    process.disconnect?.();
  });
  process.send?.({ origin });
}

async function fixture(t: TestContext, database?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-mcp-reliability-'));
  const setupToken = fixtureSecret();
  const password = fixtureSecret();
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'test', HOST: '127.0.0.1', ROLE: 'all', SETUP_TOKEN: setupToken,
    APP_SECRET: fixtureSecret(), SMARTSELL_DATA_FILE: join(dir, 'state.sqlite'), MEDIA_DIRECTORY: join(dir, 'media'),
    MCP_AUDIT_FIXTURE: '1', ...(database && { DATABASE_URL: database }),
    // Agent connections are hub_v1 (phase1-design §7.4): the legacy Operation tools this fixture drives stay callable but are
    // listed only with the debugging switch.
    SMARTSELL_MCP_LIST_LEGACY: '1',
  };
  let child: ChildProcess | undefined;
  let origin = '';
  let session: Record<string, string> = {};
  const stop = async (crash: boolean) => {
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) { child = undefined; return; }
    const exit = once(child, 'exit', { signal: timeout() });
    if (crash) child.kill('SIGKILL'); else child.send({ close: true });
    const [code, signal] = await exit;
    child = undefined;
    assert.deepEqual([code, signal], crash ? [null, 'SIGKILL'] : [0, null]);
  };
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });
  async function boot(interrupt = false) {
    assert(!child);
    child = fork(fileURLToPath(import.meta.url), [], { env: { ...env, ...(interrupt && { MCP_AUDIT_STOP_BEFORE_FINISH: '1' }) },
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const [ready] = await once(child, 'message', { signal: timeout() });
    assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    origin = ready.origin;
  }
  async function http(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, expected = 200) {
    const response = await fetch(origin + path, { method, headers: { ...session, ...headers,
      ...(body !== undefined && { 'content-type': 'application/json', 'idempotency-key': randomUUID() }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: timeout() });
    assert.equal(response.status, expected, `${method} ${path}`);
    const value = await response.json();
    return { data: value.data ?? value, headers: response.headers };
  }
  await boot();
  const setup = await http('/api/v1/setup', 'POST', { email: 'mcp-reliability@example.invalid', password,
    name: 'Fixture Owner', workspaceName: 'MCP reliability' }, { 'x-setup-token': setupToken }, 201);
  const { workspaces: [workspace], user } = setup.data;
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  const { data: { csrf_token: csrf } } = await http('/api/v1/session/csrf', 'GET', undefined, { cookie });
  session = { cookie, 'x-csrf-token': csrf };
  const root = `/api/v1/workspaces/${workspace.id}`;
  const rest = async (path: string, method = 'GET', body?: unknown, status = 200) => (await http(root + path, method, body, {}, status)).data;
  const grant = database ? await rest('/tokens', 'POST', { access: 'write' }, 201)
    : await rest('/agent-connections', 'POST', { label: 'MCP test', client: 'codex', expires_days: 1 }, 201);
  const canary = fixtureSecret();
  const audit = async (query = '') => {
    const data = (await http(`${root}/mcp-tool-calls${query ? `?${query}` : ''}`)).data;
    assert(Array.isArray(data));
    const json = JSON.stringify(data);
    for (const secret of [setupToken, password, grant.token, cookie, csrf, canary]) assert(!json.includes(secret), 'Audit returned private fixture content');
    return data;
  };
  const activity = () => rest('/views/activity?actor=agent');
  const scope = database ? { workspace_id: workspace.id } : {};
  const writeTool = database ? draftWrite : brandWrite;
  async function prepareWrite(slug: string) {
    const idempotency_key = randomUUID();
    if (!database) {
      const args = { body: { name: canary, slug }, idempotency_key };
      return { args, changed: { ...args, body: { ...args.body, slug: 'changed-payload' } },
        brandId: (resource: { id: string }) => resource.id,
        async check() {
          const brands = await rest('/brands');
          assert.equal(brands.length, 1);
          assert.equal(brands[0].version, 1);
          assert(brands[0].name === canary, 'Saved brand does not match the fixture');
          return { id: brands[0].id, version: brands[0].version };
        } };
    }
    const brand = await rest('/brands', 'POST', { name: 'Fixture brand', slug });
    const made = await rest('/content-items', 'POST', { brand_id: brand.id, title: 'Fixture draft' });
    const item = made.item ?? made;
    const added = await rest(`/content-items/${item.id}/variants`, 'POST', { platform: 'facebook', market: 'US', format: 'text', body_markdown: 'Initial fixture.' });
    const variant = added.variant ?? added;
    const args = { ...scope, params: { id: variant.id }, body: { body_markdown: canary, expected_version: variant.version },
      expected_version: variant.version, idempotency_key };
    return { args, changed: { ...args, body: { ...args.body, body_markdown: 'Changed retry' } }, brandId: () => brand.id,
      async check() {
        const current = await rest(`/content-variants/${variant.id}`);
        const row = current.variant ?? current;
        assert.equal(row.version, variant.version + 1);
        assert(row.draft_doc.body === canary, 'Saved draft does not match the fixture');
        return { id: row.id, version: row.version };
      } };
  }
  return { get origin() { return origin; }, boot, stop, audit, activity, prepareWrite, writeTool, scope, grant: grant.id, actor: user.id,
    beforeFinish: () => once(child!, 'message', { signal: timeout() }),
    connect: () => connect(origin, grant.token, writeTool),
    unauthorizedAudit: () => fetch(`${origin}${root}/mcp-tool-calls`, { signal: timeout() }) };
}

async function connect(origin: string, token: string, writeTool: string) {
  let id = 0;
  let session: string | null = null;
  async function post(method: string, params: unknown, endpoint = origin, notification = false) {
    return fetch(`${endpoint}/mcp`, { method: 'POST', headers: { accept, authorization: `Bearer ${token}`,
      'content-type': 'application/json', ...(method !== 'initialize' && { 'mcp-protocol-version': protocol }),
      ...(session && { 'mcp-session-id': session }) },
    body: JSON.stringify({ jsonrpc: '2.0', ...(!notification && { id: ++id }), method, params }), signal: timeout() });
  }
  const initial = await post('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'audit-reliability', version: '1' } });
  assert.equal(initial.status, 200);
  session = initial.headers.get('mcp-session-id');
  assert.equal((await initial.json()).result?.protocolVersion, protocol);
  assert.equal((await post('notifications/initialized', {}, origin, true)).status, 202);
  const list = await post('tools/list', {});
  assert.equal(list.status, 200);
  const tools: string[] = (await list.json()).result.tools.map((tool: { name: string }) => tool.name);
  assert(tools.includes(writeTool) && tools.includes(readTool), 'Expected fixture tools not discoverable');
  const send = (name: string, args: unknown, endpoint?: string) => post('tools/call', { name, arguments: args }, endpoint);
  return { send, async call(name: string, args: unknown) {
    const response = await send(name, args);
    assert.equal(response.status, 200);
    const requestId = response.headers.get('x-request-id');
    assert(requestId, 'Missing tool call request ID');
    const { result } = await response.json();
    assert(result, 'Missing tool result');
    return { requestId, result };
  } };
}

async function loseResponse(t: TestContext, origin: string) {
  const proxy = createServer(async (request, reply) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(`${origin}/mcp`, { method: 'POST', headers: {
        accept, authorization: request.headers.authorization!, 'content-type': 'application/json',
        'mcp-protocol-version': protocol, ...(request.headers['mcp-session-id'] && { 'mcp-session-id': String(request.headers['mcp-session-id']) }),
      }, body: Buffer.concat(chunks), signal: timeout() });
      await upstream.arrayBuffer();
      // Send the test harness only status and request ID. The client receives no headers or body.
      resolve({ status: upstream.status, requestId: upstream.headers.get('x-request-id') });
    } catch { resolve({ status: 0, requestId: null }); }
    reply.destroy();
  });
  let resolve!: (capture: { status: number; requestId: string | null }) => void;
  const receipt = new Promise<Parameters<typeof resolve>[0]>(done => { resolve = done; });
  const listening = once(proxy, 'listening');
  proxy.listen(0, '127.0.0.1');
  await listening;
  t.after(() => new Promise<void>(done => { proxy.close(() => done()); proxy.closeAllConnections(); }));
  const address = proxy.address();
  assert(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`, receipt };
}

if (process.env.MCP_AUDIT_FIXTURE === '1') {
  await serveFixture();
} else {
  function databaseFor(name: string) {
    const raw = process.env.MCP_AUDIT_TEST_POSTGRES_URL;
    if (!raw) return;
    const url = new URL(raw);
    assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.port !== '' &&
      url.username === 'app_rw' && url.password !== '' && url.pathname === '/mcp_audit_fixture' && !url.search && !url.hash,
    'Use a disposable loopback PostgreSQL fixture');
    url.pathname = `/mcp_audit_${name}`;
    return url.href;
  }

  for (const runtime of ['Commands SQLite', 'Operations PostgreSQL']) {
    const postgres = runtime === 'Operations PostgreSQL';
    const options = { skip: postgres && !process.env.MCP_AUDIT_TEST_POSTGRES_URL };
    test(`${runtime}: MCP audit counts a lost response and post-restart replay as distinct attempts with one committed write`, options, async t => {
      const f = await fixture(t, postgres ? databaseFor('transport') : undefined);
      const { writeTool } = f;
      const write = await f.prepareWrite('lost-response');
      const mcp = await f.connect();
      const { args } = write;
      const proxy = await loseResponse(t, f.origin);
      await assert.rejects(mcp.send(writeTool, args, proxy.origin), TypeError);
      const first = await proxy.receipt;
      assert.equal(first.status, 200);
      assert(first.requestId);
      const saved = await write.check();
      await f.stop(false);
      await f.boot();
      const client = await f.connect();
      const replay = await client.call(writeTool, args);
      assert.equal(replay.result.isError, undefined);
      assert.equal(replay.result.structuredContent.data.id, saved.id);
      const read = await client.call(readTool, { ...f.scope, params: { id: write.brandId(saved) } });
      assert.equal(read.result.structuredContent.data.id, write.brandId(saved));
      const missing = await client.call(readTool, { ...f.scope, params: { id: randomUUID() } });
      assert.equal(missing.result.isError, true);
      assert.equal((missing.result.structuredContent.error ?? missing.result.structuredContent.data).code, 'NOT_FOUND');
      const mismatch = await client.call(writeTool, write.changed);
      assert.equal(mismatch.result.isError, true);
      assert.equal((mismatch.result.structuredContent.error ?? mismatch.result.structuredContent.data).code, 'IDEMPOTENCY_MISMATCH');
      assert.deepEqual(await write.check(), saved);
      assert.equal((await f.unauthorizedAudit()).status, 401);
      const activity = await f.activity();
      assert.equal(activity.length, 1);
      assert.equal(activity[0].action, writeTool);
      assert.equal(activity[0].count, 1);
      assert.equal(activity[0].resource.id, saved.id);
      const attempts = [[first.requestId, writeTool, 'success', undefined, false], [replay.requestId, writeTool, 'success', undefined, true],
        [read.requestId, readTool, 'success', undefined, false], [missing.requestId, readTool, 'failed', 'NOT_FOUND', false],
        [mismatch.requestId, writeTool, 'failed', 'IDEMPOTENCY_MISMATCH', false]] as const;
      const calls = await f.audit(`actor_id=${f.actor}&credential_id=${f.grant}`);
      assert.equal(calls.length, attempts.length);
      assert.equal(new Set(calls.map(row => row.call_id)).size, attempts.length);
      for (const [requestId, tool, outcome, error, replayed] of attempts) {
        const matches = await f.audit(`request_id=${requestId}&tool=${tool}&outcome=${outcome}`);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].error_code, error);
        assert.equal(matches[0].replayed === true, replayed);
      }
    });

    test(`${runtime}: MCP audit exposes the proven business commit after a crash before audit finalization`, options, async t => {
      const f = await fixture(t, postgres ? databaseFor('crash') : undefined);
      const { writeTool } = f;
      const write = await f.prepareWrite('crash-after-commit');
      await f.stop(false);
      await f.boot(true);
      const mcp = await f.connect();
      const { args } = write;
      const beforeFinish = f.beforeFinish();
      const request = assert.rejects(mcp.send(writeTool, args), TypeError);
      const [signal] = await beforeFinish;
      assert.equal(signal.stage, 'before-audit-finish');
      assert.match(signal.requestId, /^[a-f0-9-]{36}$/);
      await f.stop(true);
      await request;
      await f.boot();
      const saved = await write.check();
      const attempts = await f.audit(`tool=${writeTool}`);
      assert.equal(attempts.length, 1);
      const [crashed] = attempts;
      assert.equal(crashed.request_id, signal.requestId);
      assert.equal(crashed.outcome, 'pending');
      assert.equal(crashed.business_committed, true, 'Committed business write is indistinguishable from an unfinished attempt');
      const replay = await (await f.connect()).call(writeTool, args);
      assert.equal(replay.result.structuredContent.data.id, saved.id);
      const [retry] = await f.audit(`request_id=${replay.requestId}`);
      assert.equal(retry.replayed, true);
      assert.notEqual(retry.call_id, crashed.call_id);
      assert.deepEqual(await f.audit(`request_id=${crashed.request_id}`), [crashed]);
      const effects = await f.activity();
      assert.equal(effects.length, 1);
      assert.equal(effects[0].count, 1);
      assert.equal(effects[0].resource.id, saved.id);
      assert.deepEqual(await write.check(), saved);
    });
  }
}
