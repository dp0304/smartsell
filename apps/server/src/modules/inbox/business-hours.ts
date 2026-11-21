import { Problem, type Data } from '@smartsell/contracts';

export const minute = 60_000;
const day = 24 * 60 * minute;
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type Window = { start: string; end: string };
export interface Calendar {
  tz: string;
  weekly: Partial<Record<(typeof weekdays)[number], Window[]>>;
  holidays: string[];
  exceptions: Record<string, Window[]>;
}

export function invalid(field: string): never {
  throw new Problem(422, 'INVALID_INPUT', `Invalid ${field}`);
}
export function object(value: unknown, field: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  return value as Data;
}
export function text(value: unknown, field: string, max = 240) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid(field);
  return value.trim();
}
const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);
function date(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || isoDate(Date.parse(value)) !== value) return invalid('calendar date');
  return value;
}
function wallMinutes(value: string) {
  const [hours, mins] = value.split(':').map(Number);
  return hours * 60 + mins;
}
function windows(value: unknown, field: string): Window[] {
  if (!Array.isArray(value) || value.length > 24) return invalid(field);
  const sorted = value.map(entry => {
    const { start, end } = object(entry, field);
    if (typeof start !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start) ||
      typeof end !== 'string' || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(end) || start >= end) return invalid(field);
    return { start, end };
  }).sort((a, b) => a.start.localeCompare(b.start));
  if (sorted.some((entry, index) => index > 0 && entry.start < sorted[index - 1].end)) return invalid(field);
  return sorted;
}
export function weeklyMinutes(calendar: Calendar) {
  return Object.values(calendar.weekly).flat().reduce((sum, { start, end }) => sum + wallMinutes(end) - wallMinutes(start), 0);
}
export function parseCalendar(data: Data, defaultTimezone: string): Calendar {
  const tz = data.tz === undefined ? defaultTimezone : text(data.tz, 'tz', 100);
  try {
    if (/^[+-]/.test(tz)) return invalid('tz');
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch { return invalid('tz'); }
  const weekly = Object.fromEntries(Object.entries(object(data.weekly, 'weekly')).map(([key, value]) => {
    if (!weekdays.some(weekday => weekday === key)) return invalid('weekly weekday');
    return [key, windows(value, `weekly.${key}`)];
  }));
  const holidays = data.holidays === undefined ? [] : data.holidays;
  if (!Array.isArray(holidays) || holidays.length > 366) return invalid('holidays');
  const exceptions = Object.entries(data.exceptions === undefined ? {} : object(data.exceptions, 'exceptions'));
  if (exceptions.length > 366) return invalid('exceptions');
  const calendar = { tz, weekly, holidays: [...new Set(holidays.map(date))].sort(),
    exceptions: Object.fromEntries(exceptions.map(([key, value]) => [date(key), windows(value, `exceptions.${key}`)])) };
  if (!weeklyMinutes(calendar)) return invalid('weekly (at least one opening interval required)');
  return calendar;
}

function zonedFormatter(tz: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}
function localTime(formatter: Intl.DateTimeFormat, instant: number) {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  return Date.parse(`${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
}
export function localDate(instant: number, tz: string) {
  return isoDate(localTime(zonedFormatter(tz), instant));
}

/** Work accrues in UTC elapsed time only where the local wall clock is within an opening interval. */
export function businessClock(calendar: Calendar | null) {
  const formatter = calendar ? zonedFormatter(calendar.tz) : undefined;
  const holidays = new Set(calendar?.holidays);
  const offset = (instant: number) => formatter ? localTime(formatter, instant) - Math.floor(instant / 1000) * 1000 : 0;

  function* openIntervals(from: number, until = Infinity): Generator<[number, number]> {
    for (let midnight = Math.floor(from / day) * day; midnight < until; midnight += day) {
      const next = midnight + day;
      const startOffset = offset(midnight);
      const endOffset = offset(next - 1);
      let transition = next;
      if (startOffset !== endOffset) {
        // Locate the IANA offset transition so repeated times count twice and skipped times count zero.
        let low = midnight / 1000, high = next / 1000;
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (offset(middle * 1000) === startOffset) low = middle;
          else high = middle;
        }
        transition = high * 1000;
      }
      for (const [start, end, shift] of [[midnight, transition, startOffset], [transition, next, endOffset]]) {
        if (start === end) continue;
        for (let localDay = Math.floor((start + shift) / day) * day; localDay < end + shift; localDay += day) {
          const date = isoDate(localDay);
          const opening = calendar!.exceptions[date] ?? (holidays.has(date) ? [] : calendar!.weekly[weekdays[new Date(localDay).getUTCDay()]] ?? []);
          for (const interval of opening) {
            const left = Math.max(from, start, localDay + wallMinutes(interval.start) * minute - shift);
            const right = Math.min(until, end, localDay + wallMinutes(interval.end) * minute - shift);
            if (left < right) yield [left, right];
          }
        }
      }
    }
  }
  return {
    contains(at: number) { return !calendar || !openIntervals(at, at + 1).next().done; },
    add(from: number, remaining: number) {
      if (!calendar || remaining === 0) return from + remaining;
      for (const [start, end] of openIntervals(from)) {
        if (remaining <= end - start) return start + remaining;
        remaining -= end - start;
      }
      throw new Error('Business calendar has no future opening');
    },
    between(from: number, until: number, cap = Infinity) {
      if (until <= from) return 0;
      if (!calendar) return until - from;
      let elapsed = 0;
      for (const [start, end] of openIntervals(from, until)) {
        elapsed += end - start;
        if (elapsed > cap) break;
      }
      return elapsed;
    },
  };
}
