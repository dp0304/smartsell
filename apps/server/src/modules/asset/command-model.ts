import { createHash } from 'node:crypto';
import { DomainError, required, text, type Context, type Entity, type Fields } from '../types.ts';

export const moduleKey = 'asset';
export const get = (ctx: Context, kind: string, id: string) => required(ctx, moduleKey, kind, id);
export const list = (ctx: Context, kind: string) => ctx.list(moduleKey, kind);
export const insert = (ctx: Context, kind: string, data: Fields, id?: string) => ctx.insert(moduleKey, kind, data, id);
export const update = (ctx: Context, row: Entity, patch: Fields) => ctx.update(moduleKey, row.kind, row.id, patch, row.version);
export const emit = (ctx: Context, event: string, payload: Fields) => ctx.emit(`asset.${event}`, payload);

export function invalid(message: string): never {
  throw new DomainError('invalid_input', message);
}

export function conflict(message: string): never {
  throw new DomainError('invalid_state', message, 409);
}

export function option(input: Fields, key: string, values: readonly string[]): string {
  const value = text(input, key, 100);
  if (!values.includes(value)) invalid(`Invalid ${key}`);
  return value;
}

export function optional(input: Fields, key: string, max = 4096): string | null {
  return input[key] == null ? null : text(input, key, max);
}

export function strings(value: unknown, key: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(`Invalid ${key}`);
  return [...new Set(value.map(entry => text({ entry }, 'entry', 256)))];
}

export function object(value: unknown, key: string): Fields {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${key}`);
  return value as Fields;
}

export function bool(input: Fields, key: string, fallback: boolean): boolean {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid(`Invalid ${key}`);
  return value;
}

export function integer(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(`Invalid ${key}`);
  return value;
}

export function instant(value: unknown, key: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) invalid(`Invalid ${key}`);
  const parsed = Date.parse(value);
  const date = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== value.slice(0, 10)) invalid(`Invalid ${key}`);
  return new Date(parsed).toISOString();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) invalid('Expected JSON-compatible data');
  return JSON.stringify(value);
}

export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function expectVersion(row: Entity, input: Fields): void {
  if (input.expected_version !== undefined && integer(input.expected_version, 'expected_version', 1, Number.MAX_SAFE_INTEGER) !== row.version) {
    throw new DomainError('version_conflict', `Version conflict for ${row.kind}`, 409);
  }
}
