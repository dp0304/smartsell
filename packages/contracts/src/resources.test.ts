import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crud, Problem, type Context, type Data, type Input, type Row } from './index.js';

const now = '2026-01-01T00:00:00.000Z';
const row: Row = { id: 'r1', created_at: now, updated_at: now, version: 1, name: 'Before', status: 'active' };
const input: Input = { body: {}, query: {}, params: { id: row.id } };
const [list, get, create, update] = crud({
  kind: 'brand', path: '/brands', name: 'brand', required: ['name'], writable: ['status'], initial: { status: 'active' },
});

function fixture() {
  const events: Array<{ type: string; data: Data }> = [];
  const ctx: Context = {
    workspaceId: 'w1', tenantId: 't1', actorId: 'u1', role: 'owner', now,
    list: () => [row], get: () => row,
    create: (_kind, values) => ({ ...row, ...values }),
    update: (_kind, _id, values) => ({ ...row, ...values, version: 2 }),
    remove: () => { throw new Error('Unexpected removal'); },
    emit: (type, data) => events.push({ type, data }),
  };
  return { ctx, events };
}

test('resource operations expose flat rows and filter declared list fields', () => {
  const { ctx } = fixture();
  assert.deepEqual(list.run(ctx, { ...input, query: { status: 'active' } }), [row]);
  assert.deepEqual(list.run(ctx, { ...input, query: { status: 'archived' } }), []);
  assert.deepEqual(get.run(ctx, input), row);
});

test('resource writes reject server-owned fields and emit successful mutations only', () => {
  const { ctx, events } = fixture();
  assert.throws(() => create.run(ctx, { ...input, body: { name: 'Brand', version: 99 } }), Problem);
  assert.throws(() => create.run(ctx, { ...input, body: { name: '  ' } }), Problem);
  assert.throws(() => update.run(ctx, input), Problem);
  assert.deepEqual(events, []);
  assert.deepEqual(create.run(ctx, { ...input, body: { name: ' Brand ' } }), { ...row, name: 'Brand' });
  assert.equal(update.versionKind, 'brand');
  assert.deepEqual(update.run(ctx, { ...input, body: { status: 'archived' } }), { ...row, status: 'archived', version: 2 });
  assert.deepEqual(events, [
    { type: 'brand.created', data: { id: 'r1', version: 1 } },
    { type: 'brand.updated', data: { id: 'r1', version: 2 } },
  ]);
});
