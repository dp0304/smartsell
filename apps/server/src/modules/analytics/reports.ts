import { pdfText } from './report-workflows.ts';
import { localMinute, resolveLocal } from '../../../../../packages/domain/src/publishing/index.js';
import { workspace } from '../workspace/brands.js';
import { accessibleBatch } from '../ingest/import-operations.ts';
import { checkUse } from '../ingest/source-policy.ts';
import { freezeReportMetricEvidence, importRowEvidence, reportMetricIngestProvenance, type MetricEvidenceRefs } from '../ingest/evidence.ts';
import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { canReadFinancial, compareMetrics, metricDefinitions, metricQueryInput } from './metrics.ts';
import { metricReportResult, reportObservationIds } from './report-metric-evidence.js';
import { attributionQuery, revenueDaily } from './commerce.ts';
import { array, choice, conflict, date, dto, invalid, object, period, strings, text, timezone } from './validation.ts';

const reportFields = ['title', 'kind', 'scope', 'period', 'sections', 'status', 'schedule', 'template_id'];
const versionFields = ['report_id', 'version_no', 'status', 'data_cutoff_at', 'query_snapshot', 'definition_revisions', 'attribution_versions',
  'results', 'evidence', 'narrative', 'data_issues', 'supersedes_version_id', 'finalized_at', 'finalized_by'];
function authorize(ctx: Context, sensitive: unknown) {
  if (sensitive && !canReadFinancial(ctx)) throw new Problem(403, 'analytics_revenue_forbidden', 'Revenue access is required');
}
export function reports(ctx: Context) {
  return ctx.list('report').filter(row => !row.sensitive || canReadFinancial(ctx)).map(row => dto(row, reportFields));
}
export function getReport(ctx: Context, id: string) {
  const report = ctx.get('report', id);
  authorize(ctx, report.sensitive);
  return dto(report, reportFields);
}
export function saveReport(ctx: Context, body: Data, id?: string, template = false) {
  const target = template ? 'report_template' : 'report';
  const prior = id ? ctx.get(target, id) : undefined;
  authorize(ctx, prior?.sensitive);
  const template_id = body.template_id === undefined ? undefined : text(body.template_id, 'template_id');
  const base = template_id && !prior && !template ? ctx.get('report_template', template_id) : undefined;
  authorize(ctx, base?.sensitive);
  const merged = { ...base, ...prior, ...body };
  const kind = choice(merged.kind ?? 'social_performance', ['social_performance', 'campaign', 'client_monthly', 'custom', 'ecommerce'], 'report kind');
  const time = period(merged.period);
  const scopeInput = object(merged.scope ?? {});
  const scope = Object.fromEntries(['brand_ids', 'social_account_ids', 'campaign_ids', 'platforms', 'market_ids']
    .filter(key => scopeInput[key] !== undefined).map(key => [key, strings(scopeInput[key], key)]));
  let sensitive = kind === 'ecommerce';
  const sections = array(merged.sections, 'sections', 30).map(raw => {
    const section = object(raw), key = text(section.key, 'section.key');
    const type = choice(section.type ?? 'table', ['kpi', 'chart', 'table', 'narrative'], 'section.type');
    const source = choice(section.source ?? (type === 'narrative' ? 'narrative' : 'metrics'), ['metrics', 'narrative', 'revenue', 'attribution'], 'section.source');
    if (source === 'narrative') return { key, type, source };
    if (source !== 'metrics') {
      sensitive = true;
      const query = object(section.query ?? {});
      if (Object.keys(scope).some(filter => filter !== 'campaign_ids') || (scope.campaign_ids && (source !== 'attribution' || scope.campaign_ids.length !== 1))) {
        invalid('Commerce sections support only a single campaign scope for attribution');
      }
      return { key, type, source, query: { ...time,
        store_id: query.store_id === undefined ? undefined : text(query.store_id, 'store_id'),
        ...(scope.campaign_ids ? { subject: { type: 'campaign', id: scope.campaign_ids[0] } } : {}) } };
    }
    const input = object(section.query), subject = object(input.subject), sectionFilter = object(subject.filter ?? {});
    const rawTime = object(input.time ?? {});
    const filter = { ...sectionFilter };
    for (const [name, values] of Object.entries(scope)) {
      filter[name] = filter[name] === undefined ? values : strings(filter[name], name).filter(value => values.includes(value));
    }
    const query = metricQueryInput(ctx, { ...input, subject: { ...subject, filter }, time: { ...rawTime, ...time } });
    if (metricDefinitions(ctx).some(def => (def.scope === 'commerce' || def.unit === 'currency') && query.metrics.includes(String(def.key)))) sensitive = true;
    return { key, type, source, query };
  });
  if (!sections.length || new Set(sections.map(row => row.key)).size !== sections.length) invalid('Report sections must have unique keys');
  const rawSchedule = merged.schedule == null ? undefined : object(merged.schedule);
  const schedule = rawSchedule && (() => {
    const tz = timezone(rawSchedule.tz ?? workspace(ctx).default_timezone);
    const next_at = date(rawSchedule.next_at);
    return { interval_days: choice(String(rawSchedule.interval_days), ['1', '7', '30'], 'schedule.interval_days'),
      next_at, tz, local_time: body.schedule === undefined && typeof rawSchedule.local_time === 'string'
        ? rawSchedule.local_time : localMinute(next_at, tz).slice(11) };
  })();
  authorize(ctx, sensitive);
  const value = { kind, title: text(merged.title, 'title'), scope, period: time, sections, sensitive, schedule: schedule ?? null,
    template_id: template ? undefined : template_id ?? prior?.template_id,
    status: choice(merged.status ?? 'active', ['active', 'archived'], 'status') };
  return dto(id ? ctx.update(target, id, value) : ctx.create(target, value), reportFields);
}
export function reportTemplates(ctx: Context) {
  return ctx.list('report_template').filter(row => !row.sensitive || canReadFinancial(ctx)).map(row => dto(row, reportFields));
}
export function reportGenerationInput(ctx: Context, id: string, body: Data) {
  const report = ctx.get('report', id);
  authorize(ctx, report.sensitive);
  if (report.status !== 'active') conflict('Report is archived');
  const now = date(ctx.now), cutoff = body.data_cutoff_at === undefined ? now : date(body.data_cutoff_at);
  if (cutoff > now) invalid('Report cutoff is in the future');
  const hasCommerce = (report.sections as { source: string }[]).some(section => !['narrative', 'metrics'].includes(section.source));
  if (hasCommerce && cutoff !== now) invalid('Historical commerce reports require a historical commerce snapshot');
  return { report, cutoff, hasCommerce };
}
export function generateReport(ctx: Context, id: string, body: Data, prepared = reportGenerationInput(ctx, id, body)) {
  const { report, cutoff } = prepared;
  authorize(ctx, report.sensitive);
  const sections = structuredClone(report.sections as { key: string; type?: string; source: string; query?: Data }[]);
  let sensitive = Boolean(report.sensitive);
  const definitions: Record<string, number[]> = Object.create(null);
  const attribution: Record<string, number[]> = Object.create(null);
  const issues: Data[] = [];
  const commerce_lineage: Record<string, ReturnType<typeof freezeLineage>> = Object.create(null);
  const observationIds = new Set<string>();
  let observations: Row[] | undefined;
  const results = sections.flatMap<{ section_key: string; data: Data }>(section => {
    if (section.source === 'narrative') return [];
    const lineage: Record<string, Row[]> = Object.create(null);
    const capture = (key: string, facts: Row[]) => { lineage[key] = facts; };
    if (section.source === 'revenue') {
      const data = revenueDaily(ctx, section.query!, capture);
      for (const warning of new Set([...data.warnings, ...data.rows.flatMap(row => row.warnings)])) issues.push({ section_key: section.key, warning });
      commerce_lineage[section.key] = freezeLineage(ctx, lineage);
      return [{ section_key: section.key, data }];
    }
    if (section.source === 'attribution') {
      const data = attributionQuery(ctx, section.query!, capture);
      for (const row of data.rows) attribution[row.model_key] = [...new Set([...(attribution[row.model_key] ?? []), ...row.revisions as number[]])];
      commerce_lineage[section.key] = freezeLineage(ctx, lineage);
      return [{ section_key: section.key, data }];
    }
    observations ??= ctx.list('metric_observation');
    const data = metricReportResult(section.type, compareMetrics(ctx, section.query as ReturnType<typeof metricQueryInput>, cutoff, observations));
    for (const observationId of reportObservationIds(data)) observationIds.add(observationId);
    const comparison = data.comparison;
    for (const def of [...data.definitions, ...(comparison?.definitions ?? [])]) {
      if (def.scope === 'commerce' || def.unit === 'currency') sensitive = true;
      const key = String(def.key);
      definitions[key] = [...new Set([...(definitions[key] ?? []), Number(def.revision)])];
    }
    for (const warning of new Set([...data.warnings, ...(comparison?.warnings ?? [])])) issues.push({ section_key: section.key, warning });
    return [{ section_key: section.key, data }];
  });
  authorize(ctx, sensitive);
  const metric_lineage = freezeReportMetricEvidence(ctx, observations?.filter(row => observationIds.has(row.id)) ?? []);
  const version_no = Math.max(0, ...ctx.list('report_version').filter(row => row.report_id === id).map(row => Number(row.version_no))) + 1;
  const row = ctx.create('report_version', { report_id: id, version_no, status: 'draft', sensitive,
    data_cutoff_at: cutoff, query_snapshot: sections, definition_revisions: definitions, attribution_versions: attribution, results, commerce_lineage, metric_lineage,
    data_issues: issues, narrative: [] });
  ctx.emit('analytics.report_version.ready', { report_id: id, version_id: row.id, version_no });
  return dto(row, versionFields);
}
export function version(ctx: Context, id: string, reportId?: string) {
  const row = ctx.get('report_version', id);
  if (reportId && reportId !== row.report_id) throw new Problem(404, 'report_version_not_found', 'Report version does not belong to report');
  authorize(ctx, row.sensitive);
  return row;
}
export function reportVersion(ctx: Context, id: string) { return dto(version(ctx, id), versionFields); }
export function reportProvenance(ctx: Context, id: string, observationId: string) {
  const report = version(ctx, id);
  const frozen = report.metric_lineage as MetricEvidenceRefs | undefined;
  if (frozen && Object.hasOwn(frozen, observationId)) return reportMetricIngestProvenance(ctx, observationId, frozen[observationId]!);
  if (!frozen) {
    const sections = report.query_snapshot as { key: string; type?: string; source?: string }[] | undefined;
    const found = (report.results as { section_key: string; data: Data }[]).some(({ section_key, data }) => {
      const section = sections?.find(row => row.key === section_key);
      return section?.type !== 'narrative' && (!section?.source || section.source === 'metrics') && reportObservationIds(data).includes(observationId);
    });
    if (found) return { observation_id: observationId, status: 'not_captured', raw_evidence: { status: 'not_retained' } };
  }
  throw new Problem(404, 'PROVENANCE_NOT_FOUND', 'Observation is not in this report version');
}
type TradeRef = { fact_id: string; kind: 'order' | 'refund'; source_kind?: string; batch_id?: string; import_row_id?: string };
function freezeLineage(ctx: Context, lineage: Record<string, Row[]>) {
  const imported = new Map(ctx.list('import_row').flatMap(row => {
    const ref = row.target_ref as Data | undefined;
    return row.status === 'merged' && ref?.module === 'commerce' ? [[JSON.stringify([row.batch_id, ref.resource_type, ref.resource_id]), row.id] as const] : [];
  }));
  return Object.fromEntries(Object.entries(lineage).map(([key, facts]) => [key, [...new Map(facts.map(fact => {
    const source = fact.source as Data | undefined;
    const kind = typeof fact.external_refund_id === 'string' ? 'refund' : 'order';
    const batch_id = typeof source?.batch_id === 'string' ? source.batch_id : undefined;
    const ref: TradeRef = { fact_id: fact.id, kind, source_kind: typeof source?.kind === 'string' ? source.kind : undefined,
      batch_id, import_row_id: imported.get(JSON.stringify([batch_id, kind, fact.id])) };
    return [fact.id, ref] as const;
  })).values()]]));
}

export function reportTradeProvenance(ctx: Context, id: string, sectionKey: string, traceKey?: string) {
  const report = version(ctx, id);
  const section = (report.query_snapshot as { key: string; source: string }[]).find(row => row.key === sectionKey);
  if (!section || !['revenue', 'attribution'].includes(section.source)) throw new Problem(404, 'PROVENANCE_NOT_FOUND', 'Commerce section is not in this report version');
  const sections = report.commerce_lineage as Record<string, Record<string, TradeRef[]>> | undefined;
  const frozen = sections && Object.hasOwn(sections, sectionKey) ? sections[sectionKey] : undefined;
  if (!frozen) {
    const evidence = report.evidence as Record<string, unknown> | undefined;
    return { status: 'not_captured', rows: [], references: evidence && Object.hasOwn(evidence, sectionKey) ? evidence[sectionKey] : [] };
  }
  if (traceKey !== undefined && !Object.hasOwn(frozen, traceKey)) throw new Problem(404, 'PROVENANCE_NOT_FOUND', 'Value is not in this report section');
  const importRows = new Map(ctx.list('import_row').map(row => [row.id, row]));
  const describe = (ref: TradeRef) => {
    const fact = { fact_id: ref.fact_id, kind: ref.kind };
    try {
      if (ref.source_kind === 'file_import' && ref.batch_id) {
        const batch = accessibleBatch(ctx, ref.batch_id);
        const candidate = ref.import_row_id ? importRows.get(ref.import_row_id) : undefined;
        const row = candidate?.batch_id === batch.id ? candidate : undefined;
        return { ...fact, import_batch_id: batch.id, source_row: row?.row_no, mapping_version: batch.mapping_version,
          ...importRowEvidence(ctx, batch, row) };
      }
      if (ref.source_kind === 'store_sync' && ref.batch_id) {
        const run = ctx.get('sync_run', ref.batch_id);
        checkUse(ctx, [String(run.data_source_id)], 'display');
        return { ...fact, sync_run_id: run.id, data_source_id: run.data_source_id, mapping_version: run.mapping_version, status: 'not_retained' };
      }
    } catch (error) {
      if (error instanceof Problem && error.status === 403) return { ...fact, status: 'restricted' };
      if (!(error instanceof Problem) || error.status !== 404) throw error;
    }
    return { ...fact, status: 'not_retained' };
  };
  const entries = traceKey === undefined ? Object.entries(frozen) : [[traceKey, frozen[traceKey]!] as const];
  return { status: 'captured', rows: entries.map(([key, refs]) => ({ key, sources: refs.map(describe) })) };
}

export function reportVersions(ctx: Context, id: string) {
  ctx.get('report', id);
  return ctx.list('report_version').filter(row => row.report_id === id && (!row.sensitive || canReadFinancial(ctx)))
    .sort((a, b) => Number(b.version_no) - Number(a.version_no)).map(row => dto(row, versionFields));
}
export function updateNarrative(ctx: Context, id: string, body: Data) {
  const row = version(ctx, id);
  if (row.status !== 'draft') conflict('Only a draft narrative can change');
  const sections = new Set((row.query_snapshot as { key: string }[]).map(section => section.key));
  const refs = new Set<string>(sections);
  for (const result of row.results as { data: { rows: { values?: Record<string, { refs: string[] }> }[]; evidence?: { observation_ids: string[] }[] } }[]) {
    for (const observation of result.data.evidence ?? []) for (const ref of observation.observation_ids) refs.add(ref);
    for (const entry of result.data.rows) for (const value of Object.values(entry.values ?? {})) for (const ref of value.refs ?? []) refs.add(ref);
  }
  const narrative = array(body.narrative, 'narrative', 30).map(raw => {
    const section = object(raw), section_key = text(section.section_key, 'section_key');
    if (!sections.has(section_key)) invalid('Narrative must reference a report section');
    const blocks = array(section.blocks, 'blocks', 30).map(raw => {
      const block = object(raw);
      const references = strings(block.refs, 'refs');
      if (!references.length || references.some(ref => !refs.has(ref))) invalid('Narrative references must identify frozen report evidence');
      return { kind: choice(block.kind, ['fact', 'estimate', 'recommendation'], 'narrative kind'), text: text(block.text, 'narrative text'), refs: references };
    });
    return { section_key, blocks };
  });
  return dto(ctx.update('report_version', id, { narrative }), versionFields);
}
export function finalizeReport(ctx: Context, id: string) {
  const row = version(ctx, id);
  if (row.status !== 'draft') conflict('Only a draft can be finalized');
  const prior = ctx.list('report_version').find(version => version.report_id === row.report_id && version.status === 'finalized');
  if (prior && (Number(prior.version_no) >= Number(row.version_no) || String(prior.data_cutoff_at) > String(row.data_cutoff_at))) conflict('Cannot finalize an older report snapshot');
  if (prior) ctx.update('report_version', prior.id, { status: 'superseded' });
  const saved = ctx.update('report_version', id, { status: 'finalized', finalized_at: date(ctx.now), finalized_by: ctx.actorId,
    supersedes_version_id: prior?.id });
  ctx.emit('analytics.report_version.finalized', { version_id: id, report_id: row.report_id, supersedes_version_id: prior?.id });
  return dto(saved, versionFields);
}
function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  const safe = typeof value === 'string' && /^\s*[=+\-@\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function exportReport(ctx: Context, id: string, body: Data) {
  const row = version(ctx, id);
  if (row.status !== 'finalized' && row.status !== 'superseded') conflict('A report must be finalized for export');
  const format = choice(body.format, ['csv', 'pdf', 'xlsx', 'pptx'], 'format');
  if (format !== 'csv' && format !== 'pdf') throw new Problem(501, 'analytics_renderer_unavailable', `${format} renderer is not configured`);
  const content = renderReportText(row, format);
  return format === 'pdf'
    ? { format, media_type: 'application/pdf', encoding: 'base64', version_id: row.id, content: Buffer.from(content).toString('base64') }
    : { format, media_type: 'text/csv; charset=utf-8', version_id: row.id, content };
}

export function reportExportRows(row: Row) {
  const rows: unknown[][] = [['section', 'group', 'metric', 'value', 'availability', 'refs']];
  for (const result of row.results as { section_key: string; data: { rows: (Data & { group?: Data; values?: Record<string, Data> })[] } }[]) {
    for (const item of result.data.rows) {
      if (item.values) for (const [metric, value] of Object.entries(item.values)) {
        rows.push([result.section_key, JSON.stringify(item.group), metric, value.value, value.availability, JSON.stringify(value.refs)]);
      } else rows.push([result.section_key, '', '', JSON.stringify(item), '', '']);
    }
  }
  for (const section of row.narrative as { section_key: string; blocks: { kind: string; text: string; refs: string[] }[] }[]) {
    for (const block of section.blocks) rows.push([section.section_key, '', block.kind, block.text, '', JSON.stringify(block.refs)]);
  }
  return rows;
}

export function renderReportText(row: Row, format: 'csv' | 'pdf') {
  const lines = reportExportRows(row).map(cells => cells.map(csvCell).join(','));
  return format === 'pdf' ? pdfText(lines) : lines.join('\r\n');
}

function nextOccurrence(now: string, schedule: { next_at: string; interval_days: string; tz?: string; local_time?: string }, tz: string) {
  const interval = Number(schedule.interval_days) * 86_400_000;
  const [lastDay, lastTime] = localMinute(schedule.next_at, tz).split('T');
  const time = schedule.local_time ?? lastTime;
  const today = Date.parse(`${localMinute(now, tz).slice(0, 10)}T00:00:00Z`);
  const previous = Date.parse(`${lastDay}T00:00:00Z`);
  let day = previous + interval * Math.max(1, Math.floor((today - previous) / interval));
  for (;;) {
    const local = `${new Date(day).toISOString().slice(0, 10)}T${time}`;
    let next: string;
    try { next = resolveLocal(local, tz, 'earlier_occurrence').scheduled_at; }
    catch (error) {
      if (!(error instanceof Problem) || error.code !== 'DST_GAP') throw error;
      next = resolveLocal(local, tz, 'shift_forward').scheduled_at;
    }
    if (next > now) return next;
    day += interval;
  }
}

export function prepareScheduledReports(ctx: Context) {
  const now = date(ctx.now);
  const results = [];
  for (const report of ctx.list('report')) {
    const schedule = report.schedule as { next_at: string; interval_days: string; tz?: string; local_time?: string } | null;
    if (report.status !== 'active' || !schedule || schedule.next_at > now) continue;
    const tz = schedule.tz ?? String(workspace(ctx).default_timezone);
    const next_at = nextOccurrence(now, schedule, tz);
    results.push(generateReport(ctx, report.id, {}));
    ctx.update('report', report.id, { schedule: { ...schedule, tz, local_time: schedule.local_time ?? localMinute(schedule.next_at, tz).slice(11), next_at } });
  }
  return { generated: results };
}
