import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { activityViewOperations, agentPresence, describeAction, type ActivityItem } from './activity.js';

function fixture() {
  const rows = new Map<string, Row[]>();
  let next = 0;
  const ctx: Context = {
    workspaceId: 'w1', tenantId: 't1', actorId: 'owner', role: 'viewer', now: '2026-11-20T12:00:00.000Z',
    list: kind => rows.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind}: ${id}`);
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: `r${String(++next).padStart(3, '0')}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update() { throw new Error('read-only'); },
    remove() { throw new Error('read-only'); },
    emit() {},
  };
  const event = (minutesAgo: number, values: Data) => ctx.create('activity_event', {
    occurred_at: new Date(Date.parse(ctx.now) - minutesAgo * 60_000).toISOString(), actor_id: 'owner', source: 'rest', ...values,
  });
  const agent = (minutesAgo: number, action: string, values: Data = {}) => event(minutesAgo, { action, actor_type: 'agent', credential_id: 'cred-claude', credential_label: 'Claude Code', source: 'mcp', ...values });
  const human = (minutesAgo: number, action: string, values: Data = {}) => event(minutesAgo, { action, actor_type: 'human', credential_id: null, ...values });
  const view = (query: Record<string, string> = {}) => activityViewOperations[0]!.run(ctx, { body: {}, params: {}, query }) as ActivityItem[];
  return { ctx, agent, human, view };
}

test('activity groups consecutive same-credential actions within ten minutes, newest first', () => {
  const { ctx, agent, human, view } = fixture();
  const campaign = ctx.create('campaign', { name: 'Winter launch' });
  const content = ctx.create('content_item', { title: 'Scarf reel' });
  const targets = [1, 2, 3].map(() => ctx.create('publish_target', { content_item_id: content.id }));
  agent(30, 'publishing_create_target', { resource_type: 'publish_target', resource_id: targets[0]!.id });
  agent(14, 'publishing_create_target', { resource_type: 'publish_target', resource_id: targets[1]!.id });
  agent(6, 'publishing_create_target', { resource_type: 'publish_target', resource_id: targets[2]!.id });
  human(5, 'publishing_approve', { resource_type: 'publish_target', resource_id: targets[2]!.id });
  agent(4, 'campaign_update', { resource_type: 'campaign', resource_id: campaign.id });
  agent(3, 'campaign_update', { resource_type: 'campaign', resource_id: campaign.id });
  agent(2, 'custom_tool_run');

  const items = view();
  assert.deepEqual(items.map(item => [item.action, item.count]), [
    ['custom_tool_run', 1], ['campaign_update', 2], ['publishing_approve', 1], ['publishing_create_target', 2], ['publishing_create_target', 1],
  ]);
  assert.deepEqual(items[0]!.summary, ['執行了 custom_tool_run', 'Ran custom_tool_run']);
  assert.deepEqual(items[1], {
    id: items[1]!.id, occurred_at: '2026-11-20T11:57:00.000Z',
    actor: { type: 'agent', user_id: 'owner', credential_id: 'cred-claude', label: 'Claude Code' },
    source: 'mcp', action: 'campaign_update', verb: 'updated', summary: ['更新了推廣計劃 ×2', 'Updated a campaign ×2'],
    resource: { type: 'campaign', id: campaign.id, title: 'Winter launch' }, count: 2,
  });
  assert.deepEqual(items[2]!.actor, { type: 'human', user_id: 'owner', credential_id: null, label: null });
  assert.equal(items[2]!.verb, 'approved');
  assert.deepEqual(items[3]!.resource, { type: 'publish_target', id: null, title: null });
  assert.deepEqual(items[4]!.resource, { type: 'publish_target', id: targets[0]!.id, title: 'Scarf reel' });
  assert.equal(items[4]!.occurred_at, '2026-11-20T11:30:00.000Z');
});

test('activity filters by actor, since and limit and validates input', () => {
  const { agent, human, view } = fixture();
  agent(50, 'content_create_item');
  human(40, 'campaign_update');
  agent(20, 'publishing_request_approval');
  human(10, 'publishing_approve', { brand_id: 'b1' });
  assert.deepEqual(view({ actor: 'agent' }).map(item => item.action), ['publishing_request_approval', 'content_create_item']);
  assert.deepEqual(view({ actor: 'human' }).map(item => item.verb), ['approved', 'updated']);
  assert.deepEqual(view({ since: '2026-11-20T11:30:00Z' }).map(item => item.action), ['publishing_approve', 'publishing_request_approval']);
  assert.deepEqual(view({ limit: '1' }).map(item => item.action), ['publishing_approve']);
  assert.throws(() => view({ actor: 'robot' }), (error: unknown) => error instanceof Problem && error.status === 422);
  assert.throws(() => view({ since: 'yesterday' }), (error: unknown) => error instanceof Problem && error.status === 422);
  assert.throws(() => view({ brand_id: 'missing' }), (error: unknown) => error instanceof Problem && error.status === 404);
});

test('agent presence is unknown without attributed events and counts credentials seen in 30 days', () => {
  const { ctx, agent, human } = fixture();
  assert.deepEqual(agentPresence(ctx), { connections: null, last_seen_at: null });
  human(5, 'campaign_update');
  assert.deepEqual(agentPresence(ctx), { connections: 0, last_seen_at: null });
  agent(60 * 24 * 40, 'content_create_item', { credential_id: 'cred-old' });
  agent(60, 'content_create_item');
  agent(30, 'content_create_item', { credential_id: 'cred-codex' });
  assert.deepEqual(agentPresence(ctx), { connections: 2, last_seen_at: '2026-11-20T11:30:00.000Z' });
  assert.deepEqual(describeAction('publishing_archive_slot_template').verb, 'deleted');
  assert.deepEqual(describeAction('publishing_create_target', 3).summary, ['建立了發布排期 ×3', 'Created a publish schedule ×3']);
});

test('activity names and links only resources the caller may read in their own module', () => {
  const { ctx, agent, view } = fixture();
  const open = ctx.create('ad_account', { brand_id: 'b1', permissions: [{ actor_id: 'owner', actions: ['read'] }] });
  const locked = ctx.create('ad_account', { brand_id: 'b1', permissions: [{ actor_id: 'someone', actions: ['read'] }] });
  const shared = ctx.create('ad_proposal', { ad_account_id: open.id, name: 'Spring boost' });
  const secret = ctx.create('ad_proposal', { ad_account_id: locked.id, name: 'Secret Q1 launch push' });
  const brief = ctx.create('brief', { title: 'Launch brief' });
  const mine = ctx.create('work_item', { title: 'My task', assignee_id: 'owner' });
  const theirs = ctx.create('work_item', { title: 'Their task', assignee_id: 'someone' });
  const job = ctx.create('agent_job', { title: 'Private job' });
  agent(60, 'ads_create_proposal', { resource_type: 'ad_proposal', resource_id: secret.id });
  agent(45, 'ads_revise_proposal', { resource_type: 'ad_proposal', resource_id: shared.id });
  agent(30, 'brief_update_draft', { resource_type: 'brief', resource_id: brief.id });
  agent(20, 'tasks_update', { resource_type: 'work_item', resource_id: theirs.id });
  agent(15, 'tasks_create', { resource_type: 'work_item', resource_id: mine.id });
  agent(10, 'agent_jobs_create', { resource_type: 'agent_job', resource_id: job.id });
  agent(5, 'campaign_brief_create', { resource_type: 'campaign', resource_id: brief.id });
  const refs = () => Object.fromEntries(view().map(item => [item.action, [item.resource.id, item.resource.title]]));

  assert.deepEqual(refs(), {
    ads_create_proposal: [null, null], ads_revise_proposal: [shared.id, 'Spring boost'], brief_update_draft: [brief.id, 'Launch brief'],
    tasks_update: [theirs.id, 'Their task'], tasks_create: [mine.id, 'My task'], agent_jobs_create: [job.id, 'Private job'], campaign_brief_create: [null, null],
  });
  assert.deepEqual(view().find(item => item.action === 'ads_create_proposal')!.summary, ['建立了投放方案', 'Created an ad proposal'], 'The event itself stays visible');
  ctx.role = 'reviewer';
  assert.deepEqual(refs().brief_update_draft, [null, null]);
  ctx.role = 'agent';
  assert.deepEqual([refs().tasks_update, refs().tasks_create], [[null, null], [mine.id, 'My task']]);
  ctx.role = 'owner';
  assert.deepEqual(refs().ads_create_proposal, [secret.id, 'Secret Q1 launch push'], 'Owners and admins read every ad account');
  Object.assign(ctx, { canReadWorkspaceResource: (kind: string) => kind !== 'agent_job' });
  assert.deepEqual(refs().agent_jobs_create, [null, null]);
});

test('activity names and links jobs and change sets only when the agent module would show them', () => {
  const { ctx, agent, view } = fixture();
  ctx.role = 'editor';
  // The host rule from integration/workspace-services.ts: below manager, personal kinds belong to their assignee, owner or creator.
  const personal = ['customer', 'conversation', 'creator', 'agent_job'];
  Object.assign(ctx, { canReadWorkspaceResource: (kind: string, row: Row) =>
    !personal.includes(kind) || ['owner', 'admin', 'manager'].includes(ctx.role) || [row.assignee_id, row.created_by].includes(ctx.actorId) });
  const theirs = ctx.create('conversation', { assignee_id: 'someone' });
  const mine = ctx.create('conversation', { assignee_id: 'owner' });
  const blocked = ctx.create('agent_job', { title: 'Reply to VIP complaint', created_by: 'owner', input_scope: { resource_refs: [{ kind: 'conversation', id: theirs.id }] } });
  const open = ctx.create('agent_job', { title: 'Answer a question', created_by: 'owner', input_scope: { resource_refs: [{ kind: 'conversation', id: mine.id }] } });
  const hidden = ctx.create('change_set', { title: 'VIP reply drafts', agent_job_id: blocked.id });
  const shown = ctx.create('change_set', { title: 'Answer drafts', agent_job_id: open.id });
  agent(40, 'agent_jobs_create', { resource_type: 'agent_job', resource_id: blocked.id });
  agent(35, 'agent_jobs_heartbeat', { resource_type: 'agent_job', resource_id: blocked.id });
  agent(30, 'agent_jobs_claim', { resource_type: 'agent_job', resource_id: open.id });
  agent(20, 'change_sets_create', { resource_type: 'change_set', resource_id: hidden.id });
  agent(10, 'change_sets_reject', { resource_type: 'change_set', resource_id: shown.id });
  const refs = () => Object.fromEntries(view().map(item => [item.action, [item.resource.id, item.resource.title]]));

  assert.deepEqual(refs(), {
    agent_jobs_create: [null, null], agent_jobs_heartbeat: [null, null], agent_jobs_claim: [open.id, 'Answer a question'],
    change_sets_create: [null, null], change_sets_reject: [shown.id, 'Answer drafts'],
  }, 'A job the member created still hides once a resource it references is someone else’s');
  assert.deepEqual(view().find(item => item.action === 'agent_jobs_create')!.summary, ['交辦了任務', 'Assigned a task'], 'The event itself stays visible');
  ctx.role = 'manager';
  assert.deepEqual([refs().agent_jobs_create, refs().change_sets_create], [[blocked.id, 'Reply to VIP complaint'], [hidden.id, 'VIP reply drafts']]);
});
