import { randomUUID } from 'node:crypto';
import { Records } from '@smartsell/db';
import type { BackgroundStore } from '../runtime.js';
import { DomainError, writers, type Context } from '../modules/types.js';
import type { Store } from '../store.js';
import { getRetentionPolicy as getCommandRetentionPolicy } from '../modules/ops/retention-policy.js';
import { operationRecords, operationRow } from './operation-records.js';
import type { Row } from '@smartsell/contracts';

export function commandBackgroundStore(store: Store): BackgroundStore {
  const { operationWorkspaces, operationWork } = store;
  if (!operationWorkspaces || !operationWork) throw new Error('Operation background storage is unavailable');
  // The memory and local stores read without the write lock; Postgres takes its workspace lock for the one-row read only.
  const read = store.operationRead ?? operationWork;
  return {
    workspaces: () => operationWorkspaces.call(store),
    // S5: one Operation row by key, without loading the snapshot.
    peek: <T>(ws: { id: string }, run: (get: (kind: string, id: string) => Promise<Row | undefined>) => T | Promise<T>) =>
      read.call(store, ws.id, async ({ context }) => run((kind, id) => operationRow<Row>(context, kind, id))) as Promise<T>,
    transact: (ws, readOnly, run) => store.operationWork!(ws.id, async ({ context, command, listActivePatHolders }, members) => {
      const { records, flush } = await operationRecords(context, readOnly);
      const identity = new Records(new Map(), false);
      identity.put(`workspace/${ws.id}`, ws);
      for (const member of members) identity.put(`member/${member.userId}/${ws.id}`, { ...member, workspaceId: ws.id });
      const holders = listActivePatHolders ? await listActivePatHolders() :
        (await context.list('mcp_runtime', 'credential'))
          .filter(({ data }) => data.revoked !== true && data.workspace_removed !== true && data.expires > Date.now())
          .map(({ id, data }) => ({ id, actorId: data.actor_id }));
      for (const { id, actorId } of holders) {
        identity.put(`command-credential/${id}`, { actorId, workspaceId: ws.id });
      }
      const scope = {
        tenantId: context.tenantId, workspaceId: context.workspaceId, actorId: context.actorId,
        async runCommandReport<T>(id: string, actorId: string, run: (ctx: Context) => Promise<T>) {
          const member = members.find(member => member.userId === actorId);
          if (!member || !writers.includes(member.role)) throw new DomainError('forbidden', 'Report generation access denied', 403);
          return await command({ module: 'operation_runtime', action: 'generate_report_version', key: `worker/${id}`, fingerprint: id },
            () => run({ ...context, actorId, role: member.role })) as T;
        },
        async backgroundRetentionDays(dataClass: string) {
          if (dataClass !== 'store_pii_amazon') return;
          const policy = await getCommandRetentionPolicy(context, dataClass);
          if (typeof policy?.retain_days === 'number') return policy.retain_days;
        },
      };
      const result = await run(records, scope, identity);
      if (records.changes.size) await command({ module: 'operation_runtime', action: 'background', key: `background/${randomUUID()}`, fingerprint: '' }, flush);
      return result;
    }),
  };
}
