import type { Context, Data, Operation, Row } from '@smartsell/contracts';
import { canReadFinancial, metricDefinitions } from '../analytics/metrics.js';
import { generateReport, reportVersion, reportVersions, reports } from '../analytics/reports.js';
import { formats, platforms } from '../content/model.js';
import { canReadTask } from '../workspace/tasks.js';
import { createBrief, createBriefRevision } from './brief-operations.js';
import { CAMPAIGN_KINDS, SLOT_FIELDS, createCampaign, goalProgress, transition } from './core.js';
import { campaignMatrix, createCampaignTasks } from './coordination-operations.js';
import { budgetSummary } from './spend-operations.js';
import { CAMPAIGN, INTERNAL_READ, LEAD, PLAN, array, campaign, choice, conflict, event, fields, integer, invalid, jsonDoc, missing, number, optionalText, record, rows, text, timestamp, version } from './shared.js';

type Unfinished = { type: string; id: string; status: unknown };
function unfinished(ctx: Context, campaignId: string): Unfinished[] {
  const collaborations = new Set(rows(ctx, 'collaboration', 'campaign_id', campaignId).map(row => row.id));
  const checks = [
    { type: 'publish_target', candidates: rows(ctx, 'publish_target', 'campaign_id', campaignId), terminal: ['closed', 'cancelled', 'superseded', 'published', 'failed_final', 'expired_skipped'] },
    { type: 'work_item', candidates: rows(ctx, 'work_item', 'campaign_id', campaignId), terminal: ['done', 'cancelled'] },
    { type: 'commission_entry', candidates: ctx.list('commission_entry').filter(row => collaborations.has(String(row.collaboration_id)) && row.kind !== 'reversal'), terminal: ['paid', 'platform_settled', 'reversed', 'void'] },
    { type: 'sample_shipment', candidates: ctx.list('sample_shipment').filter(row => collaborations.has(String(row.collaboration_id)) && (row.return_required === true || row.requires_return === true)), terminal: ['returned', 'cancelled', 'waived'] },
  ];
  return checks.flatMap(({ type, candidates, terminal }) => candidates.flatMap(row => {
    const status = row.plan_status ?? row.status;
    return terminal.includes(String(status)) ? [] : [{ type, id: row.id, status }];
  })).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}
const REPORT_ROLES = [...PLAN, 'analyst'] as const;
function exactCampaignIds(ids: unknown, campaignId: string): boolean {
  return Array.isArray(ids) && ids.length === 1 && ids[0] === campaignId;
}
function reportMatchesCampaign(report: Data, campaignId: string): boolean {
  const scope = (report.scope ?? report.subject_filter) as Data | undefined;
  if ([scope?.campaign_id, report.campaign_id].some(id => id != null && id !== campaignId)) return false;
  return scope?.campaign_ids !== undefined ? exactCampaignIds(scope.campaign_ids, campaignId) :
    (scope?.campaign_id ?? report.campaign_id) === campaignId;
}
function sectionsMatchCampaign(raw: unknown, campaignId: string): boolean {
  const sections = raw as { source: string; query?: { subject?: { type?: string; id?: string; filter?: Data } } }[] | undefined;
  return Array.isArray(sections) && sections.every(section => {
    const subject = section.query?.subject;
    if (section.source === 'narrative') return true;
    if (section.source === 'attribution') return subject?.type === 'campaign' && subject.id === campaignId;
    return section.source === 'metrics' && exactCampaignIds(subject?.filter?.campaign_ids, campaignId);
  });
}
function closeoutReportVersion(ctx: Context, campaignId: string, raw: unknown): string | null {
  const id = optionalText(raw, 'report_version_id');
  if (!id) return null;
  const revision = reportVersion(ctx, id);
  const report = ctx.get('report', String(revision.report_id));
  // The editable definition can be retargeted after generating a frozen version.
  if (!reportMatchesCampaign(report, campaignId) || !sectionsMatchCampaign(revision.query_snapshot, campaignId) ||
      !['finalized', 'superseded'].includes(String(revision.status))) invalid('A finalized report version scoped to this campaign is required');
  return id;
}
function snapshot(ctx: Context, row: Row) {
  const matrix = campaignMatrix(ctx, row);
  return {
    data_cutoff_at: ctx.now,
    goals: rows(ctx, 'campaign_goal', 'campaign_id', row.id).map(goal => ({ goal, progress: goalProgress(ctx, goal, row) })),
    costs: budgetSummary(ctx, row.id), unfinished: unfinished(ctx, row.id),
    delivery: { cells: matrix.cells.map(({ slot, counts, gap, excess }) => ({ slot_id: slot.id, counts, gap, excess })), outside_plan_count: matrix.outside_plan.length + matrix.unplanned_items.length },
  };
}

const TEMPLATE = '/campaign-templates/:id';
const taskFields = ['title', 'key', 'offset_hours', 'depends_on_keys', 'gate'];
const templateSlotFields = [...SLOT_FIELDS.filter(key => !['social_account_id', 'market_id', 'owner_user_id', 'window_start', 'window_end'].includes(key)), 'window_start_offset_hours', 'window_end_offset_hours'];
const HOUR_MS = 3_600_000;
function hours(value: unknown, field: string, min = -87_600): number | null {
  if (value == null) return null;
  const parsed = number(value, field);
  if (parsed < min || parsed > 87_600) invalid(`${field} must be between ${min} and 87600 hours`);
  return parsed;
}
function plainBrief(value: unknown) {
  const doc = jsonDoc(value, 'brief.body_doc');
  function convert(node: Data, level = 0): Data {
    if (level > 4) invalid('Template briefs support structural headings and paragraphs only');
    if (node.type === 'text') {
      fields(node, ['type', 'text']);
      return { type: 'text', text: text(node.text, 'brief text', 10_000) };
    }
    const type = choice(node.type, ['doc', 'paragraph', 'heading'], 'brief node type');
    fields(node, type === 'heading' ? ['type', 'attrs', 'content'] : ['type', 'content']);
    const content = array(node.content ?? [], 'brief content', 1000).map(child => {
      const value = record(child, 'brief node');
      if (type === 'doc' ? !['paragraph', 'heading'].includes(String(value.type)) : value.type !== 'text') invalid('Template brief structure is invalid');
      return convert(value, level + 1);
    });
    if (type !== 'heading') return { type, content };
    const attrs = record(node.attrs, 'heading attributes');
    fields(attrs, ['level']);
    return { type, attrs: { level: integer(attrs.level, 'heading level', 1, 6) }, content };
  }
  return convert(doc);
}
function templateValues(ctx: Context, body: Data): Data {
  const source_campaign_id = optionalText(body.source_campaign_id, 'source_campaign_id');
  if (source_campaign_id && ctx.get('campaign', source_campaign_id).status !== 'closed') invalid('Template sources must be closed campaigns');
  const structure = record(body.structure, 'structure');
  fields(structure, ['brief', 'milestones', 'plan_slots', 'duration_hours']);
  const briefInput = structure.brief == null ? null : record(structure.brief, 'brief');
  if (briefInput) fields(briefInput, ['title', 'body_doc', 'requirements']);
  const brief = briefInput ? {
    title: text(briefInput.title, 'brief title'), body_doc: plainBrief(briefInput.body_doc),
    requirements: array(briefInput.requirements ?? [], 'brief requirements').map(value => {
      const requirement = record(value, 'brief requirement');
      fields(requirement, ['count', 'due_offset_hours']);
      return { count: integer(requirement.count, 'brief requirement count', 1), due_offset_hours: hours(requirement.due_offset_hours, 'due_offset_hours') };
    }),
  } : null;
  const slotInputs = array(structure.plan_slots ?? [], 'plan_slots').map(value => {
    const slot = record(value, 'slot'); fields(slot, templateSlotFields);
    const start = hours(slot.window_start_offset_hours, 'window_start_offset_hours');
    const end = hours(slot.window_end_offset_hours, 'window_end_offset_hours');
    if (start !== null && end !== null && start >= end) invalid('Slot offsets must be ordered');
    return { ...slot, stage: choice(slot.stage, ['teaser', 'launch', 'sustain', 'conversion', 'recap', 'custom'], 'stage'), platform: text(slot.platform, 'platform'), window_start_offset_hours: start, window_end_offset_hours: end };
  });
  const milestones = array(structure.milestones ?? [], 'milestones', 100).map(value => {
    const task = record(value, 'milestone'); fields(task, taskFields);
    return { title: text(task.title, 'milestone title', 200), key: text(task.key, 'milestone key'), offset_hours: hours(task.offset_hours, 'offset_hours'),
      depends_on_keys: array(task.depends_on_keys ?? [], 'depends_on_keys').map(key => text(key, 'dependency key')),
      gate: task.gate == null ? null : choice(task.gate, ['ready_for_scheduling'], 'gate') };
  });
  const graph = new Map(milestones.map(task => [task.key, task.depends_on_keys]));
  if (graph.size !== milestones.length) invalid('Milestone keys must be unique');
  function visit(key: string, path: Set<string>, checked: Set<string>) {
    if (path.has(key)) invalid('Milestone dependencies contain a cycle');
    if (checked.has(key)) return;
    const dependencies = graph.get(key);
    if (!dependencies) invalid('Unknown milestone prerequisite');
    path.add(key);
    for (const dependency of dependencies) visit(dependency, path, checked);
    path.delete(key);
    checked.add(key);
  }
  const checked = new Set<string>();
  for (const key of graph.keys()) visit(key, new Set(), checked);
  const duration_hours = hours(structure.duration_hours, 'duration_hours', 1 / HOUR_MS);
  return { name: text(body.name, 'name'), source_campaign_id, structure: { brief, milestones, plan_slots: slotInputs, duration_hours } };
}

function deriveTemplate(ctx: Context, row: Row, name: unknown): Data {
  if (row.status !== 'closed') conflict('Template sources must be closed campaigns');
  const start = Date.parse(timestamp(row.starts_at, 'starts_at'));
  const offset = (value: unknown) => value == null ? null : (Date.parse(timestamp(value, 'template date')) - start) / HOUR_MS;
  const tasks = rows(ctx, 'work_item', 'campaign_id', row.id).filter(task => task.kind === 'campaign_milestone' && task.status !== 'cancelled' && canReadTask(ctx, task));
  const keys = new Map(tasks.map((task, index) => [task.id, `milestone-${index + 1}`]));
  const edges = ctx.list('work_item_dependency');
  const main = rows(ctx, 'brief', 'campaign_id', row.id).find(brief => brief.kind === 'main' && typeof brief.approved_revision_id === 'string');
  const approved = main ? ctx.get('brief_revision', String(main.approved_revision_id)) : null;
  // Reuse structural fields only. Titles, document text, notes, specs and record references can contain expired terms.
  return templateValues(ctx, { name, source_campaign_id: row.id, structure: {
    duration_hours: offset(row.ends_at),
    brief: approved ? { title: 'Campaign brief', body_doc: { type: 'doc', content: [] },
      requirements: (approved.requirements as Data[] | undefined ?? []).map(item => ({ count: item.count, due_offset_hours: offset(item.due_at) })) } : null,
    plan_slots: rows(ctx, 'campaign_plan_slot', 'campaign_id', row.id).map(slot => ({
      stage: slot.stage, platform: platforms.includes(String(slot.platform)) ? slot.platform : 'generic', locale: slot.locale,
      content_format: formats.includes(String(slot.content_format)) ? slot.content_format : null, planned_count: slot.planned_count,
      window_start_offset_hours: offset(slot.window_start), window_end_offset_hours: offset(slot.window_end),
    })),
    milestones: tasks.map((task, index) => ({
      key: keys.get(task.id), title: `Milestone ${index + 1}`, offset_hours: offset(task.due_at),
      depends_on_keys: edges.filter(edge => edge.work_item_id === task.id && keys.has(String(edge.depends_on_id)))
        .map(edge => keys.get(String(edge.depends_on_id))),
      gate: (task.payload as Data | undefined)?.gate === 'ready_for_scheduling' ? 'ready_for_scheduling' : null,
    })),
  } });
}

function sensitiveGoal(ctx: Context, goal: Data): boolean {
  return goal.unit === 'currency' || metricDefinitions(ctx).some(definition => definition.key === goal.metric_key && definition.scope === 'commerce');
}

export const closeoutOperations: Operation[] = [
  { method: 'GET', path: `${CAMPAIGN}/closeout`, name: 'campaign_closeout_get', roles: INTERNAL_READ, summary: 'Read the closeout snapshot and retrospective', run(ctx, input) {
    const closeout = rows(ctx, 'campaign_closeout', 'campaign_id', campaign(ctx, input).id)[0];
    if (!closeout || canReadFinancial(ctx)) return closeout ?? null;
    const snapshot = closeout.snapshot as Data;
    const goals = (snapshot.goals as { goal: Row; progress: Data }[]).map(entry => sensitiveGoal(ctx, entry.goal)
      ? { ...entry, progress: { goal_id: entry.goal.id, value: null, progress_percent: null, coverage: { status: 'no_permission' } } }
      : entry);
    return { ...closeout, snapshot: { ...snapshot, goals } };
  } },
  { method: 'GET', path: `${CAMPAIGN}/historical-baselines`, name: 'campaign_historical_baselines', roles: INTERNAL_READ, summary: 'Find comparable observed results from prior closeouts', run(ctx, input) {
    const row = campaign(ctx, input);
    const key = text(input.query.metric_key, 'metric_key');
    const unit = choice(input.query.unit, ['count', 'currency', 'percent', 'seconds'], 'unit');
    const code = input.query.currency ?? null;
    const marketId = input.query.market_id ?? null;
    if (marketId) ctx.get('market', marketId);
    if (!canReadFinancial(ctx) && sensitiveGoal(ctx, { metric_key: key, unit })) return [];
    const previous = new Map(rows(ctx, 'campaign', 'brand_id', row.brand_id).filter(item => item.id !== row.id && item.status === 'closed').map(item => [item.id, item]));
    const marketIds = new Map(ctx.list('campaign_market').map(item => [item.id, item.market_id]));
    return ctx.list('campaign_closeout').filter(item => previous.has(String(item.campaign_id))).flatMap(item => {
      const facts = item.snapshot as Data;
      return (facts.goals as { goal: Row; progress: Data }[]).flatMap(({ goal, progress }) => {
        if (goal.metric_key !== key || goal.unit !== unit || (goal.currency ?? null) !== code || goal.status === 'withdrawn') return [];
        const goalMarket = marketIds.get(String(goal.campaign_market_id)) ?? null;
        const coverage = progress.coverage as Data | undefined;
        if (goalMarket !== marketId || coverage?.status !== 'observed' || typeof progress.value !== 'number') return [];
        return [{ goal_id: goal.id, campaign_id: item.campaign_id, closeout_id: item.id, data_cutoff_at: facts.data_cutoff_at, value: progress.value,
          coverage, attribution_note: goal.attribution_note }];
      });
    }).sort((a, b) => String(b.data_cutoff_at).localeCompare(String(a.data_cutoff_at)) || a.goal_id.localeCompare(b.goal_id)).slice(0, 50);
  } },
  { method: 'POST', path: `${CAMPAIGN}/closeout/draft`, name: 'campaign_closeout_draft', roles: LEAD, summary: 'Preview facts and unresolved items for campaign closeout', run(ctx, input) {
    const row = campaign(ctx, input);
    if (row.status !== 'wrapping') conflict('Closeout starts when the campaign is wrapping');
    return { campaign_id: row.id, facts: snapshot(ctx, row), recommendations: [], retrospective_doc: { type: 'doc', content: [] } };
  } },
  { method: 'POST', path: `${CAMPAIGN}/closeout`, name: 'campaign_closeout', roles: LEAD, versionKind: 'campaign', summary: 'Freeze the closeout and close the campaign', run(ctx, input) {
    const row = campaign(ctx, input); version(row, input);
    if (row.status !== 'wrapping') conflict('Only a wrapping campaign can close');
    const body = input.body;
    fields(body, ['expected_version', 'report_version_id', 'retrospective_doc', 'retentions']);
    const report_version_id = closeoutReportVersion(ctx, row.id, body.report_version_id);
    const retrospective_doc = jsonDoc(body.retrospective_doc, 'retrospective_doc');
    const facts = snapshot(ctx, row);
    const actual = new Set(facts.unfinished.map(item => `${item.type}:${item.id}`));
    const seen = new Set<string>();
    const retentions = array(body.retentions ?? [], 'retentions', 1000).map(value => {
      const item = record(value, 'retention'); fields(item, ['type', 'id', 'reason']);
      const type = text(item.type, 'type'), id = text(item.id, 'id'), key = `${type}:${id}`;
      if (!actual.has(key) || seen.has(key)) invalid('Retentions must refer to distinct current unfinished items');
      seen.add(key);
      return { type, id, reason: text(item.reason, 'reason') };
    });
    if (seen.size !== actual.size) conflict('Resolve or explicitly retain each unfinished item');
    const closeout = ctx.create('campaign_closeout', { campaign_id: row.id, snapshot: { ...facts, retentions }, report_version_id, retrospective_doc, closed_by: ctx.actorId });
    transition(ctx, row, 'closed', 'closeout_completed', true);
    event(ctx, 'campaign.closed', row.id, { closeout_id: closeout.id, report_version_id, data_cutoff_at: facts.data_cutoff_at });
    return closeout;
  } },
  { method: 'GET', path: `${CAMPAIGN}/reports`, name: 'campaign_report_list', roles: REPORT_ROLES, summary: 'List reports and frozen versions scoped to this campaign', run(ctx, input) {
    const row = campaign(ctx, input);
    return reports(ctx).filter(report => reportMatchesCampaign(report, row.id)).map(report => ({
      ...report, versions: reportVersions(ctx, String(report.id)).filter(revision => sectionsMatchCampaign(revision.query_snapshot, row.id)),
    }));
  } },
  { method: 'POST', path: `${CAMPAIGN}/reports/:reportId/backfill`, name: 'campaign_report_backfill', roles: REPORT_ROLES, summary: 'Generate a new report version for a closed campaign', run(ctx, input) {
    const row = campaign(ctx, input);
    const report = ctx.get('report', text(input.params.reportId, 'report_id'));
    if (!reportMatchesCampaign(report, row.id)) missing('Report does not belong to this campaign');
    if (row.status !== 'closed') conflict('Campaign must be closed to generate a backfill report');
    fields(input.body, ['data_cutoff_at']);
    if (!sectionsMatchCampaign(report.sections, row.id)) invalid('Report sections must be scoped to this campaign');
    return generateReport(ctx, report.id, input.body);
  } },
  { method: 'POST', path: `${CAMPAIGN}/templates`, name: 'campaign_template_derive', roles: LEAD, summary: 'Derive a reusable structure from a closed campaign', run(ctx, input) {
    fields(input.body, ['name']);
    return ctx.create('campaign_template', deriveTemplate(ctx, campaign(ctx, input), input.body.name));
  } },
  { method: 'GET', path: '/campaign-templates', name: 'campaign_template_list', roles: INTERNAL_READ, summary: 'List reusable campaign templates', run: ctx => ctx.list('campaign_template') },
  { method: 'GET', path: TEMPLATE, name: 'campaign_template_get', roles: INTERNAL_READ, summary: 'Read a campaign template', run: (ctx, { params }) => ctx.get('campaign_template', params.id!) },
  { method: 'POST', path: '/campaign-templates', name: 'campaign_template_create', roles: LEAD, summary: 'Save a reusable brief and relative campaign schedule', run(ctx, { body }) {
    fields(body, ['name', 'source_campaign_id', 'structure']);
    return ctx.create('campaign_template', templateValues(ctx, body));
  } },
  { method: 'PATCH', path: TEMPLATE, name: 'campaign_template_update', roles: LEAD, versionKind: 'campaign_template', summary: 'Revise a campaign template', run(ctx, input) {
    const row = ctx.get('campaign_template', input.params.id!); version(row, input);
    fields(input.body, ['name', 'source_campaign_id', 'structure', 'expected_version']);
    return ctx.update('campaign_template', row.id, templateValues(ctx, { ...row, ...input.body }));
  } },
  { method: 'DELETE', path: TEMPLATE, name: 'campaign_template_delete', roles: LEAD, versionKind: 'campaign_template', summary: 'Delete an unused campaign template', run(ctx, input) {
    const row = ctx.get('campaign_template', input.params.id!); version(row, input);
    if (rows(ctx, 'campaign', 'template_id', row.id).length) conflict('This template is referenced by a campaign');
    ctx.remove('campaign_template', row.id);
    return { id: row.id, deleted: true };
  } },
  { method: 'POST', path: `${TEMPLATE}/instantiate`, name: 'campaign_template_instantiate', roles: PLAN, summary: 'Create a draft campaign, draft brief and dated plan from a template', run(ctx, input) {
    const row = ctx.get('campaign_template', input.params.id!);
    const body = input.body;
    fields(body, ['brand_id', 'name', 'kind', 'starts_at', 'ends_at', 'timezone', 'owner_user_id', 'utm_key', 'markets']);
    const structure = record(row.structure, 'structure');
    const starts_at = timestamp(body.starts_at, 'starts_at');
    const anchor = Date.parse(starts_at);
    const relative = (offset: unknown): string | null => offset == null ? null : new Date(anchor + Math.round(Number(offset) * HOUR_MS)).toISOString();
    const campaign = createCampaign(ctx, { ...body, kind: choice(body.kind ?? 'other', CAMPAIGN_KINDS, 'kind'), starts_at, ends_at: body.ends_at ?? relative(structure.duration_hours),
      plan_slots: (structure.plan_slots as Data[]).map(({ window_start_offset_hours, window_end_offset_hours, ...slot }) => ({ ...slot, window_start: relative(window_start_offset_hours), window_end: relative(window_end_offset_hours) })),
    }, row.id);
    if (structure.brief) {
      const briefTemplate = structure.brief as Data;
      const brief = createBrief(ctx, campaign, { kind: 'main', title: briefTemplate.title });
      createBriefRevision(ctx, brief, { body_doc: briefTemplate.body_doc,
        requirements: ((briefTemplate.requirements ?? []) as Data[]).map(item => ({ type: 'asset', count: item.count, due_at: relative(item.due_offset_hours) })),
      });
    }
    const tasks = structure.milestones as Data[];
    if (tasks.length) createCampaignTasks(ctx, campaign, tasks.map(({ offset_hours, ...task }) => ({ ...task, due_at: relative(offset_hours) })), 'campaign_milestone');
    return campaign;
  } },
];
