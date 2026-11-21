import { randomUUID } from 'node:crypto';
import { DomainError, type Context, type Entity, type Fields } from '../types.ts';

export function context(workspaceId = 'workspace', rows = new Map<string, Entity>()) {
  const events: { event: string; payload: Fields }[] = [];
  const key = (module: string, kind: string, id: string) => JSON.stringify([workspaceId, module, kind, id]);
  const ctx: Context & { events: typeof events } = {
    tenantId: 'tenant', workspaceId, actorId: 'admin', role: 'admin', now: '2026-10-01T12:00:00.000Z', events,
    async get(module, kind, id) { return structuredClone(rows.get(key(module, kind, id))); },
    async list(module, kind) {
      return structuredClone([...rows.values()].filter(row => row.workspace_id === workspaceId && row.module === module && row.kind === kind));
    },
    async insert(module, kind, data, id = randomUUID() as string) {
      const row = { id, module, kind, data, version: 1, tenant_id: ctx.tenantId, workspace_id: workspaceId, created_at: ctx.now, updated_at: ctx.now };
      if (rows.has(key(module, kind, id))) throw new DomainError('duplicate', 'Duplicate ID', 409);
      rows.set(key(module, kind, id), structuredClone(row));
      return row;
    },
    async update(module, kind, id, patch, expectedVersion) {
      const previous = await ctx.get(module, kind, id);
      if (!previous || previous.version !== expectedVersion) throw new DomainError('version_conflict', 'Version changed', 409);
      const row = { ...previous, data: { ...previous.data, ...patch }, version: previous.version + 1, updated_at: ctx.now };
      rows.set(key(module, kind, id), structuredClone(row));
      return row;
    },
    async emit(event, payload) { events.push({ event, payload }); },
  };
  return ctx;
}
