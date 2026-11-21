import { createHash } from 'node:crypto';
import { DomainError, required, text, type Context, type Entity, type Fields } from '../types.js';
import { instant, localMinute, resolveLocal } from '../../../../../packages/domain/src/publishing/time.js';

export const MODULE = 'planning';
export const TARGET = 'publish_target';
export const PLAN = 'publish_plan';
export const PROFILE = 'publishing_profile';
export const APPROVAL = 'approval';
export const PAUSE = 'pause_switch';
export const PRECHECK = 'precheck_run';
export const activeTarget = (row: Entity) => !['cancelled', 'closed', 'rejected'].includes(row.data.status);
export const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export const object = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value);
export const read = (ctx: Context, kind: string, id: string) => required(ctx, MODULE, kind, id);
export const insert = (ctx: Context, kind: string, data: Fields, id?: string) => ctx.insert(MODULE, kind, data, id);
export const list = (ctx: Context, kind: string) => ctx.list(MODULE, kind);
export const emit = (ctx: Context, event: string, payload: Fields) => ctx.emit(`${MODULE}.${event}`, payload);
export const update = (ctx: Context, row: Entity, patch: Fields) => ctx.update(MODULE, row.kind, row.id, patch, row.version);
export const targetFor = (ctx: Context, input: Fields) => read(ctx, TARGET, text(input, 'target_id', 160));
export const addMinutes = (at: string, delta: number) => new Date(Date.parse(at) + delta * 60_000).toISOString();

export function fail(code: string, message: string, status = 422): never {
  throw new DomainError(code, message, status);
}

export function version(row: Entity, input: Fields) {
  if (input.expected_version === undefined) fail('version_required', 'expected_version is required', 428);
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) fail('invalid_input', 'expected_version must be a positive integer');
  if (row.version !== input.expected_version) fail('version_conflict', 'This record changed. Reload and retry.', 409);
}

export function one<const T extends readonly string[]>(value: unknown, options: T, key: string): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) fail('invalid_input', `Invalid ${key}. Expected ${options.join(', ')}.`);
  return value as T[number];
}

export function allowed(input: Fields, keys: readonly string[]) {
  for (const key of Object.keys(input)) if (!keys.includes(key)) fail('invalid_input', `Unknown or read-only field: ${key}`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function convert<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof Error && 'code' in error) fail(String(error.code).toLowerCase(), error.message);
    throw error;
  }
}

export function timestamp(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) {
    fail('invalid_input', `${field} requires a valid ISO timestamp with an offset`);
  }
  return convert(() => instant(value, field));
}

export function timezone(value: unknown): string {
  if (!nonempty(value) || value.length > 128 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) fail('invalid_timezone', 'An IANA time zone is required');
  try { new Intl.DateTimeFormat('en', { timeZone: value }); }
  catch { fail('invalid_timezone', 'Invalid IANA time zone'); }
  return value;
}

export const timeFields = ['scheduled_at', 'local_scheduled_at', 'schedule_tz', 'tz', 'dst_choice'] as const;

export function scheduleTime(input: Fields, defaultZone: unknown) {
  if (input.schedule_tz !== undefined && input.tz !== undefined && input.schedule_tz !== input.tz) fail('invalid_input', 'Choose one schedule time zone');
  const schedule_tz = timezone(input.schedule_tz ?? input.tz ?? defaultZone);
  if ((input.scheduled_at === undefined) === (input.local_scheduled_at === undefined)) fail('invalid_input', 'Supply either scheduled_at or local_scheduled_at');
  if (input.scheduled_at !== undefined) {
    if (input.dst_choice !== undefined) fail('invalid_input', 'dst_choice applies to local_scheduled_at');
    const scheduled_at = timestamp(input.scheduled_at, 'scheduled_at');
    return { scheduled_at, schedule_tz, local_scheduled_at: localMinute(scheduled_at, schedule_tz), dst_resolution: 'explicit_instant' };
  }
  const local_scheduled_at = text(input, 'local_scheduled_at', 16);
  const choice = input.dst_choice === undefined ? undefined : one(input.dst_choice, ['shift_forward', 'earlier_occurrence', 'later_occurrence'], 'dst_choice');
  const resolved = convert(() => resolveLocal(local_scheduled_at, schedule_tz, choice));
  if (choice && resolved.dst_resolution === 'none') fail('invalid_input', 'This local time does not require a DST choice.');
  return { ...resolved, schedule_tz, local_scheduled_at };
}

export async function assertNoExecution(ctx: Context, target: Entity) {
  if ((await ctx.list('execution', 'execution_task')).some(row => row.data.target_id === target.id)) {
    fail('execution_already_started', 'An execution task owns this target. Use execution cancellation or handoff.', 409);
  }
}
