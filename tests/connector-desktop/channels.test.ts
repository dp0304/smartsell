import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelSessions } from '../../apps/connector-desktop/src/channel-sessions.ts';
import { ChromeBrowser, findChrome, type ChannelBrowser } from '../../apps/connector-desktop/src/chrome.ts';
import { canInspect, channels, type Observation } from '../../apps/connector-desktop/src/channels.ts';

function fixture() {
  let now = Date.parse('2026-11-21T12:00:00Z');
  let observed: Observation = { kind: 'login' };
  const tabs = new Map<string, string>();
  const browser: ChannelBrowser = {
    session: 1,
    async open(id, url) { tabs.set(id, url); },
    async hasTab(id) { return tabs.has(id); },
    async focus() {},
    async inspect() { return observed; },
    async click() {},
  };
  const sessions = new ChannelSessions(browser, () => now);
  return { sessions, browser, tabs, observe: (value: Observation) => { observed = value; }, advance: (ms: number) => { now += ms; } };
}

test('opening Chrome is separate from observing login, verification, and switching identity', async () => {
  const f = fixture();
  await f.sessions.open('x');
  assert.equal(f.tabs.get('x'), channels.x.page);
  assert.equal(f.sessions.snapshot().x.status, 'unverified');
  await f.sessions.verify('x');
  assert.equal(f.sessions.snapshot().x.status, 'login');
  f.observe({ kind: 'identity', identity: 'first_fixture' });
  await f.sessions.verify('x');
  assert.equal(f.sessions.snapshot().x.status, 'verified');
  assert.equal(f.sessions.snapshot().x.identity, 'first_fixture');
  assert.equal(f.sessions.snapshot().x.checkedAt, '2026-11-21T12:00:00.000Z');
  f.advance(3000);
  f.observe({ kind: 'identity', identity: 'next_fixture' });
  await f.sessions.poll();
  assert.deepEqual(f.sessions.snapshot().x, {
    status: 'changed', identity: 'next_fixture', previousIdentity: 'first_fixture', checkedAt: '2026-11-21T12:00:00.000Z',
    busy: undefined, unavailable: false, note: '检测到 Chrome 中的身份变化。核对后再次点击验证。',
  });
  await f.sessions.verify('x');
  assert.equal(f.sessions.snapshot().x.status, 'verified');
  assert.equal(f.sessions.snapshot().x.checkedAt, '2026-11-21T12:00:03.000Z');
  await f.sessions.openTask('x', channels.x.page, AbortSignal.timeout(1000));
  assert.equal(f.tabs.size, 1);
});

test('expiry, closed tabs, and interrupted verification invalidate local proof', async () => {
  const f = fixture();
  f.observe({ kind: 'identity', identity: 'fixture-shop' });
  await f.sessions.verify('shopify');
  f.advance(30 * 60_000);
  assert.equal(f.sessions.snapshot().shopify.status, 'expired');
  await f.sessions.verify('shopify');
  f.tabs.clear();
  await f.sessions.poll();
  assert.equal(f.sessions.snapshot().shopify.status, 'expired');
  const entered = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Observation>();
  f.browser.inspect = async () => { entered.resolve(); return reply.promise; };
  const pending = f.sessions.verify('shopify');
  await entered.promise;
  f.sessions.suspend();
  reply.resolve({ kind: 'identity', identity: 'fixture-shop' });
  await pending;
  assert.equal(f.sessions.snapshot().shopify.status, 'expired');
});

test('scan reuses managed tabs and confirmation rejects stale, changed, and logged-out identities', async () => {
  const f = fixture();
  const signal = AbortSignal.timeout(5000);
  await f.sessions.scan(signal);
  assert.equal(f.tabs.size, 0);
  f.browser.recoverTabs = async () => { f.tabs.set('tiktok', channels.tiktok.page); };
  f.observe({ kind: 'identity', identity: '1234567890123456789' });
  await f.sessions.scan(signal);
  const { identity, checkedAt, registrationPlatform } = f.sessions.snapshot().tiktok;
  assert.equal(registrationPlatform, 'tiktok');
  const selection = { id: 'tiktok', identity, checkedAt };
  assert.deepEqual(await f.sessions.recheck([selection], signal), [{ kind: 'social', platform: 'tiktok', external_id: identity, observed_at: checkedAt }]);
  await assert.rejects(f.sessions.recheck([], signal), /至少选择/);
  await assert.rejects(f.sessions.recheck([selection, selection], signal), /重新检查/);
  f.observe({ kind: 'identity', identity: '1111111111111111111' });
  await assert.rejects(f.sessions.recheck([selection], signal), /身份已变化/);
  assert.equal(f.sessions.snapshot().tiktok.status, 'changed');
  await f.sessions.verify('tiktok');
  const next = f.sessions.snapshot().tiktok;
  f.observe({ kind: 'login' });
  await assert.rejects(f.sessions.recheck([{ id: 'tiktok', identity: next.identity, checkedAt: next.checkedAt }], signal), /身份已变化/);
  assert.equal(f.sessions.snapshot().tiktok.status, 'login');
  f.observe({ kind: 'identity', identity: next.identity! });
  await f.sessions.verify('tiktok');
  f.advance(30 * 60_000);
  await assert.rejects(f.sessions.recheck([{ id: 'tiktok', identity: next.identity, checkedAt: next.checkedAt }], signal), /过期/);
});

test('no Chrome reports an installation instruction and never opens another browser', async () => {
  const browser = new ChromeBrowser('unused-missing-chrome-fixture', () => findChrome('win32', {}));
  const sessions = new ChannelSessions(browser);
  await sessions.verify('reddit');
  assert.equal(browser.session, 0);
  assert.equal(sessions.snapshot().reddit.status, 'unverified');
  assert.equal(sessions.snapshot().reddit.unavailable, true);
  assert.match(sessions.snapshot().reddit.note!, /请安装 Chrome/);
  await assert.rejects(sessions.open('https://example.invalid'), /不支持/);
  assert.equal(canInspect('youtube', 'https://accounts.google.com/v3/signin'), true);
  assert.equal(canInspect('youtube', 'https://studio.youtube.com.forbidden.invalid/'), false);
  assert.equal(canInspect('shopify', 'http://localhost/'), false);
});
