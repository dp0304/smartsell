import { createHash } from 'node:crypto';
import { DomainError, required, type Context, type Entity, type Fields } from '../types';

export const providers = ['shopify', 'tiktok_shop', 'amazon_sp', 'shopee', 'file_import'] as const;
export const channels = ['online_store', 'tiktok_shop', 'marketplace', 'other'] as const;
export const priceSources = ['store_market_price', 'store_base_price', 'manual', 'fx_estimate'] as const;
export const productStatuses = ['active', 'draft', 'archived', 'removed_at_source'] as const;
export const variantStatuses = ['active', 'archived', 'removed_at_source'] as const;
export const moduleKey = 'commerce';
export const bad = (field: string): never => { throw new DomainError('invalid_input', `Invalid ${field}`); };
export const conflict = (code: string, message: string): never => { throw new DomainError(code, message, 409); };
export const active = (row: Entity | undefined): row is Entity => !!row && row.data.rolled_back !== true;
export const get = (ctx: Context, kind: string, id: string) => ctx.get(moduleKey, kind, id);
export const list = (ctx: Context, kind: string) => ctx.list(moduleKey, kind);
export const insert = (ctx: Context, kind: string, data: Fields, id?: string) => ctx.insert(moduleKey, kind, data, id);
export const update = (ctx: Context, row: Entity, patch: Fields) => ctx.update(moduleKey, row.kind, row.id, patch, row.version);

export function str(value: unknown, field: string, max = 250): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return bad(field);
  return value.trim();
}
export function obj(value: unknown, field: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad(field);
  return value as Fields;
}
export function id(value: unknown, field: string): string {
  const input = str(value, field, 160);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/|+-]*$/.test(input)) return bad(field);
  return input;
}
export function one<const T extends readonly string[]>(value: unknown, field: string, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) return bad(field);
  return value;
}
export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return bad(field);
  return value;
}
export function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') return bad(field);
  return value;
}
const currencies = new Set([...Intl.supportedValuesOf('currency'), ...'BOV CHE CHW CLF COU MXV USN UYI UYW XAF XAG XAU XBA XBB XBC XBD XCD XDR XOF XPD XPF XPT XSU XTS XUA XXX ZWG XCG'.split(' ')]);
export function currency(value: unknown): string {
  const result = str(value, 'currency', 3).toUpperCase();
  if (!currencies.has(result)) return bad('currency');
  return result;
}
export function locale(value: unknown, field = 'locale'): string {
  const result = str(value, field, 40);
  try { return Intl.getCanonicalLocales(result)[0] ?? bad(field); } catch { return bad(field); }
}
export function timezone(value: unknown): string {
  const zone = str(value, 'timezone', 80);
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { return bad('timezone'); }
  return zone;
}
export function instant(value: unknown, field: string, zone?: string): string {
  const stamp = str(value, field, 50).replace(' ', 'T');
  const parts = /^(\d{4}-\d\d-\d\d)(?:T(\d\d:\d\d)(?::(\d\d)(\.\d{1,3})?)?(Z|[+-]\d\d:?\d\d)?)?$/.exec(stamp);
  if (!parts || Number.isNaN(Date.parse(parts[1])) || new Date(parts[1]).toISOString().slice(0, 10) !== parts[1]) return bad(field);
  const clock = `${parts[2] ?? '00:00'}:${parts[3] ?? '00'}${(parts[4] ?? '.').padEnd(4, '0')}`;
  if (Number(clock.slice(0, 2)) > 23 || Number(clock.slice(3, 5)) > 59 || Number(clock.slice(6, 8)) > 59) return bad(field);
  const wall = `${parts[1]}T${clock}`;
  if (parts[5]) {
    const t = Date.parse(wall + parts[5]);
    if (!Number.isFinite(t)) return bad(field);
    return new Date(t).toISOString();
  }
  if (!zone) throw new DomainError('timezone_required', `Timezone required for ${field}`);
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', fractionalSecondDigits: 3 });
  const wallMs = Date.parse(wall + 'Z');
  const local = (time: number) => formatter.format(new Date(time)).replace(' ', 'T').replace(',', '.');
  const offsets = new Set([-86400000, 0, 86400000].map(delta => Date.parse(local(wallMs + delta) + 'Z') - wallMs - delta));
  const matches = [...offsets].map(offset => wallMs - offset).filter(t => local(t) === wall);
  if (matches.length !== 1) return bad(field);
  return new Date(matches[0]).toISOString();
}
export function url(value: unknown, field = 'purchase_url'): string {
  const link = str(value, field, 1000);
  let parsed: URL;
  try { parsed = new URL(link); } catch { return bad(field); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return bad(field);
  return link;
}
export function purchaseUrl(provider: string, value: unknown, field = 'purchase_url'): string {
  const normalized = url(value, field);
  const parsed = new URL(normalized);
  if (provider === 'shopee' && (!/^(?:www\.)?shopee\.(?:sg|ph|tw|vn|co\.id|co\.th|com\.(?:my|br|mx|co|cl))$/.test(parsed.hostname)
    || !/(?:\/product\/\d+\/\d+|\/[^/]*-i\.\d+\.\d+)\/?$/.test(parsed.pathname))) return bad(field);
  return normalized;
}
export function options(value: unknown): Record<string, string> {
  const pairs = Object.entries(obj(value, 'options'));
  if (pairs.length > 10) return bad('options');
  return Object.fromEntries(pairs.map(([key, val]) => [str(key, 'option name', 50), str(val, 'option value', 150)]));
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export const hash = (...value: unknown[]) => createHash('sha256').update(canonical(value)).digest('hex');
export const stableId = (...parts: unknown[]) => {
  const h = hash(...parts);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const same = (data: Fields, patch: Fields) => Object.entries(patch).every(([k, v]) => canonical(data[k]) === canonical(v));
export const guardId = (ctx: Context, storeId: string) => stableId(ctx.workspaceId, 'commerce_write_guard', storeId);
export function version(input: Fields, entity: Entity) {
  if (integer(input.expected_version, 'expected_version', 1) !== entity.version) conflict('version_conflict', 'Record version has changed');
}
export async function live(ctx: Context, kind: string, key: string): Promise<Entity> {
  const result = await required(ctx, moduleKey, kind, key);
  if (!active(result)) throw new DomainError('not_found', `${kind} not found`, 404);
  return result;
}
export async function store(ctx: Context, key: string, writable = true): Promise<Entity> {
  const result = await live(ctx, 'store', key);
  if (writable && result.data.status === 'disabled') conflict('store_disabled', 'Store is disabled');
  return result;
}
/** Acquired before reading store data used to plan writes. All commerce writers share its CAS. */
export async function guard(ctx: Context, storeId: string) {
  const key = guardId(ctx, storeId);
  const current = await get(ctx, 'write_guard', key);
  if (current) await update(ctx, current, { sequence: current.data.sequence + 1 });
  else await insert(ctx, 'write_guard', { store_id: storeId, sequence: 1 }, key);
}
export function statusBucket(quantity: number | null, threshold: number | null): string {
  if (quantity === null) return 'unknown';
  if (quantity <= 0) return 'out_of_stock';
  return threshold !== null && quantity <= threshold ? 'low' : 'in_stock';
}
