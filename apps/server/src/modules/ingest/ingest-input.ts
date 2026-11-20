import { Problem, type Data } from '@smartsell/contracts';

export function invalid(message: string, code = 'INVALID_INPUT'): never {
  throw new Problem(422, code, message);
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} is required`);
  return value.trim();
}
export function object(value: unknown, field: string): Data {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Data;
}
export const asData = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
export const listed = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
export const day = 86_400_000;
export const iso = (time: number) => new Date(time).toISOString();

export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) invalid(`${field} must be an integer in range`);
  return parsed;
}
export function currency(value: unknown): string {
  const code = text(value, 'currency').toUpperCase();
  if (!Intl.supportedValuesOf('currency').includes(code) && !['XAF', 'XCD', 'XOF', 'XPF'].includes(code)) invalid('Expected ISO 4217 currency');
  return code;
}
export function moneyMinor(value: string, code: string): number {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  if (!/^\d+(\.\d+)?$/.test(value)) invalid('Expected a nonnegative decimal amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > digits) invalid(`Amount exceeds ${code} currency precision`);
  return integer(`${whole}${fraction.padEnd(digits, '0')}`, 'amount_minor');
}
export function timezone(value: unknown): string {
  const name = text(value, 'timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: name }); } catch { invalid('Unknown IANA timezone'); }
  return name;
}
export function timestamp(value: unknown, zone?: string): string {
  const input = text(value, 'timestamp');
  const match = /^(\d{4}-\d\d-\d\d)(?:[T ](\d\d:\d\d)(?::(\d\d)(\.\d{1,3})?)?)?(Z|[+-]\d\d:\d\d)?$/.exec(input);
  if (!match) invalid('Expected an ISO date or timestamp');
  const [, date, clock = '00:00', seconds = '00', fraction = '.000', offset] = match;
  const local = `${date}T${clock}:${seconds}${fraction.padEnd(4, '0')}`;
  const naive = Date.parse(`${local}Z`);
  if (!Number.isFinite(naive) || iso(naive).slice(0, -1) !== local) invalid('Invalid calendar timestamp');
  if (offset) {
    const parsed = Date.parse(local + offset);
    if (!Number.isFinite(parsed)) invalid('Invalid timestamp offset');
    return iso(parsed);
  }
  if (!zone) invalid('Timestamp without an offset requires options.timezone');
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const localMs = (time: number) => Date.parse(`${formatter.format(time).replace(' ', 'T')}.000Z`);
  const candidates = new Set<number>();
  for (const sample of [naive - day, naive, naive + day]) {
    const offsetMs = localMs(sample) - Math.floor(sample / 1_000) * 1_000;
    const candidate = naive - offsetMs;
    if (localMs(candidate) === Math.floor(naive / 1_000) * 1_000) candidates.add(candidate);
  }
  if (candidates.size !== 1) invalid('Local timestamp is ambiguous or does not exist; insert an offset');
  return iso([...candidates][0]);
}
export function windowOf(from: unknown, to: unknown) {
  const start = timestamp(from, 'UTC'), end = timestamp(to, 'UTC');
  if (start >= end) invalid('from must precede to');
  return { from: start, to: end };
}
