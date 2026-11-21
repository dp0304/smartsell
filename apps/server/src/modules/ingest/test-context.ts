import { DomainError, type Commands, type Context, type Entity, type Fields, type Role } from '../types.js';

/** Runs the public command contract with workspace-scoped, atomic in-memory writes. */
export function testWorkspace() {
  let records = new Map<string, Entity>();
  let events: { event: string; payload: Fields; workspaceId: string }[] = [];
  let nextId = 0;
  let pending = Promise.resolve();
  const key = (workspaceId: string, module: string, kind: string, id: string) => JSON.stringify([workspaceId, module, kind, id]);

  function run<T = any>(commands: Commands, action: string, input: Fields = {}, options: {
    role?: Role; actorId?: string; now?: string; workspaceId?: string;
    beforeWrite?: (module: string, kind: string) => void;
  } = {}): Promise<T> {
    const result = pending.then(async () => {
      const { role = 'owner', actorId = 'owner-1', now = '2026-11-19T12:00:00.000Z', workspaceId = 'workspace-1', beforeWrite } = options;
      const tenantId = 'tenant-1';
      const command = commands[action];
      if (!Object.hasOwn(commands, action) || !command) throw new DomainError('not_found', 'Command not found', 404);
      if (!command.roles.includes(role)) throw new DomainError('forbidden', 'Command is not available for this role', 403);
      const working = new Map(records);
      const emitted: typeof events = [];
      const ctx: Context = {
        tenantId, workspaceId, actorId, now, role,
        async get(module, kind, id) {
          return structuredClone(working.get(key(workspaceId, module, kind, id)));
        },
        async list(module, kind) {
          return structuredClone([...working.values()].filter(row => row.workspace_id === workspaceId && row.module === module && row.kind === kind));
        },
        async insert(module, kind, data, id = `record-${++nextId}`) {
          beforeWrite?.(module, kind);
          const rowKey = key(workspaceId, module, kind, id);
          if (working.has(rowKey)) throw new DomainError('conflict', 'Record already exists', 409);
          const row: Entity = { id, module, kind, data: structuredClone(data), version: 1, created_at: now, updated_at: now, tenant_id: tenantId, workspace_id: workspaceId };
          working.set(rowKey, row);
          return structuredClone(row);
        },
        async update(module, kind, id, patch, expectedVersion) {
          beforeWrite?.(module, kind);
          const rowKey = key(workspaceId, module, kind, id);
          const current = working.get(rowKey);
          if (!current) throw new DomainError('not_found', 'Record not found', 404);
          if (current.version !== expectedVersion) throw new DomainError('conflict', 'Version conflict', 409);
          const updated = { ...current, version: current.version + 1, updated_at: now, data: { ...current.data, ...structuredClone(patch) } };
          working.set(rowKey, updated);
          return structuredClone(updated);
        },
        async emit(event, payload) {
          emitted.push({ event, payload: structuredClone(payload), workspaceId });
        },
      };
      const output = await command.run(ctx, input);
      records = working;
      events = [...events, ...emitted];
      return output as T;
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    run,
    list(module: string, kind: string, workspaceId = 'workspace-1') {
      return structuredClone([...records.values()].filter(row => row.workspace_id === workspaceId && row.module === module && row.kind === kind));
    },
    events(workspaceId = 'workspace-1') {
      return structuredClone(events.filter(event => event.workspaceId === workspaceId));
    },
  };
}
