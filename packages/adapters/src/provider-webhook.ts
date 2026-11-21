import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Adapter, AdapterOptions, ExternalEvent, ProviderKey, RawRequest } from './adapter-types.ts';
import { header, identifier, record, rows, text } from './provider-http.ts';

const tiktokPublishEvents = new Set([
  'post.publish.inbox_delivered', 'post.publish.complete', 'post.publish.failed',
  'post.publish.publicly_available', 'post.publish.no_longer_publicaly_available',
]);

export function createWebhook(provider: ProviderKey, options: AdapterOptions): Adapter['webhook'] {
  const meta = provider === 'meta_instagram' || provider === 'meta_facebook';
  const shop = provider === 'tiktok_shop';
  if (!meta && !shop && provider !== 'shopify' && provider !== 'tiktok') return undefined;
  const appKey = text(options.credentials?.clientId);
  const secret = shop ? options.credentials?.clientSecret : options.credentials?.webhookSecret ?? options.credentials?.clientSecret;
  const clock = options.now ?? Date.now;
  const verify = (request: RawRequest) => {
    if (!secret) return false;
    const raw = Buffer.from(request.rawBody);
    const hmac = createHmac('sha256', secret);
    let supplied: Buffer;
    if (meta) {
      const signature = header(request.headers, 'x-hub-signature-256');
      if (!signature || !/^sha256=[\da-f]{64}$/i.test(signature)) return false;
      supplied = Buffer.from(signature.slice(7), 'hex');
    } else if (provider === 'shopify') {
      const signature = header(request.headers, 'x-shopify-hmac-sha256');
      if (!signature || !/^[\w+/]{43}=$/.test(signature)) return false;
      supplied = Buffer.from(signature, 'base64');
      if (supplied.length !== 32 || supplied.toString('base64') !== signature) return false;
    } else if (shop) {
      const signature = header(request.headers, 'authorization');
      if (!appKey || !signature || !/^[\da-f]{64}$/i.test(signature)) return false;
      hmac.update(appKey);
      supplied = Buffer.from(signature, 'hex');
    } else {
      const signature = header(request.headers, 'tiktok-signature');
      const parts = signature?.match(/^t=(\d+),\s*s=([\da-f]{64})$/i);
      if (!parts || Math.abs(Math.floor(clock() / 1000) - Number(parts[1])) > 300) return false;
      hmac.update(`${parts[1]}.`);
      supplied = Buffer.from(parts[2], 'hex');
    }
    return timingSafeEqual(hmac.update(raw).digest(), supplied);
  };
  const event = (type: string, externalId?: string, accountId?: string): ExternalEvent => ({ provider, type, externalId, accountId, action: 'resync' });
  return {
    verify,
    parse(request) {
      if (!verify(request)) return [];
      let body: Record<string, unknown>;
      try { body = record(JSON.parse(Buffer.from(request.rawBody).toString('utf8'))); } catch { return []; }
      if (meta) {
        if (body.object !== (provider === 'meta_instagram' ? 'instagram' : 'page')) return [];
        return rows(body.entry).flatMap(entry => [
          ...rows(entry.changes).flatMap(change => {
            const field = text(change.field);
            return field ? [event(field, identifier(record(change.value).id), identifier(entry.id))] : [];
          }),
          ...rows(entry.messaging).map(message => event('messaging', identifier(record(message.message).mid), identifier(entry.id))),
        ]);
      }
      if (provider === 'shopify') {
        const type = header(request.headers, 'x-shopify-topic');
        return type && /^(products|inventory_levels|inventory_items)\//.test(type)
          ? [event(type, header(request.headers, 'x-shopify-event-id') ?? header(request.headers, 'x-shopify-webhook-id'), header(request.headers, 'x-shopify-shop-domain'))] : [];
      }
      if (shop) {
        // TikTok Shop's product status change uses numeric event type 4.
        if (body.type !== 4) return [];
        const shopId = identifier(body.shop_id);
        const productId = identifier(record(body.data).product_id);
        return shopId && productId ? [event('product_status_change', productId, shopId)] : [];
      }
      const type = text(body.event);
      if (!type || !tiktokPublishEvents.has(type) || !appKey || body.client_key !== appKey) return [];
      let content: Record<string, unknown>;
      try { content = record(typeof body.content === 'string' ? JSON.parse(body.content) : body.content); } catch { return []; }
      const publishId = identifier(content.publish_id);
      return publishId ? [event(type, identifier(body.event_id) ?? publishId, identifier(body.user_openid))] : [];
    },
    ...(meta ? { challenge(query: Readonly<Record<string, string | undefined>>) {
      const token = options.credentials?.webhookVerifyToken;
      const supplied = query['hub.verify_token'];
      if (query['hub.mode'] !== 'subscribe' || !token || !supplied) return null;
      const actual = Buffer.from(supplied);
      const expected = Buffer.from(token);
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? query['hub.challenge'] ?? null : null;
    } } : {}),
  };
}
