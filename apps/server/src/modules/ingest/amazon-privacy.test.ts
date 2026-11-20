import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context, Row } from '@smartsell/contracts';
import { Records } from '@smartsell/db';
import type { FastifyBaseLogger } from 'fastify';
import { configuration, type ProcessRole } from '../../config';
import { makeContext, type DomainEvent } from '../../context';
import { MemoryStore } from '../../memory';
import { commandBackgroundStore } from '../../integration/command-background';
import { discoverOperations, type Schedule, type Subscriber } from '../../operations';
import { runWorkspaceBackground, type BackgroundStore } from '../../runtime';
import { getRetentionPolicy } from '../ops/retention';
import { retentionCommands } from '../ops/retention-policy';
import { evidenceHash } from './amazon-privacy';
import { captureRawRecord } from './evidence';
import { createImportBatch } from './import-operations';
import { receiveVerifiedDelivery } from './sync-operations';

const task = 'ingest.purge_misstored_pii';
const now = '2026-11-20T12:00:00.000Z';
const delivery = '2026-11-16T12:00:00.000Z';
const receipt = '2026-11-18T12:00:00.000Z';
const pii = { streetAddress: 'Example Street', postalCode: 'X0X 0X0', recipientName: 'Example Buyer' };
const amazonFields = { provider: 'amazon_sp', resources: ['orders'], allowed_uses: { display: true, cache_days: 90 }, status: 'disabled' };

test('Amazon evidence and report writes retain only approved fields and notifications persist only routing metadata', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(now) });
  const ctx = makeContext(new Records(new Map(), false), { tenantId: 'tenant', workspaceId: 'ws', actorId: 'owner' }, 'owner');
  const store = ctx.create('store', { provider: 'amazon_sp', default_currency: 'CAD' });
  const source = ctx.create('data_source', { ...amazonFields, store_id: store.id });
  const run = ctx.create('sync_run', { data_source_id: source.id, resource: 'orders' });
  const payload = { orderId: '123-1234567-1234567', deliveryAddress: pii, currency: 'CAD', total_minor: 1099 };
  const raw = captureRawRecord(ctx, { sourceId: source.id, runId: run.id, resource: 'orders', externalId: payload.orderId, payload });
  assert.ok(raw);
  assert.deepEqual(raw.payload, { external_order_id: payload.orderId, currency: 'CAD', total_minor: 1099 });
  assert.equal(raw.payload_hash, evidenceHash(raw.payload as Record<string, unknown>));
  const notification = receiveVerifiedDelivery(ctx, { sourceId: source.id, resource: 'orders', externalId: payload.orderId, eventId: 'event-1', transport: 'sqs', payload } as Parameters<typeof receiveVerifiedDelivery>[1]);
  assert.equal(notification.delivery.payload, undefined);
  assert.equal(ctx.list('webhook_delivery').length, 1);

  const batch = await createImportBatch(ctx, { store_id: store.id, template_key: 'order_list', csv: [
    'amazon-order-id,purchase-date,currency,total_minor,ship-postal-code,ship-city,buyer-name,other',
    `${payload.orderId},${delivery},CAD,1099,X0X0X0,Example City,Example Buyer,some unknown value`,
  ].join('\n') });
  assert.deepEqual(batch.header, ['amazon-order-id', 'purchase-date', 'currency', 'total_minor']);
  const row = ctx.list('import_row')[0];
  assert.equal((row.normalized as Row).total_minor, 1099);
  assert.doesNotMatch(JSON.stringify([batch, row, ctx.list('file_object')]), /postal|X0X|Example Buyer|Example City|unknown value/);
  assert.throws(() => createImportBatch(ctx, { store_id: store.id, template_key: 'product_list', file_object_id: 'upload' }), { code: 'INLINE_PROTECTED_IMPORT_REQUIRED' });
  const product = await createImportBatch(ctx, { store_id: store.id, template_key: 'product_list', csv: 'asin,seller-sku,item-name,deliveryAddress\nB001,SKU1,Widget,Example Street' });
  assert.deepEqual(product.header, ['asin', 'seller-sku', 'item-name']);
  assert.doesNotMatch(JSON.stringify(ctx.list('import_row')), /Example Street/);
});

async function backgroundFixture() {
  const { schedules, subscribers } = await discoverOperations();
  const schedule = schedules.find(entry => entry.id === task);
  const subscriber = subscribers.find(entry => entry.id === task);
  assert.ok(schedule, 'actual module discovery registers the schedule');
  assert.ok(subscriber, 'actual module discovery registers the subscriber');
  const db = new MemoryStore();
  await db.setup({ email: 'owner@example.test', name: 'Owner', workspaceName: 'Amazon privacy test', passwordHash: 'unused' }, 'unused');
  const store = commandBackgroundStore(db);
  const [ws] = await store.workspaces();
  assert.ok(ws);
  const setCommandRetention = (retainDays: number) => db.workspace('unused', ws.id, ({ context, command }) => command(
    { module: 'ops', action: 'set_retention_policy', key: 'amazon-policy', fingerprint: String(retainDays) },
    () => retentionCommands.set_retention_policy.run(context, { data_class: 'store_pii_amazon', retain_days: retainDays, action: 'delete' }),
  ));
  const transact = <T>(write: boolean, run: (ctx: Context, records: Records) => T) => store.transact(ws, !write,
    (records, scope) => run(makeContext(records, scope, 'owner'), records));
  const logs: unknown[] = [];
  const log = { error(details: unknown) { logs.push(details); } } as FastifyBaseLogger;

  // The initial cycle starts immediately. Resolve only at the worker drain or after the scheduler's queue transaction commits.
  async function cycle(role: 'scheduler' | 'worker', selectedSubscriber: Subscriber, selectedSchedules: Schedule[] = [schedule!]) {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let committed = 0;
    const observed: BackgroundStore = {
      workspaces: store.workspaces,
      async transact<T>(...args: Parameters<BackgroundStore['transact']>): Promise<T> {
        const result = await store.transact(...args) as T;
        if (role === 'scheduler' && ++committed === selectedSchedules.length + 1) resolve();
        return result;
      },
    };
    const stop = runWorkspaceBackground(observed, { ...configuration({}), roles: new Set<ProcessRole>([role]) },
      [selectedSubscriber], selectedSchedules, log, [], undefined, async () => resolve());
    const timeout = setTimeout(() => reject(new Error(`${role} did not finish its initial cycle`)), 10_000);
    try { await promise; } finally { clearTimeout(timeout); await stop(); }
    if (role === 'scheduler') assert.equal(committed, selectedSchedules.length + 1);
  }
  return { transact, cycle, schedule, subscriber, schedules, logs, setCommandRetention };
}

test('real scheduler and worker scrub all scoped legacy surfaces immediately and audit the delivery or receipt deadline once', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(now) });
  const { transact, cycle, subscriber, schedules, schedule, logs, setCommandRetention } = await backgroundFixture();
  await setCommandRetention(3);
  const expiredSchedule = schedules.find(entry => entry.id === 'ingest.purge_expired');
  assert.ok(expiredSchedule);
  const ids = await transact(true, ctx => {
    const store = ctx.create('store', { provider: 'amazon_sp' });
    const source = ctx.create('data_source', { ...amazonFields, store_id: store.id });
    const other = ctx.create('data_source', { provider: 'shopify' });
    ctx.create('retention_policy', { data_class: 'store_pii_amazon', retain_days: 6 });
    ctx.create('order', { store_id: store.id, external_order_id: 'order-1', delivered_at: delivery });
    const raw = ctx.create('raw_record', { data_source_id: source.id, resource: 'orders', external_id: 'order-1', legal_hold: true,
      retention_until: '2027-01-01T00:00:00.000Z', payload_hash: 'legacy-hash', payload: { external_order_id: 'order-1', total_minor: 500,
        order: { deliveryAddress: pii, lines: [{ sku: 'S1', postalCode: 'X0X 0X0' }, { sku: 'S2' }] } } });
    const webhook = ctx.create('webhook_delivery', { provider: 'amazon_sp', received_at: receipt, payload: { orderId: 'order-2', BuyerInfo: { name: 'Example Buyer' }, amount_minor: 500 } });
    const batch = ctx.create('import_batch', { store_id: store.id, expires_at: '2027-01-01T00:00:00.000Z' });
    const row = ctx.create('import_row', { batch_id: batch.id, raw: { 'order-id': 'order-3', 'ship-city': 'Example City', total_minor: '600' },
      normalized: { external_order_id: 'order-3', total_minor: 600, buyerPhone: '555-0123' } });
    const foreign = ctx.create('raw_record', { data_source_id: other.id, retention_until: '2027-01-01T00:00:00.000Z', payload: { deliveryAddress: pii } });
    const expired = ctx.create('raw_record', { data_source_id: source.id, retention_until: receipt, payload: { deliveryAddress: pii } });
    return { raw: raw.id, webhook: webhook.id, row: row.id, foreign: foreign.id, expired: expired.id };
  });
  await cycle('scheduler', subscriber, [schedule, expiredSchedule]);
  await transact(false, (ctx, records) => {
    assert.equal(ctx.get('raw_record', ids.raw).payload_hash, 'legacy-hash');
    assert.equal(records.list('job/').length, 1);
    assert.equal(ctx.list('audit_event').length, 1, 'ordinary expiry audited before removing expired Amazon evidence');
    assert.equal(ctx.list('raw_record').some(row => row.id === ids.expired), false);
  });
  await cycle('worker', subscriber);
  await cycle('scheduler', subscriber);
  await cycle('worker', subscriber);
  await transact(false, (ctx, records) => {
    const raw = ctx.get('raw_record', ids.raw);
    const webhook = ctx.get('webhook_delivery', ids.webhook);
    const row = ctx.get('import_row', ids.row);
    assert.deepEqual(raw.payload, { external_order_id: 'order-1', total_minor: 500, order: { lines: [{ sku: 'S1' }, { sku: 'S2' }] } });
    assert.equal(raw.payload_hash, evidenceHash(raw.payload as Record<string, unknown>));
    assert.deepEqual(webhook.payload, { orderId: 'order-2', amount_minor: 500 });
    assert.deepEqual(row.raw, { 'order-id': 'order-3', total_minor: '600' });
    assert.deepEqual(row.normalized, { external_order_id: 'order-3', total_minor: 600 });
    assert.deepEqual(ctx.get('raw_record', ids.foreign).payload, { deliveryAddress: pii });
    assert.equal(records.list('job/').length, 0);
    const due = records.list<DomainEvent>('outbox/').filter(event => event.type === `${task}.due`);
    assert.deepEqual(due.map(event => event.payload.job_key), ['pii-purge:2026-11-20']);
    const audits = ctx.list('audit_event').filter(row => row.action === 'ingest.amazon_pii.purged');
    assert.equal(audits.length, 4);
    const details = (id: string) => audits.find(row => row.resource_id === id)?.details;
    assert.deepEqual(details(ids.raw), { provider: 'amazon_sp', data_class: 'store_pii_amazon', removed_fields: 2, retain_days: 3,
      retain_anchor: 'order_delivered_at', deadline_at: '2026-11-19T12:00:00.000Z', deadline_exceeded: true });
    assert.deepEqual(details(ids.webhook), { provider: 'amazon_sp', data_class: 'store_pii_amazon', removed_fields: 1, retain_days: 3,
      retain_anchor: 'received_at', deadline_at: '2026-11-21T12:00:00.000Z', deadline_exceeded: false });
    assert.doesNotMatch(JSON.stringify([audits, records.list('outbox/')]), /Example|X0X|555-0123/);
  });
  t.mock.timers.setTime(Date.parse('2026-11-21T00:00:00.000Z'));
  await cycle('scheduler', subscriber);
  await cycle('worker', subscriber);
  await transact(false, (ctx, records) => {
    assert.equal(ctx.list('audit_event').length, 4);
    assert.equal(records.list<DomainEvent>('outbox/').filter(event => event.type === `${task}.due`).length, 2);
  });
  assert.deepEqual(logs, []);
});

test('terminal worker failure rolls back the scrub and reports OP job_failure_rate without logging PII', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(now) });
  const { transact, cycle, subscriber, logs } = await backgroundFixture();
  const id = await transact(true, ctx => ctx.create('webhook_delivery', { provider: 'amazon_sp', payload: { deliveryAddress: pii } }).id);
  const privateError = 'failure while processing Example Buyer';
  const failing: Subscriber = { ...subscriber, async run(ctx, event) {
    await subscriber.run(ctx, event);
    throw new Error(privateError);
  } };
  await cycle('scheduler', failing);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await cycle('worker', failing);
    await transact(false, (ctx, records) => {
      assert.deepEqual(ctx.get('webhook_delivery', id).payload, { deliveryAddress: pii });
      assert.equal(ctx.list('audit_event').filter(row => row.action === 'ingest.amazon_pii.purged').length, 0);
      const [job] = records.list<{ attempts: number; status: string }>('job/');
      assert.equal(job.attempts, attempt);
      assert.equal(job.status, attempt < 5 ? 'queued' : 'failed');
      const alerts = ctx.list('alert_incident');
      assert.equal(alerts.length, attempt < 5 ? 0 : 1);
      if (attempt === 5) assert.equal(alerts[0].signal, 'job_failure_rate');
    });
    t.mock.timers.setTime(Date.now() + 60_000);
  }
  assert.equal(logs.length, 5);
  assert.doesNotMatch(JSON.stringify(logs), /Example Buyer/);
});

test('effective Amazon retention never exceeds 30 days or a subsequently shortened tenant policy', () => {
  const scope = { tenantId: 'tenant', workspaceId: 'ws', actorId: 'owner' };
  const ctx = makeContext(new Records(new Map(), false), scope, 'owner');
  const tenantScope = makeContext(new Records(new Map(), false), scope, 'owner');
  const enriched = Object.assign(ctx, { tenantScope });
  assert.equal(getRetentionPolicy(enriched, 'store_pii_amazon')?.retain_days, 30);
  const local = ctx.create('retention_policy', { data_class: 'store_pii_amazon', retain_days: 60 });
  assert.equal(getRetentionPolicy(enriched, 'store_pii_amazon')?.retain_days, 30);
  tenantScope.create('retention_policy', { data_class: 'store_pii_amazon', retain_days: 4 });
  assert.equal(getRetentionPolicy(enriched, 'store_pii_amazon')?.retain_days, 4);
  ctx.update('retention_policy', local.id, { retain_days: 0 });
  assert.equal(getRetentionPolicy(enriched, 'store_pii_amazon')?.retain_days, 0);
});
