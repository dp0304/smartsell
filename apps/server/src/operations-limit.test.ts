import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { READ, type Data } from '@smartsell/contracts';
import { Records } from '@smartsell/db';
import { configuration } from './config.js';
import { runScopedOperation, type Registered } from './operations.js';

// E22: `limit` reaches run() only for reads that opt in with ownsLimit (object results); array results keep cursor pagination.
test('E22: ownsLimit reads receive limit; array reads keep every page', async () => {
  const records = new Records(new Map(), false);
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const config = configuration({ SETUP_TOKEN: 'operations-limit-fixture-token' });
  const objectRead: Registered = { module: 'workspace', method: 'GET', path: '/views/echo', name: 'views_echo', roles: READ, summary: 'echo',
    contract: { query: ['limit'] }, ownsLimit: true, run: (_ctx, { query }) => ({ seen: query.limit ?? null }) };
  const arrayRead: Registered = { module: 'workspace', method: 'GET', path: '/views/rows', name: 'views_rows', roles: READ, summary: 'rows',
    contract: { query: ['limit'] }, run: (_ctx, { query }) => {
      assert.equal(query.limit, undefined, 'an array read never sees limit');
      return Array.from({ length: 5 }, (_, index) => ({ id: `r${index}` }));
    } };
  const call = async (operation: Registered, query: Record<string, string>) =>
    (await runScopedOperation(records, scope, { actorId: scope.actorId }, 'owner', randomUUID(), operation,
      { params: {}, query, body: {} }, 'rest', config)).body as Data;

  assert.deepEqual((await call(objectRead, { limit: '7' })).data, { seen: '7' });
  assert.deepEqual((await call(objectRead, {})).data, { seen: null });

  const first = await call(arrayRead, { limit: '2' });
  assert.deepEqual((first.data as Data[]).map(row => row.id), ['r0', 'r1']);
  const second = await call(arrayRead, { limit: '2', cursor: String(first.next_cursor) });
  assert.deepEqual((second.data as Data[]).map(row => row.id), ['r2', 'r3']);
});
