import { Records } from '@smartsell/db';
import type { Context, Entity } from '../modules/types.js';

const moduleName = 'operation_runtime';
const recordKind = 'record';
const revisionKind = 'revision';

export async function operationRow<T>(context: Context, kind: string, id: string): Promise<T | undefined> {
  const entity = await context.get(moduleName, recordKind, `row/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
  if (typeof entity?.data.value === 'string') return JSON.parse(entity.data.value) as T;
}

export async function operationRevision(context: Context) {
  return (await context.get(moduleName, revisionKind, context.workspaceId))?.version ?? 0;
}

/** Present the synchronous Operation snapshot inside an already authorized Command transaction. */
export async function operationRecords(context: Context, readOnly: boolean) {
  if (!readOnly) await context.lockOperationRecords?.();
  // Read the revision before loading records so concurrent writers cannot commit from stale snapshots.
  const revision = readOnly ? undefined : await context.get(moduleName, revisionKind, context.workspaceId);
  const entities = new Map<string, Entity>();
  const values = new Map<string, string>();
  for (const entity of await context.list(moduleName, recordKind)) {
    entities.set(entity.id, entity);
    if (typeof entity.data.value === 'string') values.set(entity.id, entity.data.value);
  }
  const records = new Records(values, readOnly);
  return {
    records,
    async flush() {
      if (!records.changes.size) return;
      if (revision) {
        await context.update(moduleName, revisionKind, revision.id, {}, revision.version);
      } else {
        await context.insert(moduleName, revisionKind, {}, context.workspaceId);
      }
      for (const [key, value] of records.changes) {
        const entity = entities.get(key);
        // The Command store permits versioned updates but no deletes. Null is absent in the Operation snapshot.
        if (entity) await context.update(moduleName, recordKind, entity.id, { value }, entity.version);
        else if (value !== null) await context.insert(moduleName, recordKind, { value }, key);
      }
    },
  };
}
