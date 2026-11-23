import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createPeer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileStore } from '../../packages/db/src/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { createServer } from '../../apps/server/src/server.ts';
import { metaPauseDrain } from '../../apps/server/src/modules/ads/meta-pause.ts';
import { applyCampaignCostEvent } from '../../apps/server/src/modules/campaign/spend-operations.ts';
import { createFetchTransport } from '../../packages/adapters/src/fetch-transport.ts';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-ads-http-'));
  const store = await fileStore(join(dir, 'state.json'));
  const setupToken = 'ads-acceptance-token';
  const config = configuration({ SETUP_TOKEN: setupToken });
  // Keep provider I/O under the test-controlled drain, outside the API server's worker.
  const server = createServer({ config: { ...config, roles: new Set(['api']) }, store, ...await discoverOperations() });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const origin = await server.listen({ host: '127.0.0.1', port: 0 });
  const password = 'ads-acceptance-only-password';
  const email = 'ads-owner@example.invalid';
  async function request(path, { method = 'GET', data, headers, status = 200 } = {}) {
    const res = await fetch(origin + path, { method, body: data === undefined ? undefined : JSON.stringify(data), headers: {
      origin: config.origin, connection: 'close', ...(data !== undefined && { 'content-type': 'application/json' }), ...headers,
    } });
    const body = await res.json();
    assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(body)}`);
    return { body, headers: res.headers };
  }
  const session = ({ body, headers }) => ({ cookie: headers.get('set-cookie').split(';')[0], 'x-csrf-token': body.data.csrf_token });
  const setup = await request('/api/v1/setup', { method: 'POST', status: 201, headers: { 'x-setup-token': setupToken },
    data: { email, password, name: 'Ads owner', workspaceName: 'Ads acceptance' } });
  const { user, workspaces: [workspace] } = setup.body.data;
  const owner = session(setup);
  const inspect = fn => store.transaction({ identityWrite: true }, async tx => {
    const scope = { actorId: user.id, tenantId: tx.identity.get(`workspace/${workspace.id}`).tenantId, workspaceId: workspace.id };
    const records = await tx.workspace(scope);
    return fn(makeContext(records, scope, 'owner'), tx.identity, records);
  });
  const actorId = randomUUID();
  const editorEmail = 'ads-editor@example.invalid';
  await inspect((_ctx, identity) => {
    identity.put(`user/${actorId}`, { ...identity.get(`user/${user.id}`), id: actorId, email: editorEmail, name: 'Ads editor' });
    identity.put(`email/${editorEmail}`, actorId);
    identity.put(`member/${actorId}/${workspace.id}`, { userId: actorId, workspaceId: workspace.id, role: 'editor' });
  });
  const editor = session(await request('/api/v1/login', { method: 'POST', data: { email: editorEmail, password } }));
  const op = async (path, { method, data, headers = owner, status = 200, version, key = randomUUID() } = {}) => {
    const { body } = await request(`/api/v1/workspaces/${workspace.id}${path}`, { method: method ?? (data ? 'POST' : 'GET'), data, status,
      headers: { ...headers, 'idempotency-key': key, ...(version !== undefined && { 'if-match': String(version) }) } });
    return status < 400 ? body.data : body;
  };
  const account = async (name) => {
    const brand = await op('/brands', { data: { name, slug: name.toLowerCase() } });
    return op('/ad-accounts', { data: { brand_id: brand.id, provider: 'meta_ads', external_account_id: name, currency: 'USD', timezone: 'UTC' } });
  };
  const revision = { objective: 'sales', schedule: { starts_at: new Date(Date.now() + 86_400_000).toISOString(), ends_at: new Date(Date.now() + 172_800_000).toISOString() },
    budget: { type: 'daily', currency: 'USD', amount_minor: 100, cap_minor: 100 } };
  return { actorId, editor, inspect, op, account, revision };
}

test('AD01 workspace editor sees only granted accounts and grant revocation blocks replays', async t => {
  const { op, account, actorId, editor, revision } = await fixture(t);
  let north = await account('North');
  const south = await account('South');
  const seed = async account => {
    const { entity } = await op(`/ad-accounts/${account.id}/import`, { data: { source_ref: 'authorized-fixture', entity: {
      level: 'campaign', external_id: `${account.external_account_id}-campaign`, name: account.external_account_id,
    } } });
    return { ad_account_id: account.id, revision: { ...revision, change: { kind: 'pause', target_entity_id: entity.id } } };
  };
  const visibleDraft = await seed(north);
  const hiddenDraft = await seed(south);
  const hidden = await op('/ad-proposals', { data: hiddenDraft });
  const grant = (permissions, status) => op(`/ad-accounts/${north.id}`, { method: 'PATCH', data: { permissions }, version: north.version, status });
  await grant([{ actor_id: actorId, actions: ['read'], expires_at: '2000-01-01T00:00:00Z' }], 422);
  north = await grant([{ actor_id: actorId, actions: ['read'] }]);
  const [listed] = await op('/ad-accounts', { headers: editor });
  assert.equal(listed.id, north.id);
  assert.equal(Object.hasOwn(listed, 'permissions'), false);
  assert.deepEqual((await op('/ad-entities', { headers: editor })).map(row => row.ad_account_id), [north.id]);
  assert.deepEqual(await op('/ad-proposals', { headers: editor }), []);
  await op(`/ads/performance?ad_account_id=${south.id}`, { headers: editor, status: 404 });
  await op(`/ad-proposals/${hidden.id}`, { headers: editor, status: 404 });
  await op(`/ad-proposals/${hidden.id}/revisions`, { data: hiddenDraft.revision, headers: editor, version: 999, status: 404 });
  await op('/ad-proposals', { data: visibleDraft, headers: editor, status: 404 });
  north = await grant([{ actor_id: actorId, actions: ['read', 'draft'] }]);
  const key = randomUUID();
  const draft = await op('/ad-proposals', { data: visibleDraft, headers: editor, key });
  assert.deepEqual((await op('/ad-proposals', { headers: editor })).map(row => row.id), [draft.id]);
  await grant([]);
  assert.deepEqual(await op('/ad-accounts', { headers: editor }), []);
  await op('/ad-proposals', { data: visibleDraft, headers: editor, key, status: 404 });
});

test('AD02 concurrent report retries and late observations preserve spend, coverage and event counts', async t => {
  const { op, account, inspect } = await fixture(t);
  const ads = await account('Pacing');
  const campaign = await op('/campaigns', { data: { brand_id: ads.brand_id, name: 'Budget test', kind: 'launch', timezone: 'UTC' } });
  await op(`/campaigns/${campaign.id}/budget-lines`, { data: { category: 'ads', currency: 'USD', amount_minor: 100, fx_date: '2025-03-01' } });
  await op(`/campaigns/${campaign.id}/budget-lines`, { data: { category: 'ads', currency: 'EUR', amount_minor: 400, fx_date: '2025-03-01' } });
  const path = `/ad-accounts/${ads.id}/import`;
  const entity = { campaign_id: campaign.id, level: 'campaign', external_id: 'platform-campaign', name: 'Initial structure' };
  const day = '2025-03-01';
  const zeroDay = '2025-03-02';
  const spend = (value, date = day) => ({ metric_key: 'spend', date, value, availability: 'observed', definition: 'Native daily spend in cents' });
  const report = (source_ref, observed_at, observations, changes = {}) => ({ source_ref, entity: { ...entity, observed_at, ...changes }, observations });
  const first = report('initial-report', '2025-03-04T08:00:00Z', [spend(120)]);
  const key = randomUUID();
  const [initial, sameKey, newKey] = await Promise.all([
    op(path, { data: first, key }), op(path, { data: first, key }), op(path, { data: first }),
  ]);
  assert.deepEqual([sameKey, newKey].map(result => result.observations[0].id), [initial.observations[0].id, initial.observations[0].id]);
  const observationEvents = records => records.list('outbox/').filter(row => row.type === 'analytics.observations.recorded');
  const deliver = event => inspect(ctx => applyCampaignCostEvent(ctx, { type: event.type, data: event.payload }));
  const usdBudget = async () => (await op(`/campaigns/${campaign.id}/budget-summary`)).currencies.find(row => row.currency === 'USD');
  const initialEvent = await inspect((_ctx, _identity, records) => observationEvents(records)[0]);
  await deliver(initialEvent);
  assert.equal((await usdBudget()).actual_minor, 120);
  const correctedAt = '2025-03-04T10:00:00Z';
  const correction = report('corrected-report', correctedAt, [spend(150)], { name: 'Corrected structure' });
  const corrected = await op(path, { data: correction });
  const mixed = await op(path, { data: { ...correction, observations: [spend(150), spend(0, zeroDay)] } });
  assert.equal(mixed.observations[0].id, corrected.observations[0].id);
  const late = await op(path, { data: report('delayed-report', '2025-03-04T09:00:00Z', [spend(90)]) });
  assert.equal(late.entity.name, 'Corrected structure');
  await op(path, { data: correction });
  const { entity: group } = await op(path, { data: report('child-report', correctedAt, [spend(25)], {
    level: 'ad_group', external_id: 'platform-group', name: 'Child included in campaign total', parent_entity_id: initial.entity.id,
  }) });
  const { pacing, timezone } = await op(`/ads/performance?ad_account_id=${ads.id}&campaign_id=${campaign.id}&from=${day}&until=2025-03-03`);
  assert.equal(timezone, 'UTC');
  assert.deepEqual(pacing.find(row => row.currency === 'USD'), {
    currency: 'USD', actual_spend_minor: 150, budget_minor: 100, observed_pacing: 1.5,
    coverage_ratio: 2 / 3, unreported_days: 1, delayed: true, as_of: '2025-03-04T10:00:00.000Z',
  });
  assert.equal(pacing.find(row => row.currency === 'EUR').budget_minor, 400);
  assert.equal(pacing.find(row => row.currency === 'EUR').actual_spend_minor, null);
  const evidence = await inspect((ctx, _identity, records) => ({
    observationCount: ctx.list('metric_observation').filter(row => row.ad_account_id === ads.id).length,
    parentEvents: observationEvents(records).filter(row => row.payload.subject_id === initial.entity.id),
    childEvents: observationEvents(records).filter(row => row.payload.subject_id === group.id),
  }));
  assert.equal(evidence.observationCount, 5);
  assert.deepEqual(evidence.parentEvents.map(event => event.payload.count), [1, 1, 1, 1]);
  assert.deepEqual(evidence.childEvents.map(event => event.payload.count), [1]);
  assert.equal(newKey.entity.version, initial.entity.version);
  assert.equal(late.entity.version, corrected.entity.version);

  // Deliver in reverse emission order, then replay the already processed initial event again.
  for (const event of [...evidence.parentEvents].reverse().concat(evidence.childEvents, initialEvent)) await deliver(event);
  const ledger = await usdBudget();
  assert.equal(ledger.actual_minor, 150);
  assert.equal(ledger.overrun_minor, 50);
  const ledgerEvents = await inspect((_ctx, _identity, records) => records.list('outbox/').filter(row =>
    row.type === 'campaign.cost_entry.changed' && row.payload.campaign_id === campaign.id));
  assert.deepEqual(ledgerEvents.map(event => event.payload.action).sort(), ['created', 'created', 'updated']);
});

test('CR06 and AD03 creator material requires paid rights at selection and after approval', async t => {
  const { op, account, inspect, revision } = await fixture(t);
  const ads = await account('Creator');
  const { variant, grant } = await inspect(ctx => {
    const asset = ctx.create('asset', { brand_id: ads.brand_id, origin: 'creator_delivery' });
    const version = ctx.create('asset_version', { asset_id: asset.id });
    const rendition = ctx.create('asset_rendition', { asset_version_id: version.id });
    const creative = ctx.create('ad_creative', { brand_id: ads.brand_id, origin: 'asset', origin_ref: asset.id, status: 'draft' });
    const variant = ctx.create('ad_creative_variant', { creative_id: creative.id, rendition_ids: [rendition.id] });
    const grant = ctx.create('rights_grant', { brand_id: ads.brand_id, status: 'active' });
    const terms = ctx.create('rights_grant_revision', { rights_grant_id: grant.id, valid_from: ctx.now, usages: ['organic_social'] });
    ctx.update('rights_grant', grant.id, { current_revision_id: terms.id });
    ctx.create('rights_grant_asset', { rights_grant_id: grant.id, asset_id: asset.id, asset_version_id: version.id, version_scope: 'specific_version' });
    return { variant, grant };
  });
  const selection = { ad_account_id: ads.id, revision: { ...revision, market_ids: ['US'], creative_variant_ids: [variant.id] } };
  assert.equal((await op('/ad-proposals', { data: selection, status: 409 })).code, 'RIGHTS_UNAVAILABLE');
  assert.deepEqual(await op('/ad-proposals'), []);
  await inspect(ctx => {
    const terms = ctx.create('rights_grant_revision', { rights_grant_id: grant.id, valid_from: ctx.now, usages: ['paid_ads'] });
    ctx.update('rights_grant', grant.id, { current_revision_id: terms.id });
  });
  const draft = await op('/ad-proposals', { data: selection });
  const review = await op(`/ad-proposals/${draft.id}/submit-approval`, { version: draft.version, data: {} });
  const approved = await op(`/ad-proposals/${draft.id}/decide`, { version: review.version, data: { decision: 'approved' } });
  await inspect(ctx => ctx.update('rights_grant', grant.id, { status: 'revoked' }));
  assert.equal((await op(`/ad-proposals/${draft.id}/operations`, { version: approved.version, status: 409,
    data: { kind: 'create_external_draft', proposal_revision_id: draft.current_revision_id } })).code, 'RIGHTS_UNAVAILABLE');
  assert.equal((await op(`/ad-proposals/${draft.id}/manual-operations`, { version: approved.version, status: 409, data: {} })).code, 'RIGHTS_UNAVAILABLE');
  assert.deepEqual(await inspect(ctx => ctx.list('ad_operation')), []);
});

test('AD05 HTTP approval gates Meta pause and readback never repeats a write', async t => {
  const { op, inspect, revision } = await fixture(t);
  const brand = await op('/brands', { data: { name: 'Meta QA', slug: 'meta-qa' } });
  const encryptionKey = randomBytes(32);
  const connectionId = await inspect(ctx => {
    const connection = ctx.create('connection', { provider: 'meta_ads', purpose: 'ads', status: 'active', brand_id: brand.id,
      external_account_id: 'act_801', discovered_accounts: [{ externalAccountId: 'act_801' }] });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([ctx.tenantId, ctx.workspaceId, connection.id, connection.provider])));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ accessToken: 'loopback-token', scopes: ['ads_management'] })), cipher.final()]);
    ctx.update('connection', connection.id, { sealed_token: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url') });
    for (const key of ['ads_read', 'ads_write']) ctx.create('capability', { connection_id: connection.id, key, status: 'available' });
    return connection.id;
  });
  const account = await op('/ad-accounts', { data: { brand_id: brand.id, provider: 'meta_ads', external_account_id: 'act_801',
    connection_id: connectionId, currency: 'USD', timezone: 'UTC' } });

  const requests = [];
  const paused = new Set();
  const peer = createPeer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization });
    const id = req.url.split('?')[0].split('/').at(-1);
    if (req.method === 'POST' && id === '902') return res.destroy();
    res.setHeader('content-type', 'application/json');
    const status = paused.has(id) ? 'PAUSED' : 'ACTIVE';
    res.end(JSON.stringify(req.method === 'POST' ? { success: true } : {
      id, account_id: id === '903' ? '999' : '801', configured_status: status, effective_status: status,
    }));
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  t.after(() => { peer.closeAllConnections(); peer.close(); });
  const origin = `http://127.0.0.1:${peer.address().port}`;
  const transport = createFetchTransport({ origins: ['https://graph.facebook.com'], timeoutMs: 2_000,
    fetch: (url, init) => fetch(`${origin}${url.pathname}${url.search}`, init),
  });
  const drain = metaPauseDrain({ encryptionKey }, transport);
  const tick = () => drain(inspect);

  for (const [externalId, expected] of [['900', 'rejected'], ['901', 'accepted'], ['902', 'outcome_unknown'], ['903', 'blocked']]) {
    const { entity } = await op(`/ad-accounts/${account.id}/import`, { data: { source_ref: 'loopback-fixture',
      entity: { level: 'campaign', external_id: externalId, name: `Campaign ${externalId}` } } });
    const draft = await op('/ad-proposals', { data: { ad_account_id: account.id, revision: {
      ...revision, change: { kind: 'pause', target_entity_id: entity.id },
    } } });
    const proposalPath = `/ad-proposals/${draft.id}`;
    const execute = (proposal, status = 200) => op(`${proposalPath}/operations`, { version: proposal.version, status,
      data: { kind: 'pause', proposal_revision_id: draft.current_revision_id } });
    const before = requests.length;
    await execute(draft, 409);
    const review = await op(`${proposalPath}/submit-approval`, { data: {}, version: draft.version });
    assert.equal(review.status, 'in_review');
    await execute(review, 409);
    await tick();
    assert.equal(requests.length, before);
    const decided = await op(`${proposalPath}/decide`, { version: review.version,
      data: { decision: expected === 'rejected' ? 'rejected' : 'approved' } });
    if (expected === 'rejected') {
      assert.equal(decided.status, 'rejected');
      await execute(decided, 409);
      await tick();
      assert.equal(requests.length, before);
      continue;
    }
    const queued = await execute(decided);
    const operationPath = `/ad-operations/${queued.id}`;
    assert.equal(queued.status, 'queued');
    await tick();
    const receipt = await op(operationPath);
    assert.equal(receipt.status, expected);
    assert.equal((await execute(decided)).id, queued.id);
    if (expected === 'blocked') {
      assert.equal(receipt.blocked_reason, 'provider_target_unverified');
      assert.deepEqual(requests.slice(before).map(row => row.method), ['GET']);
      continue;
    }
    assert.equal(receipt.verified_state, undefined);
    await tick();
    const active = await op(operationPath);
    assert.equal(active.status, expected);
    assert.equal(active.effective_status, 'ACTIVE');
    paused.add(externalId);
    await op(`${operationPath}/reconcile`, { data: {}, version: active.version });
    await tick();
    const verified = await op(operationPath);
    assert.equal(verified.status, 'verified');
    assert.equal(verified.verified_state, 'paused');
    assert.equal(verified.configured_status, 'PAUSED');
    assert.equal(verified.effective_status, 'PAUSED');
    assert.equal((await execute(decided)).id, queued.id);
    await tick();
    assert.deepEqual(requests.slice(before).map(row => [row.method, row.url, row.body]), [
      ['GET', `/v25.0/${externalId}?fields=id,account_id,configured_status,effective_status`, ''],
      ['POST', `/v25.0/${externalId}`, 'status=PAUSED'],
      ['GET', `/v25.0/${externalId}?fields=id,account_id,configured_status,effective_status`, ''],
      ['GET', `/v25.0/${externalId}?fields=id,account_id,configured_status,effective_status`, ''],
    ]);
  }
  assert(requests.every(request => request.authorization === 'Bearer loopback-token'));
  assert.equal((await inspect(ctx => ctx.list('ad_operation'))).length, 3);
});
