import { readers, required, reviewers, text, writers, type Commands } from '../types.js';
import { agentModule, array, command, conflict, id, integer } from './agent-validation.js';

const kind = 'workflow_template';

export const templateCommands: Commands = {
  workflow_templates_create: command(writers, async (ctx, input) => {
    const steps = array(input.steps, 'steps', 20).map(step => text({ step }, 'step', 2000));
    if (!steps.length) conflict('A template needs at least one step');
    const row = await ctx.insert(agentModule, kind, { title: text(input, 'title', 200), steps, status: 'draft', created_by: ctx.actorId });
    await ctx.emit('agent.workflow_template.created', { workflow_template_id: row.id });
    return row;
  }),
  workflow_templates_publish: command(reviewers, async (ctx, input) => {
    const row = await required(ctx, agentModule, kind, id(input.workflow_template_id));
    if (row.data.status !== 'draft') conflict('Template has already been published');
    const published = await ctx.update(agentModule, kind, row.id, { status: 'published', published_by: ctx.actorId }, integer(input.expected_version, 'expected_version'));
    await ctx.emit('agent.workflow_template.published', { workflow_template_id: row.id });
    return published;
  }),
  workflow_templates_list: command(readers, async ctx => ({
    items: (await ctx.list(agentModule, kind)).filter(row => row.data.status === 'published').slice(0, 100),
  })),
};
