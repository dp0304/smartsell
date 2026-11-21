import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { test, type TestContext } from 'node:test';
import type { Row } from '@smartsell/contracts';
import { Records } from '@smartsell/db';
import { makeContext } from '../context.js';
import { createSignedWebhookHost, type SignedWebhookTransaction } from './signed-webhook-host.js';
import { createSignedWebhookAdapter, type SignedWebhookDelivery, type SignedWebhookTarget } from './signed-webhook.js';

const key = 'local-webhook-test-key';
const event: SignedWebhookDelivery = { tenantId: 'tenant-1', workspaceId: 'workspace-1', targetId: 'bridge',
  kind: 'report', eventId: 'outbox-42', eventType: 'analytics.report_version.finalized', data: { report_id: 'report-1' } };
const target = (url: string): SignedWebhookTarget => ({ id: event.targetId, tenantId: event.tenantId, workspaceId: event.workspaceId,
  kinds: ['transaction', 'esp', 'crm', 'report'], url, signingKey: key });

async function listen(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('a real loopback receiver verifies exact-byte signatures and deduplicates stable delivery keys', async t => {
  const requests: { body: Buffer; signature: string | undefined; idempotencyKey: string; method: string | undefined; path: string | undefined }[] = [];
  const receipts = new Map<string, { id: string; body: Buffer }>();
  const baseUrl = await listen(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-smartsell-signature'] as string | undefined;
      const idempotencyKey = String(req.headers['idempotency-key']);
      requests.push({ body, signature, idempotencyKey, method: req.method, path: req.url });
      const expected = 'sha256=' + createHmac('sha256', key).update(body).digest('hex');
      if (signature !== expected || JSON.parse(body.toString()).delivery_id !== idempotencyKey) {
        res.writeHead(401).end();
        return;
      }
      const prior = receipts.get(idempotencyKey);
      if (prior && !prior.body.equals(body)) {
        res.writeHead(409).end();
        return;
      }
      const receipt = prior ?? { id: `receipt-${receipts.size + 1}`, body };
      receipts.set(idempotencyKey, receipt);
      res.writeHead(prior ? 200 : 202, { 'X-SmartSell-Receipt-Id': receipt.id }).end();
    });
  });
  const options = { allowLoopbackHttp: true, targets: [target(`${baseUrl}/bridge?version=1`)] };
  const adapter = createSignedWebhookAdapter(options);
  const first = await adapter.deliver({ ...event, data: { report_id: 'report-1', section: { label: '銷售', total: 3 } } });
  const restarted = createSignedWebhookAdapter(options);
  const replay = await restarted.deliver({ ...event, data: { section: { total: 3, label: '銷售' }, report_id: 'report-1' } });
  assert.equal(first.status, 'delivered');
  assert.equal(replay.status, 'delivered');
  assert.equal(requests.length, 2);
  assert.equal(receipts.size, 1);
  assert.equal(first.responseStatus, 202);
  assert.equal(replay.responseStatus, 200);
  assert.equal(first.receiptId, 'receipt-1');
  assert.equal(replay.receiptId, first.receiptId);
  assert.equal(first.idempotencyKey, replay.idempotencyKey);
  assert.equal(first.payloadSha256, replay.payloadSha256);
  const wire = requests[0]!;
  assert.equal(wire.method, 'POST');
  assert.equal(wire.path, '/bridge?version=1');
  assert.equal(wire.idempotencyKey, first.idempotencyKey);
  assert.equal(first.payloadSha256, createHash('sha256').update(wire.body).digest('hex'));
  assert.deepEqual(JSON.parse(wire.body.toString()), {
    id: event.eventId, type: event.eventType, data: { report_id: 'report-1', section: { label: '銷售', total: 3 } },
    kind: event.kind, tenant_id: event.tenantId, workspace_id: event.workspaceId, delivery_id: first.idempotencyKey,
  });
  const changed = await restarted.deliver({ ...event, data: { report_id: 'changed' } });
  assert.equal(changed.status, 'unknown');
  assert.equal(changed.responseStatus, 409);
  assert.equal(changed.idempotencyKey, first.idempotencyKey);
  assert.notEqual(changed.payloadSha256, first.payloadSha256);
  for (const kind of ['transaction', 'esp', 'crm'] as const) {
    const result = await adapter.deliver({ ...event, kind, eventType: `${kind}.fixture`, data: {} });
    assert.equal(result.status, 'delivered');
    assert.notEqual(result.idempotencyKey, first.idempotencyKey);
  }
  assert.equal(receipts.size, 4);
});

test('wrong tenant, workspace, target or delivery kind is blocked before sending', async t => {
  let hit = false;
  const baseUrl = await listen(t, (_req, res) => { hit = true; res.writeHead(204).end(); });
  const adapter = createSignedWebhookAdapter({ allowLoopbackHttp: true, targets: [{ ...target(baseUrl), kinds: ['report'] }] });
  for (const fields of [{ tenantId: 'other' }, { workspaceId: 'other' }, { targetId: 'other' }, { kind: 'crm' as const }]) {
    assert.deepEqual(await adapter.deliver({ ...event, ...fields }), { status: 'blocked', reason: 'target_unavailable' });
  }
  assert.equal(hit, false);
  assert.throws(() => createSignedWebhookAdapter({ targets: [target(baseUrl)] }), /must use HTTPS/);
  assert.throws(() => createSignedWebhookAdapter({ allowLoopbackHttp: true, targets: [target('http://example.invalid')] }), /must use HTTPS/);
});

test('real HTTP failures distinguish ambiguous attempts from rejections and never follow redirects', async t => {
  const paths: (string | undefined)[] = [];
  const baseUrl = await listen(t, (req, res) => {
    paths.push(req.url);
    req.resume();
    req.on('end', () => {
      if (req.url === '/timeout') return;
      if (req.url === '/dropped') return req.socket.destroy();
      if (req.url === '/redirect') return res.writeHead(307, { Location: '/unexpected' }).end();
      if (req.url === '/failure') return res.writeHead(503).end();
      res.writeHead(422).end();
    });
  });
  const pathsToTest = ['redirect', 'failure', 'reject', 'dropped', 'timeout'];
  const adapter = createSignedWebhookAdapter({ allowLoopbackHttp: true, timeoutMs: 250,
    targets: pathsToTest.map(path => ({ ...target(`${baseUrl}/${path}`), id: path })) });
  for (const [targetId, status, responseStatus, reason] of [
    ['redirect', 'unknown', 307, 'ambiguous_response'], ['failure', 'unknown', 503, 'ambiguous_response'],
    ['reject', 'rejected', 422, undefined], ['dropped', 'unknown', null, 'transport_error'], ['timeout', 'unknown', null, 'timeout'],
  ] as const) {
    const result = await adapter.deliver({ ...event, targetId });
    assert.equal(result.status, status);
    assert.equal('responseStatus' in result && result.responseStatus, responseStatus);
    assert.equal('reason' in result ? result.reason : undefined, reason);
  }
  assert.deepEqual(paths, pathsToTest.map(path => `/${path}`));
});

test('host commits claims before loopback HTTP and keeps uncertain or abandoned claims from replaying', async t => {
  let committed = new Map<string, string>();
  let now = Date.now();
  let txTail: Promise<unknown> = Promise.resolve();
  const scope = { tenantId: event.tenantId, workspaceId: event.workspaceId, actorId: 'test-worker' };
  const deliveries = () => new Records(committed, true).list<Row>('row/webhook_delivery/');
  const transact: SignedWebhookTransaction = run => {
    const next = txTail.then(async () => {
      const snapshot = new Map(committed);
      const ctx = { ...makeContext(new Records(snapshot, false), scope, 'owner'), now: new Date(now).toISOString() };
      const result = await run(ctx);
      committed = snapshot;
      return result;
    });
    txTail = next.catch(() => {});
    return next;
  };
  const observed: { claimed?: unknown; body: unknown }[] = [];
  const url = await listen(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const idempotencyKey = req.headers['idempotency-key'];
      const row = deliveries().find(item => item.idempotency_key === idempotencyKey);
      const parsed = JSON.parse(body.toString());
      observed.push({ claimed: row?.status, body: parsed.data });
      if (req.headers['x-smartsell-signature'] !== 'sha256=' + createHmac('sha256', key).update(body).digest('hex')) {
        res.writeHead(401).end();
      } else if (parsed.data.version_id === 'version-dropped') {
        req.socket.destroy();
      } else {
        res.writeHead(204, { 'X-SmartSell-Receipt-Id': 'accepted' }).end();
      }
    });
  });
  const host = createSignedWebhookHost({ webhookAllowed: (_ctx, row) => row.url === url && row.secret_id === 'trusted',
    ops: { webhookSigningKey: () => key } }, { allowLoopbackHttp: true });
  const report = (version_id: string) => ({ type: event.eventType, data: { version_id, report_id: 'report-1', ignored: 'private' } });
  await transact(ctx => {
    const subscription = ctx.create('webhook_subscription', { url, secret_id: 'trusted', status: 'active', event_types: [event.eventType] });
    ctx.create('webhook_subscription', { url, secret_id: 'untrusted', status: 'active', event_types: [event.eventType] });
    ctx.create('egress_policy', { rules: [{ destination_kind: 'outbound_webhook', destination_id: subscription.id, data_class: 'internal', effect: 'allow' }] });
    host.enqueue(ctx, report('version-1'));
    host.subscriber.run(ctx, report('version-1'));
    host.enqueue(ctx, report('version-dropped'));
    host.enqueue(ctx, report('version-abandoned'));
    const abandoned = ctx.list('webhook_delivery').find(row => row.event_id === 'version-abandoned')!;
    ctx.update('webhook_delivery', abandoned.id, { status: 'sending', attempt: 1, claim_expires_at: ctx.now });
  });
  const crmEvent = 'traffic.lead.handoff_requested';
  const customerId = await transact(ctx => {
    const subscription = ctx.create('webhook_subscription', { url, secret_id: 'trusted', status: 'active', event_types: [crmEvent] });
    const customer = ctx.create('customer', { status: 'active' });
    const consent = ctx.create('consent_record', { customer_id: customer.id, channel: 'email', purpose: 'service',
      action: 'opt_in', captured_at: ctx.now });
    const lead = ctx.create('lead', { customer_id: customer.id, status: 'qualified', channel_consents: [consent.id] });
    const handoff = ctx.create('lead_handoff', { lead_id: lead.id, status: 'pending', channel: 'email', destination: subscription.id });
    ctx.update('lead', lead.id, { handoff_id: handoff.id, handoff_status: 'pending' });
    host.enqueue(ctx, { type: crmEvent, data: { lead_id: lead.id, handoff_id: handoff.id } });
    return customer.id;
  });
  assert.equal(deliveries().length, 4);
  now++;
  await transact(ctx => { ctx.create('consent_record', { customer_id: customerId, channel: 'email', purpose: 'service',
    action: 'withdrawn', captured_at: ctx.now }); });
  await Promise.all([host.drain(transact), host.drain(transact)]);
  now += 240_000;
  await host.drain(transact);
  assert.deepEqual(observed, [
    { claimed: 'sending', body: { version_id: 'version-1', report_id: 'report-1' } },
    { claimed: 'sending', body: { version_id: 'version-dropped', report_id: 'report-1' } },
  ]);
  const crmDelivery = deliveries().find(row => row.event_type === crmEvent);
  assert.equal(crmDelivery?.status, 'blocked');
  assert.equal(crmDelivery?.reason, 'handoff_no_longer_eligible');
  const outcomes = Object.fromEntries(deliveries().filter(row => row.event_type === event.eventType)
    .map(row => [row.event_id, [row.status, row.attempt, row.reason, row.receipt_id]]));
  assert.deepEqual(outcomes, {
    'version-1': ['delivered', 1, null, 'accepted'],
    'version-dropped': ['unknown', 1, 'transport_error', null],
    'version-abandoned': ['unknown', 1, 'claim_expired', undefined],
  });
});
