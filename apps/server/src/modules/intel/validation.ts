import { DomainError, required, text } from '../types.ts';
import type { Command, Context, Entity, Fields, Role } from '../types.ts';

export const moduleKey = 'intel';
export const fail = (message: string): never => { throw new DomainError('invalid_input', message); };
export const conflict = (message: string): never => { throw new DomainError('invalid_state', message, 409); };
export const blocked = (message: string): never => { throw new DomainError('EGRESS_BLOCKED', message, 403); };
export const command = (roles: readonly Role[], run: Command['run']): Command => ({ roles, async run(ctx, input) {
  if (!roles.includes(ctx.role)) throw new DomainError('forbidden', 'Insufficient Intel permissions', 403);
  return run(ctx, input);
} });
export function object(input: unknown, keys: readonly string[], field = 'input'): Fields {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    return fail(`Invalid ${field}`);
  }
  const fields = input as Fields;
  for (const key of Object.keys(fields)) if (!keys.includes(key)) fail(`Unknown ${field} field: ${key}`);
  return fields;
}
export function choice<T extends string>(input: Fields, key: string, values: readonly T[]): T {
  if (!values.includes(input[key])) fail(`Invalid ${key}`);
  return input[key];
}
export function number(input: Fields, key: string, min: number, max: number, integer = false): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    return fail(`Invalid ${key}`);
  }
  return value;
}
export function boolean(input: Fields, key: string): boolean {
  if (typeof input[key] !== 'boolean') fail(`Invalid ${key}`);
  return input[key];
}
export function strings(input: Fields, key: string, limit = 50, length = 160): string[] {
  const values = input[key];
  if (!Array.isArray(values) || values.length > limit) return fail(`Invalid ${key}`);
  const normalized = values.map(value => text({ value }, 'value', length));
  if (new Set(normalized).size !== normalized.length) fail(`Duplicate ${key}`);
  return normalized;
}
export function url(input: Fields, key = 'url'): string {
  const raw = text(input, key, 2048);
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return fail(`Invalid ${key}`);
    return parsed.href;
  } catch { return fail(`Invalid ${key}`); }
}
export function timestamp(input: Fields, key: string): string {
  const raw = text(input, key, 32);
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.exec(raw);
  if (!match || !Number.isFinite(Date.parse(raw))) return fail(`Invalid ${key}; use a timestamp with a timezone`);
  const [, y, m, d, h, minute, s] = match;
  const maxDay = [31, +y % 4 === 0 && (+y % 100 !== 0 || +y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][+m - 1];
  if (!maxDay || +d < 1 || +d > maxDay || +h > 23 || +minute > 59 || +s > 59) fail(`Invalid ${key}`);
  return new Date(raw).toISOString();
}
export function language(input: Fields, key = 'language'): string {
  try { return Intl.getCanonicalLocales(text(input, key, 50))[0]; }
  catch { return fail(`Invalid ${key}`); }
}
export function optional<T>(input: Fields, key: string, parse: (input: Fields, key: string) => T): T | undefined {
  return Object.hasOwn(input, key) ? parse(input, key) : undefined;
}
export function selected(input: Fields, keys: readonly string[], parse = text): Fields {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(input, key)).map(key => [key, parse(input, key)]));
}
export function period(value: unknown, field = 'period'): { from: string; to: string } {
  const input = object(value, ['from', 'to'], field);
  const from = timestamp(input, 'from');
  const to = timestamp(input, 'to');
  if (from >= to) fail(`Invalid ${field} order`);
  return { from, to };
}
export function money(value: unknown): { amount_minor: number; currency: string } {
  const input = object(value, ['amount_minor', 'currency'], 'money');
  const currency = text(input, 'currency', 3);
  if (!/^[A-Z]{3}$/.test(currency) || !Intl.supportedValuesOf('currency').includes(currency)) fail('Invalid currency');
  return { amount_minor: number(input, 'amount_minor', 0, Number.MAX_SAFE_INTEGER, true), currency };
}
export const get = (ctx: Context, kind: string, id: string) => required(ctx, moduleKey, kind, id);
export const list = (ctx: Context, kind: string) => ctx.list(moduleKey, kind);
export const expectedVersion = (input: Fields) => number(input, 'expected_version', 1, Number.MAX_SAFE_INTEGER, true);
export function assertVersion(row: Entity, input: Fields) {
  if (row.version !== expectedVersion(input)) throw new DomainError('version_conflict', 'Record has changed', 409);
}
export async function create(ctx: Context, kind: string, data: Fields, event = `${kind}.created`) {
  const row = await ctx.insert(moduleKey, kind, { ...data, created_by_id: ctx.actorId });
  await ctx.emit(`${moduleKey}.${event}`, { id: row.id, version: row.version });
  return row;
}
export async function update(ctx: Context, kind: string, row: Entity, patch: Fields, input: Fields, event = `${kind}.changed`, details: Fields = {}) {
  const result = await ctx.update(moduleKey, kind, row.id, patch, expectedVersion(input));
  await ctx.emit(`${moduleKey}.${event}`, { id: result.id, version: result.version, ...(patch.status ? { status: patch.status } : {}), ...details });
  return result;
}
export function active(row: Entity) {
  if (row.data.status !== 'active') conflict(`${row.kind} must be active`);
}
