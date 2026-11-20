import { addDays, dayIn, diffDays, isDay } from '@smartsell/ui';

export const periodPresets = [7, 30, 90] as const;
const maxDays = 366;

export interface Period { from?: string; to?: string; days: number; explicit: boolean }

/**
 * Reads ?from&to (inclusive YYYY-MM-DD). Without a valid pair the request omits them so the server
 * applies its own default in the workspace time zone instead of the browser's.
 */
export function readPeriod(params: URLSearchParams, defaultDays: number): Period {
  const from = params.get('from'), to = params.get('to');
  if (isDay(from) && isDay(to) && from <= to && diffDays(from, to) < maxDays) return { from, to, days: diffDays(from, to) + 1, explicit: true };
  return { days: defaultDays, explicit: false };
}

export const todayIn = (timeZone?: string, now = new Date()) => dayIn(now.toISOString(), timeZone);

export function presetRange(days: number, today: string) {
  return { from: addDays(today, -(days - 1)), to: today };
}

/** The preset a period corresponds to, or null for a custom range. */
export function activePreset(period: Period, today: string): number | null {
  if (!period.explicit) return period.days;
  return period.to === today && (periodPresets as readonly number[]).includes(period.days) ? period.days : null;
}

export function withPeriod(params: URLSearchParams, days: number, today: string, defaultDays: number) {
  const next = new URLSearchParams(params);
  if (days === defaultDays) { next.delete('from'); next.delete('to'); return next; }
  const range = presetRange(days, today);
  next.set('from', range.from);
  next.set('to', range.to);
  return next;
}
