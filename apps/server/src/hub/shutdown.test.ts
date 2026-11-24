import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../app.js';
import { configuration } from '../config.js';
import { MemoryStore } from '../memory.js';
import { registerOperationRoutes } from '../operation-server.js';
import { discoverOperations } from '../operations.js';
import { discover } from '../registry.js';

// S4 ledger 7 / S10: a cancelled alert stream followed by another request used to keep app.close() waiting ~70 s (a spare
// client socket that never sent a request counted as a request in progress until headersTimeout). E2E restarts hubs.
test('shutdown: a cancelled alert stream and a later request do not hold app.close()', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-shutdown-'));
  const config = configuration({ SETUP_TOKEN: 'shutdown-setup-token', MEDIA_DIRECTORY: join(dir, 'media') });
  const [{ operations }, discovered] = await Promise.all([discoverOperations(), discover()]);
  const { app } = buildApp({ ...config, ...discovered, store: new MemoryStore(), operationApi: { config, operations, register: registerOperationRoutes } });
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const setup = await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': config.setupToken! },
      body: JSON.stringify({ email: 'shutdown-owner@example.test', name: 'Owner', workspaceName: 'Shutdown', password: 'acceptance-only-1234' }) });
    assert.equal(setup.status, 201);
    const { data: { workspaces: [{ id: wid }] } } = await setup.json();
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const { csrf_token } = await (await fetch(`${base}/api/v1/session/csrf`, { headers: { cookie } })).json();
    const created = await fetch(`${base}/api/v1/workspaces/${wid}/agent-connections`, { method: 'POST',
      headers: { cookie, 'x-csrf-token': csrf_token, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Laptop · Codex', client: 'codex' }) });
    assert.equal(created.status, 201);
    const bearer = { authorization: `Bearer ${(await created.json()).data.token}` };
    const stream = await fetch(`${base}/api/v1/agent/alerts/stream`, { headers: { ...bearer, accept: 'text/event-stream' } });
    assert.equal(stream.status, 200);
    await stream.body?.cancel();
    const after = await fetch(`${base}/api/v1/agent/uploads/config`, { headers: bearer });
    assert.equal(after.status, 200);
    await after.text();
    // A second, still-open stream is ended by the stream's own preClose hook.
    const open = await fetch(`${base}/api/v1/agent/alerts/stream`, { headers: { ...bearer, accept: 'text/event-stream' } });
    assert.equal(open.status, 200);
    const reading = open.text().catch(() => '');
    const started = Date.now();
    await app.close();
    await reading;
    assert.ok(Date.now() - started < 5_000, `app.close() took ${Date.now() - started} ms`);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
