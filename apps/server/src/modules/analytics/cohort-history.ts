import { factDate } from './validation.ts';

const excludedProviders = new Set(['amazon', 'amazon_sp', 'shopee', 'lazada']);

export function addCalendarMonths(instant: string, months: number): string {
  const date = new Date(instant);
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months, 1);
  const monthEnd = new Date(date);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  return date.toISOString();
}

export function cohortHistory(provider: unknown, start: unknown, cutoff: string, months: number) {
  const excluded = excludedProviders.has(String(provider));
  const candidate = factDate(start);
  const history_coverage_from = candidate && candidate <= cutoff ? candidate : null;
  const history_reliable_from = history_coverage_from ? addCalendarMonths(history_coverage_from, months) : null;
  return { excluded, history_coverage_from, history_reliable_from };
}

export function firstPurchase(when: string, orderIndex: unknown, history: ReturnType<typeof cohortHistory>) {
  if (typeof orderIndex === 'number' && orderIndex > 1) return { knownReturning: true, reason: null };
  if (!history.history_coverage_from) return { knownReturning: false, reason: 'HISTORY_START_UNKNOWN' };
  if (when < history.history_reliable_from!) return { knownReturning: false, reason: 'INSUFFICIENT_ORDER_HISTORY' };
  return { knownReturning: false, reason: orderIndex === 1 ? null : 'FIRST_PURCHASE_UNVERIFIED' };
}

export function cohortLimitations(history: ReturnType<typeof cohortHistory>, queryStart: string) {
  if (history.excluded) return ['PROVIDER_IDENTITY_UNAVAILABLE'];
  if (!history.history_reliable_from) return ['HISTORY_START_UNKNOWN'];
  return queryStart < history.history_reliable_from ? ['INSUFFICIENT_ORDER_HISTORY'] : [];
}

// Infer only from an unbroken, attested orders window covering the requested end.
export function attestedHistoryStart(segments: Iterable<{ status?: unknown; window_start?: unknown; window_end?: unknown }>, end: string) {
  const windows = [...segments].flatMap(segment => {
    const from = factDate(segment.window_start), to = factDate(segment.window_end);
    return from && to && from < to ? [{ from, to, complete: segment.status === 'complete' }] : [];
  }).sort((a, b) => b.to.localeCompare(a.to));
  let start = end;
  for (const window of windows) {
    if (window.complete && window.from < start && window.to >= start) start = window.from;
  }
  for (const window of windows) {
    if (!window.complete && window.from < end && window.to > start) start = window.to > end ? end : window.to;
  }
  return start < end ? start : null;
}
