import { DomainError, readers, type Command, type Context, type Entity, type Fields, type Role } from '../types.js';

export const key = 'workspace';
export const browse = readers;
export const manage = ['owner', 'admin', 'editor'] as const;
export const administer = ['owner', 'admin'] as const;
export const isManager = (ctx: Context) => (manage as readonly Role[]).includes(ctx.role);
export const problems = {
  invalid(message: string): never { throw new DomainError('invalid_input', message); },
  conflict(message: string): never { throw new DomainError('invalid_state', message, 409); },
  missing(message: string): never { throw new DomainError('not_found', message, 404); },
  denied(): never { throw new DomainError('forbidden', 'Access denied', 403); },
};
export function action(roles: readonly Role[], run: Command['run']): Command {
  return { roles, async run(ctx, input) {
    if (!roles.includes(ctx.role)) problems.denied();
    return run(ctx, input);
  } };
}
export function str(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return problems.invalid(`Invalid ${name}`);
  return value.trim();
}
export function obj(value: unknown, name: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return problems.invalid(`Invalid ${name}`);
  return value as Fields;
}
export function choice<const T extends readonly string[]>(value: unknown, name: string, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) return problems.invalid(`Invalid ${name}`);
  return value;
}
export const identifier = (value: unknown) => str(value, 'id', 160);
export function iso(value: unknown, field: string): string {
  const date = str(value, field, 40);
  if (!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))?$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date.slice(0, 10)).toISOString().slice(0, 10) !== date.slice(0, 10)) return problems.invalid(`Invalid ${field}`);
  return new Date(date).toISOString();
}
export function listLimit(value: unknown, fallback = 50): number {
  const effective = value === undefined ? fallback : value;
  if (typeof effective !== 'number' || !Number.isSafeInteger(effective) || effective < 1 || effective > 100) return problems.invalid('limit must be between 1 and 100');
  return effective;
}
export function expected(row: Entity, input: Fields): number {
  const n = input.expected_version ?? input.version;
  if (!Number.isSafeInteger(n) || n < 1) problems.invalid('expected_version must be a positive integer');
  if (row.version !== n) throw new DomainError('version_conflict', 'Record version has changed', 409);
  return n;
}
export const list = (ctx: Context, kind: string) => ctx.list(key, kind);
export const get = (ctx: Context, kind: string, id: string) => ctx.get(key, kind, id);
export async function must(ctx: Context, kind: string, id: string) {
  return await get(ctx, kind, id) ?? problems.missing(`${kind} not found`);
}
export const put = (ctx: Context, row: Entity, patch: Fields) => ctx.update(key, row.kind, row.id, patch, row.version);
export const add = (ctx: Context, kind: string, data: Fields, id?: string) => ctx.insert(key, kind, data, id);
export const emit = (ctx: Context, event: string, data: Fields) => ctx.emit(`${key}.${event}`, data);
export const active = (row: Entity) => !['archived', 'revoked', 'removed', 'disabled', 'cancelled'].includes(row.data.status);
export const openTask = (row: Entity) => !['done', 'cancelled'].includes(row.data.status);
export const inBrand = (row: Entity, brand: string | undefined) => brand === undefined || row.data.brand_id === brand;
export async function brandFilter(ctx: Context, value: unknown): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const id = identifier(value);
  await must(ctx, 'brand', id);
  return id;
}
export function fields(input: Fields, schema: Record<string, (value: unknown) => unknown>): Fields {
  return Object.fromEntries(Object.entries(schema).filter(([name]) => Object.hasOwn(input, name)).map(([name, validate]) => [name, validate(input[name])]));
}
export const nullable = (validate: (value: unknown) => unknown) => (value: unknown) => value === null ? null : validate(value);
export const instant = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
export const newest = (a: Entity, b: Entity) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id);
export function safeTitle(row: Entity, fallback: string) {
  const title = row.data.title ?? row.data.name ?? row.data.display_name ?? row.data.subject ?? row.data.label;
  return typeof title === 'string' && title.length ? title.slice(0, 250) : fallback;
}
export function localDay(now: string | number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  return ['year', 'month', 'day'].map(k => parts.find(part => part.type === k)?.value).join('-');
}
export async function workspaceZone(ctx: Context) {
  const row = await get(ctx, 'workspace', ctx.workspaceId);
  return typeof row?.data.default_timezone === 'string' ? row.data.default_timezone : 'UTC';
}
