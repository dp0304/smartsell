// E50 remote control on the hub: the broker pairs an Agent's command with the machine's long poll, only that machine
// can answer it, and the owner's settings are validated strictly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem } from '@smartsell/contracts';
import { RemoteBroker } from './broker.js';
import { parseCapabilities } from './device-http.js';
import { normaliseSite, remoteSettings } from './settings.js';

const caps = { browser: true, phones: [] };

test('a command reaches the machine\'s waiting poll; its answer resolves the Agent\'s call and remembers the session', async () => {
  const broker = new RemoteBroker();
  const poll = broker.next('ws', 'mac-b', caps, 5000);
  assert.equal(broker.listening('ws', 'mac-b'), true);
  const call = broker.submit('ws', 'mac-b', 'browser', { op: 'open', url: 'https://seller.example.com/' });
  const envelope = await poll;
  assert.ok(envelope);
  assert.deepEqual(envelope.command, { op: 'open', url: 'https://seller.example.com/' });
  assert.equal(broker.resolve('ws', 'win-c', { command_id: envelope.command_id, ok: true, result: {} }), false, 'another machine cannot answer');
  assert.equal(broker.resolve('ws', 'mac-b', { command_id: envelope.command_id, ok: true, result: { session_id: 's-1', title: 'x' } }), true);
  assert.deepEqual(await call, { session_id: 's-1', title: 'x' });
  assert.deepEqual(broker.sessionMachine('s-1'), { workspaceId: 'ws', deviceId: 'mac-b' });
});

test('a command waits in the queue for the next poll; a refusal becomes a Problem with the Worker\'s code', async () => {
  const broker = new RemoteBroker();
  await broker.next('ws', 'mac-b', caps, 0);
  const call = broker.submit('ws', 'mac-b', 'browser', { op: 'snapshot', session_id: 's' });
  const envelope = await broker.next('ws', 'mac-b', caps, 1000);
  broker.resolve('ws', 'mac-b', { command_id: envelope!.command_id, ok: false, error: { code: 'SITE_NOT_ALLOWED', message: 'not allowed' } });
  await assert.rejects(call, (error: unknown) => error instanceof Problem && error.code === 'SITE_NOT_ALLOWED');
});

test('no Worker listening: refused at once; no answer: MACHINE_TIMEOUT', async () => {
  const broker = new RemoteBroker();
  await assert.rejects(broker.submit('ws', 'gone', 'browser', { op: 'snapshot' }), (error: unknown) => error instanceof Problem && error.code === 'MACHINE_NOT_LISTENING');
  await broker.next('ws', 'mac-b', caps, 0);
  await assert.rejects(broker.submit('ws', 'mac-b', 'browser', { op: 'snapshot' }, { timeoutMs: 50 }), (error: unknown) => error instanceof Problem && error.code === 'MACHINE_TIMEOUT');
});

test('a poll ends with null after its wait, or at once when the Worker disconnects', async () => {
  const broker = new RemoteBroker();
  assert.equal(await broker.next('ws', 'mac-b', caps, 20), null);
  const abort = new AbortController();
  const pending = broker.next('ws', 'mac-b', caps, 20_000, abort.signal);
  abort.abort();
  assert.equal(await pending, null);
});

test('settings: sites normalised to hosts; bad sites, apps and fields refused; off when never set', () => {
  assert.equal(normaliseSite('https://Seller.Shopee.tw/portal/x', 0), 'seller.shopee.tw');
  assert.equal(normaliseSite('*.myshopify.com', 0), '*.myshopify.com');
  assert.equal(normaliseSite('127.0.0.1:4100', 0), '127.0.0.1:4100');
  for (const bad of ['*', '*.com', 'javascript:alert(1)', 'a b.com', '', 42]) assert.throws(() => normaliseSite(bad, 0), Problem, String(bad));
  assert.deepEqual(remoteSettings({ id: 'd' } as never), { browser: { enabled: false, sites: [] }, phone: { enabled: false, apps: [] }, updated_at: null });
});

test('capabilities from the Worker are bounded and validated', () => {
  assert.deepEqual(parseCapabilities({ browser: true, phones: [{ serial: 'R5CT1', model: 'SM A546E', state: 'device' }, { serial: 'bad serial!' }] }),
    { browser: true, phones: [{ serial: 'R5CT1', model: 'SM A546E', state: 'device' }] });
  assert.deepEqual(parseCapabilities('nonsense'), { browser: false, phones: [] });
});
