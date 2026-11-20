import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { AgentConnection } from './types';
import { normalizeQuery, viewKey, viewPrefix } from './keys';
import { activePreset, presetRange, readPeriod, withPeriod } from './period';
import { openStreamCount, subscribeViewStream } from './stream';
import { agentState, connectionState, groupByKind, jobBody, sectionOf, sortDecisions } from './logic';
import { decisionOutcome, decisionRequest, readAllPages } from './use-view';

test('view keys share the view prefix and ignore empty filters', () => {
  assert.deepEqual(viewKey('w1', '/views/home', { to: '2026-11-20', brand_id: undefined, from: '' }), ['workspace', 'w1', 'view', '/views/home', { to: '2026-11-20' }]);
  assert.deepEqual(viewKey('w1', '/views/home', { b: '1', a: '2' }).slice(0, 3), viewPrefix('w1'));
  assert.deepEqual(Object.keys(normalizeQuery({ b: '1', a: '2' })), ['a', 'b']);
});

test('periods: only a valid inclusive range is sent, presets end today', () => {
  assert.deepEqual(readPeriod(new URLSearchParams('from=2026-11-14&to=2026-11-20'), 7), { from: '2026-11-14', to: '2026-11-20', days: 7, explicit: true });
  assert.deepEqual(readPeriod(new URLSearchParams('from=2026-11-21&to=2026-11-20'), 30), { days: 30, explicit: false });
  assert.deepEqual(readPeriod(new URLSearchParams('from=2026-02-30&to=2026-03-02'), 7), { days: 7, explicit: false });
  assert.deepEqual(presetRange(30, '2026-11-20'), { from: '2026-10-22', to: '2026-11-20' });
  assert.equal(activePreset(readPeriod(new URLSearchParams(), 30), '2026-11-20'), 30);
  assert.equal(activePreset(readPeriod(new URLSearchParams('from=2026-10-22&to=2026-11-20'), 7), '2026-11-20'), 30);
  assert.equal(activePreset(readPeriod(new URLSearchParams('from=2026-10-01&to=2026-10-10'), 7), '2026-11-20'), null);
  const params = withPeriod(new URLSearchParams('brand=b1'), 90, '2026-11-20', 7);
  assert.equal(params.toString(), 'brand=b1&from=2026-08-23&to=2026-11-20');
  assert.equal(withPeriod(params, 7, '2026-11-20', 7).toString(), 'brand=b1');
});

class FakeSource {
  static opened: FakeSource[] = [];
  listeners = new Map<string, (() => void)[]>();
  closed = false;
  constructor(public url: string) { FakeSource.opened.push(this); }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  close() { this.closed = true; }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
}

test('the stream is shared per workspace and debounces bursts with a max wait', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    FakeSource.opened = [];
    const open = (url: string) => new FakeSource(url) as unknown as EventSource;
    let calls = 0;
    const stop1 = subscribeViewStream('w1', () => { calls += 1; }, { open, now: Date.now });
    const stop2 = subscribeViewStream('w1', () => { calls += 1; }, { open, now: Date.now });
    assert.equal(FakeSource.opened.length, 1);
    assert.equal(FakeSource.opened[0].url, '/api/v1/workspaces/w1/stream');
    const source = FakeSource.opened[0];
    source.emit('workspace.changed'); mock.timers.tick(1000);
    source.emit('workspace.changed'); mock.timers.tick(1000);
    assert.equal(calls, 0);
    mock.timers.tick(600);
    assert.equal(calls, 2);
    calls = 0;
    for (let i = 0; i < 10; i += 1) { source.emit('workspace.changed'); mock.timers.tick(700); }
    assert.ok(calls >= 2, 'a continuous burst still refreshes once maxWait passes');
    calls = 0;
    source.emit('error'); source.emit('open'); mock.timers.tick(1500);
    assert.equal(calls, 2, 'reconnecting refreshes changes missed while offline');
    stop1();
    assert.equal(source.closed, false);
    stop2();
    assert.equal(source.closed, true);
    assert.equal(openStreamCount(), 0);
  } finally { mock.timers.reset(); }
});

test('decisionOutcome tells a carried-out decision from a blocked, expired or stale one', () => {
  const approval = { kind: 'publish_approval' as const };
  assert.deepEqual(decisionOutcome(approval, { id: 't1', plan_status: 'approved' }), { kind: 'done' });
  assert.deepEqual(decisionOutcome(approval, { id: 't1', decision_status: 'blocked', precheck: { items: [
    { check_key: 'publishing_paused', severity: 'blocker', result: 'fail', message: 'Publishing is paused' },
    { check_key: 'caption_length', severity: 'risk', result: 'warn', message: 'Long caption' },
  ] } }), { kind: 'blocked', blockers: ['Publishing is paused'] });
  assert.deepEqual(decisionOutcome(approval, { id: 't1', decision_status: 'expired' }), { kind: 'expired' });
  const changes = { kind: 'change_set' as const };
  assert.deepEqual(decisionOutcome(changes, { status: 'stale', items: [{ status: 'conflict' }] }), { kind: 'stale' });
  assert.deepEqual(decisionOutcome(changes, { status: 'partial', items: [{ status: 'applied' }, { status: 'conflict' }, { status: 'conflict' }] }), { kind: 'partial', skipped: 2 });
  assert.deepEqual(decisionOutcome(changes, { status: 'applied', items: [{ status: 'applied' }] }), { kind: 'done' });
  // Only change sets read status as an apply outcome.
  assert.deepEqual(decisionOutcome({ kind: 'agent_job_review' }, { status: 'partial' }), { kind: 'done' });
});

test('decisionRequest keeps the action inside the workspace API and merges the reason', () => {
  assert.deepEqual(decisionRequest('w 1', { method: 'post', path: '/publish-targets/t1/approve', version: 7, body: { resource_hash: 'h' } }, 'ok'), {
    url: '/api/v1/workspaces/w%201/publish-targets/t1/approve', method: 'POST', body: { resource_hash: 'h', reason: 'ok' }, version: 7,
  });
  assert.deepEqual(decisionRequest('w1', { method: 'POST', path: '/change-sets/c1/apply', version: null, body: null }).body, {});
  assert.equal(decisionRequest('w1', { method: 'POST', path: '/x', version: null }).version, undefined);
  for (const path of ['/../../session', 'https://evil.test/x', '//evil.test/x', '/a?b=1', 'relative']) {
    assert.throws(() => decisionRequest('w1', { method: 'POST', path }), /invalid_decision_path/, path);
  }
  assert.throws(() => decisionRequest('w1', { method: 'GET', path: '/x' }), /invalid_decision_method/);
});

const connection = (patch: Partial<AgentConnection>): AgentConnection => ({ id: 'c', label: 'Mac', client: 'claude_code', created_at: '2026-11-01T00:00:00Z', expires_at: null, last_used_at: null, revoked: false, ...patch });
test('agent lamp: active only with recent use on a usable connection', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(agentState(undefined, now), 'unknown');
  assert.equal(agentState([], now), 'none');
  assert.equal(agentState([connection({ revoked: true, last_used_at: '2026-11-20T11:59:00Z' })], now), 'none');
  assert.equal(agentState([connection({ expires_at: '2026-11-19T00:00:00Z' })], now), 'none');
  assert.equal(agentState([connection({ last_used_at: '2026-11-20T11:50:00Z' })], now), 'active');
  assert.equal(agentState([connection({ last_used_at: '2026-11-20T09:00:00Z' })], now), 'idle');
  assert.equal(connectionState(connection({ expires_at: '2026-11-21T00:00:00Z' }), now), 'active');
});

test('jobBody turns one sentence into an agent_jobs_create body', () => {
  assert.deepEqual(jobBody('  幫我上架   新品  '), { title: '幫我上架 新品', kind: 'custom', expected_output: { type: 'note' } });
  assert.deepEqual(jobBody('Do it', 'b1').input_scope, { brand_ids: ['b1'] });
  const long = jobBody('x'.repeat(500));
  assert.equal(long.title.length, 300);
  assert.equal(long.input_scope?.constraints?.length, 500);
});

test('decisions sort by severity, then deadline, and group by kind', () => {
  const base = { title: 't', resource: { type: null, id: null }, actions: [] };
  const items = [
    { ...base, id: 'a', kind: 'change_set', severity: 'normal', created_at: '2026-11-01' },
    { ...base, id: 'b', kind: 'publish_approval', severity: 'blocker', created_at: '2026-11-05' },
    { ...base, id: 'c', kind: 'publish_approval', severity: 'normal', created_at: '2026-11-02', due_at: '2026-11-21' },
  ] as const;
  assert.deepEqual(sortDecisions(items).map(item => item.id), ['b', 'c', 'a']);
  assert.deepEqual(groupByKind(items).map(([kind, list]) => [kind, list.length]), [['publish_approval', 2], ['change_set', 1]]);
});

test('sectionOf reads the dashboard page from the path', () => {
  assert.equal(sectionOf('/app/w1'), '');
  assert.equal(sectionOf('/app/w1/'), '');
  assert.equal(sectionOf('/app/w1/products/p9'), 'products');
  assert.equal(sectionOf('/w/w1/home'), '');
});

test('readAllPages reads again from the first page when the list shifts between page reads', async () => {
  // Offset cursors: after the first page, row r3 moves to the front, so the second page repeats r2 and r3 would be missed.
  let calls = 0;
  const pages = [
    { data: [{ id: 'r1' }, { id: 'r2' }], next_cursor: 'c1' }, { data: [{ id: 'r2' }, { id: 'r4' }], next_cursor: null },
    { data: [{ id: 'r3' }, { id: 'r1' }], next_cursor: 'c1' }, { data: [{ id: 'r2' }, { id: 'r4' }], next_cursor: null },
  ];
  const restore = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(pages[calls++]), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const result = await readAllPages<{ id: string }[]>('/api/v1/workspaces/w1/views/products', {});
    assert.deepEqual(result.data.map(row => row.id), ['r3', 'r1', 'r2', 'r4']);
    assert.equal(result.next_cursor, null);
    assert.equal(calls, 4);
  } finally { globalThis.fetch = restore; }
});
