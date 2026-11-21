import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore } from '../../../../../packages/db/src/index.ts';
import { makeContext } from '../../context.ts';
import { configuration } from '../../config.ts';
import { discoverOperations } from '../../operations.ts';
import { createServer } from '../../server.ts';

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-engagement-'));
  const setupToken = 'engagement-test-token';
  const store = await fileStore(join(directory, 'state.sqlite'));
  const discovered = await discoverOperations();
  const app = createServer({ config: configuration({ SETUP_TOKEN: setupToken, HOST: '127.0.0.1', ROLE: 'all' }),
    store, ...discovered });
  t.after(async () => { await app.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const setup = await fetch(`${origin}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': setupToken }, body: JSON.stringify({ email: 'owner@example.test', name: 'Owner', workspaceName: 'Engagement', password: 'acceptance-only-1234' }) });
  assert.equal(setup.status, 201);
  const { csrf_token: csrf, workspaces, user } = (await setup.json()).data;
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const prefix = `${origin}/api/v1/workspaces/${workspaces[0].id}`;
  const call = async (method, path, body, { status = 200, version, key } = {}) => {
    const response = await fetch(prefix + path, { method, headers: { cookie, 'x-csrf-token': csrf,
      ...(version && { 'if-match': String(version) }), ...(key && { 'idempotency-key': key }), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const content = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${content}`);
    return content ? JSON.parse(content).data : undefined;
  };
  const workspaceId = workspaces[0].id;
  const scope = await store.transaction({ readOnly: true }, ({ identity }) => ({
    workspaceId, actorId: user.id, tenantId: identity.get(`workspace/${workspaceId}`).tenantId,
  }));
  const seed = run => store.transaction({}, async tx => run(makeContext(await tx.workspace(scope), scope, 'owner')));
  return { call, seed };
}
