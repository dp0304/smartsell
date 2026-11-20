import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountBody, can, defaultZone, heldBy, pauseBody, problemText, scopeNames, setupTones, splitPauses } from './settings-logic';

test('role gates mirror the server lists and leave an unknown role to the server', () => {
  assert.equal(can('register', 'owner'), true);
  assert.equal(can('register', 'manager'), false);
  assert.equal(can('pause', 'editor'), true);
  assert.equal(can('pause', 'viewer'), false);
  assert.equal(can('release', 'manager'), true);
  assert.equal(can('release', 'editor'), false);
  assert.equal(can('release', undefined), true);
});

test('pauses split into active (newest first) and released (latest release first)', () => {
  const { active, released } = splitPauses([
    { id: 'a', activated_at: '2026-11-18T00:00:00Z' },
    { id: 'b', activated_at: '2026-11-19T00:00:00Z' },
    { id: 'c', activated_at: '2026-11-01T00:00:00Z', released_at: '2026-11-02T00:00:00Z' },
    { id: 'd', activated_at: '2026-11-03T00:00:00Z', released_at: '2026-11-05T00:00:00Z' },
  ]);
  assert.deepEqual(active.map(row => row.id), ['b', 'a']);
  assert.deepEqual(released.map(row => row.id), ['d', 'c']);
  assert.deepEqual(splitPauses(undefined), { active: [], released: [] });
});

test('held publications count only paused targets of that switch; missed uses the planned time', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const targets = [
    { paused_by_switch_id: 'p1', plan_status: 'paused', scheduled_at: '2026-11-20T08:00:00Z' },
    { paused_by_switch_id: 'p1', plan_status: 'paused', scheduled_at: '2026-11-21T08:00:00Z' },
    { paused_by_switch_id: 'p1', plan_status: 'paused', local_scheduled_at: '2026-11-19' },
    { paused_by_switch_id: 'p1', plan_status: 'ready', scheduled_at: '2026-11-10T08:00:00Z' },
    { paused_by_switch_id: 'p2', plan_status: 'paused', scheduled_at: '2026-11-10T08:00:00Z' },
  ];
  assert.deepEqual(heldBy(targets, 'p1', now), { held: 3, missed: 2 });
  assert.deepEqual(heldBy(undefined, 'p1', now), { held: 0, missed: 0 });
});

test('pause body: workspace needs only a reason; a narrower scope needs its id', () => {
  assert.deepEqual(pauseBody({ scope_type: 'workspace', scope_id: 'ignored', reason: '  標示有誤 ', unschedule: false }),
    { body: { scope_type: 'workspace', reason: '標示有誤', mode: 'hold' } });
  assert.deepEqual(pauseBody({ scope_type: 'brand', scope_id: 'b1', reason: 'x', unschedule: true }),
    { body: { scope_type: 'brand', scope_id: 'b1', reason: 'x', mode: 'hold_and_unschedule' } });
  assert.deepEqual(pauseBody({ scope_type: 'social_account', scope_id: '', reason: ' ', unschedule: false }), { missing: ['scope_id', 'reason'] });
});

test('account body requires every field and the ownership confirmation', () => {
  const draft = { brand_id: 'b1', provider: 'meta_instagram', display_name: ' 悅數 IG ', external_account_id: '178', default_timezone: 'Asia/Taipei', owned: true };
  assert.deepEqual(accountBody(draft), { body: { brand_id: 'b1', provider: 'meta_instagram', display_name: '悅數 IG', external_account_id: '178', default_timezone: 'Asia/Taipei', owned_account_confirmed: true } });
  assert.deepEqual(accountBody({ ...draft, owned: false }), { missing: ['owned'] });
  assert.deepEqual(accountBody({ ...draft, provider: 'myspace', display_name: '' }), { missing: ['display_name', 'provider'] });
});

test('default zone prefers the brand default market, then any market, then a non-UTC workspace zone', () => {
  const brands = [{ id: 'b1', default_market_id: 'm2' }, { id: 'b2' }];
  const markets = [{ id: 'm1', brand_id: 'b1', timezone: 'Asia/Hong_Kong' }, { id: 'm2', brand_id: 'b1', timezone: 'Asia/Taipei' }, { id: 'm3', brand_id: 'b2', timezone: 'Asia/Tokyo' }];
  assert.equal(defaultZone('b1', brands, markets, 'UTC', 'Europe/London'), 'Asia/Taipei');
  assert.equal(defaultZone('b2', brands, markets, 'UTC', 'Europe/London'), 'Asia/Tokyo');
  assert.equal(defaultZone('b3', brands, markets, 'Asia/Singapore', 'Europe/London'), 'Asia/Singapore');
  assert.equal(defaultZone('b3', brands, markets, 'UTC', 'Europe/London'), 'Europe/London');
  assert.equal(defaultZone('b3', brands, markets, null, undefined), 'UTC');
});

test('member scopes name known brands and keep other scopes as written', () => {
  assert.deepEqual(scopeNames(['brand:b1', 'campaign:c1', '', 4], new Map([['b1', '悅數美妝']])), ['悅數美妝', 'campaign:c1']);
  assert.deepEqual(scopeNames(undefined, new Map()), []);
});

test('setup tones keep unknown apart from zero', () => {
  assert.deepEqual(setupTones({}), { publishing: 'neutral', brands: 'neutral', accounts: 'neutral', agent: 'neutral' });
  assert.deepEqual(setupTones({ pauses: 1, brands: 1, markets: 0, accounts: 2, activeAccounts: 0, agent: 'none' }),
    { publishing: 'critical', brands: 'warning', accounts: 'warning', agent: 'warning' });
  assert.deepEqual(setupTones({ pauses: 0, brands: 2, markets: 3, accounts: 2, activeAccounts: 1, agent: 'idle' }),
    { publishing: 'good', brands: 'good', accounts: 'good', agent: 'good' });
});

test('known problems read in plain language; unknown ones fall back', () => {
  assert.equal(problemText(409, 'ACCOUNT_ALREADY_REGISTERED')?.[0], '這個平台帳號已經登記過了。');
  assert.match(problemText(403, 'forbidden')?.[0] ?? '', /權限/);
  assert.equal(problemText(500, 'boom'), undefined);
});
