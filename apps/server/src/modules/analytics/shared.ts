import { admins, DomainError, type Context, type Commands, type Entity, type Fields } from '../types.js';

export const moduleKey = 'analytics';
export const revenueRoles = ['owner', 'admin', 'editor'] as const;
export function invalid(message: string): never { throw new DomainError('invalid_input', message); }
export function state(message: string): never { throw new DomainError('invalid_state', message, 409); }
export function object(value: unknown, field: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${field}`);
  return value as Fields;
}
export function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (!choices.includes(value as T)) invalid(`Invalid ${field}`);
  return value as T;
}
export function integer(value: unknown, field: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) invalid(`Invalid ${field}`);
  return value as number;
}
export function strings(value: unknown, field: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 200)) invalid(`Invalid ${field}`);
  return [...new Set(value.map(x => x.trim()))];
}
function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}
export function date(value: unknown, field: string): string {
  if (!isDate(value)) invalid(`Invalid ${field}`);
  return value;
}
export function instant(value: unknown, field: string): string {
  if (isDate(value)) return `${value}T00:00:00.000Z`;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !isDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) invalid(`Invalid ${field}`);
  return new Date(value).toISOString();
}
export const currentTime = (ctx: Context) => instant(ctx.now, 'now');
export function timeZone(value: unknown = 'UTC'): string {
  if (typeof value !== 'string') invalid('Invalid time zone');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return invalid('Invalid time zone'); }
}
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
export function localDay(when: string | number, tz: string): string {
  let formatter = dateFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(tz, formatter);
  }
  const parts = formatter.formatToParts(new Date(when));
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key)?.value).join('-');
}
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(day) + days * 86_400_000).toISOString().slice(0, 10);
}
export function dayStart(day: string, tz: string): number {
  const utc = Date.parse(day);
  let lo = utc - 36 * 3600_000;
  let hi = utc + 36 * 3600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDay(mid, tz) < day) lo = mid; else hi = mid;
  }
  return hi;
}
export function period(value: unknown) {
  const data = object(value, 'period');
  const tz = timeZone(data.tz);
  const from = isDate(data.from) ? new Date(dayStart(data.from, tz)).toISOString() : instant(data.from, 'from');
  const to = isDate(data.to) ? new Date(dayStart(data.to, tz)).toISOString() : instant(data.to, 'to');
  if (from >= to || Date.parse(to) - Date.parse(from) > 3 * 366 * 86_400_000) invalid('Period must be increasing and at most three years');
  return { from, to, tz };
}
export type Period = ReturnType<typeof period>;
export const inPeriod = (when: string, range: Period) => when >= range.from && when < range.to;
export function cutoff(ctx: Context, value: unknown): string {
  const now = currentTime(ctx);
  if (value === undefined) return now;
  const parsed = instant(value, 'data_cutoff_at');
  if (parsed > now) invalid('Cutoff cannot be in the future');
  return parsed;
}
export const visibleAt = (row: Entity, asOf: string) => instant(row.created_at, 'created_at') <= asOf;
export const ref = (row: Entity) => ({ module: row.module, kind: row.kind, id: row.id, version: row.version });

export function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value) || !Intl.supportedValuesOf('currency').includes(value)) invalid('Invalid ISO currency');
  return value;
}
const digits = new Map<string, number>();
function minorDigits(code: string): number {
  let count = digits.get(code);
  if (count === undefined) {
    count = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits!;
    digits.set(code, count);
  }
  return count;
}
function rateParts(rate: unknown): [bigint, bigint] {
  if ((typeof rate !== 'number' && typeof rate !== 'string') || !/^\d{1,12}(?:\.\d{1,12})?$/.test(String(rate))) invalid('FX rate must be a positive decimal with up to 12 decimal places');
  const [whole, fraction = ''] = String(rate).split('.');
  const amount = BigInt(whole + fraction);
  if (amount === 0n) invalid('FX rate must be positive');
  return [amount, 10n ** BigInt(fraction.length)];
}
export function roundDivision(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) return -roundDivision(-numerator, denominator);
  return (2n * numerator + denominator) / (2n * denominator);
}
export function safeNumber(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new DomainError('amount_overflow', 'Amount exceeds supported minor-unit range');
  return result;
}
export async function ratesAt(ctx: Context, asOf: string): Promise<Entity[]> {
  return [...await ctx.list(moduleKey, 'fx_rate'), ...await ctx.list('core', 'fx_rate')]
    .filter(row => visibleAt(row, asOf))
    .sort((a, b) => instant(b.created_at, 'created_at').localeCompare(instant(a.created_at, 'created_at')) || (b.data.revision ?? 0) - (a.data.revision ?? 0) || b.id.localeCompare(a.id));
}
export function convertMinor(amount: number, from: string, to: string, day: string, rates: Entity[]) {
  if (from === to) return { amount_minor: amount, fx: null };
  const rate = rates.find(row => row.data.from_currency === from && row.data.to_currency === to && row.data.date === day);
  if (!rate) return { amount_minor: null, fx: null };
  const [n, d] = rateParts(rate.data.rate);
  const scaled = roundDivision(BigInt(amount) * n * 10n ** BigInt(minorDigits(to)), d * 10n ** BigInt(minorDigits(from)));
  return { amount_minor: safeNumber(scaled), fx: { ...ref(rate), date: day, rate: String(rate.data.rate), from_currency: from, to_currency: to } };
}
export const fxCommands: Commands = {
  set_fx_rate: { roles: admins, async run(ctx, input) {
    const from_currency = currency(input.from_currency);
    const to_currency = currency(input.to_currency);
    if (from_currency === to_currency) invalid('FX requires distinct currencies');
    const day = date(input.date, 'date');
    rateParts(input.rate);
    const rate = String(input.rate);
    const prior = (await ratesAt(ctx, currentTime(ctx))).find(r => r.data.from_currency === from_currency && r.data.to_currency === to_currency && r.data.date === day);
    if (prior?.data.rate === rate) return prior;
    const revision = (prior?.data.revision ?? 0) + 1;
    const row = await ctx.insert(moduleKey, 'fx_rate', { from_currency, to_currency, date: day, rate, revision, supersedes_id: prior?.id ?? null }, `${from_currency}:${to_currency}:${day}:${revision}`);
    await ctx.emit('analytics.fx_rate.recorded', { fx_rate_id: row.id, from_currency, to_currency, date: day, revision });
    return row;
  } },
};
