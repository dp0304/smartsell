import { createHash } from 'node:crypto';
import { ADMIN, APPROVE, Problem, READ, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { array, checkVersion, integer, object, text } from './input.js';
import { createAgentJob } from './jobs.js';

interface TriggerEvent { id: string; type: string; data?: Data }
interface Trigger { type: 'event' | 'schedule'; event_type?: string; every_minutes?: number }
interface Action { type: 'create_work_item' | 'create_agent_job'; title: string; brand_id?: string }

function trigger(value: unknown): Trigger {
  const spec = object(value, 'trigger');
  if (spec.type === 'event') return { type: 'event', event_type: text(spec.event_type, 'event_type') };
  if (spec.type === 'schedule') return { type: 'schedule', every_minutes: integer(spec.every_minutes, 'every_minutes', 1, 1440) };
  throw new Problem(400, 'INVALID_INPUT', 'Rules need an event or a fixed interval trigger');
}

function actions(ctx: Context, value: unknown): Action[] {
  const rows = array(value, 'actions', 10).map((row): Action => {
    const spec = object(row, 'action');
    if (spec.type !== 'create_work_item' && spec.type !== 'create_agent_job') throw new Problem(400, 'INVALID_INPUT', 'Unsupported rule action');
    return { type: spec.type, title: text(spec.title, 'title'), ...(spec.brand_id === undefined ? {} : { brand_id: ctx.get('brand', text(spec.brand_id, 'brand_id')).id }) };
  });
  if (!rows.length) throw new Problem(400, 'INVALID_INPUT', 'A rule needs at least one action');
  return rows;
}

function conditions(value: unknown) {
  return array(value ?? [], 'conditions', 10).map((condition) => {
    const entry = object(condition, 'condition');
    const key = text(entry.key, 'condition.key');
    if (!/^[a-z][a-z0-9_]*$/.test(key) || !['string', 'boolean', 'number'].includes(typeof entry.equals)) throw new Problem(400, 'INVALID_INPUT', 'Conditions compare a single scalar event field');
    return { key, equals: entry.equals };
  });
}

function values(ctx: Context, body: Data): Data {
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Problem(400, 'INVALID_INPUT', 'enabled must be a boolean');
  return { name: text(body.name, 'name'), enabled: body.enabled === true, trigger: trigger(body.trigger), actions: actions(ctx, body.actions), conditions: conditions(body.conditions) };
}

function matches(rule: Row, event: TriggerEvent) {
  const definition = trigger(rule.trigger);
  if (definition.type !== 'event' || definition.event_type !== event.type) return false;
  const data = event.data ?? {};
  return conditions(rule.conditions).every(({ key, equals }) => Object.hasOwn(data, key) && data[key] === equals);
}

function execute(ctx: Context, rule: Row, triggerKey: string): Row {
  const existing = ctx.list('rule_run').find((row) => row.rule_id === rule.id && row.trigger_key === triggerKey);
  if (existing) return existing;
  const planned = actions(ctx, rule.actions);
  const row = ctx.create('rule_run', { rule_id: rule.id, rule_version: rule.version, trigger_key: triggerKey, status: 'acting', started_at: ctx.now });
  const results = planned.map((action) => {
    if (action.type === 'create_agent_job') return { type: action.type, id: createAgentJob(ctx, action as unknown as Data, row.id).id };
    const task = ctx.create('work_item', { type: 'todo', title: action.title, brand_id: action.brand_id ?? null, priority: 'normal', status: 'open', source_type: 'automation', source_ref: { rule_id: rule.id, rule_run_id: row.id }, created_by: ctx.actorId });
    return { type: action.type, id: task.id };
  });
  const waiting = results.some((action) => action.type === 'create_agent_job');
  const status = waiting ? 'waiting' : 'succeeded';
  const updated = ctx.update('rule_run', row.id, { status, waiting_reason: waiting ? 'awaiting_agent_claim' : null, action_results: results, finished_at: waiting ? null : ctx.now });
  ctx.emit(`agent.rule_run.${waiting ? 'waiting' : 'completed'}`, { rule_run_id: row.id, rule_id: rule.id });
  return updated;
}

/** Call from a trusted event worker transaction using an authorized service principal. */
export function processAgentEvent(ctx: Context, event: TriggerEvent): Row[] {
  const key = `event:${text(event.id, 'event.id', 500)}`;
  if (event.type.startsWith('agent.rule_run.') || (event.type.startsWith('agent.job.') && event.data?.source_rule_run_id)) return [];
  return ctx.list('automation_rule').filter((rule) => rule.enabled === true && matches(rule, event)).map((rule) => execute(ctx, rule, key));
}

/** The UTC interval bucket is the durable dedupe key. Catch-up and scheduling are the host's responsibility. */
export function processAgentSchedule(ctx: Context): Row[] {
  const minutes = Math.floor(Date.parse(ctx.now) / 60_000);
  return ctx.list('automation_rule').flatMap((rule) => {
    const spec = trigger(rule.trigger);
    return rule.enabled === true && spec.type === 'schedule' && minutes % spec.every_minutes! === 0 ? [execute(ctx, rule, `schedule:${minutes}`)] : [];
  });
}

export function publishedWorkflow(ctx: Context, id: string): Row {
  const template = ctx.get('workflow_template', id);
  if (typeof template.current_revision_id !== 'string') throw new Problem(404, 'WORKFLOW_UNAVAILABLE', 'Workflow has no published revision');
  const revision = ctx.get('workflow_template_revision', template.current_revision_id);
  if (revision.template_id !== template.id || revision.brand_id !== template.brand_id) throw new Problem(404, 'WORKFLOW_UNAVAILABLE', 'Workflow revision is unavailable');
  return revision;
}

export const ruleOperations: Operation[] = [
  { method: 'GET', path: '/automation-rules', name: 'automation_rules_list', roles: ADMIN, summary: 'List workspace rules', run: (ctx) => ctx.list('automation_rule') },
  { method: 'POST', path: '/automation-rules', name: 'automation_rules_create', roles: ADMIN, summary: 'Create a deterministic or Agent work rule', run: (ctx, { body }) => ctx.create('automation_rule', values(ctx, { ...body, enabled: false })) },
  { method: 'PATCH', path: '/automation-rules/:id', name: 'automation_rules_update', roles: ADMIN, summary: 'Update or activate an automation rule', versionKind: 'automation_rule', run(ctx, input) {
    const rule = ctx.get('automation_rule', input.params.id!);
    checkVersion(rule, input.expectedVersion);
    return ctx.update('automation_rule', rule.id, values(ctx, { ...rule, ...input.body }));
  } },
  { method: 'POST', path: '/automation-rules/:id/test', name: 'automation_rules_test', roles: ADMIN, summary: 'Preview actions for a representative event without writes', run(ctx, { params, body }) {
    const rule = ctx.get('automation_rule', params.id!);
    const spec = trigger(rule.trigger);
    const matched = spec.type === 'schedule' ? Math.floor(Date.parse(ctx.now) / 60_000) % spec.every_minutes! === 0 :
      matches(rule, { id: '', type: text(body.type, 'event.type'), data: object(body.data ?? {}, 'event.data') });
    return { matched, enabled: rule.enabled, actions: matched ? actions(ctx, rule.actions) : [] };
  } },
  { method: 'GET', path: '/automation-rules/:id/runs', name: 'automation_rules_runs', roles: ADMIN, summary: 'List deduplicated rule runs and waiting reasons', run(ctx, { params }) {
    const rule = ctx.get('automation_rule', params.id!);
    return ctx.list('rule_run').filter((run) => run.rule_id === rule.id);
  } },
  { method: 'GET', path: '/workflow-templates', name: 'workflow_templates_list', roles: READ, summary: 'List published workflow templates', run: (ctx) => ctx.list('workflow_template').filter((row) => typeof row.current_revision_id === 'string') },
  { method: 'GET', path: '/workflow-templates/:id', name: 'workflow_templates_get', roles: READ, summary: 'Read the current published workflow revision', run: (ctx, { params }) => publishedWorkflow(ctx, params.id!) },
  { method: 'POST', path: '/workflow-templates', name: 'workflow_templates_create', roles: APPROVE, summary: 'Publish a workspace workflow template', run(ctx, { body }) {
    const key = text(body.key, 'key');
    if (ctx.list('workflow_template').some((row) => row.key === key)) throw new Problem(409, 'WORKFLOW_EXISTS', 'Workflow key already exists');
    const template = ctx.create('workflow_template', { key, name: text(body.name, 'name'), scope: 'workspace', brand_id: body.brand_id === undefined ? null : ctx.get('brand', text(body.brand_id, 'brand_id')).id });
    return publish(ctx, template, body);
  } },
  { method: 'POST', path: '/workflow-templates/:id/revisions', name: 'workflow_templates_publish', roles: APPROVE, summary: 'Publish an immutable workflow revision', versionKind: 'workflow_template', run(ctx, input) {
    const template = ctx.get('workflow_template', input.params.id!);
    checkVersion(template, input.expectedVersion);
    return publish(ctx, template, input.body);
  } },
];

function publish(ctx: Context, template: Row, body: Data) {
  const prompt = text(body.prompt, 'prompt', 20_000);
  const steps = array(body.steps ?? [], 'steps', 30).map((step) => text(step, 'step', 1200));
  const previous = typeof template.current_revision_id === 'string' ? publishedWorkflow(ctx, template.id) : null;
  const revision = ctx.create('workflow_template_revision', { template_id: template.id, brand_id: template.brand_id, revision_no: Number(previous?.revision_no ?? 0) + 1, prompt, steps, content_hash: createHash('sha256').update(JSON.stringify([prompt, steps])).digest('hex') });
  const row = ctx.update('workflow_template', template.id, { current_revision_id: revision.id });
  ctx.emit('agent.workflow_template.published', { template_id: template.id, revision_id: revision.id });
  return { ...row, revision };
}
