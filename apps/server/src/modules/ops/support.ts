import { ADMIN, Problem, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';

export type Store = Pick<Context, 'list' | 'get' | 'create' | 'update' | 'remove'>;

export interface BackupManifest {
  consistent_at: string;
  db_snapshot_ref: string;
  storage_manifest_ref: string;
  config_ref: string;
}

export interface RestoreCandidate {
  domain: string;
  resource_type: string;
  resource_id: string;
  db_state: string;
}

export type Reconciliation =
  | { state: 'present'; evidence_id: string }
  | { state: 'absent'; approved: boolean; within_window: boolean }
  | { state: 'unknown' };

export interface JobSelector {
  queue: string;
  provider?: string;
  task_kind?: string;
  side_effect?: boolean;
}

/** Trusted host hooks. Scope is supplied by the authenticated transaction, never by request input. */
export interface OpsServices {
  deploymentMode?: 'private' | 'saas';
  health?(): { db: 'ok' | 'degraded' | 'down'; storage: 'ok' | 'degraded' | 'down'; queue_lag_s?: number };
  setConnectorAutoHalt?(scope: { rule_id: string; workspace_ids: readonly string[] | 'all'; halted: boolean; reason: string; actor: string }): void;
  members?(ctx: Context): Row[];
  disableMember?(ctx: Context, memberId: string): void;
  credentials?(ctx: Context): Row[];
  revokeCredential?(ctx: Context, secretId: string): void;
  retentionReferences?(ctx: Context, kind: string, record: Row): readonly string[];
  applyRetention?(ctx: Context, kind: string, record: Row, action: string): void;
  exportData?(ctx: Context, selection: string): Data;
  createBackup?(ctx: Context, policy: Row, runId: string): BackupManifest;
  verifyBackup?(ctx: Context, backup: Row): boolean;
  /** Idempotent by run ID. The control-plane restore record and pause must survive the restore. */
  restoreBackup?(ctx: Context, backup: Row, runId: string): void;
  restoreCandidates?(ctx: Context, since: string): readonly RestoreCandidate[];
  reconcile?(ctx: Context, item: Row): Reconciliation;
  applyReconciliation?(ctx: Context, item: Row, decision: 'adopt_external' | 'keep_cancelled' | 'requeue' | 'manual'): void;
  probeCallback?(ctx: Context, endpoint: Row): boolean;
  webhookSigningKey?(ctx: Context, secretId: string): string | Uint8Array | Promise<string | Uint8Array>;
  /** Development policy for explicitly configured literal loopback target URLs. */
  allowLoopbackWebhook?(ctx: Context, url: string, secretId: string): boolean;
  /** Transport must enforce deployment networking policy and block redirects to disallowed destinations. */
  sendWebhook?(ctx: Context, request: { url: string; headers: Record<string, string>; body: string }): { status: number } | Promise<{ status: number }>;
  upgradePreflight?(ctx: Context, release: Row): { migration_ok: boolean; connector_compat_ok: boolean; outstanding_side_effects: number };
  offlineLicense?: { publicKey: string; installFingerprint: string };
}

export interface OpsContext extends Context {
  /** Transactional store shared by all workspaces in this tenant. */
  tenantScope?: Store;
  /** Authenticated tenant membership, distinct from workspace role. */
  tenantRole?: Context['role'];
  opsServices?: OpsServices;
  assetFileRetention?: {
    candidates(ctx: Context): { id: string; version: number; blocked_by: string[] }[];
    purge(ctx: Context, files: readonly { id: string; version: number }[]): { deleted: string[]; skipped: string[] };
  };
}

export const services = (ctx: Context): OpsServices => (ctx as OpsContext).opsServices ?? {};
export const tenantScope = (ctx: Context): Store | undefined => (ctx as OpsContext).tenantScope;

export function tenantStore(ctx: Context): Store {
  return tenantScope(ctx) ?? unavailable('tenant_scope');
}

export function unavailable(capability: string): never {
  throw new Problem(503, 'ops_capability_unavailable', 'Required operations service is unavailable', { capability });
}

export function invalid(message: string): never { throw new Problem(422, 'invalid_input', message); }
export function conflict(code: string, message: string): never { throw new Problem(409, code, message); }
export function forbidden(): never { throw new Problem(403, 'forbidden', 'Insufficient operations permissions'); }
export function requireTenantAdmin(ctx: Context, roles = ADMIN): void {
  const role = (ctx as OpsContext).tenantRole;
  if (!role || !roles.includes(role)) forbidden();
}

export function object(value: unknown, field: string): Data {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Data;
}

export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) invalid(`${field} must be nonempty text`);
  return value.trim();
}

export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`);
  return value;
}

export function integer(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function choice<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) invalid(`Invalid ${field}`);
  return value as T;
}

export function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 1000) invalid(`${field} must be an array`);
  return [...new Set(value.map(item => text(item, field)))];
}

export function instant(value: unknown, field: string): string {
  const timestamp = Date.parse(text(value, field));
  if (!Number.isFinite(timestamp)) invalid(`${field} must be a timestamp`);
  return new Date(timestamp).toISOString();
}

export function future(value: unknown, ctx: Context, field: string): string {
  const timestamp = instant(value, field);
  if (Date.parse(timestamp) <= Date.parse(ctx.now)) invalid(`${field} must be in the future`);
  return timestamp;
}

export function upsert(store: Store, kind: string, key: Data, values: Data): Row {
  const row = store.list(kind).find(item => Object.entries(key).every(([field, value]) => item[field] === value));
  return row ? store.update(kind, row.id, values) : store.create(kind, { ...key, ...values });
}

export function audit(ctx: Context, action: string, resourceType: string, resourceId: string, details: Data = {}): void {
  ctx.create('audit_event', { action, resource_type: resourceType, resource_id: resourceId, actor_id: ctx.actorId, details });
}

export function change(ctx: Context, action: string, kind: string, row: Row, details: Data = {}): Row {
  audit(ctx, action, kind, row.id, details);
  ctx.emit(action, { ...details, resource_id: row.id, actor: ctx.actorId });
  return row;
}

export type OpsOperation = Operation & { readonly mcp: boolean };

export function operation(method: Operation['method'], path: string, name: string, summary: string,
  run: Operation['run'], options: Partial<Pick<Operation, 'roles' | 'versionKind' | 'external'>> & { mcp?: boolean } = {}): OpsOperation {
  const roles = options.roles ?? ADMIN;
  return { path: `/admin${path}`, method, name, summary, ...options, roles, mcp: options.mcp ?? false,
    run(ctx, input) {
      if (!roles.includes(ctx.role)) forbidden();
      if (!options.mcp && tenantScope(ctx)) requireTenantAdmin(ctx, roles);
      return run(ctx, input);
    } };
}

const secretField = /password|passwd|token|secret|credential|authorization|api.?key|private.?key|cookie|signature/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, secretField.test(key) ? '[redacted]' : redact(item)]));
  return value;
}
