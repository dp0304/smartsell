import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, type Context, type Entity, type Fields, type Role } from '../types.ts';
import { commands } from './index.ts';

function workspace() {
  let entries = new Map<string, Entity>();
  const events: { type: string; payload: Fields }[] = [];
  let sequence = 0;
  const now = '2026-04-20T12:00:00.000Z';
  const ctx: Context = {
    role: 'owner', actorId: 'owner', workspaceId: 'workspace', tenantId: 'tenant', now,
    async get(module, kind, id) { return structuredClone(entries.get(`${module}.${kind}.${id}`)); },
    async list(module, kind) { return structuredClone([...entries.values()].filter(row => row.module === module && row.kind === kind)); },
    async insert(module, kind, data, id = String(++sequence)) {
      const key = `${module}.${kind}.${id}`;
      if (entries.has(key)) throw new Error('Duplicate resource');
      const row = { id, module, kind, data, version: 1, tenant_id: this.tenantId, workspace_id: this.workspaceId, created_at: this.now, updated_at: this.now };
      entries.set(key, structuredClone(row));
      return structuredClone(row);
    },
    async update(module, kind, id, patch, expectedVersion) {
      const row = await this.get(module, kind, id);
      if (!row || row.version !== expectedVersion) throw new Error('Stale resource');
      const updated = { ...row, version: row.version + 1, data: { ...row.data, ...patch }, updated_at: this.now };
      entries.set(`${module}.${kind}.${id}`, structuredClone(updated));
      return structuredClone(updated);
    },
    async emit(type, payload) { events.push({ type, payload }); },
  };
  async function run<T = any>(action: string, input: Fields = {}, role: Role = 'owner'): Promise<T> {
    const saved = structuredClone(entries);
    const eventCount = events.length;
    try { return await commands[action].run({ ...ctx, role }, input) as T; }
    catch (error) { entries = saved; events.splice(eventCount); throw error; }
  }
  return { ctx, events, run };
}

const goal = { metric_key: 'reach', unit: 'count', baseline_value: 0, target_value: 100, due_at: '2026-04-25T00:00:00Z' };
const draft = { brand_id: 'brand', name: 'New collection', kind: 'launch', starts_at: '2026-04-19T10:00:00+01:00', ends_at: '2026-04-25T00:00:00Z' };
const domainCode = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
async function fixture() {
  const db = workspace();
  await db.ctx.insert('workspace', 'brand', {}, 'brand');
  await db.ctx.insert('workspace', 'market', {}, 'market');
  await db.ctx.insert('analytics', 'metric_definition', { key: 'reach' });
  return db;
}
async function campaignInWrapping(run: Awaited<ReturnType<typeof fixture>>['run']) {
  let row = await run<Entity>('create_draft', { ...draft, goals: [goal] });
  for (const to of ['planned', 'active', 'wrapping']) row = await run<Entity>('transition', { campaign_id: row.id, to, expected_version: row.version });
  return row;
}

test('campaign requires goal units, baseline, cutoff and existing metric, and protects status, versions and tracking key', async () => {
  const { run, ctx } = await fixture();
  for (const invalidGoal of [{ unit: undefined }, { due_at: undefined }, { baseline_value: undefined }, { metric_key: 'missing' }]) {
    await assert.rejects(run('create_draft', { ...draft, goals: [{ ...goal, ...invalidGoal }] }), domainCode('invalid_input'));
  }
  assert.equal((await ctx.list('campaign', 'campaign')).length, 0);
  const campaign = await run<Entity>('create_draft', { ...draft, utm_key: 'launch', markets: [{ market_id: 'market', locales: ['en-gb'] }], goals: [{ ...goal, market_id: 'market' }] });
  assert.equal(campaign.data.starts_at, '2026-04-19T09:00:00.000Z');
  const context = await run('get_context', { campaign_id: campaign.id }, 'viewer');
  assert.equal(context.goals[0].goal.data.campaign_market_id, context.markets[0].id);
  assert.equal(context.goals[0].progress, null);
  const command = { campaign_id: campaign.id, expected_version: 1 };
  await assert.rejects(run('update', { ...command, patch: { utm_key: 'renamed' } }), domainCode('invalid_input'));
  await assert.rejects(run('transition', { ...command, to: 'active' }), domainCode('conflict'));
  await assert.rejects(run('transition', { ...command, to: 'planned' }, 'viewer'), domainCode('forbidden'));
  const planned = await run<Entity>('transition', { ...command, to: 'planned' });
  const [active] = await run<Entity[]>('auto_transition');
  assert.equal(active.data.status, 'active');
  await assert.rejects(run('transition', { ...command, expected_version: planned.version, to: 'paused' }), domainCode('version_conflict'));
  assert.equal((await run('prepare_link', { campaign_id: campaign.id })).utm_params.utm_campaign, 'launch');
});

test('brief preserves approved content across drafts and review supersedes only the earlier approval', async () => {
  const { run } = await fixture();
  const { id: campaign_id } = await run<Entity>('create_draft', draft);
  const brief = await run<Entity>('create_brief', { campaign_id, title: 'Strategy' });
  const common = { campaign_id, brief_id: brief.id };
  const first = await run('update_brief_draft', { ...common, expected_version: brief.version, markdown: 'Initial copy' });
  const submitted = await run<Entity>('submit_brief_revision', { ...common, revision_id: first.revision.id, expected_version: first.revision.version });
  await run('approve_brief_revision', { ...common, revision_id: submitted.id, expected_version: submitted.version }, 'reviewer');
  const [current] = await run<Entity[]>('list_briefs', { campaign_id });
  const second = await run('update_brief_draft', { ...common, expected_version: current.version, markdown: 'Second copy' });
  assert.equal((await run('get_context', { campaign_id })).briefs[0].approved_revision.id, first.revision.id);
  const next = await run<Entity>('submit_brief_revision', { ...common, revision_id: second.revision.id, expected_version: second.revision.version });
  await run('approve_brief_revision', { ...common, revision_id: next.id, expected_version: next.version }, 'reviewer');
  const revisions = await run<Entity[]>('list_brief_revisions', common);
  assert.deepEqual(revisions.map(row => row.data.status), ['superseded', 'approved']);
  assert.equal(revisions[0].data.body_doc.content[0].content[0].text, 'Initial copy');
});

test('matrix counts each target and keeps scheduling separate from completed milestones', async () => {
  const { run, ctx, events } = await fixture();
  const { id: campaign_id } = await run<Entity>('create_draft', draft);
  await run('create_plan_slot', { campaign_id, platform: 'instagram', stage: 'launch', planned_count: 3 });
  const item = await ctx.insert('content', 'content_item', { campaign_id, production_due_at: '2026-04-20T00:00:00Z' });
  const variant = await ctx.insert('content', 'content_variant', { content_item_id: item.id, platform: 'instagram' });
  for (const account_id of ['a', 'b', 'c']) {
    await ctx.insert('account', 'social_account', { platform: 'instagram' }, account_id);
    await ctx.insert('planning', 'publish_target', { content_variant_id: variant.id, account_id, scheduled_at: '2026-04-21T00:00:00Z', status: 'scheduled' });
  }
  await ctx.insert('account', 'social_account', { platform: 'youtube' }, 'outside');
  await ctx.insert('planning', 'publish_target', { content_variant_id: variant.id, account_id: 'outside', scheduled_at: '2026-04-21T00:00:00Z', status: 'draft' });
  const [first, second] = await run<Entity[]>('create_tasks', { campaign_id, tasks: [
    { key: 'shoot', kind: 'campaign_milestone', title: 'Shoot', due_at: '2026-04-21T00:00:00Z', gate: 'ready_for_scheduling' },
    { key: 'edit', kind: 'campaign_milestone', title: 'Edit', due_at: '2026-04-23T00:00:00Z', dependencies: [{ predecessor: 'shoot' }] },
  ] });
  assert.equal((await run('list_milestones', { campaign_id })).find((row: any) => row.item.id === second.id).blocked, true);
  await run('check_milestones', { campaign_id });
  await run('check_milestones', { campaign_id });
  assert.equal(events.filter(event => event.type === 'campaign.milestone.delayed').length, 1);
  await ctx.update('workspace', 'work_item', first.id, { status: 'done' }, 1);
  const after = await run('list_milestones', { campaign_id });
  assert.equal(after.find((row: any) => row.item.id === first.id).ready_for_scheduling, true);
  assert.equal(after.find((row: any) => row.item.id === second.id).blocked, false);
  const matrix = await run('matrix', { campaign_id });
  assert.equal(matrix.cells[0].counts.scheduled, 3);
  assert.equal(matrix.cells[0].counts.published, 0);
  assert.equal(matrix.cells[0].gap, 0);
  assert.deepEqual(matrix.cells[0].actual.map((row: Fields) => row.social_account_id), ['a', 'b', 'c']);
  assert.deepEqual(matrix.cells[0].actual.map((row: Fields) => row.production_due_at), Array(3).fill('2026-04-20T00:00:00Z'));
  assert.equal(matrix.unplanned.length, 1);
  assert.equal(matrix.unplanned[0].phase, 'in_production');
});

test('budget preserves original currency and dates, avoids double counting, and emits an overrun without rejecting actual spend', async () => {
  const { run, events } = await fixture();
  const { id: campaign_id } = await run<Entity>('create_draft', draft);
  const line = await run<Entity>('create_budget_line', { campaign_id, category: 'ads', amount_minor: 1000, currency: 'USD', fx_date: '2026-04-20' });
  await run('create_budget_line', { campaign_id, category: 'sample', amount_minor: 50, currency: 'EUR', fx_date: '2026-04-19' });
  const commitment = await run<Entity>('create_cost_commitment', { campaign_id, budget_line_id: line.id, amount_minor: 800, source_ref: 'ads:proposal-1' });
  assert.equal((await run('budget_summary', { campaign_id })).lines[0].outstanding_minor, 0);
  await run('transition_cost_commitment', { campaign_id, commitment_id: commitment.id, expected_version: commitment.version, to: 'committed', approval_ref: 'approval-1' });
  const cost = { campaign_id, budget_line_id: line.id, incurred_on: '2026-04-20' };
  const entry = await run<Entity>('create_cost_entry', { ...cost, commitment_id: commitment.id, amount_minor: 300, fx_date: '2026-04-18', attachment_file_ids: ['invoice'] });
  assert.equal(entry.data.fx_date, '2026-04-18');
  assert.deepEqual(entry.data.attachment_file_ids, ['invoice']);
  await assert.rejects(run('create_cost_entry', { ...cost, amount_minor: 1, currency: 'EUR' }), domainCode('invalid_input'));
  const extra = await run<Entity>('create_cost_entry', { ...cost, amount_minor: 300 });
  const budget = await run('budget_summary', { campaign_id });
  assert.deepEqual(budget.totals.map((row: any) => [row.currency, row.remaining_minor]), [['USD', -100], ['EUR', 50]]);
  assert.equal(budget.lines[0].actual_minor, 600);
  assert.equal(budget.lines[0].outstanding_minor, 500);
  const overruns = events.filter(event => event.type === 'campaign.budget.overrun_detected');
  assert.equal(overruns.length, 1);
  assert.ok(overruns[0].payload.approval_request_id);
  await run('void_cost_entry', { campaign_id, cost_entry_id: extra.id, expected_version: extra.version, reason: 'Duplicate invoice' });
  assert.equal((await run('budget_summary', { campaign_id })).lines[0].remaining_minor, 200);
});

test('closeout requires unfinished items to be acknowledged and keeps the chosen report version frozen', async () => {
  const { run, ctx } = await fixture();
  const campaign = await campaignInWrapping(run);
  const campaign_id = campaign.id;
  const [goalRow] = await ctx.list('campaign', 'campaign_goal');
  const item = await ctx.insert('content', 'content_item', { campaign_id });
  const variant = await ctx.insert('content', 'content_variant', { content_item_id: item.id });
  const target = await ctx.insert('planning', 'publish_target', { content_variant_id: variant.id, account_id: 'account', status: 'scheduled' });
  const report = await ctx.insert('analytics', 'report_version', { campaign_id, status: 'finalized', data_cutoff_at: ctx.now, results: { campaign_goals: { [goalRow.id]: { value: 15, coverage: 'partial' } } } });
  const input = { campaign_id, expected_version: campaign.version, report_version_id: report.id, checklist_complete: true };
  const draft = await run('closeout_draft', { campaign_id, report_version_id: report.id });
  assert.equal(draft.snapshot.incomplete[0].id, target.id);
  assert.equal(await run('get_closeout', { campaign_id }), null);
  await assert.rejects(run('closeout', input), domainCode('conflict'));
  const closed = await run('closeout', { ...input, retained_items: { [`publish_target:${target.id}`]: 'Deferred to the next release' } });
  assert.equal(closed.campaign.data.status, 'closed');
  await ctx.insert('analytics', 'report_version', { campaign_id, status: 'finalized', data_cutoff_at: ctx.now, results: { campaign_goals: { [goalRow.id]: { value: 75 } } } });
  await ctx.update('planning', 'publish_target', target.id, { status: 'published' }, target.version);
  assert.deepEqual(await run('get_closeout', { campaign_id }), closed.closeout);
  assert.equal(closed.closeout.data.snapshot.goals[0].result.value, 15);
  await assert.rejects(run('closeout', { ...input, expected_version: closed.campaign.version }), domainCode('conflict'));
});

test('campaign links use the Traffic facade and retain the campaign identity after a rename', async () => {
  const { run, ctx } = await fixture();
  await ctx.insert('traffic', 'destination_domain', { hostname: 'shop.example.com', status: 'verified' });
  const campaign = await run<Entity>('create_draft', { ...draft, utm_key: 'summer-drop' });
  await run('update', { campaign_id: campaign.id, expected_version: campaign.version, patch: { name: 'Renamed' } });
  const input = { campaign_id: campaign.id, destination_url: 'https://shop.example.com/buy?utm_campaign=wrong', utm_params: { utm_source: 'Instagram' } };
  const { link, revision } = await run('create_link', input);
  const finalUrl = new URL(revision.data.final_url);
  assert.equal(finalUrl.searchParams.get('utm_campaign'), 'summer-drop');
  assert.equal(finalUrl.searchParams.get('utm_source'), 'instagram');
  assert.deepEqual(await run('list_links', { campaign_id: campaign.id }), [link]);
});

test('previewing a matrix gap writes nothing; filling it creates only production records', async () => {
  const { run, ctx } = await fixture();
  const { id: campaign_id } = await run<Entity>('create_draft', draft);
  const slot = await run<Entity>('create_plan_slot', { campaign_id, platform: 'instagram', stage: 'launch', planned_count: 2,
    window_start: '2026-04-20T00:00:00Z', window_end: '2026-04-24T00:00:00Z', content_format: 'reel' });
  const input = { campaign_id, slot_id: slot.id, production_due_at: '2026-04-21T00:00:00Z' };
  assert.equal((await run('create_gap_items', { ...input, dry_run: true })).count, 2);
  assert.equal((await ctx.list('content', 'content_item')).length, 0);
  const { items, tasks } = await run('create_gap_items', input);
  assert.equal(items.length, 2);
  assert.equal(tasks.length, 2);
  const result = await run('matrix', { campaign_id });
  assert.equal(result.cells[0].gap, 0);
  assert.equal(result.cells[0].counts.in_production, 2);
  assert.equal(result.calendar.length, 0);
  assert.deepEqual(await ctx.list('planning', 'publish_target'), []);
});

test('templates reuse slot and milestone timing without reusing the source records', async () => {
  const { run, ctx } = await fixture();
  const campaign = await campaignInWrapping(run);
  const campaign_id = campaign.id;
  await run('create_plan_slot', { campaign_id, platform: 'instagram', stage: 'launch', window_start: '2026-04-20T09:00:00Z',
    window_end: '2026-04-22T09:00:00Z', note: 'Price $10, expires immediately' });
  const [milestone] = await run<Entity[]>('create_tasks', { campaign_id, tasks: [{ key: 'shoot', kind: 'campaign_milestone', title: 'Licensed shoot', due_at: '2026-04-20T09:00:00Z' }] });
  await ctx.update('workspace', 'work_item', milestone.id, { status: 'done' }, milestone.version);
  await run('closeout', { campaign_id, expected_version: campaign.version, checklist_complete: true });
  const template = await run<Entity>('create_template', { campaign_id, name: 'Reusable launch' });
  assert.doesNotMatch(JSON.stringify(template.data.structure), /Price|Licensed/);
  const newCampaign = await run<Entity>('instantiate_template', { template_id: template.id, brand_id: 'brand', name: 'Next collection', starts_at: '2026-06-01T09:00:00Z' });
  assert.equal(newCampaign.data.status, 'draft');
  assert.notEqual(newCampaign.data.utm_key, campaign.data.utm_key);
  const [slot] = await run<Entity[]>('list_plan_slots', { campaign_id: newCampaign.id });
  const [work] = await run('list_milestones', { campaign_id: newCampaign.id });
  assert.equal(slot.data.window_start, '2026-06-02T09:00:00.000Z');
  assert.equal(work.item.data.due_at, '2026-06-02T09:00:00.000Z');
  assert.equal(work.item.data.status, 'open');
});
