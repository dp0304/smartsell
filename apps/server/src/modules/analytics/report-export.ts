import { Problem, type Context, type Data, type Input, type Row } from '@smartsell/contracts';
import type { FastifyReply } from 'fastify';
import { mediaFor } from '../../integration/media-host.js';
import type { Subscriber } from '../../operations.js';
import { checkUse } from '../ingest/source-policy.js';
import { financialRoles } from './metrics.js';
import { collectSourceIds } from './report-workflows.js';
import { reportExportRows, renderReportText, version } from './reports.js';
import { renderReportXlsx } from './report-xlsx.js';
import { choice } from './validation.js';

export const reportExportKind = 'analytics.render_report_file';
export const reportExportRoles: readonly Context['role'][] = financialRoles;
const requested = `${reportExportKind}.requested`;
const cleanup = `${reportExportKind}.cleanup_requested`;
const formats = ['pdf', 'csv', 'xlsx'] as const;
const mimeTypes = { pdf: 'application/pdf', csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const missing = () => new Problem(404, 'NOT_FOUND', 'Report export not found');

function exportVersion(ctx: Context, { id, n }: Input['params']) {
  ctx.get('report', id);
  const versionNo = Number(n);
  const row = /^[1-9]\d*$/.test(n) && Number.isSafeInteger(versionNo) &&
    ctx.list('report_version').find(item => item.report_id === id && item.version_no === versionNo);
  if (!row) throw missing();
  return version(ctx, row.id, id);
}

function checkExport(ctx: Context, row: Row) {
  if (!reportExportRoles.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Report export access is required');
  if (row.status !== 'finalized' && row.status !== 'superseded') {
    throw new Problem(409, 'STATE_CONFLICT', 'A report must be finalized for export');
  }
  const sources = new Set<string>();
  collectSourceIds(row.results, sources);
  collectSourceIds(row.metric_lineage, sources);
  // Older snapshots may have observation references without a captured ingest envelope.
  const observations = row.metric_lineage as Data | undefined;
  const unresolved = new Set(Object.keys(observations ?? {}).filter(id => !observations?.[id]));
  if (unresolved.size) for (const observation of ctx.list('metric_observation')) {
    if (unresolved.has(observation.id)) collectSourceIds(observation, sources);
  }
  try {
    const lineage = row.commerce_lineage as Record<string, Record<string, { source_kind?: string; batch_id?: string }[]>> | undefined;
    for (const section of Object.values(lineage ?? {})) for (const refs of Object.values(section)) for (const ref of refs) {
      if (!ref.batch_id) continue;
      const kind = ref.source_kind === 'file_import' ? 'import_batch' : ref.source_kind === 'store_sync' ? 'sync_run' : undefined;
      const sourceId = kind && ctx.get(kind, ref.batch_id).data_source_id;
      if (typeof sourceId === 'string') sources.add(sourceId);
    }
    checkUse(ctx, [...sources], 'export');
  } catch (error) {
    if (!(error instanceof Problem) || error.status !== 404) throw error;
    throw new Problem(403, 'EGRESS_BLOCKED', 'A source used by this report is unavailable');
  }
}

// Run before the platform idempotency lookup so replays observe current source policy.
export function authorizeReportExport(ctx: Context, input: Input) {
  checkExport(ctx, exportVersion(ctx, input.params));
  return ctx;
}

export function queueReportExport(ctx: Context, { params, body }: Input) {
  const row = exportVersion(ctx, params);
  const format = choice(body.format, formats, 'format');
  const existing = ctx.list('operation').find(item => item.kind === reportExportKind && item.version_id === row.id &&
    item.format === format && item.requested_by === ctx.actorId && (item.status === 'queued' || item.status === 'succeeded'));
  if (existing) return { operation_id: existing.id };
  const operation = ctx.create('operation', { kind: reportExportKind, status: 'queued', requested_by: ctx.actorId,
    report_id: row.report_id, version_id: row.id, version_no: row.version_no, format });
  ctx.emit(requested, { operation_id: operation.id });
  return { operation_id: operation.id };
}

export function assertReportExportVisible(ctx: Context, operation: Row) {
  if (!reportExportRoles.includes(ctx.role)) throw missing();
  version(ctx, String(operation.version_id), String(operation.report_id));
}

export function listReportExports(ctx: Context, { params }: Input) {
  const row = exportVersion(ctx, params);
  return { items: ctx.list('operation').filter(item => item.kind === reportExportKind && item.version_id === row.id &&
    item.requested_by === ctx.actorId).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(item => ({
      operation_id: item.id, format: item.format, status: item.status, version: item.version, error_code: item.error_code,
    })) };
}

export async function downloadReportExport(ctx: Context, { params }: Input) {
  const operation = ctx.get('operation', params.id);
  if (operation.kind !== reportExportKind || operation.status !== 'succeeded' || typeof operation.file_object_id !== 'string') throw missing();
  checkExport(ctx, version(ctx, String(operation.version_id), String(operation.report_id)));
  return mediaFor(ctx).readReportExport(ctx, operation.file_object_id, operation.id);
}

export function sendReportExport(reply: FastifyReply, data: unknown) {
  const file = data as Awaited<ReturnType<typeof downloadReportExport>>;
  return reply.type(file.mime).header('content-disposition', `attachment; filename="${file.filename}"`)
    .header('content-length', file.size).header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff').send(file.stream);
}

function finish(ctx: Context, operation: Row, fields: Data) {
  const result = ctx.update('operation', operation.id, fields);
  ctx.emit(`${reportExportKind}.${fields.status}`, { operation_id: operation.id });
  if (fields.status === 'cancelled' || fields.status === 'failed') ctx.emit(cleanup, { operation_id: operation.id });
  return result;
}

export function cancelReportExport(ctx: Context, operation: Row) {
  if (operation.status === 'cancelled') return operation;
  if (operation.status !== 'queued') throw new Problem(409, 'STATE_CONFLICT', 'Report export has already finished');
  return finish(ctx, operation, { status: 'cancelled', cancel_requested_at: ctx.now });
}

function exportOperation(ctx: Context, event: Data) {
  const id = (event.data as Data)?.operation_id;
  if (typeof id !== 'string') return;
  const row = ctx.get('operation', id);
  if (row.kind === reportExportKind) return row;
}

export const reportExportSubscriber: Subscriber = {
  id: reportExportKind,
  sensitive: true,
  accepts: type => type === requested || type === cleanup,
  async run(ctx, event) {
    const operation = exportOperation(ctx, event);
    if (!operation) return;
    if (event.type === cleanup) {
      if (operation.status === 'cancelled' || operation.status === 'failed') await mediaFor(ctx).discardReportExport(ctx, operation.id);
      return;
    }
    if (operation.status !== 'queued') return;
    const actorId = String(operation.requested_by);
    const member = (ctx as Context & { activeWorkspaceMembers?: { userId: string; role: Context['role']; scopes?: string[] }[] })
      .activeWorkspaceMembers?.find(item => item.userId === actorId);
    let row: Row;
    try {
      if (!member || member.scopes?.length || !reportExportRoles.includes(member.role)) {
        throw new Problem(403, 'FORBIDDEN', 'Report export access is required');
      }
      const actor = { ...ctx, role: member.role, actorId };
      row = version(actor, String(operation.version_id), String(operation.report_id));
      checkExport(actor, row);
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      finish(ctx, operation, { status: 'failed', error_code: error.code });
      return;
    }
    const format = choice(operation.format, formats, 'format');
    const bytes = format === 'xlsx' ? await renderReportXlsx(reportExportRows(row)) : Buffer.from(renderReportText(row, format));
    const file = await mediaFor(ctx).storeReportExport({ ...ctx, actorId }, operation.id, bytes, mimeTypes[format], `report-v${row.version_no}.${format}`);
    finish(ctx, operation, { status: 'succeeded', file_object_id: file.id,
      result_ref: { report_id: row.report_id, version_id: row.id, version_no: row.version_no, format } });
  },
  onTerminalFailure(ctx, _attempts, event) {
    const operation = exportOperation(ctx, event);
    if (event.type !== cleanup && operation?.status === 'queued') finish(ctx, operation, { status: 'failed', error_code: 'REPORT_EXPORT_FAILED' });
  },
};
