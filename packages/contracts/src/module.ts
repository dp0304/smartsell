/** Shared in-process contract for workspace application services, REST and MCP. */
export type Data = Record<string, unknown>;
export interface Row extends Data {
  id: string;
  version: number;
  created_at: string;
  updated_at: string;
}
export type Role = 'owner' | 'admin' | 'manager' | 'editor' | 'reviewer' | 'analyst' | 'viewer' | 'agent';
/** Each invocation sees one scoped, transactional snapshot. Changes roll back on an error. */
export interface Context {
  workspaceId: string;
  tenantId: string;
  actorId: string;
  role: Role;
  now: string;
  list(kind: string): Row[];
  get(kind: string, id: string): Row;
  create(kind: string, values: Data): Row;
  update(kind: string, id: string, values: Data): Row;
  remove(kind: string, id: string): void;
  emit(type: string, data: Data): void;
}
export class Problem extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Data) {
    super(message);
    this.name = 'Problem';
  }
}
export interface Input {
  body: Data;
  params: Record<string, string>;
  query: Record<string, string>;
  expectedVersion?: number;
  idempotencyKey?: string;
}
export interface Operation {
  /** Full workspace-relative path, starting with '/'. Use ':id' for named path parameters. */
  path: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Stable MCP name matching the design, e.g. content_create_draft. */
  name: string;
  roles: readonly Role[];
  summary: string;
  /** If set, server requires If-Match against this kind's :id before executing. */
  versionKind?: string;
  external?: boolean;
  /** The operation durably accepts asynchronous work. */
  accepted?: boolean | ((result: unknown) => boolean);
  /** Wire schema from a shared contract or resource factory. */
  contract?: {
    body?: Record<string, unknown>;
    bodyRequired?: boolean;
    output?: Record<string, unknown>;
    query?: readonly string[];
  };
  /** Apply operation-specific resource visibility before version checks and replay. */
  scopeContext?(ctx: Context, input: Input): Context;
  /** Supply ordered rows for shared REST pagination when the operation has a legacy result shape. */
  listForRest?(ctx: Context, input: Input): Row[] | Promise<Row[]>;
  /** Return a resource (Row), list of resources (Row[]), or a query/action result object. */
  run(ctx: Context, input: Input): unknown | Promise<unknown>;
}
export const READ: readonly Role[] = ['owner','admin','manager','editor','reviewer','analyst','viewer','agent'];
export const WRITE: readonly Role[] = ['owner','admin','manager','editor','agent'];
export const APPROVE: readonly Role[] = ['owner','admin','manager','reviewer'];
export const ADMIN: readonly Role[] = ['owner','admin'];
