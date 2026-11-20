import { DomainError } from '../types.ts';

export function invalid(message: string): never {
  throw new DomainError('invalid_input', message);
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`Unknown field: ${key}`);
  return value as Record<string, unknown>;
}
export function oneOf<const T extends string>(value: unknown, options: readonly T[], name: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(`Invalid ${name}`);
  return value as T;
}
export function flag(value: unknown, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid(`Invalid ${name}`);
  return value;
}
export function instant(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(`Invalid ${name}`);
  return new Date(value).toISOString();
}
