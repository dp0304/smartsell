import { required, type Commands, type Fields } from '../types.ts';
import { campaignCommands } from './campaign-commands.ts';
import { command, conflict, expected, fields, getCampaign, leadRoles, moduleName, optionalText, readRoles, rows, text, timestamp, writeRoles } from './command-input.ts';
import { coordinationCommands } from './coordination-commands.ts';

export const templateCommands: Commands = {
  list_templates: command(readRoles, async ctx => (await ctx.list(moduleName, 'campaign_template')).filter(row => !row.data.archived_at)),
  create_template: command(leadRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'name']);
    const campaign = await getCampaign(ctx, input);
    if (campaign.data.status !== 'closed') conflict('Create templates from closed campaigns');
    const start = Date.parse(campaign.data.starts_at);
    const relative = (value: string | null) => value ? Date.parse(value) - start : null;
    const [slots, work, edges] = await Promise.all([rows(ctx, 'campaign_plan_slot', campaign.id), ctx.list('workspace', 'work_item'), ctx.list('workspace', 'work_item_dependency')]);
    const milestones = work.filter(row => row.data.campaign_id === campaign.id && row.data.kind === 'campaign_milestone' && row.data.due_at && row.data.status !== 'cancelled');
    const offsets: Fields[] = [];
    const remaining = new Map(milestones.map(row => [row.id, row]));
    const included = new Set(remaining.keys());
    while (remaining.size) {
      let progressed = false;
      for (const [id, row] of remaining) {
        const dependencies = edges.filter(edge => (edge.data.successor_id ?? edge.data.work_item_id) === id)
          .map(edge => ({ predecessor: edge.data.predecessor_id ?? edge.data.depends_on_id, lag_hours: edge.data.lag_hours ?? 0 }))
          .filter(edge => included.has(edge.predecessor));
        if (dependencies.some(edge => remaining.has(edge.predecessor))) continue;
        offsets.push({ key: id, offset: relative(row.data.due_at), gate: row.data.payload?.gate === 'ready_for_scheduling' ? 'ready_for_scheduling' : null, dependencies });
        remaining.delete(id);
        progressed = true;
      }
      if (!progressed) conflict('Campaign milestones contain a dependency cycle');
    }
    const briefs = (await rows(ctx, 'brief', campaign.id)).filter(row => row.data.kind === 'main' && row.data.approved_revision_id);
    const approved = briefs.length ? await required(ctx, moduleName, 'brief_revision', briefs[0].data.approved_revision_id) : null;
    const structure = {
      duration: relative(campaign.data.ends_at), kind: campaign.data.kind, timezone: campaign.data.timezone,
      plan_slots: slots.map(({ data }) => ({ stage: data.stage, platform: data.platform, locale: data.locale, content_format: data.content_format,
        planned_count: data.planned_count, start: relative(data.window_start), end: relative(data.window_end) })),
      milestones: offsets,
      brief_requirements: approved?.data.requirements.map((requirement: Fields) => ({ count: requirement.count, due_offset: relative(requirement.due_at) })) ?? null,
    };
    return ctx.insert(moduleName, 'campaign_template', { name: text(input.name, 'name'), source_campaign_id: campaign.id, structure });
  }),
  update_template: command(leadRoles, async (ctx, input) => {
    fields(input, ['template_id', 'expected_version', 'name']);
    const template = await required(ctx, moduleName, 'campaign_template', text(input.template_id, 'template_id'));
    if (template.data.archived_at) conflict('Template is archived');
    return ctx.update(moduleName, 'campaign_template', template.id, { name: text(input.name, 'name') }, expected(template, input.expected_version));
  }),
  archive_template: command(leadRoles, async (ctx, input) => {
    fields(input, ['template_id', 'expected_version']);
    const template = await required(ctx, moduleName, 'campaign_template', text(input.template_id, 'template_id'));
    if (template.data.archived_at) conflict('Template is archived');
    return ctx.update(moduleName, 'campaign_template', template.id, { archived_at: ctx.now }, expected(template, input.expected_version));
  }),
  instantiate_template: command(writeRoles, async (ctx, input) => {
    fields(input, ['template_id', 'brand_id', 'name', 'starts_at', 'owner_user_id']);
    const template = await required(ctx, moduleName, 'campaign_template', text(input.template_id, 'template_id'));
    if (template.data.archived_at) conflict('Template is archived');
    const structure = template.data.structure;
    const starts_at = timestamp(input.starts_at, 'starts_at');
    const absolute = (offset: number | null) => offset == null ? null : new Date(Date.parse(starts_at) + offset).toISOString();
    const campaign = await campaignCommands.create_draft.run(ctx, { brand_id: input.brand_id, name: input.name, kind: structure.kind, timezone: structure.timezone,
      owner_user_id: optionalText(input.owner_user_id, 'owner_user_id') ?? ctx.actorId, starts_at, ends_at: absolute(structure.duration) }) as Awaited<ReturnType<typeof required>>;
    const campaign_id = campaign.id;
    for (const { start, end, ...slot } of structure.plan_slots) {
      await campaignCommands.create_plan_slot.run(ctx, { campaign_id, ...slot, window_start: absolute(start), window_end: absolute(end) });
    }
    await coordinationCommands.create_tasks.run(ctx, { campaign_id, tasks: structure.milestones.map((milestone: Fields, index: number) => ({
      key: `${template.id}:${milestone.key}`, kind: 'campaign_milestone', title: `Milestone ${index + 1}`, due_at: absolute(milestone.offset), gate: milestone.gate,
      dependencies: milestone.dependencies.map((dependency: Fields) => ({ ...dependency, predecessor: `${template.id}:${dependency.predecessor}` })),
    })) });
    if (structure.brief_requirements) {
      const { briefCommands } = await import('./brief-commands.ts');
      const brief = await briefCommands.create_brief.run(ctx, { campaign_id, title: 'Campaign brief' }) as Awaited<ReturnType<typeof required>>;
      await briefCommands.update_brief_draft.run(ctx, { campaign_id, brief_id: brief.id, expected_version: brief.version, body_doc: { type: 'doc', content: [] },
        requirements: structure.brief_requirements.map((item: Fields) => ({ type: 'asset', count: item.count, due_at: absolute(item.due_offset) })) });
    }
    return ctx.update(moduleName, 'campaign', campaign.id, { template_id: template.id }, campaign.version);
  }),
};
