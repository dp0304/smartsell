import { DomainError, required, type Command, type Context, type Entity, type Fields, type Role } from '../types.ts';

export const moduleName = 'campaign';
export const readRoles = ['owner', 'admin', 'editor', 'reviewer', 'viewer'] as const;
export const writeRoles = ['owner', 'admin', 'editor'] as const;
export const leadRoles = ['owner', 'admin'] as const;
export const reviewRoles = ['owner', 'admin', 'reviewer'] as const;

export function invalid(message: string): never { throw new DomainError('invalid_input', message); }
export function conflict(message: string): never { throw new DomainError('conflict', message, 409); }
export function missing(message: string): never { throw new DomainError('not_found', message, 404); }

export function command(roles: readonly Role[], run: Command['run']): Command {
  return { roles, async run(ctx, input) {
    if (!roles.includes(ctx.role)) throw new DomainError('forbidden', 'Campaign permission required', 403);
    return run(ctx, object(input, 'input'));
  } };
}
export function object(value: unknown, key: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${key} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${key} must be a plain object`);
  return value as Fields;
}
export function fields(input: Fields, allowed: readonly string[]) {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) invalid(`Unknown or read-only field: ${key}`);
}
export function text(value: unknown, key: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${key} must be nonempty text up to ${max} characters`);
  return value.trim();
}
export function optionalText(value: unknown, key: string, max?: number): string | null {
  return value == null ? null : text(value, key, max);
}
export function options<T extends string>(value: unknown, key: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(`${key} must be one of ${allowed.join(', ')}`);
  return value as T;
}
export function list(value: unknown, key: string, max = 200): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${key} must be an array with at most ${max} items`);
  return value;
}
export function strings(value: unknown, key: string): string[] {
  const result = list(value, key).map(item => text(item, key));
  if (new Set(result).size !== result.length) invalid(`${key} contains duplicates`);
  return result;
}
export function numeric(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${key} must be a finite number`);
  return value;
}
export function integer(value: unknown, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const result = numeric(value, key);
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid(`${key} must be an integer from ${min} to ${max}`);
  return result;
}
export function date(value: unknown, key: string): string {
  const parsed = text(value, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed) || !Number.isFinite(Date.parse(parsed)) || new Date(parsed).toISOString().slice(0, 10) !== parsed) {
    invalid(`${key} must be a calendar date`);
  }
  return parsed;
}
export function timestamp(value: unknown, key: string): string {
  const parsed = text(value, key);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    invalid(`${key} must be an ISO timestamp with timezone`);
  }
  date(parsed.slice(0, 10), key);
  return new Date(parsed).toISOString();
}
export function windowDates(input: Fields, start: string, end: string) {
  const from = input[start] == null ? null : timestamp(input[start], start);
  const to = input[end] == null ? null : timestamp(input[end], end);
  if (from && to && from >= to) invalid(`${start} must precede ${end}`);
  return { [start]: from, [end]: to };
}
export function currency(value: unknown): string {
  const parsed = text(value, 'currency', 3);
  if (!/^[A-Z]{3}$/.test(parsed) || !Intl.supportedValuesOf('currency').includes(parsed)) invalid('currency must be an ISO currency code');
  return parsed;
}
export function expected(row: Entity, value: unknown) {
  if (value === undefined) throw new DomainError('version_required', 'expected_version is required', 428);
  if (integer(value, 'expected_version', 1) !== row.version) throw new DomainError('version_conflict', 'The resource has changed', 409);
  return row.version;
}
export function getCampaign(ctx: Context, input: Fields) { return required(ctx, moduleName, 'campaign', text(input.campaign_id, 'campaign_id')); }
export async function related(ctx: Context, kind: string, campaignId: string, id: unknown) {
  const row = await required(ctx, moduleName, kind, text(id, `${kind}_id`));
  if (row.data.campaign_id !== campaignId) missing(`${kind} does not belong to this campaign`);
  return row;
}
export async function rows(ctx: Context, kind: string, campaignId: string) {
  return (await ctx.list(moduleName, kind)).filter(row => row.data.campaign_id === campaignId && !row.data.removed_at);
}
export function mutable(row: Entity) {
  if (row.data.status === 'closed' || row.data.status === 'cancelled') conflict('Campaign is read-only');
}
export function emit(ctx: Context, name: string, campaignId: string, payload: Fields = {}) {
  return ctx.emit(`campaign.${name}`, { ...payload, campaign_id: campaignId });
}
export async function reference(ctx: Context, module: string, kind: string, value: unknown, key: string) {
  const id = text(value, key);
  await required(ctx, module, kind, id);
  return id;
}
