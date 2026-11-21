import { ADMIN, Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { prepareAdSpendReport } from '../ads/workspace-operations';
import { prepareReportUnitCost } from '../analytics/insights';
import { canReadFinancial, recordObservations } from '../analytics/metrics';
import { requirePhase, requirePlatformPhase } from '../commerce/domain';
import { importedOrder, prepareImport, prepareLogistics } from '../commerce/imports';
import { prepareReportedCommission } from '../creator/commission-operations';
import { prepareObservation } from '../intel/intel-observations';
import { asData, day, invalid, iso, text, timestamp } from './ingest-input';
import type { Template } from './templates';

export type Classification = 'new' | 'changed' | 'unchanged';
export type Target = { module: string; resource_type: string; resource_id: string };
interface Prepared { status: Classification; apply: () => Target }
export const storeTemplates = ['product_list', 'inventory_list', 'order_list', 'refund_list', 'logistics', 'commission', 'unit_cost'] as const;
const target = (module: string, kind: string, id: string): Target => ({ module, resource_type: kind, resource_id: id });

export function prepare(ctx: Context, batch: Row, template: Template, values: Data, _key: string, rowId?: string): Prepared {
  if (template === 'product_list' || template === 'inventory_list' || template === 'order_list' || template === 'refund_list') {
    const write = prepareImport(ctx, template, text(batch.store_id, 'store_id'), values, { batchId: batch.id, mode: 'file' });
    return { status: write.status, apply: () => target('commerce', write.resourceType, write().id) };
  }
  if (template === 'competitor_observation') {
    const { likes, comments, shares, views, ...metadata } = values;
    const metrics = Object.fromEntries(Object.entries({ likes, comments, shares, views }).map(([name, value]) => [name,
      value === undefined ? { availability: 'source_not_provided' } : { availability: 'observed', value }]));
    const write = prepareObservation(ctx, { ...metadata, subject_type: metadata.subject_type ?? 'post', metrics,
      data_source_id: batch.data_source_id ?? undefined, source: { batch_id: batch.id } }, 'import');
    return { status: write.status === 'create' ? 'new' : 'unchanged', apply: () => target('intel', 'observation', write().id) };
  }
  if (template === 'social_post_report' || template === 'social_account_report') {
    const account = ctx.get('social_account', text(values.social_account_id, 'social_account_id'));
    const source = batch.data_source_id ? ctx.get('data_source', String(batch.data_source_id)) : undefined;
    if (source?.social_account_id && account.id !== source.social_account_id) invalid('Account is outside the data source');
    const subjectType = template === 'social_post_report' ? 'platform_post' : 'social_account';
    const subject = template === 'social_post_report' ? ctx.list('platform_post').find(post => (post.social_account_id ?? post.account_id) === account.id && post.external_post_id === values.external_post_id) : account;
    if (!subject) invalid('Register the platform post before importing its observations', 'UNKNOWN_PLATFORM_POST');
    const availability = values.availability ?? (values.value === undefined ? 'source_not_provided' : 'observed');
    const value = values.value === undefined ? null : Number(values.value);
    if (value !== null && (typeof values.value !== 'string' || !/^-?\d+(\.\d+)?$/.test(values.value) || !Number.isFinite(value))) invalid('Metric value is not numeric');
    const start = text(values.report_date, 'report_date');
    const zone = asData(batch.options).timezone;
    const nextCalendarDate = typeof values.report_day === 'string' ? iso(Date.parse(`${values.report_day}T00:00:00Z`) + day).slice(0, 10) : undefined;
    const end = nextCalendarDate && typeof zone === 'string' ? timestamp(nextCalendarDate, zone) : iso(Date.parse(start) + day);
    const lifetime = values.period_kind === 'lifetime';
    // A lifetime total is a snapshot as of the end of its report day, so several days in one file stay distinct points.
    const observed = values.observed_at ?? (lifetime && Date.parse(end) < Date.parse(String(batch.created_at)) ? end : batch.created_at);
    const period = lifetime ? { period_kind: 'lifetime' } : { period_kind: 'day', period_start: start, period_end: end, date: values.report_day };
    const observation = {
      subject_type: subjectType, subject_id: subject.id, metric_key: values.metric_key, value, availability, ...period, observed_at: observed,
      source: { method: 'import', batch_id: batch.id, data_source_id: source?.id },
    };
    const matching = ctx.list('metric_observation').filter(row => row.subject_type === subjectType && row.subject_id === subject.id &&
      row.metric_key === values.metric_key && (lifetime ? row.period_kind === 'lifetime' && row.observed_at === observed : row.period_kind !== 'lifetime' && row.period_start === start && row.period_end === end) &&
      asData(row.source).data_source_id === source?.id && !Object.values(asData(row.dims)).some(item => item !== undefined)).sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)));
    const previous = values.observed_at === undefined ? matching[0] : matching.find(row => row.observed_at === observed);
    if (previous?.value === value && previous.availability === availability) {
      return { status: 'unchanged', apply: () => target('analytics', 'metric_observation', previous.id) };
    }
    const preview: Context = {
      ...ctx, list: ctx.list.bind(ctx), get: ctx.get.bind(ctx),
      create: (_kind, row) => ({ ...row, id: 'preview', version: 1, created_at: ctx.now, updated_at: ctx.now }), emit: () => {},
      update: () => { throw new Error('Unexpected preview update'); }, remove: () => { throw new Error('Unexpected preview delete'); },
    };
    recordObservations(preview, { observations: [observation] });
    return { status: matching.length ? 'changed' : 'new', apply: () => {
      const { ids } = recordObservations(ctx, { observations: [observation] });
      if (!ids[0]) throw new Error('Analytics sink did not return a stored observation');
      return target('analytics', 'metric_observation', ids[0]);
    } };
  }
  requirePhase(ctx, 'p1');
  const source = { method: 'import', batch_id: batch.id, row_id: rowId, data_source_id: batch.data_source_id ?? undefined };
  if (template === 'ad_report') {
    const write = prepareAdSpendReport(ctx, batch, values, source);
    return { status: write.status, apply: () => target('analytics', 'metric_observation', write.apply().id) };
  }
  const store = ctx.get('store', text(batch.store_id, 'store_id'));
  requirePlatformPhase(ctx, store.provider);
  if (store.status === 'disabled') throw new Problem(409, 'store_disabled', 'Store is disabled');
  if (template === 'unit_cost') {
    if (!canReadFinancial(ctx)) throw new Problem(403, 'FORBIDDEN', 'Unit cost reports require financial access');
    const write = prepareReportUnitCost(ctx, store.id, values, source);
    return { status: write.status, apply: () => target('analytics', 'unit_cost_version', write.apply().id) };
  }
  if (!ADMIN.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Transaction reports require store administration');
  if (template === 'logistics') {
    const write = prepareLogistics(ctx, store.id, values, source);
    return { status: write.status, apply: () => target('commerce', write.resourceType, write().id) };
  }
  const order = importedOrder(ctx, store.id, values.external_order_id);
  const write = prepareReportedCommission(ctx, order, values, source);
  return { status: write.status, apply: () => target('creator', 'commission_entry', write.apply().id) };
}
