import { createHash } from 'node:crypto';
import { Problem, type Data } from '@smartsell/contracts';

export function invalid(message: string): never { throw new Problem(422, 'INVALID_INPUT', message); }
export function conflict(message: string): never { throw new Problem(409, 'STATE_CONFLICT', message); }
export function unavailable(message: string): never { throw new Problem(409, 'CAPABILITY_UNAVAILABLE', message); }
export function dto(value: unknown, keys: readonly string[]): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`Unknown field: ${key}`);
  return value as Data;
}
export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) invalid(`Invalid ${name}`);
  return value.trim();
}
export function optional(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name);
}
export function oneOf<const T extends string>(value: unknown, options: readonly T[], name: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(`Invalid ${name}`);
  return value as T;
}
export function integer(value: unknown, name: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid(`Invalid ${name}`);
  return value;
}
export function flag(value: unknown, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid(`Invalid ${name}`);
  return value;
}
export function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) invalid(`Invalid ${name}`);
  return [...new Set(value.map(x => text(x, name)))];
}
export function instant(value: unknown, name: string): string {
  const date = text(value, name);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(date) || !Number.isFinite(Date.parse(date))) invalid(`Invalid ${name}`);
  return new Date(date).toISOString();
}
export function zone(value: unknown): string {
  const tz = text(value, 'timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { invalid('Invalid timezone'); }
  return tz;
}
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
