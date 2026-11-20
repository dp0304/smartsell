import { Problem, type Data, type Context, type Row } from '@smartsell/contracts';

export function fail(code: string, status = 409, details?: Data): never {
  throw new Problem(status, code, code, details);
}

export function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_INPUT', 422);
  return value;
}

export function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 422);
  return value as Data;
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT', 422);
  return value;
}

export function one<T extends string>(value: unknown, options: readonly T[]): T {
  if (!options.includes(value as T)) fail('INVALID_INPUT', 422);
  return value as T;
}

export function select(row: Row, fields: readonly string[]): Data {
  return Object.fromEntries(['id', 'version', 'created_at', 'updated_at', ...fields].map(key => [key, row[key]]));
}

export function find(ctx: Context, kind: string, match: Data): Row | undefined {
  return ctx.list(kind).find(row => Object.entries(match).every(([key, value]) => row[key] === value));
}

export function matches(value: unknown, pattern: RegExp, max = 256): string {
  const str = text(value, max);
  if (!pattern.test(str)) fail('INVALID_INPUT', 422);
  return str;
}

export const sha256Pattern = /^[0-9a-f]{64}$/;
export const time = (ctx: Context) => Date.parse(ctx.now);
export const iso = (ms: number) => new Date(ms).toISOString();

export function audit(ctx: Context, action: string, data: Data) {
  ctx.emit('account.audit.recorded', { action, actor_id: ctx.actorId, occurred_at: ctx.now, ...data });
}
