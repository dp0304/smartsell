import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from './app.js';
import { configuration } from './config.js';
import { localStore } from './local.js';
import { MemoryStore } from './memory.js';
import { DomainError } from './modules/types.js';
import { readProjection } from './read-policy.js';
import { register, type Registry } from './registry.js';

const origin = 'https://smartsell.example.test';
const setupToken = 'test-secret';
const payload = { email: 'owner@example.test', password: 'A disposable password', name: 'Owner', workspaceName: 'Workspace' };
const options = { origins: new Set([origin]), setupToken, secureCookie: true };

function registryFixture() {
  const registry: Registry = new Map();
  register(registry, 'workspace', {
    save_brand: {
      roles: ['owner', 'admin'], async run(ctx, input) {
        const row = await ctx.get('workspace', 'brand', 'brand');
        const patch = { name: input.name, private_payload: { key: 'secret fixture' } };
        const changed = row ? await ctx.update('workspace', 'brand', row.id, patch, input.version) :
          await ctx.insert('workspace', 'brand', patch, 'brand');
        await ctx.emit('workspace.brand.saved', { id: changed.id });
        if (input.fail) throw new DomainError('fixture_failure', 'Roll back');
        return changed;
      },
    },
    review_only: { roles: ['reviewer'], async run() { return true; } },
  });
  return registry;
}

test('session rotation, single setup, scopes, idempotency, and rollback over the API', async t => {
  const { app } = buildApp({ ...options, store: new MemoryStore(), registry: registryFixture() });
  t.after(() => app.close());
  const setup = () => app.inject({ method: 'POST', url: '/api/v1/setup', payload, headers: { origin, 'x-setup-token': setupToken } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/setup', payload })).statusCode, 403);
  const setups = await Promise.all([setup(), setup()]);
  assert.deepEqual(setups.map(result => result.statusCode).sort(), [201, 409]);
  const first = setups.find(result => result.statusCode === 201)!;
  assert.match(String(first.headers['set-cookie']), /__Host-smartsell_session=.*HttpOnly; SameSite=Strict;.*Secure/);
  const initialCookie = String(first.headers['set-cookie']).split(';')[0];
  const { workspaces: [{ id }] } = first.json();
  const path = `/api/v1/workspaces/${id}`;
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { cookie: initialCookie, origin }, payload });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  assert.notEqual(cookie, initialCookie);
  assert.equal((await app.inject({ url: '/api/v1/session', headers: { cookie: initialCookie } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v1/workspaces/00000000-0000-0000-0000-000000000001/commands', headers: { cookie } })).statusCode, 404);
  assert.deepEqual((await app.inject({ url: `${path}/commands`, headers: { cookie } })).json(), { items: [{ module: 'workspace', action: 'save_brand' }] });
  const command = (key: string, input: object, source = origin, action = 'save_brand') => app.inject({ method: 'POST',
    url: `${path}/commands/workspace/${action}`, headers: { cookie, origin: source, 'idempotency-key': key }, payload: input });
  assert.equal((await command('blocked', {}, 'https://untrusted.example.test')).statusCode, 403);
  assert.equal((await command('review', {}, origin, 'review_only')).statusCode, 403);
  assert.equal((await command('save', { name: 'First' })).statusCode, 200);
  const [one, replay] = await Promise.all([command('edit', { name: 'Second', version: 1 }), command('edit', { version: 1, name: 'Second' })]);
  assert.equal(one.statusCode, 200);
  assert.deepEqual(replay.json(), one.json());
  assert.equal(one.json().data.version, 2);
  assert.equal((await command('edit', { name: 'Different', version: 1 })).json().error.code, 'idempotency_conflict');
  assert.equal((await command('stale', { name: 'Stale', version: 1 })).json().error.code, 'version_conflict');
  assert.equal((await command('abort', { name: 'Discard', version: 2, fail: true })).statusCode, 422);
  const records = await app.inject({ url: `${path}/records/workspace/brand`, headers: { cookie } });
  assert.deepEqual(records.json().items.map(({ data, version }: { data: object; version: number }) => ({ data, version })),
    [{ data: { name: 'Second' }, version: 2 }]);
  assert.equal((await app.inject({ url: `${path}/records/account/credential`, headers: { cookie } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/session', headers: { cookie, origin } })).statusCode, 204);
  assert.equal((await app.inject({ url: '/api/v1/session', headers: { cookie } })).statusCode, 401);
});

test('loopback preview persists session, records, and idempotency across restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'preview.sqlite');
  const first = localStore(file);
  const { password: _, ...input } = payload;
  assert.ok(await first.setup({ ...input, passwordHash: 'fixture' }, 'session'));
  const id = (await first.session('session'))!.workspaces[0].id;
  const key = { module: 'workspace', action: 'save_brand', key: 'persist', fingerprint: 'same' };
  await first.workspace('session', id, unit => unit.command(key, async () => {
    await unit.context.insert('workspace', 'brand', { name: 'Persisted' }, 'brand');
    return 'committed';
  }));
  await first.close();
  const second = localStore(file);
  try {
    assert.equal(await second.workspace('session', id, unit => unit.command(key, async () => assert.fail('replay ran again'))), 'committed');
    assert.deepEqual((await second.workspace('session', id, unit => unit.context.get('workspace', 'brand', 'brand')))?.data, { name: 'Persisted' });
  } finally { await second.close(); }
});

test('read projections and configuration default closed for sensitive records and production storage', () => {
  assert.equal(readProjection('account', 'connection', 'viewer'), undefined);
  assert.equal(readProjection('team', 'share', 'owner'), undefined);
  assert.ok(readProjection('account', 'connection', 'admin'));
  assert.throws(() => configuration({ NODE_ENV: 'production' }), /Production requires/);
  assert.throws(() => configuration({ HOST: '0.0.0.0' }), /loopback/);
});
