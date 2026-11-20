import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import { configuration, type ProcessRole } from './config.js';
import { makeContext } from './context.js';
import { commandBackgroundStore } from './integration/command-background.js';
import { localStore } from './local.js';
import { MemoryStore } from './memory.js';
import type { Entity } from './modules/types.js';
import type { Subscriber } from './operations.js';
import { runWorkspaceBackground } from './runtime.js';
import type { Store } from './store.js';

const day = 86_400_000;
const rowIds = (store: Store, workspaceId: string) => store.operationWork!(workspaceId, async ({ context }) =>
  (await context.list('operation_runtime', 'record')).map(row => row.id).sort());
type Persisted = { records: [string, Entity][]; responses: unknown[]; audit: unknown[] };
function persisted(path: string, change?: (state: Persisted) => void): Persisted {
  const db = new DatabaseSync(path);
  try {
    const state = JSON.parse((db.prepare('SELECT payload FROM snapshot WHERE id = 1').get() as { payload: string }).payload) as Persisted;
    if (change) {
      change(state);
      db.prepare('UPDATE snapshot SET payload = ? WHERE id = 1').run(JSON.stringify(state));
    }
    return state;
  } finally { db.close(); }
}
const persistedRowIds = (state: Persisted) => state.records.map(([, row]) => row)
  .filter(row => row.module === 'operation_runtime' && row.kind === 'record').map(row => row.id).sort();

test('finished jobs and pruned outbox events leave the persisted local snapshot instead of null tombstones', async t => {
  const start = Date.parse('2026-11-01T00:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const db = localStore(path);
  await db.setup({ email: 'owner@example.test', name: 'Owner', workspaceName: 'Prune test', passwordHash: 'unused' }, 'unused');
  const background = commandBackgroundStore(db);
  const [ws] = await background.workspaces();
  assert.ok(ws);
  await background.transact(ws, false, (records, scope) => {
    const ctx = makeContext(records, scope, 'owner');
    for (let index = 0; index < 3; index++) ctx.emit('test.happened', { index });
  });
  // 'workspace' and 'agent' accept every event in production, so each event gets one job and one consumed marker per subscriber.
  const subscribers: Subscriber[] = ['workspace', 'agent'].map(id => ({ id, accepts: () => true, run: () => {} }));
  const drained: (() => void)[] = [];
  const nextDrain = () => new Promise<void>(resolve => drained.push(resolve));
  const drain = async () => { drained.shift()?.(); };
  let failed: unknown;
  const log = { error(details: unknown) { failed = details; } } as FastifyBaseLogger;
  const timeout = setTimeout(() => assert.fail('background cycle did not finish'), 10_000);
  t.after(() => clearTimeout(timeout));

  // The first cycle dispatches and runs every job, then reaches the drain.
  const consumed = nextDrain();
  const stop = runWorkspaceBackground(background, { ...configuration({}), roles: new Set<ProcessRole>(['worker']) },
    subscribers, [], log, [], undefined, drain);
  await consumed;
  const before = await rowIds(db, ws.id);
  assert.equal(before.filter(id => id.startsWith('outbox/')).length, 3);
  assert.equal(before.filter(id => id.startsWith('consumed/')).length, 6);
  assert.deepEqual(before.filter(id => id.startsWith('job/')), [], 'finished jobs leave no row behind');

  // Past the retention window the next hourly prune removes the delivered events and their consumed markers.
  const pruned = nextDrain();
  t.mock.timers.setTime(start + 4 * day);
  await pruned;
  await stop();
  assert.equal(failed, undefined);
  const after = await rowIds(db, ws.id);
  assert.ok(after.length < before.length);
  assert.deepEqual(after.filter(id => /^(outbox|consumed|job)\//.test(id)), []);
  await db.close();

  const reopened = localStore(path);
  try { assert.deepEqual(await rowIds(reopened, ws.id), after, 'the persisted snapshot holds no pruned rows'); }
  finally { await reopened.close(); }
  // Every write above was a background flush; none may leave a per-write replay record or audit line behind.
  const { responses, audit } = persisted(path);
  assert.deepEqual([responses.length, audit.length], [0, 0]);
});

test('background flushes keep no replay record while report commands still replay', async () => {
  const db = new MemoryStore();
  await db.setup({ email: 'owner@example.test', name: 'Owner', workspaceName: 'Replay test', passwordHash: 'unused' }, 'unused');
  const [ws] = await db.operationWorkspaces();
  const runs = { background: 0, report: 0 };
  await db.operationWork(ws.id, async ({ command }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await command({ module: 'operation_runtime', action: 'background', key: 'background/fixed', fingerprint: '' }, async () => { runs.background++; });
      await command({ module: 'operation_runtime', action: 'generate_report_version', key: 'worker/r1', fingerprint: 'r1' },
        async () => { runs.report++; return 'version'; });
    }
  });
  assert.deepEqual(runs, { background: 2, report: 1 });
});

test('null tombstones saved by older builds leave the local snapshot on the next write', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  let db = localStore(path);
  await db.setup({ email: 'owner@example.test', name: 'Owner', workspaceName: 'Legacy test', passwordHash: 'unused' }, 'unused');
  const [ws] = await commandBackgroundStore(db).workspaces();
  await commandBackgroundStore(db).transact(ws, false, records => {
    for (const key of ['outbox/old', 'consumed/workspace/old', 'job/workspace/old', 'schedule/kept']) records.put(key, { key });
  });
  await db.close();
  // Older builds flushed deleted keys as null values and kept the rows.
  persisted(path, state => {
    for (const [, row] of state.records) if (row.module === 'operation_runtime' && row.kind === 'record' && row.id !== 'schedule/kept') row.data.value = null;
  });
  assert.equal(persistedRowIds(persisted(path)).length, 4);

  db = localStore(path);
  assert.deepEqual(await rowIds(db, ws.id), ['schedule/kept']);
  await commandBackgroundStore(db).transact(ws, false, records => records.put('schedule/kept', { key: 'schedule/kept', run: 2 }));
  assert.deepEqual(await commandBackgroundStore(db).transact(ws, true, records => records.get('schedule/kept')), { key: 'schedule/kept', run: 2 });
  await db.close();
  assert.deepEqual(persistedRowIds(persisted(path)), ['schedule/kept']);
});
