import { DomainError, text, type Context, type Entity, type Fields, type Role } from '../types.js';

export const ops = 'ops';
type Records = Pick<Context, 'get' | 'list' | 'insert' | 'update'>;

export interface OpsContext extends Context {
  /** Tenant-wide access provided by the host in the same transaction as ctx. */
  opsTenantStore?: Records;
  /** Set only by trusted host after checking the actor's tenant-level role. */
  opsTenantRole?: 'owner' | 'admin';
  /** Applies the account-owned projection for all affected workspaces in the same transaction. */
  opsProjectConnectorHalt?: (scope: string, ruleId: string, stopped: boolean, reason: string) => Promise<void>;
  opsUsageLimit?: (meterKey: string, at: string) => Promise<number | undefined>;
}

export const capabilities = (ctx: Context) => ctx as OpsContext;
export const invalid = (message: string): never => { throw new DomainError('invalid_input', message); };

export function tenantAdmin(ctx: Context): Records {
  if (!capabilities(ctx).opsTenantRole) throw new DomainError('forbidden', 'Tenant administrator required', 403);
  const store = capabilities(ctx).opsTenantStore;
  if (!store) throw new DomainError('ops_capability_unavailable', 'Tenant operations store unavailable', 503);
  return store;
}

export function command(roles: readonly Role[], run: (ctx: Context, input: Fields) => Promise<unknown>) {
  return { roles, async run(ctx: Context, input: Fields) {
    if (!roles.includes(ctx.role)) throw new DomainError('forbidden', 'Access denied', 403);
    return run(ctx, object(input, 'input'));
  } };
}

export function object(value: unknown, field: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(`Invalid ${field}`);
  return value as Fields;
}

export function choice<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (!options.includes(value as T)) return invalid(`Invalid ${field}`);
  return value as T;
}

export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(`Invalid ${field}`);
  return value;
}

export function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return invalid(`Invalid ${field}`);
  return value;
}

/** Restrict commands to the current workspace or a tenant default. */
export function policyScope(ctx: Context, input: Fields): string | null {
  if (input.workspace_id === 'default' || input.workspace_id === null) return null;
  if (input.workspace_id === undefined || input.workspace_id === ctx.workspaceId) return ctx.workspaceId;
  throw new DomainError('not_found', 'Workspace not found', 404);
}

export function policyId(workspaceId: string | null, suffix = ''): string {
  return `${workspaceId === null ? 'default' : 'workspace'}${suffix ? `:${suffix}` : ''}`;
}

export async function tenantDefault(ctx: Context, kind: string, id = 'default') {
  const row = await capabilities(ctx).opsTenantStore?.get(ops, kind, id);
  return row?.tenant_id === ctx.tenantId && row.data.workspace_id === null ? row : undefined;
}

export async function save(store: Records, kind: string, id: string, data: Fields, expected?: unknown) {
  const row = await store.get(ops, kind, id);
  if (expected !== undefined && integer(expected, 'version', 0, 2_147_483_647) !== (row?.version ?? 0)) {
    throw new DomainError('version_conflict', 'Record version has changed', 409);
  }
  return row ? store.update(ops, kind, id, data, row.version) : store.insert(ops, kind, data, id);
}

export async function changed(ctx: Context, event: string, row: Entity, details: Fields = {}) {
  const payload = { ...details, resource_id: row.id, actor: ctx.actorId };
  await ctx.insert(ops, 'audit_event', { ...payload, action: event, resource_type: row.kind, occurred_at: ctx.now });
  await ctx.emit(event, payload);
  return row;
}

export function reason(input: Fields): string { return text(input, 'reason', 500); }
