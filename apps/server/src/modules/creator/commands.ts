import { randomUUID } from 'node:crypto';
import { Problem, type Context as OperationContext, type Data, type Operation, type Row } from '@smartsell/contracts';
import { nativeOperationContext } from '../inbox/operations.js';
import { DomainError } from '../types.ts';
import type { Commands, Context, Entity, Fields, Role } from '../types.ts';

const localKinds = ['creator', 'creator_account', 'creator_contact', 'creator_association', 'evaluation', 'evaluation_override', 'collaboration', 'collaboration_terms', 'outreach', 'deliverable', 'deliverable_version', 'deliverable_deadline_change', 'sample_shipment', 'live_session', 'live_clip_reuse', 'affiliate_assignment', 'commission_entry', 'settlement_batch'];
const scopes: Record<string, string> = {
  ...Object.fromEntries(localKinds.map(kind => [kind, 'creator'])),
  campaign: 'campaign', brand: 'workspace', market: 'workspace', product: 'commerce', product_variant: 'commerce',
  order: 'commerce', order_line: 'commerce', refund: 'commerce', store: 'commerce', discount_usage: 'commerce', payment_transaction: 'commerce',
  promotion: 'commerce', short_link: 'traffic', asset: 'asset', asset_version: 'asset', rights_grant: 'asset',
  rights_grant_asset: 'asset', rights_grant_revision: 'asset', platform_post: 'execution', publish_target: 'planning', evidence: 'core', file_object: 'asset',
};
const singular: Record<string, string> = {
  creators: 'creator', 'creator-accounts': 'creator_account', campaigns: 'campaign', collaborations: 'collaboration', terms: 'terms_revision', deliverables: 'deliverable',
  'creator-evaluations': 'evaluation', 'creator-associations': 'creator_association',
  'deliverable-versions': 'deliverable_version', outreach: 'outreach', 'sample-shipments': 'sample_shipment',
  'live-sessions': 'live_session', 'commission-entries': 'commission_entry', 'settlement-batches': 'settlement_batch',
};
const roles = ['owner', 'admin', 'editor', 'reviewer', 'viewer'] as const;

/** Exposes the Creator operations through the workspace command contract with a transactional snapshot. */
async function execute(ctx: Context, operation: Operation, input: Fields) {
  const native = nativeOperationContext(ctx);
  const records = new Map<string, Entity[]>();
  if (!native) await Promise.all(Object.entries(scopes).map(async ([kind, module]) => records.set(kind, await ctx.list(module, kind))));
  const rows = (kind: string) => {
    const all = records.get(kind);
    if (!all) throw new Error(`Unregistered Creator record kind ${kind}`);
    return all;
  };
  const flattened = (row: Entity): Row => ({ ...row.data, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at });
  const lookup = (kind: string, id: string) => {
    const row = rows(kind).find(item => item.id === id);
    if (!row) throw new Problem(404, 'not_found', `${kind} not found`);
    return row;
  };
  const writes: Array<() => Promise<unknown>> = [];
  const adapter: OperationContext = native ?? {
    tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, actorId: ctx.actorId, role: ctx.role, now: ctx.now,
    list: kind => rows(kind).map(flattened), get: (kind, id) => flattened(lookup(kind, id)),
    create(kind, data) {
      if (!localKinds.includes(kind)) throw new Error(`Creator cannot create ${kind} records`);
      const id = typeof data.command_key === 'string' ? data.command_key : randomUUID();
      const row: Entity = { id, module: 'creator', kind, data, version: 1, created_at: ctx.now, updated_at: ctx.now, tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId };
      rows(kind).push(row);
      writes.push(() => ctx.insert('creator', kind, data, id));
      return flattened(row);
    },
    update(kind, id, data) {
      if (!localKinds.includes(kind)) throw new Error(`Creator cannot update ${kind} records`);
      const row = lookup(kind, id);
      const next = { ...row, data: { ...row.data, ...data }, updated_at: ctx.now, version: row.version + 1 };
      rows(kind)[rows(kind).indexOf(row)] = next;
      writes.push(() => ctx.update('creator', kind, id, data, row.version));
      return flattened(next);
    },
    remove(kind) { throw new Error(`Creator cannot delete ${kind} records`); },
    emit(type, data) { writes.push(() => ctx.emit(type, data)); },
  };
  const params: Record<string, string> = {};
  const parts = operation.path.split('/');
  for (const [index, part] of parts.entries()) {
    if (!part.startsWith(':')) continue;
    const field = singular[parts[index - 1]] ?? parts[index - 1];
    const value = input[`${field}_id`] ?? (field === 'terms_revision' ? input.terms_id : undefined) ?? input[part.slice(1)];
    if (typeof value !== 'string' || !value.trim() || value.length > 240) throw new DomainError('invalid_input', `Invalid ${field}_id`);
    params[part.slice(1)] = value.trim();
  }
  const expectedVersion = input.expected_version;
  try {
    if (operation.versionKind && operation.method !== 'GET') {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new DomainError('invalid_input', 'Invalid expected_version');
      if (adapter.get(operation.versionKind, params.id).version !== expectedVersion) throw new DomainError('version_conflict', 'Record changed. Refresh and try again.', 409);
    }
    const query = Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const result = await operation.run(adapter, { body: input as Data, params, query, expectedVersion, idempotencyKey: input.idempotency_key });
    for (const write of writes) await write();
    return result;
  } catch (error) {
    if (error instanceof Problem) throw new DomainError(error.code, error.message, error.status);
    throw error;
  }
}

export function createCommands(operations: readonly Operation[]): Commands {
  return Object.fromEntries(operations.map(operation => [operation.name, {
    roles: roles.filter((role: Role) => operation.roles.includes(role)),
    run: (ctx: Context, input: Fields) => execute(ctx, operation, input),
  }]));
}
