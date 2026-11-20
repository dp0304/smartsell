import { createHash } from 'node:crypto';
import { DomainError, required, text, type Context, type Entity, type Fields, type Role } from '../types.js';

export const DAY = 86_400_000;
export const moduleKey = 'ingest';
export const socialProviders = ['meta_instagram', 'meta_facebook', 'tiktok', 'youtube', 'douyin', 'xiaohongshu'] as const;
export const methods = ['official_api', 'report_import', 'manual_entry'] as const;
export const uses = ['display', 'team_share', 'export', 'public_display', 'model_processing'] as const;
export const availabilities = ['observed', 'not_collected', 'no_permission', 'not_applicable', 'sync_failed', 'source_not_provided'] as const;
export const resources = ['account_metrics', 'post_metrics', 'video_metrics', 'note_metrics', 'ad_metrics'] as const;
export const metricKeys = ['impressions', 'reach', 'views', 'video_views', 'likes', 'comments', 'shares', 'saves', 'followers', 'clicks', 'spend', 'conversions', 'watch_time_seconds'] as const;
export const cumulativeKeys = new Set<string>(['impressions', 'reach', 'views', 'video_views', 'likes', 'comments', 'shares', 'saves', 'followers', 'clicks', 'watch_time_seconds']);
export const roleAllowed = (ctx: Context, roles: readonly Role[]) => requireThat(roles.includes(ctx.role), 'forbidden', 'Role cannot run this ingestion command', 403);
export const get = (ctx: Context, kind: string, id: string) => required(ctx, moduleKey, kind, id);
export const list = (ctx: Context, kind: string) => ctx.list(moduleKey, kind);
export const insert = (ctx: Context, kind: string, data: Fields, id?: string) => ctx.insert(moduleKey, kind, data, id);
export const update = (ctx: Context, row: Entity, data: Fields) => ctx.update(moduleKey, row.kind, row.id, data, row.version);
export const emit = (ctx: Context, event: string, data: Fields) => ctx.emit(`ingest.${event}`, data);
export const hash = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export const iso = (time: number) => new Date(time).toISOString();
export const at = (time: string) => Date.parse(time);

export function requireThat(condition: unknown, code: string, message: string, status = 422): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}

export function shape(value: unknown, fields: readonly string[], label = 'input'): Fields {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_input', `Invalid ${label}`);
  requireThat(Object.keys(value).every(key => fields.includes(key)), 'invalid_input', `Unexpected field in ${label}`);
  return value as Fields;
}

export function choice<T extends string>(value: unknown, values: readonly T[], key: string): T {
  requireThat(values.some(option => option === value), 'invalid_input', `Invalid ${key}`);
  return value as T;
}

export function integer(value: unknown, min: number, max: number, key: string): number {
  requireThat(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'invalid_input', `Invalid ${key}`);
  return value;
}

export function identifier(input: Fields, key: string): string {
  const id = text(input, key, 160);
  requireThat(/^[\p{L}0-9_-][\p{L}0-9_:.!-]*$/u.test(id) && !/^\+?\d{10,15}$/.test(id), 'invalid_input', `Invalid ${key}`);
  return id;
}

export function instant(value: unknown, key: string): number {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(at(value)), 'invalid_window', `Invalid ${key}; provide an ISO timestamp with offset`);
  const [date, clock] = value.split('T');
  requireThat(isDate(date) && Number(clock.slice(0, 2)) < 24, 'invalid_window', `Invalid ${key}`);
  return at(value);
}

export function isDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(at(value)) && iso(at(value)).slice(0, 10) === value;
}

export function windowFrom(input: Fields, now: number, maxDays = 366): [number, number] {
  const start = instant(input.from, 'from'), end = instant(input.to, 'to');
  requireThat(start < end && end - start <= maxDays * DAY && end <= now, 'invalid_window', 'Window must be ordered, in the past, and within the supported range');
  return [start, end];
}

export function nativeTimezone(value: unknown) {
  requireThat(typeof value === 'string' && /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_.+-]+)+)$/.test(value), 'invalid_timezone', 'Use an IANA timezone');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new DomainError('invalid_timezone', 'Use a supported IANA timezone'); }
}

export function nativeDay(date: string, timezone: string): [number, number] {
  requireThat(isDate(date), 'invalid_input', 'date must be a calendar date (YYYY-MM-DD)');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateAt = (time: number) => {
    const parts = formatter.formatToParts(time);
    return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value.padStart(key === 'year' ? 4 : 2, '0')).join('-');
  };
  const midnight = (day: string) => {
    let lo = at(day) - 2 * DAY, hi = at(day) + 2 * DAY;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (dateAt(mid) < day) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const start = midnight(date), end = midnight(iso(at(date) + DAY).slice(0, 10));
  requireThat(start < end, 'invalid_input', 'Calendar date does not exist in this timezone');
  return [start, end];
}

export async function checkUse(ctx: Context, sourceIds: readonly string[], use: typeof uses[number]): Promise<void> {
  choice(use, uses, 'use');
  for (const id of new Set(sourceIds)) {
    const source = await get(ctx, 'data_source', id);
    requireThat(source.data.status !== 'disabled' && source.data.allowed_uses?.[use] === true, 'EGRESS_BLOCKED', 'Data source does not allow this use', 403);
  }
}
