import { createHash } from 'node:crypto';
import { DomainError, required, text } from '../types.ts';
import type { Context, Entity, Fields } from '../types.ts';

export const moduleKey = 'creator';
export const day = 86_400_000;
export const invalid = (key: string): never => { throw new DomainError('invalid_input', `Invalid ${key}`); };
export const conflict = (code: string, message: string): never => { throw new DomainError(code, message, 409); };
export const get = (ctx: Context, kind: string, id: string) => required(ctx, moduleKey, kind, id);
export const list = (ctx: Context, kind: string) => ctx.list(moduleKey, kind);
export const insert = (ctx: Context, kind: string, data: Fields, id?: string) => ctx.insert(moduleKey, kind, data, id);
export const update = (ctx: Context, row: Entity, patch: Fields) => ctx.update(moduleKey, row.kind, row.id, patch, row.version);
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const optional = (input: Fields, key: string, max = 240) => input[key] == null ? null : text(input, key, max);
export function choice<T extends string>(input: Fields, key: string, choices: readonly T[], fallback?: T): T {
  const value = input[key] === undefined ? fallback : input[key];
  return choices.includes(value) ? value : invalid(key);
}
export function integer(input: Fields, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const value = input[key];
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(key);
}
export function safeMinor(value: bigint): number {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : invalid('amount_minor');
}
export function date(input: Fields, key: string): string {
  const value = text(input, key, 48);
  return /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : invalid(key);
}
export function optionalDate(input: Fields, key: string) { return input[key] == null ? null : date(input, key); }
export function object(value: unknown, key: string): Fields {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : invalid(key);
}
export function strings(input: Fields, key: string): string[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return invalid(key);
  return [...new Set(value.map(item => text({ [key]: item }, key, 240)))];
}
export function checkVersion(row: Entity, input: Fields) {
  if (integer(input, 'expected_version', 1) !== row.version) conflict('version_conflict', 'Record changed. Refresh and try again.');
}
export function url(input: Fields, key: string) {
  const raw = optional(input, key, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : invalid(key);
  } catch { return invalid(key); }
}
export function currency(input: Fields) {
  const value = text(input, 'currency', 3).toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : invalid('currency');
}
export async function signedTerms(ctx: Context, collaboration: Entity) {
  const id = collaboration.data.current_terms_revision_id;
  const terms = id ? await ctx.get(moduleKey, 'collaboration_terms', id) : undefined;
  if (!terms || terms.data.collaboration_id !== collaboration.id || terms.data.sign_status !== 'signed') return conflict('TERMS_REQUIRED', 'Current collaboration terms must be signed');
  return terms;
}
export async function setCollaborationStatus(ctx: Context, row: Entity, status: string, patch: Fields = {}) {
  if (row.data.status !== status) await ctx.emit('creator.collaboration.status_changed', { collaboration_id: row.id, from: row.data.status, to: status });
  return update(ctx, row, { ...patch, status });
}