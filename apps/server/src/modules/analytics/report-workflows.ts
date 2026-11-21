import { createHash } from 'node:crypto';
import { DomainError, readers, required, reviewers, text, writers, type Commands, type Context, type Entity, type Fields, type Role } from '../types.js';
import { commandMetricIngestProvenance, freezeCommandMetricEvidence, type MetricEvidenceRefs } from '../ingest/evidence.js';
import { parseMetricQuery, queryMetrics } from './metrics.js';
import { metricReportResult, reportObservationIds } from './report-metric-evidence.js';
import { definitionsAt, definitionFor } from './registry.js';
import { attributionQuery, parseAttributionQuery, parseSalesQuery, revenueQuery } from './sales.js';
import { choice, cutoff, currentTime, integer, invalid, moduleKey, object, period, ref, revenueRoles, state, strings } from './shared.js';

const reportKinds = ['social_performance', 'campaign', 'client_monthly', 'custom', 'ecommerce'] as const;
const sectionTypes = ['kpi', 'chart', 'table', 'narrative'] as const;
const scopeKeys = ['brand_ids', 'social_account_ids', 'campaign_ids', 'platforms', 'market_ids', 'store_ids'] as const;
type MetricSection = { key: string; type: string; source: 'metrics'; query: ReturnType<typeof parseMetricQuery> };
type RevenueSection = { key: string; type: string; source: 'revenue'; query: ReturnType<typeof parseSalesQuery> };
type AttributionSection = { key: string; type: string; source: 'attribution'; query: ReturnType<typeof parseAttributionQuery> };
type Section = MetricSection | RevenueSection | AttributionSection;
const canReadRevenue = (role: Role) => revenueRoles.some(candidate => candidate === role);
function guardFinancial(role: Role, sensitive: boolean) {
  if (sensitive && !canReadRevenue(role)) throw new DomainError('forbidden', 'Revenue access is required for this report', 403);
}
function overlap(first: string[] | undefined, second: string[] | undefined) {
  if (!first) return second;
  if (!second) return first;
  return first.filter(id => second.includes(id));
}
function parseReport(input: Fields) {
  const title = text(input, 'title', 200), kind = choice(input.kind, reportKinds, 'report.kind');
  const range = period(input.period);
  const scope: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(object(input.scope ?? {}, 'scope'))) {
    choice(key, scopeKeys, 'scope key');
    scope[key] = strings(value, `scope.${key}`);
  }
  if (!Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 20) invalid('Provide 1–20 report sections');
  const keys = new Set<string>();
  const sections = input.sections.map(raw => {
    const section = object(raw, 'section');
    const key = text(section, 'key', 80);
    if (!/^[a-z][a-z0-9_]*$/.test(key) || keys.has(key)) invalid('Use unique section keys in snake_case');
    keys.add(key);
    const type = choice(section.type, sectionTypes, 'section.type');
    const source = choice(section.source ?? 'metrics', ['metrics', 'revenue', 'attribution'], 'section.source');
    const query = object(section.query, 'section.query');
    if (source === 'metrics') {
      const subject = object(query.subject, 'query.subject');
      const filter = object(subject.filter ?? {}, 'query.subject.filter');
      const merged = { ...filter };
      for (const criterion of scopeKeys.filter(k => k !== 'store_ids')) if (scope[criterion] !== undefined) merged[criterion] = overlap(scope[criterion], filter[criterion] === undefined ? undefined : strings(filter[criterion], criterion));
      return { key, type, source, query: parseMetricQuery({ ...query, subject: { ...subject, filter: merged }, time: { ...range, ...query.time } }) };
    }
    const stores = query.store_ids === undefined ? undefined : strings(query.store_ids, 'store_ids');
    const expanded = { ...query, period: query.period ?? range, store_ids: overlap(scope.store_ids, stores) };
    return { key, type, source, query: source === 'revenue' ? parseSalesQuery(expanded) : parseAttributionQuery(expanded) };
  }) as Section[];
  return { title, kind, scope, period: range, sections };
}
function isSensitive(sections: Section[], registry: Awaited<ReturnType<typeof definitionsAt>>) {
  return sections.some(section => section.source !== 'metrics' || section.query.metrics.some(key => {
    const definition = definitionFor(registry, key);
    return definition.scope === 'commerce' || definition.unit === 'currency';
  }));
}
function expected(row: Entity, input: Fields) {
  const version = integer(input.expected_version, 'expected_version', 1);
  if (version !== row.version) throw new DomainError('version_conflict', 'Report record version changed', 409);
  return version;
}
export function collectSourceIds(raw: unknown, ids: Set<string>) {
  if (Array.isArray(raw)) { for (const child of raw) collectSourceIds(child, ids); return; }
  if (!raw || typeof raw !== 'object') return;
  for (const [key, child] of Object.entries(raw)) {
    if (key === 'data_source_id' && typeof child === 'string') ids.add(child);
    else collectSourceIds(child, ids);
  }
}
async function guardSnapshotUse(ctx: Context, version: Entity, use: 'display' | 'export') {
  const ids = new Set<string>();
  collectSourceIds(version.data.results, ids);
  for (const id of ids) {
    const source = await ctx.get('ingest', 'data_source', id);
    if (!source || source.data.status === 'disabled' || source.data.allowed_uses?.[use] !== true) {
      throw new DomainError('egress_blocked', `A source used by this snapshot does not permit ${use}`, 403);
    }
  }
}
function reportVersionView(row: Entity): Entity {
  const { metric_lineage: _lineage, ...data } = row.data;
  return { ...row, data };
}
function collectRefs(raw: unknown, refs: Map<string, ReturnType<typeof ref>>) {
  if (Array.isArray(raw)) { for (const child of raw) collectRefs(child, refs); return; }
  if (!raw || typeof raw !== 'object') return;
  const item = raw as Fields;
  if (typeof item.module === 'string' && typeof item.kind === 'string' && typeof item.id === 'string' && Number.isSafeInteger(item.version)) {
    refs.set(`${item.module}/${item.kind}/${item.id}`, { module: item.module, kind: item.kind, id: item.id, version: item.version });
  }
  for (const child of Object.values(item)) collectRefs(child, refs);
}
function readNarrative(raw: unknown, results: Fields, evidence: Fields) {
  if (!Array.isArray(raw) || raw.length > 20) invalid('Narrative must contain up to 20 sections');
  const known = new Set<string>();
  for (const key of Object.keys(results)) {
    known.add(`section:${key}`);
    for (const row of evidence[key] ?? []) known.add(`${row.module}/${row.kind}/${row.id}`);
  }
  const sections = new Set<string>();
  return raw.map(item => {
    const section = object(item, 'narrative section');
    const section_key = text(section, 'section_key', 80);
    if (!Object.hasOwn(results, section_key) || sections.has(section_key)) invalid('Narrative section must refer to a unique report section');
    sections.add(section_key);
    if (!Array.isArray(section.blocks) || section.blocks.length < 1 || section.blocks.length > 20) invalid('A narrative section must have 1–20 blocks');
    return { section_key, blocks: section.blocks.map(rawBlock => {
      const block = object(rawBlock, 'narrative block');
      const refs = strings(block.refs, 'refs', 20);
      if (!refs.length || refs.some(item => !known.has(item))) invalid('Narrative references must point to frozen sections or records');
      return { kind: choice(block.kind, ['fact', 'estimate', 'recommendation'], 'narrative kind'), text: text(block, 'text', 4000), refs };
    }) };
  });
}
function spreadsheetCell(value: unknown): string {
  let raw = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(raw)) raw = `'${raw}`;
  return `"${raw.replaceAll('"', '""')}"`;
}
function exportRows(version: Entity) {
  const rows: unknown[][] = [['report_version', 'data_cutoff_at', 'section', 'dimension', 'metric', 'value', 'availability', 'currency', 'warnings']];
  for (const [key, result] of Object.entries(version.data.results)) {
    const section = result as Fields;
    const warnings = (section.warnings ?? []).join('|');
    const records = section.rows as Fields[];
    if (!records.length) rows.push([version.data.version_no, version.data.data_cutoff_at, key, null, null, null, 'not_collected', null, warnings]);
    for (const record of records) {
      if (record.values) for (const [metric, raw] of Object.entries(record.values)) {
        const cell = raw as Fields;
        rows.push([version.data.version_no, version.data.data_cutoff_at, key, record.group, metric, cell.value, cell.availability, cell.currency, warnings]);
      } else for (const [metric, value] of Object.entries(record).filter(([field]) => field.endsWith('_minor'))) {
        rows.push([version.data.version_no, version.data.data_cutoff_at, key,
          { day: record.day, store_id: record.store_id, model_key: record.model_key, order_id: record.order_id }, metric, value, value === null ? 'not_collected' : 'observed', record.currency, warnings]);
      }
    }
  }
  for (const section of version.data.narrative ?? []) for (const block of section.blocks) {
    rows.push([version.data.version_no, version.data.data_cutoff_at, section.section_key, block.refs, block.kind, block.text]);
  }
  return rows;
}
export function pdfText(lines: string[]) {
  // The PDF uses the built-in Helvetica font. CSV retains the full Unicode content.
  const wrap = lines.flatMap(line => line.normalize('NFKD').replace(/\p{Mark}/gu, '').replace(/[^ -~]/g, '?').match(/.{1,100}/g) ?? ['']);
  const contents: string[][] = [];
  for (let offset = 0; offset < wrap.length; offset += 54) contents.push(wrap.slice(offset, offset + 54));
  const definitions = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${contents.map((_, i) => `${i * 2 + 4} 0 R`).join(' ')}] /Count ${contents.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [i, page] of contents.entries()) {
    const stream = `BT /F1 9 Tf 12 TL 36 760 Td\n${page.map(line => `(${line.replace(/[()\\]/g, '\\$&')}) Tj T*`).join('\n')}\nET\n`;
    definitions.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${i * 2 + 5} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  let data = '%PDF-1.4\n';
  const offsets = definitions.map((definition, index) => {
    const offset = data.length;
    data += `${index + 1} 0 obj\n${definition}\nendobj\n`;
    return offset;
  });
  const xref = data.length;
  return `${data}xref\n0 ${definitions.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${definitions.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

export async function commandReportGenerationInput(ctx: Context, input: Fields, snapshot?: Fields) {
  const report = await required(ctx, moduleKey, 'report', text(input, 'report_id', 200));
  guardFinancial(ctx.role, report.data.sensitive);
  if (report.data.status !== 'active') state('Archived report cannot generate a version');
  const asOf = cutoff(ctx, input.data_cutoff_at);
  const sections = (snapshot ?? report.data).sections as Section[];
  const registry = await definitionsAt(ctx, asOf);
  const sensitive = (snapshot ?? report.data).sensitive || isSensitive(sections, registry);
  guardFinancial(ctx.role, sensitive);
  return { report, sections, asOf, sensitive: Boolean(sensitive) };
}

export async function generateCommandReport(ctx: Context, input: Fields, snapshot?: Fields) {
  const { report, sections, asOf, sensitive } = await commandReportGenerationInput(ctx, input, snapshot);
  const results: Fields = {}, definition_revisions: Fields = {}, attribution_versions: Fields = {}, evidence: Fields = {}, data_issues = [];
  const observationIds = new Set<string>();
  let observations: Entity[] | undefined;
  try {
    for (const section of sections) {
      let result;
      if (section.source === 'metrics') {
        observations ??= await ctx.list(moduleKey, 'metric_observation');
        const primary = await queryMetrics(ctx, section.query, asOf, canReadRevenue(ctx.role), observations);
        const comparison = section.query.compare ? await queryMetrics(ctx, { ...section.query, time: { ...section.query.time, ...section.query.compare } }, asOf, canReadRevenue(ctx.role), observations) : null;
        result = metricReportResult(section.type, comparison ? { ...primary, comparison } : primary);
        for (const observationId of reportObservationIds(result)) observationIds.add(observationId);
        for (const definition of [...primary.definitions_used, ...(comparison?.definitions_used ?? [])]) {
          definition_revisions[definition.key] = [...new Set([...(definition_revisions[definition.key] ?? []), ...definition.revisions])].sort((a, b) => a - b);
        }
      } else if (section.source === 'revenue') result = await revenueQuery(ctx, section.query, asOf);
      else {
        result = await attributionQuery(ctx, section.query, asOf);
        Object.assign(attribution_versions, result.model_versions);
      }
      results[section.key] = result;
      const refs = new Map<string, ReturnType<typeof ref>>();
      collectRefs(result, refs);
      evidence[section.key] = [...refs.values()];
      for (const warning of result.warnings) data_issues.push({ section_key: section.key, code: warning });
    }
  } catch (failure) {
    if (!(failure instanceof DomainError) || failure.code !== 'historical_revision_unavailable') throw failure;
    const row = await ctx.insert(moduleKey, 'report_version', { report_id: report.id, version_no: report.data.next_version_no, status: 'failed', sensitive, data_cutoff_at: asOf,
      query_snapshot: sections, results: {}, evidence: {}, data_issues: [{ code: failure.code, message: failure.message }] });
    await ctx.update(moduleKey, 'report', report.id, { next_version_no: report.data.next_version_no + 1 }, report.version);
    await ctx.emit('analytics.report_version.failed', { report_id: report.id, version_id: row.id, code: failure.code });
    return row;
  }
  const metric_lineage = await freezeCommandMetricEvidence(ctx, observations?.filter(row => observationIds.has(row.id)) ?? []);
  const row = await ctx.insert(moduleKey, 'report_version', { report_id: report.id, title: (snapshot ?? report.data).title, status: 'draft', version_no: report.data.next_version_no,
    data_cutoff_at: asOf, query_snapshot: sections, definition_revisions, attribution_versions, evidence, results, data_issues, narrative: [], sensitive, metric_lineage,
    supersedes_version_id: null, agent_job_id: input.agent_job_id === undefined ? null : text(input, 'agent_job_id', 200) });
  await ctx.update(moduleKey, 'report', report.id, { next_version_no: report.data.next_version_no + 1 }, report.version);
  await ctx.emit('analytics.report_version.ready', { report_id: report.id, version_id: row.id, version_no: row.data.version_no });
  return reportVersionView(row);
}

export const reportCommands: Commands = {
  reports_create: { roles: writers, async run(ctx, input) {
    const parsed = parseReport(input);
    const sensitive = isSensitive(parsed.sections, await definitionsAt(ctx, currentTime(ctx)));
    guardFinancial(ctx.role, sensitive);
    const row = await ctx.insert(moduleKey, 'report', { ...parsed, section_inputs: input.sections, sensitive, owner_user_id: ctx.actorId, status: 'active', next_version_no: 1, finalized_version_id: null });
    await ctx.emit('analytics.report.created', { report_id: row.id, kind: parsed.kind });
    return row;
  } },
  reports_update: { roles: writers, async run(ctx, input) {
    const row = await required(ctx, moduleKey, 'report', text(input, 'report_id', 200));
    guardFinancial(ctx.role, row.data.sensitive);
    if (row.data.status !== 'active') state('Archived report cannot be edited');
    const revision = expected(row, input);
    const parsed = parseReport({ title: input.title ?? row.data.title, kind: input.kind ?? row.data.kind, period: input.period ?? row.data.period,
      scope: input.scope ?? row.data.scope, sections: input.sections ?? row.data.section_inputs ?? row.data.sections });
    const sensitive = isSensitive(parsed.sections, await definitionsAt(ctx, currentTime(ctx)));
    guardFinancial(ctx.role, sensitive);
    const updated = await ctx.update(moduleKey, 'report', row.id, { ...parsed, sensitive, section_inputs: input.sections ?? row.data.section_inputs ?? row.data.sections }, revision);
    await ctx.emit('analytics.report.updated', { report_id: row.id });
    return updated;
  } },
  reports_get: { roles: readers, async run(ctx, input) {
    if (input.version_id !== undefined) {
      const row = await required(ctx, moduleKey, 'report_version', text(input, 'version_id', 200));
      guardFinancial(ctx.role, row.data.sensitive);
      await guardSnapshotUse(ctx, row, 'display');
      return reportVersionView(row);
    }
    const report = await required(ctx, moduleKey, 'report', text(input, 'report_id', 200));
    guardFinancial(ctx.role, report.data.sensitive);
    const versions = (await ctx.list(moduleKey, 'report_version')).filter(row => row.data.report_id === report.id && (!row.data.sensitive || canReadRevenue(ctx.role)));
    if (input.version_no === undefined) return { report, versions: versions.sort((a, b) => b.data.version_no - a.data.version_no).map(row => ({ id: row.id, version: row.version, version_no: row.data.version_no, status: row.data.status, data_cutoff_at: row.data.data_cutoff_at })) };
    const row = versions.find(item => item.data.version_no === integer(input.version_no, 'version_no', 1));
    if (!row) throw new DomainError('not_found', 'Report version not found', 404);
    await guardSnapshotUse(ctx, row, 'display');
    return reportVersionView(row);
  } },
  report_provenance_get: { roles: readers, async run(ctx, input) {
    const version = await required(ctx, moduleKey, 'report_version', text(input, 'version_id', 200));
    guardFinancial(ctx.role, version.data.sensitive);
    await guardSnapshotUse(ctx, version, 'display');
    const id = text(input, 'observation_id', 200);
    const frozen = version.data.metric_lineage as MetricEvidenceRefs | undefined;
    if (frozen && Object.hasOwn(frozen, id)) return commandMetricIngestProvenance(ctx, id, frozen[id]!);
    if (!frozen) {
      const sections = version.data.query_snapshot as Section[] | undefined;
      const found = Object.entries(version.data.results ?? {}).some(([key, data]) => {
        const section = sections?.find(row => row.key === key);
        return section?.type !== 'narrative' && (!section?.source || section.source === 'metrics') && reportObservationIds(data as Fields).includes(id);
      });
      if (found) return { observation_id: id, status: 'not_captured', raw_evidence: { status: 'not_retained' } };
    }
    throw new DomainError('not_found', 'Observation is not in this report version', 404);
  } },
  reports_update_narrative: { roles: writers, async run(ctx, input) {
    const version = await required(ctx, moduleKey, 'report_version', text(input, 'version_id', 200));
    guardFinancial(ctx.role, version.data.sensitive);
    if (version.data.status !== 'draft') state('Only drafts can change the narrative');
    await guardSnapshotUse(ctx, version, 'display');
    const row = await ctx.update(moduleKey, 'report_version', version.id, { narrative: readNarrative(input.narrative, version.data.results, version.data.evidence) }, expected(version, input));
    await ctx.emit('analytics.report_version.narrative_updated', { version_id: row.id });
    return reportVersionView(row);
  } },
  reports_finalize: { roles: reviewers, async run(ctx, input) {
    const version = await required(ctx, moduleKey, 'report_version', text(input, 'version_id', 200));
    guardFinancial(ctx.role, version.data.sensitive);
    if (version.data.status !== 'draft') state('Only a draft can be finalized');
    await guardSnapshotUse(ctx, version, 'display');
    const revision = expected(version, input);
    const report = await required(ctx, moduleKey, 'report', version.data.report_id);
    const previous = report.data.finalized_version_id ? await required(ctx, moduleKey, 'report_version', report.data.finalized_version_id) : undefined;
    if (previous && previous.data.version_no >= version.data.version_no) state('A newer report is already finalized');
    if (previous) await ctx.update(moduleKey, 'report_version', previous.id, { status: 'superseded', superseded_by_version_id: version.id }, previous.version);
    const row = await ctx.update(moduleKey, 'report_version', version.id, { status: 'finalized', finalized_by: ctx.actorId, finalized_at: currentTime(ctx), supersedes_version_id: previous?.id ?? null }, revision);
    await ctx.update(moduleKey, 'report', report.id, { finalized_version_id: row.id }, report.version);
    await ctx.emit('analytics.report_version.finalized', { report_id: report.id, version_id: row.id, supersedes_version_id: previous?.id ?? null });
    return reportVersionView(row);
  } },
  reports_export: { roles: reviewers, async run(ctx, input) {
    const version = await required(ctx, moduleKey, 'report_version', text(input, 'version_id', 200));
    guardFinancial(ctx.role, version.data.sensitive);
    if (!['finalized', 'superseded'].includes(version.data.status)) state('Only finalized report versions can be exported');
    await guardSnapshotUse(ctx, version, 'export');
    const format = choice(input.format, ['csv', 'pdf'], 'format');
    const rows = exportRows(version);
    const content = format === 'csv' ? rows.map(row => row.map(spreadsheetCell).join(',')).join('\r\n') + '\r\n'
      : pdfText([version.data.title, `Version ${version.data.version_no} | Cutoff ${version.data.data_cutoff_at}`, ...rows.slice(1).map(row => row.slice(2).map(item => typeof item === 'object' ? JSON.stringify(item) : item ?? '').join(' | '))]);
    const file = await ctx.insert(moduleKey, 'report_export', { version_id: version.id, format, sha256: createHash('sha256').update(content).digest('hex'), size_bytes: Buffer.byteLength(content) });
    await ctx.emit('analytics.report_version.exported', { version_id: version.id, export_id: file.id, format });
    return { export_id: file.id, filename: `report-v${version.data.version_no}.${format}`, mime_type: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf', encoding: format === 'csv' ? 'utf-8' : 'base64', content: format === 'csv' ? content : Buffer.from(content).toString('base64') };
  } },
};