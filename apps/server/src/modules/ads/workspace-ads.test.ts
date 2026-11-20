import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { metaPauseDrain } from './meta-pause.js';
import { test } from 'node:test';
import { testWorkspace } from '../lifecycle/workspace-test-context.js';
import { operations } from './index.js';

function fixture() {
  const workspace = testWorkspace(operations);
  const {ctx, call} = workspace;
  const settings = { provider:'meta_ads', external_account_id:'external-1', brand_id:'brand', currency:'USD', timezone:'UTC', spend_cap_snapshot:1000 };
  const account = call('ads_register_account',settings);
  const asset = ctx.create('asset',{brand_id:'brand'});
  const rendition = ctx.create('asset_rendition',{asset_id:asset.id});
  const creative = call('ads_create_creative',{brand_id:'brand',origin:'asset',origin_ref:asset.id});
  const variant = call('ads_create_creative_variant',{headline:'Headline',primary_text:'Description',rendition_ids:[rendition.id],locale:'en'},creative.id);
  const grant = ctx.create('rights_grant',{brand_id:'brand',status:'active'});
  const terms = ctx.create('rights_grant_revision',{rights_grant_id:grant.id,usages:['organic_social'],regions:['US'],valid_from:ctx.now,valid_until:'2026-12-01T00:00:00Z'});
  ctx.update('rights_grant',grant.id,{current_revision_id:terms.id});
  ctx.create('rights_grant_asset',{rights_grant_id:grant.id,asset_id:asset.id,version_scope:'all_versions'});
  const revision = {objective:'sales',market_ids:['US'],creative_variant_ids:[variant.id],
    schedule:{starts_at:'2026-11-20T00:00:00Z',ends_at:'2026-11-22T00:00:00Z'},budget:{type:'daily',currency:'USD',amount_minor:100,cap_minor:150}};
  return {...workspace,account,grant,terms,revision,settings};
}

test('advertising approval binds the exact revision and rechecks paid rights', () => {
  const {ctx,call,account,grant,terms,revision} = fixture();
  const proposal = call('ads_create_proposal',{ad_account_id:account.id,revision});
  assert.throws(() => call('ads_submit_proposal',{},proposal.id), {code:'RIGHTS_UNAVAILABLE'});
  const paid = ctx.create('rights_grant_revision',{...terms, usages:['paid_ads']});
  ctx.update('rights_grant',grant.id,{current_revision_id:paid.id});
  const blocked = call('ads_create_proposal',{ad_account_id:account.id,revision:{...revision,placements:['unsupported-placement']}});
  assert.throws(() => call('ads_submit_proposal',{},blocked.id),{code:'UNSUPPORTED_AD_FIELDS'});
  const submitted = call('ads_submit_proposal',{},proposal.id);
  ctx.role = 'editor';
  assert.throws(() => call('ads_decide_proposal',{decision:'approved'},proposal.id),{code:'FORBIDDEN'});
  ctx.role = 'reviewer';
  call('ads_decide_proposal',{decision:'approved'},proposal.id);
  ctx.role = 'owner';
  assert.throws(() => call('ads_execute_operation',{kind:'create_external_draft',proposal_revision_id:proposal.current_revision_id},proposal.id,{},'once'),{code:'CAPABILITY_UNAVAILABLE'});
  assert.equal(ctx.list('ad_operation').length,0);
  assert.equal(call('ads_export_proposal',{},proposal.id).mode,'manual');
  const handoff = call('ads_record_manual_operation',{},proposal.id,{},'manual-once');
  assert.equal(handoff.status,'manual');
  assert.equal(call('ads_record_manual_operation',{},proposal.id,{},'manual-once').id,handoff.id);
  assert.equal(ctx.list('ad_operation_attempt').length,0);
  ctx.update('rights_grant',grant.id,{status:'revoked'});
  assert.throws(() => call('ads_execute_operation',{kind:'create_external_draft',proposal_revision_id:proposal.current_revision_id},proposal.id,{},'after-revocation'),{code:'RIGHTS_UNAVAILABLE'});
  assert.throws(() => call('ads_record_manual_operation',{},proposal.id,{},'after-revocation'),{code:'RIGHTS_UNAVAILABLE'});
  assert.equal(ctx.list('ad_operation').length,1);
  const updated = call('ads_revise_proposal',{...revision, objective:'reach'},proposal.id);
  assert.notEqual(updated.current_revision_id,proposal.current_revision_id);
  assert.equal(ctx.get('ad_approval_request',String(submitted.approval_request_id)).status,'superseded');
  assert.throws(() => call('ads_export_proposal',{},proposal.id),{code:'STATE_CONFLICT'});
});

test('ad accounts require a dedicated connection and keep read and write independent', () => {
  const {ctx,call,settings} = fixture();
  const social = ctx.create('connection',{provider:'meta_ads',purpose:'social',brand_id:'brand',status:'active'});
  assert.throws(() => call('ads_register_account',{...settings,external_account_id:'second',connection_id:social.id}),{code:'CAPABILITY_UNAVAILABLE'});
  const connected = ctx.create('connection',{provider:'meta_ads',purpose:'ads',brand_id:'brand',status:'active'});
  ctx.create('capability',{connection_id:connected.id,status:'available',key:'ads_read'});
  ctx.create('capability',{connection_id:connected.id,status:'available',key:'ads_write',external_account_id:'wrong-account'});
  const account = call('ads_register_account',{...settings,external_account_id:'second',connection_id:connected.id});
  assert.equal(account.read_capability,'available');
  assert.equal(account.write_capability,'unavailable');
});

test('report pacing distinguishes missing spend from reported zero', () => {
  const {ctx,call,account} = fixture();
  const campaign = ctx.create('campaign',{brand_id:'brand'});
  ctx.create('budget_line',{campaign_id:campaign.id,category:'ads',currency:'USD',amount_minor:100});
  const entity = {level:'campaign',external_id:'c1',name:'C1',campaign_id:campaign.id};
  const observation = {metric_key:'spend',date:'2026-11-17',definition:'Daily spend in cents'};
  call('ads_import_report',{source_ref:'r1',entity,observations:[{...observation,availability:'source_not_provided'}]},account.id);
  const query = {ad_account_id:account.id,campaign_id:campaign.id,from:'2026-11-17',until:'2026-11-18'};
  const total = () => (call('ads_query_performance',{},undefined,query).pacing as Record<string,unknown>[])[0];
  assert.equal(total().actual_spend_minor,null);
  assert.equal(total().unreported_days,2);
  call('ads_import_report',{source_ref:'r2',entity,observations:[{...observation,availability:'observed',value:0}]},account.id);
  assert.equal(total().actual_spend_minor,0);
  assert.equal(total().unreported_days,1);
  assert.equal(total().observed_pacing,0);
  assert.equal(total().coverage_ratio,0.5);
  const report = call('ads_query_performance',{},undefined,query);
  assert.equal(report.timezone,'UTC');
  assert.equal(report.reporting_basis,'provider_native_daily');
  assert.equal((report.observations as Record<string,unknown>[])[0].definition,'Daily spend in cents');
  assert.equal(ctx.list('metric_observation').length,2);
  assert.throws(() => call('ads_import_report',{source_ref:'r2',entity,observations:[{...observation,availability:'observed',value:1}]},account.id),{code:'STATE_CONFLICT'});
  assert.equal(ctx.list('metric_observation').length,2);
  call('ads_import_report',{source_ref:'r3',entity,observations:[{...observation,availability:'observed',value:120}]},account.id);
  assert.equal(total().coverage_ratio,0.5);
  assert.equal(total().observed_pacing,1.2);
});

test('adjustment suggestions use target evidence and create a new reviewable draft', () => {
  const {ctx,call,account,revision} = fixture();
  const target = ctx.create('ad_entity',{ad_account_id:account.id,level:'campaign',external_id:'c1'});
  const evidence = ctx.create('metric_observation',{subject_type:'ads.ad_entity',subject_id:target.id,availability:'observed'});
  const suggestion = call('ads_suggest_adjustments',{target_entity_id:target.id,kind:'pause',rationale:'Spend surge',evidence_refs:[evidence.id],checks:{sample_size:5,minimum_sample_size:10}});
  assert.ok((suggestion.limitations as string[]).includes('insufficient_sample'));
  const decided = call('ads_decide_adjustment',{decision:'accepted',revision:{...revision,creative_variant_ids:[],change:{kind:'pause',target_entity_id:target.id}}},suggestion.id);
  const proposed = ctx.get('ad_proposal_revision',String(decided.resulting_proposal_revision_id));
  assert.equal(ctx.get('ad_proposal',String(proposed.proposal_id)).status,'draft');
  assert.equal(ctx.list('ad_operation').length,0);
});


test('AD05 Meta campaign pause separates acceptance and readback and never resends an unknown write', async t => {
  const { ctx, call, settings } = fixture();
  const connection = ctx.create('connection', { provider: 'meta_ads', purpose: 'ads', status: 'active', brand_id: settings.brand_id,
    external_account_id: 'act_801', discovered_accounts: [{ externalAccountId: 'act_801' }] });
  const encryptionKey = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(Buffer.from(JSON.stringify([ctx.tenantId, ctx.workspaceId, connection.id, connection.provider])));
  const token = { accessToken: 'local-token', scopes: ['ads_management'] };
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(token)), cipher.final()]);
  ctx.update('connection', connection.id, { sealed_token: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url') });
  for (const key of ['ads_read', 'ads_write']) ctx.create('capability', { connection_id: connection.id, key, status: 'available' });
  const account = call('ads_register_account', { ...settings, external_account_id: 'act_801', connection_id: connection.id });
  const requests: { method?: string; url?: string; body: string; authorization?: string }[] = [];
  const paused = new Set<string>();
  const server = createServer(async (req, reply) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization });
    const id = req.url!.split('?')[0].split('/').at(-1)!;
    if (req.method === 'POST') {
      paused.add(id);
      if (id === '902') { reply.destroy(); return; }
    }
    reply.setHeader('Content-Type', 'application/json');
    reply.end(JSON.stringify(req.method === 'POST' ? { success: true } : { id, account_id: '801',
      configured_status: paused.has(id) ? 'PAUSED' : 'ACTIVE', effective_status: paused.has(id) ? 'PAUSED' : 'ACTIVE' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const drain = metaPauseDrain({ encryptionKey }, async request => {
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://graph.facebook.com');
    const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, {
      method: request.method, headers: request.headers, body: typeof request.body === 'string' ? request.body : undefined,
    });
    return { status: response.status, body: await response.json() };
  });
  const tick = () => drain(async run => run(ctx));
  for (const [externalId, receipt] of [['901', 'accepted'], ['902', 'outcome_unknown']] as const) {
    const target = ctx.create('ad_entity', { ad_account_id: account.id, external_id: externalId, level: 'campaign' });
    const proposal = call('ads_create_proposal', { ad_account_id: account.id, revision: { objective: 'sales',
      schedule: { starts_at:'2026-11-20T00:00:00Z', ends_at:'2026-11-22T00:00:00Z' },
      budget: { type: 'daily', currency: 'USD', amount_minor: 100, cap_minor: 150 }, change: { kind: 'pause', target_entity_id: target.id } } });
    call('ads_submit_proposal', {}, proposal.id);
    ctx.actorId = 'approver';
    call('ads_decide_proposal', { decision: 'approved' }, proposal.id);
    ctx.actorId = 'author';
    const input = { kind: 'pause', proposal_revision_id: proposal.current_revision_id };
    const queued = call('ads_execute_operation', input, proposal.id, {}, `first-${externalId}`);
    assert.equal(queued.status, 'queued');
    await tick();
    assert.equal(call('ads_get_operation', {}, queued.id).status, receipt);
    assert.equal(call('ads_execute_operation', input, proposal.id, {}, `another-${externalId}`).id, queued.id);
    call('ads_reconcile_operation', {}, queued.id);
    await tick();
    await tick();
    assert.equal(call('ads_get_operation', {}, queued.id).status, 'verified');
    assert.deepEqual(requests.filter(row => row.url?.includes(`/${externalId}`)).map(row => [row.method, row.url, row.body]), [
      ['GET', `/v25.0/${externalId}?fields=id,account_id,configured_status,effective_status`, ''],
      ['POST', `/v25.0/${externalId}`, 'status=PAUSED'],
      ['GET', `/v25.0/${externalId}?fields=id,account_id,configured_status,effective_status`, ''],
    ]);
  }
  assert(requests.every(row => row.authorization === 'Bearer local-token'));
  assert.equal(ctx.list('ad_operation').length, 2);
});
