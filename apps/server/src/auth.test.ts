// SEC-2 (wave 6, G5-ops): login throttling on the hub, where `trustProxy: '127.0.0.1'` makes request.ip the
// X-Forwarded-For client of `tailscale serve`. A process on the hub machine can set that header freely.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { buildApp } from './app.js';
import { ACCOUNT_FAILURES_PER_WINDOW, createThrottle } from './auth.js';
import { MemoryStore } from './memory.js';
import { DomainError } from './modules/types.js';

const ORIGIN = 'https://hub.tail1234.ts.net';
const PASSWORD = 'a disposable fixture password';

async function hub(t: TestContext) {
  const setupToken = randomBytes(32).toString('hex');
  const { app } = buildApp({ origins: new Set([ORIGIN]), setupToken, secureCookie: true, store: new MemoryStore(), registry: new Map(),
    trustProxy: '127.0.0.1' } as unknown as Parameters<typeof buildApp>[0]);
  t.after(() => app.close());
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', remoteAddress: '127.0.0.1', headers: { origin: ORIGIN, 'x-setup-token': setupToken },
    payload: { username: 'owner', password: PASSWORD, workspaceName: 'Shop' } });
  assert.equal(setup.statusCode, 201, setup.body);
  // Every request reaches the hub from 127.0.0.1 (tailscale serve, or a local process that claims any X-Forwarded-For).
  const login = (forwarded: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/session', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': forwarded, origin: ORIGIN }, payload });
  return { app, login };
}

test('createThrottle: a full map evicts expired, then the oldest entries, instead of refusing every new key', () => {
  let now = 1_000;
  const throttle = createThrottle({ limit: 2, windowMs: 60_000, capacity: 3, now: () => now });
  for (const key of ['a', 'b', 'c']) throttle.hit(key);
  assert.equal(throttle.size, 3);
  throttle.hit('d');   // the old code threw 429 here for every newcomer once 10,000 keys were in the map
  assert.equal(throttle.size, 3);
  throttle.hit('a');   // 'a' was the oldest window and was evicted: it starts over
  throttle.hit('a');
  assert.throws(() => throttle.hit('a'), (error: unknown) => error instanceof DomainError && error.status === 429);
  now += 61_000;       // expired entries go before any live one
  throttle.hit('e');
  assert.equal(throttle.size, 1);
  throttle.record('f'); throttle.record('f');
  assert.equal(throttle.exhausted('f'), true);
  throttle.clear('f');
  assert.equal(throttle.exhausted('f'), false);
});

test('SEC-2: rotating X-Forwarded-For no longer gives unlimited password guesses against the owner', async t => {
  const { login } = await hub(t);
  const codes: number[] = [];
  for (let attempt = 0; attempt < ACCOUNT_FAILURES_PER_WINDOW + 5; attempt++) {
    codes.push((await login(`203.0.113.${attempt + 1}`, { username: 'owner', password: `wrong-guess-${attempt}` })).statusCode);
  }
  assert.deepEqual(codes.slice(0, ACCOUNT_FAILURES_PER_WINDOW), Array(ACCOUNT_FAILURES_PER_WINDOW).fill(401));
  assert.deepEqual(codes.slice(ACCOUNT_FAILURES_PER_WINDOW), Array(5).fill(429), 'the account limit holds whatever address is claimed');
  // A made-up name gets the same answers (no account enumeration) and does not share the owner's budget.
  assert.equal((await login('203.0.113.200', { username: 'nobody', password: 'wrong-guess' })).statusCode, 401);
});

test('SEC-2: filling the per-address map with spoofed addresses does not lock the owner out of signing in', async t => {
  const { login } = await hub(t);
  const codes = new Map<number, number>();
  // Cheap malformed requests with 10,050 distinct spoofed addresses (the map holds 10,000).
  for (let index = 0; index < 10_050; index++) {
    const response = await login(`10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`, { bogus: true });
    codes.set(response.statusCode, (codes.get(response.statusCode) ?? 0) + 1);
  }
  assert.deepEqual([...codes.keys()], [422], 'every flood request is refused for its body, none for a full map');
  // The owner on their tailnet address (rewritten by tailscale serve) still signs in.
  const owner = await login('100.101.102.103', { username: 'owner', password: PASSWORD });
  assert.equal(owner.statusCode, 200, owner.body);
});
