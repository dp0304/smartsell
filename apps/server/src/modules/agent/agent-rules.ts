import { createHash } from 'node:crypto';
import { admins, DomainError, required, text, type Commands, type Context, type Fields } from '../types.js';
import { createAgentJob } from './agent-jobs.js';
import { agentModule, command, id, integer, invalid, object, time } from './agent-validation.js';

const ruleKind = 'automation_rule';
export type RuleTrigger = { kind: 'event'; name: string; id: string; data: Fields } | { kind: 'schedule'; scheduledAt: string };
const eventName = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/;
const intervalOrigin = 0;

function definition(input: Fields) {
  const trigger = object(input.trigger, 'trigger');
  const action = object(input.action, 'action');
  const name = trigger.kind === 'event' ? text(trigger, 'name', 120) : undefined;
  if (name && (!eventName.test(name) || name.startsWith('agent.rule_run.') || name.startsWith('agent.job.'))) invalid('trigger.name');
  const triggerData = trigger.kind === 'event' ? { kind: trigger.kind, name } : trigger.kind === 'schedule' ?
    { kind: trigger.kind, interval_minutes: integer(trigger.interval_minutes, 'interval_minutes', 5, 10080) } : invalid('trigger.kind');
  if (!['create_agent_job', 'remind'].includes(action.kind)) invalid('action.kind');
  const condition = input.condition == null ? null : object(input.condition, 'condition');
  if (condition && (trigger.kind !== 'event' || !/^[a-z][a-z0-9_]{0,63}$/.test(condition.field) ||
      !['string', 'boolean', 'number'].includes(typeof condition.equals) ||
      (typeof condition.equals === 'string' && condition.equals.length > 256) ||
      (typeof condition.equals === 'number' && !Number.isFinite(condition.equals)))) invalid('condition');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') invalid('enabled');
  return { name: text(input, 'name', 120), enabled: input.enabled === true, trigger: triggerData,
    condition: condition ? { field: condition.field, equals: condition.equals } : null,
    action: { kind: action.kind, title: text(action, 'title', 200) } };
}

function match(rule: Fields, trigger: RuleTrigger) {
  if (rule.trigger.kind !== trigger.kind) return false;
  if (trigger.kind === 'schedule') {
    return (Date.parse(time(trigger.scheduledAt, 'scheduled_at')) - intervalOrigin) % (rule.trigger.interval_minutes * 60_000) === 0;
  }
  return rule.trigger.name === trigger.name && (!rule.condition ||
    (Object.hasOwn(trigger.data, rule.condition.field) && trigger.data[rule.condition.field] === rule.condition.equals));
}

/** The worker supplies the durable event ID or scheduled tick inside a workspace transaction. */
export async function evaluateAgentRules(ctx: Context, trigger: RuleTrigger) {
  const triggerRef = trigger.kind === 'event' ? id(trigger.id) : time(trigger.scheduledAt, 'scheduled_at');
  const runs = [];
  for (const rule of await ctx.list(agentModule, ruleKind)) {
    if (!rule.data.enabled || !match(rule.data, trigger)) continue;
    const runId = 'rule-' + createHash('sha256').update(JSON.stringify([ctx.tenantId, ctx.workspaceId, rule.id, trigger.kind, triggerRef])).digest('hex');
    if (await ctx.get(agentModule, 'rule_run', runId)) continue;
    const run = await ctx.insert(agentModule, 'rule_run', { rule_id: rule.id, rule_version: rule.version,
      trigger_kind: trigger.kind, trigger_ref: triggerRef, status: 'acting' }, runId);
    const action = rule.data.action;
    const job = action.kind === 'create_agent_job' ? await createAgentJob(ctx, { title: action.title, kind: 'automation' }, run.id) : null;
    const reminder = job ? null : await ctx.insert('workspace', 'work_item', { resource_type: 'rule_run', resource_id: run.id,
      title: action.title, type: 'followup', status: 'open', priority: 'normal', source_type: 'automation', created_by_id: ctx.actorId }, `rule-reminder:${run.id}`);
    const status = job ? 'waiting' : 'succeeded';
    const saved = await ctx.update(agentModule, 'rule_run', run.id, { status, agent_job_id: job?.id ?? null,
      reminder_id: reminder?.id ?? null, waiting_reason: job ? 'waiting_for_agent_job' : null }, run.version);
    if (reminder) await ctx.emit('agent.rule.reminder_created', { rule_run_id: run.id, reminder_id: reminder.id, title: action.title });
    await ctx.emit(`agent.rule_run.${job ? 'waiting' : 'completed'}`, { rule_run_id: run.id, status, agent_job_id: job?.id ?? null });
    runs.push(saved);
  }
  return { items: runs };
}

export const ruleCommands: Commands = {
  automation_rules_create: command(admins, (ctx, input) => ctx.insert(agentModule, ruleKind, { ...definition(input), created_by: ctx.actorId }).then(async rule => {
    await ctx.emit('agent.automation_rule.created', { rule_id: rule.id });
    return rule;
  })),
  automation_rules_update: command(admins, async (ctx, input) => {
    const rule = await required(ctx, agentModule, ruleKind, id(input.rule_id));
    const patch = definition({ ...rule.data, ...input });
    const next = await ctx.update(agentModule, ruleKind, rule.id, patch, integer(input.expected_version, 'expected_version'));
    await ctx.emit('agent.automation_rule.updated', { rule_id: rule.id, enabled: next.data.enabled });
    return next;
  }),
  automation_rules_list: command(admins, async ctx => ({ items: await ctx.list(agentModule, ruleKind) })),
  automation_rules_runs: command(admins, async (ctx, input) => {
    const rule = await required(ctx, agentModule, ruleKind, id(input.rule_id));
    return { items: (await ctx.list(agentModule, 'rule_run')).filter(run => run.data.rule_id === rule.id) };
  }),
  automation_rules_test: command(admins, async (ctx, input) => {
    const rule = await required(ctx, agentModule, ruleKind, id(input.rule_id));
    const trigger = object(input.sample, 'sample');
    if (!['event', 'schedule'].includes(trigger.kind)) throw new DomainError('invalid_input', 'Invalid sample kind');
    const sample: RuleTrigger = trigger.kind === 'event' ? { kind: 'event', name: text(trigger, 'name', 120), id: 'sample',
      data: object(trigger.data ?? {}, 'sample.data') } : { kind: 'schedule', scheduledAt: time(trigger.scheduled_at, 'scheduled_at') };
    const matches = match(rule.data, sample);
    return { matches, enabled: rule.data.enabled, action: matches ? rule.data.action : null };
  }),
};
