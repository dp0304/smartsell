// SEC-2 (wave 6, G5-ops): login throttling on the hub, where `trustProxy: '127.0.0.1'` makes request.ip the
// X-Forwarded-For client of `tailscale serve`. A process on the hub machine can set that header freely.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { buildApp } from './app.js';
import { ACCOUNT_FAILURE_WINDOW_MS, ACCOUNT_FAILURES_PER_WINDOW, ACCOUNT_SLOWED_CONCURRENCY, createThrottle, signInDelayMs } from './auth.js';
import { MemoryStore } from './memory.js';
import { DomainError } from './modules/types.js';

const ORIGIN = 'https://hub.tail1234.ts.net';
const PASSWORD = 'a disposable fixture password';

async function hub(t: TestContext, extra: { loginDelay?: (ms: number) => Promise<void> } = {}) {
  const setupToken = randomBytes(32).toString('hex');
  const { app } = buildApp({ origins: new Set([ORIGIN]), setupToken, secureCookie: true, store: new MemoryStore(), registry: new Map(),
    trustProxy: '127.0.0.1', ...extra } as unknown as Parameters<typeof buildApp>[0]);
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

test('S3: the slowdown grows 1 s, 2 s, 4 s … up to 10 s past 20 failures for a name', () => {
  assert.deepEqual([0, 19, 20, 21, 22, 23, 24, 25, 500].map(signInDelayMs), [0, 0, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
});

test('SEC-2/S3: rotating X-Forwarded-For gets slower and slower answers instead of unlimited fast guesses', async t => {
  const delays: number[] = [];
  const { login } = await hub(t, { loginDelay: async ms => { delays.push(ms); } });
  const codes: number[] = [];
  for (let attempt = 0; attempt < ACCOUNT_FAILURES_PER_WINDOW + 5; attempt++) {
    codes.push((await login(`203.0.113.${attempt + 1}`, { username: 'owner', password: `wrong-guess-${attempt}` })).statusCode);
  }
  assert.deepEqual(codes, Array(ACCOUNT_FAILURES_PER_WINDOW + 5).fill(401));
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10000], 'every guess past 20 waits before the password is checked');
  // The right password from yet another address still signs in, after the same wait.
  const owner = await login('100.101.102.103', { username: 'owner', password: PASSWORD });
  assert.equal(owner.statusCode, 200, owner.body);
  assert.equal(delays.at(-1), 10000);
  // A made-up name gets the same answers (no account enumeration) and does not share the owner's budget.
  delays.length = 0;
  assert.equal((await login('203.0.113.200', { username: 'nobody', password: 'wrong-guess' })).statusCode, 401);
  assert.deepEqual(delays, []);
});

test('S3: 20 failures lock only that address out of that name; the owner signs in from another address', async t => {
  const delays: number[] = [];
  // Before the app exists: the throttles keep a reference to Date.now.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { login } = await hub(t, { loginDelay: async ms => { delays.push(ms); } });
  const attacker = '203.0.113.9';
  for (let attempt = 0; attempt < ACCOUNT_FAILURES_PER_WINDOW; attempt++) {
    // The per-address limit (10 a minute) still applies on its own.
    if (attempt && attempt % 10 === 0) t.mock.timers.tick(61_000);
    assert.equal((await login(attacker, { username: 'owner', password: `wrong-guess-${attempt}` })).statusCode, 401);
  }
  t.mock.timers.tick(61_000);
  assert.equal((await login(attacker, { username: 'owner', password: PASSWORD })).statusCode, 429, 'that address is refused even with the right password');
  assert.equal((await login(attacker, { username: 'someone-else', password: 'wrong-guess' })).statusCode, 401, 'only for that name');
  assert.deepEqual(delays, []);
  const owner = await login('100.101.102.103', { username: 'owner', password: PASSWORD });
  assert.equal(owner.statusCode, 200, owner.body);
  assert.deepEqual(delays, [1000], 'slowed because the name failed 20 times, not refused');
  // When the window passes the address starts over.
  t.mock.timers.tick(ACCOUNT_FAILURE_WINDOW_MS);
  delays.length = 0;
  assert.equal((await login(attacker, { username: 'owner', password: PASSWORD })).statusCode, 200);
  assert.deepEqual(delays, []);
});

test('S3: only a few slowed attempts per name run at once, which bounds parallel guessing', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { login } = await hub(t, { loginDelay: () => gate });
  for (let attempt = 0; attempt < ACCOUNT_FAILURES_PER_WINDOW; attempt++) {
    assert.equal((await login(`198.51.100.${attempt + 1}`, { username: 'owner', password: `wrong-guess-${attempt}` })).statusCode, 401);
  }
  const waiting = Array.from({ length: ACCOUNT_SLOWED_CONCURRENCY }, (_, index) =>
    login(`192.0.2.${index + 1}`, { username: 'owner', password: index === 0 ? PASSWORD : `parallel-${index}` }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await login('192.0.2.200', { username: 'owner', password: 'one-too-many' })).statusCode, 429);
  release();
  assert.deepEqual((await Promise.all(waiting)).map(response => response.statusCode), [200, ...Array(ACCOUNT_SLOWED_CONCURRENCY - 1).fill(401)]);
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
