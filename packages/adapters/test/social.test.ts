import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAdapter, type AdapterOptions, type ProviderKey } from '../src/official.ts';

type Fixture = [path: string, body: unknown, check?: (url: URL, method: string, headers: Record<string, string>) => void];
function fixture(provider: ProviderKey, fixtures: Fixture[], phase?: AdapterOptions['phase']) {
  let index = 0;
  const adapter = createAdapter(provider, {
    phase,
    credentials: { clientId: 'fixture-key', clientSecret: 'fixture-secret', tiktokVerifiedMediaOrigins: ['https://cdn.example.test/videos/'] },
    transport: async request => {
      const next = fixtures[index++];
      assert.ok(next, `Unexpected request: ${request.url}`);
      const url = new URL(request.url);
      assert.equal(url.pathname, next[0]);
      next[2]?.(url, request.method, request.headers);
      return { status: 200, body: next[1] };
    },
  });
  return { adapter, done: () => assert.equal(index, fixtures.length) };
}
const connection = { externalAccountId: 'bound-account', accessToken: 'fixture-token' };

async function collect(pages: AsyncIterable<unknown>) {
  const out = [];
  for await (const page of pages) out.push(page);
  return out;
}

test('Instagram comment sync verifies ownership and uses only the provider cursor on the configured endpoint', async () => {
  const ownMedia = { id: 'media-1', owner: { id: 'bound-account' } };
  const { adapter, done } = fixture('meta_instagram', [
    ['/v24.0/media-1', ownMedia],
    ['/v24.0/media-1/comments', { data: [{ id: 'first' }], paging: { next: 'https://untrusted.example.test', cursors: { after: 'next' } } }],
    ['/v24.0/media-1', ownMedia],
    ['/v24.0/media-1/comments', { data: [{ id: 'second' }] }, (url, method) => {
      assert.equal(method, 'GET');
      assert.equal(url.origin, 'https://graph.instagram.com');
      assert.equal(url.searchParams.get('after'), 'next');
    }],
    ['/v24.0/media-1', { ...ownMedia, owner: { id: 'other-account' } }],
  ]);
  const ctx = { ...connection, scopes: ['instagram_business_basic', 'instagram_business_manage_comments'], objectId: 'media-1' };
  assert.deepEqual(await collect(adapter.sync('comment_read', null, ctx)), [
    { items: [{ id: 'first' }], nextCursor: 'next' }, { items: [{ id: 'second' }], nextCursor: null },
  ]);
  await assert.rejects(collect(adapter.sync('comment_read', null, ctx)), /post_identity_unverified/);
  await assert.rejects(collect(adapter.sync('comment_read', null, { ...ctx, objectId: '..' })), /media_id_required/);
  done();
});

test('Facebook comment reads require Page scope and a Page-owned post', async () => {
  const pages = { data: [{ id: 'bound-account', access_token: 'page-token' }] };
  const { adapter, done } = fixture('meta_facebook', [
    ['/v24.0/me/accounts', pages],
    ['/v24.0/bound-account_1', { id: 'bound-account_1', from: { id: 'bound-account' } }],
    ['/v24.0/bound-account_1/comments', { data: [{ id: 'comment' }] }, (url, method, headers) => {
      assert.equal(method, 'GET');
      assert.equal(url.origin, 'https://graph.facebook.com');
      assert.equal(url.searchParams.get('after'), 'cursor');
      assert.equal(headers.authorization, 'Bearer page-token');
    }],
    ['/v24.0/me/accounts', pages],
    ['/v24.0/bound-account_1', { id: 'bound-account_1', from: { id: 'another-page' } }],
  ], 'P0a');
  const ctx = { ...connection, objectId: 'bound-account_1' };
  await assert.rejects(collect(adapter.sync('comment_read', null, { ...ctx, scopes: ['pages_read_engagement'] })), /sync_capability_unavailable/);
  const authorized = { ...ctx, scopes: ['pages_read_engagement', 'pages_read_user_engagement'] };
  assert.deepEqual(await collect(adapter.sync('comment_read', 'cursor', authorized)), [{ items: [{ id: 'comment' }], nextCursor: null }]);
  await assert.rejects(collect(adapter.sync('comment_read', null, authorized)), /post_identity_unverified/);
  done();
});

test('YouTube comment sync requires the documented scope and requests plain text for the bound video', async () => {
  const { adapter, done } = fixture('youtube', [
    ['/youtube/v3/videos', { items: [{ id: 'video-1', snippet: { channelId: 'bound-account' } }] }],
    ['/youtube/v3/commentThreads', { items: [{ id: 'comment', snippet: { videoId: 'video-1' } }, { id: 'other', snippet: { videoId: 'video-2' } }] }, (url, method) => {
      assert.equal(method, 'GET');
      assert.equal(url.searchParams.get('videoId'), 'video-1');
      assert.equal(url.searchParams.get('textFormat'), 'plainText');
      assert.equal(url.searchParams.get('pageToken'), 'incoming');
    }],
  ], 'P0b');
  const ctx = { ...connection, objectId: 'video-1' };
  await assert.rejects(collect(adapter.sync('comment_read', null, { ...ctx, scopes: ['https://www.googleapis.com/auth/youtube.readonly'] })), /sync_capability_unavailable/);
  assert.deepEqual(await collect(adapter.sync('comment_read', 'incoming', { ...ctx, scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'] })), [
    { items: [{ id: 'comment', snippet: { videoId: 'video-1' } }], nextCursor: null },
  ]);
  done();
});

test('TikTok rejects encoded separators in verified URL prefixes before it sends media', async () => {
  const { adapter, done } = fixture('tiktok', []);
  const ctx = {
    ...connection, client_request_id: 'attempt', fencing_token: 1, credentialState: 'active' as const, scopes: ['video.upload'],
    approval: { provider: 'tiktok' as const, externalAccountId: 'bound-account', operation: 'publish_upload', clientRequestId: 'attempt' },
  };
  const result = await adapter.execute('publish_upload', {
    format: 'video', mediaUrl: 'https://cdn.example.test/videos/..%2foutside.mp4', musicUsageConfirmed: true,
  }, ctx);
  assert.equal(result.error?.reason, 'url_ownership_unverified');
  done();
});

test('Facebook reads later Page account cursors and uses the selected Page token', async () => {
  const { adapter, done } = fixture('meta_facebook', [
    ['/v24.0/me/accounts', { data: [{ id: 'other-page', access_token: 'other-token' }], paging: { next: 'https://untrusted.example.test', cursors: { after: 'second-page' } } }],
    ['/v24.0/me/accounts', { data: [{ id: 'bound-account', access_token: 'page-token' }] }, (url, method, headers) => {
      assert.equal(method, 'GET');
      assert.equal(url.origin, 'https://graph.facebook.com');
      assert.equal(url.searchParams.get('after'), 'second-page');
      assert.equal(headers.authorization, 'Bearer fixture-token');
    }],
    ['/v24.0/post-1', { id: 'post-1', from: { id: 'bound-account' }, is_published: true, permalink_url: 'https://www.facebook.com/post-1' }, (_url, _method, headers) => {
      assert.equal(headers.authorization, 'Bearer page-token');
    }],
  ]);
  const ctx = { ...connection, client_request_id: 'attempt', fencing_token: 1 };
  assert.equal((await adapter.observe({ kind: 'post', id: 'post-1', parentId: 'bound-account' }, ctx)).status, 'published');
  done();
});

test('Instagram cannot use an invalid or mismatched container receipt to publish', async () => {
  const { adapter, done } = fixture('meta_instagram', [
    ['/v24.0/container-1', { id: 'other-container', status_code: 'FINISHED' }],
  ]);
  const ctx = {
    ...connection, client_request_id: 'attempt', fencing_token: 1, credentialState: 'active' as const, scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    approval: { provider: 'meta_instagram' as const, externalAccountId: 'bound-account', operation: 'publish', clientRequestId: 'attempt' },
  };
  const result = await adapter.execute('publish', { format: 'image', containerId: 'container-1' }, ctx);
  assert.equal(result.status, 'unknown');
  const invalid = await adapter.execute('publish', { format: 'image', containerId: '..' }, ctx);
  assert.equal(invalid.error?.reason, 'containerId');
  done();
});
