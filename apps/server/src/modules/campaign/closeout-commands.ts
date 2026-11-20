import { DomainError, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { generateCommandReport, reportCommands } from '../analytics/report-workflows.ts';
import { budgetSummary } from './budget-commands.ts';
import { targetCampaignId, targetContentItemId } from './coordination-commands.ts';
import { command, conflict, emit, expected, fields, getCampaign, invalid, leadRoles, missing, moduleName, object, optionalText, readRoles, rows, text, timestamp, writeRoles } from './command-input.ts';

function reportMatchesCampaign(report: Entity, campaignId: string) {
  const scope = report.data.scope;
  if (scope?.campaign_ids !== undefined) {
    return Array.isArray(scope.campaign_ids) && scope.campaign_ids.length === 1 && scope.campaign_ids[0] === campaignId;
  }
  return (scope?.campaign_id ?? report.data.campaign_id) === campaignId;
}

async function closeoutData(ctx: Context, campaign: Entity, input: Fields) {
  const campaignId = campaign.id;
  const reportId = optionalText(input.report_version_id, 'report_version_id');
  const reportVersion = reportId ? await ctx.get('analytics', 'report_version', reportId) : undefined;
  if (reportId) {
    const report = reportVersion?.data.report_id ? await ctx.get('analytics', 'report', reportVersion.data.report_id) : undefined;
    if (!reportVersion || !['finalized', 'superseded'].includes(reportVersion.data.status) ||
      !(reportVersion.data.report_id ? report && reportMatchesCampaign(report, campaignId) : reportVersion.data.campaign_id === campaignId)) {
      invalid('Select a finalized report version for this campaign');
    }
    await reportCommands.reports_get.run(ctx, { version_id: reportId });
  }
  const cutoff = timestamp(reportVersion?.data.data_cutoff_at ?? ctx.now, 'data_cutoff_at');
  if (Date.parse(cutoff) > Date.parse(ctx.now)) invalid('Report cutoff cannot be in the future');
  const [goals, targets, collaboration, payouts, samples, budget, work, variants, items, posts] = await Promise.all([
    rows(ctx, 'campaign_goal', campaignId), ctx.list('planning', 'publish_target'), ctx.list('creator', 'collaboration'),
    ctx.list('creator', 'commission_entry'), ctx.list('creator', 'sample_shipment'), budgetSummary(ctx, campaignId), ctx.list('workspace', 'work_item'),
    ctx.list('content', 'content_variant'), ctx.list('content', 'content_item'), ctx.list('execution', 'platform_post'),
  ]);
  const variantsById = new Map(variants.map(row => [row.id, row]));
  const itemsById = new Map(items.map(row => [row.id, row]));
  const publishedTargets = new Set(posts.map(row => row.data.publish_target_id ?? row.data.target_id));
  const unfinishedTargets = targets.filter(target => {
    const variant = variantsById.get(target.data.content_variant_id ?? target.data.variant_id);
    const itemId = targetContentItemId(target, variant);
    const item = itemId ? itemsById.get(itemId) : undefined;
    const status = target.data.close_reason ?? target.data.plan_status ?? target.data.status;
    return targetCampaignId(target, item) === campaignId && !publishedTargets.has(target.id) &&
      !['closed', 'cancelled', 'superseded', 'published', 'manual_done', 'matched_native', 'failed_final', 'expired_skipped'].includes(status);
  });
  const collabIds = new Set(collaboration.filter(row => row.data.campaign_id === campaignId).map(row => row.id));
  const creatorLinked = (row: Entity) => row.data.campaign_id === campaignId || collabIds.has(row.data.collaboration_id);
  const refs = [
    ...unfinishedTargets.map(row => ({ type: 'publish_target', id: row.id, status: row.data.close_reason ?? row.data.plan_status ?? row.data.status ?? null })),
    ...payouts.filter(row => creatorLinked(row) && !['paid', 'settled', 'platform_settled', 'void', 'reversed', 'cancelled'].includes(row.data.status))
      .map(row => ({ type: 'commission_entry', id: row.id, status: row.data.status ?? null })),
    ...samples.filter(row => creatorLinked(row) && row.data.return_required !== false && !['returned', 'cancelled', 'draft'].includes(row.data.status))
      .map(row => ({ type: 'sample_shipment', id: row.id, status: row.data.status ?? null })),
    ...work.filter(row => (row.data.campaign_id === campaignId || (row.data.subject_ref?.type === 'campaign' && row.data.subject_ref.id === campaignId)) && !['done', 'completed', 'cancelled'].includes(row.data.status))
      .map(row => ({ type: 'work_item', id: row.id, status: row.data.status ?? null })),
  ];
  const supplied = input.retained_items === undefined ? {} : object(input.retained_items, 'retained_items');
  for (const key of Object.keys(supplied)) {
    if (!refs.some(ref => `${ref.type}:${ref.id}` === key)) invalid(`Unknown closeout issue ${key}`);
    text(supplied[key], `retained_items.${key}`, 4096);
  }
  const incomplete = refs.map(ref => ({ ...ref, retention_reason: optionalText(supplied[`${ref.type}:${ref.id}`], 'retention_reason', 4096) }));
  const reportResults = reportVersion?.data.results?.campaign_goals;
  const retrospective_doc = input.retrospective_doc == null ? null : object(input.retrospective_doc, 'retrospective_doc');
  return structuredClone({
    report_version_id: reportId, retrospective_doc,
    snapshot: { captured_at: ctx.now, data_cutoff_at: cutoff, campaign: campaign.data,
      goals: goals.map(goal => ({ goal_id: goal.id, ...goal.data, result: reportResults?.[goal.id] ?? null })),
      budget, incomplete, report_results: reportVersion?.data.results ?? null },
  });
}

const closeoutFields = ['campaign_id', 'report_version_id', 'retrospective_doc', 'retained_items'];
export const closeoutCommands: Commands = {
  closeout_draft: command(leadRoles, async (ctx, input) => {
    fields(input, closeoutFields);
    const campaign = await getCampaign(ctx, input);
    if (campaign.data.status !== 'wrapping') conflict('Campaign must be wrapping to preview closeout');
    return closeoutData(ctx, campaign, input);
  }),
  closeout: command(leadRoles, async (ctx, input) => {
    fields(input, [...closeoutFields, 'expected_version', 'checklist_complete']);
    const campaign = await getCampaign(ctx, input);
    const version = expected(campaign, input.expected_version);
    if (campaign.data.status !== 'wrapping' || (await rows(ctx, 'campaign_closeout', campaign.id)).length) conflict('Campaign must be wrapping and have no final closeout');
    if (input.checklist_complete !== true) invalid('Confirm checklist_complete');
    const values = await closeoutData(ctx, campaign, input);
    if (values.snapshot.incomplete.some(row => !row.retention_reason)) conflict('Resolve or explicitly retain each unfinished item');
    const closeout = await ctx.insert(moduleName, 'campaign_closeout', { ...values, campaign_id: campaign.id, closed_by: ctx.actorId });
    const updated = await ctx.update(moduleName, 'campaign', campaign.id, { status: 'closed', closed_at: ctx.now, closeout_id: closeout.id }, version);
    await emit(ctx, 'campaign.status_changed', campaign.id, { from: 'wrapping', to: 'closed', status: 'closed' });
    await emit(ctx, 'campaign.closed', campaign.id, { closeout_id: closeout.id, report_version_id: values.report_version_id });
    return { campaign: updated, closeout };
  }),
  get_closeout: command(readRoles, async (ctx, input) => {
    const closeout = (await rows(ctx, 'campaign_closeout', (await getCampaign(ctx, input)).id))[0];
    if (!closeout) return null;
    if (!closeout.data.report_version_id) return closeout;
    try {
      await reportCommands.reports_get.run(ctx, { version_id: closeout.data.report_version_id });
      return closeout;
    } catch (error) {
      if (!(error instanceof DomainError) || ![403, 404].includes(error.status)) throw error;
      const snapshot = closeout.data.snapshot;
      return { ...closeout, data: { ...closeout.data, snapshot: {
        ...snapshot, report_results: null, goals: snapshot.goals.map((goal: Fields) => ({ ...goal, result: null })),
      } } };
    }
  }),
  list_reports: command(readRoles, async (ctx, input) => {
    fields(input, ['campaign_id']);
    const campaign = await getCampaign(ctx, input);
    const reports = (await ctx.list('analytics', 'report')).filter(report => reportMatchesCampaign(report, campaign.id));
    const visible = await Promise.all(reports.map(async report => {
      try {
        return await reportCommands.reports_get.run(ctx, { report_id: report.id });
      } catch (error) {
        if (error instanceof DomainError && error.code === 'forbidden') return null;
        throw error;
      }
    }));
    return visible.filter(report => report !== null);
  }),
  backfill_report: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'report_id', 'data_cutoff_at']);
    const campaign = await getCampaign(ctx, input);
    const report = await ctx.get('analytics', 'report', text(input.report_id, 'report_id'));
    if (!report || !reportMatchesCampaign(report, campaign.id)) missing('Report does not belong to this campaign');
    if (campaign.data.status !== 'closed') conflict('Campaign must be closed to generate a backfill report');
    return generateCommandReport(ctx, { report_id: report.id, data_cutoff_at: input.data_cutoff_at });
  }),
};
