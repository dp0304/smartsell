import { randomUUID } from 'node:crypto';
import { DomainError, type Context, type Fields, type Role } from './modules/types';
import type { LoginIdentifier } from './setup-policy.js';
import type { SessionUser } from './session-user.js';

export type User = SessionUser;
export type Workspace = { id: string; name: string; role: Role };
export type Scope = { tenantId: string; workspaceId: string; actorId: string; role: Role };
export type Setup = LoginIdentifier & { name: string; workspaceName: string; passwordHash: string };
export type CommandInfo = { module: string; action: string; key: string; fingerprint: string };

export type PublicLocator = 'team.share' | 'traffic.landing_page' | 'traffic.short_link' | 'traffic.workspace' | 'lifecycle.unsubscribe_link';
export type MembershipChange = { memberId: string } & ({ action: 'set_role'; role: Role; scopes?: string[] } | { action: 'remove' });

export interface Unit {
  context: Context;
  brandScopes?: readonly string[];
  issueAgentSession?(tokenHash: string, ttlSeconds: number): Promise<void>;
  command(info: CommandInfo, run: () => Promise<unknown>): Promise<unknown>;
  changeMembership?(change: MembershipChange): Promise<void>;
  listMembers?(): Promise<{ user_id: string; role: Role; scopes?: string[] }[]>;
  listActivePatHolders?(): Promise<{ id: string; actorId: string }[]>;
  inviteMember?(input: { id: string; email: string; role: Role; tokenHash: string }): Promise<void>;
}

export interface Store {
  initialized(): Promise<boolean>;
  setup(input: Setup, tokenHash: string, replace?: string): Promise<boolean>;
  credentials(identifier: LoginIdentifier | string): Promise<{ id: string; passwordHash: string } | undefined>;
  acceptMemberInvitation?(input: { tokenHash: string; email: string; name: string; passwordHash: string }): Promise<boolean>;
  /** ttlSeconds defaults to SESSION_SECONDS. Agent connections pass their own lifetime and no replace hash. */
  issueSession(userId: string, tokenHash: string, replace?: string, ttlSeconds?: number): Promise<void>;
  commandIdentity?<T>(run: (unit: import('./integration/command-identity-state.js').CommandIdentityUnit) => Promise<T>): Promise<T>;
  revokeSession(tokenHash: string): Promise<void>;
  session(tokenHash: string): Promise<{ user: User; workspaces: Workspace[] } | undefined>;
  workspace<T>(tokenHash: string | undefined, workspaceId: string, run: (unit: Unit) => Promise<T>, credentialId?: string): Promise<T>;
  publicWork?<T>(locator: PublicLocator, id: string, run: (unit: Unit) => Promise<T>): Promise<T | undefined>;
  operationWorkspaces?(): Promise<import('./identity.js').Workspace[]>;
  operationWork?<T>(workspaceId: string, run: (unit: Unit, members: { userId: string; role: Role }[]) => Promise<T>): Promise<T>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export const SESSION_SECONDS = 12 * 60 * 60;
export const MAX_SESSION_SECONDS = 365 * 24 * 60 * 60;
export const unauthenticated = () => new DomainError('unauthenticated', 'Sign in required', 401);
export const missingWorkspace = () => new DomainError('not_found', 'Workspace not found', 404);
export const versionConflict = () => new DomainError('version_conflict', 'Record version has changed', 409);
export const duplicateRecord = () => new DomainError('already_exists', 'Record already exists', 409);
export const keyConflict = () => new DomainError('idempotency_conflict', 'Idempotency key was already used for another request', 409);

export function checkVersion(expected: number) {
  if (!Number.isInteger(expected) || expected < 1 || expected > 2_147_483_647) {
    throw new DomainError('invalid_version', 'Expected a positive record version');
  }
}

export function newEntity(scope: Scope, now: string, module: string, kind: string, data: Fields, id = randomUUID() as string) {
  return {
    id, module, kind, data, version: 1, tenant_id: scope.tenantId,
    workspace_id: scope.workspaceId, created_at: now, updated_at: now,
  };
}

export function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
