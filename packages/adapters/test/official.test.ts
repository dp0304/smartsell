import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'vitest';
import { createAdapter, createAdapters, providerCatalog, TransportError } from '../src/official.ts';
import type { Transport, TransportRequest, TransportResponse } from '../src/official.ts';

const credentials = { clientId: 'fixture-id', clientSecret: 'fixture-secret' };
const now = () => 1_795_000_000_000;
const exec = { credentialState: 'active' as const, accessToken: 'fixture-access', externalAccountId: 'account-1', client_request_id: 'request-1', fencing_token: 1 };
const approved = (provider: Parameters<typeof createAdapter>[0], operation: string) => ({
  ...exec, approval: { provider, operation, externalAccountId: exec.externalAccountId, clientRequestId: exec.client_request_id },
});
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}
type Fixture = { method: TransportRequest['method']; path: string; response: TransportResponse | Error; validate?: (req: TransportRequest, url: URL) => void };
function replay(...fixtures: Fixture[]) {
  const failures: unknown[] = [];
  const transport: Transport = async request => {
    const fixture = fixtures.shift();
    try {
      assert.ok(fixture, 'unexpected network request');
      const destination = new URL(request.url);
      assert.equal(request.method, fixture.method);
      assert.equal(destination.pathname, fixture.path);
      fixture.validate?.(request, destination);
    } catch (error) { failures.push(error); throw error; }
    if (fixture.response instanceof Error) throw fixture.response;
    return fixture.response;
  };
  return { transport, complete() { assert.deepEqual(failures, []); assert.equal(fixtures.length, 0); } };
}
const ok = (body: unknown): TransportResponse => ({ status: 200, body });

test('catalog and unconfigured adapters fail closed without network', async () => {
  assert.equal(Object.keys(createAdapters()).length, 12);
  assert.ok(providerCatalog.lazada.capabilities.every(cap => cap.phase === 'P2'));
  assert.ok(providerCatalog.xiaohongshu.capabilities.some(cap => cap.operation === 'publish' && cap.readiness === 'unsupported'));
  assert.equal((await createAdapter('youtube').probe({})).status, 'unconfigured');
  assert.equal((await createAdapter('youtube').execute('publish', {}, approved('youtube', 'publish'))).error?.reason, 'unconfigured');
  assert.equal((await createAdapter('lazada').probe({})).status, 'unsupported');
});

test('YouTube OAuth uses S256, exchanges code, refreshes and identifies owner', async () => {
  const fx = replay(
    { method: 'POST', path: '/token', response: ok({ access_token: 'one', refresh_token: 'refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.readonly' }), validate(req) { assert.equal(new URLSearchParams(String(req.body)).get('code_verifier'), 'verifier'); } },
    { method: 'POST', path: '/token', response: ok({ access_token: 'two' }), validate(req) { assert.equal(new URLSearchParams(String(req.body)).get('refresh_token'), 'refresh'); } },
    { method: 'GET', path: '/youtube/v3/channels', response: ok({ items: [{ id: 'account-1', contentDetails: { relatedPlaylists: { uploads: 'playlist' } } }] }) },
  );
  const adapter = createAdapter('youtube', { credentials, transport: fx.transport });
  const redirectUri = 'https://example.test/oauth/youtube';
  const url = new URL(adapter.oauth!.authorizationUrl({ state: 'state', redirectUri, scopes: [], codeChallenge: 'challenge' }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state');
  const tokens = await adapter.oauth!.exchangeCode({ code: 'code', redirectUri, codeVerifier: 'verifier' });
  assert.equal(tokens.expiresIn, 3600);
  assert.equal((await adapter.oauth!.refresh({ refreshToken: 'refresh' })).refreshToken, 'refresh');
  const report = await adapter.probe({ accessToken: tokens.accessToken, scopes: tokens.scopes });
  assert.equal(report.externalAccountId, 'account-1');
  assert.equal(report.accounts?.[0].uploadsPlaylistId, 'playlist');
  assert.ok(report.capabilities.some(cap => cap.operation === 'post_read' && cap.status === 'read_only'));
  fx.complete();
});

test('Facebook resolves the selected Page token and verifies the published Page post', async () => {
  const fx = replay(
    { method: 'GET', path: '/v24.0/me/accounts', response: ok({ data: [
      { id: 'other', access_token: 'other-token', tasks: ['CREATE_CONTENT'] },
      { id: 'account-1', access_token: 'page-token', tasks: ['CREATE_CONTENT'] },
    ] }) },
    { method: 'POST', path: '/v24.0/account-1/feed', response: ok({ id: 'post' }), validate(req) { assert.equal(req.headers.authorization, 'Bearer page-token'); } },
    { method: 'GET', path: '/v24.0/me/accounts', response: ok({ data: [{ id: 'account-1', access_token: 'page-token' }] }) },
    { method: 'GET', path: '/v24.0/post', response: ok({ id: 'post', from: { id: 'account-1' }, is_published: true, permalink_url: 'https://www.facebook.com/post' }) },
  );
  const adapter = createAdapter('meta_facebook', { credentials, transport: fx.transport });
  const ctx = { ...approved('meta_facebook', 'publish'), scopes: ['pages_manage_posts', 'pages_read_engagement'], pageTasks: ['CREATE_CONTENT'] };
  const receipt = await adapter.execute('publish', { format: 'text', caption: 'Page fixture' }, ctx);
  assert.equal(receipt.status, 'accepted');
  assert.equal((await adapter.observe(receipt, ctx)).status, 'published');
  fx.complete();
});

test('YouTube upload retains the same session when the platform reports partial data', async () => {
  const session = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture';
  const fx = replay(
    { method: 'POST', path: '/upload/youtube/v3/videos', response: { status: 200, headers: { Location: session } } },
    { method: 'PUT', path: '/upload/youtube/v3/videos', response: { status: 308 }, validate(req) { assert.equal(req.headers['content-range'], 'bytes 0-2/3'); } },
    { method: 'PUT', path: '/upload/youtube/v3/videos', response: { status: 308 }, validate(req) {
      assert.equal(req.headers['content-range'], 'bytes */3');
      assert.equal(req.headers['content-length'], '0');
      assert.equal(req.body, undefined);
    } },
    { method: 'PUT', path: '/upload/youtube/v3/videos', response: ok({ id: 'video-1' }) },
    { method: 'GET', path: '/youtube/v3/videos', response: ok({ items: [{ id: 'video-1', snippet: { channelId: 'account-1' }, status: { uploadStatus: 'processed', privacyStatus: 'public' } }] }) },
  );
  const adapter = createAdapter('youtube', { credentials, transport: fx.transport });
  const ctx = { ...approved('youtube', 'publish'), scopes: ['https://www.googleapis.com/auth/youtube.upload'] };
  const result = await adapter.execute('publish', { format: 'video', title: 'Fixture', privacyStatus: 'public', media: new Uint8Array([1, 2, 3]) }, ctx);
  assert.equal(result.status, 'running');
  assert.equal(result.externalRef?.kind, 'upload_session');
  assert.equal(result.externalRef?.id, session);
  assert.equal((await adapter.observe({ ...result.externalRef!, id: session.replace('/videos?', '/videos-other?') }, ctx)).subStatus, 'invalid_upload_session');
  assert.equal((await adapter.observe(result, ctx)).subStatus, 'upload_incomplete');
  const observation = await adapter.observe(result, ctx);
  assert.equal(observation.status, 'published');
  assert.equal(observation.externalRef?.id, 'video-1');
  fx.complete();
});

test('YouTube does not follow a redirect returned by an upload session', async () => {
  const session = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture';
  const fx = replay(
    { method: 'POST', path: '/upload/youtube/v3/videos', response: { status: 200, headers: { Location: session } } },
    { method: 'PUT', path: '/upload/youtube/v3/videos', response: { status: 308, headers: { Location: 'https://other.example/video' } } },
  );
  const adapter = createAdapter('youtube', { credentials, transport: fx.transport });
  const ctx = { ...approved('youtube', 'publish'), scopes: ['https://www.googleapis.com/auth/youtube.upload'] };
  const receipt = await adapter.execute('publish', { format: 'video', title: 'Fixture', privacyStatus: 'private', media: new Uint8Array([1]) }, ctx);
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.error?.reason, 'unexpected_redirect');
  assert.equal(receipt.externalRef?.id, session);
  fx.complete();
});

test('Instagram verifies container and quota, then requires owner and permalink readback', async () => {
  const fx = replay(
    { method: 'POST', path: '/v24.0/account-1/media', response: ok({ id: 'container' }) },
    { method: 'GET', path: '/v24.0/container', response: ok({ status_code: 'FINISHED' }) },
    { method: 'GET', path: '/v24.0/account-1/content_publishing_limit', response: ok({ data: [{ quota_usage: 1, config: { quota_total: 100 } }] }) },
    { method: 'POST', path: '/v24.0/account-1/media_publish', response: ok({ id: 'post' }) },
    { method: 'GET', path: '/v24.0/post', response: ok({ id: 'post', owner: { id: 'another' }, permalink: 'https://www.instagram.com/p/abc/' }) },
    { method: 'GET', path: '/v24.0/post', response: ok({ id: 'post', owner: { id: 'account-1' }, permalink: 'https://www.instagram.com/p/abc/' }) },
  );
  const adapter = createAdapter('meta_instagram', { credentials, transport: fx.transport });
  const ctx = { ...approved('meta_instagram', 'publish'), scopes: ['instagram_business_basic', 'instagram_business_content_publish'] };
  const prepared = await adapter.execute('publish', { format: 'image', mediaUrl: 'https://example.test/img.jpg' }, ctx);
  assert.equal(prepared.status, 'running');
  const posted = await adapter.execute('publish', { format: 'image', containerId: prepared.externalRef?.id }, ctx);
  assert.equal(posted.status, 'accepted');
  assert.equal((await adapter.observe(posted, ctx)).status, 'unknown');
  assert.equal((await adapter.observe(posted, ctx)).status, 'published');
  fx.complete();
});

test('TikTok draft delivery, limited status and public post IDs are distinct', async () => {
  const fx = replay(
    { method: 'POST', path: '/v2/post/publish/inbox/video/init/', response: ok({ data: { publish_id: 'publish-1' }, error: { code: 'ok' } }) },
    ...['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE', 'PUBLISH_COMPLETE'].map((status, index): Fixture => ({ method: 'POST', path: '/v2/post/publish/status/fetch/', response: ok({ data: { status, ...(index === 2 ? { publicaly_available_post_id: ['123456789123456789'] } : {}) }, error: { code: 'ok' } }) })),
  );
  const adapter = createAdapter('tiktok', { credentials: { ...credentials, tiktokVerifiedMediaOrigins: ['https://media.example.test'] }, transport: fx.transport });
  const ctx = { ...approved('tiktok', 'publish_upload'), scopes: ['video.upload', 'video.publish'] };
  const input = { format: 'video', mediaUrl: 'https://media.example.test/movie.mp4', musicUsageConfirmed: true };
  assert.equal((await adapter.execute('publish', input, { ...ctx, ...approved('tiktok', 'publish') })).error?.reason, 'capability_unavailable');
  const receipt = await adapter.execute('upload_draft', input, ctx);
  assert.equal((await adapter.observe(receipt, ctx)).subStatus, 'awaiting_creator_action');
  assert.equal((await adapter.observe(receipt, ctx)).status, 'accepted');
  assert.deepEqual((await adapter.observe(receipt, ctx)).postIds, ['123456789123456789']);
  fx.complete();
});

test('outcome classification distinguishes failures before transmission from ambiguous writes', async () => {
  const fx = replay(
    { method: 'POST', path: '/v2/post/publish/inbox/video/init/', response: new TransportError('not_sent') },
    { method: 'POST', path: '/v2/post/publish/inbox/video/init/', response: new TransportError('possibly_sent') },
  );
  const adapter = createAdapter('tiktok', { credentials: { ...credentials, tiktokVerifiedMediaOrigins: ['https://media.example.test'] }, transport: fx.transport });
  const ctx = { ...approved('tiktok', 'publish_upload'), scopes: ['video.upload'] };
  const input = { format: 'video', mediaUrl: 'https://media.example.test/movie.mp4', musicUsageConfirmed: true };
  assert.equal((await adapter.execute('publish_upload', input, ctx)).error?.errorClass, 'transient');
  assert.equal((await adapter.execute('publish_upload', input, ctx)).status, 'unknown');
  assert.equal((await adapter.execute('publish_upload', input, { ...ctx, previousOutcome: 'outcome_unknown' })).error?.reason, 'observe_before_resubmit');
  fx.complete();
});

test('Shopify accepts verified callbacks and webhooks, preserving opaque GraphQL cursor', async () => {
  const fx = replay(
    { method: 'POST', path: '/admin/oauth/access_token', response: ok({ access_token: 'shop-token', refresh_token: 'refresh', expires_in: 3600, scope: 'read_products' }), validate(req) { assert.equal(JSON.parse(String(req.body)).expiring, 1); } },
    { method: 'POST', path: '/admin/oauth/access_token', response: ok({ access_token: 'another-token', refresh_token: 'rotated-refresh', expires_in: 3600 }), validate(req) { assert.equal(JSON.parse(String(req.body)).refresh_token, 'refresh'); } },
    { method: 'POST', path: '/admin/api/2026-10/graphql.json', response: ok({ data: { shop: { currencyCode: 'USD' }, products: { nodes: [{ id: 'gid://shopify/Product/1', variants: { nodes: [{ id: 'v1' }], pageInfo: { hasNextPage: true, endCursor: 'variant-cursor' } } }], pageInfo: { hasNextPage: true, endCursor: 'opaque' } } } }) },
    { method: 'POST', path: '/admin/api/2026-10/graphql.json', response: ok({ data: { product: { id: 'gid://shopify/Product/1', variants: { nodes: [{ id: 'v2' }], pageInfo: { hasNextPage: false } } } } }), validate(req) {
      assert.deepEqual(JSON.parse(String(req.body)).variables, { id: 'gid://shopify/Product/1', after: 'variant-cursor' });
    } },
    { method: 'POST', path: '/admin/api/2026-10/graphql.json', response: ok({ data: { products: { nodes: [], pageInfo: { hasNextPage: false } } } }), validate(req) { assert.equal(JSON.parse(String(req.body)).variables.after, 'opaque'); } },
  );
  const adapter = createAdapter('shopify', { credentials, transport: fx.transport });
  const shop = 'fixture.myshopify.com';
  const callback = { code: 'code', shop, state: 'state', timestamp: '123' };
  const digest = createHmac('sha256', credentials.clientSecret).update(new URLSearchParams(callback).toString()).digest('hex');
  const exchange = { code: 'code', shopDomain: shop, redirectUri: 'https://example.test/oauth' };
  await assert.rejects(adapter.oauth!.exchangeCode(exchange), /invalid_shopify_callback/);
  const grant = await adapter.oauth!.exchangeCode({ ...exchange, callbackQuery: { ...callback, hmac: digest } });
  assert.equal(grant.expiresIn, 3600);
  assert.equal((await adapter.oauth!.refresh({ shopDomain: shop, refreshToken: grant.refreshToken! })).refreshToken, 'rotated-refresh');
  const rawBody = '{ "id": "product" }';
  const signature = createHmac('sha256', credentials.clientSecret).update(rawBody).digest('base64');
  const hook = { rawBody, headers: { 'X-Shopify-Hmac-Sha256': signature, 'X-Shopify-Topic': 'products/update', 'X-Shopify-Webhook-Id': 'event-1' } };
  assert.equal(adapter.webhook!.parse(hook)[0].action, 'resync');
  assert.deepEqual(adapter.webhook!.parse({ ...hook, rawBody: rawBody.trim().replaceAll(' ', '') }), []);
  const pages = await collect(adapter.sync('product_read', null, { ...exec, shopDomain: shop, scopes: ['read_products'] }));
  assert.equal(pages[0].items[0].variantsComplete, true);
  assert.deepEqual((pages[0].items[0].variants as { nodes: { id: string }[] }).nodes.map(variant => variant.id), ['v1', 'v2']);
  assert.equal(pages[1].nextCursor, null);
  fx.complete();
});

test('official adapter honors a deployment phase cap before catalog requests', async () => {
  let calls = 0;
  const adapter = createAdapter('shopify', { phase: 'P0a', credentials, transport: async () => { calls++; throw new Error('unexpected network request'); } });
  const context = { ...exec, shopDomain: 'fixture.myshopify.com', scopes: ['read_products'] };
  const pages = adapter.sync('product_read', null, context);
  await assert.rejects(pages[Symbol.asyncIterator]().next(), /sync_capability_unavailable/);
  assert.equal(calls, 0);
  const report = await createAdapter('shopify', { phase: 'P0a' }).probe(context);
  assert.ok(report.capabilities.some(cap => cap.operation === 'product_read' && cap.executor === 'api' && cap.phase === 'P0b' && cap.status === 'unsupported'));
});

test('Shopify rejects a repeated nested cursor before emitting a partial product', async () => {
  const variants = (id: string) => ({ nodes: [{ id }], pageInfo: { hasNextPage: true, endCursor: 'stalled' } });
  const fx = replay(
    { method: 'POST', path: '/admin/api/2026-10/graphql.json', response: ok({ data: { products: { nodes: [{ id: 'product', variants: variants('v1') }], pageInfo: { hasNextPage: false } } } }) },
    { method: 'POST', path: '/admin/api/2026-10/graphql.json', response: ok({ data: { product: { id: 'product', variants: variants('v2') } } }) },
  );
  const adapter = createAdapter('shopify', { credentials, transport: fx.transport });
  const pages = adapter.sync('product_read', null, { ...exec, shopDomain: 'fixture.myshopify.com', scopes: ['read_products'] });
  await assert.rejects(pages[Symbol.asyncIterator]().next(), /variant_cursor_did_not_advance/);
  fx.complete();
});

test('TikTok Shop OAuth exchanges and refreshes only valid token envelopes', async () => {
  const fx = replay(
    { method: 'GET', path: '/api/v2/token/get', response: ok({ code: 0, data: { access_token: 'shop-token', refresh_token: 'refresh' } }), validate(_req, url) {
      assert.equal(url.origin, 'https://auth.tiktok-shops.com');
      assert.equal(url.searchParams.get('grant_type'), 'authorized_code');
      assert.equal(url.searchParams.get('auth_code'), 'code');
    } },
    { method: 'GET', path: '/api/v2/token/refresh', response: ok({ data: { access_token: 'unverified' } }), validate(_req, url) {
      assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
      assert.equal(url.searchParams.get('refresh_token'), 'refresh');
    } },
  );
  const { oauth } = createAdapter('tiktok_shop', { credentials, transport: fx.transport });
  const grant = await oauth!.exchangeCode({ code: 'code', redirectUri: 'https://example.test/oauth' });
  assert.equal(grant.accessToken, 'shop-token');
  await assert.rejects(oauth!.refresh({ refreshToken: grant.refreshToken! }), /invalid_shop_token_response/);
  fx.complete();
});

test('signed TikTok Shop requests include canonical body and never expose app secret', async () => {
  const timestamp = String(now() / 1000);
  const fx = replay(
    { method: 'GET', path: '/authorization/202309/shops', response: ok({ code: 0, data: { shops: [{ id: 'shop', cipher: 'cipher' }] } }) },
    { method: 'POST', path: '/product/202309/products/search', response: ok({ code: 0, data: { products: [{ id: 'product' }] } }), validate(req, url) {
      const expected = createHmac('sha256', credentials.clientSecret).update(`${credentials.clientSecret}${url.pathname}app_key${credentials.clientId}page_size20shop_cipherciphertimestamp${timestamp}{}${credentials.clientSecret}`).digest('hex');
      assert.equal(url.searchParams.get('sign'), expected);
      assert.equal(req.headers['x-tts-access-token'], exec.accessToken);
      assert.ok(!req.url.includes(credentials.clientSecret));
    } },
    { method: 'GET', path: '/product/202309/products/product', response: ok({ code: 0, data: { id: 'product', skus: [] } }) },
  );
  const adapter = createAdapter('tiktok_shop', { credentials, transport: fx.transport, now });
  const scopes = ['seller.product.info'];
  const report = await adapter.probe({ accessToken: exec.accessToken, scopes });
  assert.equal(report.accounts?.[0].shopCipher, 'cipher');
  assert.ok(report.capabilities.some(cap => cap.operation === 'product_read' && cap.status === 'read_only'));
  const pages = await collect(adapter.sync('products', null, { ...exec, scopes, externalAccountId: 'shop', shopCipher: 'cipher' }));
  assert.deepEqual(pages[0].items, [{ id: 'product', skus: [] }]);
  fx.complete();
});

test('Amazon projects only non-restricted listing fields', async () => {
  const fx = replay({ method: 'GET', path: '/listings/2021-08-01/items/account-1', response: ok({ items: [{ sku: 'sku', buyerInfo: { email: 'must-not-return' }, summaries: [{ marketplaceId: 'market', asin: 'asin', postalCode: '00000' }] }] }), validate(req, url) {
    assert.equal(req.headers['x-amz-access-token'], exec.accessToken);
    assert.equal(url.searchParams.get('includedData'), 'summaries,offers,fulfillmentAvailability');
  } });
  const adapter = createAdapter('amazon_sp', { credentials: { ...credentials, amazonRegion: 'na', amazonMarketplaceId: 'market' }, transport: fx.transport });
  const items = (await collect(adapter.sync('catalog', null, exec)))[0].items;
  assert.equal(items[0].sku, 'sku');
  assert.doesNotMatch(JSON.stringify(items), /buyerInfo|postalCode|must-not-return/);
  fx.complete();
});

test('TikTok Shop authenticates product status webhooks with the app key and original bytes', () => {
  assert.equal(createAdapter('tiktok_shop', { credentials, phase: 'P0a' }).webhook, undefined);
  const webhook = createAdapter('tiktok_shop', { credentials, phase: 'P0b' }).webhook!;
  const rawBody = Buffer.from('{ "type": 4, "shop_id": "7483920000000000012", "data": { "product_id": "7483920000000000088", "status": "商品" } }');
  const fixture = (body: Buffer, appKey = credentials.clientId) => ({ rawBody: body, headers: {
    Authorization: createHmac('sha256', credentials.clientSecret).update(appKey).update(body).digest('hex'),
  } });
  const signed = fixture(rawBody);
  assert.equal(webhook.verify(signed), true);
  assert.deepEqual(webhook.parse(signed), [{ provider: 'tiktok_shop', type: 'product_status_change', externalId: '7483920000000000088', accountId: '7483920000000000012', action: 'resync' }]);
  assert.equal(webhook.verify(fixture(rawBody, 'another-app')), false);
  assert.equal(webhook.verify({ ...signed, headers: { Authorization: 'bad-signature' } }), false);
  assert.deepEqual(webhook.parse({ ...signed, rawBody: Buffer.from(JSON.stringify(JSON.parse(rawBody.toString()))) }), []);
  assert.deepEqual(webhook.parse(fixture(Buffer.from('{"type":1,"shop_id":"shop","data":{"product_id":"product"}}'))), []);
  assert.deepEqual(webhook.parse(fixture(Buffer.from('{"type":4,"data":{"product_id":"product"}}'))), []);
});

test('Meta and TikTok webhook fixtures verify raw bodies and fail closed', () => {
  const payload = JSON.stringify({ object: 'instagram', entry: [{ id: 'account-1', changes: [{ field: 'comments', value: { id: 'comment' } }] }] });
  const signature = createHmac('sha256', credentials.clientSecret).update(payload).digest('hex');
  const meta = createAdapter('meta_instagram', { credentials: { ...credentials, webhookVerifyToken: 'verify' } }).webhook!;
  const request = { rawBody: payload, headers: { 'X-Hub-Signature-256': `sha256=${signature}` } };
  assert.equal(meta.parse(request)[0].externalId, 'comment');
  assert.equal(meta.challenge?.({ 'hub.verify_token': 'verify', 'hub.mode': 'subscribe', 'hub.challenge': 'challenge' }), 'challenge');
  assert.deepEqual(meta.parse({ ...request, rawBody: `${payload} ` }), []);
  const tiktok = createAdapter('tiktok', { credentials, now }).webhook!;
  const raw = JSON.stringify({ client_key: credentials.clientId, event: 'post.publish.inbox_delivered', content: '{"publish_id":"id"}' });
  const timestamp = now() / 1000;
  const signed = (epoch: number, payload = raw) => ({ rawBody: payload, headers: { 'TikTok-Signature': `t=${epoch},s=${createHmac('sha256', credentials.clientSecret).update(`${epoch}.${payload}`).digest('hex')}` } });
  assert.equal(tiktok.parse(signed(timestamp))[0].externalId, 'id');
  assert.equal(tiktok.verify(signed(timestamp - 301)), false);
  assert.deepEqual(tiktok.parse(signed(timestamp, raw.replace('inbox_delivered', 'other'))), []);
  assert.deepEqual(tiktok.parse(signed(timestamp, raw.replace('publish_id', 'other_id'))), []);
  assert.deepEqual(tiktok.parse(signed(timestamp, raw.replace(credentials.clientId, 'wrong-app'))), []);
});
