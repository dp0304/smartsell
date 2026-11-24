/** Workspace-scoped command contract. A unit of work, its events and its idempotent response commit together. */
export type Fields = Record<string, any>;
export type Role = 'owner' | 'admin' | 'editor' | 'reviewer' | 'viewer';
export interface Entity {
  id: string; module: string; kind: string; data: Fields; version: number;
  tenant_id: string; workspace_id: string; created_at: string; updated_at: string;
}
export interface Context {
  tenantId: string; workspaceId: string; actorId: string; role: Role; now: string;
  /** The workspace name the store knows without an identity record (the local/memory store's setup name). Optional. */
  workspaceName?: string;
  lockOperationRecords?(): Promise<void>;
  get(module: string, kind: string, id: string): Promise<Entity | undefined>;
  list(module: string, kind: string): Promise<Entity[]>;
  insert(module: string, kind: string, data: Fields, id?: string): Promise<Entity>;
  update(module: string, kind: string, id: string, patch: Fields, expectedVersion: number): Promise<Entity>;
  emit(event: string, payload: Fields): Promise<void>;
}
export interface Command {
  roles: readonly Role[];
  accepted?: boolean;
  run(ctx: Context, input: Fields): Promise<unknown>;
}
export type Commands = Record<string, Command>;
export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); this.name = 'DomainError'; }
}
export const writers: Role[] = ['owner','admin','editor'];
export const reviewers: Role[] = ['owner','admin','reviewer'];
export const admins: Role[] = ['owner','admin'];
export const readers: Role[] = [...writers,'reviewer','viewer'];
export function text(input: Fields, key: string, max = 4096): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new DomainError('invalid_input', `Invalid ${key}`);
  return value.trim();
}
export async function required(ctx: Context, module: string, kind: string, id: string): Promise<Entity> {
  const row = await ctx.get(module, kind, id);
  if (!row) throw new DomainError('not_found', `${module}.${kind} not found`, 404);
  return row;
}
