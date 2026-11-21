import { Problem, type Data, type Row } from '@smartsell/contracts';
import { dayStart } from './shared.ts';

export function invalid(message: string): never { throw new Problem(400, 'invalid_analytics_input', message); }
export function conflict(message: string): never { throw new Problem(409, 'analytics_conflict', message); }
export function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object');
  return value as Data;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 10000) invalid(`Invalid ${field}`);
  return value.trim();
}
export function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (!choices.includes(value as T)) invalid(`Invalid ${field}`);
  return value as T;
}
export function array(value: unknown, field: string, limit = 500): unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid(`Invalid ${field}`);
  return value;
}
export function strings(value: unknown, field: string, limit = 100): string[] {
  return [...new Set(array(value, field, limit).map(item => text(item, field)))];
}
export function date(value: unknown): string {
  const input = text(value, 'timestamp');
  if (!/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))?$/.test(input)
      || !Number.isFinite(Date.parse(input)) || new Date(input.slice(0, 10)).toISOString().slice(0, 10) !== input.slice(0, 10)) {
    invalid('Expected a valid ISO date or timestamp with offset');
  }
  return new Date(input).toISOString();
}
export function timezone(value: unknown): string {
  const tz = text(value, 'timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { invalid('Invalid timezone'); }
  return tz;
}
export function period(value: unknown) {
  const input = object(value);
  const tz = timezone(input.tz ?? 'UTC');
  const bound = (value: unknown) => {
    const normalized = date(value);
    return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) ? new Date(dayStart(value, tz)).toISOString() : normalized;
  };
  const from = bound(input.from), to = bound(input.to);
  if (from >= to) invalid('Expected from before to');
  return { from, to, tz };
}
export function localDay(instant: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)?.value).join('-');
}
export function fields(row: Data, keys: readonly string[]): Data {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
}
export function dto(row: Row, keys: readonly string[]): Data {
  return fields(row, ['id', 'version', 'created_at', 'updated_at', ...keys]);
}
export function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
export function minor(value: unknown): value is number { return finite(value) && Number.isSafeInteger(value) && value >= 0; }
export function currency(value: unknown): string {
  const code = text(value, 'currency');
  if (!/^[A-Z]{3}$/.test(code)) invalid('Expected a three-letter currency code');
  return code;
}
export function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value.length ? value : undefined; }
export function factDate(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}
export function visibleAt(row: Row, cutoff: string): boolean { return (factDate(row.created_at) ?? '') <= cutoff; }
export function inPeriod(value: unknown, range: { from: string; to: string }): boolean {
  const instant = factDate(value);
  return instant !== undefined && instant >= range.from && instant < range.to;
}
