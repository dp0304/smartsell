import { createHash } from 'node:crypto';
import { DomainError, required, text, type Context, type Entity, type Fields, type Role } from '../types.js';

export const moduleKey = 'account';
export const get = (ctx: Context, kind: string, id: string) => required(ctx, moduleKey, kind, id);
export const list = (ctx: Context, kind: string) => ctx.list(moduleKey, kind);
export const insert = (ctx: Context, kind: string, value: Fields, id?: string) => ctx.insert(moduleKey, kind, value, id);
export const update = (ctx: Context, row: Entity, value: Fields) => ctx.update(moduleKey, row.kind, row.id, value, row.version);
export const emit = (ctx: Context, event: string, payload: Fields) => ctx.emit(`account.${event}`, payload);
export const millis = (ctx: Context) => Date.parse(ctx.now);
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const idFor = (...parts: string[]) => sha256(JSON.stringify(parts));

export function ensure(value: unknown, code: string, status = 409): asserts value {
  if (!value) throw new DomainError(code, code, status);
}
export function requireRole(ctx: Context, roles: readonly Role[]) {
  ensure(roles.includes(ctx.role), 'forbidden', 403);
}
export function choice<T extends string>(input: Fields, key: string, values: readonly T[]): T {
  const value = input[key];
  ensure(values.includes(value), `invalid_${key}`, 422);
  return value;
}
export function integer(input: Fields, key: string, min: number, max: number): number {
  const value = input[key];
  ensure(Number.isSafeInteger(value) && value >= min && value <= max, `invalid_${key}`, 422);
  return value;
}
export function identifier(input: Fields, key: string): string { return text(input, key, 160); }
export function approved(input: Fields, key: string) { ensure(input[key] === true, `${key}_required`, 422); }
export function timezone(value: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { ensure(false, 'invalid_timezone', 422); }
  return value;
}
export async function upsert(ctx: Context, kind: string, id: string, value: Fields) {
  const existing = await ctx.get(moduleKey, kind, id);
  return existing ? update(ctx, existing, value) : insert(ctx, kind, value, id);
}
export async function blocks(ctx: Context, bindingId: string) {
  return (await list(ctx, 'account_block')).filter((row) => row.data.binding_id === bindingId && row.data.status === 'open');
}
export async function openBlock(ctx: Context, binding: Entity, reason: string) {
  const current = (await blocks(ctx, binding.id)).find((row) => row.data.kind === reason);
  if (current) return current;
  const block = await insert(ctx, 'account_block', { binding_id: binding.id, social_account_id: binding.data.social_account_id, kind: reason, status: 'open' });
  await emit(ctx, 'block.opened', { block_id: block.id, binding_id: binding.id, reason });
  return block;
}
export async function stopAuto(ctx: Context, binding: Entity, reason: string, blockId: string | null) {
  if (binding.data.connector_mode !== 'auto') return binding;
  const stopped = await update(ctx, binding, { connector_mode: 'assist', auto_stopped_at: ctx.now, auto_stop_reason: reason, auto_stop_block_id: blockId });
  await emit(ctx, 'binding.auto_stopped', { binding_id: binding.id, reason, block_id: blockId });
  return stopped;
}
