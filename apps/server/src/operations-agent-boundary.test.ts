import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { Data, Input, Role, Row } from '@smartsell/contracts';
import { Records } from '@smartsell/db';
import { buildApp } from './app.js';
import { configuration } from './config.js';
import { makeContext } from './context.js';
import { MemoryStore } from './memory.js';
import { registerOperationRoutes } from './operation-server.js';
import { AGENT_HUMAN_FIELDS, AGENT_STOP_ONLY, agentCallable, discoverOperations, HUMAN_ONLY, runScopedOperation, type Registered } from './operations.js';
import { discover } from './registry.js';

type Json = Record<string, any>;
const config = configuration({ SETUP_TOKEN: 'agent-boundary-setup-token' });
let discovered: Promise<Registered[]> | undefined;
const operations = () => discovered ??= discoverOperations().then(result => result.operations);
const byName = async (name: string) => (await operations()).find(op => op.name === name) ?? assert.fail(`missing ${name}`);

/** Reviewer-tier writes (the APPROVE set: roles with 'reviewer' and without 'editor') are decisions unless they stop or only read. */
const approverTier = (op: Registered) => op.method !== 'GET' && op.roles.includes('reviewer') && !op.roles.includes('editor');
/** Approver-tier writes an Agent may still call. Each one stops something reversibly or only reads back state (design 4.3: Agent 可以「停」). */
const AGENT_APPROVER_WRITES: Record<string, string> = {
  pages_unpublish: 'takes a landing page offline; a person can publish it again',
  forms_deactivate: 'stops accepting form submissions; a person can activate it again',
  lifecycle_cancel_campaign: 'cancels a local draft email campaign',
  lifecycle_cancel_local_esp: 'asks the ESP to cancel a confirmed schedule',
  jobs_cancel: 'requests cancellation of a durable operation',
  links_probe: 'observes a registered destination and records what it saw',
  lifecycle_reconcile_local_esp: 'reads back the provider receipt',
  lifecycle_read_local_esp_flow: 'reads back the provider flow state',
};
/** Writes no manager, editor or reviewer may make: workspace settings, integrations and imports. */
const adminTier = (op: Registered) => op.method !== 'GET' && !(['manager', 'editor', 'reviewer'] as Role[]).some(role => op.roles.includes(role));
/** Writes whose name says they release, resume or authorize something, at any role tier. */
const releaseName = (op: Registered) => op.method !== 'GET' &&
  /(?:^|_)(?:publish|activate|enable|resume|restore|start|allow|release|reopen|unsnooze|verify|accept|confirm|schedule|send|connect|authorize|grant|retry|apply)(?:_|$)/.test(op.name);
/**
 * Agent-callable admin-tier and release-named writes, grouped by why an Agent may make them. A release hidden in an ordinary
 * update (links_update back to active) has no telling name: put it in AGENT_STOP_ONLY or AGENT_HUMAN_FIELDS by hand.
 */
const AGENT_SETTINGS: Record<string, string[]> = {
  'imports or records what the Agent observed, with its evidence': ['account_probe_capabilities', 'account_probe_store_capabilities',
    'commerce_store_sync', 'content_poll_feed', 'content_preview_feed_import', 'inbox_ingest_batch', 'inbox_import_review', 'ads_import_report',
    'lifecycle_sync_local_esp_suppressions', 'customers_link_identity', 'customers_unlink_identity', 'customers_merge', 'customers_revert_merge',
    'lifecycle_record_consent', 'lifecycle_import_campaign_send', 'lifecycle_import_health', 'lifecycle_import_send_observation',
    'analytics_record_observations', 'attribution_record_reported', 'contribution_record_inputs', 'audience_insights_record',
    'commerce_promotion_verify', 'inbox_verify_review_reply', 'creators_verify_account', 'collaborations_send_terms', 'import_confirm'],
  'defines workspace structure or drafts; nothing goes public, mails anyone, spends or widens data use': ['workspace_update',
    'data_source_create', 'data_source_update', 'commerce_store_create', 'commerce_store_update', 'content_create_pillar',
    'content_update_pillar', 'content_create_feed', 'content_update_feed', 'inbox_create_sla_policy', 'inbox_update_sla_policy',
    'inbox_create_business_hours', 'inbox_update_business_hours', 'inbox_register_review_source', 'utm_create', 'utm_update',
    'ads_register_account', 'ads_update_account', 'lifecycle_create_consent_text', 'lifecycle_create_esp_account',
    'revise_metric_definition', 'attribution_models_revise', 'reports_generate_due',
    'content_restore_revision', 'content_accept_source_change', 'posting_time_apply', 'sync_schedule_create', 'sync_schedule_update'],
  'auto-reply rules only write drafts that a person approves': ['inbox_create_auto_rule', 'inbox_enable_auto_rule', 'inbox_evaluate_auto_rules'],
  'stops, cancels, caps or archives': ['data_source_pause', 'content_archive_pillar', 'content_archive_feed', 'inbox_cancel_reply',
    'inbox_archive_business_hours', 'inbox_archive_sla_policy', 'inbox_archive_auto_rule', 'utm_remove', 'lifecycle_record_suppression',
    'lifecycle_create_frequency_rule', 'agent_jobs_confirm_cancel'],
  'authorizes only .test addresses or loopback readback': ['lifecycle_set_local_esp', 'inbox_set_local_comment_access'],
  'asks a person to act or approve, or carries out what a person approved': ['publishing_schedule', 'publishing_retry',
    'publishing_apply_execution_batch', 'inbox_send_reply', 'inbox_retry_reply', 'outreach_send', 'lifecycle_request_customer_data'],
  'internal work state: retries failed collection or media, reopens tasks, frees a lease': ['sync_run_retry', 'backfill_resume',
    'asset_retry_rendition', 'tasks_reopen', 'inbox_sla_tick', 'inbox_unsnooze', 'inbox_release'],
};

test('no approver-tier write becomes Agent-callable without an explicit stop or read reason', async () => {
  const all = await operations();
  const names = new Set(all.map(op => op.name));
  const leaked = all.filter(op => approverTier(op) && agentCallable(op) && !Object.hasOwn(AGENT_APPROVER_WRITES, op.name) && !Object.hasOwn(AGENT_STOP_ONLY, op.name));
  assert.deepEqual(leaked.map(op => op.name), [], 'Add the operation to HUMAN_ONLY, or explain in AGENT_APPROVER_WRITES why an Agent may call it');
  for (const name of Object.keys(AGENT_APPROVER_WRITES)) {
    const op = all.find(item => item.name === name);
    assert.ok(op && approverTier(op) && agentCallable(op), `${name} no longer needs an Agent exception`);
  }
  for (const name of [...Object.keys(AGENT_STOP_ONLY), ...Object.keys(AGENT_HUMAN_FIELDS)]) {
    const op = all.find(item => item.name === name);
    assert.ok(op && agentCallable(op), `${name} is not an Agent-callable operation`);
  }
  assert.deepEqual([...HUMAN_ONLY].filter(name => !names.has(name)), [], 'HUMAN_ONLY names an operation that does not exist');
});

test('no admin-tier or release-named write becomes Agent-callable without a stated reason', async () => {
  const all = await operations();
  const listed = Object.values(AGENT_SETTINGS).flat();
  assert.equal(new Set(listed).size, listed.length, 'an operation is listed under two reasons');
  const watched = (op: Registered) => (adminTier(op) || releaseName(op)) && agentCallable(op) && !Object.hasOwn(AGENT_STOP_ONLY, op.name);
  assert.deepEqual(all.filter(op => watched(op) && !listed.includes(op.name)).map(op => op.name), [],
    'Add the operation to HUMAN_ONLY, or list it in AGENT_SETTINGS under the reason an Agent may call it');
  assert.deepEqual(listed.filter(name => !all.some(op => op.name === name && watched(op))), [], 'AGENT_SETTINGS lists an operation that no longer needs a reason');
});

function harness(role: Role = 'owner') {
  const records = new Records(new Map(), false);
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const ctx = makeContext(records, scope, role);
  const run = async (name: string, input: Partial<Input> = {}, grantId?: string) => (await runScopedOperation(records, scope,
    { actorId: scope.actorId, grantId }, role, randomUUID(), await byName(name), { params: {}, query: {}, body: {}, ...input },
    grantId ? 'mcp' : 'rest', config)).body.data as Json;
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: Json) => String(error.code));
  return { ctx, run, code, scope };
}
const agent = 'credential-a';

test('the shared runner refuses newly human-only releases for Agent credentials and lets people through to the operation', async () => {
  const { run, code } = harness();
  const names = ['pages_publish', 'pages_configure_experiment', 'bio_add_item', 'bio_edit_item', 'bio_remove_item', 'forms_activate',
    'links_allow_host', 'links_revoke_host', 'links_domain_create', 'links_domain_verify', 'lifecycle_test_send_campaign',
    'lifecycle_schedule_campaign', 'lifecycle_submit_local_esp', 'commerce_localization_accept', 'commerce_localization_writeback',
    'deliverables_review', 'deliverables_verify_publication', 'account_enable_social_account', 'account_link_accounts',
    'experiment_start', 'collection_budget_set', 'commerce_store_connect', 'data_source_resume', 'workspace_brand_restore', 'commerce_fact_retract'];
  for (const name of names) {
    const input = { params: { id: randomUUID() }, expectedVersion: 1, idempotencyKey: `k-${name}`, body: { hostname: 'attacker.example' } };
    assert.equal(await code(run(name, input, agent)), 'HUMAN_REQUIRED', name);
    // A random id fails inside the operation (NOT_FOUND and the like): the gate let the person through. Success paths are below.
    assert.notEqual(await code(run(name, input)), 'HUMAN_REQUIRED', name);
  }
  assert.ok((await run('links_allow_host', { body: { hostname: 'shop.example.com' } })).id);
});

test('an Agent cannot undo a person\'s pause or archive, start a test, or retract an approved fact', async () => {
  const { ctx, run, code } = harness();
  const link = ctx.create('short_link', { code: 'glow', status: 'active' });
  const update = (status: string | undefined, version: number, grantId?: string) =>
    run('links_update', { params: { id: link.id }, expectedVersion: version, body: status ? { status } : { expires_at: '2099-01-01T00:00:00Z' } }, grantId);
  assert.equal((await update('paused', 1, agent)).status, 'paused');
  for (const status of ['active', 'archived', undefined]) assert.equal(await code(update(status, 2, agent)), 'HUMAN_REQUIRED', String(status));
  assert.equal((await update('active', 2)).status, 'active');

  const source = ctx.create('data_source', { kind: 'file_import', provider: 'file_import', name: 'CSV', status: 'active', resources: [] });
  assert.equal((await run('data_source_pause', { params: { id: source.id } }, agent)).status, 'paused');
  assert.equal(await code(run('data_source_resume', { params: { id: source.id } }, agent)), 'HUMAN_REQUIRED');
  assert.equal((await run('data_source_resume', { params: { id: source.id } })).status, 'active');

  const brand = ctx.create('brand', { name: 'Old', slug: 'old', status: 'archived' });
  assert.equal(await code(run('workspace_brand_restore', { params: { id: brand.id }, expectedVersion: 1 }, agent)), 'HUMAN_REQUIRED');
  assert.equal((await run('workspace_brand_restore', { params: { id: brand.id }, expectedVersion: 1 })).status, 'active');

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const experiment = ctx.create('experiment', { type: 'page', status: 'draft', period: { from: day(0), to: day(2), tz: 'UTC' }, variants: [] });
  assert.equal(await code(run('experiment_start', { params: { id: experiment.id }, expectedVersion: 1 }, agent)), 'HUMAN_REQUIRED');
  assert.equal((await run('experiment_start', { params: { id: experiment.id }, expectedVersion: 1 })).status, 'running');
  assert.equal((await run('experiment_stop', { params: { id: experiment.id }, expectedVersion: 2 }, agent)).status, 'stopped');

  const product = ctx.create('product', { store_id: randomUUID(), title: 'Serum', status: 'active' });
  const fact = await run('catalog_propose_fact', { params: { id: product.id }, body: { category: 'spec', fact_key: 'volume', value: '30ml' } });
  await run('commerce_fact_approve', { params: { id: fact.current_revision_id } });
  const approved = ctx.get('product_fact', fact.id);
  assert.equal(await code(run('commerce_fact_retract', { params: { id: fact.id }, expectedVersion: approved.version }, agent)), 'HUMAN_REQUIRED');
  assert.equal(ctx.get('product_fact', fact.id).status, 'active');
  assert.equal((await run('commerce_fact_retract', { params: { id: fact.id }, expectedVersion: approved.version })).status, 'retracted');
});

test('the decisions view does not show an Agent credential the draft values waiting for review', async () => {
  const { ctx, run } = harness();
  const product = ctx.create('product', { store_id: randomUUID(), title: 'Serum', status: 'active' });
  await run('catalog_propose_fact', { params: { id: product.id }, body: { category: 'spec', fact_key: 'volume', value: 'SECRET-DRAFT-30ml' } });
  const previews = async (grantId?: string) => JSON.stringify(await run('views_decisions_list', {}, grantId));
  assert.ok((await previews()).includes('SECRET-DRAFT-30ml'));
  assert.ok(!(await previews(agent)).includes('SECRET-DRAFT-30ml'));
});

test('an Agent registers and edits data sources but cannot set what their data may be used for', async () => {
  const { run, code } = harness();
  const create = (body: Json, grantId?: string) => run('data_source_create', { body: { kind: 'file_import', provider: 'file_import', name: 'CSV', resources: ['orders'], ...body } }, grantId);
  assert.equal(await code(create({ allowed_uses: { public_display: true } }, agent)), 'HUMAN_REQUIRED');
  const source = await create({}, agent);
  assert.equal(source.allowed_uses.public_display, false);
  const edit = (body: Json, version: number, grantId?: string) => run('data_source_update', { params: { id: source.id }, expectedVersion: version, body }, grantId);
  assert.equal(await code(edit({ allowed_uses: { model_processing: true } }, source.version, agent)), 'HUMAN_REQUIRED');
  const renamed = await edit({ name: 'Orders CSV' }, source.version, agent);
  assert.equal(renamed.name, 'Orders CSV');
  assert.equal((await edit({ allowed_uses: { model_processing: true } }, renamed.version)).allowed_uses.model_processing, true);
});

test('an Agent may send only the stop on endpoints that both release and stop', async () => {
  const { ctx, run, code } = harness();
  const page = ctx.create('bio_page', { handle: 'glow', brand_id: randomUUID(), title: 'Glow', status: 'published' });
  assert.equal(await code(run('bio_publish', { params: { id: page.id }, expectedVersion: 1, body: {} }, agent)), 'HUMAN_REQUIRED');
  assert.equal((await run('bio_publish', { params: { id: page.id }, expectedVersion: 1, body: { unpublish: true } }, agent)).status, 'unpublished');
  assert.equal(await code(run('bio_publish', { params: { id: page.id }, expectedVersion: 2, body: { unpublish: false } }, agent)), 'HUMAN_REQUIRED');
  assert.equal((await run('bio_publish', { params: { id: page.id }, expectedVersion: 2, body: {} })).status, 'published');

  const flow = ctx.create('esp_flow_ref', { esp_account_id: randomUUID(), kind: 'welcome', status: 'draft' });
  assert.equal(await code(run('lifecycle_change_flow_status', { params: { id: flow.id }, expectedVersion: 1, body: { status: 'live' } }, agent)), 'HUMAN_REQUIRED');
  assert.equal((await run('lifecycle_change_flow_status', { params: { id: flow.id }, expectedVersion: 1, body: { status: 'manual' } }, agent)).review_mode, 'manual');
});

test('an admin Agent edits an ad account but cannot change who may approve or spend on it', async () => {
  const { ctx, run, code } = harness();
  const account = ctx.create('ad_account', { provider: 'meta_ads', brand_id: randomUUID(), external_account_id: 'act_1', currency: 'TWD',
    timezone: 'Asia/Taipei', permissions: [] });
  const grant = [{ actor_id: randomUUID(), actions: ['read', 'approve'] }];
  assert.equal(await code(run('ads_update_account', { params: { id: account.id }, expectedVersion: 1, body: { permissions: grant } }, agent)), 'HUMAN_REQUIRED');
  assert.equal(await code(run('ads_update_account', { params: { id: account.id }, expectedVersion: 1, body: { permissions: [] } }, agent)), 'HUMAN_REQUIRED');
  assert.equal((await run('ads_update_account', { params: { id: account.id }, expectedVersion: 1, body: { spend_cap_snapshot: 50000 } }, agent)).spend_cap_snapshot, 50000);
  const human = await run('ads_update_account', { params: { id: account.id }, expectedVersion: 2, body: { permissions: grant } });
  assert.deepEqual(human.permissions.map((row: Json) => row.actions), [['read', 'approve']]);
});

test('idempotency keys are scoped to the credential, and still replay and reject mismatches within one', async () => {
  const { run, code } = harness();
  const create = (name: string, key: string, grantId?: string) => run('workspace_brand_create',
    { body: { name, slug: name.toLowerCase() }, idempotencyKey: key }, grantId);
  const first = await create('Alpha', 'brand-1', 'credential-a');
  assert.equal((await create('Alpha', 'brand-1', 'credential-a')).id, first.id);
  assert.equal(await code(create('Other', 'brand-1', 'credential-a')), 'IDEMPOTENCY_MISMATCH');
  const second = await create('Beta', 'brand-1', 'credential-b');
  assert.notEqual(second.id, first.id);
  assert.equal(await code(create('Gamma', 'brand-1', 'credential-b')), 'IDEMPOTENCY_MISMATCH');
  const human = await create('Delta', 'brand-1');
  assert.ok(![first.id, second.id].includes(human.id));
});

test('Agent credentials read only approved knowledge and are recorded as the author of their proposals', async () => {
  const { ctx, run } = harness();
  const brand = ctx.create('brand', { name: 'Glow', slug: 'glow', status: 'active' });
  const proposed = await run('knowledge_propose', { body: { brand_id: brand.id, kind: 'tone', title: 'Voice', body: 'Warm and plain' } });
  assert.equal(proposed.knowledge_revision.created_by_type, 'user');
  await run('knowledge_approve', { params: { id: proposed.knowledge_revision.id }, expectedVersion: 1 });
  const entry = ctx.get('knowledge_entry', proposed.id);
  const revised = await run('knowledge_revise', { params: { id: entry.id }, expectedVersion: entry.version,
    body: { body: 'Shout it', source: { kind: 'human', note: 'from the founder' } } }, agent);
  assert.deepEqual([revised.knowledge_revision.created_by_type, revised.knowledge_revision.source], ['agent', { kind: 'agent', note: 'from the founder' }]);

  const bodies = (detail: Json) => detail.revisions.map((row: Json) => row.body);
  assert.deepEqual(bodies(await run('knowledge_get', { params: { id: entry.id } }, agent)), ['Warm and plain']);
  assert.deepEqual(bodies(await run('knowledge_get', { params: { id: entry.id } })), ['Shout it', 'Warm and plain']);
  const context = (grantId?: string) => run('knowledge_get_context', { params: { brandId: brand.id }, query: { include_proposed: 'true' } }, grantId);
  assert.deepEqual((await context(agent)).items.map((row: Json) => row.body), ['Warm and plain']);
  assert.deepEqual((await context()).items.map((row: Json) => row.body).sort(), ['Shout it', 'Warm and plain']);
  const human = await run('knowledge_propose', { body: { brand_id: brand.id, kind: 'faq', title: 'Shipping', body: 'Two days', source: { kind: 'human' } } });
  assert.equal(human.knowledge_revision.source.kind, 'human');
  const imported = await run('knowledge_propose', { body: { brand_id: brand.id, kind: 'faq', title: 'Returns', body: '30 days',
    source: { kind: 'document_import', evidence_id: 'ev-1' } } }, agent);
  assert.deepEqual(imported.knowledge_revision.source, { kind: 'document_import', evidence_id: 'ev-1' });
});

test('Agent credentials see only approved localization text and cannot label their drafts as human', async () => {
  const { ctx, run } = harness();
  const store = ctx.create('store', { name: 'Shop', provider: 'manual', default_locale: 'en', status: 'active' });
  const product = ctx.create('product', { store_id: store.id, title: 'Vitamin C Serum', status: 'active' });
  const draft = (text: string, grantId?: string, version?: number) => run('catalog_update_localization',
    { params: { id: product.id }, expectedVersion: version, body: { field_key: 'title', locale: 'zh-TW', text, origin: 'human' } }, grantId);
  const localization = await draft('維C精華');
  await run('commerce_localization_submit', { params: { id: localization.id }, expectedVersion: localization.version });
  const approved = await run('commerce_localization_approve', { params: { id: localization.id }, expectedVersion: localization.version + 1 });
  assert.equal(approved.status, 'approved');
  await draft('超強維C精華', agent, approved.version);
  const origins = ctx.list('product_localization_revision').map(row => [row.text, row.origin]);
  assert.deepEqual(origins, [['維C精華', 'human'], ['超強維C精華', 'agent']]);

  const texts = (rows: Json[]) => rows.flatMap(row => row.revisions.map((revision: Row) => revision.text));
  assert.deepEqual(texts(await run('commerce_localization_list', { params: { id: product.id } }, agent) as unknown as Json[]), ['維C精華']);
  assert.deepEqual(texts(await run('commerce_localization_list', { params: { id: product.id } }) as unknown as Json[]), ['維C精華', '超強維C精華']);
  assert.deepEqual(texts((await run('catalog_get_product', { params: { id: product.id } }, agent)).localizations), ['維C精華']);
});

test('work items an Agent creates or completes are attributed to the Agent and stay assigned to its person', async () => {
  const { run, scope } = harness();
  const task = await run('tasks_create', { body: { title: 'Check stock' } }, agent);
  assert.deepEqual([task.source_type, task.assignee_type, task.assignee_id], ['agent', 'user', scope.actorId]);
  const started = await run('tasks_update', { params: { id: task.id }, expectedVersion: task.version, body: { status: 'in_progress' } }, agent);
  const done = await run('tasks_complete', { params: { id: task.id }, expectedVersion: started.version }, agent);
  assert.deepEqual([done.completed_by_type, done.completed_by_id], ['agent_client', scope.actorId]);
  const human = await run('tasks_create', { body: { title: 'Call supplier' } });
  assert.equal(human.source_type, 'manual');
});

async function connection(t: TestContext) {
  const store = new MemoryStore();
  const [all, registry] = await Promise.all([operations(), discover()]);
  const { app } = buildApp({ ...config, ...registry, store, operationApi: { config, operations: all, register: registerOperationRoutes } });
  t.after(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const post = async (path: string, body: Data, headers: Json = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { response, json: await response.json() as Json };
  };
  const setup = await post('/api/v1/setup', { email: 'boundary@example.test', name: 'Owner', workspaceName: 'Boundary', password: 'acceptance-only-1234' },
    { 'x-setup-token': config.setupToken! });
  const wid = setup.json.data.workspaces[0].id;
  const cookie = setup.response.headers.get('set-cookie')!.split(';')[0]!;
  const { csrf_token } = await (await fetch(`${base}/api/v1/session/csrf`, { headers: { cookie } })).json() as Json;
  const { token } = (await post(`/api/v1/workspaces/${wid}/agent-connections`, { label: 'Boundary agent', client: 'codex' },
    { cookie, 'x-csrf-token': csrf_token })).json.data;
  return async (name: string, args: Json) => {
    const { json } = await post('/mcp', { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } },
      { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' });
    return json.result.structuredContent as Json;
  };
}

test('over MCP an owner connection is refused releases by name and by body, and keeps its stops', async t => {
  const call = await connection(t);
  const operation = (name: string, input: Json) => call('smartsell_operation_call', { operation: name, ...input });
  assert.equal((await operation('links_allow_host', { body: { hostname: 'attacker-site.com' }, idempotency_key: 'allow-1' })).error.code, 'HUMAN_REQUIRED');
  const described = (await call('smartsell_operations_describe', { module: 'traffic' })).data.map((op: Json) => op.name);
  assert.ok(described.includes('pages_unpublish') && described.includes('bio_publish'));
  assert.ok(!described.includes('pages_publish') && !described.includes('links_allow_host'));

  const brand = (await call('workspace_brand_create', { body: { name: 'Glow', slug: 'glow' }, idempotency_key: 'brand-1' })).data;
  const page = (await operation('bio_create', { body: { brand_id: brand.id, title: 'Glow links', handle: 'glow' }, idempotency_key: 'bio-1' })).data;
  const publish = await operation('bio_publish', { params: { id: page.id }, expected_version: page.version, body: {}, idempotency_key: 'bio-2' });
  assert.equal(publish.error.code, 'HUMAN_REQUIRED');
  const stop = await operation('bio_publish', { params: { id: page.id }, expected_version: page.version, body: { unpublish: true }, idempotency_key: 'bio-3' });
  assert.equal(stop.data.status, 'unpublished');
});
