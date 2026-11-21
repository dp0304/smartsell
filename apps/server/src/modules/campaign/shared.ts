import { createHash } from 'node:crypto';
import { Problem, type Context, type Data, type Input, type Row } from '@smartsell/contracts';

export const PLAN = ['owner', 'admin', 'manager', 'editor'] as const;
export const LEAD = ['owner', 'admin', 'manager'] as const;
export const INTERNAL_READ = ['owner', 'admin', 'manager', 'editor', 'analyst', 'viewer', 'agent'] as const;
export const CAMPAIGNS = '/campaigns';
export const CAMPAIGN = `${CAMPAIGNS}/:id`;

export function invalid(message: string): never { throw new Problem(422, 'validation_failed', message); }
export function conflict(message: string): never { throw new Problem(409, 'conflict', message); }
export function missing(message: string): never { throw new Problem(404, 'not_found', message); }

export function record(value: unknown, field: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Data;
}
export function fields(body: Data, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) invalid(`Unknown or read-only field: ${key}`);
}
export function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${field} must be non-empty text up to ${max} characters`);
  return value.trim();
}
export function optionalText(value: unknown, field: string, max = 500): string | null {
  return value == null ? null : text(value, field, max);
}
export function choice<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(`${field} must be one of ${allowed.join(', ')}`);
  return value as T;
}
export function flag(value: unknown, field: string, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`);
  return value;
}
export function array(value: unknown, field: string, max = 200): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${field} must be an array of at most ${max} items`);
  return value;
}
export function strings(value: unknown, field: string): string[] {
  const values = array(value, field).map(item => text(item, field));
  if (new Set(values).size !== values.length) invalid(`${field} contains duplicates`);
  return values;
}
export function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${field} must be a finite number`);
  return value;
}
export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const result = number(value, field);
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid(`${field} must be an integer from ${min} to ${max}`);
  return result;
}
export function day(value: unknown, field: string): string {
  const input = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !Number.isFinite(Date.parse(input)) || new Date(input).toISOString().slice(0, 10) !== input) {
    invalid(`${field} must be a calendar date (YYYY-MM-DD)`);
  }
  return input;
}
export function timestamp(value: unknown, field: string): string {
  const input = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(input) || !Number.isFinite(Date.parse(input))) {
    invalid(`${field} must be an ISO timestamp with a timezone`);
  }
  day(input.slice(0, 10), field);
  return new Date(input).toISOString();
}
export function optionalTimestamp(value: unknown, field: string): string | null {
  return value == null ? null : timestamp(value, field);
}
export function range(start: string | null, end: string | null, field: string): void {
  if (start && end && start >= end) invalid(`${field} start must precede its end`);
}
export function locale(value: unknown, field: string): string {
  try { return Intl.getCanonicalLocales(text(value, field, 80))[0]!; }
  catch { return invalid(`${field} must be a valid language tag`); }
}
export function currency(value: unknown): string {
  const parsed = text(value, 'currency', 3);
  if (!/^[A-Z]{3}$/.test(parsed) || !Intl.supportedValuesOf('currency').includes(parsed)) invalid('currency must be a supported ISO currency code');
  return parsed;
}
export function version(row: Row, input: Input): void {
  const supplied = input.expectedVersion ?? input.body.expected_version;
  if (supplied === undefined) throw new Problem(428, 'version_required', 'Supply If-Match or expected_version');
  if (integer(supplied, 'expected_version', 1) !== row.version) throw new Problem(412, 'version_conflict', 'The resource has changed');
}
export function rows(ctx: Context, kind: string, key: string, id: unknown): Row[] {
  return ctx.list(kind).filter(row => row[key] === id);
}
export function campaign(ctx: Context, input: Input): Row {
  return ctx.get('campaign', text(input.params.id ?? input.body.campaign_id, 'campaign_id'));
}
export function mutable(row: Row): void {
  if (row.status === 'closed' || row.status === 'cancelled') conflict('This campaign is read-only');
}
export function scoped(ctx: Context, kind: string, id: string, parentKey: string, parentId: string): Row {
  const row = ctx.get(kind, id);
  if (row[parentKey] !== parentId) missing(`${kind} does not belong to this resource`);
  return row;
}
export function jsonDoc(value: unknown, field: string): Data {
  const doc = record(value, field);
  const stack: { node: Data; depth: number }[] = [{ node: doc, depth: 0 }];
  if (doc.type !== 'doc') invalid(`${field} must be a ProseMirror doc`);
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > 30 || ++count > 10_000) invalid(`${field} is too large`);
    text(node.type, `${field}.type`, 80);
    if (node.type === 'text' && (typeof node.text !== 'string' || !node.text.length || node.content !== undefined)) invalid(`${field} contains an invalid text node`);
    if (node.content !== undefined) {
      for (const child of array(node.content, `${field}.content`, 10_000)) stack.push({ node: record(child, field), depth: depth + 1 });
    }
  }
  return doc;
}
export function hash(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object') {
      const object = item as Data;
      return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(item) ?? 'null';
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function event(ctx: Context, name: string, campaignId: string, data: Data = {}): void {
  ctx.emit(`campaign.${name}`, { ...data, campaign_id: campaignId });
}
export function page(items: Row[], query: Input['query']): { data: Row[]; next_cursor: string | null } {
  const limit = query.limit === undefined ? 50 : integer(Number(query.limit), 'limit', 1, 200);
  const index = query.cursor === undefined ? -1 : items.findIndex(row => row.id === query.cursor);
  if (query.cursor !== undefined && index === -1) invalid('Unknown cursor');
  const data = items.slice(index + 1, index + 1 + limit);
  return { data, next_cursor: index + 1 + limit < items.length ? data.at(-1)!.id : null };
}
