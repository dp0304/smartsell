import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import test from 'node:test';
import { configuration } from '../../apps/server/src/config.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { workspaceServices } from '../../apps/server/src/integration/workspace-services.ts';
import { createExecutionWorker } from '../../apps/server/src/modules/execution/worker.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { createServer } from '../../apps/server/src/server.ts';
import { fileStore } from '../../packages/db/src/index.ts';
import { localStorage } from '../../packages/media-store/src/storage.ts';

async function fixture(t, { opsServices, withOperations = operations => operations, captureErrors } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-ops-authorization-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const setupToken = randomUUID();
  const config = configuration({ SETUP_TOKEN: setupToken });
  const store = await fileStore(join(directory, 'state.json'));
  const { operations } = await discoverOperations();
  const app = createServer({ config, store, operations: withOperations(operations), opsServices });
  t.after(() => app.close());
  if (captureErrors) app.addHook('onRequest', async req => {
    const requestLogger = Object.create(req.log);
    requestLogger.error = (...args) => captureErrors.push(args.map(value => value instanceof Error
      ? { message: value.message, stack: value.stack } : value));
    req.log = requestLogger;
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  async function http(path, status, { method = 'GET', body, headers } = {}) {
    const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}`);
    return { raw, json: raw ? JSON.parse(raw) : undefined, headers: response.headers };
  }
  const setup = await http('/api/v1/setup', 201, { method: 'POST', headers: { 'x-setup-token': setupToken },
    body: { name: 'Fixture Owner', email: 'ops-authorization@example.invalid', password: randomUUID(), workspaceName: 'Operations fixture' },
  });
  const { user, workspaces: [workspace], csrf_token } = setup.json.data;
  const owner = { cookie: setup.headers.get('set-cookie').split(';')[0], 'x-csrf-token': csrf_token };
  const rest = (method, path, status, body) => http(`/api/v1/workspaces/${workspace.id}${path}`, status, { method, body, headers: owner });
  const seed = async run => store.transaction({ identityWrite: true }, async tx => {
    const { tenantId } = tx.identity.get(`workspace/${workspace.id}`);
    const scope = { actorId: user.id, workspaceId: workspace.id, tenantId };
    const records = await tx.workspace(scope);
    return run(makeContext(records, scope, 'owner'), scope, tx.identity);
  });
  return { directory, workspace, http, rest, seed };
}

test('OP03 a single synthetic credential stays out of inventory, REST, MCP and request error logs', async t => {
  const secret = `synthetic-ops-${randomUUID()}`;
  const errors = [];
  const s = await fixture(t, {
    captureErrors: errors,
    opsServices: { credentials: ctx => ctx.list('synthetic_credential') },
    withOperations: operations => operations.map(operation => operation.name === 'search_query' ? {
      ...operation, run(ctx, input) {
        if (input.query.fixture_error === '1') throw new Error(`Synthetic upstream error with ${secret}`);
        return operation.run(ctx, input);
      },
    } : operation),
  });
  const { inventory, connection, audit } = await s.seed(ctx => ({
    inventory: ctx.create('synthetic_credential', { provider: 'fixture', purpose: 'social', status: 'active', access_token: secret }),
    connection: ctx.create('connection', { provider: 'youtube', purpose: 'social', status: 'active', sealed_token: secret }),
    audit: ctx.create('audit_event', { action: 'fixture.read', metadata: { access_token: secret } }),
  }));
  const absent = (surface, output) => assert.equal(output.includes(secret), false, `${surface} exposed the synthetic value`);
  const inventoryResponse = await s.rest('GET', '/admin/credentials', 200);
  absent('inventory', inventoryResponse.raw);
  assert.equal(inventoryResponse.json.data[0].id, inventory.id);
  assert.equal(inventoryResponse.json.data[0].access_token, undefined);
  const connections = await s.rest('GET', '/connections', 200);
  absent('account connection list', connections.raw);
  assert.ok(connections.json.data.some(row => row.id === connection.id));
  const revoked = await s.rest('POST', `/connections/${connection.id}/revoke`, 200, {});
  absent('account connection revocation', revoked.raw);
  await s.seed(ctx => assert.equal(ctx.get('connection', connection.id).sealed_token, null));
  const auditPath = '/admin/audit-events';
  const restAudit = await s.rest('GET', auditPath, 200);
  absent('REST audit', restAudit.raw);
  assert.equal(restAudit.json.data.find(row => row.id === audit.id).metadata.access_token, '[redacted]');
  const { json: { data: { token } } } = await s.rest('POST', '/tokens', 201, { access: 'read', tools: ['search_query'] });
  const mcp = query => s.http('/mcp', 200, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_query', arguments: { workspace_id: s.workspace.id, query } } },
  });
  const mcpSearch = await mcp({ q: 'fixture' });
  absent('MCP search', mcpSearch.raw);
  assert.ok(mcpSearch.json.result?.structuredContent);
  const restError = await s.rest('GET', '/search?q=fixture&fixture_error=1', 500);
  absent('REST error', restError.raw);
  assert.equal(restError.json.code, 'INTERNAL_ERROR');
  const mcpError = await mcp({ fixture_error: '1' });
  absent('MCP error', mcpError.raw);
  assert.equal(mcpError.json.result.isError, true);
  assert.equal(mcpError.json.result.structuredContent.data.code, 'INTERNAL_ERROR');
  assert.equal(errors.length, 2);
  absent('REST error log', JSON.stringify(errors[0]));
  absent('MCP error log', JSON.stringify(errors[1]));
});

test('OP05 a scheduled revision pins actual local object bytes through purge preview and approval', async t => {
  const s = await fixture(t);
  const storage = localStorage(join(s.directory, 'media'));
  const payload = 'synthetic scheduled asset bytes';
  const source = join(s.directory, 'source');
  await writeFile(source, payload);
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const { file, key } = await s.seed((ctx, scope) => {
    const key = `t/${scope.tenantId}/w/${scope.workspaceId}/objects/${randomUUID()}`;
    const file = ctx.create('asset_file', { storage_key: key, sha256 });
    const asset = ctx.create('asset', { status: 'ready' });
    const version = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id });
    const revision = ctx.create('content_revision', { media: [{ asset_version_id: version.id }] });
    ctx.create('publish_target', { plan_status: 'ready', variant_revision_id: revision.id });
    return { file, key };
  });
  await storage.write(key, { path: source, size: Buffer.byteLength(payload), sha256, mime: 'text/plain' });
  const data_class = 'asset_file';
  await s.rest('PUT', '/admin/retention-policies', 200, { data_class, retain_days: 0 });
  const { json: { data: run } } = await s.rest('POST', '/admin/purge-runs', 200, { data_class });
  assert.deepEqual(run.preview.candidates, []);
  const blocked = run.preview.blocked_by.find(row => row.resource_id === file.id);
  assert.ok(blocked?.reasons.includes('scheduled_target'));
  const { json: { data: approved } } = await s.rest('POST', `/admin/purge-runs/${run.id}/approve`, 200, {});
  assert.deepEqual(approved.purged, []);
  assert.ok(approved.blocked_by.find(row => row.resource_id === file.id)?.reasons.includes('scheduled_target'));
  assert.equal(await text((await storage.read(key)).stream), payload);
});

test('OP10 read-only exports a known audit row and reads back an already published receipt without submitting', async t => {
  const s = await fixture(t);
  const enrich = workspaceServices([]);
  const transact = run => s.seed((ctx, _scope, identity) => run(enrich(ctx, identity)));
  const receipt = randomUUID();
  const externalPostId = randomUUID();
  const { task, attempt, audit } = await transact(ctx => {
    ctx.tenantScope.create('license_entitlement', {
      module_key: 'core', status: 'active', valid_from: '2020-01-01T00:00:00Z', valid_until: '2020-02-01T00:00:00Z',
    });
    const account = ctx.create('social_account', { provider: 'instagram', status: 'active' });
    const target = ctx.create('publish_target', { plan_status: 'ready' });
    const task = ctx.create('execution_task', { status: 'accepted', social_account_id: account.id,
      publish_target_id: target.id, fencing_token: 1, frozen: { platform: 'instagram' } });
    const attempt = ctx.create('execution_attempt', { task_id: task.id, status: 'accepted', attempt_no: 1,
      executor: 'api', side_effect_possible: true, receipt, client_request_id: randomUUID() });
    const audit = ctx.create('audit_event', { action: 'fixture.publication.accepted', resource_id: attempt.id });
    return { task, attempt, audit };
  });
  assert.equal((await s.rest('GET', '/admin/license', 200)).json.data.status, 'read_only');
  const exported = (await s.rest('POST', '/admin/exports', 200, { selection: 'audit_event' })).json.data;
  assert.equal(exported.export.status, 'completed');
  const exportedAudit = exported.data.find(row => row.id === audit.id);
  assert.equal(exportedAudit?.action, audit.action);
  assert.equal(exportedAudit.resource_id, attempt.id);

  const taskPath = `/execution-tasks/${task.id}`;
  const detail = async () => (await s.rest('GET', taskPath, 200)).json.data;
  assert.deepEqual((await detail()).attempts.map(row => [row.id, row.status]), [[attempt.id, 'accepted']]);
  const { operation_id } = (await s.rest('POST', `${taskPath}/reconcile`, 202, {})).json.data;
  const observations = [];
  let submissions = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async observe(request, reference) {
      observations.push([request.task_id, request.client_request_id, reference]);
      return { status: 'published', external_post_id: externalPostId, permalink: 'https://example.invalid/local-fixture' };
    },
    async submit() { submissions++; return { status: 'unknown' }; },
  }]);
  await worker.tick();
  assert.deepEqual(observations, [[task.id, attempt.client_request_id, receipt]]);
  assert.equal(submissions, 0);

  const after = await detail();
  assert.equal(after.status, 'published');
  assert.deepEqual(after.attempts.map(row => [row.id, row.status]), [[attempt.id, 'verified_published']]);
  assert.equal(after.verifications.find(row => row.id === operation_id)?.outcome, 'published');
  assert.equal(after.platform_post.external_post_id, externalPostId);
  assert.equal(after.platform_post.post_status, 'live');
  assert.deepEqual(after.pending_side_effects, []);
});
