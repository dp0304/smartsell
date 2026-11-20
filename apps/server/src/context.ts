import { randomUUID } from 'node:crypto';
import type { Context, Data, Role, Row } from '@smartsell/contracts';
import type { Records, Scope } from '@smartsell/db';
import { missing } from './identity.js';

export interface DomainEvent {
  id: string;
  type: string;
  payload: Data;
  occurred_at: string;
  actor_id: string;
  trace_id?: string;
  dispatched_at?: string;
}

export function makeContext(records: Pick<Records, 'get' | 'list' | 'put' | 'delete'>, scope: Scope, role: Role, traceId?: string): Context {
  const now = new Date().toISOString();
  const prefix = (kind: string) => `row/${encodeURIComponent(kind)}/`;
  const key = (kind: string, id: string) => `${prefix(kind)}${encodeURIComponent(id)}`;
  const get = (kind: string, id: string) => {
    const row = records.get<Row>(key(kind, id));
    if (!row) throw missing();
    return row;
  };
  return {
    ...scope, now, role,
    list: kind => records.list<Row>(prefix(kind)),
    get,
    create(kind, values) {
      const row: Row = { ...values, id: randomUUID(), version: 1, created_at: now, updated_at: now };
      records.put(key(kind, row.id), row);
      return row;
    },
    update(kind, id, values) {
      const old = get(kind, id);
      const row: Row = { ...old, ...values, id, version: old.version + 1, created_at: old.created_at, updated_at: now };
      records.put(key(kind, id), row);
      return row;
    },
    remove(kind, id) {
      get(kind, id);
      records.delete(key(kind, id));
    },
    emit(type, payload) {
      const id = randomUUID();
      records.put('stream/revision', (records.get<number>('stream/revision') ?? 0) + 1);
      records.put(`outbox/${id}`, { id, type, payload, occurred_at: now, actor_id: scope.actorId, trace_id: traceId } satisfies DomainEvent);
    },
  };
}
