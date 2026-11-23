import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { DesktopConnector } from '../../apps/connector-desktop/src/controller.ts';
import { zhihuObservationScript, zhihuOrigin } from '../../apps/connector-desktop/src/zhihu-dom.ts';
import type { ZhihuStatsClaim, ZhihuStatsResult } from '../../apps/connector/src/device-client.ts';
import { ZhihuChrome, type ZhihuBrowser } from '../../apps/connector-desktop/src/zhihu-chrome.ts';
import type { ZhihuProfileStep } from '../../apps/connector-desktop/src/zhihu-dom.ts';

const slug = 'fixture-account';
const position = { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 };
class Element {
  innerText: string;
  sideColumn = false;
  hidden = false;
  occluded = false;
  children: Record<string, Element> = {};
  descendants: Record<string, Element[]> = {};
  constructor(text = '') { this.innerText = text; }
  checkVisibility() { return !this.hidden; }
  closest(selector: string) { return this.sideColumn && selector === '.Profile-sideColumn' ? this : null; }
  getClientRects() { return [position]; }
  getBoundingClientRect() { return position; }
  contains() { return !this.occluded; }
  getAttribute() { return null; }
  hasAttribute() { return false; }
  querySelector(selector: string) { return this.children[selector]; }
  querySelectorAll(selector: string) { return this.descendants[selector] ?? []; }
  get value() { throw new Error('unexpected access to an input value'); }
}
class Anchor extends Element {
  origin = zhihuOrigin;
  username = '';
  password = '';
  search = '';
  hash = '';
  target = '';
  constructor(text: string, public pathname: string) { super(text); }
}

function observe(url: string, options: { slug?: string; opened?: boolean; loginCheck?: boolean; approved?: ZhihuProfileStep; rows?: Record<string, Element[]> } = {}) {
  const { slug, opened, loginCheck, approved, rows = {} } = options;
  const queried: string[] = [];
  const document = {
    querySelectorAll: (selector: string) => { queried.push(selector); return rows[selector] ?? []; },
    elementFromPoint: () => new Element(),
    get cookie() { throw new Error('unexpected access to cookies'); },
  };
  const navigations: string[] = [];
  const context = { URL, document, location: { href: url, assign: (destination: string) => navigations.push(destination) },
    innerHeight: 800, innerWidth: 800, HTMLAnchorElement: Anchor };
  const result = JSON.parse(JSON.stringify(runInNewContext(zhihuObservationScript(slug, opened, loginCheck, approved), context)));
  return { result, queried, navigations };
}

const profileLinks = 'header .AppHeader-profile a[href], header .AppHeader-userInfo a[href]';
const portalLinks = `${profileLinks}, .Popover-content a.Menu-item[href], .Popover-content [role="menu"] a[href]`;
const followersSelector = '.Profile-sideColumn a.NumberBoard-item, .Profile-mainColumn a.NumberBoard-item';
const upvotesSelector = '.IconGraf, .Profile-sideColumnItem, .Profile-lightListItem, .Profile-sideColumn .Card :is(div, span)';
const profile = `${zhihuOrigin}/people/${slug}`;
const upvotesText = '获得\n3,456 次赞同';
const followersText = '1.2 万';

function metrics() {
  const followers = new Anchor('', `/people/${slug}/followers`);
  followers.children = { '.NumberBoard-itemName': new Element('关注者'), '.NumberBoard-itemValue': new Element(followersText) };
  const upvotes = new Element(upvotesText);
  upvotes.sideColumn = true;
  return { followers, upvotes, rows: { [followersSelector]: [followers], [upvotesSelector]: [upvotes] } };
}

test('login, off-origin, and wrong-profile pages never query metrics', () => {
  for (const [url, kind] of [[`${zhihuOrigin}/signin?next=%2F`, 'sign-in-unrecognized'], ['https://evil.example/people/fixture-account', 'off-origin'],
    [`${zhihuOrigin}/people/wrong`, 'mismatch'], [`${profile}?tracking=1`, 'mismatch']]) {
    const { result, queried } = observe(url, { slug, rows: metrics().rows });
    assert.deepEqual(result, { kind });
    assert(!queried.includes(followersSelector));
    assert(!queried.includes(upvotesSelector));
  }
});

test('login required needs a visible official sign-in form and yields to challenges and errors', () => {
  const signIn = `${zhihuOrigin}/signin`;
  const form = new Element();
  const button = new Element('登录/注册');
  const input = new Element();
  form.descendants = { 'button.SignFlow-submitButton': [button],
    'input[name="username"], input[name="password"], input[name="phoneNo"], input[type="tel"], .SignFlow-accountInput input': [input] };
  const rows = { 'form.SignFlow': [form] };
  const guard = observe(signIn, { rows }).queried[0];
  assert.deepEqual(observe(signIn, { rows }).result, { kind: 'login-required' });
  assert.deepEqual(observe(profile, { slug, rows: { ...metrics().rows, ...rows } }).result, { kind: 'login-required' });
  assert.deepEqual(observe('https://evil.example/signin', { rows }).result, { kind: 'off-origin' });
  assert.deepEqual(observe(signIn, { rows: { ...rows, [guard]: [new Element()] } }).result, { kind: 'challenge' });
  assert.deepEqual(observe(`${zhihuOrigin}/captcha`, { rows }).result, { kind: 'challenge' });
  assert.deepEqual(observe(`${zhihuOrigin}/error`, { rows }).result, { kind: 'page-error' });
  assert.deepEqual(observe(zhihuOrigin, { rows: { 'header button, header a': [new Element('登录')] } }).result, { kind: 'manual' });
  input.hidden = true;
  assert.deepEqual(observe(signIn, { rows }).result, { kind: 'sign-in-unrecognized' });
  input.hidden = false;
  button.occluded = true;
  assert.deepEqual(observe(signIn, { rows }).result, { kind: 'sign-in-unrecognized' });
});

test('visible official QR markup counts only on the sign-in route', () => {
  const signIn = `${zhihuOrigin}/signin`;
  const qr = new Element();
  const rows = { '.Qrcode-container .Qrcode-content .Qrcode-img img, .Qrcode-container .Qrcode-content .Qrcode-img canvas, .Qrcode-container .Qrcode-content img.Qrcode-img': [qr] };
  assert.deepEqual(observe(signIn, { rows }).result, { kind: 'login-required' });
  assert.deepEqual(observe(profile, { rows }).result, { kind: 'waiting' });
  qr.hidden = true;
  assert.deepEqual(observe(signIn, { rows }).result, { kind: 'sign-in-unrecognized' });
});

test('login check recognizes the account entry without returning a slug or querying metrics', () => {
  const link = new Anchor('我的主页', `/people/${slug}`);
  const rows = { ...metrics().rows, [profileLinks]: [link] };
  const { result, queried } = observe(profile, { slug, loginCheck: true, rows });
  assert.deepEqual(result, { kind: 'signed-in' });
  assert(!queried.includes(followersSelector));
  assert(!queried.includes(upvotesSelector));
});

test('portaled profile link must be visible, unique, same origin, and from an opened menu', () => {
  const link = new Anchor('我的主页', `/people/${slug}`);
  const rows = { [portalLinks]: [link] };
  assert.deepEqual(observe(zhihuOrigin, { rows }).result, { kind: 'waiting' });
  assert.deepEqual(observe(zhihuOrigin, { rows, opened: true }).result, { kind: 'profile', slug, point: { x: 5, y: 5 } });
  link.origin = 'https://evil.example';
  assert.deepEqual(observe(zhihuOrigin, { rows, opened: true }).result, { kind: 'ambiguous' });
  link.origin = zhihuOrigin;
  link.occluded = true;
  assert.deepEqual(observe(zhihuOrigin, { rows, opened: true }).result, { kind: 'ambiguous' });
  link.occluded = false;
  rows[portalLinks].push(new Anchor('我的主页', '/people/wrong'));
  assert.deepEqual(observe(zhihuOrigin, { rows, opened: true }).result, { kind: 'ambiguous' });
});

test('verified profile extracts only unique visible metrics, preserving original formatting', () => {
  const { followers, upvotes, rows } = metrics();
  assert.deepEqual(observe(profile, { slug, rows }).result, { kind: 'stats', followers: followersText, upvotes: upvotesText });
  followers.children['.NumberBoard-itemValue'].hidden = true;
  assert.deepEqual(observe(profile, { slug, rows }).result, { kind: 'waiting' });
  followers.children['.NumberBoard-itemValue'].hidden = false;
  upvotes.occluded = true;
  assert.deepEqual(observe(profile, { slug, rows }).result, { kind: 'waiting' });
  upvotes.occluded = false;
  rows[upvotesSelector].push(metrics().upvotes);
  assert.deepEqual(observe(profile, { slug, rows }).result, { kind: 'ambiguous' });
});

test('sidebar cards ignore the leading layout marker and count nested copies once', () => {
  const { upvotes, rows } = metrics();
  upvotes.innerText = '​\n获得 3,456 次赞同';
  const wrapper = new Element(upvotes.innerText);
  wrapper.sideColumn = true;
  wrapper.descendants[upvotesSelector] = [upvotes];
  rows[upvotesSelector].push(wrapper);
  assert.deepEqual(observe(profile, { slug, rows }).result,
    { kind: 'stats', followers: followersText, upvotes: '获得 3,456 次赞同' });
});

test('account navigation re-proves the approved control in the same document', () => {
  const link = new Anchor('我的主页', `/people/${slug}`);
  const rows = { [profileLinks]: [link] };
  const { result: approved, navigations } = observe(zhihuOrigin, { rows });
  assert.deepEqual(navigations, []);
  link.pathname = '/people/other';
  const changed = observe(zhihuOrigin, { rows, approved });
  assert.deepEqual(changed.result, { kind: 'manual' });
  assert.deepEqual(changed.navigations, []);
  link.pathname = `/people/${slug}`;
  const redirected = observe('https://evil.example', { rows, approved });
  assert.deepEqual(redirected.result, { kind: 'off-origin' });
  assert.deepEqual(redirected.navigations, []);
  const verified = observe(zhihuOrigin, { rows, approved });
  assert.deepEqual(verified.result, { kind: 'clicked' });
  assert.deepEqual(verified.navigations, [`${zhihuOrigin}/people/${slug}`]);
});

test('read checks its own profile link before navigating; preflight never clicks', async () => {
  let clicks = 0;
  const browser = new ZhihuChrome({
    async open() {},
    async observe(_signal, expected, _menuOpened, loginCheck) {
      if (loginCheck) return { kind: 'signed-in' };
      return expected ? { kind: 'stats', followers: followersText, upvotes: upvotesText }
        : { kind: 'profile', slug, point: { x: 1, y: 1 } };
    },
    async click() { clicks++; return true; },
  });
  const signal = new AbortController().signal;
  assert.equal(await browser.checkLogin(signal), 'signed_in');
  assert.deepEqual(await browser.read('another', signal), { status: 'blocked', reason: 'identity_mismatch' });
  assert.equal(clicks, 0);
  assert.deepEqual(await browser.read(slug, signal), { status: 'completed', profile_slug: slug, followers_text: followersText, upvotes_text: upvotesText });
  assert.equal(clicks, 1);
});

const ok = (data: unknown) => Response.json({ data });
const done: ZhihuStatsResult = { status: 'completed', profile_slug: slug, followers_text: followersText, upvotes_text: upvotesText };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(options: {
  mode?: 'login_check'; lease?: number; catalog?: boolean;
  read?: ZhihuBrowser['read']; check?: ZhihuBrowser['checkLogin']; reportStatus?: number;
  holdClaim?: Promise<void>; unavailable?: boolean;
} = {}) {
  const { privateKey: key, publicKey } = generateKeyPairSync('ed25519');
  const origin = 'https://fixture.example';
  const pairing = { workspace: 'workspace', device: 'device', origin, key, name: 'Fixture' };
  const called = { reads: 0, opened: 0, checks: 0, claims: 0, reports: [] as any[], actions: [] as string[] };
  const state = { now: Date.parse('2026-05-01T00:00:00Z'), reportStatus: options.reportStatus, claimAvailable: !options.catalog, catalogAvailable: Boolean(options.catalog), heartbeatUnavailable: false };
  const controller = new DesktopConnector({
    origin, platform: 'darwin', version: '1', now: () => state.now,
    vault: { load: () => pairing, save() {}, clear() {}, available: () => true },
    async openPlatform() {}, async pickMedia() { return undefined; },
    zhihu: {
      async openLogin() { called.opened++; },
      async checkLogin(signal) { called.checks++; return options.check?.(signal) ?? 'login_required'; },
      async read(expected, signal) { called.reads++; assert.equal(expected, slug); return options.read?.(expected, signal) ?? done; },
    },
    fetcher: async (input, request) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      const action = ({ '/api/v1/device/heartbeat': 'heartbeat', '/api/v1/device/zhihu-stats/claim': 'zhihu.stats.claim',
        '/api/v1/device/zhihu-stats/report': 'zhihu.stats.report', '/api/v1/device/catalog/claim': 'catalog.claim' } as Record<string, string>)[url.pathname];
      assert(action);
      called.actions.push(action);
      const headers = new Headers(request?.headers);
      const body = Buffer.from(request?.body as Uint8Array);
      const digest = createHash('sha256').update(body).digest('hex');
      const signed = ['smartsell.device.v1', pairing.workspace, pairing.device, action,
        headers.get('x-smartsell-timestamp'), headers.get('x-smartsell-nonce'), digest];
      assert(verify(null, Buffer.from(JSON.stringify(signed)), publicKey, Buffer.from(headers.get('x-smartsell-signature')!, 'base64url')));
      const data = JSON.parse(body.toString());
      if (action === 'heartbeat') return state.heartbeatUnavailable ? new Response(null, { status: 503 }) : ok({ status: 'online' });
      if (action === 'catalog.claim') {
        if (!state.catalogAvailable) return ok({ job: null });
        state.catalogAvailable = false;
        return ok({ job: { id: 'catalog', store_id: 'store', device_id: 'device',
        store_name: 'Fixture', provider: 'shopify', external_store_id: 'fixture.myshopify.com',
        portal_url: 'https://admin.shopify.com/store/fixture', claim_id: 'claim-token', expires_at: new Date(state.now + 120_000).toISOString() } });
      }
      if (action === 'zhihu.stats.claim') {
        called.claims++;
        await options.holdClaim;
        if (options.unavailable) return new Response(null, { status: 404 });
        assert.deepEqual(data, {});
        if (!state.claimAvailable) return ok({ claim: null });
        state.claimAvailable = false;
        const claim: ZhihuStatsClaim = { id: 'zhihu', workspace_id: pairing.workspace, device_id: pairing.device,
          fencing_token: 7, lease_expires_at: new Date(state.now + (options.lease ?? 120_000)).toISOString(),
          ...(options.mode ? { mode: options.mode } : { profile_slug: slug }) };
        return ok({ claim });
      }
      called.reports.push(data);
      return state.reportStatus ? new Response(null, { status: state.reportStatus }) : ok({ id: data.id, status: data.result.status });
    },
  });
  return { controller, called, state };
}

test('connect and tick automatically process Zhihu serially and retry the exact fenced result without rereading', async () => {
  const gate = Promise.withResolvers<void>();
  const { controller, called, state } = fixture({ holdClaim: gate.promise, reportStatus: 503 });
  await controller.connect();
  await controller.tick(); // An overlapping tick cannot start a second claim or heartbeat.
  assert.deepEqual(called.actions, ['heartbeat', 'zhihu.stats.claim']);
  gate.resolve();
  await turn();
  assert.equal(controller.snapshot().zhihu?.pending, true);
  assert.equal(called.reads, 1);
  assert.equal(called.reports.length, 1);
  state.reportStatus = undefined;
  await controller.tick();
  assert.equal(called.reads, 1);
  assert.equal(called.claims, 1);
  assert.deepEqual(called.reports, [{ id: 'zhihu', fencing_token: 7, result: done }, { id: 'zhihu', fencing_token: 7, result: done }]);
  assert.equal(controller.snapshot().zhihu, undefined);
  const local = JSON.stringify(controller.snapshot());
  for (const value of [slug, followersText, upvotesText]) assert(!local.includes(value));
});

test('transient disconnect preserves the unacknowledged Zhihu result and reconnect never reads twice', async () => {
  const { controller, called, state } = fixture({ reportStatus: 503 });
  await controller.connect();
  await turn();
  assert.equal(called.reports.length, 1);
  state.heartbeatUnavailable = true;
  await controller.tick();
  assert.equal(controller.snapshot().connectionIssue, 'heartbeat');
  assert.equal(controller.snapshot().online, false);
  assert.equal(controller.snapshot().zhihu?.pending, true);
  state.heartbeatUnavailable = false;
  state.reportStatus = undefined;
  await controller.connect();
  await turn();
  assert.deepEqual(called.reports, [called.reports[0], called.reports[0]]);
  assert.equal(called.reads, 1);
  assert.equal(called.claims, 1);
  assert.equal(controller.snapshot().zhihu, undefined);
  assert.match(controller.snapshot().activity[0]!.result, /已确认只读统计回填/);
});

test('login preflight reports only recognized states and never reads statistics', async () => {
  for (const outcome of ['login_required', 'signed_in', 'challenge'] as const) {
    const { controller, called } = fixture({ mode: 'login_check', check: async () => outcome });
    await controller.connect();
    await turn();
    await controller.tick();
    assert.equal(called.checks, 1);
    assert.equal(called.reads, 0);
    assert.deepEqual(called.reports.map(({ result }) => result), outcome === 'challenge' ? []
      : outcome === 'signed_in' ? [{ status: 'completed' }] : [{ status: 'blocked', reason: 'login_required' }]);
    assert.equal(controller.snapshot().activity.some(event => event.action === 'zhihu'), true);
  }
});

test('stop or an expired lease during observation prevents any report', async () => {
  for (const halt of ['stop', 'lease'] as const) {
    const observed = Promise.withResolvers<AbortSignal>();
    const gate = Promise.withResolvers<ZhihuStatsResult>();
    const { controller, called, state } = fixture({ read: async (_expected, signal) => { observed.resolve(signal); return gate.promise; } });
    await controller.connect();
    const signal = await observed.promise;
    if (halt === 'stop') {
      controller.stop();
      assert(signal.aborted);
    } else {
      state.now += 120_001;
      await controller.tick();
      assert(signal.aborted);
    }
    gate.resolve(done);
    await turn();
    if (halt === 'stop') {
      assert.equal(controller.snapshot().zhihu?.pending, false);
      await controller.connect();
      await controller.tick();
      assert.equal(called.reads, 1);
      assert.equal(called.claims, 1);
      state.now += 120_001;
    }
    await controller.tick();
    assert.equal(called.reports.length, 0);
    assert.equal(controller.snapshot().zhihu, undefined);
  }
});

test('fence rejection stops the worker; missing Zhihu endpoint and active catalog keep the worker serial', async () => {
  const fenced = fixture({ reportStatus: 409 });
  await fenced.controller.connect();
  await turn();
  assert.equal(fenced.controller.snapshot().connectionIssue, 'fence');
  await fenced.controller.tick();
  assert.equal(fenced.called.reports.length, 1);

  const older = fixture({ unavailable: true });
  await older.controller.connect();
  await turn();
  assert.equal(older.controller.snapshot().online, true);
  assert.equal(older.called.opened, 0);

  const catalog = fixture({ catalog: true });
  await catalog.controller.connect();
  await turn();
  catalog.state.claimAvailable = true;
  await catalog.controller.tick();
  assert.equal(catalog.called.claims, 1);
  assert.equal(catalog.called.opened, 0);
  assert.equal(catalog.controller.snapshot().catalog?.id, 'catalog');
});

test('a paused Zhihu claim blocks new local tasks only until its lease expires', async () => {
  const { controller, called, state } = fixture({ mode: 'login_check', check: async () => 'challenge' });
  await controller.connect();
  await turn();
  state.catalogAvailable = true;
  await controller.tick();
  assert(!called.actions.includes('catalog.claim'));
  assert.equal(called.reports.length, 0);
  state.now += 120_001;
  await controller.tick();
  assert.equal(controller.snapshot().catalog?.id, 'catalog');
});
