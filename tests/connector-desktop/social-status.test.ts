import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ChannelSessions } from '../../apps/connector-desktop/src/channel-sessions.ts';
import type { ChannelId } from '../../apps/connector-desktop/src/channels.ts';
import { DesktopConnector } from '../../apps/connector-desktop/src/controller.ts';
import type { XPostsObservation } from '../../apps/connector-desktop/src/x-posts.ts';
import { parseSocialStatusResult, socialStatusPlatforms, type SocialStatusClaim, type SocialStatusResult } from '../../apps/connector/src/social-status.ts';

const origin = 'https://fixture.invalid';
const post = { id: '123', url: 'https://x.com/fixture/status/123', text: 'A fixture video', has_video: true };
const derivedResult = { channels: [{ platform: 'x', status: 'verified', identity: 'fixture', posts: [post] }] };

function fixture() {
  const { publicKey, privateKey: key } = generateKeyPairSync('ed25519');
  const pairing = { origin, workspace: 'workspace', device: 'device', key, name: 'Fixture' };
  const state = { now: Date.parse('2026-07-01T12:00:00Z'), protocol: 1, claim: null as SocialStatusClaim | null,
    reportError: 0, claimError: 0, catalogReady: false };
  const calls: string[] = [], navigations: string[] = [], reports: { id: string; fencing_token: number; result: SocialStatusResult }[] = [];
  const nonces = new Set<string>();
  const tabs = new Set<ChannelId>();
  const browser = { reads: 0, read: async (_expected: string | undefined, _signal: AbortSignal): Promise<XPostsObservation> => ({ kind: 'posts', identity: 'fixture', posts: [post] }) };
  const routes: Record<string, string> = {
    '/api/v1/device/heartbeat': 'heartbeat', '/api/v1/device/claim': 'claim', '/api/v1/device/catalog/claim': 'catalog.claim',
    '/api/v1/device/zhihu-stats/claim': 'zhihu.stats.claim', '/api/v1/device/social-status/claim': 'social.status.claim',
    '/api/v1/device/social-status/report': 'social.status.report',
  };
  const controller = new DesktopConnector({ origin, version: 'fixture', platform: 'darwin', now: () => state.now,
    vault: { load: () => pairing, save() {}, clear() {}, available: () => true },
    async openPlatform() { assert.fail('No task handoff should open'); }, async pickMedia() { return undefined; },
    zhihu: { async openLogin() { assert.fail('No Zhihu job is claimed'); }, async read() { return 'manual'; }, async checkLogin() { return 'manual'; } },
    channels: new ChannelSessions({ session: 1, async hasTab(id) { return tabs.has(id); },
      async open(id, url) { navigations.push(url); tabs.add(id as ChannelId); }, async focus() {},
      async inspect(id) { return id === 'x' ? { kind: 'identity', identity: 'Fixture' } : { kind: 'login' }; },
      async click() { assert.fail('A status inspection cannot click'); },
      async readRecentX(expected, signal) { browser.reads++; return browser.read(expected, signal); },
    }),
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(init?.redirect, 'error');
      const action = routes[url.pathname];
      assert(action, url.pathname);
      calls.push(action);
      const headers = new Headers(init?.headers);
      const nonce = headers.get('x-smartsell-nonce');
      assert(nonce && !nonces.has(nonce));
      nonces.add(nonce);
      assert.equal(headers.get('x-smartsell-workspace'), pairing.workspace);
      assert.equal(headers.get('x-smartsell-device'), pairing.device);
      const bytes = Buffer.from(init?.body as Uint8Array);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const proof = ['smartsell.device.v1', pairing.workspace, pairing.device, action, headers.get('x-smartsell-timestamp'), nonce, digest];
      assert(verify(null, Buffer.from(JSON.stringify(proof)), publicKey, Buffer.from(headers.get('x-smartsell-signature')!, 'base64url')));
      const body = JSON.parse(bytes.toString());
      const ok = (data: unknown) => Response.json({ data });
      switch (action) {
        case 'heartbeat':
          assert.equal(body.social_status_version, 1);
          return ok({ status: 'online', browser_work: { pending_identity: [] }, ...(state.protocol && { social_status_version: state.protocol }) });
        case 'claim': assert.deepEqual(body, { channel: 'browser' }); return ok({ claim: null });
        case 'zhihu.stats.claim': return new Response(null, { status: 404 });
        case 'catalog.claim': return ok({ job: state.catalogReady ? { id: 'catalog', store_id: 'store', device_id: pairing.device, store_name: 'Fixture',
          provider: 'shopify', external_store_id: 'shop.myshopify.com', claim_id: 'catalog-lease', expires_at: new Date(state.now + 60_000).toISOString() } : null });
        case 'social.status.claim': {
          assert.deepEqual(body, {});
          const claim = state.claim;
          state.claim = null;
          return state.claimError ? new Response(null, { status: state.claimError }) : ok({ claim });
        }
        case 'social.status.report':
          reports.push(body);
          return state.reportError ? new Response(null, { status: state.reportError }) : ok({ id: body.id,
            status: body.result.channels.every((channel: { status: string }) => channel.status === 'verified') ? 'completed' : 'blocked' });
        default: throw new Error('Unhandled fixture action');
      }
    },
  });
  const queue = (values: Partial<SocialStatusClaim> = {}) => state.claim = { id: 'status-task', workspace_id: pairing.workspace, device_id: pairing.device,
    mode: 'recent_posts', platform: 'x', fencing_token: 15, lease_expires_at: new Date(state.now + 120_000).toISOString(), ...values };
  async function connect() { await controller.connect(); await turn(); }
  return { state, controller, calls, reports, navigations, browser, tabs, queue, connect };
}

test('new signed route runs past empty or missing older lanes and retries the exact report without browsing again', async () => {
  const f = fixture();
  f.queue({ expected_identity: '@Fixture' });
  f.state.reportError = 503;
  f.state.catalogReady = true;
  await f.connect();
  assert.deepEqual(f.calls, ['heartbeat', 'claim', 'zhihu.stats.claim', 'social.status.claim', 'social.status.report']);
  assert.deepEqual(f.navigations, ['https://x.com/home']);
  assert.equal(f.controller.snapshot().socialStatus?.pending, true);
  assert.equal(f.controller.snapshot().catalog, undefined);
  f.state.reportError = 0;
  await f.controller.tick();
  const signed = { id: 'status-task', fencing_token: 15, result: derivedResult };
  assert.deepEqual(f.reports, [signed, signed]);
  assert.equal(f.browser.reads, 1);
  assert.equal(f.controller.snapshot().socialStatus, undefined);
  assert(!JSON.stringify(f.controller.snapshot()).includes(post.text));
  await f.controller.tick();
  assert.equal(f.controller.snapshot().catalog?.id, 'catalog');
  const count = f.calls.filter(call => call === 'social.status.claim').length;
  await f.controller.tick();
  assert.equal(f.calls.filter(call => call === 'social.status.claim').length, count);
});

test('old servers, future versions and missing opt-in routes fall back to catalog without opening Chrome', async () => {
  for (const protocol of [0, 2, 1]) {
    const f = fixture();
    f.state.protocol = protocol;
    f.state.claimError = 404;
    f.state.catalogReady = true;
    await f.connect();
    assert.equal(f.calls.includes('social.status.claim'), protocol === 1);
    assert.equal(f.controller.snapshot().catalog?.id, 'catalog');
    assert.deepEqual(f.navigations, []);
  }
});

test('wrong device or workspace and an expired signed claim never start a browser or report details', async () => {
  for (const values of [{ device_id: 'other-device' }, { workspace_id: 'other-workspace' }, { lease_expires_at: '2026-06-30T00:00:00Z' }]) {
    const f = fixture();
    f.queue(values);
    await f.connect();
    assert.deepEqual(f.navigations, []);
    assert.deepEqual(f.reports, []);
  }
});

test('stop or expiration during observation cancels the lease and blocks overlap and late reports', async () => {
  for (const end of ['stop', 'expiry']) {
    const f = fixture();
    const entered = Promise.withResolvers<AbortSignal>();
    const finish = Promise.withResolvers<XPostsObservation>();
    f.browser.read = async (_expected, signal) => { entered.resolve(signal); return finish.promise; };
    f.queue();
    f.state.catalogReady = true;
    await f.controller.connect();
    const signal = await entered.promise;
    await f.controller.tick();
    assert(!f.calls.includes('catalog.claim'));
    if (end === 'stop') f.controller.stop();
    else { f.state.now += 120_000; await f.controller.tick(); }
    assert(signal.aborted);
    finish.resolve({ kind: 'posts', identity: 'fixture', posts: [post] });
    await turn();
    assert.deepEqual(f.reports, []);
  }
});

test('reports unmatched or uncertain X evidence without identity, text or a fabricated empty list', async () => {
  for (const status of ['identity_mismatch', 'unverified', 'login_required'] as const) {
    const f = fixture();
    f.queue({ expected_identity: 'different' });
    f.browser.read = async () => status === 'identity_mismatch' ? { kind: 'posts', identity: 'fixture', posts: [post] } : { kind: status };
    await f.connect();
    assert.deepEqual(f.reports[0]?.result, { channels: [{ platform: 'x', status }] });
  }
});

test('an undirected status checks open tabs only, including local X and Reddit, and marks absent evidence', async () => {
  const f = fixture();
  f.queue({ mode: 'account_status', platform: undefined });
  f.tabs.add('x');
  f.tabs.add('reddit');
  await f.connect();
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.reports[0]?.result, { channels: socialStatusPlatforms.map(platform => platform === 'x'
    ? { platform, status: 'verified', identity: 'fixture' }
    : { platform, status: platform === 'reddit' ? 'login_required' : 'unverified' }) });
  assert.equal(f.browser.reads, 0);
});

test('a targeted non-X recent posts query is unsupported; targeted account status opens only its official site', async () => {
  const f = fixture();
  f.queue({ platform: 'reddit' });
  await f.connect();
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.reports[0]?.result, { channels: [{ platform: 'reddit', status: 'unsupported' }] });
  f.queue({ mode: 'account_status', platform: 'reddit' });
  await f.controller.tick();
  assert.deepEqual(f.navigations, ['https://www.reddit.com/']);
  assert.deepEqual(f.reports[1]?.result, { channels: [{ platform: 'reddit', status: 'login_required' }] });
});

test('rejects out-of-scope post URLs and details on an unverified channel before signing', () => {
  const f = fixture();
  const claim = f.queue();
  for (const url of ['https://twitter.com/fixture/status/123', 'https://x.com/foreign/status/123', `${post.url}?ref=1`]) {
    assert.throws(() => parseSocialStatusResult({ channels: [{ ...derivedResult.channels[0], posts: [{ ...post, url }] }] }, claim));
  }
  assert.throws(() => parseSocialStatusResult({ channels: [{ platform: 'x', status: 'unverified', posts: [] }] }, claim));
});
