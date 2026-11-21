import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Context, type Data, type Operation, type Role, type Row } from '@smartsell/contracts';
import { operations as agentOperations } from '../../agent/operations.js';
import { operations as assetOperations } from '../../asset/index.js';
import { briefOperations } from '../../campaign/brief-operations.js';
import { catalogOperations } from '../../commerce/catalog-operations.js';
import { operations as planningOperations } from '../../planning/index.js';
import { decisionsViewOperations, type DecisionAction, type DecisionItem } from './decisions.js';

type TestContext = Context & { agentCredentialId?: string };
function fixture() {
  const rows = new Map<string, Row[]>();
  let next = 0;
  const ctx: TestContext = {
    workspaceId: 'w1', tenantId: 't1', actorId: 'owner', role: 'owner', now: '2026-11-20T08:00:00.000Z',
    list: kind => rows.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind}: ${id}`);
      return row;
    },
    create(kind, values) {
      const row = { ...structuredClone(values), id: `r${++next}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, patch) {
      const previous = ctx.get(kind, id);
      const row = { ...previous, ...structuredClone(patch), id, version: previous.version + 1, updated_at: ctx.now };
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? row : item));
      return row;
    },
    remove(kind, id) { rows.set(kind, ctx.list(kind).filter(item => item.id !== id)); },
    emit() {},
  };
  const as = (role: Role, actorId = ctx.actorId, credential?: string): TestContext => ({ ...ctx, role, actorId, agentCredentialId: credential });
  async function run<T>(ops: Operation[], name: string, input: { body?: Data; params?: Record<string, string>; query?: Record<string, string>; expectedVersion?: number } = {}, caller: TestContext = ctx): Promise<T> {
    const op = ops.find(item => item.name === name)!;
    assert.ok(op.roles.includes(caller.role), `${caller.role} may not run ${name}`);
    return await op.run(caller, { body: {}, params: {}, query: {}, ...input }) as T;
  }
  const list = (query: Record<string, string> = {}, caller: TestContext = ctx) => run<DecisionItem[]>(decisionsViewOperations, 'views_decisions_list', { query }, caller);
  const summary = (query: Record<string, string> = {}, caller: TestContext = ctx) => run<{ counts: Record<string, number>; total: number; hidden_kinds: string[] }>(decisionsViewOperations, 'views_decisions_summary', { query }, caller);
  /** Sends an action the way the web client does, including the REST dispatcher's If-Match check. */
  async function send(ops: Operation[], action: DecisionAction, reason?: string, caller: TestContext = ctx) {
    const op = ops.find(item => {
      if (item.method !== action.method) return false;
      const names: string[] = [];
      const pattern = new RegExp(`^${item.path.replace(/:([A-Za-z_]+)/g, (_, key: string) => { names.push(key); return '([^/]+)'; })}$`);
      return pattern.test(action.path);
    });
    assert.ok(op, `no operation serves ${action.method} ${action.path}`);
    const names: string[] = [];
    const pattern = new RegExp(`^${op.path.replace(/:([A-Za-z_]+)/g, (_, key: string) => { names.push(key); return '([^/]+)'; })}$`);
    const params = Object.fromEntries(names.map((key, index) => [key, decodeURIComponent(pattern.exec(action.path)![index + 1]!)]));
    assert.ok(op.roles.includes(caller.role));
    if (op.versionKind) {
      assert.notEqual(action.version, null, `${op.name} requires If-Match`);
      assert.equal(caller.get(op.versionKind, params.id!).version, action.version);
    }
    if (action.requires_reason) assert.ok(reason, `${op.name} requires a reason`);
    const body = { ...action.body, ...(reason && action.reason_field ? { [action.reason_field]: reason } : {}) };
    return await op.run(caller, { body, params, query: {}, expectedVersion: action.version ?? undefined }) as Row;
  }
  return { ctx, as, run, list, summary, send };
}
const find = (items: DecisionItem[], kind: string) => items.find(item => item.kind === kind)!;
const action = (item: DecisionItem, key: string) => item.actions.find(entry => entry.key === key)!;

async function publishFixture(f: ReturnType<typeof fixture>) {
  const { ctx, run } = f;
  await run(planningOperations, 'publishing_create_approval_policy', { body: { name: 'Review', steps: [{ order: 1, approvers: { roles: ['owner', 'reviewer'] }, min_approvals: 1 }] } });
  ctx.create('brand', { name: 'Brand', status: 'active' });
  const account = ctx.create('social_account', { provider: 'meta_facebook', platform: 'facebook', handle: '@brand', status: 'active', brand_id: 'r2', default_timezone: 'UTC' });
  const content = ctx.create('content_item', { brand_id: 'r2', title: 'Winter launch' });
  const variant = ctx.create('content_variant', { content_item_id: content.id, platform: 'facebook', format: 'text', locale: 'en', readiness: 'ready' });
  const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'v1', rendered: { text: 'Hello winter' }, media: [] });
  ctx.update('content_variant', variant.id, { current_revision_id: revision.id });
  const target = await run<Row>(planningOperations, 'publishing_create_target', { body: { social_account_id: account.id, content_variant_id: variant.id, scheduled_at: '2026-11-20T20:00:00Z' } }, f.as('editor', 'editor-1', 'cred-claude'));
  await run(planningOperations, 'publishing_request_approval', { params: { id: target.id } }, f.as('editor', 'editor-1', 'cred-claude'));
  ctx.create('activity_event', { occurred_at: ctx.now, action: 'publishing_request_approval', actor_id: 'editor-1', actor_type: 'agent', credential_id: 'cred-claude', credential_label: 'Claude Code', source: 'mcp' });
  return { target };
}

test('publish approvals carry the hash, version and paths the planning endpoints accept', async () => {
  const f = fixture();
  const { target } = await publishFixture(f);
  const item = find(await f.list(), 'publish_approval');
  const current = f.ctx.get('publish_target', target.id);
  const request = f.ctx.get('approval_request', String(current.approval_request_id));
  assert.equal(item.id, `publish_approval:${request.id}`);
  assert.deepEqual(item.requested_by, { type: 'agent', label: 'Claude Code' });
  assert.deepEqual(item.resource, { type: 'publish_target', id: target.id, version: current.version, hash: request.resource_hash, route: null });
  assert.equal(item.title, 'Winter launch');
  assert.equal(item.severity, 'high');
  assert.equal(item.brand_id, 'r2');
  assert.equal(item.preview.text, 'Hello winter');
  assert.equal(item.preview.scheduled_at, '2026-11-20T20:00:00.000Z');
  assert.deepEqual(item.actions.map(entry => [entry.key, entry.path, entry.version]), [
    ['approve', `/publish-targets/${target.id}/approve`, current.version],
    ['request_changes', `/publish-targets/${target.id}/request-changes`, current.version],
    ['reject', `/publish-targets/${target.id}/reject`, current.version],
  ]);
  assert.deepEqual(action(item, 'approve').body, { resource_hash: request.resource_hash, approval_request_id: request.id });
  await f.send(planningOperations, action(item, 'approve'));
  assert.equal(f.ctx.get('approval_request', request.id).status, 'approved');
  assert.equal((await f.list()).length, 0);
});

test('agent callers and roles outside the approval step see decisions without actions', async () => {
  const f = fixture();
  await publishFixture(f);
  const agent = await f.list({}, f.as('owner', 'owner', 'cred-claude'));
  assert.equal(agent.length, 1);
  assert.deepEqual(agent[0]!.actions, []);
  assert.deepEqual((await f.list({}, f.as('agent', 'bot')))[0]!.actions, []);
  assert.deepEqual((await f.list({}, f.as('viewer', 'viewer-1')))[0]!.actions, []);
  assert.equal((await f.list({}, f.as('reviewer', 'reviewer-1')))[0]!.actions.length, 3);
});

test('change sets and agent job reviews map to the agent module decision endpoints', async () => {
  const f = fixture();
  const { ctx, run, send } = f;
  const task = ctx.create('work_item', { title: 'Old title', type: 'task', status: 'open', created_by_id: 'owner' });
  const agent = f.as('owner', 'owner', 'cred-claude');
  await run(agentOperations, 'change_sets_create', { body: { title: 'Tidy titles', rationale: 'Shorter', items: [{ target_type: 'work_item', target_id: task.id, expected_version: task.version, patch: { title: 'New title' } }] } }, agent);
  const job = await run<Row>(agentOperations, 'agent_jobs_create', { body: { title: 'Write captions' } });
  const claimed = await run<Row>(agentOperations, 'agent_jobs_claim', { params: { id: job.id }, expectedVersion: ctx.get('agent_job', job.id).version }, agent);
  await run(agentOperations, 'agent_jobs_submit_result', { params: { id: job.id }, expectedVersion: claimed.version, body: { fencing_token: claimed.fencing_token, result_ref: { note: 'Drafted 3 captions' } } }, agent);
  ctx.create('activity_event', { occurred_at: ctx.now, action: 'agent_jobs_submit_result', actor_id: 'owner', actor_type: 'agent', credential_id: 'cred-codex', credential_label: 'Codex', source: 'mcp', resource_id: job.id });

  const items = await f.list();
  const change = find(items, 'change_set');
  assert.equal(change.requested_by.type, 'agent');
  assert.deepEqual(change.preview.fields, [{ label: ['Old title · 標題', 'Old title · Title'], before: 'Old title', after: 'New title' }]);
  assert.deepEqual(action(change, 'reject'), { key: 'reject', label: ['拒絕', 'Reject'], method: 'POST', path: `/change-sets/${change.resource.id}/reject`, version: change.resource.version, body: {}, requires_reason: true, reason_field: 'reason', tone: 'danger' });
  await send(agentOperations, action(change, 'apply'));
  assert.equal(ctx.get('work_item', task.id).title, 'New title');

  const review = find(items, 'agent_job_review');
  assert.deepEqual(review.requested_by, { type: 'agent', label: 'Codex' });
  assert.equal(review.preview.text, 'Drafted 3 captions');
  const back = action(review, 'return');
  assert.equal(back.reason_field, 'note');
  assert.equal(back.requires_reason, true);
  await send(agentOperations, back, 'Use the brand tone');
  assert.equal(ctx.get('agent_job', job.id).status, 'returned');
  assert.deepEqual((await f.list()).map(item => item.kind), []);
});

test('brief, knowledge and fact decisions follow their owning endpoints', async () => {
  const f = fixture();
  const { ctx, run, send } = f;
  const brand = ctx.create('brand', { name: 'Brand', status: 'active' });
  const campaign = ctx.create('campaign', { brand_id: brand.id, name: 'Winter', status: 'active' });
  const brief = ctx.create('brief', { campaign_id: campaign.id, kind: 'main', title: 'Main brief' });
  const revision = ctx.create('brief_revision', { brief_id: brief.id, revision_no: 1, status: 'in_review', body_doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Launch in December' }] }] }, requirements: [], fact_refs: [], created_by_type: 'agent_client' });
  ctx.update('brief', brief.id, { current_revision_id: revision.id });
  await run(assetOperations, 'knowledge_propose', { body: { brand_id: brand.id, kind: 'tone', title: 'Voice', body: 'Warm and direct' } }, f.as('agent', 'bot'));
  const product = ctx.create('product', { title: 'Wool scarf', brand_id: brand.id });
  const fact = ctx.create('product_fact', { product_id: product.id, brand_id: brand.id, category: 'claim', fact_key: 'warmth', status: 'active' });
  const draft = ctx.create('product_fact_revision', { fact_id: fact.id, category: 'claim', value: { type: 'text', text: 'Warmest scarf' }, evidence_urls: [], evidence_ids: [], source: { kind: 'agent' }, review_status: 'draft' });
  ctx.update('product_fact', fact.id, { current_revision_id: draft.id });

  const items = await f.list();
  // An Agent connection runs with its person's role, yet unapproved fact and knowledge text never reaches it.
  const agentKinds = (await f.list({}, f.as('owner', 'owner', 'cred-claude'))).map(item => item.kind);
  assert.ok(agentKinds.includes('brief_revision'));
  assert.ok(!agentKinds.includes('knowledge_revision') && !agentKinds.includes('fact_revision'));
  const briefItem = find(items, 'brief_revision');
  assert.equal(briefItem.campaign_id, campaign.id);
  assert.equal(briefItem.resource.route, `/plans/${campaign.id}`);
  assert.equal(briefItem.preview.text, 'Launch in December');
  assert.equal(action(briefItem, 'request_changes').requires_reason, true);
  await send(briefOperations, action(briefItem, 'request_changes'), 'Add the price');
  assert.equal(ctx.get('brief_revision', revision.id).status, 'changes_requested');

  const knowledge = find(items, 'knowledge_revision');
  assert.equal(knowledge.requested_by.type, 'agent');
  await send(assetOperations, action(knowledge, 'approve'));
  assert.equal(ctx.list('knowledge_entry')[0]!.status, 'active');

  const factItem = find(items, 'fact_revision');
  assert.deepEqual(factItem.actions.map(entry => [entry.key, entry.version, entry.reason_field]), [['reject', null, null]]);
  assert.equal(factItem.resource.route, `/products/${product.id}`);
  await send(catalogOperations, action(factItem, 'reject'));
  assert.equal(ctx.get('product_fact_revision', draft.id).review_status, 'rejected');
  assert.deepEqual((await f.list({}, f.as('agent', 'bot'))).filter(item => item.kind === 'fact_revision'), []);
});

test('seeded decision kinds expose the documented request shapes and role visibility', async () => {
  const f = fixture();
  const { ctx } = f;
  const brand = ctx.create('brand', { name: 'Brand', status: 'active' });
  const other = ctx.create('brand', { name: 'Other', status: 'active' });
  const campaign = ctx.create('campaign', { brand_id: brand.id, name: 'Winter', status: 'active' });
  const budget = ctx.create('approval_request', { resource_type: 'budget_line', resource_id: 'line-1', resource_hash: 'h', status: 'pending', current_step: 1,
    context: { campaign_id: campaign.id, category: 'ads', currency: 'TWD', budget_minor: 100_000, actual_minor: 130_000, open_commitment_minor: 0, overrun_minor: 30_000 } });
  const target = ctx.create('publish_target', { brand_id: other.id, title: 'Late post', scheduled_at: '2026-11-20T06:00:00.000Z', plan_status: 'ready' });
  const task = ctx.create('execution_task', { publish_target_id: target.id, status: 'blocked', sub_status: 'late_awaiting_decision', due_at: '2026-11-20T06:00:00.000Z', delay_minutes: 120 });
  const account = ctx.create('ad_account', { brand_id: brand.id, name: 'Meta TW', currency: 'TWD', permissions: [{ actor_id: 'manager-1', actions: ['read'] }] });
  const revision = ctx.create('ad_proposal_revision', { objective: 'traffic', budget: { type: 'daily', amount_minor: 50_000, currency: 'TWD', cap_minor: 60_000 }, schedule: { starts_at: '2026-11-21T00:00:00.000Z', ends_at: '2026-11-28T00:00:00.000Z', tz: 'Asia/Taipei' }, estimates: [], content_hash: 'ad-hash' });
  const proposal = ctx.create('ad_proposal', { ad_account_id: account.id, brand_id: brand.id, campaign_id: campaign.id, name: 'Winter traffic', status: 'in_review', current_revision_id: revision.id, created_via: 'agent' });
  const conversation = ctx.create('conversation', { brand_id: brand.id, status: 'open', priority: 'urgent' });
  const reply = ctx.create('reply_draft', { conversation_id: conversation.id, body_text: 'Thanks!', status: 'pending_approval', auto_rule_id: 'rule-1', reply_mode: 'public_reply' });
  const product = ctx.create('product', { title: 'Scarf', brand_id: brand.id });
  const current = ctx.create('product_localization_revision', { text: '羊毛圍巾', origin: 'agent', content_hash: 'loc' });
  const localization = ctx.create('product_localization', { product_id: product.id, field_key: 'title', locale: 'zh-TW', status: 'in_review', current_revision_id: current.id });

  const items = await f.list();
  assert.deepEqual(items.map(item => item.kind), ['late_decision', 'ad_proposal', 'budget_approval', 'reply_draft', 'localization']);
  const late = find(items, 'late_decision');
  assert.deepEqual(late.actions.map(entry => [entry.key, entry.path, entry.body, entry.version]), ['run_now', 'reschedule', 'skip']
    .map(decision => [decision, `/execution-tasks/${task.id}/late-decision`, { decision }, task.version]));
  assert.equal(late.requested_by.type, 'rule');
  const money = find(items, 'budget_approval');
  assert.deepEqual(money.actions.map(entry => [entry.path, entry.body, entry.version, entry.requires_reason]), [
    [`/campaigns/${campaign.id}/budget-approvals/${budget.id}/decide`, { decision: 'approve' }, budget.version, true],
    [`/campaigns/${campaign.id}/budget-approvals/${budget.id}/decide`, { decision: 'reject' }, budget.version, true],
  ]);
  assert.deepEqual(money.preview.fields.at(-1), { label: ['超支', 'Overrun'], before: null, after: 30_000, unit: 'currency', currency: 'TWD' });
  const replyItem = find(items, 'reply_draft');
  assert.equal(replyItem.severity, 'high');
  assert.deepEqual(replyItem.actions.map(entry => [entry.key, entry.path, entry.version]), [['approve', `/reply-drafts/${reply.id}/approve`, reply.version], ['reject', `/reply-drafts/${reply.id}/reject`, reply.version]]);
  const ad = find(items, 'ad_proposal');
  assert.deepEqual(ad.requested_by, { type: 'agent', label: null });
  assert.deepEqual(ad.preview.budget, revision.budget);
  assert.deepEqual(ad.actions.map(entry => [entry.path, entry.body, entry.version, entry.reason_field]), [
    [`/ad-proposals/${proposal.id}/decide`, { decision: 'approved' }, proposal.version, 'reason'],
    [`/ad-proposals/${proposal.id}/decide`, { decision: 'rejected' }, proposal.version, 'reason'],
  ]);
  assert.deepEqual(find(items, 'localization').actions.map(entry => [entry.path, entry.version]), [[`/localizations/${localization.id}/approve`, localization.version], [`/localizations/${localization.id}/reject`, localization.version]]);

  const manager = await f.list({}, f.as('manager', 'manager-1'));
  assert.deepEqual(find(manager, 'ad_proposal').actions, []);
  const viewer = f.as('viewer', 'viewer-1');
  assert.deepEqual((await f.list({}, viewer)).map(item => item.kind), ['late_decision', 'reply_draft', 'localization']);
  assert.deepEqual(await f.summary({}, viewer), { counts: { publish_approval: 0, change_set: 0, agent_job_review: 0, reply_draft: 1, ad_proposal: 0, brief_revision: 0,
    fact_revision: 0, knowledge_revision: 0, localization: 1, late_decision: 1 }, total: 3, hidden_kinds: ['budget_approval'], as_of: ctx.now });
  assert.deepEqual((await f.list({ brand_id: other.id })).map(item => item.kind), ['late_decision']);
  assert.deepEqual((await f.list({ kind: 'reply_draft,ad_proposal' })).map(item => item.kind), ['ad_proposal', 'reply_draft']);
  assert.deepEqual((await f.summary({ campaign_id: campaign.id })).total, 2);
  await assert.rejects(f.list({ kind: 'nope' }), (error: unknown) => error instanceof Problem && error.status === 422);
  assert.deepEqual((await f.list({}, f.as('owner', 'owner', 'cred-claude'))).flatMap(item => item.actions), []);
  // The decisions page heads its brand- or plan-filtered list with this summary, so both count the same scope.
  for (const query of [{ brand_id: brand.id }, { brand_id: other.id }, { campaign_id: campaign.id }, { brand_id: brand.id, campaign_id: campaign.id }] as Record<string, string>[]) {
    const rows = await f.list(query), head = await f.summary(query);
    assert.equal(head.total, rows.length);
    for (const [kind, n] of Object.entries(head.counts)) assert.equal(n, rows.filter(row => row.kind === kind).length, `${JSON.stringify(query)} ${kind}`);
  }
});

test('each kind is read once per request however many approvals and change sets are pending', async () => {
  const f = fixture();
  const { ctx } = f;
  const steps = [{ order: 1, approvers: { roles: ['owner'] }, min_approvals: 1 }];
  const requests = [0, 1, 2].map(n => {
    const request = ctx.create('approval_request', { resource_type: 'planning.publish_target', status: 'pending', resource_hash: `h${n}`, steps, current_step: 1, due_at: '2026-11-22T00:00:00.000Z' });
    const target = ctx.create('publish_target', { plan_status: 'awaiting_approval', approval_request_id: request.id, frozen_hash: `h${n}`, title: `Post ${n}`, scheduled_at: '2026-11-23T00:00:00.000Z' });
    return ctx.update('approval_request', request.id, { resource_id: target.id });
  });
  // The owner already decided the first request; someone else decided the second.
  ctx.create('approval_decision', { request_id: requests[0]!.id, step_no: 1, decided_by_user_id: 'owner' });
  ctx.create('approval_decision', { request_id: requests[1]!.id, step_no: 1, decided_by_user_id: 'reviewer-1' });
  const sets = [0, 1].map(n => {
    const set = ctx.create('change_set', { status: 'pending', title: `Set ${n}` });
    ctx.create('change_set_item', { change_set_id: set.id, status: 'pending', target_type: 'work_item', target_id: 'w', preview: { title: { before: `a${n}`, after: `b${n}` } } });
    ctx.create('change_set_item', { change_set_id: set.id, status: 'applied', target_type: 'work_item', target_id: 'w', preview: { title: { before: 'x', after: 'y' } } });
    return set;
  });

  const reads: string[] = [];
  const counting: TestContext = { ...ctx, list: kind => { reads.push(kind); return ctx.list(kind); } };
  const items = await f.list({}, counting);
  assert.deepEqual(reads.filter((kind, index) => reads.indexOf(kind) !== index), []);
  const byId = new Map(items.map(item => [item.id, item]));
  assert.deepEqual(requests.map(request => byId.get(`publish_approval:${request.id}`)!.actions.length), [0, 3, 3]);
  assert.deepEqual(sets.map(set => byId.get(`change_set:${set.id}`)!.preview.fields.map(field => [field.before, field.after])), [[['a0', 'b0']], [['a1', 'b1']]]);
});

test('counting reads neither previews nor the activity log, yet counts exactly what the list shows', async () => {
  const f = fixture();
  const { ctx } = f;
  await publishFixture(f);
  const conversation = ctx.create('conversation', { brand_id: 'r2', status: 'open' });
  const message = ctx.create('message', { conversation_id: conversation.id, body_text: 'Is it warm?' });
  ctx.create('reply_draft', { conversation_id: conversation.id, in_reply_to_message_id: message.id, body_text: 'Very', status: 'pending_approval' });
  ctx.create('agent_job', { status: 'submitted', title: 'Captions', assignee_type: 'agent_client', lease_credential_id: 'cred-claude' });

  const reads = new Set<string>();
  const counting: TestContext = { ...ctx, list: kind => { reads.add(kind); return ctx.list(kind); } };
  const head = await f.summary({}, counting);
  // Labels sort the whole activity log and previews read revisions and messages; a badge needs neither.
  assert.deepEqual(['activity_event', 'content_revision', 'message', 'approval_decision'].filter(kind => reads.has(kind)), []);
  const items = await f.list({}, counting);
  assert.ok(reads.has('activity_event') && reads.has('content_revision') && reads.has('message'));
  assert.deepEqual(items.map(item => item.kind).sort(), ['agent_job_review', 'publish_approval', 'reply_draft']);
  assert.equal(head.total, items.length);
  assert.equal(find(items, 'publish_approval').requested_by.label, 'Claude Code');
});
