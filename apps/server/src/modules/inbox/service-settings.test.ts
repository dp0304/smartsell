import assert from 'node:assert/strict';
import test from 'node:test';
import type { Row } from '@smartsell/contracts';
import { buildApp } from '../../app.js';
import { configuration } from '../../config.js';
import { MemoryStore } from '../../memory.js';
import { discoverOperations } from '../../operations.js';
import { registerOperationRoutes } from '../../operation-server.js';
import { businessClock, minute, parseCalendar } from './business-hours.js';
import { operations, schedules } from './index.js';
import { at, byId, workspaceFixture } from './workspace-fixture.js';

const range = (start: string, end: string) => [{ start, end }];
const weekly = { mon: range('09:00', '17:00'), fri: range('09:00', '17:00'), tue: range('09:00', '17:00') };
const imported = { provider: 'meta_facebook', brand_id: 'brand', social_account_id: 'account', kind: 'comment_thread',
  external_message_id: 'root', external_user_id: 'customer', body_text: 'A question' };

test('business clock excludes spring-forward gaps and includes repeated opening times in fall', () => {
  const clock = businessClock(parseCalendar({ weekly: { sun: range('01:30', '03:30') } }, 'America/New_York'));
  assert.equal(clock.between(Date.parse('2026-03-08'), Date.parse('2026-03-09')), 60 * minute);
  assert.equal(clock.between(Date.parse('2026-11-01'), Date.parse('2026-11-02')), 150 * minute);
  assert.equal(new Date(clock.add(Date.parse('2026-11-01T05:30:00Z'), 45 * minute)).toISOString(), '2026-11-01T06:45:00.000Z');
  assert.throws(() => parseCalendar({ weekly: { mon: [...range('09:00', '13:00'), ...range('12:00', '17:00')] } }, 'UTC'), { code: 'INVALID_INPUT' });
});

test('SLA deadlines use workspace time, exceptions and holidays, and preserve the assigned calendar through pauses', async () => {
  const { ctx, events, run } = workspaceFixture(operations);
  ctx.role = 'admin';
  ctx.create('workspace', { default_timezone: 'Asia/Taipei' });
  const calendar = await run('inbox_create_business_hours', { name: 'Support', weekly, holidays: ['2026-11-23'], exceptions: { '2026-11-24': range('10:00', '16:00') } });
  assert.equal(calendar.tz, 'Asia/Taipei');
  const policy = await run('inbox_create_sla_policy', { name: 'Support', business_hours_id: calendar.id, first_response_minutes: 60,
    resolution_minutes: 120, pause_on_status: ['snoozed'] });
  await assert.rejects(run('inbox_archive_business_hours', {}, at(calendar)), { code: 'INVALID_STATE' });
  ctx.now = '2026-11-20T08:30:00.000Z';
  const { items: [{ conversation }] } = await run<{ items: { conversation: Row }[] }>('inbox_ingest_batch', {
    messages: [{ ...imported, platform_created_at: ctx.now }],
  });
  const sla = () => run('inbox_get_conversation_sla', {}, byId(conversation.id));
  assert.equal((await sla()).first_response_due_at, '2026-11-24T02:30:00.000Z');
  assert.equal((await sla()).resolution_due_at, '2026-11-24T03:30:00.000Z');
  await run('inbox_update_business_hours', { exceptions: {} }, at(calendar));
  await run('inbox_archive_sla_policy', {}, at(policy));
  ctx.now = '2026-11-20T08:45:00.000Z';
  await run('inbox_update_conversation', { status: 'snoozed', snooze_until: '2026-11-24T02:15:00.000Z' }, at(conversation));
  ctx.now = '2026-11-24T02:15:00.000Z';
  await schedules.find(schedule => schedule.id === 'inbox.unsnooze')!.run(ctx);
  assert.equal((await sla()).paused_seconds, 30 * 60);
  assert.equal((await sla()).first_response_due_at, '2026-11-24T03:00:00.000Z');
  ctx.now = '2026-11-24T03:01:00.000Z';
  const tick = schedules.find(schedule => schedule.id === 'inbox.sla_tick')!;
  await tick.run(ctx);
  await tick.run(ctx);
  assert.equal(events.filter(event => event.type === 'inbox.sla.breached' && event.data.target === 'first').length, 1);
});

test('rules use the workspace day for frequency limits and only approvers can reject a pending draft', async () => {
  const { ctx, run } = workspaceFixture(operations);
  ctx.role = 'admin';
  ctx.create('workspace', { default_timezone: 'Asia/Taipei' });
  const account = ctx.create('social_account', { brand_id: 'brand' });
  const rule = await run('inbox_create_auto_rule', { trigger: 'keyword', keyword: 'question', social_account_id: account.id,
    body_text: 'Draft reply', window_minutes: 30, max_per_participant_per_day: 1 });
  await run('inbox_enable_auto_rule', { enabled: true }, at(rule));
  async function evaluate(id: string, atTime: string) {
    ctx.now = atTime;
    const { items: [{ message }] } = await run<{ items: { message: Row }[] }>('inbox_ingest_batch', { messages: [{
      ...imported, social_account_id: account.id, external_message_id: id, platform_created_at: atTime,
    }] });
    return (await run<Row[]>('inbox_evaluate_auto_rules', {}, byId(message.id)))[0];
  }
  const first = await evaluate('first', '2026-11-20T15:59:00.000Z');
  const second = await evaluate('second', '2026-11-20T16:01:00.000Z');
  const third = await evaluate('third', '2026-11-21T00:01:00.000Z');
  assert.deepEqual([first.outcome, second.outcome, third.outcome], ['drafted', 'drafted', 'skipped_frequency']);
  const draft = ctx.get('reply_draft', String(first.reply_draft_id));
  ctx.role = 'editor';
  const pending = await run('inbox_submit_reply_approval', {}, at(draft));
  await assert.rejects(run('inbox_reject_auto_reply', { reason: 'Use a personal reply' }, at(pending)), { code: 'FORBIDDEN' });
  ctx.role = 'reviewer';
  const rejected = await run('inbox_reject_auto_reply', { reason: 'Use a personal reply' }, at(pending));
  assert.equal(rejected.status, 'discarded');
  assert.equal(ctx.list('work_item').length, 0);
});

test('formal inbox routes persist review and a single approved manual work item', async t => {
  const origin = 'https://smartsell.example.test';
  const setupToken = 'fixture-secret';
  const config = configuration({ NODE_ENV: 'test', SETUP_TOKEN: setupToken, PUBLIC_ORIGIN: origin });
  const discovered = await discoverOperations();
  assert.ok(discovered.schedules.some(schedule => schedule.id === 'inbox.sla_tick'));
  const { app } = buildApp({ ...config, origins: new Set([origin]), setupToken, store: new MemoryStore(), registry: new Map(),
    operationApi: { config, operations: [...discovered.operations, {
      module: 'inbox_test', method: 'POST', path: '/test-social-account', name: 'fixture_social_account', roles: ['owner'],
      summary: 'Seed a social account', run: ctx => ctx.create('social_account', { brand_id: 'brand' }),
    }], register: registerOperationRoutes } });
  t.after(() => app.close());
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { origin, 'x-setup-token': setupToken },
    payload: { email: 'inbox@example.test', password: 'A disposable password', name: 'Owner', workspaceName: 'Inbox Test' } });
  assert.equal(setup.statusCode, 201, setup.body);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const root = `/api/v1/workspaces/${setup.json().workspaces[0].id}`;
  const csrf = await app.inject({ url: '/api/v1/session/csrf', headers: { cookie, origin } });
  assert.equal(csrf.statusCode, 200, csrf.body);
  type Method = 'GET' | 'POST' | 'PATCH';
  const request = (method: Method, url: string, payload?: object, headers = {}) => app.inject({ method, url: root + url,
    headers: { cookie, origin, 'x-csrf-token': csrf.json().csrf_token, ...headers }, payload });
  const ok = async (method: Method, url: string, payload?: object, headers = {}) => {
    const response = await request(method, url, payload, headers);
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data;
  };
  const account = await ok('POST', '/test-social-account', {});
  const now = new Date();
  const nextDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][(now.getUTCDay() + 2) % 7];
  const calendar = await ok('POST', '/inbox/business-hours', { name: 'Off today', tz: 'UTC', weekly: { [nextDay]: range('09:00', '17:00') } });
  const rule = await ok('POST', '/inbox/auto-rules', { trigger: 'business_hours_off', business_hours_id: calendar.id,
    social_account_id: account.id, body_text: 'We will reply during opening hours.', window_minutes: 60, max_per_participant_per_day: 1 });
  await ok('PATCH', `/inbox/auto-rules/${rule.id}`, { enabled: true }, { 'if-match': `"${rule.version}"` });
  const { items: [{ message }] } = await ok('POST', '/inbox/ingest', { messages: [{ ...imported, social_account_id: account.id, platform_created_at: now.toISOString() }] });
  const evaluate = () => ok('POST', `/inbox/messages/${message.id}/evaluate-rules`, {});
  const runs = await evaluate();
  assert.equal(runs[0].outcome, 'drafted');
  assert.deepEqual(await evaluate(), runs);
  const draftId = runs[0].reply_draft_id;
  const draft = await ok('GET', `/reply-drafts/${draftId}`);
  const pending = await ok('POST', `/reply-drafts/${draftId}/submit-approval`, {}, { 'if-match': `"${draft.version}"` });
  assert.deepEqual((await ok('GET', '/inbox/auto-reply-review')).map((row: { id: string }) => row.id), [draftId]);
  const approve = (version: number) => request('POST', `/reply-drafts/${draftId}/approve`, {}, { 'if-match': `"${version}"`, 'idempotency-key': 'rule-approval' });
  assert.equal((await approve(draft.version)).statusCode, 409);
  const approved = await approve(pending.version);
  assert.equal(approved.statusCode, 200, approved.body);
  const { work_item_id: taskId, status } = approved.json().data;
  assert.equal(status, 'approved');
  assert.ok(taskId);
  assert.deepEqual((await approve(pending.version)).json(), approved.json());
  const task = await ok('GET', `/work-items/${taskId}`);
  assert.equal(task.resource_id, draftId);
  assert.equal(task.status, 'open');
  assert.equal(task.source_ref.approved_draft_version, approved.json().data.version);
  assert.deepEqual(await ok('GET', '/inbox/auto-reply-review'), []);
  const invalidSend = await request('POST', `/reply-drafts/${draftId}/send`, {});
  assert.equal(invalidSend.statusCode, 422, invalidSend.body);
  assert.equal(invalidSend.json().error.code, 'VALIDATION_FAILED');

  const missingDraftId = '00000000-0000-4000-8000-000000000001';
  const missingSend = await request('POST', `/reply-drafts/${missingDraftId}/send`, { mode: 'manual', fencing_token: 1 }, {
    'idempotency-key': 'send-missing-draft',
    'if-match': '"1"',
  });
  assert.equal(missingSend.statusCode, 404, missingSend.body);
  assert.equal(missingSend.json().error.code, 'not_found');
});
