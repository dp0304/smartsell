import { ADMIN, READ, type Context, type Input, type Operation } from '@smartsell/contracts';
import { attributionExplain, attributionModels, attributionQuery, reconciliationChecks, reconcileRevenue, recordReportedAttribution, revenueDaily, reviseModel, runAttribution } from './commerce.ts';
import { applyPostingTime, audienceInsights, cohorts, contribution, experimentAction, experiments, getExperiment, importUnitCosts, postingTimes, recordAudience, recordContributionInputs, recordExperimentResult, saveExperiment, suggestPostingTime } from './insights.ts';
import { compareMetrics, financialRoles, metricDefinitions, metricQueryInput, postHistory, recordObservations, reviseMetricDefinition } from './metrics.ts';
import { authorizeReportExport, downloadReportExport, listReportExports, queueReportExport } from './report-export.js';
import { queueReport, reportDraftRoles as draft } from './report-generation.js';
import { exportReport, finalizeReport, getReport, prepareScheduledReports, reports, reportTemplates, reportProvenance, reportTradeProvenance, reportVersion, reportVersions, saveReport, updateNarrative } from './reports.ts';
import { linkActivity } from './traffic.ts';
import { date, invalid, period, text } from './validation.ts';

const definitionAdmin = ['owner', 'admin', 'analyst'] as const;
const op = (method: Operation['method'], path: string, name: string, roles: Operation['roles'], summary: string,
  run: Operation['run'], versionKind?: string): Operation => ({ method, path, name, roles, summary, run, versionKind });
const parameters = (input: Input) => ({ ...input.query, ...input.body });
function cutoff(ctx: Context, input: unknown): string {
  const now = date(ctx.now), at = input === undefined ? now : date(input);
  if (at > now) invalid('Cutoff is in the future');
  return at;
}
function getDefinitions(ctx: Context, input: Input) {
  const key = input.params.id ?? input.query.keys;
  const keys = key?.split(',');
  return { items: metricDefinitions(ctx).filter(row => !keys || keys.includes(row.key)) };
}
function performance(kind: 'platform_post' | 'social_account') {
  return (ctx: Context, input: Input) => {
    const { query: q } = input;
    const type = kind === 'platform_post' ? 'published_at' : 'period';
    const { from, to, tz } = period(q);
    const filters = Object.fromEntries(['subject_ids', 'brand_ids', 'social_account_ids', 'platforms', 'campaign_ids', 'content_types', 'market_ids']
      .filter(key => q[key] !== undefined).map(key => [key, q[key].split(',')]));
    const raw = { metrics: (q.metrics ?? (kind === 'platform_post' ? 'norm.post.engagements' : 'norm.account.followers')).split(','),
      time: { from, to, tz, basis: q.basis ?? type }, subject: { type: kind, filter: filters },
      granularity: q.granularity, age_bucket: q.age_bucket ?? (kind === 'platform_post' && !q.granularity && (q.basis ?? type) === 'published_at' ? '24h' : undefined),
      traffic_source: q.traffic_source };
    const at = cutoff(ctx, q.data_cutoff_at);
    const query = metricQueryInput(ctx, raw);
    const totals = compareMetrics(ctx, query, at);
    const items = ctx.list(kind).filter(row => row.created_at <= at && (!filters.subject_ids || filters.subject_ids.includes(row.id)))
      .map(row => ({ subject_id: row.id, ...compareMetrics(ctx, { ...query, subject: { ...query.subject, filter: { ...filters, subject_ids: [row.id] } } }, at) }))
      .filter(row => row.coverage.subjects_total > 0);
    return { items, as_of: at, coverage: totals.coverage, warnings: totals.warnings };
  };
}
export const operations: Operation[] = [
  op('GET', '/metric-definitions', 'metric_definitions_get', READ, 'List versioned metric definitions', getDefinitions),
  op('GET', '/metric-definitions/:id', 'metric_definition_get', READ, 'Read a metric definition and its revisions', getDefinitions),
  op('POST', '/metric-definitions', 'revise_metric_definition', definitionAdmin, 'Create or revise a workspace metric definition', (ctx, input) => reviseMetricDefinition(ctx, input.body)),
  op('POST', '/metrics/observations', 'analytics_record_observations', ADMIN, 'Import normalized metric observations', (ctx, input) => recordObservations(ctx, input.body)),
  op('POST', '/metrics/query', 'metrics_query', READ, 'Query metrics with their coverage and evidence', (ctx, input) => compareMetrics(ctx, metricQueryInput(ctx, input.body), cutoff(ctx, input.body.data_cutoff_at))),
  op('GET', '/performance/posts', 'posts_performance_get', READ, 'Read per-post performance and comparable age buckets', performance('platform_post')),
  op('GET', '/performance/posts/:id/history', 'post_performance_history', READ, 'Read the observation history of one post', (ctx, input) => postHistory(ctx, input.params.id)),
  op('GET', '/performance/accounts', 'accounts_performance_get', READ, 'Read account performance and trends', performance('social_account')),
  op('GET', '/performance/links', 'links_performance_get', READ, 'Read redirects, filtered clicks, and consented event counts', (ctx, input) => ({
    items: linkActivity(ctx, period(input.query), cutoff(ctx, input.query.data_cutoff_at), input.query.short_link_id, input.query.campaign_id), as_of: cutoff(ctx, input.query.data_cutoff_at) })),
  op('GET', '/reports', 'reports_list', draft, 'List report definitions', reports),
  op('POST', '/reports', 'reports_create', draft, 'Create a report definition', (ctx, input) => saveReport(ctx, input.body)),
  op('GET', '/reports/:id', 'report_definition_get', draft, 'Read a report definition', (ctx, input) => getReport(ctx, input.params.id)),
  op('PATCH', '/reports/:id', 'reports_update', draft, 'Edit a report definition', (ctx, input) => saveReport(ctx, input.body, input.params.id), 'report'),
  op('GET', '/reports/:id/versions', 'report_versions_list', READ, 'List frozen report snapshots', (ctx, input) => reportVersions(ctx, input.params.id)),
  { ...op('POST', '/reports/:id/versions', 'reports_generate_version', draft, 'Queue generation of a frozen report draft',
    (ctx, input) => queueReport(ctx, input.params.id, input.body)), accepted: true },
  op('GET', '/report-versions/:id', 'reports_get', READ, 'Read a frozen report snapshot', (ctx, input) => reportVersion(ctx, input.params.id)),
  op('GET', '/report-versions/:id/provenance', 'report_provenance_get', READ, 'Trace a frozen metric observation to its ingest evidence',
    (ctx, input) => reportProvenance(ctx, input.params.id, text(input.query.observation_id, 'observation_id'))),
  op('GET', '/report-versions/:id/commerce-provenance', 'report_commerce_provenance_get', financialRoles, 'Trace a frozen commerce section to its original fact sources',
    (ctx, input) => reportTradeProvenance(ctx, input.params.id, text(input.query.section_key, 'section_key'),
      input.query.trace_key === undefined ? undefined : text(input.query.trace_key, 'trace_key'))),
  op('PATCH', '/report-versions/:id/narrative', 'reports_update_narrative', draft, 'Edit only a draft narrative', (ctx, input) => updateNarrative(ctx, input.params.id, input.body), 'report_version'),
  op('POST', '/report-versions/:id/finalize', 'reports_finalize', financialRoles, 'Finalize and lock a report snapshot', (ctx, input) => finalizeReport(ctx, input.params.id), 'report_version'),
  op('POST', '/report-versions/:id/export', 'reports_export', financialRoles, 'Export a finalized report snapshot', (ctx, input) => exportReport(ctx, input.params.id, input.body)),
  { ...op('POST', '/reports/:id/versions/:n/export', 'reports_queue_export', financialRoles, 'Queue a file for this finalized report version',
    queueReportExport), accepted: true, scopeContext: authorizeReportExport },
  op('GET', '/reports/:id/versions/:n/exports', 'report_exports_list', financialRoles, 'List exports of this report version', listReportExports),
  op('GET', '/report-exports/:id/download', 'report_export_download', financialRoles, 'Download the stored report export', downloadReportExport),
  op('GET', '/report-templates', 'report_templates_list', draft, 'List reusable report templates', reportTemplates),
  op('POST', '/report-templates', 'report_templates_create', draft, 'Create a reusable report template', (ctx, input) => saveReport(ctx, input.body, undefined, true)),
  op('POST', '/reports/scheduled/generate', 'reports_generate_due', ADMIN, 'Generate drafts for due report schedules', prepareScheduledReports),
  op('GET', '/attribution/orders/:id/explain', 'attribution_explain', financialRoles, 'Explain one order’s attribution models and evidence', (ctx, input) => attributionExplain(ctx, ctx.get('order', input.params.id))),
  op('POST', '/attribution/query', 'attribution_query', financialRoles, 'Query each model’s credit and unattributed amounts separately', (ctx, input) => attributionQuery(ctx, input.body)),
  op('GET', '/attribution-models', 'attribution_models_get', financialRoles, 'List model revisions and windows', attributionModels),
  op('PATCH', '/attribution-models/:id', 'attribution_models_revise', ADMIN, 'Create a new revision of a model window', (ctx, input) => reviseModel(ctx, input.body, input.params.id)),
  op('POST', '/attribution/runs', 'attribution_run', financialRoles, 'Recompute order attribution from workspace evidence', (ctx, input) => runAttribution(ctx, input.body)),
  op('POST', '/attribution/reported', 'attribution_record_reported', ADMIN, 'Import authorized provider-reported credits', (ctx, input) => recordReportedAttribution(ctx, input.body)),
  op('GET', '/revenue/daily', 'revenue_query', financialRoles, 'Read daily sales, refunds, and collection with coverage', (ctx, input) => revenueDaily(ctx, parameters(input))),
  op('GET', '/revenue/reconciliation', 'revenue_reconciliation_list', financialRoles, 'Read reconciliation checks and source differences',
    (ctx, input) => reconciliationChecks(ctx, input.query.store_id)),
  op('POST', '/revenue/reconciliation', 'revenue_reconcile', financialRoles, 'Reconcile observed order totals against an authorized source total',
    (ctx, input) => reconcileRevenue(ctx, input.body)),
  op('POST', '/unit-costs/import', 'unit_costs_import', financialRoles, 'Import normalized unit costs', (ctx, input) => importUnitCosts(ctx, input.body)),
  op('POST', '/contribution/inputs', 'contribution_record_inputs', ADMIN, 'Record normalized contribution evidence', (ctx, input) => recordContributionInputs(ctx, input.body)),
  op('GET', '/contribution', 'contribution_query', financialRoles, 'Read estimated contribution and missing cost items', (ctx, input) => contribution(ctx, parameters(input))),
  op('GET', '/cohorts', 'cohorts_list', financialRoles, 'Read comparable first-purchase cohorts', (ctx, input) => cohorts(ctx, parameters(input))),
  op('GET', '/cohorts/:id', 'cohort_get', financialRoles, 'Read one store’s first-purchase cohorts', (ctx, input) => { ctx.get('store', input.params.id); return cohorts(ctx, parameters(input), input.params.id)[0]; }),
  op('GET', '/experiments', 'experiments_list', draft, 'List experiment designs and decisions', experiments),
  op('POST', '/experiments', 'experiments_create', draft, 'Register an experiment design', (ctx, input) => saveExperiment(ctx, input.body)),
  op('GET', '/experiments/:id', 'experiment_get', draft, 'Read design and result snapshots', (ctx, input) => getExperiment(ctx, input.params.id)),
  op('PATCH', '/experiments/:id', 'experiment_update', draft, 'Edit an experiment before starting it', (ctx, input) => saveExperiment(ctx, input.body, input.params.id), 'experiment'),
  ...(['start', 'stop', 'conclude', 'archive'] as const).map(action => op('POST', `/experiments/:id/${action}`, `experiment_${action}`, draft,
    `Transition an experiment to ${action}`, (ctx, input) => experimentAction(ctx, input.params.id, action, input.body), 'experiment')),
  op('POST', '/experiments/:id/results', 'experiment_record_result', draft, 'Store an immutable experiment evidence snapshot', (ctx, input) => recordExperimentResult(ctx, input.params.id, input.body)),
  op('GET', '/audience-insights', 'audience_insights_get', READ, 'Read audience snapshots by source', (ctx, input) => audienceInsights(ctx, input.query.social_account_id)),
  op('POST', '/audience-insights', 'audience_insights_record', ADMIN, 'Ingest normalized audience snapshots', (ctx, input) => recordAudience(ctx, input.body)),
  op('GET', '/posting-time-recommendations', 'posting_time_get', READ, 'Read saved posting-time recommendations', (ctx, input) => postingTimes(ctx, input.query.social_account_id)),
  op('POST', '/posting-time-recommendations/:id/apply', 'posting_time_apply', ['owner', 'admin', 'manager', 'editor'], 'Apply suggestions as planning slot templates',
    (ctx, input) => applyPostingTime(ctx, input.params.id), 'posting_time_recommendation'),
  op('POST', '/posting-time-recommendations', 'posting_time_suggest', draft, 'Calculate candidate publishing hours for comparable posts', (ctx, input) => suggestPostingTime(ctx, input.body)),
];
