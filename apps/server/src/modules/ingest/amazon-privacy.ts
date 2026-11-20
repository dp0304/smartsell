import { createHash } from 'node:crypto';
import type { Context, Data, Row } from '@smartsell/contracts';
import type { Schedule, Subscriber } from '../../operations.js';
import { raiseAlert } from '../ops/controls.js';
import { getRetentionPolicy } from '../ops/retention.js';
import { audit } from '../ops/support.js';
import { asData, day, iso } from './ingest-input';
import { forbiddenColumn, privateValue } from './templates';

export const AMAZON = 'amazon_sp';
const task = 'ingest.purge_misstored_pii';
const dataClass = 'store_pii_amazon';
const compact = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const privateLocationField = /^(?:ship|shipping|bill|billing|delivery)?(?:name|city|country|countrycode|state|stateorregion|province|county|district|region|municipality|zip|mobile|mobilenumber|telephone|company|companyname|taxid|cpf|cnpj)$/;
const privatePartyFields = new Set(['shipto', 'billto', 'soldto', 'shiptoaddress', 'trackingid']);

export function amazonPrivateColumn(key: string) {
  const field = compact(key);
  return forbiddenColumn(key) || privateValue(key) || privatePartyFields.has(field) || privateLocationField.test(field);
}

function scrub(value: unknown): { value: unknown; removed: number } {
  if (typeof value === 'string' && privateValue(value)) return { value: null, removed: 1 };
  if (Array.isArray(value)) {
    const children = value.map(scrub);
    return { value: children.map(child => child.value), removed: children.reduce((sum, child) => sum + child.removed, 0) };
  }
  if (value === null || typeof value !== 'object') return { value, removed: 0 };
  const entries: [string, unknown][] = [];
  let removed = 0;
  for (const [key, child] of Object.entries(value)) {
    if (amazonPrivateColumn(key) || (typeof child === 'string' && privateValue(child))) {
      removed++;
      continue;
    }
    const cleaned = scrub(child);
    entries.push([key, cleaned.value]);
    removed += cleaned.removed;
  }
  return { value: Object.fromEntries(entries), removed };
}

export function evidenceHash(payload: Data) {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
}

// Only preserve known top-level evidence fields. Native Orders aliases keep the same normalized shape.
const rawAliases: Record<string, string> = {
  amazonorderid: 'external_order_id', orderid: 'external_order_id', refundid: 'external_refund_id',
  createdtime: 'placed_at', purchasetime: 'placed_at', purchasedate: 'placed_at', lastupdatedtime: 'external_updated_at',
  orderstatus: 'status',
};
export function amazonRawEvidence(payload: Data, allowed: ReadonlySet<string>): Data {
  const values = new Map<string, unknown>();
  for (const [key, value] of Object.entries(payload)) {
    const target = allowed.has(key) ? key : rawAliases[compact(key)];
    if (!target || !allowed.has(target)) continue;
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && !privateValue(value))) {
      if (key === target || !values.has(target)) values.set(target, value);
    }
  }
  return Object.fromEntries(values);
}

function instant(value: unknown, now: number) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now ? time : undefined;
}

function deliveredAt(value: unknown, now: number): number | undefined {
  const fields = asData(value);
  for (const [key, value] of Object.entries(fields)) {
    if (['orderdeliveredat', 'deliveredat', 'deliveredtime', 'actualdeliverydate', 'actualdeliverytime'].includes(compact(key))) {
      const time = instant(value, now);
      if (time !== undefined) return time;
    }
  }
  for (const [key, value] of Object.entries(fields)) {
    if (['order', 'payload', 'orderchange', 'delivery', 'fulfillment'].includes(compact(key))) {
      const time = deliveredAt(value, now);
      if (time !== undefined) return time;
    }
  }
}

function providerFor(ctx: Context) {
  const sources = new Map(ctx.list('data_source').map(row => [row.id, row]));
  const stores = new Map(ctx.list('store').map(row => [row.id, row]));
  const batches = new Map(ctx.list('import_batch').map(row => [row.id, row]));
  return (row: Row) => {
    const batch = batches.get(String(row.batch_id ?? row.import_batch_id));
    const source = sources.get(String(row.data_source_id ?? row.routed_data_source_id ?? batch?.data_source_id));
    const storeId = source?.store_id ?? batch?.store_id;
    const isAmazon = [row.provider, source?.provider, batch?.provider, stores.get(String(storeId))?.provider].includes(AMAZON);
    return { isAmazon, storeId, batch };
  };
}

/** The policy is the outer deadline. Any PII found is removed during this pass, even before that deadline. */
export async function backgroundAmazonRetentionDays(ctx: Context) {
  const host = ctx as Context & { backgroundRetentionDays?(dataClass: string): Promise<number | undefined> };
  const days = await host.backgroundRetentionDays?.(dataClass);
  return typeof days === 'number' && Number.isInteger(days) && days >= 0 ? days : 30;
}

export function purgeMisstoredAmazonPii(ctx: Context, commandDays = 30, eligible?: (kind: string, row: Row) => boolean) {
  const scope = providerFor(ctx);
  const now = Date.parse(ctx.now);
  const days = Math.min(commandDays, Number(getRetentionPolicy(ctx, dataClass)?.retain_days ?? 30));
  const orders = new Map(ctx.list('order').map(order => [JSON.stringify([order.store_id, order.external_order_id]), order]));
  let rows = 0;
  const surfaces = { raw_record: ['payload'], webhook_delivery: ['payload'], import_row: ['raw', 'normalized'] } as const;
  for (const kind of Object.keys(surfaces) as (keyof typeof surfaces)[]) {
    for (const row of ctx.list(kind)) {
      if (eligible && !eligible(kind, row)) continue;
      const { isAmazon, storeId, batch } = scope(row);
      if (!isAmazon) continue;
      const patch: Data = {};
      let removed = 0;
      for (const field of surfaces[kind]) {
        const result = scrub(row[field]);
        if (!result.removed) continue;
        patch[field] = result.value;
        removed += result.removed;
      }
      if (!removed) continue;
      if (kind === 'raw_record') patch.payload_hash = evidenceHash(asData(patch.payload));
      const payload = asData(row.payload ?? row.normalized ?? row.raw);
      const externalId = payload.external_order_id ?? payload.orderId ?? payload.amazonOrderId ?? (row.resource === 'orders' ? row.external_id : undefined);
      const order = typeof storeId === 'string' && typeof externalId === 'string' ? orders.get(JSON.stringify([storeId, externalId])) : undefined;
      const delivered = deliveredAt(order, now) ?? deliveredAt(row, now) ?? deliveredAt(payload, now) ?? deliveredAt(row.raw, now);
      const received = [row.received_at, row.fetched_at, row.observed_at, batch?.received_at, row.created_at, batch?.created_at]
        .map(value => instant(value, now)).find(value => value !== undefined) ?? now;
      const deadline = (delivered ?? received) + days * day;
      ctx.update(kind, row.id, patch);
      audit(ctx, 'ingest.amazon_pii.purged', kind, row.id, {
        provider: AMAZON, data_class: dataClass, removed_fields: removed, retain_days: days,
        retain_anchor: delivered === undefined ? 'received_at' : 'order_delivered_at',
        deadline_at: iso(deadline), deadline_exceeded: now > deadline,
      });
      rows++;
    }
  }
  return { rows_scrubbed: rows };
}

export const amazonPiiSchedule: Schedule = {
  id: task, utcDaily: true,
  run(ctx) { ctx.emit(`${task}.due`, { job_key: `pii-purge:${ctx.now.slice(0, 10)}` }); },
};

export const amazonPiiSubscriber: Subscriber = {
  id: task, sensitive: true,
  accepts: type => type === `${task}.due`,
  async run(ctx) { return purgeMisstoredAmazonPii(ctx, await backgroundAmazonRetentionDays(ctx)); },
  onTerminalFailure(ctx, attempts) {
    raiseAlert(ctx, 'job_failure_rate', task, 'critical', { job: task, attempts, failed_jobs: 1, total_jobs: 1 });
  },
};
