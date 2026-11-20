import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testWorkspace } from '../ingest/test-context.js';
import type { Commands, Entity, Fields, Role } from '../types.js';
import { commands } from './index.js';

const creator = { role: 'editor', actorId: 'author' } as const;
const lead = { role: 'reviewer', actorId: 'lead' } as const;
const operator = { role: 'admin', actorId: 'operator' } as const;
const auditor = { role: 'reviewer', actorId: 'auditor' } as const;
const now = '2026-11-19T12:00:00.000Z';
const later = '2026-11-19T13:00:00.000Z';
const grant = (actor_id: string, actions: string[], max_spend_minor = 500) => ({ actor_id, actions, max_spend_minor });
const permissions = [grant('author', ['read', 'draft', 'export', 'review', 'approve']), grant('lead', ['read', 'review', 'approve', 'spend']),
  grant('operator', ['read', 'draft', 'execute', 'spend', 'reconcile']), grant('auditor', ['read', 'reconcile'])];
const fixtureCommands: Commands = { seed: { roles: ['owner'], run: (ctx, x) => ctx.insert(x.module, x.kind, x.data, x.id) },
  patch: { roles: ['owner'], run: (ctx, x) => ctx.update(x.module, x.kind, x.id, x.data, x.version) } };

async function fixture({ rights = true, identity = false } = {}) {
  const ws = testWorkspace();
  const seed = (module: string, kind: string, id: string, data: Fields) => ws.run<Entity>(fixtureCommands, 'seed', { module, kind, id, data });
  const patch = (module: string, kind: string, id: string, data: Fields, version = 1) => ws.run<Entity>(fixtureCommands, 'patch', { module, kind, id, data, version });
  const run = <T = any>(action: string, input: Fields, actor: { role: Role; actorId: string; now?: string } = creator) => ws.run<T>(commands, action, input, actor);
  await seed('workspace', 'brand', 'brand', { name: 'Brand' });
  await seed('workspace', 'brand', 'other-brand', { name: 'Other Brand' });
  await seed('workspace', 'market', 'tw', { brand_id: 'brand', country_code: 'TW' });
  await seed('workspace', 'market', 'jp', { brand_id: 'brand', country_code: 'JP' });
  await seed('workspace', 'market', 'wrong-market', { brand_id: 'other-brand', country_code: 'TW' });
  await seed('campaign', 'campaign', 'campaign', { brand_id: 'brand' });
  await seed('asset', 'asset', 'asset', { brand_id: 'brand', status: 'active' });
  await seed('asset', 'asset_version', 'asset-v1', { asset_id: 'asset' });
  await seed('asset', 'asset_rendition', 'render', { asset_version_id: 'asset-v1', status: 'ready' });
  const terms = { rights_grant_id: 'rights', usages: rights ? ['paid_ads'] : ['organic_social'], regions: ['TW'], platforms: ['facebook'],
    valid_from: '2026-10-01T00:00:00Z', valid_until: '2026-12-01T00:00:00Z' };
  await seed('asset', 'rights_grant_revision', 'rights-v1', terms);
  await seed('asset', 'rights_grant', 'rights', { brand_id: 'brand', status: 'active', current_revision_id: 'rights-v1' });
  await seed('asset', 'rights_grant_asset', 'rights-link', { asset_id: 'asset', rights_grant_id: 'rights' });
  const accountInput = { brand_id: 'brand', provider: 'meta_ads', external_account_id: 'ad-account', currency: 'TWD', timezone: 'Asia/Taipei', spend_cap_minor: 500, permissions };
  const account = await run('register_account', accountInput, operator);
  const creative = await run('create_creative', { ad_account_id: account.id, campaign_id: 'campaign', origin: 'asset', origin_ref: 'asset', creator_identity_required: identity });
  const variant = await run('create_creative_variant', { creative_id: creative.id, headline: 'Ad', primary_text: 'Copy', cta: 'shop_now', locale: 'zh-TW', aspect_ratio: '1:1', rendition_ids: ['render'] });
  const revision = { objective: 'sales', market_ids: ['tw'], audience_spec: { interests: ['hiking'] }, placements: ['facebook_feed'],
    schedule: { start_at: '2026-11-19T20:00:00+08:00', end_at: '2026-11-26T20:00:00+08:00', timezone: 'Asia/Taipei' },
    budget: { type: 'daily', amount_minor: 100, cap_minor: 120, currency: 'TWD' }, creative_variant_ids: [variant.id],
    estimates: [{ metric: 'impressions', value: 500, source: 'historical worksheet' }] };
  const create = (changes = {}, name = 'Launch campaign') => run('create_proposal', { ad_account_id: account.id, campaign_id: 'campaign', name, revision: { ...revision, ...changes } });
  const params = (proposal: Entity, rev: Entity) => ({ id: proposal.id, expected_version: proposal.version, revision_hash: rev.data.content_hash });
  const snapshot = (changes = {}) => run('record_entity_snapshot', { ad_account_id: account.id, campaign_id: 'campaign', level: 'campaign', external_id: 'ext-1',
    name: 'Platform campaign', observed_at: now, source: 'manual', status_snapshot: 'active', budget_snapshot: { type: 'daily', currency: 'TWD', amount_minor: 100 }, ...changes }, operator);
  async function approve(changes = {}) {
    const next = await create(changes);
    const { revision: rev } = next;
    const previewed = await run('preview_proposal', params(next.proposal, rev));
    const submitted = await run('submit_proposal', { ...params(previewed.proposal, rev), preview_id: previewed.preview.id });
    const reviewed = await run('review_proposal', { ...params(submitted, rev), recommendation: 'approve', note: 'Checked budget, account and rights' }, lead);
    const approved = await run('approve_proposal', params(reviewed.proposal, rev), lead);
    return { proposal: approved, revision: rev };
  }
  return { ws, seed, patch, run, account, accountInput, create, revision, params, approve, snapshot, terms };
}

const rejected = (code: string) => (error: any) => error?.code === code;

test('account grants and dedicated capabilities are distinct from roles and social authorization', async () => {
  const { run, account, accountInput, seed, patch } = await fixture();
  const other = { role: 'editor', actorId: 'other' } as const;
  assert.deepEqual((await run('list_accounts', {}, other)).items, []);
  await assert.rejects(run('list_entities', { ad_account_id: account.id }, other), rejected('forbidden'));
  await assert.rejects(run('register_account', accountInput), rejected('forbidden'));
  await assert.rejects(run('register_account', accountInput, operator), rejected('conflict'));
  await seed('account', 'connection', 'social', { purpose: 'social', status: 'active', provider: 'meta_ads', brand_id: 'brand' });
  await seed('account', 'connection', 'ad-conn', { purpose: 'ads', status: 'active', provider: 'meta_ads', brand_id: 'brand', external_account_id: 'ad-account' });
  await seed('account', 'capability', 'read-cap', { operation: 'ads_read', status: 'available', connection_id: 'ad-conn', external_account_id: 'ad-account' });
  await seed('account', 'capability', 'wrong-write-cap', { operation: 'ads_write', status: 'available', connection_id: 'ad-conn', external_account_id: 'different' });
  await assert.rejects(run('update_account', { id: account.id, expected_version: account.version, connection_id: 'social' }, operator), rejected('CAPABILITY_UNAVAILABLE'));
  const updated = await run('update_account', { id: account.id, expected_version: account.version, connection_id: 'ad-conn', read_capability_id: 'read-cap', write_capability_id: 'wrong-write-cap' }, operator);
  assert.deepEqual(updated.capabilities, { read_capability: 'available', write_capability: 'unavailable' });
  await patch('account', 'connection', 'ad-conn', { status: 'revoked' });
  assert.equal((await run('list_accounts', {})).items[0].data.read_capability, 'unavailable');
  await assert.rejects(run('set_account_permissions', { id: account.id, expected_version: account.version, permissions: [] }, operator), rejected('version_conflict'));

  const otherAccount = await run('register_account', { ...accountInput, brand_id: 'other-brand', external_account_id: 'other-brand-account',
    permissions: [grant('other', ['read'])] }, operator);
  assert.deepEqual((await run('list_accounts', {}, other)).items.map((row: Entity) => row.id), [otherAccount.id]);
  assert.deepEqual((await run('list_entities', { ad_account_id: otherAccount.id }, other)).items, []);
  await assert.rejects(run('query_performance', { ad_account_id: account.id, start_date: '2026-11-18', end_date: '2026-11-19' }, other), rejected('forbidden'));
});

test('revoking creative rights after approval blocks export and operation preparation', async () => {
  const { ws, run, params, approve, patch } = await fixture();
  const { proposal, revision } = await approve();
  await patch('asset', 'rights_grant', 'rights', { status: 'revoked' });
  const input = params(proposal, revision);
  await assert.rejects(run('export_proposal', input), rejected('preview_stale'));
  await assert.rejects(run('prepare_operation', { ...input, proposal_id: proposal.id, idempotency_key: 'revoked' }, operator), rejected('preview_stale'));
  assert.equal(ws.list('ads', 'ad_operation').length, 0);
});

test('preview exposes unsupported settings and estimated values and blocks partial rights and currencies', async () => {
  const { create, run, params, revision } = await fixture({ identity: true });
  await assert.rejects(create({ market_ids: ['wrong-market'] }), rejected('scope_mismatch'));
  await assert.rejects(create({ budget: { ...revision.budget, currency: 'JPY' } }), rejected('currency_mismatch'));
  await assert.rejects(create({ budget: { ...revision.budget, amount_minor: 121 } }), rejected('spend_limit_exceeded'));
  const draft = await create({ objective: 'made_up', placements: ['instagram_feed'], market_ids: ['tw', 'jp'], platform_options: { experimental: true } });
  const previewed = await run('preview_proposal', params(draft.proposal, draft.revision));
  const { blockers, estimates, actual_spend_minor } = previewed.preview.data;
  assert.ok(blockers.some((item: Fields) => item.reason === 'paid_usage_missing'));
  assert.ok(blockers.some((item: Fields) => item.reason === 'creator_identity_missing'));
  assert.equal(blockers.filter((item: Fields) => item.reason === 'unsupported_field').length, 2);
  assert.equal(estimates[0].estimate, true);
  assert.equal(actual_spend_minor, null);
  await assert.rejects(run('submit_proposal', { ...params(previewed.proposal, draft.revision), preview_id: previewed.preview.id }), rejected('proposal_blocked'));
});

test('submitted revision requires favorable independent review and revising invalidates approval', async () => {
  const { ws, create, run, params, revision, approve } = await fixture();
  const draft = await create();
  const previewed = await run('preview_proposal', params(draft.proposal, draft.revision));
  const submitted = await run('submit_proposal', { ...params(previewed.proposal, draft.revision), preview_id: previewed.preview.id });
  await assert.rejects(run('approve_proposal', params(submitted, draft.revision), lead), rejected('review_required'));
  await assert.rejects(run('review_proposal', { ...params(submitted, draft.revision), recommendation: 'approve', note: 'self' }, { role: 'admin', actorId: 'author' }), rejected('separation_of_duties'));
  const rejectedProposal = await run('reject_proposal', { ...params(submitted, draft.revision), note: 'Need better evidence' }, lead);
  assert.equal(rejectedProposal.data.status, 'rejected');
  const approved = await approve();
  const revised = await run('revise_proposal', { ...params(approved.proposal, approved.revision), revision: { ...revision, budget: { ...revision.budget, amount_minor: 105 } } });
  assert.equal(revised.proposal.data.status, 'draft');
  assert.notEqual(revised.revision.data.content_hash, approved.revision.data.content_hash);
  assert.equal(ws.list('core', 'approval_request').find(item => item.id === approved.proposal.data.approval_request_id)?.data.status, 'invalidated');
  assert.equal(ws.list('ads', 'ad_proposal_revision').find(item => item.id === approved.revision.id)?.data.budget.amount_minor, 100);
  await assert.rejects(run('preview_proposal', params(revised.proposal, approved.revision)), rejected('version_conflict'));
});

test('manual results require independent reconciliation and distinct acceptance, review and delivery facts', async () => {
  const { ws, run, seed, params, approve, snapshot } = await fixture();
  const approved = await approve();
  const exported = await run('export_proposal', params(approved.proposal, approved.revision));
  assert.equal(exported.export.data.checklist.budget.cap_minor, 120);
  const prep = { ...params(exported.proposal, approved.revision), proposal_id: exported.proposal.id, idempotency_key: 'launch' };
  const operation = await run('prepare_operation', prep, operator);
  assert.equal(operation.data.status, 'awaiting_manual_result');
  assert.equal(operation.data.spend_delta_minor, 120);
  assert.equal((await run('prepare_operation', prep, operator)).id, operation.id);
  const attempt = ws.list('ads', 'ad_operation_attempt')[0];
  const resultInput = { id: operation.id, expected_version: operation.version, fencing_token: attempt.data.fencing_token, outcome: 'accepted', external_id: 'ext-1',
    evidence: { reference: 'receipt-1', note: 'Platform accepted request', source: 'platform_receipt', observed_at: now } };
  const initial = await run('record_operation_result', resultInput, operator);
  assert.equal(initial.operation.data.status, 'awaiting_reconciliation');
  const reviewInput = { id: operation.id, expected_version: initial.operation.version, result_id: initial.result.id, decision: 'matched',
    evidence: { reference: 'console-1', source: 'platform_console', note: 'Review pending', observed_at: now },
    observations: { external_account_id: 'ad-account', external_id: 'ext-1', accepted_at: now, platform_review: 'pending' } };
  await assert.rejects(run('reconcile_operation', reviewInput, operator), rejected('separation_of_duties'));
  await assert.rejects(run('reconcile_operation', { ...reviewInput, evidence: resultInput.evidence }, auditor), rejected('independent_evidence_required'));
  const pending = await run('reconcile_operation', reviewInput, auditor);
  assert.equal(pending.operation.data.status, 'platform_review');
  assert.equal((await run('get_proposal', { id: approved.proposal.id })).proposal.data.status, 'exported');
  const entity = await snapshot();
  const newerResult = await run('record_operation_result', { ...resultInput, expected_version: pending.operation.version,
    evidence: { ...resultInput.evidence, reference: 'receipt-2', observed_at: later } }, { ...operator, now: later });
  const finalInput = { ...reviewInput, expected_version: newerResult.operation.version, result_id: newerResult.result.id,
    evidence: { ...reviewInput.evidence, reference: 'console-2', observed_at: later },
    observations: { ...reviewInput.observations, platform_review: 'approved', delivery: 'active', result_entity_id: entity.id,
      budget: { type: 'daily', currency: 'JPY', amount_minor: 100 } } };
  await assert.rejects(run('reconcile_operation', finalInput, { ...auditor, now: later }), rejected('budget_mismatch'));
  finalInput.observations.budget.currency = 'TWD';
  const verified = await run('reconcile_operation', finalInput, { ...auditor, now: later });
  assert.equal(verified.operation.data.status, 'active_verified');
  assert.equal(verified.operation.data.observations.first_spend_at, null);
  assert.equal((await run('get_proposal', { id: approved.proposal.id })).proposal.data.status, 'launched');
  assert.equal((await run('get_operation', { id: operation.id })).evidence.length, 4);
  await seed('analytics', 'metric_observation', 'first-spend', { subject_id: entity.id, subject_type: 'ads.ad_entity', metric_key: 'meta_ads.spend',
    value: 20, availability: 'observed', currency: 'TWD', observed_at: later });
  const spending = await run('record_first_spend', { id: operation.id, expected_version: verified.operation.version,
    observation_id: 'first-spend', first_spend_at: later,
    evidence: { reference: 'spend-report', note: 'First verified spend', source: 'report_export', observed_at: later } }, { ...auditor, now: later });
  assert.equal(spending.data.observations.first_spend_at, later);
  assert.equal(spending.data.status, 'active_verified');
  assert.ok(ws.events().some(item => item.event === 'ads.operation.verified'));
  assert.ok(ws.events().some(item => item.event === 'ads.operation.first_spend_observed'));
});

test('retry requires independent evidence of non-application and permission revalidation', async () => {
  const { ws, run, account, params, approve } = await fixture();
  const approved = await approve();
  const input = { ...params(approved.proposal, approved.revision), proposal_id: approved.proposal.id, idempotency_key: 'retryable-op' };
  let edited = await run('set_account_permissions', { id: account.id, expected_version: account.version,
    permissions: permissions.map(item => item.actor_id === 'operator' ? { ...item, max_spend_minor: 119 } : item) }, operator);
  await assert.rejects(run('prepare_operation', input, operator), rejected('spend_limit_exceeded'));
  edited = await run('set_account_permissions', { id: account.id, expected_version: edited.version, permissions }, operator);
  const operation = await run('prepare_operation', input, operator);
  await assert.rejects(run('retry_operation', { id: operation.id, expected_version: operation.version, revision_hash: input.revision_hash }, operator), rejected('invalid_state'));
  const attempt = ws.list('ads', 'ad_operation_attempt')[0];
  const reported = await run('record_operation_result', { id: operation.id, expected_version: operation.version, fencing_token: attempt.data.fencing_token,
    outcome: 'outcome_unknown', evidence: { reference: 'timeout-check', source: 'platform_console', note: 'No response', observed_at: now } }, operator);
  const result = await run('reconcile_operation', { id: operation.id, expected_version: reported.operation.version, result_id: reported.result.id,
    decision: 'confirmed_not_applied', retry: true, observations: { client_reference: operation.data.client_reference },
    evidence: { reference: 'independent-search', source: 'platform_console', note: 'Confirmed missing status by searching stable reference', observed_at: now } }, auditor);
  assert.equal(result.operation.data.status, 'retryable');
  const retried = await run('retry_operation', { id: operation.id, expected_version: result.operation.version, revision_hash: input.revision_hash }, operator);
  assert.equal(retried.operation.data.client_reference, operation.data.client_reference);
  assert.notEqual(retried.attempt.data.fencing_token, attempt.data.fencing_token);
  await assert.rejects(run('record_operation_result', { id: operation.id, expected_version: retried.operation.version, fencing_token: attempt.data.fencing_token }, operator), rejected('version_conflict'));
});

test('merged ad report imports into analytics and rejects cross-account or currency reuse', async () => {
  const { ws, seed, run, account, accountInput, snapshot } = await fixture();
  const campaign = await snapshot();
  const group = await snapshot({ level: 'ad_group', external_id: 'group', parent_entity_id: campaign.id });
  const ad = await snapshot({ level: 'ad', external_id: 'one-ad', parent_entity_id: group.id });
  await seed('ingest', 'import_batch', 'batch', { template_key: 'ad_report', provider: 'meta_ads', status: 'merged',
    ad_account_id: account.id, actor_id: 'operator', merged_at: now, options: { timezone: 'Asia/Taipei' } });
  await seed('ingest', 'import_row', 'line', { batch_id: 'batch', status: 'merged', normalized: { external_ad_id: 'one-ad',
    report_day: '2026-11-18', currency: 'TWD', amount_minor: 42 } });
  const args = { ad_account_id: account.id, import_batch_id: 'batch' };
  await assert.rejects(run('import_ad_report', args), rejected('forbidden'));
  const result = await run('import_ad_report', args, operator);
  assert.equal((await run('import_ad_report', args, operator)).id, result.id);
  assert.equal(ws.list('analytics', 'metric_observation').length, 1);
  const report = await run('query_performance', { ad_account_id: account.id, entity_id: ad.id, start_date: '2026-11-18', end_date: '2026-11-18' });
  assert.equal(report.totals.observed_spend_minor, 42);
  assert.equal(report.observations[0].data.source.batch_id, 'batch');
  const otherAccount = await run('register_account', { ...accountInput, external_account_id: 'second-account' }, operator);
  await assert.rejects(run('import_ad_report', { ...args, ad_account_id: otherAccount.id }, operator), rejected('scope_mismatch'));
  await seed('ingest', 'import_batch', 'wrong-currency', { template_key: 'ad_report', provider: 'meta_ads', status: 'merged',
    ad_account_id: account.id, merged_at: now, options: { timezone: 'Asia/Taipei' } });
  await seed('ingest', 'import_row', 'wrong-line', { batch_id: 'wrong-currency', status: 'merged', normalized: { external_ad_id: 'one-ad',
    report_day: '2026-11-18', currency: 'JPY', amount_minor: 42 } });
  await assert.rejects(run('import_ad_report', { ...args, import_batch_id: 'wrong-currency' }, operator), rejected('currency_mismatch'));
  assert.equal(ws.list('analytics', 'metric_observation').length, 1);
});

test('performance deduplicates revisions and ancestor totals, preserves missing days and produces evidence-backed draft adjustments', async () => {
  const { ws, seed, run, account, snapshot, create, params, revision } = await fixture();
  const campaign = await snapshot();
  const group = await snapshot({ level: 'ad_group', external_id: 'group-1', parent_entity_id: campaign.id });
  await seed('campaign', 'budget_line', 'allocation', { campaign_id: 'campaign', category: 'ads', amount_minor: 100, currency: 'TWD' });
  await seed('campaign', 'budget_line', 'other-currency', { campaign_id: 'campaign', category: 'ads', amount_minor: 800, currency: 'USD' });
  const obs = { subject_type: 'ads.ad_entity', subject_id: campaign.id, metric_key: 'meta_ads.spend', period_kind: 'day', date: '2026-11-18',
    observed_at: now, timezone: 'Asia/Taipei', value: 120, availability: 'observed', currency: 'TWD', source: { method: 'import' } };
  await seed('analytics', 'metric_observation', 'obs-current', obs);
  await seed('analytics', 'metric_observation', 'obs-old', { ...obs, observed_at: '2026-11-19T11:00:00Z', value: 300 });
  await seed('analytics', 'metric_observation', 'obs-child', { ...obs, subject_id: group.id, value: 40 });
  await seed('analytics', 'metric_observation', 'obs-segment', { ...obs, dimensions: { age: '18-25' }, value: 77 });
  await seed('analytics', 'metric_observation', 'obs-estimate', { ...obs, date: '2026-11-19', availability: 'estimated', value: 60 });
  const query = { ad_account_id: account.id, campaign_id: 'campaign', start_date: '2026-11-18', end_date: '2026-11-19' };
  const report = await run('query_performance', query);
  assert.equal(report.totals.observed_spend_minor, 120);
  assert.deepEqual(report.totals.missing_dates, ['2026-11-19']);
  assert.equal(report.totals.coverage, 0.5);
  assert.equal(report.totals.pacing_ratio, 1.2);
  assert.equal(report.observations.length, 5);
  assert.equal((await run('query_performance', { ...query, start_date: '2026-11-19' })).totals.observed_spend_minor, null);
  const evidence = await run('save_performance_snapshot', query);
  await run('save_performance_snapshot', query);
  assert.equal(ws.events().filter(item => item.event === 'ads.budget.pacing_alert').length, 1);
  const proposal = await create();
  const suggestion = await run('create_adjustment', { proposal_id: proposal.proposal.id, revision_hash: proposal.revision.data.content_hash,
    target_entity_id: campaign.id, kind: 'pause', evidence_refs: [evidence.id], rationale: 'Observed cost above allocation', minimum_sample_size: 10, concurrent_promotion: true });
  assert.ok(suggestion.data.checks.limits.includes('sample_below_minimum'));
  const decision = await run('decide_adjustment', { id: suggestion.id, expected_version: suggestion.version, decision: 'accepted', note: 'Prepare a pause draft',
    proposal_expected_version: proposal.proposal.version, revision_hash: params(proposal.proposal, proposal.revision).revision_hash,
    revision: { ...revision, operation: { kind: 'pause', target_entity_id: campaign.id } } });
  assert.ok(decision.data.resulting_proposal_revision_id);
  assert.equal((await run('get_proposal', { id: proposal.proposal.id })).proposal.data.status, 'draft');
  assert.equal(ws.list('ads', 'ad_operation').length, 0);
});
