import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import type { Context } from '@smartsell/contracts';
import { configuration, type ProcessRole } from '../../config.js';
import { makeContext } from '../../context.js';
import { commandBackgroundStore } from '../../integration/command-background.js';
import { MemoryStore } from '../../memory.js';
import { runWorkspaceBackground } from '../../runtime.js';
import { configureAlerts, resetAlertHooks } from './model.js';
import { createAlertsDrain, updateChannels } from './push.js';
import { alertReminderSchedule } from './reminders.js';
import { alertTriggerSubscriber } from './triggers.js';

test('hub background: a captcha status event becomes an owner alert through the outbox and reaches a fake ntfy server', async t => {
  const received: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200).end('{}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  resetAlertHooks();
  configureAlerts({ secretKey: randomBytes(32), publicOrigin: 'https://hub.tail1234.ts.net' });
  t.after(resetAlertHooks);

  const db = new MemoryStore();
  await db.setup({ email: 'owner@example.test', name: 'Owner', workspaceName: 'Alerts', passwordHash: 'unused' }, 'unused');
  const background = commandBackgroundStore(db);
  const [ws] = await background.workspaces();
  assert.ok(ws);
  const transact = <T>(run: (ctx: Context) => T) => background.transact(ws, false, (records, scope) => run(makeContext(records, scope, 'owner')));
  const jobId = await transact(ctx => {
    ctx.create('workspace', { default_timezone: 'Asia/Shanghai' });
    const device = ctx.create('connector_device', { display_name: 'Mac-B', name: 'mac-b', status: 'active', last_seen_at: ctx.now });
    const account = ctx.create('social_account', { provider: 'x', handle: 'fixture_x', status: 'active' });
    ctx.create('channel_settings', { social_account_id: account.id, lateness_limit_min: 30 });
    ctx.create('account_execution_binding', { social_account_id: account.id, device_id: device.id, status: 'active' });
    const target = ctx.create('publish_target', { social_account_id: account.id, scheduled_at: new Date(Date.now() + 3_600_000).toISOString(), plan_status: 'ready' });
    const job = ctx.create('worker_job', { kind: 'publish_post', status: 'needs_owner', device_id: device.id, social_account_id: account.id,
      publish_target_id: target.id, dry_run: false, mode: 'auto', not_before: target.scheduled_at, not_after: new Date(Date.now() + 5_400_000).toISOString(),
      prepare_lead_min: 30, resume_token: 0, blocker: { code: 'captcha', phase: 'prepare' } });
    updateChannels(ctx, { body: { channels: [{ kind: 'ntfy', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hub-alerts` }] }, params: {}, query: {} });
    ctx.emit('worker.job.status_changed', { job_id: job.id, from: 'claimed', to: 'needs_owner', publish_target_id: target.id,
      social_account_id: account.id, device_id: device.id, blocker_code: 'captcha' });
    return job.id;
  });

  let failed: unknown;
  const log = { error(details: unknown) { failed = details; }, debug() {} } as unknown as FastifyBaseLogger;
  const stop = runWorkspaceBackground(background, { ...configuration({}), roles: new Set<ProcessRole>(['worker', 'scheduler']) },
    [alertTriggerSubscriber], [alertReminderSchedule], log, [], undefined, createAlertsDrain());
  const deadline = Date.now() + 15_000;
  while (!received.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  await stop();
  assert.equal(failed, undefined);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.topic, 'hub-alerts');
  assert.match(String(received[0]!.message), /機器：Mac-B\n帳號：X @fixture_x\n/);
  const alerts = await transact(ctx => ctx.list('owner_alert'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, 'worker_blocker');
  assert.equal(alerts[0]!.job_id, jobId);
  assert.equal(alerts[0]!.push_status, 'sent');
  await db.close();
});
