import { Problem } from '../../../contracts/src/module.js';

export function instant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Problem(422, 'VALIDATION_FAILED', `${field} requires an ISO timestamp with an offset`);
  }
  localEpoch(value.slice(0, 16));
  return new Date(value).toISOString();
}

function formatter(zone: string) {
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    throw new Problem(422, 'VALIDATION_FAILED', 'Invalid IANA time zone');
  }
}

export function localMinute(at: string | number, zone: string): string {
  return formatter(zone).format(new Date(at)).replace(' ', 'T');
}

function localEpoch(value: string) {
  const ms = Date.parse(`${value}Z`);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 16) !== value) {
    throw new Problem(422, 'VALIDATION_FAILED', 'Invalid local date or time');
  }
  return ms;
}

export function resolveLocal(value: string, zone: string, choice?: unknown) {
  const wall = localEpoch(value);
  const format = formatter(zone);
  const local = (ms: number) => format.format(new Date(ms)).replace(' ', 'T');
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = wall + hours * 3_600_000;
    offsets.add(localEpoch(local(sample)) - sample);
  }
  const matches = (at: number, str: string) => [...offsets].map(offset => at - offset).filter(ms => local(ms) === str).sort((a, b) => a - b);
  const candidates = matches(wall, value);
  if (candidates.length === 1) return { scheduled_at: new Date(candidates[0]).toISOString(), dst_resolution: 'none' };
  if (candidates.length > 1) {
    if (choice !== 'earlier_occurrence' && choice !== 'later_occurrence') {
      throw new Problem(422, 'DST_FOLD', 'Choose which occurrence to schedule', { options: ['earlier_occurrence', 'later_occurrence'] });
    }
    return { scheduled_at: new Date(candidates[choice === 'earlier_occurrence' ? 0 : candidates.length - 1]).toISOString(), dst_resolution: choice };
  }
  if (choice !== 'shift_forward') throw new Problem(422, 'DST_GAP', 'Local time does not exist', { options: ['shift_forward'] });
  for (let minute = 1; minute <= 1440; minute++) {
    const next = wall + minute * 60_000;
    const shifted = matches(next, new Date(next).toISOString().slice(0, 16));
    if (shifted.length) return { scheduled_at: new Date(shifted[0]).toISOString(), dst_resolution: 'shifted_forward' };
  }
  throw new Problem(422, 'DST_GAP', 'No valid local time found in the next day');
}

export function inWindows(windows: unknown, at: string, zone: string): boolean {
  if (!Array.isArray(windows) || !Number.isFinite(Date.parse(at))) return false;
  const [day, time] = localMinute(at, zone).split('T');
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
  const hhmm = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  return windows.some(window => {
    if (!window || typeof window.start !== 'string' || !hhmm.test(window.start) || typeof window.end !== 'string' || !hhmm.test(window.end)) return false;
    const applies = (day: number) => window.dow == null || Array.isArray(window.dow) && window.dow.includes(day);
    if (window.start < window.end) return applies(weekday) && time >= window.start && time < window.end;
    return window.start > window.end && (applies(weekday) && time >= window.start || applies(weekday === 1 ? 7 : weekday - 1) && time < window.end);
  });
}
