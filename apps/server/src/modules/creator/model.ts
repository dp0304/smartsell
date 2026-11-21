import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';

export const operators = ['owner', 'admin', 'manager', 'editor'] as const;
export const approvers = ['owner', 'admin', 'manager'] as const;
export function bad(field: string): never { throw new Problem(422, 'INVALID_INPUT', `Invalid ${field}`); }
export function block(code: string, message: string): never { throw new Problem(409, code, message); }
export function text(data: Data, field: string, max = 255): string {
  const value = data[field];
  if (typeof value !== 'string' || !value.trim() || value.length > max) return bad(field);
  return value.trim();
}
export function optional(data: Data, field: string, max?: number) {
  return data[field] == null ? null : text(data, field, max);
}
export function choice<T extends string>(data: Data, field: string, values: readonly T[]): T {
  return values.find(value => value === data[field]) ?? bad(field);
}
export function integer(data: Data, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const value = data[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return bad(field);
  return value;
}
export function date(data: Data, field: string) {
  const value = text(data, field);
  if (!Number.isFinite(Date.parse(value))) return bad(field);
  return new Date(value).toISOString();
}
export function object(value: unknown, field: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad(field);
  return value as Data;
}
export function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > 200) return bad(field);
  return value;
}
export function ids(data: Data, field: string): string[] {
  return [...new Set(array(data[field], field).map(value => text({ value }, 'value')))];
}
export function moneyCurrency(data: Data, field = 'currency') {
  const value = text(data, field, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(value)) return bad(field);
  return value;
}
export function url(data: Data, field: string) {
  const value = optional(data, field, 2048);
  if (!value) return null;
  let result: URL;
  try { result = new URL(value); } catch { return bad(field); }
  if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password) return bad(field);
  return value;
}
export const related = (ctx: Context, kind: string, field: string, value: unknown) => ctx.list(kind).filter(row => row[field] === value);
export function signedTerms(ctx: Context, collaboration: Row) {
  if (!collaboration.current_terms_revision_id) return block('TERMS_REQUIRED', 'Signed collaboration terms are required');
  const row = ctx.get('collaboration_terms', String(collaboration.current_terms_revision_id));
  if (row.sign_status !== 'signed') return block('TERMS_REQUIRED', 'Current collaboration terms must be signed');
  return row;
}
export function collaborationStatus(ctx: Context, row: Row, status: string, patch: Data = {}) {
  if (row.status !== status) ctx.emit('creator.collaboration.status_changed', { collaboration_id: row.id, from: row.status, to: status });
  return ctx.update('collaboration', row.id, { ...patch, status });
}
export const currencySafe = (value: bigint) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return bad('amount');
  return Number(value);
};
export const created = (ctx: Context, kind: string, values: Data) => ctx.create(kind, { ...values, created_by: ctx.actorId });
