import { isDeepStrictEqual } from 'node:util';
import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';

export const providers = ['shopify', 'tiktok_shop', 'amazon_sp', 'shopee', 'lazada', 'file_import', 'other'] as const;
export const channels = ['online_store', 'tiktok_shop', 'marketplace', 'other'] as const;
export const priceSources = ['store_market_price', 'store_base_price', 'manual', 'fx_estimate'] as const;
export const availability = ['observed', 'not_collected', 'no_permission', 'source_not_provided', 'sync_failed'] as const;
export const stockStatuses = ['in_stock', 'low', 'out_of_stock', 'unknown', 'not_tracked'] as const;

export function invalid(field: string): never {
  throw new Problem(422, 'invalid_input', `Invalid ${field}`);
}
export function conflict(code: string, message: string): never {
  throw new Problem(409, code, message);
}
export function object(value: unknown, field: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value as Data;
}
export function text(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(field);
  return value.trim();
}
export function optional(value: unknown, field: string): string | null {
  return value == null || value === '' ? null : text(value, field);
}
export function identifier(value: unknown, field: string): string | null {
  return optional(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value, field);
}
export function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) invalid(field);
  return value as T;
}
export function integer(value: unknown, field: string, min = 0): number {
  const number = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min) invalid(field);
  return number;
}
export function bool(value: unknown, field: string): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return invalid(field);
}
export function currency(value: unknown): string {
  const code = text(value, 'currency', 3).toUpperCase();
  if (!Intl.supportedValuesOf('currency').includes(code) && !['XAF', 'XCD', 'XOF', 'XPF'].includes(code)) invalid('currency');
  return code;
}
export function timestamp(value: unknown, field: string): string {
  const parsed = Date.parse(text(value, field));
  if (!Number.isFinite(parsed)) invalid(field);
  return new Date(parsed).toISOString();
}
export function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) invalid(field);
  return Array.from(new Set(value.map(item => text(item, field))));
}
export function objects(value: unknown, field: string): Data[] {
  if (!Array.isArray(value)) invalid(field);
  return value.map(item => object(item, field));
}
export function stringMap(value: unknown, field: string): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value, field)).map(([key, item]) => [key, text(item, field)]));
}
export function one(rows: Row[], code: string, message: string): Row | undefined {
  if (rows.length > 1) conflict(code, message);
  return rows[0];
}
export function rowChanged(row: Row | undefined, data: Data): boolean {
  return !row || Object.entries(data).some(([key, value]) => !isDeepStrictEqual(row[key], value));
}
export function upsert(ctx: Context, kind: string, row: Row | undefined, data: Data): Row {
  if (!row) return ctx.create(kind, data);
  return rowChanged(row, data) ? ctx.update(kind, row.id, data) : row;
}
export function https(value: unknown, field: string): URL {
  try {
    const url = new URL(text(value, field));
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url;
  } catch { /* malformed URL */ }
  return invalid(field);
}
export function purchaseUrl(value: unknown, provider: Row['provider']): string | null {
  if (value == null || value === '') return null;
  const url = https(value, 'purchase_url');
  if (provider === 'shopee') {
    const host = url.hostname.replace(/^www\./, '');
    const domains = ['shopee.sg', 'shopee.com.my', 'shopee.co.th', 'shopee.co.id', 'shopee.ph', 'shopee.vn', 'shopee.tw', 'shopee.com.br', 'shopee.com.mx', 'shopee.com.co', 'shopee.cl'];
    if (!domains.includes(host) || !/^\/(?:product\/\d+\/\d+\/?|[^/]+-i\.\d+\.\d+\/?)$/.test(url.pathname)) invalid('purchase_url');
    url.search = '';
    url.hash = '';
  }
  return url.toString();
}
export function phase(_ctx: Context): 'p0a' | 'p0b' | 'p1' | 'p2' {
  return enumValue(process.env.SMARTSELL_COMMERCE_PHASE?.toLowerCase() ?? 'p2', ['p0a', 'p0b', 'p1', 'p2'], 'commerce phase');
}
export function requirePhase(ctx: Context, minimum: ReturnType<typeof phase>): void {
  const phases = ['p0a', 'p0b', 'p1', 'p2'];
  if (phases.indexOf(phase(ctx)) < phases.indexOf(minimum)) throw new Problem(409, 'phase_unavailable', `Requires commerce phase ${minimum}`);
}
export function requirePlatformPhase(ctx: Context, provider: unknown): void {
  if (provider === 'lazada') requirePhase(ctx, 'p2');
}
export function scope(value: unknown, existing: Data = {}): Data {
  if (value == null) return existing;
  const requested = object(value, 'sync_scope');
  const result = { ...existing };
  for (const field of ['products', 'inventory', 'orders', 'refunds']) {
    if (field in requested) result[field] = bool(requested[field], field);
  }
  return result;
}
