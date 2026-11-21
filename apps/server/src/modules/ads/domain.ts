import { createHash } from 'node:crypto';
import { DomainError, required, text, type Command, type Context, type Entity, type Fields, type Role } from '../types.js';

export const admin = ['owner', 'admin'] as const;
export const draft = ['owner', 'admin', 'editor'] as const;
export const review = ['owner', 'admin', 'reviewer'] as const;
export const read = ['owner', 'admin', 'editor', 'reviewer', 'viewer'] as const;
export const accountActions = ['read', 'draft', 'review', 'approve', 'execute', 'spend', 'reconcile', 'export'] as const;
type AccountAction = typeof accountActions[number];
export const operationKinds = ['create_external_draft', 'launch', 'pause', 'resume', 'update_budget', 'update_creative'] as const;
export const ads = 'ads';

export function fail(code: string, message: string, status = 422): never {
  throw new DomainError(code, message, status);
}
export function check(condition: unknown, code: string, message: string, status = 422): asserts condition {
  if (!condition) fail(code, message, status);
}
export function cmd(roles: readonly Role[], run: Command['run']): Command {
  return { roles, async run(ctx, input) {
    check(roles.includes(ctx.role), 'forbidden', 'Workspace role cannot run this command', 403);
    return run(ctx, obj(input, 'input'));
  } };
}
export function obj(value: unknown, key: string): Fields {
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid_input', `Invalid ${key}`);
  return value as Fields;
}
export function optional(input: Fields, key: string, max = 500): string | null {
  return input[key] == null ? null : text(input, key, max);
}
export function oneOf<T extends string>(value: unknown, choices: readonly T[], key: string): T {
  check(typeof value === 'string' && choices.includes(value as T), 'invalid_input', `Invalid ${key}`);
  return value as T;
}
export function integer(value: unknown, key: string, min = 0): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= min, 'invalid_input', `Invalid ${key}`);
  return value;
}
export function refs(value: unknown, key: string, min = 0): string[] {
  check(Array.isArray(value) && value.length >= min && value.length <= 100, 'invalid_input', `Invalid ${key}`);
  const items = value.map(item => text({ item }, 'item', 200));
  check(new Set(items).size === items.length, 'invalid_input', `Duplicate ${key}`);
  return items;
}
export function bool(value: unknown, key: string): boolean {
  check(typeof value === 'boolean', 'invalid_input', `Invalid ${key}`);
  return value;
}
export function currency(value: unknown): string {
  check(typeof value === 'string' && /^[A-Z]{3}$/.test(value), 'invalid_input', 'Currency must be a three-letter uppercase code');
  return value;
}
export function timezone(value: unknown): string {
  check(typeof value === 'string' && value.length <= 100, 'invalid_input', 'Invalid timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { fail('invalid_input', 'Invalid timezone'); }
  return value;
}
export function day(value: unknown, key: string): string {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'invalid_input', `Invalid ${key}`);
  const ms = Date.parse(value);
  check(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value, 'invalid_input', `Invalid ${key}`);
  return value;
}
export function timestamp(value: unknown, key: string): string {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value), 'invalid_input', `Invalid ${key}`);
  day(value.slice(0, 10), key);
  const ms = Date.parse(value);
  check(Number.isFinite(ms) && Number(value.slice(11, 13)) < 24, 'invalid_input', `Invalid ${key}`);
  return new Date(ms).toISOString();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const fields = value as Fields;
    return `{${Object.keys(fields).sort().map(key => `${JSON.stringify(key)}:${canonical(fields[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function jsonObject(value: unknown, key: string): Fields {
  const json = JSON.stringify(obj(value, key));
  check(json.length <= 16000, 'invalid_input', `${key} exceeds 16 KB`);
  return JSON.parse(json);
}
export async function row(ctx: Context, kind: string, id: string): Promise<Entity> {
  return required(ctx, ads, kind, id);
}
export async function inputRow(ctx: Context, kind: string, input: Fields, key = 'id'): Promise<Entity> {
  return row(ctx, kind, text(input, key, 200));
}
export function expected(entity: Entity, input: Fields, key = 'expected_version'): number {
  const version = integer(input[key], key, 1);
  check(version === entity.version, 'version_conflict', `Stale ${entity.kind} version`, 409);
  return version;
}
export async function patch(ctx: Context, entity: Entity, data: Fields): Promise<Entity> {
  return ctx.update(entity.module, entity.kind, entity.id, data, entity.version);
}
export function state(entity: Entity, ...allowed: string[]): void {
  check(allowed.includes(entity.data.status), 'invalid_state', `${entity.kind} is ${entity.data.status}; expected ${allowed.join(' or ')}`, 409);
}
export function same(actual: unknown, expectedValue: unknown, label: string): void {
  check(actual === expectedValue, 'scope_mismatch', `${label} is outside the selected advertising scope`, 403);
}
export function activeAccountGrant(permissions: unknown, actorId: string, now: string): Fields | undefined {
  return Array.isArray(permissions) ? permissions.find((item: Fields) => item?.actor_id === actorId &&
    Array.isArray(item.actions) && (!item.expires_at || Date.parse(item.expires_at) > Date.parse(now))) : undefined;
}
export function accountAccess(ctx: Context, account: Entity, action: AccountAction, delta = 0): void {
  const grant = activeAccountGrant(account.data.permissions, ctx.actorId, ctx.now);
  check(grant && grant.actions.includes(action), 'forbidden', `Missing ${action} permission on this ad account`, 403);
  if (action === 'spend') {
    check(delta <= grant.max_spend_minor, 'spend_limit_exceeded', 'Incremental spend exceeds the account permission limit', 403);
  }
}
export async function accountFor(ctx: Context, entity: Entity, action: AccountAction, delta = 0): Promise<Entity> {
  const account = await row(ctx, 'ad_account', entity.data.ad_account_id);
  if (entity.data.brand_id != null) same(entity.data.brand_id, account.data.brand_id, 'Brand');
  accountAccess(ctx, account, action, delta);
  return account;
}
export async function matchingCampaign(ctx: Context, id: string, brandId: string): Promise<Entity> {
  const campaign = await required(ctx, 'campaign', 'campaign', id);
  same(campaign.data.brand_id, brandId, 'Campaign');
  return campaign;
}
export function eventData(ctx: Context, entity: Entity, extra: Fields = {}): Fields {
  return { id: entity.id, actor_id: ctx.actorId, version: entity.version, ...extra };
}
export function safeSum(a: number, b: number): number {
  return integer(a + b, 'total_minor');
}
export function localDay(value: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-');
}
