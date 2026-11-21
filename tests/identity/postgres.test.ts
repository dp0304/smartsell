import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { opaque, PostgresIdentityState } from '../../packages/identity/src/index.ts';

const database = process.env.IDENTITY_TEST_DATABASE_URL;
const requireDb = createRequire(new URL('../../packages/db/package.json', import.meta.url));

test('PostgreSQL identity state serializes races and enforces flow expiry and binding', { skip: !database }, async t => {
  const { Pool } = requireDb('pg') as typeof import('../../packages/db/node_modules/@types/pg');
  const pool = new Pool({ connectionString: database });
  t.after(() => pool.end());
  await pool.query(readFileSync(new URL('../../packages/identity/schema.sql', import.meta.url), 'utf8'));
  const state = new PostgresIdentityState(pool);
  const factor = `test:${opaque()}`;
  assert.equal(await state.compareAndSwap(factor, null, { lastStep: 1 }), true);
  const row = await state.read<{ lastStep: number }>(factor);
  assert.ok(row);
  assert.equal(row.value.lastStep, 1);
  const swaps = await Promise.all([2, 3].map(lastStep => state.compareAndSwap(factor, row.version, { lastStep })));
  assert.equal(swaps.filter(Boolean).length, 1);
  const flow = `test:${opaque()}`;
  await state.putFlow(flow, 'browser', Date.now() + 60_000, { verified: true });
  assert.equal(await state.takeFlow(flow, 'other'), null);
  const takes = await Promise.all([state.takeFlow(flow, 'browser'), state.takeFlow(flow, 'browser')]);
  assert.equal(takes.filter(Boolean).length, 1);
  await state.putFlow(flow, 'browser', Date.now() - 1, {});
  assert.equal(await state.takeFlow(flow, 'browser'), null);
  await state.purgeExpiredFlows();
  assert.equal((await pool.query('SELECT 1 FROM ss_identity.flow WHERE key=$1', [flow])).rowCount, 0);
});
