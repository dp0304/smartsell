import { Problem, READ, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { currency, integer as reportInteger, text, timestamp } from '../ingest/ingest-input.js';
import { commandContext, unwrap } from '../inbox/operations.js';
import { DomainError } from '../types.js';
import { commissionCommands } from './commissions.js';
import { bad, choice, ids, integer, moneyCurrency, approvers, operators } from './model.js';

export function prepareReportedCommission(ctx: Context, order: Row, input: Data, source: Data) {
  const external_commission_id = text(input.external_commission_id, 'external_commission_id');
  const code = currency(input.currency);
  if (code !== order.currency) throw new Problem(422, 'CURRENCY_MISMATCH', 'Commission currency must match its order');
  const commission_minor = reportInteger(input.amount_minor, 'amount_minor');
  const previous = ctx.list('commission_entry').find(row => row.kind === 'reported' && row.order_id === order.id && row.external_commission_id === external_commission_id);
  const explicitTime = input.observed_at == null ? undefined : timestamp(input.observed_at);
  if (explicitTime && explicitTime > ctx.now) bad('observed_at');
  const observed_at = explicitTime ?? (previous?.commission_minor === commission_minor ? previous.observed_at : undefined) ?? ctx.now;
  const stale = typeof previous?.observed_at === 'string' && typeof observed_at === 'string' && previous.observed_at > observed_at;
  const status = !previous ? 'new' : stale || (previous.commission_minor === commission_minor && previous.observed_at === observed_at) ? 'unchanged' : 'changed';
  return { status, apply: () => {
    if (previous && status === 'unchanged') return previous;
    // Order-level report evidence has no approved order-line attribution or payable accrual.
    const data = { kind: 'reported', status: 'reported', source_kind: 'import', order_id: order.id, store_id: order.store_id,
      external_commission_id, commission_minor, currency: code, observed_at, source };
    const saved = previous ? ctx.update('commission_entry', previous.id, data) : ctx.create('commission_entry', data);
    ctx.emit('creator.commission.reported', { commission_entry_id: saved.id, order_id: order.id, batch_id: source.batch_id });
    return saved;
  } } as const;
}

export function evidence(body: Data, field = 'evidence_ids') {
  const refs = ids(body, field);
  return refs.length ? refs : bad(field);
}
export function commissionRule(data: Data) {
  const kind = choice(data.kind === undefined && data.mode !== undefined ? { kind: data.mode === 'percentage' ? 'rate' : data.mode } : data, 'kind', ['rate', 'fixed']);
  return {
    kind, basis: 'net_sales', observation_days: integer(data, 'observation_days', 0, 365),
    settlement_by: choice(data, 'settlement_by', ['self', 'tiktok_shop', 'shopify_collabs', 'other']),
    ...(kind === 'rate' ? { rate_bps: integer(data, 'rate_bps', 1, 10_000) } : { currency: moneyCurrency(data), amount_minor: integer(data, 'amount_minor', 1) }),
  };
}
function op(method: Operation['method'], path: string, name: string, command: string, roles: Operation['roles'], summary: string,
  dto: (input: Input) => Data = ({ body }) => body, versionKind?: string): Operation {
  return { method, path, name, roles, summary, versionKind, async run(ctx, input) {
    try { return unwrap(await commissionCommands[command].run(commandContext(ctx, 'creator'), dto(input))); }
    catch (error) {
      if (error instanceof DomainError) throw new Problem(error.status, error.code, error.message);
      throw error;
    }
  } };
}
const entry = ({ body, params, expectedVersion }: Input) => ({ ...body, commission_entry_id: params.id, expected_version: expectedVersion });
const batch = ({ body, params, expectedVersion }: Input) => ({ ...body, settlement_batch_id: params.id, expected_version: expectedVersion });
export const commissionOperations: Operation[] = [
  op('GET', '/commission-entries', 'commissions_list', 'list_commissions', READ, 'List the commission ledger', ({ query }) => query),
  { method: 'GET', path: '/collaborations/:id/attribution-reconciliation', name: 'commissions_reconcile_attribution', roles: approvers,
    summary: 'Compare collaboration accrual and imported commission observations by order', run(ctx, { params }) {
    const collaboration = ctx.get('collaboration', params.id);
    const ledger = ctx.list('commission_entry');
    const entriesByOrder = new Map<string, Row[]>();
    const reportsByOrder = new Map<string, Row[]>();
    for (const row of ledger) {
      if (typeof row.order_id !== 'string') continue;
      if (row.kind === 'reported') {
        const reports = reportsByOrder.get(row.order_id) ?? [];
        reports.push(row);
        reportsByOrder.set(row.order_id, reports);
      } else if (row.collaboration_id === collaboration.id && ['accrual', 'reversal'].includes(String(row.kind))) {
        const entries = entriesByOrder.get(row.order_id) ?? [];
        entries.push(row);
        entriesByOrder.set(row.order_id, entries);
      }
    }
    const orders = new Map(ctx.list('order').map(order => [order.id, order]));
    return [...entriesByOrder].flatMap(([orderId, entries]) => {
      const order = orders.get(orderId);
      if (!order) return [];
      return [{ order_id: orderId, external_order_id: order.external_order_id, currency: order.currency,
        ledger_entries: entries.map(row => ({ id: row.id, order_line_id: row.order_line_id, affiliate_assignment_id: row.affiliate_assignment_id,
          kind: row.kind, source_kind: row.source_kind, commission_minor: row.commission_minor, status: row.status })),
        // Imported reports are order-level observations with no proven creator assignment.
        order_level_reports: (reportsByOrder.get(orderId) ?? []).filter(row => row.store_id === order.store_id && row.currency === order.currency).map(row => ({
          id: row.id, external_commission_id: row.external_commission_id, source_kind: row.source_kind, commission_minor: row.commission_minor,
          observed_at: row.observed_at, report_batch_id: (row.source as Data | undefined)?.batch_id,
        })),
      }];
    });
  } },
  op('POST', '/commission-entries', 'commissions_accrue', 'accrue_commission', approvers, 'Calculate commission for a paid order line'),
  op('POST', '/commission-entries/import', 'commissions_import', 'accrue_commission', approvers, 'Import an evidenced attribution to a paid order line', ({ body }) => ({ ...body, source_kind: 'import' })),
  op('POST', '/commission-entries/mature', 'commissions_mature', 'mature_commissions', approvers, 'Mature observed commissions'),
  op('POST', '/commission-entries/:id/reverse', 'commissions_reverse', 'reverse_commission', approvers, 'Append a refund or cancellation adjustment', entry, 'commission_entry'),
  op('POST', '/commission-entries/:id/approve', 'commissions_approve', 'approve_commission', approvers, 'Approve an eligible commission', entry, 'commission_entry'),
  op('POST', '/commission-entries/:id/platform-settlement', 'commissions_record_platform_settlement', 'record_platform_settlement', approvers, 'Record external platform settlement evidence', entry, 'commission_entry'),
  { method: 'GET', path: '/settlement-batches', name: 'commissions_list_batches', roles: approvers, summary: 'List settlement batches', run: ctx => ctx.list('settlement_batch') },
  op('POST', '/settlement-batches', 'commissions_create_batch', 'create_settlement_batch', approvers, 'Submit a self-settled commission batch for approval'),
  op('POST', '/settlement-batches/:id/approve', 'commissions_batch_approve', 'approve_settlement_batch', approvers, 'Approve a self-settlement batch', batch, 'settlement_batch'),
  op('POST', '/settlement-batches/:id/cancel', 'commissions_batch_cancel', 'cancel_settlement_batch', approvers, 'Cancel a batch and release its entries', batch, 'settlement_batch'),
  op('POST', '/settlement-batches/:id/record-payment', 'commissions_batch_record_payment', 'record_settlement_payment', approvers, 'Record evidenced payment for an approved batch', batch, 'settlement_batch'),
];
