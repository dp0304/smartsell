import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { Problem, type Context, type OwnerAlert } from '@smartsell/contracts';
import { alertFixture, job, post, seedHub } from './fixtures.js';
import { ALERT_STREAM_PATH, applyAlertEvent, createOwnerAlert, registerAgentAlertStream, type AlertStreamPrincipal } from './index.js';

const f = alertFixture();
const hub = seedHub(f);
const runs: boolean[] = [];
let revoked = false;
let wake: ((workspaceId: string) => void) | undefined;
const principal: AlertStreamPrincipal = {
  credentialId: 'cred-1', actorId: 'owner-1', workspaceId: 'ws-1', label: 'Laptop',
  async run<T>(write: boolean, fn: (ctx: Context) => T | Promise<T>) { runs.push(write); return fn(f.ctx); },
};
let app: FastifyInstance;
let base = '';
before(async () => {
  // Client-side keep-alive sockets from fetch would otherwise hold close() for undici's idle timeout.
  app = Fastify({ forceCloseConnections: true });
  registerAgentAlertStream(app, {
    credentials: {
      async authenticate(req) {
        const header = req.headers.authorization;
        if (header === 'Bearer ss_command_forbidden') throw new Problem(403, 'FORBIDDEN', 'role');
        return header === 'Bearer ss_command_good' && !revoked ? principal : undefined;
      },
    },
    subscribe: callback => { wake = callback; return () => { wake = undefined; }; },
    pollMs: 5_000, heartbeatMs: 150, reauthMs: 200,
  });
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
after(() => app.close());

interface Frame { id?: string; event?: string; data?: string; comment?: string }
async function open(path = ALERT_STREAM_PATH, headers: Record<string, string> = { authorization: 'Bearer ss_command_good' }) {
  const abort = new AbortController();
  const response = await fetch(`${base}${path}`, { headers, signal: abort.signal });
  const frames: Frame[] = [];
  let buffer = '';
  let ended = false;
  const pump = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const frame: Frame = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) frame.comment = line.slice(1).trim();
            else if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = line.slice(6);
          }
          frames.push(frame);
        }
      }
    } catch { /* aborted */ } finally { ended = true; }
  })();
  const alerts = () => frames.filter(frame => frame.event === 'owner_alert').map(frame => ({ id: frame.id, alert: JSON.parse(frame.data!) as OwnerAlert }));
  async function until(check: () => boolean, label: string, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}; frames: ${JSON.stringify(frames)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return { response, frames, alerts, until, ended: () => ended, close: async () => { abort.abort(); await pump; } };
}
const raise = (key: string, machine = hub.macB.id) => createOwnerAlert(f.ctx, { kind: 'machine_setup', severity: 'normal', dedupe_key: key, title: `t-${key}`, body: 'b', machine_id: machine })!;

test('authorization: agent bearer token required; forbidden credentials get 403; no write route exists', async () => {
  for (const headers of [{}, { authorization: 'Bearer ss_command_bad' }, { authorization: 'Basic x' }] as Record<string, string>[]) {
    const response = await fetch(`${base}${ALERT_STREAM_PATH}`, { headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'UNAUTHENTICATED');
  }
  assert.equal((await fetch(`${base}${ALERT_STREAM_PATH}`, { headers: { authorization: 'Bearer ss_command_forbidden' } })).status, 403);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await fetch(`${base}${ALERT_STREAM_PATH}`, { method, headers: { authorization: 'Bearer ss_command_good' } })).status, 404);
  }
  const bad = await fetch(`${base}${ALERT_STREAM_PATH}?since=1`, { headers: { authorization: 'Bearer ss_command_good' } });
  assert.equal(bad.status, 422);
  const badId = await fetch(`${base}${ALERT_STREAM_PATH}`, { headers: { authorization: 'Bearer ss_command_good', 'last-event-id': 'abc' } });
  assert.equal(badId.status, 422);
});

test('a new subscriber starts at the newest alert, then receives each new alert once, read-only', async () => {
  raise('before-1');
  raise('before-2');
  runs.length = 0;
  const snapshot = JSON.stringify(f.ctx.list('owner_alert'));
  const stream = await open();
  assert.equal(stream.response.status, 200);
  assert.match(stream.response.headers.get('content-type') ?? '', /^text\/event-stream/);
  await stream.until(() => stream.frames.some(frame => frame.id === '2' && !frame.event), 'baseline id');
  await stream.until(() => stream.frames.some(frame => frame.comment === 'heartbeat'), 'heartbeat');
  assert.equal(stream.alerts().length, 0, 'history is not replayed to a fresh subscriber');
  assert.equal(JSON.stringify(f.ctx.list('owner_alert')), snapshot, 'streaming changes nothing');
  const third = raise('live-3');
  wake?.('ws-1');
  await stream.until(() => stream.alerts().length === 1, 'live alert');
  const [{ id, alert }] = stream.alerts();
  assert.equal(id, String(third.seq));
  assert.equal(alert.id, third.id);
  assert.equal(alert.machine?.label, 'Mac-B');
  assert.deepEqual(Object.keys(alert).sort(), ['at', 'body', 'channel', 'id', 'kind', 'machine', 'post', 'read_at', 'severity', 'title', 'web_url']);
  wake?.('ws-other');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(stream.alerts().length, 1, 'no duplicate delivery');
  await stream.close();
  assert.ok(runs.length > 0 && runs.every(write => write === false), 'every transaction the stream opens is read-only');
});

test('Last-Event-ID resumes after the given seq, in order; ?last_event_id= works for header-less clients; machine_id filters', async () => {
  const latest = Math.max(...f.ctx.list('owner_alert').map(row => Number(row.seq)));
  const resumed = await open(ALERT_STREAM_PATH, { authorization: 'Bearer ss_command_good', 'last-event-id': String(latest - 2) });
  await resumed.until(() => resumed.alerts().length === 2, 'replayed alerts');
  assert.deepEqual(resumed.alerts().map(entry => Number(entry.id)), [latest - 1, latest]);
  await resumed.close();
  const query = await open(`${ALERT_STREAM_PATH}?last_event_id=${latest - 1}`);
  await query.until(() => query.alerts().length === 1, 'query resume');
  assert.equal(Number(query.alerts()[0]!.id), latest);
  await query.close();
  raise('win-c', hub.winC.id);
  const filtered = await open(`${ALERT_STREAM_PATH}?last_event_id=0&machine_id=${hub.winC.id}`);
  await filtered.until(() => filtered.alerts().length === 1, 'filtered');
  assert.equal(filtered.alerts()[0]!.alert.machine?.label, 'Win-C');
  await filtered.close();
  // A cursor ahead of the data (for example a fresh hub data file) does not error; it continues from the newest alert.
  const ahead = await open(ALERT_STREAM_PATH, { authorization: 'Bearer ss_command_good', 'last-event-id': '999999' });
  await ahead.until(() => ahead.frames.some(frame => frame.comment === 'connected'), 'connected');
  assert.equal(ahead.alerts().length, 0);
  await ahead.close();
});

test('E2E-4 shape: a captcha blocker reaches the stream naming Mac-B and @fixture_x', async () => {
  const stream = await open();
  await stream.until(() => stream.frames.some(frame => frame.comment === 'connected'), 'connected');
  const target = post(f, hub.x, '2026-11-25T01:00:00.000Z');
  const row = job(f, { device: hub.macB, account: hub.x, target, notBefore: '2026-11-25T01:00:00.000Z', status: 'needs_owner',
    blocker: { code: 'captcha', phase: 'prepare', message: '', resumable_by: 'auto', machine_id: hub.macB.id, machine_name: 'Mac-B', social_account_id: hub.x.id, channel_label: 'X @fixture_x', at: f.ctx.now } });
  applyAlertEvent(f.ctx, 'worker.job.status_changed', { job_id: row.id, from: 'claimed', to: 'needs_owner', blocker_code: 'captcha' });
  wake?.('ws-1');
  await stream.until(() => stream.alerts().some(entry => entry.alert.kind === 'worker_blocker'), 'blocker alert');
  const { alert } = stream.alerts().find(entry => entry.alert.kind === 'worker_blocker')!;
  assert.equal(alert.severity, 'urgent');
  assert.match(`${alert.title} ${alert.body}`, /Mac-B/);
  assert.match(`${alert.title} ${alert.body}`, /@fixture_x/);
  assert.equal(alert.post?.id, target.id);
  assert.match(alert.web_url, new RegExp(`/posts/${target.id}$`));
  await stream.close();
});

test('a revoked connection loses the stream at the next re-check', async () => {
  const stream = await open();
  await stream.until(() => stream.frames.some(frame => frame.comment === 'connected'), 'connected');
  revoked = true;
  try {
    await stream.until(() => stream.ended(), 'stream end after revocation');
  } finally { revoked = false; await stream.close(); }
});
