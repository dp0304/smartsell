import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { start } from '../../apps/server/src/bootstrap.ts';
import { configuration } from '../../apps/server/src/config.ts';

const { Client } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('pg');
const requestUrl = process.env.SMARTSELL_AI04_PG_URL;
const backgroundUrl = process.env.SMARTSELL_AI04_PG_BACKGROUND_URL;
const inspectUrl = process.env.SMARTSELL_AI04_PG_INSPECT_URL;
const protocol = '2025-06-18';
const tools = ['agent_jobs_claim', 'agent_jobs_heartbeat', 'agent_jobs_confirm_cancel', 'jobs_get', 'jobs_cancel'];
const password = 'ai04-acceptance-only-2026';

async function until(read, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await read();
    if (predicate(result)) return result;
    await delay(1_000);
  } while (Date.now() < deadline);
  assert.fail(`Condition did not become true within ${timeoutMs} ms: ${JSON.stringify(result)}`);
}

test('AI04 PostgreSQL MCP draft claim race, expiry, reconciliation and zero unclaimed executions', {
  skip: !requestUrl && !backgroundUrl && !inspectUrl && 'Set the three SMARTSELL_AI04_PG_* URLs for a fresh local ai04_acceptance database',
  timeout: 260_000,
}, async t => {
  for (const value of [requestUrl, backgroundUrl, inspectUrl]) {
    const url = new URL(value);
    assert.equal(url.protocol, 'postgresql:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/ai04_acceptance');
  }
  const db = new Client({ connectionString: inspectUrl, options: '-c default_transaction_read_only=on' });
  await db.connect();
  t.after(() => db.end());
  const rows = async (sql, values) => (await db.query(sql, values)).rows;
  assert.deepEqual(await rows('SELECT count(*)::int AS users FROM ss.users'), [{ users: 0 }]);

  const modelCalls = [];
  const model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    modelCalls.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Local acceptance note' } }],
      usage: { prompt_tokens: 14, completion_tokens: 4 } }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => new Promise(resolve => model.close(resolve)));
  const endpoint = `http://127.0.0.1:${model.address().port}/v1`;

  const config = configuration({ NODE_ENV: 'test', ROLE: 'api,mcp,worker,scheduler', HOST: '127.0.0.1',
    DATABASE_URL: requestUrl, BACKGROUND_DATABASE_URL: backgroundUrl, SETUP_TOKEN: randomUUID(),
    IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
  let app, base;
  async function launch() {
    app = await start({ ...config, port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  t.after(async () => { if (app) await app.close(); });
  const original = { ...process.env };
  t.after(() => {
    for (const key of ['SMARTSELL_AGENT_MODELS', 'SMARTSELL_AGENT_MODEL_LOOPBACK', 'SMARTSELL_AGENT_SECRET_AI04']) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  process.env.SMARTSELL_AGENT_MODELS = '[]';
  await launch();

  async function request(method, path, { headers, body, status = 200 } = {}) {
    const response = await fetch(base + path, { method, headers: { origin: config.origin,
      connection: 'close', ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    return { headers: response.headers, json: raw ? JSON.parse(raw) : undefined };
  }
  const ownerEmail = 'ai04-owner@example.invalid';
  const adminEmail = 'ai04-admin@example.invalid';
  const setup = await request('POST', '/api/v1/setup', { status: 201, headers: { 'x-setup-token': config.setupToken },
    body: { email: ownerEmail, name: 'AI04 Owner', workspaceName: 'AI04 acceptance', password } });
  const workspace = setup.json.workspaces[0].id;
  const root = `/api/v1/workspaces/${workspace}`;
  async function login(email, role) {
    const { headers, json } = await request('POST', '/api/v1/login', { body: { email, password } });
    assert.equal(json.data.workspaces.find(row => row.id === workspace)?.role, role);
    const cookie = headers.get('set-cookie').split(';')[0];
    const { json: session } = await request('GET', '/api/v1/session/csrf', { headers: { cookie } });
    return { id: json.data.user.id, headers: { cookie, 'x-csrf-token': session.csrf_token } };
  }
  const owner = await login(ownerEmail, 'owner');
  async function rest(member, method, path, { body, version, status } = {}) {
    const { json } = await request(method, root + path, { status, body, headers: { ...member.headers,
      ...(method !== 'GET' && { 'idempotency-key': randomUUID() }),
      ...(version !== undefined && { 'if-match': String(version) }) } });
    return json?.data ?? json;
  }
  const invitation = await rest(owner, 'POST', '/members/invite', { body: { email: adminEmail, role: 'admin' } });
  await request('POST', '/api/v1/member-invitations/accept', { status: 204,
    body: { token: invitation.invitation_token, email: adminEmail, name: 'AI04 Admin', password } });
  const admin = await login(adminEmail, 'admin');
  assert.notEqual(owner.id, admin.id);
  const [{ tenant_id: tenantId }] = await rows('SELECT tenant_id FROM ss.workspaces WHERE id = $1', [workspace]);

  // Bind a real loopback model route with a synthetic credential, then restart the app to load it.
  await app.close();
  app = undefined;
  process.env.SMARTSELL_AGENT_MODEL_LOOPBACK = '1';
  process.env.SMARTSELL_AGENT_SECRET_AI04 = 'ai04-local-fixture-only';
  process.env.SMARTSELL_AGENT_MODELS = JSON.stringify([{ tenantId, workspaceId: workspace, secretId: 'ai04-model',
    endpoint: `${endpoint}/`, protocol: 'openai_chat', secretEnv: 'SMARTSELL_AGENT_SECRET_AI04' }]);
  await launch();
  const provider = await rest(owner, 'POST', '/model-providers', { body: { name: 'AI04 loopback', kind: 'openai_compatible',
    endpoint: `${endpoint}/`, secret_id: 'ai04-model', allowed_data_classes: ['internal'], confirm_egress: true } });
  await rest(owner, 'PATCH', `/model-providers/${provider.id}`, { version: provider.version, body: { status: 'active' } });
  await rest(owner, 'POST', '/model-routes', { body: { purpose: 'plan', provider_id: provider.id, model: 'ai04-local', enabled: true } });

  async function rpc(token, method, params) {
    const id = randomUUID();
    const { json } = await request('POST', '/mcp', { headers: { authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol }, body: { jsonrpc: '2.0', id, method, params } });
    assert.equal(json.id, id);
    assert.ok(json.result, JSON.stringify(json));
    return json.result;
  }
  for (const member of [owner, admin]) {
    const issued = await rest(member, 'POST', '/tokens', { status: 201, body: { access: 'write', tools } });
    member.token = issued.token;
    member.credentialId = issued.id;
    const initialized = await rpc(member.token, 'initialize', { protocolVersion: protocol,
      capabilities: {}, clientInfo: { name: 'ai04-postgres-acceptance', version: '1' } });
    assert.equal(initialized.protocolVersion, protocol);
    const listed = await rpc(member.token, 'tools/list', {});
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...tools].sort());
  }
  assert.notEqual(owner.token, admin.token);

  const requestRole = new Client({ connectionString: requestUrl });
  await requestRole.connect();
  try {
    await assert.rejects(requestRole.query('SELECT * FROM ss.operation_active_pat_holders($1,$2)', [tenantId, workspace]),
      { code: '42501' });
  } finally { await requestRole.end(); }
  const backgroundRole = new Client({ connectionString: backgroundUrl });
  await backgroundRole.connect();
  try {
    const holders = (tenant, workspaceId) => backgroundRole.query('SELECT * FROM ss.operation_active_pat_holders($1,$2) ORDER BY id',
      [tenant, workspaceId]).then(result => result.rows);
    assert.deepEqual(await holders(tenantId, workspace), []);
    await backgroundRole.query('BEGIN');
    await backgroundRole.query('SELECT * FROM ss.lock_operation_workspace($1)', [workspace]);
    assert.deepEqual(await holders(tenantId, workspace), [owner, admin]
      .map(member => ({ id: member.credentialId, actorId: member.id })).sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(await holders(randomUUID(), workspace), []);
    assert.deepEqual(await holders(tenantId, randomUUID()), []);
    const rawCredentials = await backgroundRole.query("SELECT id FROM ss.entities WHERE module='mcp_runtime' AND kind='credential'");
    assert.deepEqual(rawCredentials.rows, []);
    await backgroundRole.query('ROLLBACK');
    assert.deepEqual(await holders(tenantId, workspace), []);
  } finally { await backgroundRole.end(); }

  function call(member, name, args) {
    return rpc(member.token, 'tools/call', { name, arguments: { workspace_id: workspace, ...args } });
  }
  function success(result) {
    assert.equal(result.isError ?? false, false, JSON.stringify(result));
    assert.ok(result.structuredContent?.data, JSON.stringify(result));
    return result.structuredContent.data;
  }
  function failure(result, code) {
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent?.error?.code?.toUpperCase(), code, JSON.stringify(result));
    return code;
  }
  const createDraft = title => rest(owner, 'POST', '/agent-jobs', { status: 202,
    body: { kind: 'draft', title, expected_output: { type: 'note' } } });
  await t.test('AI05 recovers a 202 Agent operation and observes progress and cancellation over MCP', async () => {
    const body = { kind: 'draft', title: 'Track local progress', expected_output: { type: 'note' } };
    const headers = { ...owner.headers, 'idempotency-key': randomUUID() };
    const create = async () => (await request('POST', `${root}/agent-jobs`, { status: 202, headers, body })).json.data;
    const created = await create();
    const operation_id = created.operation_id;
    assert.equal(operation_id, created.id);
    const claimed = success(await call(owner, 'agent_jobs_claim', { agent_job_id: operation_id, expected_version: created.version }));
    await app.close();
    app = undefined;
    await launch();
    assert.equal((await create()).operation_id, operation_id);
    const id = randomUUID();
    const response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'jobs_get',
        arguments: { workspace_id: workspace, operation_id }, _meta: { progressToken: 'acceptance-progress' } } }) });
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    assert.match(response.headers.get('content-type'), /^text\/event-stream\b/);
    const [progress, result] = raw.trim().split('\n\n').map(frame => JSON.parse(frame.split('\n')[1].slice('data: '.length)));
    assert.deepEqual(progress, { jsonrpc: '2.0', method: 'notifications/progress', params: {
      progressToken: 'acceptance-progress', progress: claimed.version, message: 'claimed',
    } });
    assert.equal(result.id, id);
    const resumed = success(result.result);
    assert.deepEqual(resumed, { operation_id, status: 'claimed', version: claimed.version, cancel_requested_at: null });
    const requested = success(await call(owner, 'jobs_cancel', { operation_id, expected_version: resumed.version }));
    assert.equal(requested.status, 'claimed');
    assert.ok(requested.cancel_requested_at);
    const cancel = { agent_job_id: operation_id, expected_version: requested.version, fencing_token: claimed.fencing_token };
    const confirmed = success(await call(owner, 'agent_jobs_confirm_cancel', cancel));
    assert.equal(confirmed.status, 'cancelled');
    assert.equal(success(await call(owner, 'jobs_get', { operation_id })).status, 'cancelled');
    assert.deepEqual((await rest(owner, 'GET', '/agent-jobs')).map(row => row.id), [operation_id]);
    const history = await rest(owner, 'GET', `/agent-jobs/${operation_id}`);
    for (const type of ['created', 'cancel_requested', 'cancelled']) assert.equal(history.events.filter(event => event.type === type).length, 1);
  });
  const draft = await createDraft('Draft a short status update');
  const untouched = await createDraft('Draft a short launch reminder');
  const jobPath = `/agent-jobs/${draft.id}`;
  const job = () => rest(owner, 'GET', jobPath);
  const work = () => rest(owner, 'GET', `/work-items/${draft.work_item_id}`);
  const get = async member => success(await call(member, 'jobs_get', { operation_id: draft.id }));
  const claim = (member, expected_version) => call(member, 'agent_jobs_claim', { agent_job_id: draft.id, expected_version });
  const beat = (member, expected_version, fencing_token) => call(member, 'agent_jobs_heartbeat', {
    agent_job_id: draft.id, expected_version, fencing_token,
  });
  assert.equal(draft.operation_id, draft.id);
  assert.equal(draft.status, 'open');
  assert.equal(draft.fencing_token, 0);
  assert.equal((await get(admin)).version, draft.version);
  assert.equal((await work()).status, 'open');
  assert.deepEqual(modelCalls, []);

  const members = [owner, admin];
  const results = await Promise.all(members.map(member => claim(member, draft.version)));
  const winners = results.flatMap((result, i) => result.isError ? [] : [i]);
  assert.equal(winners.length, 1, JSON.stringify(results));
  const winnerIndex = winners[0];
  const winner = members[winnerIndex];
  const loser = members[1 - winnerIndex];
  const claimed = success(results[winnerIndex]);
  const raceError = failure(results[1 - winnerIndex], 'VERSION_CONFLICT');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.version, draft.version + 1);
  assert.equal(claimed.fencing_token, 1);
  assert.equal((await job()).lease_owner_id, winner.id);
  const wrongOwner = failure(await beat(loser, claimed.version, claimed.fencing_token), 'LEASE_LOST');
  const renewed = success(await beat(winner, claimed.version, claimed.fencing_token));
  assert.equal(renewed.status, 'in_progress');
  assert.equal(renewed.fencing_token, claimed.fencing_token);
  const expiresAt = Date.parse(renewed.lease_expires_at);
  assert.ok(expiresAt > Date.now());
  t.diagnostic(`race=${winner === owner ? 'owner' : 'admin'}:${claimed.status}/v${claimed.version}/fence=${claimed.fencing_token}, other:${raceError}; foreign heartbeat=${wrongOwner}; lease expires=${renewed.lease_expires_at}`);

  // Inspect persisted state because the API also projects expiry before maintenance writes it.
  const [{ started }] = await rows('SELECT clock_timestamp() AS started');
  const readLease = async () => {
    const [{ now, job: persisted }] = await rows(`SELECT clock_timestamp() AS now, (data->>'value')::jsonb AS job
      FROM ss.entities WHERE tenant_id=$1 AND workspace_id=$2 AND module='operation_runtime' AND kind='record' AND id=$3`,
      [tenantId, workspace, `row/agent_job/${draft.id}`]);
    if (now.getTime() < expiresAt) {
      assert.equal(persisted.status, 'in_progress', 'Maintenance released a valid PAT lease before its deadline');
      assert.equal(persisted.lease_expires_at, renewed.lease_expires_at);
      assert.equal(persisted.version, renewed.version);
    }
    assert.equal(persisted.lease_owner_id, winner.id);
    return persisted;
  };
  const readSchedule = async () => Number((await rows(`SELECT data->>'value' AS ran_at FROM ss.entities
    WHERE tenant_id=$1 AND workspace_id=$2 AND module='operation_runtime' AND kind='record' AND id='schedule/agent.leases-and-approvals'`,
    [tenantId, workspace]))[0]?.ran_at);
  await until(async () => {
    const scheduledAt = await readSchedule();
    await readLease();
    return scheduledAt;
  }, time => time >= started.getTime(), 70_000);
  assert.ok(Date.now() < expiresAt, 'Maintenance must run while the lease is active');
  t.diagnostic('worker and scheduler ran from startup; a maintenance cycle preserved the active PAT lease');
  const persistedExpiry = await until(readLease, row => row.status === 'lease_expired' && row.lease_expires_at === null,
    expiresAt - Date.now() + 70_000);
  assert.ok(Date.now() >= expiresAt);
  const expired = await job();
  assert.equal(expired.version, persistedExpiry.version);
  const expiredWork = await work();
  assert.equal(expiredWork.status, 'blocked');
  assert.equal(expiredWork.blocked_reason, 'verify_side_effects');
  assert.equal(expired.status, 'lease_expired');
  assert.equal(expired.lease_expires_at, null);
  assert.deepEqual(expired.pending_side_effects, []);
  assert.equal(expired.fencing_token, 1);
  assert.equal((await get(loser)).status, 'lease_expired');
  assert.equal((await get(loser)).version, expired.version);
  const expiredHeartbeat = failure(await beat(winner, expired.version, claimed.fencing_token), 'INVALID_STATE');
  const expiredClaim = failure(await claim(loser, expired.version), 'INVALID_STATE');
  assert.equal((await job()).lease_owner_id, winner.id);
  assert.equal(expired.events.filter(event => event.type === 'claimed').length, 1);
  const expiryEvents = expired.events.filter(event => event.type === 'lease_expired');
  assert.equal(expiryEvents.length, 1);
  assert.ok(Date.parse(expiryEvents[0].occurred_at) >= expiresAt);

  const reconcile = (body, status) => rest(owner, 'POST', `${jobPath}/reconcile`, { version: expired.version, body, status });
  const denied = await reconcile({ note: 'Review still pending' }, 409);
  assert.equal(denied.code ?? denied.error?.code, 'INVALID_STATE');
  const note = 'Reviewed job history and confirmed no pending side effects';
  const reopened = await reconcile({ note, verified_no_pending_side_effects: true });
  assert.equal(reopened.id, draft.id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.assignee_id, null);
  assert.equal(reopened.lease_owner_id, null);
  assert.equal((await work()).status, 'open');
  const reclaimed = success(await claim(loser, reopened.version));
  assert.equal(reclaimed.status, 'claimed');
  assert.equal(reclaimed.fencing_token, 2);
  const staleFence = failure(await beat(loser, reclaimed.version, claimed.fencing_token), 'LEASE_LOST');
  const final = await job();
  assert.equal(final.lease_owner_id, loser.id);
  assert.deepEqual(final.events.filter(event => event.type === 'claimed').map(event => event.actor_id).sort(), [owner.id, admin.id].sort());
  const reviews = final.events.filter(event => event.type === 'reconciled');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].actor_id, owner.id);
  assert.equal(reviews[0].note, note);
  t.diagnostic(`expiry=${expired.status}/v${expired.version}, work=${expiredWork.status}/${expiredWork.blocked_reason}, expired heartbeat=${expiredHeartbeat}, claim before review=${expiredClaim}; reconcile=409 then ${reopened.status}/v${reopened.version}; reclaim=${reclaimed.status}/v${reclaimed.version}/fence=${reclaimed.fencing_token}, old fence=${staleFence}`);

  const stillOpen = await rest(owner, 'GET', `/agent-jobs/${untouched.id}`);
  assert.equal(stillOpen.status, 'open');
  assert.equal(stillOpen.version, untouched.version);
  assert.equal(stillOpen.assignee_id, null);
  assert.equal(stillOpen.fencing_token, 0);
  assert.deepEqual(stillOpen.events.map(event => event.type), ['created']);
  assert.deepEqual(await rest(owner, 'GET', '/ai-usage'), []);
  assert.equal(modelCalls.length, 0);
  t.diagnostic('unclaimed draft: open, fence=0, history=created; model HTTP calls=0, AI usage rows=0');

  // The same observer must detect a normal, explicitly requested run.
  const control = await createDraft('Draft a positive-control note');
  const submitted = await rest(owner, 'POST', `/agent-jobs/${control.id}/run`, { body: {}, version: control.version });
  assert.equal(submitted.status, 'submitted');
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].path, '/v1/chat/completions');
  assert.equal(modelCalls[0].body.model, 'ai04-local');
  const usage = await rest(owner, 'GET', '/ai-usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].agent_job_id, control.id);
  t.diagnostic('explicit run control: submitted, model HTTP calls=1, AI usage rows=1');

  await rest(loser, 'DELETE', `/tokens/${loser.credentialId}`, { status: 204 });
  await request('POST', '/mcp', { status: 401, headers: { authorization: `Bearer ${loser.token}`,
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol },
    body: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: {} } });
  const revoked = await until(job, row => row.status === 'lease_expired' && row.lease_expires_at === null, 70_000);
  const revocationEvents = revoked.events.filter(event => event.type === 'lease_expired');
  assert.equal(revocationEvents.length, 2);
  assert.ok(Date.parse(revocationEvents[1].occurred_at) < Date.parse(reclaimed.lease_expires_at));
  assert.equal(revoked.lease_owner_id, loser.id);
  assert.equal((await get(winner)).version, revoked.version);
  t.diagnostic(`revoked PAT: MCP returns 401, maintenance releases fence=${revoked.fencing_token} before its deadline, other PAT remains active`);
});
