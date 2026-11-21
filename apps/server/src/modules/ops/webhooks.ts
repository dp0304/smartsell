import { createHmac } from 'node:crypto';
import { type Context, type Data, type Row } from '@smartsell/contracts';
import { assertJobAllowed, evaluateEgress } from './controls.js';
import { change, choice, invalid, operation, redact, services, strings, text, unavailable } from './support.js';

interface OutboundEvent {
  id: string;
  type: string;
  data: Data;
  data_classes: readonly string[];
}

function destination(ctx: Context, value: unknown, secretId: string): string {
  let url: URL;
  try { url = new URL(text(value, 'url')); } catch { invalid('Invalid webhook URL'); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    services(ctx).allowLoopbackWebhook?.(ctx, url.href, secretId) === true;
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.hash) invalid('Webhook URL must use HTTPS without credentials or a fragment');
  return url.toString();
}

function view(row: Row) {
  const { secret_id: _secret, url, ...other } = row;
  return { ...other, destination_host: new URL(String(url)).host };
}

/** Internal outbox entry point. Retries are driven by the host using the same event ID and payload. */
export async function deliverWebhook(ctx: Context, subscriptionId: string, event: OutboundEvent): Promise<Row | undefined> {
  const subscription = ctx.get('webhook_subscription', subscriptionId);
  const id = text(event.id, 'event_id');
  const type = text(event.type, 'event_type');
  const prior = ctx.list('webhook_delivery').find(row => row.subscription_id === subscription.id && row.event_id === id);
  if (prior && (prior.status !== 'retrying' || String(prior.next_retry_at) > ctx.now)) return prior;
  if (subscription.status !== 'active' || !(subscription.event_types as string[]).includes(type)) return prior;
  assertJobAllowed(ctx, { queue: 'notify', task_kind: 'webhook_delivery', side_effect: true });
  const save = (values: Data) => prior ? ctx.update('webhook_delivery', prior.id, values)
    : ctx.create('webhook_delivery', { subscription_id: subscription.id, event_id: id, event_type: type, ...values });
  if (evaluateEgress(ctx, { kind: 'outbound_webhook', id: subscription.id }, event.data_classes) !== 'allow') {
    return save({ status: 'blocked_by_egress', attempt: Number(prior?.attempt ?? 0), next_retry_at: null });
  }
  const getKey = services(ctx).webhookSigningKey ?? unavailable('webhook_key_provider');
  const send = services(ctx).sendWebhook ?? unavailable('webhook_transport');
  const key = await getKey(ctx, String(subscription.secret_id));
  if (key.length === 0) unavailable('webhook_signing_key');
  const body = JSON.stringify({ id, type, data: event.data });
  const signature = createHmac('sha256', key).update(body).digest('hex');
  let status: number | null = null;
  try { status = (await send(ctx, { url: String(subscription.url), body, headers: {
    'Content-Type': 'application/json', 'Idempotency-Key': id, 'X-SmartSell-Signature': `sha256=${signature}`,
  } })).status; } catch { /* Transport failures follow the same retry policy. */ }
  const attempt = Number(prior?.attempt ?? 0) + 1;
  if (status !== null && status >= 200 && status < 300) {
    ctx.update('webhook_subscription', subscription.id, { consecutive_failures: 0 });
    return save({ attempt, status: 'delivered', response_code: status, next_retry_at: null });
  }
  const failures = Number(subscription.consecutive_failures ?? 0) + 1;
  const suspended = failures >= 5;
  ctx.update('webhook_subscription', subscription.id, { consecutive_failures: failures, ...(suspended ? { status: 'suspended' } : {}) });
  if (suspended) ctx.emit('ops.webhook.suspended', { subscription_id: subscription.id });
  const retry = !suspended && attempt < 5 && (status === null || status >= 500 || status === 408 || status === 429);
  return save({ attempt, status: retry ? 'retrying' : 'failed', response_code: status,
    next_retry_at: retry ? new Date(Date.parse(ctx.now) + 2 ** (attempt - 1) * 60_000).toISOString() : null });
}

export const webhookOperations = [
  operation('GET', '/webhook-subscriptions', 'ops_list_webhook_subscription', 'Read configured outbound webhook subscriptions', ctx => ctx.list('webhook_subscription').map(view)),
  operation('POST', '/webhook-subscriptions', 'ops_create_webhook_subscription', 'Configure outbound webhook destination and signing key reference', (ctx, {body}) => {
    const types = strings(body.event_types, 'event_types');
    if (types.length === 0) invalid('Provide at least one event type');
    const secretId = text(body.secret_id, 'secret_id');
    return view(change(ctx, 'ops.webhook.created', 'webhook_subscription', ctx.create('webhook_subscription', {
      url: destination(ctx, body.url, secretId), event_types: types, secret_id: secretId, status: 'active', consecutive_failures: 0,
    })));
  }),
  operation('PATCH', '/webhook-subscriptions/:id', 'ops_set_webhook_subscription_status', 'Suspend or reactivate a subscription', (ctx, {body, params}) => {
    const row = ctx.get('webhook_subscription', params.id);
    const status = choice(body.status, 'status', ['active', 'suspended'] as const);
    return view(change(ctx, 'ops.webhook.status_changed', 'webhook_subscription', ctx.update('webhook_subscription', row.id, {
      status, consecutive_failures: status === 'active' && row.status !== 'active' ? 0 : row.consecutive_failures,
    })));
  }, { versionKind: 'webhook_subscription' }),
  operation('GET', '/webhook-deliveries', 'ops_list_webhook_delivery', 'Read outbound delivery status without bodies', (ctx, {query}) => redact(ctx.list('webhook_delivery')
    .filter(row => !query.subscription_id || row.subscription_id === query.subscription_id))),
];
