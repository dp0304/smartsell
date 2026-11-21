import assert from 'node:assert/strict';
import { Problem, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';

export function workspaceFixture(operations: Operation[]) {
  let sequence = 0;
  const rows = new Map<string, Map<string, Row>>();
  const events: { type: string; data: Data }[] = [];
  const table = (kind: string) => {
    if (!rows.has(kind)) rows.set(kind, new Map());
    return rows.get(kind)!;
  };
  const seed = (kind: string, values: Data, id = `row-${++sequence}`) => {
    const row = { ...values, id, version: 1, created_at: ctx.now, updated_at: ctx.now };
    table(kind).set(row.id, row);
    return row;
  };
  const ctx: Context = {
    tenantId: 'tenant', workspaceId: 'workspace', actorId: 'manager', role: 'manager', now: '2026-11-19T12:00:00.000Z',
    list: kind => [...table(kind).values()],
    get(kind, id) {
      const row = table(kind).get(id);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind} not found`);
      return row;
    },
    create: seed,
    update(kind, id, values) {
      const old = ctx.get(kind, id);
      const row = { ...old, ...values, id, version: old.version + 1, updated_at: ctx.now };
      table(kind).set(id, row);
      return row;
    },
    remove(kind, id) { table(kind).delete(id); },
    emit(type, data) { events.push({ type, data }); },
  };
  return { ctx, events, seed, async run<T = Row>(name: string, body: Data = {}, input: Partial<Input> = {}): Promise<T> {
    const operation = operations.find(op => op.name === name);
    assert.ok(operation, name);
    if (!operation.roles.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Role cannot perform operation');
    if (operation.versionKind) {
      const row = ctx.get(operation.versionKind, input.params?.id ?? '');
      if (row.version !== input.expectedVersion) throw new Problem(409, 'VERSION_CONFLICT', 'Version changed');
    }
    const snapshot = new Map([...rows].map(([kind, table]) => [kind, new Map(table)]));
    const eventCount = events.length;
    try { return await operation.run(ctx, { body, params: {}, query: {}, ...input }) as T; }
    catch (error) {
      rows.clear();
      for (const [kind, table] of snapshot) rows.set(kind, table);
      events.length = eventCount;
      throw error;
    }
  } };
}

export const at = (row: Row): Partial<Input> => ({ params: { id: row.id }, expectedVersion: row.version });
export const byId = (id: string): Partial<Input> => ({ params: { id } });
