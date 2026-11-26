// The Worker's remote-control loop (design E50) against a fake hub: it polls only while the owner has remote control on,
// runs one command at a time, answers every command (a refusal is an answer too), and backs off from old hubs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteAgent } from '../../apps/connector-desktop/src/remote/agent.ts';
import { RemoteError, type RemoteSessions } from '../../apps/connector-desktop/src/remote/sessions.ts';
import type { RemoteCommandEnvelope, RemoteControlSettings, RemoteNextRequest, RemoteResultRequest } from '../../apps/connector-desktop/src/runtime/contracts.ts';

const ON: RemoteControlSettings = { browser: { enabled: true, sites: ['seller.example.com'] }, phone: { enabled: false, apps: [] }, updated_at: '2026-11-26T00:00:00Z' };
const OFF: RemoteControlSettings = { browser: { enabled: false, sites: [] }, phone: { enabled: false, apps: [] }, updated_at: null };
const envelope = (command: Record<string, unknown>, target: 'browser' | 'phone' = 'browser'): RemoteCommandEnvelope => ({
  command_id: '11111111-2222-4333-8444-555555555555', target, command, expires_at: new Date(Date.now() + 30_000).toISOString(),
});

function harness(script: ({ command: RemoteCommandEnvelope | null; settings: RemoteControlSettings } | Error)[], sessions?: Partial<RemoteSessions>) {
  const polls: RemoteNextRequest[] = [];
  const results: RemoteResultRequest[] = [];
  const sleeps: number[] = [];
  let agent: RemoteAgent;
  const hub = {
    async remoteNext(body: RemoteNextRequest) {
      polls.push(body);
      const next = script.shift();
      if (!next) { void agent.stop(); return { command: null, settings: OFF, server_time: '' }; }
      if (next instanceof Error) throw next;
      return { ...next, server_time: '' };
    },
    async remoteResult(body: RemoteResultRequest) { results.push(body); return { accepted: true }; },
  };
  agent = new RemoteAgent({
    hub, browserReady: () => true, browser: () => sessions as RemoteSessions | undefined,
    sleep: async (ms, signal) => { sleeps.push(ms); if (signal?.aborted) throw new Error('aborted'); },
  });
  return { agent, polls, results, sleeps };
}

const settle = () => new Promise(done => setTimeout(done, 30));

test('a browser command runs in the sessions and its snapshot goes back; capabilities say the browser is ready', async () => {
  const handled: unknown[] = [];
  const h = harness([{ command: null, settings: ON }, { command: envelope({ op: 'open', url: 'https://seller.example.com/' }), settings: ON }],
    { handle: async (command: unknown) => { handled.push(command); return { session_id: 's-1', title: 'Seller' } as never; } });
  h.agent.start();
  await settle();
  await h.agent.stop();
  assert.deepEqual(handled, [{ op: 'open', url: 'https://seller.example.com/' }]);
  assert.deepEqual(h.results, [{ command_id: envelope({}).command_id, ok: true, result: { session_id: 's-1', title: 'Seller' } }]);
  assert.equal(h.polls[1].capabilities.browser, true, 'after the first poll the Worker knows remote control is on');
  assert.equal(h.polls[0].wait_ms, 25_000);
});

test('a refusal is an answer with the engine\'s code; an unexpected error becomes REMOTE_FAILED without details', async () => {
  const h = harness([{ command: envelope({ op: 'open', url: 'https://evil.example/' }), settings: ON }, { command: envelope({ op: 'snapshot', session_id: 'x' }), settings: ON }],
    { handle: async (command: { op: string }) => { if (command.op === 'open') throw new RemoteError('SITE_NOT_ALLOWED', 'not allowed'); throw new Error('secret internal detail'); } });
  h.agent.start();
  await settle();
  await h.agent.stop();
  assert.deepEqual(h.results.map(result => result.ok ? 'ok' : result.error.code), ['SITE_NOT_ALLOWED', 'REMOTE_FAILED']);
  assert.ok(h.results.every(result => result.ok || !result.error.message.includes('secret')));
});

test('own-Chrome mode off: browser commands are refused with a clear reason; remote control off: the loop waits', async () => {
  const h = harness([{ command: envelope({ op: 'open', url: 'https://seller.example.com/' }), settings: ON }, { command: null, settings: OFF }]);
  h.agent.start();
  await settle();
  await h.agent.stop();
  assert.equal(h.results[0].ok, false);
  assert.match(!h.results[0].ok ? h.results[0].error.message : '', /use my own Chrome/);
  assert.ok(h.sleeps.includes(20_000), 'off: check back in 20 s');
});

test('an old hub without the route (404) is polled again only after 10 minutes', async () => {
  const h = harness([Object.assign(new Error('not found'), { status: 404 })]);
  h.agent.start();
  await settle();
  await h.agent.stop();
  assert.ok(h.sleeps.includes(10 * 60_000));
});
