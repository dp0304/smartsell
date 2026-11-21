import { randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { ADMIN, Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { mayContact } from '../modules/lifecycle/consent.js';
import { assertJobAllowed, evaluateEgress, isEmergencyStopped } from '../modules/ops/controls.js';
import { publicAddress } from '../modules/traffic/probe.js';
import { notificationDigestEvent, signedNotificationDigest } from '../modules/workspace/notifications.js';
import type { Registered, Subscriber } from '../operations.js';
import type { CustomerEgress } from './customer-egress.js';
import { createSignedWebhookAdapter, signedWebhookEvidence, type SignedWebhookDelivery, type SignedWebhookKind,
  type SignedWebhookOptions, type SignedWebhookResult } from './signed-webhook.js';

const events = new Map<string, { kind: SignedWebhookKind; identity?: string; fields: readonly string[] }>([
  ['core.approval_request.approved', { kind: 'transaction', fields: [] }],
  ['core.approval_request.expired', { kind: 'transaction', fields: [] }],
  ['execution.task.published', { kind: 'transaction', fields: [] }],
  ['analytics.report_version.finalized', { kind: 'report', identity: 'version_id', fields: ['report_id', 'version_id'] }],
  [notificationDigestEvent, { kind: 'transaction', identity: 'notification_id', fields: ['notification_id', 'webhook_subscription_id'] }],
  ['commerce.localization.manual_required', { kind: 'transaction', identity: 'request_id', fields: ['request_id', 'product_id', 'localization_id', 'revision_id'] }],
  ['lifecycle.esp_campaign.manual_required', { kind: 'esp', identity: 'request_id', fields: ['request_id', 'esp_campaign_ref_id'] }],
  ['traffic.lead.handoff_requested', { kind: 'crm', identity: 'handoff_id', fields: ['handoff_id', 'lead_id'] }],
]);

const recordKind = 'webhook_delivery';
const transport = 'signed_http';
const maxClaims = 5;
const claimLifetimeMs = 180_000;
const job = { queue: 'notify', task_kind: 'webhook_delivery', side_effect: true };

type Egress = Pick<CustomerEgress, 'webhookAllowed'> & { ops: Pick<CustomerEgress['ops'], 'webhookSigningKey'> };
/** Run each callback in a serialized workspace write transaction and return only after commit. */
export type SignedWebhookTransaction = <T>(run: (ctx: Context) => T | Promise<T>) => Promise<T>;

async function publicWebhookAddress(hostname: string): Promise<string> {
  const addresses = await new Resolver({ timeout: 1000, tries: 1 }).resolve4(`${hostname}.`);
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error('Webhook endpoint is unavailable');
  return addresses[0]!;
}

function subscribed(row: Row, eventType: string) {
  return row.status === 'active' && Array.isArray(row.event_types) && row.event_types.includes(eventType);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function crmHandoffAllowed(ctx: Context, data: Data, subscriptionId?: string) {
  const handoff = ctx.list('lead_handoff').find(row => row.id === data.handoff_id);
  if (!handoff || handoff.lead_id !== data.lead_id || handoff.status !== 'pending' ||
      (subscriptionId !== undefined && handoff.destination !== subscriptionId)) return false;
  const lead = ctx.list('lead').find(row => row.id === handoff.lead_id);
  if (!lead || lead.status !== 'qualified' || lead.handoff_status !== 'pending' || lead.handoff_id !== handoff.id ||
      typeof lead.customer_id !== 'string' || !Array.isArray(lead.channel_consents)) return false;
  const consentIds = new Set(lead.channel_consents);
  return ctx.list('consent_record').some(row => consentIds.has(row.id) && row.channel === handoff.channel && row.purpose === 'service') &&
    mayContact(ctx, lead.customer_id, handoff.channel, 'service');
}

function updateCrmWork(ctx: Context, eventId: string, status: 'blocked' | 'open', reason: string | null, deliveryId?: string) {
  const task = ctx.list('work_item').find(row => row.dedupe_key === `manual-external:crm:${eventId}`);
  if (!task || !['blocked', 'open'].includes(String(task.status))) return;
  ctx.update('work_item', task.id, { status, blocked_reason: reason, webhook_delivery_id: deliveryId ?? null });
}

function finish(ctx: Context, row: Row, outcome: Data) {
  ctx.update(recordKind, row.id, { ...outcome, completed_at: ctx.now, claim_token: null, claim_expires_at: null });
  if (row.event_type !== 'traffic.lead.handoff_requested') return;
  const eventId = String(row.event_id);
  if (outcome.status === 'delivered' || outcome.status === 'unknown' || outcome.status === 'rejected') {
    const reason = outcome.status === 'delivered' ? 'Webhook accepted. Record provider readback.' :
      `Webhook ${String(outcome.status)}. Verify the provider outcome before retrying.`;
    updateCrmWork(ctx, eventId, 'blocked', reason, row.id);
  } else if (crmHandoffAllowed(ctx, row.event_data as Data)) {
    updateCrmWork(ctx, eventId, 'open', null, row.id);
  } else {
    updateCrmWork(ctx, eventId, 'blocked', 'Handoff is no longer eligible.', row.id);
  }
}

function observation(result: SignedWebhookResult): Data {
  if (result.status === 'blocked') return { status: 'blocked', reason: result.reason };
  return {
    status: result.status, response_code: result.responseStatus,
    reason: result.status === 'unknown' ? result.reason : null,
    receipt_id: result.status === 'delivered' ? result.receiptId ?? null : null,
  };
}

export function createSignedWebhookHost(egress: Egress, options: Omit<SignedWebhookOptions, 'targets'> = {}) {
  function enqueue(ctx: Context, event: { id?: string; type: string; data: Data }): void {
    const spec = events.get(event.type);
    if (!spec) return;
    const identity = spec.identity ? event.data[spec.identity] : event.id;
    if (!identifier(identity)) return;
    const payload = Object.fromEntries(spec.fields.flatMap(field => {
      const value = event.data[field];
      return identifier(value) ? [[field, value]] : [];
    }));
    const existing = ctx.list(recordKind).filter(row => row.event_type === event.type &&
      (row.transport === transport ? row.event_id === identity : !!event.id && row.event_id === event.id));
    let routed = existing.length > 0;
    for (const row of ctx.list('webhook_subscription')) {
      if (!subscribed(row, event.type) || !egress.webhookAllowed(ctx, row) || existing.some(delivery => delivery.subscription_id === row.id)) continue;
      if (event.type === notificationDigestEvent && payload.webhook_subscription_id !== row.id) continue;
      if (spec.kind === 'crm' && !crmHandoffAllowed(ctx, payload, row.id)) continue;
      const delivery: SignedWebhookDelivery = {
        tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, targetId: row.id,
        kind: spec.kind, eventId: `${event.type}/${identity}`, eventType: event.type, data: payload,
      };
      const evidence = signedWebhookEvidence(delivery);
      const queued = ctx.create(recordKind, {
        subscription_id: row.id, event_id: identity, event_type: event.type, event_data: payload,
        transport, status: 'queued', attempt: 0, idempotency_key: evidence.idempotencyKey, payload_sha256: evidence.payloadSha256,
      });
      routed = true;
      if (spec.kind === 'crm') updateCrmWork(ctx, identity, 'blocked', 'Webhook delivery queued.', queued.id);
    }
    if (spec.kind === 'crm' && !routed && crmHandoffAllowed(ctx, payload)) updateCrmWork(ctx, identity, 'open', null);
  }

  const subscriber: Subscriber = {
    id: 'signed-customer-webhook', accepts: type => events.has(type),
    run(ctx, event) { enqueue(ctx, { id: String(event.id ?? ''), type: String(event.type), data: (event.data ?? {}) as Data }); },
  };

  async function claim(ctx: Context) {
    const deliveries = ctx.list(recordKind).filter(row => row.transport === transport);
    for (const row of deliveries) {
      if (row.status === 'sending' && String(row.claim_expires_at) <= ctx.now) {
        finish(ctx, row, { status: 'unknown', reason: 'claim_expired' });
      }
    }
    if (isEmergencyStopped(ctx)) return;
    try { assertJobAllowed(ctx, job); }
    catch (error) {
      if (error instanceof Problem && ['job_paused', 'LICENSE_READ_ONLY'].includes(error.code)) return;
      throw error;
    }
    const subscriptions = new Map(ctx.list('webhook_subscription').map(row => [row.id, row]));
    for (const row of deliveries) {
      if (row.status !== 'queued') continue;
      const subscription = subscriptions.get(String(row.subscription_id));
      const eventType = String(row.event_type);
      const spec = events.get(eventType);
      if (!spec || !subscription || !subscribed(subscription, eventType) || !egress.webhookAllowed(ctx, subscription)) {
        finish(ctx, row, { status: 'blocked', reason: 'target_unavailable' });
        continue;
      }
      if (spec.kind === 'crm' && !crmHandoffAllowed(ctx, row.event_data as Data, subscription.id)) {
        finish(ctx, row, { status: 'blocked', reason: 'handoff_no_longer_eligible' });
        continue;
      }
      if (evaluateEgress(ctx, { kind: 'outbound_webhook', id: subscription.id }, ['internal']) !== 'allow') {
        finish(ctx, row, { status: 'blocked_by_egress', reason: 'egress_denied' });
        continue;
      }
      const key = await egress.ops.webhookSigningKey?.(ctx, String(subscription.secret_id));
      if (!key?.length) {
        finish(ctx, row, { status: 'blocked', reason: 'target_unavailable' });
        continue;
      }
      const queued: SignedWebhookDelivery = {
        tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, targetId: subscription.id,
        kind: spec.kind, eventId: `${eventType}/${String(row.event_id)}`, eventType, data: row.event_data as Data,
      };
      const evidence = signedWebhookEvidence(queued);
      if (evidence.idempotencyKey !== row.idempotency_key || evidence.payloadSha256 !== row.payload_sha256) {
        finish(ctx, row, { status: 'blocked', reason: 'snapshot_changed' });
        continue;
      }
      const data = eventType === notificationDigestEvent
        ? signedNotificationDigest(ctx, queued.data.notification_id, subscription.id) : queued.data;
      if (!data) {
        finish(ctx, row, { status: 'blocked', reason: 'no_accessible_digest_items' });
        continue;
      }
      const delivery = { ...queued, data };
      const adapter = createSignedWebhookAdapter({
        timeoutMs: 5000, resolveHttpsAddress: publicWebhookAddress, ...options,
        targets: [{ id: subscription.id, tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, kinds: [spec.kind],
          url: String(subscription.url), signingKey: key }],
      });
      const token = randomUUID();
      ctx.update(recordKind, row.id, { status: 'sending', attempt: 1, claimed_at: ctx.now, claim_token: token,
        ...(eventType === notificationDigestEvent && { payload_sha256: signedWebhookEvidence(delivery).payloadSha256 }),
        claim_expires_at: new Date(Date.parse(ctx.now) + claimLifetimeMs).toISOString() });
      return { id: row.id, token, scope: { tenantId: ctx.tenantId, workspaceId: ctx.workspaceId }, send: () => adapter.deliver(delivery) };
    }
  }

  async function drain(transact: SignedWebhookTransaction): Promise<void> {
    for (let attempt = 0; attempt < maxClaims; attempt++) {
      const claimed = await transact(claim);
      if (!claimed) return;
      let outcome: Data;
      try { outcome = observation(await claimed.send()); }
      catch { outcome = { status: 'unknown', reason: 'transport_error' }; }
      await transact(ctx => {
        if (ctx.tenantId !== claimed.scope.tenantId || ctx.workspaceId !== claimed.scope.workspaceId) throw new Error('Webhook claim scope changed');
        const row = ctx.get(recordKind, claimed.id);
        if (row.status !== 'sending' || row.claim_token !== claimed.token) return;
        finish(ctx, row, outcome);
      });
    }
  }

  const operations: Registered[] = [{
    module: 'webhook', method: 'GET', path: '/signed-webhook-deliveries', name: 'list_signed_webhook_deliveries', mcp: false, roles: ADMIN,
    summary: 'List signed webhook attempts and receipt metadata',
    run(ctx, { query }) {
      return ctx.list(recordKind).filter(row => row.transport === transport && (!query.subscription_id || row.subscription_id === query.subscription_id))
        .map(({ id, subscription_id, event_id, event_type, status, reason, idempotency_key, payload_sha256,
          attempt, response_code, receipt_id, claimed_at, completed_at }) => ({ id, subscription_id, event_id, event_type,
          status, reason, idempotency_key, payload_sha256, attempt, response_code, receipt_id, claimed_at, completed_at }));
    },
  }];
  return { enqueue, subscriber, drain, operations };
}
