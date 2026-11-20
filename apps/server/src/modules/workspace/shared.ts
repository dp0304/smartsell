import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';

export const manage = ['owner', 'admin', 'manager'] as const;
export const internal = ['owner', 'admin', 'manager', 'editor', 'reviewer', 'analyst', 'viewer'] as const;
export const isManager = (ctx: Context) => manage.some(role => role === ctx.role);
export const invalid = (message: string): never => { throw new Problem(422, 'INVALID_INPUT', message); };
export const missing = (kind: string): never => { throw new Problem(404, 'NOT_FOUND', `${kind} not found`); };
export const conflict = (message: string, details?: Data): never => { throw new Problem(409, 'CONFLICT', message, details); };
export const denied = (): never => { throw new Problem(403, 'FORBIDDEN', 'This action requires workspace management permissions'); };

export function str(value: unknown, key: string, max = 250): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid(`Invalid ${key}`);
  return value.trim();
}

export function obj(value: unknown, key: string): Data {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(`Invalid ${key}`);
  return value as Data;
}

export function one<const T extends readonly string[]>(value: unknown, key: string, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) return invalid(`Invalid ${key}`);
  return value;
}

export function bool(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') return invalid(`Invalid ${key}`);
  return value;
}

export function strings(value: unknown, key: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) return invalid(`Invalid ${key}`);
  return [...new Set(value.map(item => str(item, key)))];
}

export function timezone(value: unknown): string {
  const tz = str(value, 'timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { return invalid('Invalid timezone'); }
  return tz;
}

export function currency(value: unknown): string {
  const code = str(value, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return invalid('Invalid currency');
  return code;
}

export function locale(value: unknown): string {
  try { return Intl.getCanonicalLocales(str(value, 'language'))[0]!; } catch { return invalid('Invalid language'); }
}

export function instant(value: unknown, key: string): string {
  const raw = str(value, key);
  const time = Date.parse(raw);
  if (!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))?$/.test(raw) || !Number.isFinite(time)) return invalid(`Invalid ${key}`);
  const day = raw.slice(0, 10);
  if (new Date(Date.parse(day)).toISOString().slice(0, 10) !== day) return invalid(`Invalid ${key}`);
  return new Date(time).toISOString();
}

export function limit(value: string | undefined, fallback = 50): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > 100) return invalid('limit must be between 1 and 100');
  return n;
}

export function pick(body: Data, validators: Record<string, (value: unknown) => unknown>): Data {
  return Object.fromEntries(Object.entries(validators).filter(([key]) => Object.hasOwn(body, key)).map(([key, validate]) => [key, validate(body[key])]));
}

export const nullable = <T>(validate: (value: unknown) => T) => (value: unknown) => value === null ? null : validate(value);
export const id = (value: unknown) => str(value, 'id');
export const label = (value: unknown) => str(value, 'name');
export const stamp = (value: unknown) => instant(value, 'timestamp');
export const brandRows = (ctx: Context) => ctx.list('brand');
export function brandScope(ctx: Context, brandId: string | undefined): string | undefined {
  if (brandId !== undefined) ctx.get('brand', id(brandId));
  return brandId;
}
export function activeBrand(ctx: Context, brandId: string): Row {
  const brand = ctx.get('brand', brandId);
  if (brand.status === 'archived') conflict('Brand is archived');
  return brand;
}
export const inBrand = (row: Data, brandId: string | undefined) => brandId === undefined || row.brand_id === brandId;
export const open = (row: Row) => !['done', 'cancelled'].includes(String(row.status));
export const own = (row: Row, key: string, ctx: Context) => row[key] === ctx.actorId ? row : missing('Resource');
export const timestamp = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
export const newest = (a: Row, b: Row) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id);
export const resourcePair = (row: Data) => (row.resource_type == null) === (row.resource_id == null) || invalid('resource_type and resource_id must be supplied together');
