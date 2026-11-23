import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { CallToolResultSchema, CreateTaskResultSchema, GetTaskResultSchema } from '../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
import { configuration } from '../../apps/server/src/config.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { commandBackgroundStore } from '../../apps/server/src/integration/command-background.ts';
import { recordSyncPage } from '../../apps/server/src/modules/ingest/sync-operations.ts';
import { createExecutionWorker } from '../../apps/server/src/modules/execution/worker.ts';
import { kernelBackgroundStore } from '../../apps/server/src/runtime.ts';
import { PostgresStore } from '../../apps/server/src/postgres.ts';

const protocol = '2025-11-25';
const password = 'fixture-ai05-acceptance-only';
const tools = ['jobs_get', 'jobs_cancel', 'agent_jobs_claim', 'agent_jobs_confirm_cancel'];

async function* frames(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  let buffer = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      yield frame;
    }
  }
}

const message = frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6));
const toolError = result => result.structuredContent?.error?.code ?? result.structuredContent?.data?.code;
const data = result => {
  assert.equal(result.isError ?? false, false, JSON.stringify(result));
  return result.structuredContent.data;
};

async function runClaudeHost(t, base, token) {
  const cli = process.env.SMARTSELL_AI05_CLAUDE;
  if (!cli) return;
  const directory = await mkdtemp(join(tmpdir(), 'ai05-claude-'));
  const observed = [];
  const proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(405).end(); return; }
      const rpc = JSON.parse(body);
      observed.push({ method: rpc.method, protocolVersion: rpc.params?.protocolVersion, tasks: !!rpc.params?.capabilities?.tasks });
      const upstream = await fetch(`${base}/mcp`, { method: 'POST', body,
        headers: { authorization: req.headers.authorization, accept: req.headers.accept, 'content-type': 'application/json',
          ...(req.headers['mcp-protocol-version'] && { 'mcp-protocol-version': req.headers['mcp-protocol-version'] }),
          ...(req.headers['mcp-session-id'] && { 'mcp-session-id': req.headers['mcp-session-id'] }) } });
      const headers = Object.fromEntries(upstream.headers);
      delete headers['transfer-encoding'];
      res.writeHead(upstream.status, headers).end(Buffer.from(await upstream.arrayBuffer()));
    } catch { res.writeHead(500).end(); }
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const cwd = directory;
  const env = { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: directory,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const exec = args => promisify(execFile)(cli, args, { cwd, env, timeout: 12_000 });
  try {
    await exec(['mcp', 'add', '--transport', 'http', 'smartsell-ai05',
      `http://127.0.0.1:${proxy.address().port}/mcp`, '--header', `Authorization: Bearer ${token}`]);
    const { stdout } = await exec(['mcp', 'list']);
    assert.match(stdout, /smartsell-ai05[^\n]*Connected/);
    const initialize = observed.find(item => item.method === 'initialize');
    assert.ok(initialize);
    t.diagnostic(`Claude Code MCP host connected with ${JSON.stringify(initialize)}`);
  } finally {
    await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
    await rm(directory, { recursive: true });
  }
}

async function exportServer(t, config, standalone, worker) {
  t.signal.throwIfAborted();
  const module = standalone ? './apps/server/src/integration/kernel-runtime.ts' : './apps/server/src/bootstrap.ts';
  const label = `Export server (${worker ? 'worker' : 'API'})`;
  const started = performance.now();
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import { once } from 'node:events';
    const [config] = await once(process, 'message');
    const service = await import(${JSON.stringify(module)});
    const app = await (service.startKernel ?? service.start)(config);
    if (process.connected) {
      process.once('disconnect', () => void app.close());
      process.send(app.server.address().port);
    } else await app.close();
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const errors = new Set();
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const { level, msg, err } = JSON.parse(line);
      if (level >= 50 && ['Outbox job failed', 'Background cycle failed'].includes(msg)) {
        errors.add(`${msg} (${err?.code ?? 'no error code'})`);
      }
    } catch { /* Ignore non-JSON output. */ }
  });
  // Explicit IPC disconnect can leave Node's child-process `close` event pending.
  const exited = once(child, 'exit');
  let closing;
  function close() {
    return closing ??= (async () => {
      const started = performance.now();
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000).unref();
      try {
        const [code, signal] = await exited;
        t.diagnostic(`${label} stopped in ${Math.round(performance.now() - started)}ms (${signal ?? code})`);
        for (const error of errors) t.diagnostic(error);
        assert.equal(code, 0, `${label} stopped with ${signal ?? code}\n${stderr}`);
      } finally { clearTimeout(timer); }
    })();
  }
  t.after(close);
  try {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(15_000)]);
    const ready = once(child, 'message', { signal });
    const sent = new Promise((resolve, reject) => {
      child.send({ ...config, port: 0, roles: new Set([...config.roles, ...(worker ? ['worker'] : [])]),
        backgroundDatabaseUrl: process.env.SMARTSELL_AI05_BACKGROUND_PG_URL }, error => error ? reject(error) : resolve());
    });
    const [[port]] = await Promise.race([Promise.all([ready, sent]), exited.then(([code, signal]) => {
      throw new Error(`${label} exited during startup (${signal ?? code})\n${stderr}`);
    })]);
    t.diagnostic(`${label} ready in ${Math.round(performance.now() - started)}ms`);
    return { base: `http://127.0.0.1:${port}`, pid: child.pid, close };
  } catch (error) {
    throw new Error(`${label} failed to start\n${stderr}`, { cause: error });
  }
}

for (const surface of ['commands', 'operations']) {
  const database = process.env[`SMARTSELL_AI05_${surface.toUpperCase()}_PG_URL`];
  // This is a ceiling for the full matrix, not a readiness or request deadline. Commands
  // can spend over a minute on the export phase alone on a busy host.
  test(`AI05 ${surface} PostgreSQL stable operations and MCP Tasks`, { skip: !database && 'Run ai05-postgres.sh', timeout: 180_000 }, async t => {
    const url = new URL(database);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, `/ai05_${surface}`);
    const standalone = surface === 'operations';
    const start = standalone ? (await import('../../apps/server/src/integration/kernel-runtime.ts')).startKernel
      : (await import('../../apps/server/src/bootstrap.ts')).start;
    const config = configuration({ DATABASE_URL: database, HOST: '127.0.0.1', ROLE: 'api,mcp',
      SETUP_TOKEN: randomBytes(32).toString('hex'), IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
    let app, base;
    const clients = new Set();
    async function launch(worker = false) {
      t.signal.throwIfAborted();
      const next = await start({ ...config, port: 0, ...(worker && { roles: new Set([...config.roles, 'worker']),
        backgroundDatabaseUrl: process.env.SMARTSELL_AI05_BACKGROUND_PG_URL }) });
      if (t.signal.aborted) {
        await next.close();
        t.signal.throwIfAborted();
      }
      app = next;
      base = `http://127.0.0.1:${app.server.address().port}`;
    }
    async function stop() {
      const current = app;
      app = undefined;
      try {
        await Promise.all([...clients].map(client => client.close()));
      } finally {
        clients.clear();
        await current?.close();
      }
    }
    t.after(stop);
    await launch();
    async function request(path, { method = 'GET', body, headers, status = 200 } = {}) {
      const response = await fetch(base + path, { method, signal: AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
        headers: { connection: 'close', origin: config.origin, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await response.text();
      assert.equal(response.status, status, `${method} ${path}: ${raw}`);
      return { value: raw ? JSON.parse(raw) : undefined, headers: response.headers };
    }
    const setup = await request('/api/v1/setup', { method: 'POST', status: 201, headers: { 'x-setup-token': config.setupToken },
      body: { email: 'ai05-owner@example.invalid', name: 'AI05 Owner', workspaceName: 'AI05 acceptance', password } });
    const workspace = (setup.value.data ?? setup.value).workspaces[0].id;
    const root = `/api/v1/workspaces/${workspace}`;
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const { value: session } = await request('/api/v1/session/csrf', { headers: { cookie } });
    const owner = { cookie, 'x-csrf-token': session.csrf_token ?? session.data.csrf_token };
    const rest = async (path, options = {}) => {
      const { value } = await request(root + path, { ...options, headers: { ...owner, ...options.headers } });
      return value?.data ?? value;
    };
    const post = (path, body, status, headers) => rest(path, { method: 'POST', body, status, headers });
    const pat = (access, tools) => post('/tokens', { access, tools }, 201);
    const writer = await pat('write', tools);
    const reader = await pat('read', ['jobs_get']);
    const unrelated = await pat('read', []);
    const createKey = randomUUID();
    const createDraft = () => post('/agent-jobs', { kind: 'draft', title: 'Review local notes', expected_output: { type: 'note' } }, 202,
      { 'idempotency-key': createKey });
    const draft = await createDraft();
    const id = draft.operation_id;
    assert.equal(draft.id, id);

    async function connect(token, advertise = true) {
      const client = new Client({ name: 'ai05-sdk-host', version: '1' }, { capabilities: advertise ? { tasks: {} } : {} });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}`, connection: 'close' } } });
      t.signal.throwIfAborted();
      clients.add(client);
      await client.connect(transport);
      return { client, transport };
    }
    const taskCall = ({ client }, operation_id, workspace_id = workspace) => client.request({ method: 'tools/call', params: {
      name: 'jobs_get', arguments: { workspace_id, operation_id }, task: {},
    } }, CreateTaskResultSchema);
    const getTask = ({ client }, taskId) => client.request({ method: 'tasks/get', params: { taskId } }, GetTaskResultSchema);
    const call = ({ client, transport }, name, args) => client.callTool({ name, arguments: standalone && (name.startsWith('agent_') || !transport.sessionId)
      ? { workspace_id: workspace, params: { id: args.operation_id ?? args.agent_job_id },
        ...(args.expected_version && { expected_version: args.expected_version }),
        ...(args.fencing_token && { body: { fencing_token: args.fencing_token } }) }
      : { workspace_id: workspace, ...args } });
    await t.test('Report generation survives restart with idempotency, cancellation, and version checks', async () => {
      const definition = { title: 'AI05 persisted report', period: { from: '2026-01-01', to: '2026-02-01', tz: 'UTC' },
        sections: [{ key: 'views', type: 'table', query: { metrics: ['norm.post.views'], subject: { type: 'platform_post' }, time: { basis: 'published_at' } } }] };
      const command = (action, body, status = 200, key = randomUUID()) => post(`/commands/analytics/${action}`, body, status, { 'idempotency-key': key });
      const report = await post('/reports', definition);
      const native = !standalone && await command('reports_create', { ...definition, kind: 'custom' });
      const observe = value => command('record_observations', { observations: [{ metric_key: 'norm.post.views', value,
        subject_type: 'platform_post', subject_id: 'ai05-post', platform: 'youtube', published_at: '2026-01-02T10:00:00Z',
        observed_at: value === 42 ? '2026-01-03T10:00:00Z' : '2026-01-03T11:00:00Z', availability: 'observed', source: { method: 'manual' } }] });
      if (native) await observe(42);
      const editorEmail = 'ai05-report-editor@example.invalid';
      if (standalone) {
        const { postgresStore } = await import('../../packages/db/src/index.ts');
        const store = await postgresStore(database);
        try {
          await store.transaction({ identityWrite: true }, ({ identity }) => {
            const owner = identity.get(`user/${setup.value.data.user.id}`);
            const id = randomUUID();
            identity.put(`user/${id}`, { ...owner, id, email: editorEmail, name: 'Report editor' });
            identity.put(`email/${editorEmail}`, id);
            identity.put(`member/${id}/${workspace}`, { userId: id, workspaceId: workspace, role: 'editor' });
          });
        } finally { await store.close(); }
      } else {
        const invitation = await post('/members/invite', { email: editorEmail, role: 'editor' });
        await request('/api/v1/member-invitations/accept', { method: 'POST', status: 204,
          body: { email: editorEmail, name: 'Report editor', password, token: invitation.invitation_token } });
      }
      const editorSession = await request('/api/v1/session', { method: 'POST',
        body: { email: editorEmail, password } });
      const editorCookie = editorSession.headers.get('set-cookie').split(';')[0];
      const editorCsrf = (await request('/api/v1/session/csrf', { headers: { cookie: editorCookie } })).value;
      const editor = { cookie: editorCookie, 'x-csrf-token': editorCsrf.csrf_token ?? editorCsrf.data.csrf_token };
      const key = randomUUID(), nativeKey = randomUUID();
      const submit = (idempotencyKey = key, body = {}, status = 202) => post(`/reports/${report.id}/versions`, body, status, { 'idempotency-key': idempotencyKey });
      const submitNative = (key = nativeKey) => command('reports_generate_version', { report_id: native.id }, 202, key);
      const { operation_id: reportJob } = await submit();
      const nativeJob = native && (await submitNative()).operation_id;
      const { operation_id: stopped } = await submit(randomUUID());
      const { operation_id: mcpStopped } = await submit(randomUUID());
      const nativeStopped = native && (await submitNative(randomUUID())).operation_id;
      assert.deepEqual(await rest(`/reports/${report.id}/versions`), []);
      await stop();
      await launch();
      assert.equal((await submit()).operation_id, reportJob);
      await submit(key, { data_cutoff_at: '2026-01-02T00:00:00Z' }, 422);
      if (native) assert.equal((await submitNative()).operation_id, nativeJob);
      const mcpReader = await connect(reader.token);
      const mcpWriter = await connect(writer.token);
      assert.equal(data(await call(mcpReader, 'jobs_get', { operation_id: reportJob })).status, 'queued');
      const queued = await rest(`/operations/${stopped}`);
      await post(`/operations/${stopped}/cancel`, {}, 409, { 'if-match': String(queued.version + 1) });
      assert.equal(toolError(await call(mcpReader, 'jobs_cancel', { operation_id: stopped, expected_version: queued.version })), 'TOOL_UNAVAILABLE');
      assert.equal((await post(`/operations/${stopped}/cancel`, {}, 200, { 'if-match': String(queued.version) })).status, 'cancelled');
      const cancellable = await rest(`/operations/${mcpStopped}`);
      assert.equal(data(await call(mcpWriter, 'jobs_cancel', { operation_id: mcpStopped, expected_version: cancellable.version })).status, 'cancelled');
      if (native) {
        const current = await rest(`/operations/${nativeStopped}`);
        assert.equal(data(await call(mcpWriter, 'jobs_cancel', { operation_id: nativeStopped, expected_version: current.version })).status, 'cancelled');
      }
      await stop();
      await launch(true);
      const wait = async operationId => {
        for (let i = 0; i < 60; i++) {
          const job = await rest(`/operations/${operationId}`);
          if (job.status !== 'queued') return job;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.fail(`Report job still queued: ${operationId}`);
      };
      const completed = await wait(reportJob);
      assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
      assert.equal(completed.operation_id, reportJob);
      const { version_id: versionId } = completed.result_ref;
      const draft = await rest(`/report-versions/${versionId}`);
      assert.equal(draft.status, 'draft');
      await post(`/report-versions/${versionId}/finalize`, {}, 403, { ...editor, 'if-match': String(draft.version) });
      await post(`/report-versions/${versionId}/finalize`, {}, 409, { 'if-match': String(draft.version + 1) });
      assert.equal((await post(`/report-versions/${versionId}/finalize`, {}, 200, { 'if-match': String(draft.version) })).status, 'finalized');
      const final = await rest(`/report-versions/${versionId}`);
      const versions = await rest(`/reports/${report.id}/versions`);
      assert.deepEqual(versions.map(version => version.id), [versionId]);
      assert.equal((await rest(`/operations/${stopped}`)).status, 'cancelled');
      assert.equal((await rest(`/operations/${mcpStopped}`)).status, 'cancelled');
      if (native) {
        const job = await wait(nativeJob);
        assert.equal(job.status, 'succeeded', JSON.stringify(job));
        const draft = await command('reports_get', { version_id: job.result_ref.version_id });
        assert.equal(draft.data.status, 'draft');
        assert.equal(draft.data.results.views.rows[0].values['norm.post.views'].value, 42);
        await post('/commands/analytics/reports_finalize', { version_id: draft.id, expected_version: draft.version }, 403,
          { ...editor, 'idempotency-key': randomUUID() });
        await command('reports_finalize', { version_id: draft.id, expected_version: draft.version + 1 }, 409);
        assert.equal((await command('reports_finalize', { version_id: draft.id, expected_version: draft.version })).data.status, 'finalized');
        assert.deepEqual((await command('reports_get', { report_id: native.id })).versions.map(version => version.id), [draft.id]);
        assert.equal((await rest(`/operations/${nativeStopped}`)).status, 'cancelled');
        await observe(99);
        assert.deepEqual((await command('reports_get', { version_id: draft.id })).data.results, draft.data.results);
      }
      await stop();
      await launch();
      const replay = await connect(reader.token);
      assert.deepEqual(data(await call(replay, 'jobs_get', { operation_id: reportJob })).result_ref, completed.result_ref);
      assert.deepEqual(await rest(`/report-versions/${versionId}`), final);
      assert.equal((await submit()).operation_id, reportJob);
      if (native) assert.equal((await submitNative()).operation_id, nativeJob);
      await replay.client.close();
    });
    await t.test('Report exports pin the version and keep bytes and policy across restarts', async exportTest => {
      const background = standalone
        ? await (await import('../../packages/db/src/index.ts')).postgresStore(database)
        : new PostgresStore(process.env.SMARTSELL_AI05_BACKGROUND_PG_URL);
      let child;
      try {
        const store = standalone ? kernelBackgroundStore(background) : commandBackgroundStore(background);
        const ws = (await store.workspaces()).find(row => row.id === workspace);
        const mutate = run => store.transact(ws, false, (records, scope) => run(makeContext(records, scope, 'owner')));
        const report = await post('/reports', { title: 'Export fixture', period: { from: '2026-01-01', to: '2026-02-01', tz: 'UTC' },
          sections: [{ key: 'notes', type: 'narrative' }] });
        const source = await post('/data-sources', { name: 'Export policy', kind: 'vendor', provider: 'vendor:fixture',
          contract_ref: 'fixture', resources: ['post_metrics'], allowed_uses: { display: true, export: true } });
        const workerSource = await post('/data-sources', { name: 'Worker export policy', kind: 'vendor', provider: 'vendor:fixture-policy',
          contract_ref: 'fixture', resources: ['post_metrics'], allowed_uses: { display: true, export: true } });
        const phrase = '=HYPERLINK("https://example.invalid") 中文 🌱 <測試>';
        const { v1, other } = await mutate(ctx => {
          const snapshot = (reportId, version_no, text, data_source_id = source.id) => ctx.create('report_version', { report_id: reportId, version_no, status: 'draft',
            data_cutoff_at: '2026-01-30T00:00:00Z', results: [], metric_lineage: { fixture: { data_source_id } },
            narrative: [{ section_key: 'notes', blocks: [{ kind: 'fact', text, refs: ['notes'] }] }] });
          return { v1: snapshot(report.id, 1, phrase), other: snapshot(report.id, 3, 'Policy fixture', workerSource.id) };
        });
        const finalize = row => post(`/report-versions/${row.id}/finalize`, {}, 200, { 'if-match': String(row.version) });
        const path = `/reports/${report.id}/versions/1/export`;
        await post(path, { format: 'csv' }, 409);
        await finalize(v1);
        const legacyCsv = (await post(`/report-versions/${v1.id}/export`, { format: 'csv' })).content;
        const legacyPdf = (await post(`/report-versions/${v1.id}/export`, { format: 'pdf' })).content;
        const key = randomUUID();
        const queue = (format, idempotencyKey = randomUUID(), status = 202, url = path) => post(url, { format }, status, { 'idempotency-key': idempotencyKey });
        const ids = Object.fromEntries(await Promise.all(['csv', 'pdf', 'xlsx'].map(async format => [format, (await queue(format, format === 'csv' ? key : undefined)).operation_id])));
        assert.equal((await queue('csv')).operation_id, ids.csv);
        await queue('pdf', key, 422);
        await queue('pptx', undefined, 400);
        await queue('csv', undefined, 404, `/reports/${randomUUID()}/versions/1/export`);
        await queue('csv', undefined, 404, `/reports/${report.id}/versions/999/export`);
        const queued = await rest(`/operations/${ids.csv}`);
        assert.equal(queued.status, 'queued');
        await rest(`/report-exports/${ids.csv}/download`, { status: 404 });

        const v2 = await mutate(ctx => ctx.create('report_version', { ...v1, version_no: 2, narrative: [
          { section_key: 'notes', blocks: [{ kind: 'fact', text: 'Newer snapshot only', refs: ['notes'] }] },
        ] }));
        await finalize(v2);
        const cancelled = (await queue('xlsx', undefined, 202, `/reports/${report.id}/versions/2/export`)).operation_id;
        const cancel = await rest(`/operations/${cancelled}`);
        await post(`/operations/${cancelled}/cancel`, {}, 409, { 'if-match': String(cancel.version + 1) });
        assert.equal((await post(`/operations/${cancelled}/cancel`, {}, 200, { 'if-match': String(cancel.version) })).status, 'cancelled');
        await finalize(other);
        const denied = (await queue('pdf', undefined, 202, `/reports/${report.id}/versions/3/export`)).operation_id;
        const lostRole = (await queue('csv', undefined, 202, `/reports/${report.id}/versions/3/export`)).operation_id;
        await mutate(ctx => {
          ctx.update('data_source', workerSource.id, { allowed_uses: { display: true, export: false } });
          ctx.update('operation', lostRole, { requested_by: randomUUID() });
        });
        const editorSession = await request('/api/v1/session', { method: 'POST',
          body: { email: 'ai05-report-editor@example.invalid', password } });
        const editorCookie = editorSession.headers.get('set-cookie').split(';')[0];
        const { value: editorCsrf } = await request('/api/v1/session/csrf', { headers: { cookie: editorCookie } });
        const editor = { cookie: editorCookie, 'x-csrf-token': editorCsrf.csrf_token ?? editorCsrf.data.csrf_token };
        await post(path, { format: 'xlsx' }, 403, editor);
        const object = id => join(process.env.MEDIA_DIRECTORY, 't', ws.tenantId, 'w', ws.id, 'objects', id);
        await mkdir(join(object(ids.csv), '..'), { recursive: true });
        // Simulate a worker crash after the storage write and before the database commit.
        await writeFile(object(ids.csv), legacyCsv, { flag: 'wx' });
        await writeFile(object(cancelled), 'orphaned cancelled bytes', { flag: 'wx' });
        const originalObject = await stat(object(ids.csv));
        await stop();
        child = await exportServer(exportTest, config, standalone, true);
        base = child.base;
        const wait = async (id, status) => {
          let job;
          // The worker drains earlier outbox jobs first; don't compete with it at 10 requests/sec.
          for (let i = 0; i < 60; i++) {
            job = await rest(`/operations/${id}`);
            if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          assert.equal(job.status, status, `Report export ${id}: ${job.status} (${job.error_code ?? 'no error code'})`);
          return job;
        };
        assert.equal((await wait(denied, 'failed')).error_code, 'EGRESS_BLOCKED');
        assert.equal((await wait(lostRole, 'failed')).error_code, 'FORBIDDEN');
        for (const id of Object.values(ids)) await wait(id, 'succeeded');
        assert.equal((await stat(object(ids.csv))).ino, originalObject.ino);
        const read = async (id, status = 200) => {
          const response = await fetch(base + root + `/report-exports/${id}/download`, {
            signal: AbortSignal.any([exportTest.signal, AbortSignal.timeout(10_000)]),
            headers: { ...owner, origin: config.origin, connection: 'close' },
          });
          const data = Buffer.from(await response.arrayBuffer());
          assert.equal(response.status, status);
          return { data, headers: response.headers };
        };
        await rest(`/report-exports/${ids.xlsx}/download`, { status: 403, headers: editor });
        const csv = await read(ids.csv);
        assert.deepEqual(csv.data, Buffer.from(legacyCsv));
        assert.deepEqual((await read(ids.pdf)).data, Buffer.from(legacyPdf, 'base64'));
        const workbook = await read(ids.xlsx);
        assert.equal(workbook.headers.get('content-disposition'), 'attachment; filename="report-v1.xlsx"');
        assert.equal(workbook.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const { readXlsx } = await import('../../apps/server/src/modules/ingest/xlsx.ts');
        const xlsx = await readXlsx(workbook.data.toString('base64'), 20);
        assert.equal(xlsx[1].cells[3], phrase);
        assert.ok(!JSON.stringify(xlsx).includes('Newer snapshot only'));
        await read(cancelled, 404);
        await read(denied, 404);
        const file = await mutate(ctx => ctx.get('operation', ids.xlsx).file_object_id);
        await rest(`/files/${file}`, { status: 404 });
        await rest(`/files/${file}/download`, { status: 404 });
        if (standalone) await post('/shares/preview', { resource_type: 'file', resource_id: file, revision_id: file, audience: 'client',
          grantee_type: 'link', expires_at: new Date(Date.now() + 86_400_000).toISOString(), permissions: ['view', 'download'] }, 404);
        for (let i = 0; i < 30; i++) {
          if (!(await stat(object(cancelled)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)))) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await assert.rejects(stat(object(cancelled)), { code: 'ENOENT' });
        const currentSource = await rest(`/data-sources/${source.id}`);
        const setExport = (value, version) => rest(`/data-sources/${source.id}`, { method: 'PATCH',
          body: { allowed_uses: { display: true, export: value } }, headers: { 'if-match': String(version) } });
        const revoked = await setExport(false, currentSource.version);
        await queue('csv', key, 403);
        await read(ids.xlsx, 403);
        await setExport(true, revoked.version);
        const workerPid = child.pid;
        await child.close();
        child = await exportServer(exportTest, config, standalone, false);
        assert.notEqual(child.pid, workerPid);
        base = child.base;
        assert.equal((await queue('csv', key)).operation_id, ids.csv);
        assert.deepEqual((await read(ids.xlsx)).data, workbook.data);
        assert.equal((await rest(`/jobs/${ids.xlsx}`)).result_ref.version_id, v1.id);
        const mcp = await connect(reader.token);
        assert.deepEqual(data(await call(mcp, 'jobs_get', { operation_id: ids.xlsx })).result_ref,
          { report_id: report.id, version_id: v1.id, version_no: 1, format: 'xlsx' });
        await mcp.client.close();
      } finally {
        try {
          if (child) {
            try { await stop(); } finally { await child.close(); }
          }
        } finally {
          await background.close();
        }
      }
    });
    if (!app) await launch();
    const legacy = await connect(writer.token, false);
    assert.equal(legacy.client.getServerCapabilities().tasks, undefined);
    assert.equal(legacy.transport.sessionId, undefined);
    const old = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${reader.token}`,
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: { tasks: {} }, clientInfo: { name: 'legacy-host', version: '1' },
    } } });
    assert.equal(old.value.result.protocolVersion, '2025-06-18');
    assert.equal(old.value.result.capabilities.tasks, undefined);
    assert.equal(old.headers.get('mcp-session-id'), null);
    assert.equal(data(await call(legacy, 'jobs_get', { operation_id: id })).operation_id, id);
    const noGrant = await connect(unrelated.token);
    assert.equal(noGrant.client.getServerCapabilities().tasks, undefined);
    const watching = await connect(reader.token);
    assert.ok(watching.client.getServerCapabilities().tasks.requests.tools.call);
    const listed = await watching.client.listTools();
    assert.deepEqual(listed.tools.map(tool => [tool.name, tool.execution?.taskSupport]), [['jobs_get', 'optional']]);
    const { task } = await taskCall(watching, id);
    assert.equal(task.status, 'working');
    assert.equal((await taskCall(watching, id)).task.taskId, task.taskId);
    await assert.rejects(taskCall(watching, id, randomUUID()));
    const operating = await connect(writer.token);
    const claimed = data(await call(operating, 'agent_jobs_claim', { agent_job_id: id, expected_version: draft.version }));
    await assert.rejects(getTask(operating, task.taskId), { code: -32602 });
    await assert.rejects(getTask(watching, `${task.taskId}x`), { code: -32602 });
    await watching.client.close();
    await stop();
    await launch();
    const resumed = await connect(reader.token);
    assert.equal((await getTask(resumed, task.taskId)).statusMessage, 'claimed');
    assert.equal(data(await call(resumed, 'jobs_get', { operation_id: id })).version, claimed.version);
    assert.equal((await rest(`/operations/${id}`)).operation_id, id);
    assert.equal((await createDraft()).operation_id, id);
    assert.deepEqual((await rest('/agent-jobs')).map(job => job.id), [id]);
    assert.equal(toolError(await call(resumed, 'jobs_cancel', { operation_id: id, expected_version: claimed.version })), 'TOOL_UNAVAILABLE');
    const reopenedWriter = await connect(writer.token);
    const requested = data(await call(reopenedWriter, 'jobs_cancel', { operation_id: id, expected_version: claimed.version }));
    assert.equal(requested.status, 'claimed');
    assert.ok(requested.cancel_requested_at);
    const cancelled = data(await call(reopenedWriter, 'agent_jobs_confirm_cancel', { agent_job_id: id,
      expected_version: requested.version, fencing_token: claimed.fencing_token }));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await getTask(resumed, task.taskId)).status, 'cancelled');
    const history = await rest(`/agent-jobs/${id}`);
    for (const event of ['created', 'cancel_requested', 'cancelled']) assert.equal(history.events.filter(row => row.type === event).length, 1);
    async function verifyPublishing() {
      await t.test('Publishing batches and post-submission verification survive server restart', async t => {
        const background = standalone
          ? await (await import('../../packages/db/src/index.ts')).postgresStore(database)
          : new PostgresStore(process.env.SMARTSELL_AI05_BACKGROUND_PG_URL);
        t.after(() => background.close());
        const store = standalone ? kernelBackgroundStore(background) : commandBackgroundStore(background);
        const ws = (await store.workspaces()).find(row => row.id === workspace);
        assert.ok(ws);
        const transact = run => store.transact(ws, false, (records, scope) => run(makeContext(records, scope, 'owner')));
        const brand = await post('/brands', { name: 'AI05 publishing fixture', slug: 'ai05-publishing' });
        const account = await post('/social-accounts', { brand_id: brand.id, provider: 'meta_facebook', external_account_id: 'fixture-ai05-page',
          display_name: 'Local page', owned_account_confirmed: true });
        const { variants: [draft] } = await post('/content-items', { title: 'AI05 fixture copy', brand_id: brand.id, variants: [{
          platform: 'facebook', format: 'text', locale: 'en', body_markdown: 'Local fixture copy',
        }] });
        const { variant, revision } = await post(`/content-variants/${draft.id}/revisions`, { base_revision_id: null });
        await post(`/content-variants/${variant.id}/readiness`, {}, 200, { 'if-match': String(variant.version) });
        const input = { social_account_id: account.id, content_variant_id: variant.id, variant_revision_id: revision.id,
          scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), schedule_tz: 'UTC' };
        const plan = await post('/publish-plans', { source: 'batch', commit_mode: 'partial', items: [input, { ...input, variant_revision_id: randomUUID() }] });
        const planPath = `/publish-plans/${plan.id}`;
        const preview = await post(`${planPath}/preview`, {});
        const planKey = randomUUID();
        const commit = () => post(`${planPath}/commit`, { preview_hash: preview.preview_hash }, 202, { 'idempotency-key': planKey });
        const committed = await commit();
        assert.equal(committed.id, committed.operation_id);
        assert.deepEqual(committed.items.map(item => item.status), ['approval_required', 'failed']);
        const planned = await rest(`/publish-targets/${committed.items[0].target_id}`);
        assert.equal(planned.plan_status, 'awaiting_approval');
        assert.equal(planned.execution_task_id ?? null, null);
        const tasks = await transact(ctx => ['missing', 'published'].map(reference => {
          const target = ctx.create('publish_target', { social_account_id: account.id, plan_status: 'ready' });
          const task = ctx.create('execution_task', { publish_target_id: target.id, social_account_id: account.id, status: 'accepted',
            frozen: { platform: 'meta_facebook' }, verify_schedule_seconds: [3600] });
          const attempt = ctx.create('execution_attempt', { task_id: task.id, executor: 'api', status: 'accepted', attempt_no: 1,
            provider_processing: 'scheduled_on_platform', side_effect_possible: true, receipt: reference, submitted_at: ctx.now,
            client_request_id: `fixture-${reference}`, adapter_provider: 'meta_facebook' });
          return { task, attempt };
        }));
        const taskIds = tasks.map(({ task }) => task.id);
        const batch = await post('/execution-batches/preview', { action: 'reconcile', task_ids: taskIds });
        const batchKey = randomUUID();
        const apply = () => post(`/execution-batches/${batch.id}/apply`, {}, 202, { 'idempotency-key': batchKey });
        const applied = await apply();
        assert.equal(applied.id, batch.id);
        assert.equal(applied.status, 'applied');
        assert.deepEqual(applied.results.map(result => [result.task_id, result.task_version]),
          tasks.map(({ task }) => [task.id, task.version]));
        const [firstId, secondId] = applied.results.map(result => result.verification_operation_id);
        assert.ok(firstId && secondId && firstId !== secondId);
        const verificationPath = `/execution-tasks/${taskIds[0]}/reconcile`;
        const verificationHeaders = { 'idempotency-key': randomUUID(), 'if-match': String(tasks[0].task.version) };
        async function verify() {
          const { value, headers } = await request(root + verificationPath, { method: 'POST', body: {}, status: 202,
            headers: { ...owner, ...verificationHeaders } });
          assert.equal(headers.get('etag'), `"${tasks[0].task.version}"`);
          assert.equal(value.data.task.id, taskIds[0]);
          assert.equal(value.data.operation_id, firstId);
        }
        await verify();
        if (!standalone) {
          const { value, headers } = await request(`${root}/commands/execution/operation_publishing_reconcile`, {
            method: 'POST', status: 202, body: { id: taskIds[0], fields: {} },
            headers: { ...owner, ...verificationHeaders, 'idempotency-key': randomUUID() },
          });
          assert.equal(headers.get('etag'), `"${tasks[0].task.version}"`);
          assert.equal(value.data.task.id, taskIds[0]);
          assert.equal(value.data.operation_id, firstId);
        }
        const publicationReader = await pat('read', ['jobs_get']);
        const before = await connect(publicationReader.token);
        const { task: tracking } = await taskCall(before, firstId);
        await before.client.close();
        await stop();
        await launch();
        await verify();
        assert.deepEqual(await commit(), committed);
        assert.deepEqual(await apply(), applied);
        assert.equal((await post(`/execution-batches/${batch.id}/apply`, {}, 202)).operation_id, applied.operation_id);
        const reader = await connect(publicationReader.token);
        const writerClient = await connect(writer.token);
        assert.equal((await getTask(reader, tracking.taskId)).statusMessage, 'queued');
        assert.equal(data(await call(reader, 'jobs_get', { operation_id: committed.operation_id })).status, 'partially_committed');
        assert.equal(data(await call(reader, 'jobs_get', { operation_id: applied.operation_id })).status, 'succeeded');
        assert.deepEqual((await rest(`/operations/${committed.operation_id}`)).items, committed.items);
        const batchItems = (await rest(`/operations/${applied.operation_id}`)).items;
        assert.deepEqual(batchItems.map(item => [item.verification_operation_id, item.task_version]),
          [[firstId, tasks[0].task.version], [secondId, tasks[1].task.version]]);
        for (const operation_id of [committed.operation_id, applied.operation_id]) {
          const current = await rest(`/operations/${operation_id}`);
          await post(`/operations/${operation_id}/cancel`, {}, 409, { 'if-match': String(current.version) });
        }
        const first = data(await call(reader, 'jobs_get', { operation_id: firstId }));
        assert.equal(toolError(await call(reader, 'jobs_cancel', { operation_id: firstId, expected_version: first.version })), 'TOOL_UNAVAILABLE');
        assert.equal(toolError(await call(writerClient, 'jobs_cancel', { operation_id: firstId, expected_version: first.version + 1 })), 'VERSION_CONFLICT');
        for (const operation_id of [firstId, secondId]) {
          const current = data(await call(writerClient, 'jobs_get', { operation_id }));
          const cancellation = operation_id === firstId
            ? data(await call(writerClient, 'jobs_cancel', { operation_id, expected_version: current.version }))
            : await post(`/operations/${operation_id}/cancel`, {}, 200, { 'if-match': String(current.version) });
          assert.equal(cancellation.operation_id, operation_id);
          assert.equal(cancellation.status, 'cancel_requested');
        }
        await post(`/execution-tasks/${taskIds[0]}/retry`, {}, 409);
        let reads = 0;
        let writes = 0;
        let inconclusive = true;
        const startWorker = () => createExecutionWorker(transact, [{ provider: 'meta_facebook',
          async submit() { writes++; throw new Error('Fixture attempt already submitted'); },
          async cancelScheduled() { writes++; throw new Error('Job cancellation may only request verification'); },
          async observe(request, receipt) {
            reads++;
            assert.equal(request.client_request_id, `fixture-${receipt}`);
            if (receipt === 'published') return { status: 'published', external_post_id: 'fixture-post', permalink: 'https://example.invalid/fixture-post' };
            return inconclusive ? { status: 'inconclusive' } : { status: 'absent', complete_window: true, delay_elapsed: true };
          },
        }]);
        assert.deepEqual((await startWorker().tick()).failures, []);
        assert.equal((await rest(`/operations/${firstId}`)).status, 'cancel_requested');
        assert.equal((await rest(`/operations/${firstId}`)).progress.outcome, 'inconclusive');
        assert.equal((await rest(`/operations/${secondId}`)).status, 'succeeded');
        assert.equal((await rest(`/execution-tasks/${taskIds[1]}`)).status, 'published');
        assert.equal((await getTask(reader, tracking.taskId)).statusMessage, 'cancel_requested');
        inconclusive = false;
        await post(verificationPath, {}, 202);
        assert.deepEqual((await startWorker().tick()).failures, []);
        assert.equal((await getTask(reader, tracking.taskId)).status, 'cancelled');
        const finished = await rest(`/execution-tasks/${taskIds[0]}`);
        assert.equal(finished.status, 'cancelled');
        assert.deepEqual(finished.attempts.map(attempt => attempt.id), [tasks[0].attempt.id]);
        assert.deepEqual(finished.verifications.map(verification => verification.id), [firstId]);
        assert.equal(writes, 0);
        assert.equal(reads, 3);

        const { task, evidence } = await transact(ctx => {
          const target = ctx.create('publish_target', { social_account_id: account.id, plan_status: 'ready' });
          const task = ctx.create('execution_task', { publish_target_id: target.id, social_account_id: account.id, status: 'outcome_unknown' });
          ctx.create('execution_attempt', { task_id: task.id, executor: 'manual', status: 'unknown', attempt_no: 1, side_effect_possible: true });
          const evidence = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
          return { task, evidence };
        });
        const confirmed = await post(`/execution-tasks/${task.id}/reconcile`, {
          outcome: 'verified_absent', confirmed_no_pending_submission: true, visibility_window_elapsed: true,
          evidence_file_ids: [evidence.id],
        }, 200, { 'if-match': String(task.version) });
        assert.equal(confirmed.task.status, 'retryable');
        assert.equal(confirmed.version, confirmed.task.version);
        assert.equal(confirmed.operation_id, undefined);
      });
    }
    await runClaudeHost(t, base, reader.token);
    if (standalone) return verifyPublishing();

    const source = await post('/data-sources', { kind: 'vendor', provider: 'vendor:local', name: 'Local fixture',
      contract_ref: 'local-contract', resources: ['posts'] });
    const syncKey = randomUUID();
    const refresh = () => post(`/data-sources/${source.id}/refresh`, {}, 202, { 'idempotency-key': syncKey });
    const sync = await refresh();
    const syncId = sync.operation_id;
    assert.notEqual(syncId, sync.sync_run_id);
    assert.equal((await refresh()).operation_id, syncId);
    assert.equal((await rest(`/sync-runs?data_source_id=${source.id}`)).length, 1);
    assert.equal(data(await call(resumed, 'jobs_get', { operation_id: syncId })).status, 'queued');
    const { task: queued } = await taskCall(resumed, syncId);
    await stop();
    await launch();
    const syncReader = await connect(reader.token);
    const syncWriter = await connect(writer.token);
    assert.equal((await getTask(syncReader, queued.taskId)).statusMessage, 'queued');
    assert.equal((await refresh()).operation_id, syncId);
    assert.deepEqual((await rest(`/sync-runs?data_source_id=${source.id}`)).map(row => row.id), [sync.sync_run_id]);
    const backgroundUrl = new URL(process.env.SMARTSELL_AI05_BACKGROUND_PG_URL);
    assert.equal(backgroundUrl.host, url.host);
    assert.equal(backgroundUrl.pathname, url.pathname);
    const background = new PostgresStore(backgroundUrl.href);
    t.after(() => background.close());
    const store = commandBackgroundStore(background);
    const scope = (await store.workspaces()).find(row => row.id === workspace);
    const record = (run, page) => store.transact(scope, false, (records, scope) => recordSyncPage(makeContext(records, scope, 'owner'),
      run, { attempt: 1, requests: 1, ...page }));
    const checkpoint = index => record(sync.sync_run_id, { index, cursor: `page-${index + 1}`, result: 'more' });
    const abort = new AbortController();
    t.after(() => abort.abort());
    const signal = AbortSignal.any([t.signal, abort.signal, AbortSignal.timeout(15_000)]);
    const updates = frames(await fetch(base + root + '/stream', { headers: { cookie, connection: 'close' }, signal }));
    assert.match((await updates.next()).value, /connected/);
    const progress = frames(await fetch(base + '/mcp', { method: 'POST', signal, headers: {
      connection: 'close', authorization: `Bearer ${reader.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocol, 'mcp-session-id': syncReader.transport.sessionId,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 'sync-result', method: 'tasks/result', params: {
      taskId: queued.taskId, _meta: { progressToken: 'sync-progress' },
    } }) }));
    async function expectProgress(status, previous = 0) {
      const frame = message((await progress.next()).value);
      assert.equal(frame.method, 'notifications/progress');
      assert.equal(frame.params.progressToken, 'sync-progress');
      assert.equal(frame.params.message, status);
      assert.ok(frame.params.progress > previous);
      return frame.params.progress;
    }
    const first = await expectProgress('queued');
    await checkpoint(1);
    const second = await expectProgress('running', first);
    const update = (await updates.next()).value;
    assert.match(update, /event: workspace.changed\ndata: {"type":"workspace.changed"}/);
    const revision = update.match(/id: (\d+)/)[1];
    await checkpoint(2);
    const third = await expectProgress('running', second);
    const reconnected = frames(await fetch(base + root + '/stream', { headers: { cookie, connection: 'close', 'last-event-id': revision }, signal }));
    assert.match((await reconnected.next()).value, /connected/);
    assert.match((await reconnected.next()).value, /workspace.changed/);
    const current = (await rest(`/operations/${syncId}`));
    assert.equal(current.progress.checkpoint_index, 2);
    assert.equal(toolError(await call(syncWriter, 'jobs_cancel', { operation_id: syncId, expected_version: first })), 'VERSION_CONFLICT');
    const stopped = data(await call(syncWriter, 'jobs_cancel', { operation_id: syncId, expected_version: current.version }));
    assert.equal(stopped.status, 'cancelled');
    const fourth = await expectProgress('cancelled', third);
    const final = message((await progress.next()).value);
    assert.equal(final.id, 'sync-result');
    assert.equal(data(final.result).operation_id, syncId);
    assert.equal(data(final.result).status, 'cancelled');
    assert.equal((await progress.next()).done, true);
    await assert.rejects(checkpoint(3), { code: 'BAD_CHECKPOINT' });
    assert.equal((await rest(`/sync-runs/${sync.sync_run_id}`)).status, 'cancelled');
    assert.equal((await rest(`/operations/${syncId}`)).version, stopped.version);
    assert.equal((await getTask(syncReader, queued.taskId)).status, 'cancelled');
    abort.abort();
    const completed = await post(`/data-sources/${source.id}/refresh`, {}, 202, { 'idempotency-key': randomUUID() });
    const { task: completing } = await taskCall(syncReader, completed.operation_id);
    await record(completed.sync_run_id, { index: 1, result: 'succeeded' });
    assert.equal((await getTask(syncReader, completing.taskId)).status, 'completed');
    const result = await syncReader.client.request({ method: 'tasks/result', params: { taskId: completing.taskId } }, CallToolResultSchema);
    assert.equal(data(result).operation_id, completed.operation_id);
    assert.equal(data(result).status, 'succeeded');
    const day = 86_400_000;
    const to = Date.now() - day;
    const backfill = (resources, days) => post('/backfills', { data_source_id: source.id, resources,
      from: new Date(to - days * day).toISOString(), to: new Date(to).toISOString() }, 202);
    const older = await backfill(['posts'], 7);
    const overlap = await backfill(['posts'], 14);
    assert.equal(overlap.sync_run_ids.length, 2);
    const [shared] = older.sync_run_ids;
    assert.ok(overlap.sync_run_ids.includes(shared));
    const obsolete = await rest(`/operations/${older.operation_id}`);
    await post(`/operations/${older.operation_id}/cancel`, {}, 200, { 'if-match': String(obsolete.version) });
    assert.equal((await rest(`/sync-runs/${shared}`)).status, 'queued');
    const active = await rest(`/operations/${overlap.operation_id}`);
    assert.equal(active.progress.pending, 2);
    const { task: revokedTask } = await taskCall(syncReader, overlap.operation_id);
    const pending = frames(await fetch(base + '/mcp', { method: 'POST', signal: AbortSignal.timeout(10_000), headers: {
      authorization: `Bearer ${reader.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocol, 'mcp-session-id': syncReader.transport.sessionId, connection: 'close',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 'revoked-result', method: 'tasks/result', params: {
      taskId: revokedTask.taskId, _meta: { progressToken: 'revoked-progress' },
    } }) }));
    assert.equal(message((await pending.next()).value).method, 'notifications/progress');
    await rest(`/tokens/${reader.id}`, { method: 'DELETE', status: 204 });
    assert.equal(message((await pending.next()).value).error.code, -32602);
    assert.equal((await pending.next()).done, true);
    await post(`/operations/${overlap.operation_id}/cancel`, {}, 200, { 'if-match': String(active.version) });
    assert.equal((await rest(`/sync-runs/${shared}`)).status, 'cancelled');
    assert.equal((await rest(`/operations/${older.operation_id}`)).status, 'cancelled');
    assert.equal((await rest(`/operations/${overlap.operation_id}`)).progress.cancelled, 2);
    await request('/mcp', { method: 'POST', status: 401, headers: { authorization: `Bearer ${reader.token}`,
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol, 'mcp-session-id': syncReader.transport.sessionId },
    body: { jsonrpc: '2.0', id: 10, method: 'tasks/get', params: { taskId: queued.taskId } } });
    assert.equal(data(await call(syncWriter, 'jobs_get', { operation_id: syncId })).status, 'cancelled');
    t.diagnostic(`One tasks/result connection emitted queued v${first}, checkpoints v${second}/v${third}, cancelled v${fourth}; workspace SSE replayed after Last-Event-ID.`);
    await verifyPublishing();
  });
}
