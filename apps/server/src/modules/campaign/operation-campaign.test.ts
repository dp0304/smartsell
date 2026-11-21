import assert from 'node:assert/strict';
import test from 'node:test';
import { Problem, type Context, type Data, type Role, type Row } from '@smartsell/contracts';
import { recordObservations } from '../analytics/metrics.js';
import { finalizeReport, generateReport, saveReport } from '../analytics/reports.js';
import { operations, schedules, subscribers } from './index.js';

const time = '2026-11-19T12:00:00.000Z';
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Launch brief' }] }] };

function workspace() {
  let saved = new Map<string, Map<string, Row>>(), serial = 0;
  const events: { type: string; data: Data }[] = [];
  const transaction = async <T>(run: (ctx: Context) => T | Promise<T>, role: Role = 'owner') => {
    const working = structuredClone(saved);
    const pending: typeof events = [];
    const group = (kind: string) => {
      if (!working.has(kind)) working.set(kind, new Map());
      return working.get(kind)!;
    };
    const ctx: Context = {
      workspaceId: 'workspace', tenantId: 'tenant', actorId: 'person', role, now: time,
      list: kind => [...group(kind).values()].map(row => structuredClone(row)),
      get(kind, id) {
        const found = group(kind).get(id);
        if (!found) throw new Problem(404, 'not_found', 'Unknown resource');
        return structuredClone(found);
      },
      create(kind, data) {
        const row = { ...structuredClone(data), id: `rec-${++serial}`, version: 1, created_at: time, updated_at: time };
        group(kind).set(row.id, row);
        return structuredClone(row);
      },
      update(kind, id, data) {
        const prior = ctx.get(kind, id);
        const row = { ...prior, ...structuredClone(data), id, version: prior.version + 1, updated_at: time };
        group(kind).set(id, row);
        return structuredClone(row);
      },
      remove(kind, id) { group(kind).delete(id); },
      emit(type, data) { pending.push({ type, data: structuredClone(data) }); },
    };
    const result = await run(ctx);
    saved = working;
    events.push(...pending);
    return result;
  };
  return {
    transaction, events,
    seed: (kind: string, data: Data) => transaction(ctx => ctx.create(kind, data)),
    raw: (kind: string) => transaction(ctx => ctx.list(kind)),
    run<T = Row>(name: string, body: Data = {}, params: Record<string, string> = {}, expectedVersion?: number, role: Role = 'owner') {
      const operation = operations.find(operation => operation.name === name);
      assert.ok(operation, name);
      return transaction(ctx => {
        if (!operation.roles.includes(role)) throw new Problem(403, 'forbidden', 'Role denied');
        return operation.run(ctx, { body, params, query: {}, expectedVersion }) as T | Promise<T>;
      }, role);
    },
  };
}
async function fixture() {
  const w = workspace();
  const brand = await w.seed('brand', { name: 'Brand', status: 'active' });
  const campaign = await w.run('campaign_create_draft', { name: 'Launch', brand_id: brand.id, kind: 'launch', timezone: 'Asia/Taipei', starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' });
  return { w, brand, campaign, params: { id: campaign.id } };
}
const status = (code: number) => (error: unknown) => error instanceof Problem && error.status === code;
const goalData = { metric_key: 'reach', unit: 'count', baseline_value: 1, baseline_source: 'manual', target_value: 10, due_at: '2026-12-01T00:00:00Z' };

test('campaign goals validate the metric and scope, retain history, and gate planning', async () => {
  const { w, campaign, params, brand } = await fixture();
  await assert.rejects(w.run('campaign_transition', { to: 'planned' }, params, campaign.version), status(409));
  await assert.rejects(w.run('campaign_goal_create', { ...goalData, unit: 'seconds' }, params), status(422));
  await assert.rejects(w.run('campaign_goal_create', { ...goalData, due_at: '2026-02-30T00:00:00Z' }, params), status(422));
  const market = await w.seed('market', { brand_id: brand.id, status: 'active' });
  const updated = await w.run<{ markets: Row[]; campaign_version: number }>('campaign_set_markets', { markets: [{ market_id: market.id, locales: ['ja-JP'] }] }, params, campaign.version);
  const goal = await w.run('campaign_goal_create', { ...goalData, campaign_market_id: updated.markets[0]!.id }, params);
  const scoped = { ...params, goalId: goal.id };
  await assert.rejects(w.run('campaign_goal_update', { target_value: 20 }, scoped, goal.version), status(422));
  const changed = await w.run('campaign_goal_update', { target_value: 20, reason: 'Reforecast' }, scoped, goal.version);
  await assert.rejects(w.run('campaign_goal_update', { target_value: 21, reason: 'Stale' }, scoped, goal.version), status(412));
  const info = await w.run('campaign_goal_get', {}, scoped);
  assert.deepEqual((info.revisions as Row[]).map(row => row.target_value), [10, 20]);
  assert.equal((info.progress as Data).value, null);
  await w.transaction(ctx => recordObservations(ctx, { observations: [
    { metric_key: 'reach', subject_type: 'campaign', subject_id: campaign.id, date: '2026-11-15', value: 4, dims: { market_id: market.id }, source: { method: 'manual' } },
    { metric_key: 'reach', subject_type: 'campaign', subject_id: campaign.id, date: '2026-11-15', value: 7, source: { method: 'manual' } },
  ] }));
  const observed = await w.run('campaign_goal_get', {}, scoped);
  assert.equal((observed.progress as Data).value, 4);
  assert.equal((observed.progress as Data).progress_percent, 20);
  assert.equal(changed.campaign_id, campaign.id);
  const planned = await w.run('campaign_transition', { to: 'planned' }, params, updated.campaign_version);
  assert.equal(planned.status, 'planned');
  await w.transaction(ctx => schedules[0]!.run(ctx));
  assert.equal((await w.raw('campaign'))[0]!.status, 'active');
});

test('approval preserves immutable brief history and requires a human lead', async () => {
  const { w, campaign, params } = await fixture();
  const brief = await w.run('campaign_brief_create', { title: 'Strategy' }, params);
  await assert.rejects(w.run('campaign_brief_create', { title: 'Second main' }, params), status(409));
  const first = await w.run('brief_update_draft', { body_doc: doc }, { id: brief.id }, brief.version, 'agent');
  assert.equal(first.ai_generated, true);
  const review = await w.run('brief_revision_submit', {}, { id: first.id }, first.version);
  await assert.rejects(w.run('brief_revision_approve', {}, { id: first.id }, review.version, 'agent'), status(403));
  await w.run('brief_revision_approve', {}, { id: first.id }, review.version);
  const latest = (await w.raw('brief'))[0]!;
  const second = await w.run('brief_update_draft', { markdown: '# Revised' }, { id: brief.id }, latest.version);
  assert.equal((await w.raw('brief'))[0]!.approved_revision_id, first.id);
  const review2 = await w.run('brief_revision_submit', {}, { id: second.id }, second.version);
  await w.run('brief_revision_approve', {}, { id: second.id }, review2.version);
  const revisions = await w.raw('brief_revision');
  assert.equal(revisions[0]!.status, 'superseded');
  assert.equal(revisions[0]!.content_hash, first.content_hash);
  assert.deepEqual(revisions[0]!.body_doc, doc);
  assert.equal(revisions[1]!.status, 'approved');
  assert.equal(w.events.filter(event => event.type === 'campaign.brief.approved').length, 2);
  assert.equal((await w.run('campaign_get_context', {}, params)).id, campaign.id);
});

test('spend preserves original currencies and only counts the unpaid portion of commitments', async () => {
  const { w, params } = await fixture();
  const fx = await w.seed('fx_rate', { base: 'EUR', quote: 'USD', rate: '1.2500', rate_date: '2026-11-19' });
  const file = await w.seed('file_object', { storage_key: 'invoice' });
  const line = await w.run('campaign_budget_line_create', { amount_minor: 1000, category: 'production', currency: 'USD', fx_date: '2026-11-19' }, params);
  const commitment = await w.run('campaign_cost_commitment_create', { budget_line_id: line.id, amount_minor: 800, currency: 'USD', status: 'committed', source_ref: { type: 'external_po', id: 'PO-1' } }, params);
  const entry = await w.run('campaign_cost_entry_create', { budget_line_id: line.id, commitment_id: commitment.id, amount_minor: 400, currency: 'EUR', incurred_on: '2026-11-19', fx_rate_id: fx.id, attachment_file_ids: [file.id] }, params);
  assert.equal(entry.amount_minor, 400);
  assert.equal(entry.currency, 'EUR');
  let summary = await w.run<{ lines: Data[] }>('campaign_budget_summary', {}, params);
  assert.equal(summary.lines[0]!.actual_minor, 500);
  assert.equal(summary.lines[0]!.open_commitment_minor, 300);
  assert.equal(summary.lines[0]!.remaining_minor, 200);
  const overrun = await w.run('campaign_cost_entry_create', { budget_line_id: line.id, amount_minor: 300, currency: 'USD', incurred_on: '2026-11-19' }, params);
  summary = await w.run('campaign_budget_summary', {}, params);
  assert.equal(summary.lines[0]!.overrun_minor, 100);
  assert.equal((await w.raw('approval_request'))[0]!.status, 'pending');
  await w.run('campaign_cost_entry_delete', {}, { ...params, entryId: overrun.id }, overrun.version);
  assert.equal((await w.raw('approval_request'))[0]!.status, 'invalidated');
  assert.equal((await w.raw('cost_commitment')).length, 1);
  assert.ok(w.events.some(event => event.type === 'campaign.budget.overrun_detected'));
});

test('budget reallocations conserve currency totals and require current approval', async () => {
  const { w, params } = await fixture();
  const allocation = { currency: 'USD', fx_date: '2026-11-19' };
  const from = await w.run('campaign_budget_line_create', { ...allocation, amount_minor: 700, category: 'production' }, params);
  const to = await w.run('campaign_budget_line_create', { ...allocation, amount_minor: 300, category: 'creator' }, params);
  const body = { from_line_id: from.id, to_line_id: to.id, amount_minor: 200, reason: 'Change channel mix' };
  const first = await w.run('campaign_budget_reallocation_request', body, params);
  const stale = await w.run('campaign_budget_reallocation_request', body, params);
  assert.deepEqual((await w.raw('budget_line')).map(row => row.amount_minor), [700, 300]);
  const decision = { decision: 'approve', reason: 'Approved plan revision' };
  await w.run('campaign_budget_approval_decide', decision, { ...params, requestId: String(first.approval_request_id) }, 1);
  await assert.rejects(w.run('campaign_budget_approval_decide', decision, { ...params, requestId: String(stale.approval_request_id) }, 1), status(409));
  assert.deepEqual((await w.raw('budget_line')).map(row => row.amount_minor), [500, 500]);
});

test('matrix uses distinct account targets, fills gaps through Content and Workspace, and keeps deadlines separate', async () => {
  const { w, campaign, params, brand } = await fixture();
  const slot = await w.run('campaign_plan_slot_create', { stage: 'launch', platform: 'instagram', planned_count: 3, locale: 'en' }, params);
  const item = await w.seed('content_item', { brand_id: brand.id, campaign_id: campaign.id, production_stage: 'accepted' });
  const variant = await w.seed('content_variant', { content_item_id: item.id, platform: 'instagram', locale: 'en', format: 'feed_image' });
  for (const account of ['account-one', 'account-two']) {
    const social = await w.seed('social_account', { brand_id: brand.id, provider: 'instagram', name: account });
    await w.seed('publish_target', { campaign_id: campaign.id, content_item_id: item.id, content_variant_id: variant.id, social_account_id: social.id, scheduled_at: time, plan_status: 'ready' });
  }
  const preview = await w.run<{ drafts: Data[] }>('campaign_create_gap_items', {}, params);
  assert.equal(preview.drafts.length, 1);
  assert.equal((await w.raw('content_item')).length, 1);
  const result = await w.run<{ created: Data[] }>('campaign_create_gap_items', { dry_run: false, slot_ids: [slot.id], production_due_at: time }, params);
  assert.equal(result.created.length, 1);
  assert.equal((await w.raw('work_item'))[0]!.due_at, time);
  assert.equal((await w.raw('publish_target')).length, 2);
  const matrix = await w.run<{ cells: { counts: Data; gap: number }[] }>('campaign_matrix', {}, params);
  assert.deepEqual(matrix.cells[0]!.counts, { scheduled: 2, in_production: 1, published: 0, failed: 0 });
  assert.equal(matrix.cells[0]!.gap, 0);
});

test('closeout requires retention reasons and freezes the resulting snapshot', async () => {
  const { w, campaign, params } = await fixture();
  await w.run('campaign_goal_create', goalData, params);
  const planned = await w.run('campaign_transition', { to: 'planned' }, params, campaign.version);
  const active = await w.run('campaign_transition', { to: 'active' }, params, planned.version);
  const wrapping = await w.run('campaign_transition', { to: 'wrapping' }, params, active.version);
  const target = await w.seed('publish_target', { campaign_id: campaign.id, plan_status: 'ready' });
  await assert.rejects(w.run('campaign_closeout', { retrospective_doc: doc }, params, wrapping.version), status(409));
  const closed = await w.run('campaign_closeout', { retrospective_doc: doc, retentions: [{ type: 'publish_target', id: target.id, reason: 'Explicitly handed over' }] }, params, wrapping.version);
  await w.transaction(ctx => ctx.update('publish_target', target.id, { plan_status: 'closed' }));
  assert.deepEqual((await w.run('campaign_closeout_get', {}, params)).snapshot, closed.snapshot);
  assert.equal((await w.raw('campaign'))[0]!.status, 'closed');
});

test('closeout computes post goals at publication grain and records unsupported grains as unavailable', async () => {
  const { w, campaign, params } = await fixture();
  const post = await w.seed('platform_post', { campaign_id: campaign.id, platform: 'facebook', published_at: '2026-11-10T12:00:00Z' });
  const otherPost = await w.seed('platform_post', { campaign_id: 'other', platform: 'facebook', published_at: '2026-11-10T12:00:00Z' });
  await w.transaction(ctx => recordObservations(ctx, { observations: [post, otherPost].map(({ id }, index) => ({
    metric_key: 'norm.post.views', subject_type: 'platform_post', subject_id: id,
    observed_at: '2026-11-11T12:00:00Z', availability: 'observed', value: index ? 75 : 8, source: { method: 'manual_import' },
  })) }));
  const views = await w.run('campaign_goal_create', { ...goalData, metric_key: 'norm.post.views' }, params);
  const followers = await w.run('campaign_goal_create', { ...goalData, metric_key: 'norm.account.followers' }, params);
  const wrapping = await w.transaction(ctx => ctx.update('campaign', campaign.id, { status: 'wrapping' }));
  const closeout = await w.run('campaign_closeout', { retrospective_doc: doc }, params, wrapping.version);
  const snapshot = closeout.snapshot as { goals: { goal: Row; progress: Data }[] };
  const progress = new Map(snapshot.goals.map(({ goal, progress }) => [goal.id, progress]));
  assert.equal(progress.get(views.id)?.value, 8);
  assert.equal(progress.get(followers.id)?.value, null);
  assert.deepEqual(progress.get(followers.id)?.coverage, { status: 'unavailable', reason: 'unsupported_campaign_grain' });
});

test('campaign report backfill uses exact scope and excludes versions generated for another campaign', async () => {
  const { w, campaign, params } = await fixture();
  const other = await w.seed('campaign', { status: 'closed' });
  await w.transaction(ctx => ctx.update('campaign', campaign.id, { status: 'closed' }));
  const definition = {
    title: 'Views', kind: 'campaign', period: { from: '2026-11-01', to: '2026-11-18', tz: 'UTC' },
    sections: [{ key: 'views', query: { metrics: ['norm.post.views'], subject: { type: 'platform_post' }, time: { basis: 'published_at' }, age_bucket: '24h' } }],
  };
  const { reportId, frozen } = await w.transaction(ctx => {
    const report = saveReport(ctx, { ...definition, scope: { campaign_ids: [other.id] } });
    const reportId = String(report.id);
    const draft = generateReport(ctx, reportId, {});
    const frozen = finalizeReport(ctx, String(draft.id));
    saveReport(ctx, { scope: { campaign_ids: [campaign.id] }, sections: definition.sections }, reportId);
    return { reportId, frozen };
  });
  const multi = await w.transaction(ctx => saveReport(ctx, { ...definition, scope: { campaign_ids: [campaign.id, other.id] } }));
  const before = await w.run<Row[]>('campaign_report_list', {}, params);
  assert.deepEqual(before.map(report => [report.id, report.versions]), [[reportId, []]]);
  await assert.rejects(w.run('campaign_report_backfill', {}, { ...params, reportId: String(multi.id) }), status(404));
  await assert.rejects(w.run('campaign_report_backfill', {}, { id: other.id, reportId }), status(404));
  const backfill = await w.run('campaign_report_backfill', {}, { ...params, reportId });
  assert.equal(backfill.version_no, 2);
  assert.deepEqual((await w.run<Row[]>('campaign_report_list', {}, params))[0]?.versions, [backfill]);
  assert.equal((await w.raw('report_version')).find(version => version.id === frozen.id)?.status, 'finalized');
  assert.equal((await w.raw('campaign')).find(row => row.id === campaign.id)?.status, 'closed');
});

test('campaign links use the Traffic allowlist and retain UTM identity after a rename', async () => {
  const { w, campaign, params } = await fixture();
  const domain = await w.seed('link_domain', { hostname: 'short.example.com', verification_status: 'verified', tls_status: 'active' });
  const link = { domain_id: domain.id, destination_url: 'https://shop.example.com/launch', utm_params: { utm_campaign: 'override', utm_source: 'instagram' } };
  await assert.rejects(w.run('campaign_link_create', link, params), status(422));
  await w.seed('redirect_allowlist', { hostname: 'shop.example.com', status: 'active' });
  await w.run('campaign_update', { name: 'Renamed' }, params, campaign.version);
  const saved = await w.run('campaign_link_create', link, params);
  const revision = (await w.raw('short_link_revision'))[0]!;
  assert.equal(saved.campaign_id, campaign.id);
  assert.equal(new URL(String(revision.final_url)).searchParams.get('utm_campaign'), campaign.utm_key);
});

test('verified Ads spend is reconciled on replay without counting child totals', async () => {
  const { w, campaign, params } = await fixture();
  await w.run('campaign_budget_line_create', { amount_minor: 1000, category: 'ads', currency: 'USD', fx_date: '2026-11-19' }, params);
  const ad = await w.seed('ad_entity', { campaign_id: campaign.id, level: 'campaign' });
  const child = await w.seed('ad_entity', { campaign_id: campaign.id, level: 'ad' });
  const snapshot = { subject_type: 'ads.ad_entity', period_kind: 'day', native_date: '2026-11-19', availability: 'observed', metric_key: 'ads.spend', currency: 'USD' };
  await w.seed('metric_observation', { ...snapshot, subject_id: ad.id, value: 300, observed_at: '2026-11-19T10:00:00Z' });
  await w.seed('metric_observation', { ...snapshot, subject_id: child.id, value: 300, observed_at: '2026-11-19T10:00:00Z' });
  const consume = (id: string) => w.transaction(ctx => subscribers[0]!.run(ctx, { type: 'analytics.observations.recorded', data: { subject_type: 'ads.ad_entity', subject_id: id } }));
  await consume(child.id);
  await consume(ad.id);
  await consume(ad.id);
  await w.seed('metric_observation', { ...snapshot, subject_id: ad.id, value: 350, observed_at: '2026-11-19T11:00:00Z' });
  await consume(ad.id);
  const entries = await w.raw('cost_entry');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.amount_minor, 350);
});

test('signed creator terms and settled commission enter separate ledgers', async () => {
  const { w, campaign, params } = await fixture();
  await w.run('campaign_budget_line_create', { amount_minor: 1000, category: 'creator', currency: 'USD', fx_date: '2026-11-19' }, params);
  const collaboration = await w.seed('collaboration', { campaign_id: campaign.id });
  const terms = await w.seed('collaboration_terms', { collaboration_id: collaboration.id, sign_status: 'signed', signed_at: time, fee: { amount_minor: 200, currency: 'USD' } });
  await w.transaction(ctx => ctx.update('collaboration', collaboration.id, { current_terms_revision_id: terms.id }));
  const commission = await w.seed('commission_entry', { collaboration_id: collaboration.id, kind: 'accrual', status: 'platform_settled', commission_minor: 100, currency: 'USD', settled_at: time });
  const consume = (type: string, data: Data) => w.transaction(ctx => subscribers[0]!.run(ctx, { type, data }));
  for (let attempt = 0; attempt < 2; attempt++) {
    await consume('creator.terms.signed', { collaboration_id: collaboration.id, terms_revision_id: terms.id });
    await consume('creator.commission.platform_settled', { commission_entry_id: commission.id });
  }
  const summary = await w.run<{ lines: Data[] }>('campaign_budget_summary', {}, params);
  assert.equal(summary.lines[0]!.open_commitment_minor, 200);
  assert.equal(summary.lines[0]!.actual_minor, 100);
  assert.equal(summary.lines[0]!.remaining_minor, 700);
});

test('campaign pause is applied through the Publishing switch and replay is harmless', async () => {
  const { w, campaign, params } = await fixture();
  await w.run('campaign_goal_create', goalData, params);
  const planned = await w.run('campaign_transition', { to: 'planned' }, params, campaign.version);
  const active = await w.run('campaign_transition', { to: 'active' }, params, planned.version);
  const target = await w.seed('publish_target', { campaign_id: campaign.id, plan_status: 'ready' });
  await w.run('campaign_transition', { to: 'paused', reason: 'Editorial hold' }, params, active.version);
  const data = w.events.find(event => event.type === 'campaign.campaign.status_changed' && event.data.to === 'paused')!.data;
  for (let attempt = 0; attempt < 2; attempt++) {
    await w.transaction(ctx => subscribers[1]!.run(ctx, { type: 'campaign.campaign.status_changed', data }));
  }
  assert.equal((await w.raw('pause_switch')).length, 1);
  assert.equal((await w.raw('publish_target')).find(row => row.id === target.id)?.plan_status, 'paused');
});
