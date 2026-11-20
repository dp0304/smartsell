import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { start } from '../../apps/server/src/bootstrap.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { operationRecords } from '../../apps/server/src/integration/operation-records.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { localStore } from '../../apps/server/src/local.ts';

const origin = 'http://localhost:5173';
const setupToken = 'workspace-acceptance-only';

async function fixture(t, name) {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-workspace-'));
  const statePath = join(dir, 'workspace.sqlite');
  const config = { ...configuration({ NODE_ENV: 'development', PUBLIC_ORIGIN: origin, SETUP_TOKEN: setupToken }), port: 0, statePath };
  let app, address, cookie, csrf, root, wid;
  async function boot() {
    app = await start(config);
    address = `http://127.0.0.1:${app.server.address().port}`;
  }
  t.after(async () => {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, { method = 'GET', body, headers, status = 200, auth = true } = {}) {
    const response = await fetch(`${address}${path}`, { method, headers: { origin, connection: 'close',
      ...(auth && cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body && JSON.stringify(body) });
    const raw = await response.text();
    if (status !== null) assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    return { response, json: raw ? JSON.parse(raw) : undefined };
  }
  await boot();
  const setup = await request('/api/v1/setup', { method: 'POST', status: 201, headers: { 'x-setup-token': setupToken }, body: {
    email: `${name}@example.invalid`, name, workspaceName: name, password: 'test-only-password-2026',
  } });
  cookie = setup.response.headers.get('set-cookie').split(';')[0];
  wid = setup.json.workspaces[0].id;
  root = `/api/v1/workspaces/${wid}`;
  csrf = (await request('/api/v1/session/csrf')).json.csrf_token;
  return { wid, request,
    async restart() { await app.close(); app = undefined; await boot(); },
    async op(path, options) { return (await request(root + path, options)).json?.data; },
    async write(path, body, options = {}) {
      return (await request(root + path, { method: 'POST', body, ...options,
        headers: { 'idempotency-key': randomUUID(), ...options.headers } })).json?.data;
    },
    async rpc(token, method, params, status = 200) {
      return (await request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: randomUUID(), method, params }, auth: false, status,
        headers: { accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) } })).json;
    },
    async inspect(run) {
      const store = localStore(statePath);
      const hash = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
      try { return await store.workspace(hash, wid, run); } finally { await store.close(); }
    },
  };
}

function tool(s, token, name, params, allowedError) {
  return s.rpc(token, 'tools/call', { name, arguments: { workspace_id: s.wid, ...params } }).then(packet => {
    const result = packet.result?.structuredContent;
    assert.ok(result, JSON.stringify(packet));
    if (allowedError) assert.equal(result.error?.code?.toUpperCase(), allowedError);
    else assert.ok(result.data, JSON.stringify(packet));
    return result.data;
  });
}

test('AI05 resumes the original operation after a server restart and confirms cancellation with the existing lease', async t => {
  const s = await fixture(t, 'job');
  const names = ['jobs_get', 'jobs_cancel', 'agent_jobs_claim', 'agent_jobs_confirm_cancel'];
  await s.rpc(undefined, 'tools/list', {}, 401);
  const { token, id: tokenId } = await s.write('/tokens', { access: 'write', tools: names }, { status: 201 });
  const initialize = () => s.rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'workspace-acceptance', version: '1' } });
  assert.ok((await initialize()).result.protocolVersion);
  const listed = await s.rpc(token, 'tools/list', {});
  assert.deepEqual(listed.result.tools.map(item => item.name).sort(), names.sort());
  const idempotency = { status: 202, headers: { 'idempotency-key': randomUUID() } };
  const body = { title: 'Investigate incomplete reports' };
  const created = await s.write('/agent-jobs', body, idempotency);
  const operation_id = created.operation_id;
  assert.equal(operation_id, created.id);
  const claimed = await tool(s, token, 'agent_jobs_claim', { agent_job_id: operation_id, expected_version: created.version });
  assert.equal(claimed.status, 'claimed');
  assert.equal((await tool(s, token, 'jobs_get', { operation_id })).status, 'claimed');
  await s.restart();
  assert.ok((await initialize()).result.protocolVersion);
  assert.equal((await s.write('/agent-jobs', body, idempotency)).operation_id, operation_id);
  const resumed = await tool(s, token, 'jobs_get', { operation_id });
  assert.deepEqual(resumed, { operation_id, status: 'claimed', version: claimed.version, cancel_requested_at: null });
  const requested = await tool(s, token, 'jobs_cancel', { operation_id, expected_version: resumed.version });
  assert.equal(requested.operation_id, operation_id);
  assert.equal(requested.status, 'claimed');
  assert.ok(requested.cancel_requested_at);
  const confirmed = await tool(s, token, 'agent_jobs_confirm_cancel', { agent_job_id: operation_id,
    expected_version: requested.version, fencing_token: claimed.fencing_token });
  assert.equal(confirmed.status, 'cancelled');
  const cancelled = await tool(s, token, 'jobs_get', { operation_id });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await s.op(`/operations/${operation_id}`), cancelled);
  assert.deepEqual(await tool(s, token, 'jobs_cancel', { operation_id, expected_version: cancelled.version }), cancelled);
  assert.deepEqual(await s.write(`/operations/${operation_id}/cancel`, {}, { headers: { 'if-match': String(cancelled.version) } }), cancelled);
  assert.deepEqual((await s.op('/agent-jobs')).map(row => row.id), [operation_id]);
  const final = await s.op(`/agent-jobs/${operation_id}`);
  for (const type of ['created', 'cancel_requested', 'cancelled']) assert.equal(final.events.filter(event => event.type === type).length, 1);
  assert.ok(final.events.every(event => event.actor_id === created.created_by));
  await s.request(`/api/v1/workspaces/${s.wid}/tokens/${tokenId}`, { method: 'DELETE', status: 204 });
  await s.rpc(token, 'tools/list', {}, 401);
});

test('AI04 holds an Agent handoff until a reviewer reconciles pending effects', async t => {
  const s = await fixture(t, 'handoff');
  const { token } = await s.write('/tokens', { access: 'write', tools: ['agent_jobs_claim', 'agent_jobs_handoff', 'jobs_get'] }, { status: 201 });
  const job = await s.write('/agent-jobs', { title: 'Verify supplier acknowledgement' }, { status: 202 });
  const claimed = await tool(s, token, 'agent_jobs_claim', { agent_job_id: job.id, expected_version: job.version });
  const handed = await tool(s, token, 'agent_jobs_handoff', { agent_job_id: job.id, expected_version: claimed.version,
    fencing_token: claimed.fencing_token, done_summary: 'Sent for manual verification', pending_side_effects: ['external-receipt'] });
  assert.equal(handed.status, 'lease_expired');
  const review = await s.op(`/agent-jobs/${job.id}`);
  assert.deepEqual(review.pending_side_effects, ['external-receipt']);
  assert.equal(review.handoff_summary, 'Sent for manual verification');
  assert.equal((await s.op(`/work-items/${job.work_item_id}`)).blocked_reason, 'verify_side_effects');
  await tool(s, token, 'agent_jobs_claim', { agent_job_id: job.id, expected_version: handed.version }, 'INVALID_STATE');
  const options = { headers: { 'if-match': String(handed.version) } };
  await s.write(`/agent-jobs/${job.id}/reconcile`, { note: 'Pending' }, { ...options, status: 409 });
  const reopened = await s.write(`/agent-jobs/${job.id}/reconcile`, { note: 'Receipt reviewed', verified_no_pending_side_effects: true }, options);
  assert.equal(reopened.status, 'open');
  assert.deepEqual(reopened.pending_side_effects, []);
  const history = (await s.op(`/agent-jobs/${job.id}`)).events;
  const handoff = history.find(event => event.type === 'handed_off');
  assert.equal(handoff.actor_id, job.created_by);
  assert.deepEqual(handoff.pending_side_effects, ['external-receipt']);
  assert.ok(history.some(event => event.type === 'reconciled' && event.note === 'Receipt reviewed'));
});

test('AI04 concurrent MCP claims yield one lease and require review after it expires', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const s = await fixture(t, 'lease-race');
  const names = ['agent_jobs_claim', 'agent_jobs_heartbeat', 'jobs_get'];
  const first = await s.write('/tokens', { access: 'write', tools: names }, { status: 201 });
  const second = await s.write('/tokens', { access: 'write', tools: names }, { status: 201 });
  const job = await s.write('/agent-jobs', { title: 'Check delayed approval' }, { status: 202 });
  const call = (token, name, params) => s.rpc(token, 'tools/call', { name, arguments: { workspace_id: s.wid, ...params } });
  const claims = await Promise.all([first, second].map(({ token }) => call(token, 'agent_jobs_claim', {
    agent_job_id: job.id, expected_version: job.version,
  })));
  const winnerIndex = claims.findIndex(packet => packet.result?.structuredContent?.data?.status === 'claimed');
  assert.notEqual(winnerIndex, -1);
  const { token: winner } = [first, second][winnerIndex];
  const { token: loser } = [first, second][1 - winnerIndex];
  const claim = claims[winnerIndex].result.structuredContent.data;
  assert.equal(claims[1 - winnerIndex].result.isError, true);
  const lease = { agent_job_id: job.id, expected_version: claim.version, fencing_token: claim.fencing_token };
  assert.equal((await call(loser, 'agent_jobs_heartbeat', lease)).result.isError, true);
  t.mock.timers.tick(120_001);
  assert.equal((await tool(s, winner, 'jobs_get', { operation_id: job.id })).status, 'lease_expired');
  assert.equal((await call(winner, 'agent_jobs_heartbeat', lease)).result.isError, true);
  const expired = await s.op(`/agent-jobs/${job.id}`);
  assert.equal(expired.events.filter(event => event.type === 'claimed').length, 1);
  assert.equal((await call(loser, 'agent_jobs_claim', { agent_job_id: job.id, expected_version: expired.version })).result.isError, true);
});

test('AI06 runs scheduled deterministic and Agent actions through the workspace scheduler', async t => {
  const s = await fixture(t, 'schedule');
  const definition = { name: 'Daily operations check', trigger: { type: 'schedule', every_minutes: 1 }, actions: [
    { type: 'create_work_item', title: 'Check report coverage' }, { type: 'create_agent_job', title: 'Summarize missing observations' },
  ] };
  const rule = await s.write('/automation-rules', definition);
  await s.op(`/automation-rules/${rule.id}`, { method: 'PATCH', body: { enabled: true }, headers: { 'if-match': String(rule.version) } });
  const { token } = await s.write('/tokens', { access: 'write', tools: ['agent_jobs_claim'] }, { status: 201 });
  await s.restart();
  const path = `/automation-rules/${rule.id}/runs`;
  let run;
  for (let i = 0; i < 50 && !run; i++) {
    [run] = await s.op(path);
    if (!run) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(run, 'Scheduler did not run');
  assert.match(run.trigger_key, /^schedule:\d+$/);
  assert.equal(run.waiting_reason, 'awaiting_agent_claim');
  const [item, job] = run.action_results;
  assert.equal((await s.op(`/work-items/${item.id}`)).title, definition.actions[0].title);
  const open = await s.op(`/agent-jobs/${job.id}`);
  assert.equal((await tool(s, token, 'agent_jobs_claim', { agent_job_id: job.id, expected_version: open.version })).status, 'claimed');
  assert.equal((await s.op(path)).find(row => row.id === run.id).status, 'acting');
  await s.restart();
  assert.equal((await s.op(path)).filter(row => row.trigger_key === run.trigger_key).length, 1);
});

test('TE06 applies a structural template across workspaces without transferring fixture records', async t => {
  const source = await fixture(t, 'source');
  const dest = await fixture(t, 'dest');
  const structures = [
    { name: 'Store launch', kind: 'workspace', defaults: { markets: ['Japan'], roles: ['editor', 'reviewer'] } },
    { name: 'Launch flow', kind: 'workflow', defaults: { stages: ['Draft'], milestones: ['Launch'], approval_policies: ['Launch review'] } },
    { name: 'Monthly report', kind: 'report', defaults: { report_sections: ['Reach'] } },
  ];
  const canaries = { connection: 'connection-canary', secret: 'secret-canary', customer: 'customer@example.invalid',
    rights_grant: 'rights-canary', publish_target: 'target-canary' };
  const contaminated = structure => ({ ...structure, ...canaries, defaults: { ...structure.defaults, ...canaries } });
  const templateFields = ({ name, kind, defaults }) => ({ name, kind, defaults });
  const templates = [];
  for (const structure of structures) {
    const saved = await source.write('/team/templates', contaminated(structure));
    assert.deepEqual(templateFields(saved), structure);
    for (const key of Object.keys(canaries)) assert.ok(!Object.hasOwn(saved, key));
    templates.push(saved);
  }
  await source.inspect(unit => unit.command({ module: 'acceptance', action: 'seed', key: randomUUID(), fingerprint: '' }, async () => {
    const fixtures = { connection: { provider: 'shopify', sealed_token: canaries.secret }, secret: { sealed_value: canaries.secret },
      customer: { email: canaries.customer }, rights_grant: { status: 'active' }, publish_target: { connection_id: canaries.connection } };
    for (const [kind, id] of Object.entries(canaries)) {
      const value = JSON.stringify({ id, version: 1, status: 'active', ...fixtures[kind] });
      await unit.context.insert('operation_runtime', 'record', { value }, `row/${kind}/${encodeURIComponent(id)}`);
    }
    // Simulate older template rows containing source data in both the envelope and defaults.
    for (const template of templates) {
      const stored = await unit.context.get('operation_runtime', 'record', `row/workspace_template/${template.id}`);
      const value = JSON.stringify(contaminated(JSON.parse(stored.data.value)));
      await unit.context.update('operation_runtime', 'record', stored.id, { value }, stored.version);
    }
  }));
  assert.deepEqual((await source.op('/connections')).map(row => row.id), [canaries.connection]);
  const listed = await source.op('/team/templates');
  assert.deepEqual(listed, templates.map(({ id, version, ...structure }) => ({ id, version, ...templateFields(structure) })));
  await dest.write('/team/templates', { ...structures[0], defaults: { roles: [{ role: 'admin', user_id: canaries.customer }] } }, { status: 422 });
  await dest.write('/team/templates', { ...structures[2], defaults: { report_sections: [{ title: 'Reach', customer: canaries.customer }] } }, { status: 422 });
  assert.deepEqual(await dest.op('/team/templates'), []);

  const applied = [];
  for (const [i, template] of templates.entries()) {
    await dest.op(`/team/templates/${template.id}/export`, { status: 404 });
    await dest.write(`/team/templates/${template.id}/apply`, {}, { status: 404 });
    const bundle = await source.op(`/team/templates/${template.id}/export`);
    assert.deepEqual(bundle, structures[i]);
    const local = await dest.write('/team/templates', bundle);
    assert.notEqual(local.id, template.id);
    const options = { headers: { 'idempotency-key': randomUUID() } };
    const application = await dest.write(`/team/templates/${local.id}/apply`, {}, options);
    assert.deepEqual(await dest.write(`/team/templates/${local.id}/apply`, {}, options), application);
    assert.deepEqual(templateFields(application.defaults), bundle);
    applied.push({ local, application });
  }
  await dest.restart();
  assert.equal((await dest.request('/api/v1/session')).json.workspaces[0].id, dest.wid);
  const applications = await dest.op('/team/templates/applications');
  const policies = await dest.op('/approval-policies');
  assert.equal(applications.length, 3);
  assert.deepEqual(policies.map(({ name, active }) => ({ name, active })), [{ name: 'Launch review', active: false }]);
  const { token } = await dest.write('/tokens', { access: 'read', tools: ['jobs_get'] }, { status: 201 });
  for (const { local, application } of applied) {
    const job = await tool(dest, token, 'jobs_get', { operation_id: application.operation_id });
    assert.equal(job.operation_id, application.operation_id);
    assert.equal(job.status, 'succeeded');
    const history = applications.find(row => row.operation_id === application.operation_id);
    assert.ok(history);
    assert.equal(history.template_id, local.id);
    assert.equal(history.template_version, local.version);
    assert.equal(history.target_workspace_id, dest.wid);
    assert.deepEqual(history.applied, application.defaults);
    assert.deepEqual(history.created_objects, { defaults_id: application.defaults.id,
      approval_policy_ids: local.kind === 'workflow' ? [policies[0].id] : [] });
  }
  assert.deepEqual(await dest.op('/connections'), []);
  assert.deepEqual(await dest.op('/customers'), []);
  assert.deepEqual((await source.op('/customers')).map(row => row.id), [canaries.customer]);
  assert.deepEqual(await source.op('/team/templates/applications'), []);
  await dest.inspect(async ({ context }) => {
    const stored = await context.list('operation_runtime', 'record');
    for (const row of stored) for (const [kind, value] of Object.entries(canaries)) {
      assert.ok(!row.id.startsWith(`row/${kind}/`));
      assert.ok(!JSON.stringify(row).includes(value));
    }
  });
});


test('shared business operations preserve the same resource, version and policy across Commands and REST', async t => {
  const s = await fixture(t, 'shared-business');
  const alias = (module, action) => `/commands/${module}/operation_${action}`;
  const command = (module, action, id, fields, options) => s.write(alias(module, action), { ...(id && { id }), fields }, options);
  const version = value => ({ 'if-match': String(value) });
  const brand = await s.write('/brands', { name: 'Shared Brand', slug: 'shared-brand' });
  const other = await s.write('/brands', { name: 'Other Brand', slug: 'other-brand' });
  const old = await s.write('/campaigns', { brand_id: brand.id, name: 'Existing campaign', kind: 'launch', timezone: 'UTC' });
  const legacy = await s.inspect(unit => unit.command({ module: 'campaign', action: 'seed_old', key: randomUUID(), fingerprint: '' },
    () => unit.context.insert('campaign', 'campaign', { name: 'Legacy campaign', brand_id: brand.id, status: 'draft' })));
  await s.restart();

  const readCampaign = id => command('campaign', 'campaign_get_context', id, {});
  assert.equal((await readCampaign(old.id)).id, old.id);
  const legacyRows = await s.request(`/api/v1/workspaces/${s.wid}/records/campaign/campaign`);
  assert.deepEqual(legacyRows.json.items.map(row => row.id), [legacy.id]);
  await s.op(`/campaigns/${legacy.id}`, { status: 404 });

  const campaignPath = `/campaigns/${old.id}`;
  const firstFields = { name: 'From Commands' };
  const key = randomUUID();
  const first = await command('campaign', 'campaign_update', old.id, firstFields,
    { headers: { ...version(old.version), 'idempotency-key': key } });
  assert.equal((await s.op(campaignPath)).name, firstFields.name);
  assert.deepEqual(await s.write(campaignPath, firstFields, { method: 'PATCH', headers: { ...version(old.version), 'idempotency-key': key } }), first);
  await s.write(campaignPath, { name: 'Different payload' }, { method: 'PATCH', status: 422, headers: { ...version(old.version), 'idempotency-key': key } });
  const headers = version(first.version);
  const root = `/api/v1/workspaces/${s.wid}`;
  const send = (path, method, body, extra) => s.request(root + path, { method, body, status: null, headers: { 'idempotency-key': randomUUID(), ...extra } });
  const outcomes = await Promise.all([
    send(campaignPath, 'PATCH', { name: 'From REST' }, headers),
    send(alias('campaign', 'campaign_update'), 'POST', { id: old.id, fields: { name: 'Concurrent Commands' } }, headers),
  ]);
  assert.deepEqual(outcomes.map(result => result.response.status).sort(), [200, 409]);
  const winner = outcomes.find(result => result.response.ok).json.data;
  assert.equal(winner.version, first.version + 1);
  const commandContext = await s.request(root + alias('campaign', 'campaign_get_context'), { method: 'POST', body: { id: old.id } });
  const restContext = await s.request(root + campaignPath);
  assert.deepEqual(commandContext.json.data, restContext.json.data);
  assert.equal(restContext.json.data.id, old.id);
  assert.equal(restContext.json.data.name, winner.name);
  assert.equal(restContext.json.data.version, winner.version);
  assert.equal(commandContext.response.headers.get('etag'), `"${winner.version}"`);
  assert.equal(restContext.response.headers.get('etag'), `"${winner.version}"`);

  await command('content', 'content_create_item', undefined, { brand_id: other.id, campaign_id: old.id, title: 'Wrong brand' }, { status: 422 });
  const { item } = await command('content', 'content_create_item', undefined, { brand_id: brand.id, campaign_id: old.id, title: 'Draft content' });
  assert.equal((await s.op(`/content-items/${item.id}`)).item.id, item.id);
  const edited = await s.write(`/content-items/${item.id}`, { title: 'Edited content' }, { method: 'PATCH', headers: version(item.version) });
  const contentRead = await s.request(root + alias('content', 'content_get'), { method: 'POST', body: { id: item.id } });
  assert.equal(contentRead.json.data.item.title, edited.title);
  assert.equal(contentRead.response.headers.get('etag'), `"${edited.version}"`);
  await command('content', 'content_item_update', item.id, { campaign_id: old.id }, { status: 422, headers: version(edited.version) });

  const fixtures = await s.inspect(unit => unit.command({ module: 'acceptance', action: 'seed_shared', key: randomUUID(), fingerprint: '' }, async () => {
    const { records, flush } = await operationRecords(unit.context, false);
    const ctx = makeContext(records, unit.context, unit.context.role);
    const account = ctx.create('social_account', { brand_id: brand.id, platform: 'facebook', status: 'active' });
    const variant = ctx.create('content_variant', { content_item_id: item.id, platform: 'facebook', format: 'text', locale: 'en' });
    const revision = ctx.create('content_revision', { variant_id: variant.id });
    const store = ctx.create('store', { brand_id: brand.id, status: 'import_only' });
    const conversation = ctx.create('conversation', { brand_id: brand.id });
    const otherConversation = ctx.create('conversation', { brand_id: other.id });
    await flush();
    return { account, variant, revision, store, conversation, otherConversation };
  }));
  const target = await s.write('/publish-targets', { social_account_id: fixtures.account.id, content_variant_id: fixtures.variant.id,
    variant_revision_id: fixtures.revision.id, scheduled_at: '2099-07-01T12:00:00Z' });
  const rescheduled = await command('planning', 'publishing_reschedule', target.id, { scheduled_at: '2099-07-02T12:00:00Z' }, { headers: version(target.version) });
  assert.equal((await s.op(`/publish-targets/${target.id}`)).scheduled_at, rescheduled.scheduled_at);
  const rescheduledAgain = await s.write(`/publish-targets/${target.id}/reschedule`, { scheduled_at: '2099-07-03T12:00:00Z' }, { headers: version(rescheduled.version) });
  assert.equal((await command('planning', 'publishing_get_target', target.id, {})).version, rescheduledAgain.version);

  const product = await s.write('/products', { store_id: fixtures.store.id, title: 'Shared product' });
  const productEdit = await command('commerce', 'commerce_product_update', product.id, { title: 'New product title' }, { headers: version(product.version) });
  assert.equal((await s.op(`/products/${product.id}`)).title, productEdit.title);
  const productBack = await s.write(`/products/${product.id}`, { handle: 'same-product' }, { method: 'PATCH', headers: version(productEdit.version) });
  assert.equal((await command('commerce', 'catalog_get_product', product.id, {})).version, productBack.version);

  const caseFields = { kind: 'product_issue', title: 'Shared case' };
  await command('inbox', 'inbox_create_case', undefined, { ...caseFields, conversation_ids: [fixtures.conversation.id, fixtures.otherConversation.id] }, { status: 422 });
  const entry = await command('inbox', 'inbox_create_case', undefined, { ...caseFields, conversation_ids: [fixtures.conversation.id] });
  const resolved = await s.write(`/cases/${entry.id}`, { status: 'resolved' }, { method: 'PATCH', headers: version(entry.version) });
  const closed = await command('inbox', 'inbox_update_case', entry.id, { status: 'closed' }, { headers: version(resolved.version) });
  assert.deepEqual((await s.op(`/cases/${entry.id}`)).case, closed);

  const task = await s.inspect(unit => unit.command({ module: 'acceptance', action: 'seed_unknown', key: randomUUID(), fingerprint: '' }, async () => {
    const { records, flush } = await operationRecords(unit.context, false);
    const ctx = makeContext(records, unit.context, unit.context.role);
    const task = ctx.create('execution_task', { status: 'outcome_unknown', publish_target_id: target.id, fencing_token: 1 });
    ctx.create('execution_attempt', { task_id: task.id, status: 'unknown', attempt_no: 1, executor: 'official', side_effect_possible: true });
    await flush();
    return task;
  }));
  const verifyPath = `/execution-tasks/${task.id}/reconcile`;
  await command('execution', 'publishing_reconcile', task.id, { outcome: 'published' }, { status: 422, headers: version(task.version) });
  const verification = await s.write(verifyPath, {}, { status: 202, headers: version(task.version) });
  const verificationAgain = await command('execution', 'publishing_reconcile', task.id, {}, { status: 202, headers: version(task.version) });
  assert.equal(verificationAgain.operation_id, verification.operation_id);
  const execution = await command('execution', 'publishing_get_execution', task.id, {});
  assert.equal(execution.verifications.length, 1);
  assert.equal(execution.attempts.length, 1);
  await s.inspect(async ({ context }) => {
    const { records } = await operationRecords(context, true);
    const events = records.list('outbox/');
    const campaignUpdates = events.filter(event => event.type === 'campaign.campaign.updated' && event.payload.campaign_id === old.id);
    assert.deepEqual(campaignUpdates.map(event => event.payload.version).sort((a, b) => a - b), [first.version, winner.version]);
    assert.equal(events.filter(event => event.type === 'execution.verification.requested' && event.payload.task_id === task.id).length, 1);
  });

  const reportFields = { title: 'Shared report', period: { from: '2025-01-01', to: '2025-01-03' }, sections: [{ key: 'notes', type: 'narrative' }] };
  const report = await command('analytics', 'reports_create', undefined, reportFields);
  const reportPath = `/reports/${report.id}`;
  const renamed = await s.write(reportPath, { title: 'REST report edit' }, { method: 'PATCH', headers: version(report.version) });
  assert.equal((await command('analytics', 'report_definition_get', report.id, {})).title, renamed.title);
  const archived = await command('analytics', 'reports_update', report.id, { status: 'archived' }, { headers: version(renamed.version) });
  assert.equal((await s.op(reportPath)).version, archived.version);
  const financial = await s.write('/reports', { ...reportFields, kind: 'ecommerce' });

  async function member(role) {
    const email = `shared-${role}@example.invalid`, password = 'test-only-password-2026';
    const invitation = await s.write('/members/invite', { email, role });
    await s.request('/api/v1/member-invitations/accept', { method: 'POST', auth: false, status: 204,
      body: { email, password, name: role, token: invitation.invitation_token } });
    const login = await s.request('/api/v1/session', { method: 'POST', auth: false, body: { email, password } });
    const cookie = login.response.headers.get('set-cookie').split(';')[0];
    const csrf = (await s.request('/api/v1/session/csrf', { headers: { cookie } })).json.csrf_token;
    return { cookie, 'x-csrf-token': csrf, 'idempotency-key': randomUUID() };
  }
  const viewer = await member('viewer');
  const editor = await member('editor');
  assert.equal((await s.op(campaignPath, { headers: viewer })).id, old.id);
  assert.equal((await command('campaign', 'campaign_get_context', old.id, {}, { headers: viewer })).id, old.id);
  await command('campaign', 'campaign_update', old.id, firstFields, { headers: { ...viewer, ...version(winner.version) }, status: 403 });
  await s.write(campaignPath, firstFields, { method: 'PATCH', headers: { ...viewer, ...version(winner.version) }, status: 403 });
  await s.write(`/reports/${financial.id}`, { title: 'Denied' }, { method: 'PATCH', headers: { ...editor, ...version(999) }, status: 403 });
  await command('analytics', 'reports_update', financial.id, { title: 'Denied' }, { headers: { ...editor, ...version(999) }, status: 403 });
  await command('campaign', 'campaign_update', old.id, firstFields, { headers: { ...version(winner.version), 'x-csrf-token': '' }, status: 403 });
  await s.request(`/api/v1/workspaces/${randomUUID()}${alias('campaign', 'campaign_get_context')}`, { method: 'POST', body: { id: old.id }, status: 404 });
  await s.request(`/api/v1/workspaces/${randomUUID()}${campaignPath}`, { status: 404 });

  const { token } = await s.write('/tokens', { access: 'read' }, { status: 201 });
  const tools = (await s.rpc(token, 'tools/list', {})).result.tools;
  assert.ok(tools.every(tool => !tool.name.startsWith('operation_') && tool.name !== 'publishing_reconcile'));
});
