import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from '../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { configuration } from '../../apps/server/src/config.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { commandBackgroundStore } from '../../apps/server/src/integration/command-background.ts';
import { prepareObservation } from '../../apps/server/src/modules/intel/intel-observations.ts';
import { PostgresStore } from '../../apps/server/src/postgres.ts';
import { kernelBackgroundStore } from '../../apps/server/src/runtime.ts';
import { postgresStore } from '../../packages/db/src/index.ts';

const password = 'fixture-research-acceptance-only';

async function verifyClaudeHost(t, base, token) {
  const cli = process.env.SMARTSELL_RESEARCH_CLAUDE;
  if (!cli) return;
  const cwd = await mkdtemp(join(tmpdir(), 'research-claude-'));
  try {
    const exec = args => promisify(execFile)(cli, args, { cwd, timeout: 12_000, env: {
      PATH: process.env.PATH, HOME: cwd, CLAUDE_CONFIG_DIR: cwd, ANTHROPIC_BASE_URL: base,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    } });
    await exec(['mcp', 'add', '--transport', 'http', 'smartsell-research', `${base}/mcp`, '--header', `Authorization: Bearer ${token}`]);
    const { stdout } = await exec(['mcp', 'list']);
    assert.match(stdout, /smartsell-research[^\n]*Connected/);
    t.diagnostic('Claude Code CLI connected to the local MCP endpoint');
  } finally {
    await rm(cwd, { recursive: true });
  }
}

for (const surface of ['commands', 'operations']) {
  const database = process.env[`SMARTSELL_RESEARCH_${surface.toUpperCase()}_PG_URL`];
  test(`Research digest lifecycle on ${surface} PostgreSQL`, { skip: !database && 'Run research-operation-postgres.sh', timeout: 60_000 }, async t => {
    const url = new URL(database);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, `/research_${surface}`);
    const standalone = surface === 'operations';
    const start = standalone ? (await import('../../apps/server/src/integration/kernel-runtime.ts')).startKernel
      : (await import('../../apps/server/src/bootstrap.ts')).start;
    const backgroundDatabaseUrl = process.env.SMARTSELL_RESEARCH_BACKGROUND_PG_URL;
    const config = configuration({ DATABASE_URL: database, HOST: '127.0.0.1', ROLE: 'api,mcp',
      SETUP_TOKEN: randomBytes(32).toString('hex'), IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
    let app, base;
    async function launch(worker = false) {
      await app?.close();
      app = undefined;
      app = await start({ ...config, port: 0, ...(worker && { roles: new Set([...config.roles, 'worker']), backgroundDatabaseUrl }) });
      base = `http://127.0.0.1:${app.server.address().port}`;
    }
    t.after(async () => { await app?.close(); });
    await launch();
    async function request(path, { method = 'GET', body, headers, status = 200 } = {}) {
      const response = await fetch(base + path, { method, signal: AbortSignal.timeout(10_000),
        headers: { connection: 'close', origin: config.origin, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await response.text();
      assert.equal(response.status, status, `${method} ${path}: ${raw}`);
      const value = raw && JSON.parse(raw);
      return { data: value?.data ?? value, headers: response.headers };
    }
    const setup = await request('/api/v1/setup', { method: 'POST', status: 201, headers: { 'x-setup-token': config.setupToken },
      body: { email: 'research-owner@example.invalid', name: 'Research owner', workspaceName: 'Research acceptance', password } });
    const workspace = setup.data.workspaces[0].id;
    const root = `/api/v1/workspaces/${workspace}`;
    async function session(response) {
      const cookie = response.headers.get('set-cookie').split(';')[0];
      const { data } = await request('/api/v1/session/csrf', { headers: { cookie } });
      return { cookie, 'x-csrf-token': data.csrf_token };
    }
    const owner = await session(setup);
    const rest = (path, options = {}) => request(root + path, { ...options, headers: { ...owner, ...options.headers } });
    const get = async (path, options) => (await rest(path, options)).data;
    const post = (path, body, status, headers) => get(path, { method: 'POST', body, status, headers });
    const patch = (path, body, version) => get(path, { method: 'PATCH', body, headers: { 'if-match': String(version) } });
    const pat = (access, tools) => post('/tokens', { access, tools }, 201);
    const reader = await pat('read', ['jobs_get']);
    const writer = await pat('write', ['jobs_get', 'jobs_cancel']);
    const connect = async token => {
      const client = new Client({ name: 'research-acceptance', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, connection: 'close' } } }));
      t.after(() => client.close());
      return client;
    };
    const call = (client, name, operation_id, expected_version) => client.callTool({ name, arguments: { workspace_id: workspace, operation_id, expected_version } });
    const toolData = result => {
      assert.equal(result.isError ?? false, false, JSON.stringify(result));
      return result.structuredContent.data;
    };
    const toolError = result => {
      assert.equal(result.isError, true, JSON.stringify(result));
      return result.structuredContent?.error?.code ?? result.structuredContent?.data?.code;
    };

    const email = 'research-editor@example.invalid';
    const identityStore = standalone ? await postgresStore(database) : undefined;
    const fixtures = standalone ? identityStore : new PostgresStore(backgroundDatabaseUrl);
    t.after(async () => { await fixtures.close(); });
    let editorId;
    const editorMembership = role => identityStore.transaction({ identityWrite: true }, ({ identity }) => {
      if (!editorId) {
        const storedOwner = identity.get(`user/${setup.data.user.id}`);
        editorId = randomUUID();
        identity.put(`user/${editorId}`, { ...storedOwner, id: editorId, email, name: 'Research editor' });
        identity.put(`email/${email}`, editorId);
      }
      identity.put(`member/${editorId}/${workspace}`, { userId: editorId, workspaceId: workspace, role });
    });
    if (standalone) await editorMembership('editor');
    else {
      const invite = await post('/members/invite', { email, role: 'editor' });
      await request('/api/v1/member-invitations/accept', { method: 'POST', status: 204,
        body: { email, name: 'Research editor', password, token: invite.invitation_token } });
    }
    const login = await request('/api/v1/session', { method: 'POST', body: { email, password } });
    const editor = await session(login);
    editorId ??= login.data.user.id;

    const board = await post('/research-boards', { title: 'Synthetic research' });
    const staleBoard = await post('/research-boards', { title: 'Changing board' });
    const target = await post('/watch-targets', { target_type: 'keyword', name: 'Synthetic search', platform: 'youtube', query: { keywords: ['local'] } });
    const observation = await post('/observations', { watch_target_id: target.id, subject_type: 'post', url: 'https://example.invalid/local-observed',
      published_at: '2026-01-02T00:00:00Z', observed_at: '2026-01-03T00:00:00Z', metrics: { likes: { availability: 'observed', value: 42 } } });
    const source = await post('/data-sources', { kind: 'vendor', provider: 'vendor:local', name: 'Synthetic contract', contract_ref: 'local-only',
      resources: ['product_metrics'], allowed_uses: { display: true, team_share: true, export: true, cache_days: 30 } });
    const vendorTarget = await post('/watch-targets', { target_type: 'keyword', name: 'Synthetic estimates', query: { keywords: ['local'] },
      data_mode: 'vendor', data_source_id: source.id });
    const store = standalone ? kernelBackgroundStore(fixtures) : commandBackgroundStore(fixtures);
    const ws = (await store.workspaces()).find(row => row.id === workspace);
    const estimate = await store.transact(ws, false, (records, scope) => {
      const ctx = makeContext(records, scope, 'owner');
      ctx.update('data_source', source.id, { field_coverage: { product_metrics: { fields: ['sales'] } } });
      return prepareObservation(ctx, { watch_target_id: vendorTarget.id, subject_type: 'product', url: 'https://example.invalid/local-estimate',
        data_source_id: source.id, observed_at: '2026-01-03T00:00:00Z', metrics: { sales: { availability: 'estimated', value: 20 } } }, 'vendor')();
    });
    const observedItem = await post(`/research-boards/${board.id}/items`, { item_type: 'observation', ref_id: observation.id });
    const estimateItem = await post(`/research-boards/${board.id}/items`, { item_type: 'observation', ref_id: estimate.id });
    const note = await post(`/research-boards/${board.id}/notes`, { title: 'Review demand', body: 'Try a small batch', evidence_refs: [observedItem.id, estimateItem.id] });
    const period = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
    if (!standalone) {
      const command = (action, fields) => post(`/commands/intel/${action}`, fields, 200, { 'idempotency-key': randomUUID() });
      const legacyBoard = await command('create_research_board', { title: 'Legacy research', kind: 'research' });
      const fact = await command('add_research_item', { board_id: legacyBoard.id, item_type: 'link', url: observation.url, stance: 'evidence' });
      const legacy = await command('generate_research_digest', { title: 'Legacy digest', period, fact_item_ids: [fact.id], recommendation_item_ids: [] });
      assert.equal(legacy.data.status, 'ready');
      assert.deepEqual(legacy.data.evidence_refs, [{ kind: 'research_item', id: fact.id }]);
      assert.equal(legacy.data.sections.facts[0].item_id, fact.id);
      assert.deepEqual(legacy.data.sections.recommendations, []);
    }
    const body = { board_id: board.id, period };
    const key = randomUUID();
    const submit = ({ version = board.version, id = key, status = 202, fields = body, auth } = {}) => post('/research-digests', fields, status,
      { ...auth, 'idempotency-key': id, ...(version !== null && { 'if-match': `"${version}"` }) });
    const readJob = id => get(`/operations/${id}`);
    const listDigests = () => store.transact(ws, true, (records, scope) => makeContext(records, scope, 'owner').list('research_digest'));
    const setExport = async allowed => {
      const current = await get(`/data-sources/${source.id}`);
      await patch(`/data-sources/${source.id}`, { allowed_uses: { export: allowed } }, current.version);
    };

    assert.equal((await submit({ status: 428, version: null })).code, 'VERSION_REQUIRED');
    assert.equal((await submit({ status: 409, version: board.version + 1 })).code, 'VERSION_CONFLICT');
    await setExport(false);
    assert.equal((await submit({ status: 403 })).code, 'EGRESS_BLOCKED');
    await setExport(true);
    const [accepted, replay] = await Promise.all([submit(), submit()]);
    const { operation_id: id } = accepted;
    assert.deepEqual(Object.keys(accepted), ['operation_id']);
    assert.deepEqual(replay, accepted);
    assert.equal((await submit({ status: 422, fields: { ...body, board_id: staleBoard.id } })).code, 'IDEMPOTENCY_MISMATCH');
    const { operation_id: cancelled } = await submit({ id: randomUUID() });
    const { operation_id: revoked } = await submit({ id: randomUUID(), auth: editor });
    const { operation_id: stale } = await submit({ id: randomUUID(), version: staleBoard.version, fields: { ...body, board_id: staleBoard.id } });
    assert.deepEqual(await listDigests(), []);

    await launch();
    assert.deepEqual(await submit(), accepted);
    await verifyClaudeHost(t, base, writer.token);
    const mcpReader = await connect(reader.token);
    const mcpWriter = await connect(writer.token);
    assert.equal(toolData(await call(mcpReader, 'jobs_get', id)).status, 'queued');
    const queued = await rest(`/operations/${cancelled}`);
    assert.equal(queued.headers.get('etag'), `"${queued.data.version}"`);
    const cancelPath = `/operations/${cancelled}/cancel`;
    assert.equal((await post(cancelPath, {}, 428)).code, 'VERSION_REQUIRED');
    assert.equal((await post(cancelPath, {}, 409, { 'if-match': String(queued.data.version + 1) })).code, 'VERSION_CONFLICT');
    assert.equal(toolError(await call(mcpReader, 'jobs_cancel', cancelled, queued.data.version)), 'TOOL_UNAVAILABLE');
    assert.equal(toolData(await call(mcpWriter, 'jobs_cancel', cancelled, queued.data.version)).status, 'cancelled');
    await mcpReader.close();
    await mcpWriter.close();

    if (standalone) await editorMembership('viewer');
    else await rest(`/members/${editorId}/roles`, { method: 'PATCH', body: { role: 'viewer' } });
    assert.equal((await submit({ status: 403, auth: editor })).code.toUpperCase(), 'PERMISSION_DENIED');
    await patch(`/research-boards/${staleBoard.id}`, { title: 'Changed before worker' }, staleBoard.version);
    await launch(true);
    const wait = async id => {
      for (let i = 0; i < 80; i++) {
        const result = await readJob(id);
        if (result.status !== 'queued' && result.status !== 'running') return result;
        await delay(150);
      }
      assert.fail(`Operation did not finish: ${id}`);
    };
    const result = await wait(id);
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    const digestId = result.result_ref.research_digest_id;
    const digestPath = `/research-digests/${digestId}`;
    const digest = await get(digestPath);
    assert.deepEqual(digest.period, period);
    assert.deepEqual(digest.sections.facts.map(row => [row.item_id, row.observation_id, row.url, row.metrics.likes.value]),
      [[observedItem.id, observation.id, observation.url, 42]]);
    assert.deepEqual(digest.sections.estimates.map(row => [row.item_id, row.observation_id, row.source.estimate, row.metrics.sales.value]),
      [[estimateItem.id, estimate.id, true, 20]]);
    assert.deepEqual(digest.sections.recommendations.map(row => [row.item_id, row.body]), [[note.id, 'Try a small batch']]);
    assert.equal(Object.hasOwn(digest, 'evidence'), false);
    assert.equal((await get(digestPath, { status: 403, headers: editor })).code.toUpperCase(), 'PERMISSION_DENIED');
    assert.equal((await readJob(cancelled)).status, 'cancelled');
    assert.equal((await readJob(cancelled)).result_ref, undefined);
    assert.equal((await wait(revoked)).error_code, 'FORBIDDEN');
    assert.equal((await wait(stale)).error_code, 'VERSION_CONFLICT');
    assert.deepEqual((await listDigests()).map(row => row.id), [digestId]);

    await launch();
    const { operation_id: policyBlocked } = await submit({ id: randomUUID() });
    await setExport(false);
    assert.equal((await get(digestPath, { status: 403 })).code, 'EGRESS_BLOCKED');
    await launch(true);
    assert.equal((await wait(policyBlocked)).error_code, 'EGRESS_BLOCKED');
    assert.deepEqual((await listDigests()).map(row => row.id), [digestId]);
    await setExport(true);
    await launch();
    const reconnected = await connect(reader.token);
    assert.deepEqual(toolData(await call(reconnected, 'jobs_get', id)).result_ref, result.result_ref);
    assert.equal((await readJob(id)).operation_id, id);
    assert.deepEqual(await get(digestPath), digest);
    assert.deepEqual(await submit(), accepted);
    await reconnected.close();
    t.diagnostic(JSON.stringify({ operation_id: id, research_digest_id: digestId, observed_item_id: observedItem.id, observation_id: observation.id,
      estimate_item_id: estimateItem.id, estimated_observation_id: estimate.id, recommendation_item_id: note.id,
      observed_likes: 42, estimated_sales: 20, cancelled, revoked, stale, policyBlocked, digest_count: 1 }));
  });
}
