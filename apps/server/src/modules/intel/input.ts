import { Problem, type Data, type Input } from '@smartsell/contracts';

export function invalid(field: string, expectation: string): never {
  throw new Problem(400, 'VALIDATION_ERROR', `${field} ${expectation}`, { field });
}
export function conflict(message: string): never {
  throw new Problem(409, 'INVALID_STATE', message);
}
export function object(value: unknown, field: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'must be an object');
  return value as Data;
}
export function text(value: unknown, field: string, limit = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) invalid(field, `must be nonempty text up to ${limit} characters`);
  return value.trim();
}
export function optionalText(value: unknown, field: string, limit?: number): string | null {
  return value == null ? null : text(value, field, limit);
}
export function choice<const T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(field, `must be one of ${values.join(', ')}`);
  return value as T;
}
export function number(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(field, `must be a number between ${min} and ${max}`);
  return value;
}
export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const result = number(value, field, min, max);
  if (!Number.isSafeInteger(result)) invalid(field, 'must be an integer');
  return result;
}
export function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field, 'must be a boolean');
  return value;
}
export function strings(value: unknown, field: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) invalid(field, `must be an array with at most ${max} entries`);
  return [...new Set(value.map(entry => text(entry, field, 200)))];
}
export function url(value: unknown, field = 'url'): string {
  const raw = text(value, field, 2048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return invalid(field, 'must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid(field, 'must be an HTTP(S) URL without credentials');
  return parsed.href;
}
export function time(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid(field, 'must be an ISO timestamp with a timezone');
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || !Number.isFinite(+day) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) invalid(field, 'must be a valid timestamp');
  return new Date(ms).toISOString();
}
export function period(input: Record<string, unknown>, required = false): { from?: string; to?: string } {
  const from = required || input.from !== undefined ? time(input.from, 'from') : undefined;
  const to = required || input.to !== undefined ? time(input.to, 'to') : undefined;
  if (from && to && from >= to) invalid('to', 'must follow from');
  return { from, to };
}
export function inPeriod(value: unknown, bounds: { from?: string; to?: string }): boolean {
  return typeof value === 'string' && (!bounds.from || value >= bounds.from) && (!bounds.to || value < bounds.to);
}
export function id(input: Input): string {
  return text(input.params.id, 'id', 200);
}
export function money(value: unknown, field: string): Data {
  const item = object(value, field);
  const currency = text(item.currency, `${field}.currency`, 3);
  if (!/^[A-Z]{3}$/.test(currency)) invalid(`${field}.currency`, 'must be a three-letter uppercase currency code');
  return { amount_minor: integer(item.amount_minor, `${field}.amount_minor`), currency };
}
