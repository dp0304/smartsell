import { Problem, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';

export function testWorkspace(operations: Operation[]) {
  const records = new Map<string, Row[]>();
  const events: {type: string; data: Data}[] = [];
  let sequence = 0;
  const ctx: Context = {
    workspaceId: 'w', tenantId: 't', actorId: 'author', role: 'owner', now: '2026-11-19T12:00:00.000Z',
    list: kind => records.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(row => row.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Record unavailable');
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: String(++sequence), version: 1, created_at: ctx.now, updated_at: ctx.now };
      records.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, values) {
      const old = ctx.get(kind, id);
      const row = { ...old, ...values, id, version: old.version + 1, updated_at: ctx.now };
      records.set(kind, ctx.list(kind).map(r => r.id === id ? row : r));
      return row;
    },
    remove(kind, id) { records.set(kind, ctx.list(kind).filter(r => r.id !== id)); },
    emit(type, data) { events.push({type, data}); },
  };
  function call<T = Row>(name: string, body: Data = {}, id?: string, query: Record<string,string> = {}, idempotencyKey?: string): T {
    const operation = operations.find(op => op.name === name);
    if (!operation) throw new Error(`Missing operation ${name}`);
    if (!operation.roles.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Role forbidden');
    const original = new Map(records);
    const count = events.length;
    try { return operation.run(ctx, { body, params: id ? { id } : {}, query, idempotencyKey }) as T; }
    catch (error) {
      records.clear();
      for (const [k,v] of original) records.set(k,v);
      events.length = count;
      throw error;
    }
  }
  return { ctx, call, events };
}
