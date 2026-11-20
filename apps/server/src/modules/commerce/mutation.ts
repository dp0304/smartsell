import type { Context, Entity, Fields } from '../types';
import { active, insert, list, same, update } from './model';
import type { MutationView } from './snapshots';
import { handleContentEvent } from '../content/revisions.js';

export interface Write { kind: string; id: string; before?: Entity; patch: Fields }
export interface Journal { kind: string; id: string; before: Fields | null; committed_version: number }

export async function mutations(ctx: Context, kinds: readonly string[], storeId: string) {
  const tables = new Map(await Promise.all(kinds.map(async kind => [kind, new Map((await list(ctx, kind)).filter(row => row.data.store_id === storeId).map(row => [row.id, row]))] as const)));
  const pending = new Map<string, Write>();
  const events: [string, Fields][] = [];
  const view = {
    rows: (kind: string) => [...(tables.get(kind)?.values() ?? [])].filter(active),
    get: (kind: string, id: string) => tables.get(kind)?.get(id),
    put(kind: string, id: string, patch: Fields): Entity {
      const key = `${kind}:${id}`;
      const current = view.get(kind, id);
      if (current && same(current.data, patch)) return current;
      const write = pending.get(key);
      const next = { id, module: 'commerce', kind, data: { ...current?.data, ...patch }, version: current?.version ?? 0, created_at: current?.created_at ?? ctx.now, updated_at: ctx.now, tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId };
      pending.set(key, { kind, id, before: write ? write.before : current, patch: { ...write?.patch, ...patch } });
      const table = tables.get(kind) ?? new Map<string, Entity>();
      table.set(id, next);
      tables.set(kind, table);
      return next;
    },
    event(event: string, payload: Fields) { events.push([event, payload]); },
    writes: () => [...pending.values()],
    async persist() {
      const journal: Journal[] = [];
      for (const write of pending.values()) {
        const committed = write.before ? await update(ctx, write.before, write.patch) : await insert(ctx, write.kind, write.patch, write.id);
        const before = write.before ? Object.fromEntries(Object.keys(write.patch).map(key => [key, write.before!.data[key] ?? null])) : null;
        journal.push({ kind: write.kind, id: write.id, before, committed_version: committed.version });
      }
      for (const [event, payload] of events) {
        await ctx.emit(event, payload);
        if (event === 'commerce.listing.changed') await handleContentEvent(ctx, event, payload);
      }
      return journal;
    },
  } satisfies MutationView & Record<string, unknown>;
  return view;
}
