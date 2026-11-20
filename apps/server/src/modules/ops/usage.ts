import { DomainError, text, type Context } from '../types.js';
import { capabilities, choice, command, integer, invalid, ops } from './command-support.js';

const gauges: readonly string[] = ['seats', 'brands', 'social_accounts', 'storage_bytes'];
const meters = [...gauges, 'sync_calls', 'model_tokens', 'mcp_calls', 'vendor_queries'];
type UsageSource = string | { resource_type: string; resource_id: string; event_id?: string };
const ledger = 'usage_event';

function sourceKey(source: UsageSource | undefined): string | null {
  if (source === undefined) return null;
  if (typeof source === 'string') return text({ source }, 'source', 255);
  const type = text(source, 'resource_type', 128);
  const id = text(source, 'resource_id', 255);
  const event = source.event_id === undefined ? null : text(source, 'event_id', 255);
  return JSON.stringify([type, id, event]);
}

export async function getUsage(ctx: Context, metric: string, includeTenant = true) {
  const meter = choice(metric, meters, 'meter_key');
  const gauge = gauges.includes(meter);
  const now = new Date(ctx.now);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const asOf = now.toISOString();
  const store = (includeTenant && capabilities(ctx).opsTenantStore) || ctx;
  const rows = (await store.list(ops, ledger)).filter(({ data }) => data.meter_key === meter && data.occurred_at <= asOf);
  const opening = gauge ? rows.filter(({ data }) => data.occurred_at < start).reduce((total, { data }) => total + data.quantity, 0) : 0;
  const events = rows.filter(({ data }) => data.occurred_at >= start && data.occurred_at < end)
    .sort((a, b) => a.data.occurred_at.localeCompare(b.data.occurred_at));
  let current = opening;
  let peak = opening;
  for (const { data } of events) {
    current += data.quantity;
    peak = Math.max(current, peak);
  }
  return { meter_key: meter, period_start: start, period_end: end, aggregation: gauge ? 'peak' : 'sum',
    quantity: gauge ? peak : current, current, scope: store === ctx ? 'workspace' : 'tenant' };
}

/** Source modules call this in their transaction. P0 usage is recorded without quota enforcement. */
export async function appendUsageEvent(ctx: Context, metric: string, quantity: number, sourceRef?: UsageSource) {
  const meter = choice(metric, meters, 'meter_key');
  const delta = integer(quantity, 'quantity', gauges.includes(meter) ? -Number.MAX_SAFE_INTEGER : 0);
  const key = sourceKey(sourceRef);
  const id = key === null ? undefined : JSON.stringify([meter, key]);
  if (id !== undefined) {
    const previous = await ctx.get(ops, ledger, id);
    if (previous) {
      if (previous.data.quantity !== delta) throw new DomainError('usage_source_mismatch', 'Usage was recorded with another quantity', 409);
      return previous;
    }
  }
  const { current } = await getUsage(ctx, meter);
  if (!Number.isSafeInteger(current + delta) || current + delta < 0) return invalid('Usage total is out of range');
  return ctx.insert(ops, ledger, { meter_key: meter, workspace_id: ctx.workspaceId, quantity: delta, source_ref: sourceRef ?? null,
    occurred_at: new Date(ctx.now).toISOString() }, id);
}

export async function requireUsageCapacity(ctx: Context, metric: string, quantity: number): Promise<void> {
  const meter = choice(metric, meters, 'meter_key');
  const delta = integer(quantity, 'quantity');
  const limit = await capabilities(ctx).opsUsageLimit?.(meter, ctx.now);
  if (limit === undefined) return;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new DomainError('ops_capability_unavailable', 'Invalid configured limit', 503);
  const { current } = await getUsage(ctx, meter);
  if (delta > 0 && current + delta > limit) throw new DomainError('LICENSE_LIMIT', 'Usage quota exceeded', 402);
}

export const usageCommands = {
  get_usage: command(['owner'], async (ctx, input) => ({ items: await Promise.all(
    (input.meter_key === undefined ? meters : [choice(input.meter_key, meters, 'meter_key')])
      .map(metric => getUsage(ctx, metric, capabilities(ctx).opsTenantRole === 'owner')),
  ) })),
};
