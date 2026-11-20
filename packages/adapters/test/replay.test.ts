import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPlatformAdapter, platforms, TransportFailure } from '../src/index.ts';
import type { AdapterTransport, ConnectionCtx, ExecCtx, OperationKey, PlatformProvider, TransportRequest, TransportResponse } from '../src/index.ts';
import { createAuthorizationAdapter } from '../src/oauth.ts';
import { createAdapter } from '../src/official.ts';

function replay(steps: readonly [RegExp, TransportResponse | Error, ('read' | 'write')?][]) {
  let index = 0;
  const requests: TransportRequest[] = [];
  const transport: AdapterTransport = async req => {
    requests.push(req);
    const step = steps[index++];
    assert.ok(step, 'unexpected transport call');
    assert.match(req.url, step[0]);
    if (step[2]) assert.equal(req.effect, step[2]);
    if (step[1] instanceof Error) throw step[1];
    return step[1];
  };
  return { transport, requests, done: () => assert.equal(index, steps.length) };
}
const ok = (body: unknown) => ({ status: 200, body });
const accountId = 'bound-account';
function connection(provider: PlatformProvider, operation: OperationKey, configuration?: Record<string, string>): ConnectionCtx {
  const capability = platforms[provider].capabilities.find(item => item.executor === 'api' && item.operation === operation)!;
  return { accountId, phase: capability.phase, credential: {
    accountId, state: 'active', accessToken: 'fixture-token', scopes: capability.scopes ?? [], approvals: [capability.approval!], configuration,
  } };
}
const execution = (ctx: ConnectionCtx, operation: OperationKey): ExecCtx => ({
  ...ctx, client_request_id: 'attempt-1', fencing_token: 1, approval: { accountId, operation, clientRequestId: 'attempt-1' },
});
async function pages(provider: PlatformProvider, transport: AdapterTransport, config: Record<string, string>) {
  const result = [];
  for await (const page of createPlatformAdapter(provider, transport).sync('catalog', null, connection(provider, 'catalog', config))) result.push(page);
  return result;
}

test('Shopify pages products through an explicitly read-only GraphQL request and preserves zero inventory', async () => {
  const response = (hasNextPage: boolean, nodes: unknown[]) => ok({ data: { shop: { currencyCode: 'JPY' }, products: { nodes, pageInfo: { hasNextPage, endCursor: 'next' } } } });
  const io = replay([
    [/fixture.myshopify.com\/admin\/api\/2026-10\/graphql.json/, response(true, [{ id: 'p1', title: 'Fixture', variants: { pageInfo: { hasNextPage: true, endCursor: 'variant-next' }, nodes: [{ id: 'v1', inventoryQuantity: 0, price: '1250' }] } }]), 'read'],
    [/graphql.json/, ok({ data: { product: { id: 'p1', variants: { nodes: [{ id: 'v2', inventoryQuantity: 2 }], pageInfo: { hasNextPage: false } } } } }), 'read'],
    [/graphql.json/, response(false, []), 'read'],
  ]);
  const result = await pages('shopify', io.transport, { shop: 'fixture.myshopify.com' });
  assert.equal(result[0].items[0].variants[0].available, 0);
  assert.equal(result[0].items[0].variants[0].currency, 'JPY');
  assert.equal(result[0].items[0].variantsComplete, true);
  assert.equal(result[0].items[0].variants[1].available, 2);
  assert.deepEqual(JSON.parse(String(io.requests[1].body)).variables, { id: 'p1', after: 'variant-next' });
  assert.equal(JSON.parse(String(io.requests[2].body)).variables.after, 'next');
  assert.equal(io.requests[0].method, 'POST');
  io.done();
});

test('Shopify rejects missing authorization and a response from a different API version', async () => {
  const io = replay([[/\/admin\/api\/2026-10\/graphql.json$/, {
    status: 200, headers: { 'X-Shopify-API-Version': '2027-01' },
    body: { data: { products: { nodes: [], pageInfo: { hasNextPage: false } } } },
  }, 'read']]);
  const adapter = createPlatformAdapter('shopify', io.transport);
  const ctx = connection('shopify', 'catalog', { shop: 'fixture.myshopify.com' });
  await assert.rejects(adapter.sync('catalog', null, { ...ctx, credential: { ...ctx.credential!, accountId: 'another-shop' } })[Symbol.asyncIterator]().next(), /credential_unavailable/);
  assert.equal(io.requests.length, 0);
  await assert.rejects(adapter.sync('catalog', null, ctx)[Symbol.asyncIterator]().next(), /shopify_api_version_mismatch/);
  io.done();
});

test('TikTok Shop signs product search and reads matched details', async () => {
  const io = replay([
    [/\/product\/202309\/products\/search\?.*sign=[a-f0-9]{64}/, ok({ code: 0, data: { products: [{ id: 'p1' }] } }), 'read'],
    [/\/product\/202309\/products\/p1\?/, ok({ code: 0, data: { id: 'p1', skus: [{ id: 'v1', price: { sale_price: '9.50', currency: 'USD' }, inventory: [{ quantity: 2 }, { quantity: 3 }] }] } }), 'read'],
  ]);
  const result = await pages('tiktok_shop', io.transport, { appKey: 'fixture', appSecret: 'fixture-secret', shopCipher: 'fixture-shop' });
  assert.equal(result[0].items[0].variants[0].available, 5);
  assert.equal(io.requests[0].headers?.['x-tts-access-token'], 'fixture-token');
  io.done();
});

test('Amazon listing replay scopes prices to one marketplace and avoids restricted data', async () => {
  const io = replay([[/sellingpartnerapi-eu.amazon.com\/listings\/2021-08-01\/items\/seller/, ok({ items: [{ sku: 'sku',
    summaries: [{ marketplaceId: 'FIXTURE', itemName: 'Listing' }], offers: [{ marketplaceId: 'OTHER', offerType: 'B2C', price: { amount: 99 } },
      { marketplaceId: 'FIXTURE', offerType: 'B2C', price: { amount: '12.34', currencyCode: 'EUR' } }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 3 }],
  }] }), 'read']]);
  const result = await pages('amazon_sp', io.transport, { region: 'EU', sellerId: 'seller', marketplaceId: 'FIXTURE' });
  assert.equal(result[0].items[0].variants[0].price, '12.34');
  assert.equal(result[0].items[0].variants[0].available, 3);
  assert.equal(new URL(io.requests[0].url).searchParams.get('includedData'), 'summaries,offers,fulfillmentAvailability');
  io.done();
});

test('Shopee signs shop reads and keeps absent values absent', async () => {
  const io = replay([
    [/get_item_list\?.*sign=[a-f0-9]{64}/, ok({ error: '', response: { has_next_page: false, item: [{ item_id: 42 }] } }), 'read'],
    [/get_item_base_info\?item_id_list=42/, ok({ error: '', response: { item_list: [{ item_id: 42, has_model: true }] } }), 'read'],
    [/get_model_list\?item_id=42/, ok({ error: '', response: { model: [{ model_id: 99, model_sku: 'sku' }] } }), 'read'],
  ]);
  const result = await pages('shopee', io.transport, { region: 'SG', partnerId: '100', partnerKey: 'fixture-secret', shopId: '200' });
  assert.equal(result[0].items[0].variants[0].externalId, '99');
  assert.equal(result[0].items[0].variants[0].available, undefined);
  io.done();
});

test('approval, scope, phase and device fail closed with no transport calls', async () => {
  const io = replay([]);
  const ctx = execution(connection('tiktok', 'publish'), 'publish');
  const adapter = createPlatformAdapter('tiktok', io.transport);
  assert.equal((await adapter.execute('publish', {}, { ...ctx, approval: undefined })).status, 'failed');
  assert.equal((await adapter.execute('publish', {}, { ...ctx, phase: 'P0a' })).status, 'manual_required');
  assert.equal((await adapter.execute('publish', {}, { ...ctx, credential: undefined })).status, 'manual_required');
  assert.equal((await adapter.execute('publish', {}, { ...ctx, credential: { ...ctx.credential!, approvals: [] } })).status, 'manual_required');
  assert.equal((await adapter.execute('publish', {}, { ...ctx, credential: { ...ctx.credential!, scopes: [] } })).status, 'manual_required');
  const xhs = createPlatformAdapter('xiaohongshu', io.transport);
  assert.deepEqual(xhs.probe({ accountId, phase: 'P0b' }).capabilities.filter(c => c.executor === 'connector').map(c => c.reason), ['verified_device_required', 'verified_device_required']);
  assert.equal((await xhs.execute('publish', {}, execution({ accountId }, 'publish'))).status, 'manual_required');
  io.done();
});

test('Instagram prepares, checks readiness and quota, then preserves the container on unknown submission', async () => {
  const io = replay([
    [/\/ig-account\/media$/, ok({ id: 'container-id' }), 'write'],
    [/\/container-id\?fields=status_code/, ok({ status_code: 'FINISHED' }), 'read'],
    [/content_publishing_limit/, ok({ data: [{ quota_usage: 5, config: { quota_total: 100 } }] }), 'read'],
    [/media_publish$/, new TransportFailure('possibly_sent'), 'write'],
    [/\/container-id\?fields=status_code/, ok({ status_code: 'PUBLISHED' }), 'read'],
  ]);
  const adapter = createPlatformAdapter('meta_instagram', io.transport);
  const ctx = connection('meta_instagram', 'publish', { platformAccountId: 'ig-account' });
  const prepared = await adapter.execute('prepare_publish', { mediaUrl: 'https://cdn.example/img.jpg', mediaType: 'jpeg' }, execution(ctx, 'prepare_publish'));
  assert.ok('ref' in prepared && prepared.ref);
  const input = { containerId: prepared.ref.id, containerAccountId: accountId };
  const uncertain = await adapter.execute('publish', input, execution(ctx, 'publish'));
  assert.equal(uncertain.status, 'unknown');
  assert.ok('ref' in uncertain && uncertain.ref);
  assert.equal((await adapter.execute('publish', input, { ...execution(ctx, 'publish'), previousOutcome: 'outcome_unknown' })).status, 'unknown');
  assert.equal((await adapter.observe(uncertain.ref, ctx)).substatus, 'published_needs_media_reference');
  io.done();
});

test('Facebook distinguishes a pre-send failure from a missing write receipt', async () => {
  const io = replay([[/\/feed$/, new TransportFailure('not_sent'), 'write'], [/\/feed$/, ok({}), 'write']]);
  const adapter = createPlatformAdapter('meta_facebook', io.transport);
  const ctx = connection('meta_facebook', 'publish', { platformAccountId: 'page' });
  ctx.credential!.approvals = ['facebook_page_publishing', 'facebook_page_create_content'];
  const exec = execution(ctx, 'publish');
  const failed = await adapter.execute('publish', { message: 'fixture' }, exec);
  assert.equal(failed.status, 'failed');
  assert.ok('error' in failed && failed.error?.errorClass === 'transient');
  assert.equal((await adapter.execute('publish', { message: 'fixture' }, exec)).status, 'unknown');
  io.done();
});

test('Facebook readback requires a matching Page owner and a Facebook permalink', async () => {
  const response = (owner: string, permalink: string) => ok({ id: 'post', from: { id: owner }, is_published: true, permalink_url: permalink });
  const io = replay([
    [/\/post\?/, response('other', 'https://www.facebook.com/post'), 'read'],
    [/\/post\?/, response('expected-page', 'https://example.test/post'), 'read'],
    [/\/post\?/, response('expected-page', 'https://www.facebook.com/post'), 'read'],
  ]);
  const adapter = createPlatformAdapter('meta_facebook', io.transport);
  const ctx = connection('meta_facebook', 'observe', { platformAccountId: 'expected-page' });
  const ref = { provider: 'meta_facebook', accountId, kind: 'page_post', id: 'post' } as const;
  await assert.rejects(adapter.observe({ ...ref, accountId: 'another-account' }, ctx), /invalid_reference/);
  assert.equal(io.requests.length, 0);
  assert.equal((await adapter.observe(ref, ctx)).status, 'unknown');
  assert.equal((await adapter.observe(ref, ctx)).status, 'accepted');
  assert.equal((await adapter.observe(ref, ctx)).status, 'published');
  io.done();
});

test('TikTok inbox status and processing remain separate from verified public post IDs', async () => {
  const io = replay([
    [/\/inbox\/video\/init\/$/, ok({ error: { code: 'ok' }, data: { publish_id: 'v_inbox' } }), 'write'],
    [/\/status\/fetch\/$/, ok({ data: { status: 'SEND_TO_USER_INBOX' } }), 'read'],
    [/\/status\/fetch\/$/, ok({ data: { status: 'PUBLISH_COMPLETE' } }), 'read'],
    [/\/status\/fetch\/$/, ok({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['111', '222'] } }), 'read'],
  ]);
  const adapter = createPlatformAdapter('tiktok', io.transport);
  const ctx = connection('tiktok', 'upload_draft', { verifiedMediaPrefix: 'https://cdn.example/video/' });
  const result = await adapter.execute('upload_draft', { mediaUrl: 'https://cdn.example/video/clip.mp4' }, execution(ctx, 'upload_draft'));
  assert.ok('ref' in result && result.ref);
  assert.equal((await adapter.observe(result.ref, ctx)).substatus, 'awaiting_creator_action');
  assert.equal((await adapter.observe(result.ref, ctx)).status, 'accepted');
  assert.deepEqual((await adapter.observe(result.ref, ctx)).postIds, ['111', '222']);
  io.done();
});

test('TikTok Direct Post gates the write on approved privacy and verified media ownership', async () => {
  const io = replay([
    [/\/creator_info\/query\/$/, ok({ data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 60 } }), 'read'],
    [/\/creator_info\/query\/$/, ok({ data: { privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 60 } }), 'read'],
    [/\/video\/init\/$/, ok({ data: { publish_id: 'direct-1' } }), 'write'],
    [/\/status\/fetch\/$/, ok({ data: { status: 'PUBLISH_COMPLETE' } }), 'read'],
  ]);
  const adapter = createPlatformAdapter('tiktok', io.transport);
  const ctx = execution(connection('tiktok', 'publish', { verifiedMediaPrefix: 'https://cdn.example/video/' }), 'publish');
  const input = { mediaUrl: 'https://cdn.example/video/clip.mp4', privacyLevel: 'SELF_ONLY', privacySelected: true,
    durationSeconds: 10, musicConsent: true, commercialDisclosure: 'none' };
  assert.equal((await adapter.execute('publish', { ...input, mediaUrl: 'https://cdn.example/video-other/clip.mp4' }, ctx)).status, 'failed');
  assert.equal(io.requests.length, 0);
  assert.equal((await adapter.execute('publish', { ...input, privacyLevel: 'PUBLIC_TO_EVERYONE' }, ctx)).status, 'failed');
  const receipt = await adapter.execute('publish', input, ctx);
  assert.ok('ref' in receipt && receipt.ref);
  assert.deepEqual(JSON.parse(String(io.requests[2].body)).post_info, {
    privacy_level: 'SELF_ONLY', disable_comment: true, disable_duet: true, disable_stitch: true,
    brand_content_toggle: false, brand_organic_toggle: false,
  });
  assert.equal((await adapter.observe(receipt.ref, ctx)).substatus, 'published_limited_or_under_review');
  io.done();
});

test('YouTube uploads multipart bytes and requires a public, processed readback', async () => {
  const io = replay([
    [/\/upload\/youtube\/v3\/videos\?/, ok({ id: 'video-id' }), 'write'],
    [/\/youtube\/v3\/videos\?/, ok({ items: [{ id: 'video-id', snippet: { channelId: 'other-channel' }, status: { uploadStatus: 'processed', privacyStatus: 'public' } }] }), 'read'],
    [/\/youtube\/v3\/videos\?/, ok({ items: [{ id: 'video-id', snippet: { channelId: accountId }, status: { uploadStatus: 'processed', privacyStatus: 'private' } }] }), 'read'],
    [/\/youtube\/v3\/videos\?/, ok({ items: [{ id: 'video-id', snippet: { channelId: accountId }, status: { uploadStatus: 'processed', privacyStatus: 'public' } }] }), 'read'],
  ]);
  const adapter = createPlatformAdapter('youtube', io.transport);
  const ctx = connection('youtube', 'publish');
  ctx.credential!.scopes = [...ctx.credential!.scopes, 'https://www.googleapis.com/auth/youtube.readonly'];
  const result = await adapter.execute('publish', { media: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4', privacyStatus: 'public', title: 'fixture' }, execution(ctx, 'publish'));
  assert.ok('ref' in result && result.ref);
  assert.ok(io.requests[0].body instanceof Uint8Array);
  assert.equal((await adapter.observe(result.ref, ctx)).status, 'unknown');
  assert.equal((await adapter.observe(result.ref, ctx)).status, 'accepted');
  assert.equal((await adapter.observe(result.ref, ctx)).status, 'published');
  io.done();
});

test('compatibility adapter rejects writes without bound approval and active credentials', async () => {
  let calls = 0;
  const adapter = createAdapter('meta_facebook', {
    credentials: { clientId: 'fixture-key', clientSecret: 'fixture-secret' },
    transport: async () => { calls++; throw new Error('unexpected transport call'); },
  });
  const ctx = {
    externalAccountId: 'page', client_request_id: 'attempt', fencing_token: 1,
    accessToken: 'fixture-token', scopes: ['pages_manage_posts'], pageTasks: ['CREATE_CONTENT'],
  };
  const unapproved = await adapter.execute('publish', { format: 'text', message: 'fixture' }, ctx);
  assert.equal(unapproved.error?.reason, 'execution_approval_required');
  const inactive = await adapter.execute('publish', {}, { ...ctx, approval: {
    provider: 'meta_facebook', externalAccountId: 'page', operation: 'publish', clientRequestId: 'attempt',
  } });
  assert.equal(inactive.error?.reason, 'credential_unavailable');
  assert.equal(calls, 0);
});

test('OAuth discovers and verifies a Facebook Page from a later provider cursor', async () => {
  const urls: string[] = [];
  const adapter = createAuthorizationAdapter('meta_facebook', {
    credentials: { clientId: 'fixture-key', clientSecret: 'fixture-secret' },
    transport: async request => {
      urls.push(request.url);
      const endpoint = new URL(request.url);
      assert.equal(endpoint.origin, 'https://graph.facebook.com');
      assert.equal(endpoint.pathname, '/v24.0/me/accounts');
      if (urls.length === 1) return ok({ data: [{ id: 'first' }], paging: { next: 'https://unused.invalid/', cursors: { after: 'opaque' } } });
      assert.equal(endpoint.searchParams.get('after'), 'opaque');
      return ok({ data: [{ id: 'second', tasks: ['CREATE_CONTENT'] }] });
    },
  });
  const result = await adapter.probe({ accessToken: 'fixture-token', externalAccountId: 'second' });
  assert.deepEqual(result.accounts, [{ externalAccountId: 'second', name: undefined, pageTasks: ['CREATE_CONTENT'] }]);
  assert.equal(urls.length, 2);
});

test('OAuth verifies the selected TikTok account against the official user info shape', async () => {
  const adapter = createAuthorizationAdapter('tiktok', {
    credentials: { clientId: 'fixture-key', clientSecret: 'fixture-secret' },
    transport: async request => {
      assert.match(request.url, /^https:\/\/open.tiktokapis.com\/v2\/user\/info\//);
      return ok({ error: { code: 'ok' }, data: { user: { open_id: 'identity', display_name: 'Fixture' } } });
    },
  });
  const result = await adapter.probe({ accessToken: 'fixture-token', externalAccountId: 'identity' });
  assert.equal(result.externalAccountId, 'identity');
  await assert.rejects(adapter.probe({ accessToken: 'fixture-token', externalAccountId: 'other' }), /platform_identity_unverified/);
});
