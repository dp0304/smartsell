import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Problem, type Context, type Data, type Role, type Row } from '@smartsell/contracts';

export type Audience = 'client' | 'creator';
export type Permission = 'view' | 'comment' | 'approve' | 'download' | 'submit';
export interface ResourceRef { resource_type: string; resource_id: string; revision_id: string }
export interface PortalPrincipal { id: string; audience: Audience; verifiedEmail?: string }
export interface Projection {
  current_revision_id: string;
  title: string;
  text: string;
  attachments?: readonly { id: string; name: string }[];
}
export interface Member { id: string; user_id: string; role: Role; scopes: readonly string[] }
export type HandoverItem = { kind: string; id: string };
export interface TeamHost {
  // All hooks use the supplied tenant/workspace transaction. IAM owns seats, acceptance,
  // the last-owner invariant, grant/credential revocation and actual authorization.
  members?: {
    list(ctx: Context): readonly Member[];
    invite(ctx: Context, request: { email: string; role: Role; scopes: string[] }): { invitation_id: string };
    setRole(ctx: Context, member: Member, role: Role, scopes: string[]): void | Promise<void>;
    previewRemoval(ctx: Context, member: Member): readonly HandoverItem[];
    remove(ctx: Context, member: Member): void | Promise<void>;
  };
  work?: {
    workload(ctx: Context): readonly { assignee_id: string; kind: string; blocked: boolean }[];
    forHandover(ctx: Context, from: string): readonly HandoverItem[];
    transfer(ctx: Context, from: string, to: string, items: readonly HandoverItem[]): void;
  };
  authorizeComment?: (ctx: Context, ref: ResourceRef, action: 'read' | 'write' | 'external') => void;
  // Supply only explicitly shareable, revision-specific content. For portal requests recheck
  // availability, rights and audience every time, including for anonymous link access.
  project?: (ctx: Context, ref: ResourceRef, audience: Audience, accessor: PortalPrincipal | 'link' | 'staff') => Projection | undefined;
  checkRecipient?: (ctx: Context, audience: Audience, grantee: string) => boolean;
  acceptPortalInvite?: (ctx: Context, principal: PortalPrincipal, invitationId: string) => void;
  decide?: (ctx: Context, ref: ResourceRef, principal: PortalPrincipal, decision: 'approve' | 'request_changes', reason?: string) => void;
  download?: (ctx: Context, ref: ResourceRef, fileId: string, audience: Audience, principal: PortalPrincipal | 'link', shareId: string) => string;
  submit?: (ctx: Context, ref: ResourceRef, principal: PortalPrincipal, note: string) => void;
  // Template application creates safe defaults and keeps approval policies disabled.
  applyTemplate?: (ctx: Context, template: { kind: string; name: string; defaults: Data }) => { operation_id: string };
  ambassador?: {
    /** Resolve only rights-cleared, revision-pinned material usable by the current actor. */
    material(ctx: Context, ref: ResourceRef): { title: string; text: string; rights_until: string } | undefined;
    /** Optional host verification through an authorized source. */
    verify?(ctx: Context, ref: ResourceRef, publicUrl: string): boolean;
  };
}

export const missing = () => new Problem(404, 'not_found', 'Resource not found');
export const invalid = (field: string) => new Problem(422, 'invalid_input', `Invalid ${field}`);
export const conflict = (message: string) => new Problem(409, 'conflict', message);
export const forbidden = () => new Problem(403, 'forbidden', 'Action is not permitted');
export function requireHost<T>(hook: T | undefined): T {
  if (!hook) throw new Problem(503, 'not_configured', 'Required integration is unavailable');
  return hook;
}
export function row(ctx: Context, kind: string, id: string): Row {
  const value = ctx.list(kind).find(candidate => candidate.id === id);
  if (!value) throw missing();
  return value;
}
export function text(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(field);
  return value.trim();
}
export const identifier = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalid(field);
  return value;
};
export function choice<const T extends string>(value: unknown, field: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw invalid(field);
  return value as T;
}
export function array<T>(value: unknown, field: string, parse: (item: unknown) => T, max = 50): T[] {
  if (!Array.isArray(value) || value.length > max) throw invalid(field);
  return [...new Set(value.map(parse))];
}
export function record(value: unknown, field: string): Data {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(field);
  return value as Data;
}
export function email(value: unknown): string {
  const address = text(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw invalid('email');
  return address;
}
export function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid(field);
  return new Date(value).toISOString();
}
export function expires(ctx: Context, value: unknown, days: number): string {
  const expiry = timestamp(value, 'expires_at');
  const lifetime = Date.parse(expiry) - Date.parse(ctx.now);
  if (lifetime <= 0 || lifetime > days * 86_400_000) throw invalid('expires_at');
  return expiry;
}
export function resource(input: Data): ResourceRef {
  return {
    resource_type: identifier(input.resource_type, 'resource_type'),
    resource_id: identifier(input.resource_id, 'resource_id'),
    revision_id: identifier(input.revision_id, 'revision_id'),
  };
}
export function matches(value: Data, ref: ResourceRef): boolean {
  return value.resource_type === ref.resource_type && value.resource_id === ref.resource_id && value.revision_id === ref.revision_id;
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export function hasToken(value: unknown, token?: string): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !!token && /^[a-zA-Z0-9_-]{43}$/.test(token)
    && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(digest(token), 'hex'));
}
export function shareStatus(ctx: Context, share: Row): 'active' | 'expired' | 'revoked' {
  if (share.status === 'revoked') return 'revoked';
  if (typeof share.expires_at !== 'string' || !(Date.parse(share.expires_at) > Date.parse(ctx.now))) return 'expired';
  return 'active';
}
export function hasPermission(share: Row, permission: Permission): boolean {
  return Array.isArray(share.permissions) && share.permissions.includes(permission);
}
export function shareMetadata(ctx: Context, share: Row) {
  return {
    id: share.id, version: share.version, ...resource(share), audience: share.audience,
    grantee_type: share.grantee_type, grantee_id: share.grantee_id, permissions: share.permissions,
    expires_at: share.expires_at, status: shareStatus(ctx, share),
  };
}
