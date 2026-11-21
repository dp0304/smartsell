import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { makeContext } from '../../context.js';
import { operationRecords } from '../../integration/operation-records.js';
import type { Subscriber } from '../../operations.js';
import { DomainError, text, writers, type Context as CommandContext, type Fields } from '../types.js';
import { canReadFinancial } from './metrics.js';
import { commandReportGenerationInput, generateCommandReport } from './report-workflows.js';
import { generateReport, reportGenerationInput } from './reports.js';
import { revenueRoles } from './shared.js';

export const reportGenerationKind = 'analytics.generate_report_version';
export const reportDraftRoles = ['owner', 'admin', 'manager', 'editor', 'analyst'] as const;
const requested = `${reportGenerationKind}.requested`;

type CommandReportWorker = {
  runCommandReport?<T>(id: string, actorId: string, run: (ctx: CommandContext) => Promise<T>): Promise<T>;
};

function enqueue(ctx: Context, data: Data) {
  const { id } = ctx.create('operation', { kind: reportGenerationKind, status: 'queued', requested_by: ctx.actorId, ...data });
  ctx.emit(requested, { operation_id: id });
  return { operation_id: id };
}

export function queueReport(ctx: Context, id: string, body: Data) {
  const { report, cutoff, hasCommerce } = reportGenerationInput(ctx, id, body);
  return enqueue(ctx, { report_id: id, snapshot: { sections: report.sections, sensitive: report.sensitive },
    sensitive: report.sensitive, data_cutoff_at: cutoff, current_commerce: hasCommerce });
}

export async function queueCommandReport(ctx: CommandContext, input: Fields) {
  const { records, flush } = await operationRecords(ctx, false);
  const { report, sections, asOf, sensitive } = await commandReportGenerationInput(ctx, input);
  const agent_job_id = input.agent_job_id === undefined ? null : text(input, 'agent_job_id', 200);
  const result = enqueue(makeContext(records, ctx, ctx.role), { report_id: report.id, command_report: true, sensitive,
    snapshot: { title: report.data.title, sections, sensitive }, data_cutoff_at: asOf, agent_job_id });
  await flush();
  return result;
}

export function assertReportOperationVisible(ctx: Context, row: Row) {
  if (row.sensitive && !(row.command_report ? revenueRoles.some(role => role === ctx.role) : canReadFinancial(ctx))) {
    throw new Problem(404, 'NOT_FOUND', 'Operation not found');
  }
}

export function cancelReportGeneration(ctx: Context, operation: Row) {
  if (operation.status === 'cancelled') return operation;
  if (operation.status !== 'queued') throw new Problem(409, 'STATE_CONFLICT', 'Report generation has already finished');
  const cancelled = ctx.update('operation', operation.id, { status: 'cancelled', cancel_requested_at: ctx.now });
  ctx.emit(`${reportGenerationKind}.cancelled`, { operation_id: operation.id });
  return cancelled;
}

function queued(ctx: Context, event: Data) {
  const id = (event.data as Data)?.operation_id;
  if (typeof id !== 'string') return;
  const row = ctx.get('operation', id);
  if (row.kind === reportGenerationKind && row.status === 'queued') return row;
}

function finish(ctx: Context, row: Row, fields: Data) {
  ctx.update('operation', row.id, fields);
  ctx.emit(`${reportGenerationKind}.${fields.status}`, { operation_id: row.id });
}

export const reportGenerationSubscriber: Subscriber = {
  id: reportGenerationKind,
  sensitive: true,
  accepts: type => type === requested,
  async run(ctx, event) {
    const row = queued(ctx, event);
    if (!row) return;
    const actorId = String(row.requested_by);
    const reportId = String(row.report_id);
    const snapshot = row.snapshot as Fields;
    const role = (ctx as Context & { workspaceMemberRole?(id: string): Context['role'] }).workspaceMemberRole?.(actorId);
    if (!role || !reportDraftRoles.some(candidate => candidate === role)) {
      finish(ctx, row, { status: 'failed', error_code: 'FORBIDDEN' });
      return;
    }
    if (row.command_report) {
      const run = (ctx as Context & CommandReportWorker).runCommandReport;
      if (!run || !writers.some(candidate => candidate === role)) throw new Error('Command report worker is unavailable');
      const result = await run(row.id, actorId, async commandCtx => {
        const version = await generateCommandReport(commandCtx, {
          report_id: reportId, data_cutoff_at: row.data_cutoff_at, agent_job_id: row.agent_job_id ?? undefined,
        }, snapshot);
        return { status: version.data.status === 'failed' ? 'failed' : 'succeeded', sensitive: version.data.sensitive,
          result_ref: { report_id: reportId, version_id: version.id, version_no: version.data.version_no } };
      });
      finish(ctx, row, result);
      return;
    }
    try {
      const actor = { ...ctx, actorId, role };
      const prepared = reportGenerationInput(actor, reportId, {});
      const version = generateReport(actor, reportId, {}, { ...prepared, report: { ...prepared.report, ...snapshot },
        cutoff: row.current_commerce ? prepared.cutoff : String(row.data_cutoff_at) });
      finish(ctx, row, { status: 'succeeded', sensitive: ctx.get('report_version', String(version.id)).sensitive,
        result_ref: { report_id: reportId, version_id: version.id, version_no: version.version_no } });
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      finish(ctx, row, { status: 'failed', error_code: error.code });
    }
  },
  onTerminalFailure(ctx, _attempts, event) {
    const row = queued(ctx, event);
    if (row) finish(ctx, row, { status: 'failed', error_code: 'REPORT_GENERATION_FAILED' });
  },
};
