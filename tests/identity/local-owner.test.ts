import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initializeLocalOwner } from '../../apps/server/init-local.js';
import { buildApp } from '../../apps/server/src/app.js';
import { localStore } from '../../apps/server/src/local.js';
import { MemoryStore } from '../../apps/server/src/memory.js';

const owner = () => ({ email: 'owner@example.test', name: '店主', workspaceName: '驗收門店', password: randomBytes(30).toString('base64url') });

test('first local owner persists across reopening, uses Argon2id and cannot be replaced', async t => {
  const scratch = fileURLToPath(new URL('../../.local/', import.meta.url));
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(scratch, 'owner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { SMARTSELL_DATA_FILE: join(dir, 'workspace.sqlite') };
  const input = owner();
  await initializeLocalOwner(input, env);
  await assert.rejects(initializeLocalOwner(owner(), env), /已完成/);
  const store = localStore(env.SMARTSELL_DATA_FILE);
  const { app } = buildApp({ store, registry: new Map(), origins: new Set(), secureCookie: false });
  t.after(() => app.close());
  assert.ok((await store.credentials(input.email))?.passwordHash.startsWith('$argon2id$v=19$'));
  const login = (password: string) => app.inject({ method: 'POST', url: '/api/v1/session', payload: { email: input.email, password } });
  assert.equal((await login('incorrect')).statusCode, 401);
  const signedIn = await login(input.password);
  assert.equal(signedIn.statusCode, 200);
  assert.equal(signedIn.json().workspaces[0].name, input.workspaceName);
  assert.equal(signedIn.json().workspaces[0].role, 'owner');
  await assert.rejects(initializeLocalOwner(input, { ...env, NODE_ENV: 'production' }), /HTTPS/);
});

test('previously initialized local owners can still sign in with their existing password', async t => {
  const input = owner();
  const store = new MemoryStore();
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(input.password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 65 * 1024 * 1024 });
  await store.setup({ email: input.email, name: input.name, workspaceName: input.workspaceName, passwordHash: `${salt}:${derived.toString('hex')}` }, 'unused-test-session');
  const { app } = buildApp({ store, registry: new Map(), origins: new Set(), secureCookie: false });
  t.after(() => app.close());
  const reply = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { email: input.email, password: input.password } });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.json().workspaces.length, 1);
});
