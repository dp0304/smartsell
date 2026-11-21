import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { MemoryStore } from '../../apps/server/src/memory.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { discover } from '../../apps/server/src/registry.ts';
import { createServer } from '../../apps/server/src/server.ts';
import { fileStore } from '../../packages/db/src/index.ts';

const origin = 'http://127.0.0.1:3401';
const now = '2026-11-19T12:00:00.000Z';
const liveAt = '2026-11-20T12:00:00.000Z';
const reuseAt = '2026-11-21T12:00:00.000Z';

test.beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Creator workflow must not contact an external provider'));
});

async function fixture(t) {
  const store = new MemoryStore();
  const { registry } = await discover();
  assert.ok(registry.has('creator'));
  const { app } = buildApp({ registry, store, origin, setupToken: 'creator-acceptance-setup', secureCookie: false, origins: new Set([origin]), secret: '1a'.repeat(32) });
  t.after(() => app.close());
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { origin, 'x-setup-token': 'creator-acceptance-setup' }, payload: {
    email: 'creator-acceptance@example.invalid', name: 'Creator manager', workspaceName: 'Creator acceptance', password: 'acceptance-fixture-only-2026',
  } });
  assert.ok([200, 201].includes(setup.statusCode), setup.body);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const wid = setup.json().workspaces[0].id;
  const sessionHash = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  const command = (action, payload) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${wid}/commands/creator/${action}`, payload,
    headers: { origin, cookie, 'idempotency-key': randomUUID() } });
  const run = async (action, payload = {}) => {
    const reply = await command(action, payload);
    assert.equal(reply.statusCode, 200, reply.body);
    return reply.json().data;
  };
  const reject = async (action, payload, status, code) => {
    const reply = await command(action, payload);
    assert.equal(reply.statusCode, status, reply.body);
    assert.equal(reply.json().error.code, code);
  };
  const transact = fn => store.workspace(sessionHash, wid, unit => unit.command({ module: 'acceptance', action: 'seed', key: randomUUID(), fingerprint: '' }, () => fn(unit.context)));
  const advertised = async () => (await app.inject({ method: 'GET', url: `/api/v1/workspaces/${wid}/commands`, headers: { origin, cookie } })).json().items;
  return { run, reject, transact, advertised };
}

async function createCollaboration(s) {
  const campaign = await s.transact(ctx => ctx.insert('campaign', 'campaign', { brand_id: 'test-brand' }));
  const creator = await s.run('creators_create', { display_name: 'Mia' });
  const collaboration = await s.run('collaborations_create', { creator_id: creator.id, campaign_id: campaign.id, type: 'gifted' });
  return { campaign, creator, collaboration };
}

test('CR01 same nickname keeps two profiles and each observation carries its source and time', async t => {
  const s = await fixture(t);
  const first = await s.run('creators_create', { display_name: 'Mia' });
  const second = await s.run('creators_create', { display_name: 'Mia' });
  assert.notEqual(first.id, second.id);
  const firstAccount = await s.run('creators_link_account', { creator_id: first.id, provider: 'tiktok', handle: 'mia', external_account_id: 'user-one', profile_url: 'https://example.invalid/mia' });
  assert.equal(firstAccount.verification_level, 'self_reported');
  const secondAccount = await s.run('creators_link_account', { creator_id: second.id, provider: 'tiktok', handle: 'mia', external_account_id: 'user-two' });
  await s.reject('creators_link_account', { creator_id: second.id, provider: 'tiktok', handle: 'mia-again', external_account_id: 'user-one' }, 409, 'DUPLICATE_ACCOUNT');

  const write = { creator_id: first.id, expected_version: first.version, market: 'TW', share_bps: 0 };
  await s.reject('creators_record_audience', { ...write, observed_at: now }, 422, 'INVALID_INPUT');
  await s.reject('creators_record_audience', { ...write, source_kind: 'manual' }, 422, 'INVALID_INPUT');
  const firstObserved = await s.run('creators_record_audience', { ...write, source_kind: 'manual', observed_at: '2026-11-18T12:00:00+08:00' });
  await s.reject('creators_record_audience', { ...write, source_kind: 'manual', observed_at: now }, 409, 'version_conflict');
  await s.run('creators_record_audience', { ...write, expected_version: firstObserved.version, market: 'JP', share_bps: 2550, source_kind: 'public', source_ref: 'public audience export', observed_at: now });
  const searched = await s.run('creators_search', { q: 'mia' });
  assert.deepEqual(new Set(searched.map(row => row.id)), new Set([first.id, second.id]));
  const a = await s.run('creators_get', { creator_id: first.id });
  const b = await s.run('creators_get', { creator_id: second.id });
  assert.deepEqual(a.accounts.map(row => row.id), [firstAccount.id]);
  assert.deepEqual(b.accounts.map(row => row.id), [secondAccount.id]);
  assert.deepEqual(a.creator.audience_markets, [
    { market: 'TW', share_bps: 0, source_kind: 'manual', observed_at: '2026-11-18T04:00:00.000Z' },
    { market: 'JP', share_bps: 2550, source_kind: 'public', source_ref: 'public audience export', observed_at: now },
  ]);
  assert.deepEqual(b.creator.audience_markets, []);
  const verification = { creator_account_id: firstAccount.id, expected_version: firstAccount.version, source_ref: 'https://example.invalid/mia', verification_note: 'Matched the public profile and account ID' };
  await s.reject('creators_verify_account', { ...verification, source_ref: undefined }, 422, 'INVALID_INPUT');
  const verified = await s.run('creators_verify_account', verification);
  assert.equal(verified.verification_level, 'manually_verified');
  assert.equal(verified.verification_ref, verification.source_ref);
  assert.equal(verified.verified_at, now);
  assert.ok(verified.verified_by);
  assert.equal((await s.run('creators_get', { creator_id: first.id })).creator.last_verified_at, now);
  assert.equal((await s.run('creators_get', { creator_id: second.id })).accounts[0].verification_level, 'self_reported');
});

test('CR01 imports contacts only into the selected profile and reverses evidenced duplicate associations', async t => {
  const s = await fixture(t);
  const a = await s.run('creators_create', { display_name: 'Same name' });
  const b = await s.run('creators_create', { display_name: 'Same name' });
  const proof = await s.transact(ctx => ctx.insert('core', 'evidence', { note: 'Creator confirmed both accounts' }));
  const contact = { creator_id: a.id, source_ref: 'Creator supplied list', csv: 'channel,value\r\nemail,mia@example.invalid\r\nother,"Agent, EU"' };
  await s.reject('creators_import_contacts', { ...contact, csv: `${contact.csv}\nemail,invalid` }, 422, 'INVALID_INPUT');
  assert.deepEqual(await s.run('creators_list_contacts', { creator_id: a.id }), []);
  assert.deepEqual(await s.run('creators_import_contacts', contact), { added: 2, duplicates: 0 });
  assert.deepEqual(await s.run('creators_import_contacts', contact), { added: 0, duplicates: 2 });
  const link = { creator_id: a.id, related_creator_id: b.id, reason: 'Both profiles confirmed' };
  await s.reject('creators_associate_profiles', { ...link, evidence_ids: [] }, 422, 'INVALID_INPUT');
  const association = await s.run('creators_associate_profiles', { ...link, evidence_ids: [proof.id] });
  assert.ok(association.created_by);
  assert.equal((await s.run('creators_list_associations', { creator_id: b.id }))[0].id, association.id);
  assert.deepEqual(await s.run('creators_list_contacts', { creator_id: b.id }), []);
  const request = { creator_association_id: association.id, expected_version: association.version, reason: 'Corrected evidence' };
  const revoked = await s.run('creators_revoke_association', request);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revoked_at, now);
  assert.equal(revoked.revoked_by, association.created_by);
  assert.deepEqual(revoked.evidence_ids, [proof.id]);
  assert.equal((await s.run('creators_list_associations', { creator_id: a.id }))[0].revoked_reason, request.reason);
  assert.equal((await s.run('creators_list_contacts', { creator_id: a.id })).length, 2);
  assert.equal((await s.run('creators_get', { creator_id: a.id })).contacts, undefined);
});

test('CR02 records genuine zero, missing dimensions and an immutable human override audit', async t => {
  const s = await fixture(t);
  const { campaign, creator } = await createCollaboration(s);
  const evidence = await s.transact(ctx => ctx.insert('core', 'evidence', { note: 'Source evidence' }));
  const [original] = await s.run('creators_evaluate', { campaign_id: campaign.id, creator_id: creator.id, decision: 'shortlist', reason: 'Initial assessment',
    ai_generated: true, scores: { brand_fit: { score: 80, evidence_refs: [evidence.id] }, cost_fit: { score: 0, evidence_refs: [evidence.id] } } });
  assert.equal(original.ai_generated, false);
  assert.equal(original.scores.market_fit.score, null);
  assert.equal(original.scores.cost_fit.score, 0);
  const write = { evaluation_id: original.id, expected_version: original.version, dimension: 'brand_fit', score: 65, decision: 'hold', reason: 'Manually verified a mismatch' };
  await s.reject('creators_override_evaluation', write, 422, 'INVALID_INPUT');
  const updated = await s.run('creators_override_evaluation', { ...write, evidence_refs: [evidence.id] });
  await s.reject('creators_override_evaluation', { ...write, evidence_refs: [evidence.id] }, 409, 'version_conflict');
  await s.run('creators_override_evaluation', { evaluation_id: original.id, expected_version: updated.version, decision: 'exclude', reason: 'Decision review' });
  const [read] = await s.run('creators_list_evaluations', { campaign_id: campaign.id });
  assert.equal(read.original.scores.brand_fit.score, 80);
  assert.equal(read.scores.brand_fit.score, 65);
  assert.equal(read.scores.market_fit.score, null);
  assert.equal(read.decision, 'exclude');
  assert.deepEqual(read.overrides.map(row => [row.before.decision, row.after.decision, row.reason, row.created_by, row.overridden_at]), [
    ['shortlist', 'hold', write.reason, original.created_by, now], ['hold', 'exclude', 'Decision review', original.created_by, now],
  ]);
});

test('CR02 preserves a delegated Agent evaluation through an interactive score override on kernel REST', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-creator-evaluation-'));
  const store = await fileStore(join(directory, 'state.json'));
  const { operations } = await discoverOperations();
  const setupToken = 'creator-evaluation-setup';
  const app = createServer({ config: configuration({ SETUP_TOKEN: setupToken, HOST: '127.0.0.1', ROLE: 'all' }), store, operations });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const password = 'acceptance-fixture-only-2026';
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': setupToken }, payload: {
    email: 'creator-evaluation@example.invalid', name: 'Agent credential issuer', workspaceName: 'Creator evaluation', password,
  } });
  assert.equal(setup.statusCode, 201, setup.body);
  const { user, workspaces: [workspace], csrf_token } = setup.json().data;
  const session = { cookie: String(setup.headers['set-cookie']).split(';')[0], 'x-csrf-token': csrf_token };
  async function rest(method, path, payload, { headers = session, version, status = 200 } = {}) {
    const reply = await app.inject({ method, url: `/api/v1/workspaces/${workspace.id}${path}`, payload,
      headers: { ...headers, ...(version && { 'if-match': String(version) }) } });
    assert.equal(reply.statusCode, status, reply.body);
    return reply.json();
  }
  const { data: brand } = await rest('POST', '/brands', { name: 'Creator brand', slug: 'creator-brand' });
  const { data: campaign } = await rest('POST', '/campaigns', { brand_id: brand.id, name: 'Creator launch', kind: 'launch', timezone: 'UTC' });
  const { data: creator } = await rest('POST', '/creators', { display_name: 'Mia' });
  const operatorId = randomUUID();
  const operatorEmail = 'creator-operator@example.invalid';
  const [agentEvidence, reviewEvidence] = await store.transaction({ identityWrite: true }, async tx => {
    const { passwordHash } = tx.identity.get(`user/${user.id}`);
    tx.identity.put(`user/${operatorId}`, { id: operatorId, name: 'Creator operator', email: operatorEmail, passwordHash });
    tx.identity.put(`email/${operatorEmail}`, operatorId);
    tx.identity.put(`member/${operatorId}/${workspace.id}`, { userId: operatorId, workspaceId: workspace.id, role: 'editor' });
    const tenantId = tx.identity.get(`workspace/${workspace.id}`).tenantId;
    const scope = { workspaceId: workspace.id, actorId: user.id, tenantId };
    const ctx = makeContext(await tx.workspace(scope), scope, 'owner');
    return [ctx.create('evidence', { note: 'Portfolio and quote' }), ctx.create('evidence', { note: 'Operator checked a conflicting campaign' })];
  });
  const login = await app.inject({ method: 'POST', url: '/api/v1/login', payload: { email: operatorEmail, password } });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().data.user.id, operatorId);
  const operator = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().data.csrf_token };
  const { data: credential } = await rest('POST', '/tokens', {
    access: 'write', tools: ['creators_evaluate', 'creators_override_evaluation'],
  }, { status: 201 });
  const agent = { authorization: `Bearer ${credential.token}` };
  const path = `/campaigns/${campaign.id}/creator-evaluations`;
  const assessment = { creator_id: creator.id, decision: 'shortlist', reason: 'Portfolio matches the brief, but the quote exceeds the budget',
    scores: { brand_fit: { score: 80, evidence_refs: [agentEvidence.id] }, cost_fit: { score: 0, evidence_refs: [agentEvidence.id] } } };
  const { data: [original] } = await rest('POST', path, assessment, { headers: agent });
  assert.equal(original.total, 40);
  assert.equal(original.ai_generated, true);
  assert.equal(original.created_by, user.id);
  assert.equal(original.agent_credential_id, credential.id);

  const override = { dimension: 'brand_fit', score: 60, decision: 'hold', reason: 'Operator found a competing campaign', evidence_refs: [reviewEvidence.id] };
  const overridePath = `/creator-evaluations/${original.id}/overrides`;
  const { code } = await rest('POST', overridePath, override, { headers: agent, version: original.version, status: 403 });
  assert.equal(code, 'FORBIDDEN');
  await rest('POST', overridePath, override, { headers: operator, version: original.version });

  const { data: [read] } = await rest('GET', path, undefined, { headers: operator });
  assert.equal(read.id, original.id);
  assert.equal(read.version, original.version + 1);
  assert.equal(read.ai_generated, true);
  assert.equal(read.reason, assessment.reason);
  assert.equal(read.created_by, user.id);
  assert.equal(read.agent_credential_id, credential.id);
  assert.deepEqual(read.original, { scores: original.scores, total: 40, decision: 'shortlist', scored_dimensions: 2 });
  assert.deepEqual(read.scores.brand_fit, { score: 60, evidence_refs: [reviewEvidence.id], missing_fields: [] });
  assert.equal(read.scores.market_fit.score, null);
  assert.equal(read.scores.cost_fit.score, 0);
  assert.equal(read.total, 30);
  assert.equal(read.decision, 'hold');
  assert.equal(read.overrides.length, 1);
  const [audit] = read.overrides;
  assert.equal(audit.evaluation_id, read.id);
  assert.equal(audit.evaluation_version, read.version);
  assert.equal(audit.reason, override.reason);
  assert.equal(audit.created_by, operatorId);
  assert.equal(audit.overridden_at, now);
  assert.deepEqual(audit.before, read.original);
  assert.deepEqual(audit.after, { scores: read.scores, total: 30, decision: 'hold', scored_dimensions: 2 });
});

test('CR04 deadline change flags its linked campaign schedule and preserves the schedule and submissions', async t => {
  const s = await fixture(t);
  const { campaign, collaboration } = await createCollaboration(s);
  const [target, unrelated] = await s.transact(ctx => Promise.all([
    ctx.insert('planning', 'publish_target', { campaign_id: campaign.id, brand_id: campaign.data.brand_id, scheduled_at: liveAt, plan_status: 'ready' }),
    ctx.insert('planning', 'publish_target', { campaign_id: 'other', brand_id: campaign.data.brand_id, scheduled_at: liveAt }),
  ]));
  const create = { collaboration_id: collaboration.id, kind: 'short_video', due_at: now, acceptance_criteria: [] };
  await s.reject('deliverables_create', { ...create, publish_target_id: unrelated.id }, 409, 'PUBLISH_TARGET_MISMATCH');
  const row = await s.run('deliverables_create', { ...create, publish_target_id: target.id });
  const write = { deliverable_id: row.id, expected_version: row.version, due_at: reuseAt, reason: 'Creator needs one extra day' };
  const changed = await s.run('deliverables_change_deadline', write);
  await s.reject('deliverables_change_deadline', write, 409, 'version_conflict');
  const read = await s.run('deliverables_get', { deliverable_id: row.id });
  assert.equal(read.deliverable.status, 'requested');
  assert.equal(read.deliverable.due_at, reuseAt);
  assert.deepEqual(read.versions, []);
  assert.deepEqual(read.deadline_changes, [changed.deadline_change]);
  assert.equal(changed.deadline_change.previous_due_at, now);
  assert.deepEqual(changed.deadline_change.impact, { publish_target_id: target.id, scheduled_at: liveAt, review_required: true, deadline_after_schedule: true });
  const persistedTarget = await s.transact(ctx => ctx.get('planning', 'publish_target', target.id));
  assert.equal(persistedTarget.data.scheduled_at, liveAt);
  assert.equal(persistedTarget.version, target.version);
});

test('CR08 keeps reported commission and a creator’s payable-order accrual separate on the same Amazon order', async t => {
  const s = await fixture(t);
  const { campaign, creator } = await createCollaboration(s);
  const collaboration = await s.run('collaborations_create', { creator_id: creator.id, campaign_id: (await s.transact(ctx => ctx.insert('campaign', 'campaign', { brand_id: campaign.data.brand_id }))).id, type: 'commission' });
  const [proof, store] = await s.transact(ctx => Promise.all([
    ctx.insert('core', 'evidence', { source: 'Contract' }), ctx.insert('commerce', 'store', { brand_id: campaign.data.brand_id, provider: 'amazon' }),
  ]));
  const negotiating = await s.transact(ctx => ctx.update('creator', 'collaboration', collaboration.id, { status: 'negotiating' }, collaboration.version));
  const terms = await s.run('collaborations_create_terms', { collaboration_id: collaboration.id, expected_version: negotiating.version,
    commission_rule: { kind: 'rate', rate_bps: 1000, observation_days: 14, settlement_by: 'self' } });
  const sent = await s.run('collaborations_send_terms', { terms_revision_id: terms.id, expected_version: terms.version, signature_request_ref: 'signed-contract' });
  await s.run('collaborations_mark_terms_signed', { terms_revision_id: sent.id, expected_version: sent.version, signed_evidence_ids: [proof.id] });
  const active = (await s.run('collaborations_get', { collaboration_id: collaboration.id })).collaboration;
  const assignment = await s.run('creators_assign_affiliate', { collaboration_id: active.id, kind: 'discount_code', code: 'MIA' });
  const order = await s.transact(ctx => ctx.insert('commerce', 'order', { store_id: store.id, external_order_id: 'AMZ-1', currency: 'USD', financial_status: 'paid', paid_at: now, buyer_email: 'unsafe-fixture@example.invalid' }));
  const [line, reported] = await s.transact(ctx => Promise.all([
    ctx.insert('commerce', 'order_line', { order_id: order.id, external_line_id: 'one', unit_price_minor: 1_000, quantity: 1, discount_minor: 0 }),
    ctx.insert('creator', 'commission_entry', { kind: 'reported', status: 'reported', order_id: order.id, store_id: store.id, source_kind: 'import',
      external_commission_id: 'statement-row-1', currency: 'USD', commission_minor: 120, observed_at: now, source: { batch_id: 'merchant-report' } }),
    ctx.insert('commerce', 'discount_usage', { order_id: order.id, code: 'MIA' }),
  ]));
  const accrue = { affiliate_assignment_id: assignment.id, order_line_id: line.id };
  await s.reject('commissions_accrue', { ...accrue, estimated: true }, 422, 'invalid_input');
  const accrued = await s.run('commissions_accrue', accrue);
  const [row] = await s.run('commissions_reconcile_attribution', { collaboration_id: collaboration.id });
  assert.equal(row.external_order_id, 'AMZ-1');
  assert.deepEqual(row.ledger_entries.map(row => [row.id, row.source_kind, row.commission_minor]), [[accrued.id, 'order_derived', 100]]);
  assert.deepEqual(row.order_level_reports.map(row => [row.id, row.source_kind, row.commission_minor, row.report_batch_id]), [[reported.id, 'import', 120, 'merchant-report']]);
  assert.equal(row.total, undefined);
  assert.doesNotMatch(JSON.stringify(row), /buyer|unsafe-fixture/i);
});

test('CR03 keeps draft, sent and received outreach distinct and warns on repeat contact across campaigns', async t => {
  const s = await fixture(t);
  const { creator, collaboration } = await createCollaboration(s);
  const draft = await s.run('outreach_draft', { collaboration_id: collaboration.id, channel: 'email', body: 'Invitation' });
  const reply = { collaboration_id: collaboration.id, channel: 'email', external_message_ref: 'reply-1', body: 'Yes' };
  await s.reject('outreach_record_reply', reply, 409, 'INVALID_STATE');
  const sent = await s.run('outreach_record_sent', { outreach_id: draft.id, expected_version: draft.version, external_message_ref: 'sent-1', sent_at: now });
  assert.equal(sent.status, 'sent');
  assert.equal((await s.run('outreach_record_reply', reply)).status, 'received');
  const otherCampaign = await s.transact(ctx => ctx.insert('campaign', 'campaign', { brand_id: 'test-brand' }));
  const other = await s.run('collaborations_create', { creator_id: creator.id, campaign_id: otherCampaign.id, type: 'gifted' });
  const repeat = await s.run('outreach_draft', { collaboration_id: other.id, channel: 'email', body: 'Follow-up invitation' });
  const instructions = await s.run('outreach_send', { outreach_id: repeat.id, expected_version: repeat.version });
  assert.equal(instructions.delivery_mode, 'manual');
  assert.equal(instructions.recent_contact, true);
  assert.equal(instructions.outreach.status, 'draft');
  const detail = await s.run('collaborations_get', { collaboration_id: collaboration.id });
  assert.deepEqual(detail.outreach.map(row => [row.direction, row.status]).sort(), [['inbound', 'received'], ['outbound', 'sent']]);
});

test('CR05 and CR10 mask sample addresses and gate picking and acceptance on signed terms', async t => {
  const s = await fixture(t);
  const { collaboration } = await createCollaboration(s);
  const { variant, delivery, version, payable } = await s.transact(async ctx => {
    await ctx.update('creator', 'collaboration', collaboration.id, { status: 'active' }, collaboration.version);
    const variant = await ctx.insert('commerce', 'product_variant', { sku: 'SAMPLE' });
    const delivery = await ctx.insert('creator', 'deliverable', { collaboration_id: collaboration.id, status: 'submitted' });
    const version = await ctx.insert('creator', 'deliverable_version', { deliverable_id: delivery.id, review_status: 'pending' });
    await ctx.update('creator', 'deliverable', delivery.id, { latest_version_id: version.id }, delivery.version);
    const payable = await ctx.insert('creator', 'commission_entry', { collaboration_id: collaboration.id, status: 'eligible', commission_minor: 100 });
    return { variant, delivery, version, payable };
  });
  const created = await s.run('creators_create_shipment', { collaboration_id: collaboration.id, ship_to_ref: 'private-ref', lines: [{ product_variant_id: variant.id, qty: 1 }] });
  const update = (row, status, source_ref) => ({ sample_shipment_id: row.id, expected_version: row.version, status, ...(source_ref && { source_ref }) });
  const requested = await s.run('creators_update_shipment', update(created, 'requested'));
  await s.reject('creators_update_shipment', update(requested, 'picking'), 409, 'TERMS_REQUIRED');
  await s.reject('deliverables_review', { deliverable_version_id: version.id, expected_version: version.version, status: 'accepted' }, 409, 'TERMS_REQUIRED');
  const detail = () => s.run('collaborations_get', { collaboration_id: collaboration.id });
  const current = (await detail()).collaboration;
  const terms = await s.run('collaborations_create_terms', { collaboration_id: collaboration.id, expected_version: current.version, deliverable_requirements: ['One product video'] });
  const sent = await s.run('collaborations_send_terms', { terms_revision_id: terms.id, expected_version: terms.version, signature_request_ref: 'request-1' });
  const evidence = await s.transact(ctx => ctx.insert('core', 'evidence', { kind: 'file' }));
  await s.run('collaborations_mark_terms_signed', { terms_revision_id: sent.id, expected_version: sent.version, signed_evidence_ids: [evidence.id] });
  const signedCollaboration = (await detail()).collaboration;
  const revision = await s.run('collaborations_create_terms', { collaboration_id: collaboration.id, expected_version: signedCollaboration.version, deliverable_requirements: ['Two product videos'] });
  const termsHistory = (await detail()).collaboration_terms.sort((a, b) => a.revision_no - b.revision_no);
  assert.deepEqual(termsHistory.map(row => [row.revision_no, row.sign_status, row.deliverable_requirements]), [
    [1, 'signed', ['One product video']], [2, 'draft', ['Two product videos']],
  ]);
  assert.notEqual(termsHistory[0].content_hash, revision.content_hash);
  const picking = await s.run('creators_update_shipment', update(requested, 'picking'));
  const shipped = await s.run('creators_update_shipment', update(picking, 'shipped', 'tracking-1'));
  const delivered = await s.run('creators_update_shipment', update(shipped, 'delivered', 'receipt-1'));
  const after = await detail();
  const [listed] = await s.run('creators_list_shipments', { collaboration_id: collaboration.id });
  for (const row of [created, requested, picking, shipped, delivered, listed, ...after.sample_shipment]) assert.equal(row.ship_to_ref, undefined);
  assert.equal(delivered.status, 'delivered');
  assert.equal(after.deliverable.find(row => row.id === delivery.id).status, 'submitted');
  assert.equal(after.collaboration.status, 'active');
  const unchanged = await s.transact(ctx => ctx.get('creator', 'commission_entry', payable.id));
  assert.deepEqual(unchanged, payable);
});

test('CR07 plans and observes an external live session and gates clip reuse against current and intended rights', async t => {
  const s = await fixture(t);
  const { campaign, creator, collaboration } = await createCollaboration(s);
  const { warmup, wrongWarmup, market, asset, oldVersion, version, grant, revision, binding } = await s.transact(async ctx => {
    const target = { brand_id: 'test-brand', campaign_id: campaign.id, scheduled_at: now, plan_status: 'draft' };
    const warmup = await ctx.insert('planning', 'publish_target', target);
    const wrongWarmup = await ctx.insert('planning', 'publish_target', { ...target, campaign_id: 'another-campaign' });
    const market = await ctx.insert('workspace', 'market', { country_code: 'TW', brand_id: 'test-brand' });
    const asset = await ctx.insert('asset', 'asset', { brand_id: 'test-brand', status: 'active' });
    const oldVersion = await ctx.insert('asset', 'asset_version', { asset_id: asset.id });
    const version = await ctx.insert('asset', 'asset_version', { asset_id: asset.id });
    const grant = await ctx.insert('asset', 'rights_grant', { brand_id: 'test-brand', status: 'active' });
    const revision = await ctx.insert('asset', 'rights_grant_revision', { rights_grant_id: grant.id, valid_from: now, platforms: ['youtube'], regions: ['TW'], usages: ['organic_social'], allow_modification: false });
    const binding = await ctx.insert('asset', 'rights_grant_asset', { asset_id: asset.id, rights_grant_id: grant.id, version_scope: 'specific_version', asset_version_id: oldVersion.id });
    await ctx.update('asset', 'rights_grant', grant.id, { active_revision_id: revision.id }, grant.version);
    return { warmup, wrongWarmup, market, asset, oldVersion, version, grant, revision, binding };
  });

  const plan = { collaboration_id: collaboration.id, platform: 'tiktok', scheduled_at: liveAt, tz: 'Asia/Taipei', run_sheet: [{ title: 'Product demo', notes: 'Show offer' }] };
  assert.deepEqual((await s.advertised()).filter(row => row.module === 'creator' && /(?:^|_)(?:live|clip|stream)(?:_|$)/.test(row.action)).map(row => row.action).sort(), [
    'creators_get_live_session', 'creators_list_live_sessions', 'creators_plan_clip_reuse', 'creators_plan_live_session', 'creators_update_live_session',
  ]);
  await s.reject('creators_plan_live_session', { ...plan, warmup_publish_target_ids: [wrongWarmup.id] }, 409, 'WARMUP_TARGET_MISMATCH');
  const planned = await s.run('creators_plan_live_session', { ...plan, warmup_publish_target_ids: [warmup.id] });
  assert.equal(planned.status, 'planning');
  assert.deepEqual(planned.host_creator_ids, [creator.id]);
  assert.deepEqual(planned.warmup_publish_target_ids, [warmup.id]);
  assert.deepEqual(planned.run_sheet, [{ title: 'Product demo', product_id: null, notes: 'Show offer' }]);
  assert.deepEqual((await s.run('collaborations_get', { collaboration_id: collaboration.id })).live_session.map(row => row.id), [planned.id]);

  const transition = (row, status, source_ref) => ({ live_session_id: row.id, expected_version: row.version, status, ...(source_ref && { source_ref }) });
  const scheduled = await s.run('creators_update_live_session', transition(planned, 'scheduled'));
  await s.reject('creators_update_live_session', transition(scheduled, 'live'), 422, 'INVALID_INPUT');
  const observed = await s.run('creators_update_live_session', transition(scheduled, 'live', 'provider-session-1'));
  assert.equal(observed.observation_ref, 'provider-session-1');
  assert.equal(observed.observed_at, now);

  const clip = { live_session_id: planned.id, title: 'Product demo clip', asset_id: asset.id, asset_version_id: version.id,
    platform: 'youtube', market_id: market.id, usage: 'organic_social', reuse_at: reuseAt };
  await s.reject('creators_plan_clip_reuse', clip, 409, 'INVALID_STATE');
  await s.reject('creators_update_live_session', transition(observed, 'ended'), 422, 'INVALID_INPUT');
  const ended = await s.run('creators_update_live_session', transition(observed, 'ended', 'provider-replay-1'));
  assert.equal(ended.status, 'ended');
  assert.deepEqual(ended.observations.map(row => [row.status, row.source_ref, row.observed_at]), [
    ['live', 'provider-session-1', now], ['ended', 'provider-replay-1', now],
  ]);
  assert.equal(ended.observations[0].observed_by, ended.observations[1].observed_by);
  await s.reject('creators_plan_clip_reuse', { ...clip, asset_version_id: oldVersion.id }, 409, 'CLIP_RIGHTS_REQUIRED'); // no editing
  await s.transact(ctx => ctx.update('asset', 'rights_grant_revision', revision.id, { allow_modification: true }, revision.version));
  await s.reject('creators_plan_clip_reuse', clip, 409, 'CLIP_RIGHTS_REQUIRED'); // wrong asset version
  await s.transact(ctx => ctx.update('asset', 'rights_grant_asset', binding.id, { asset_version_id: version.id }, binding.version));
  await s.reject('creators_plan_clip_reuse', { ...clip, usage: 'paid_ads' }, 409, 'CLIP_RIGHTS_REQUIRED');
  await s.reject('creators_plan_clip_reuse', { ...clip, platform: 'tiktok' }, 409, 'CLIP_RIGHTS_REQUIRED');
  const anotherMarket = await s.transact(ctx => ctx.insert('workspace', 'market', { country_code: 'JP', brand_id: 'test-brand' }));
  await s.reject('creators_plan_clip_reuse', { ...clip, market_id: anotherMarket.id }, 409, 'CLIP_RIGHTS_REQUIRED');
  await s.transact(ctx => ctx.update('asset', 'rights_grant_revision', revision.id, { valid_until: reuseAt }, revision.version + 1));
  await s.reject('creators_plan_clip_reuse', clip, 409, 'CLIP_RIGHTS_REQUIRED'); // expires by reuse date
  const detail = () => s.run('creators_get_live_session', { live_session_id: planned.id });
  assert.deepEqual((await detail()).clips, []);
  await s.transact(ctx => ctx.update('asset', 'rights_grant_revision', revision.id, { valid_until: null }, revision.version + 2));
  const task = await s.run('creators_plan_clip_reuse', clip);
  assert.equal(task.status, 'planned');
  assert.equal(task.asset_version_id, version.id);
  assert.equal(task.rights_grant_revision_id, revision.id);
  assert.equal(task.rights_status, 'covered');
  await s.transact(ctx => ctx.update('asset', 'rights_grant', grant.id, { status: 'revoked' }, grant.version + 1));
  assert.equal((await detail()).clips[0].rights_status, 'blocked');
  await s.reject('creators_plan_clip_reuse', clip, 409, 'CLIP_RIGHTS_REQUIRED');
});
