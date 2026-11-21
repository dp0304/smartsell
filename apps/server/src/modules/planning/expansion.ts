import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { entries, list, localMinute, resolveLocal, time } from '../../../../../packages/domain/src/publishing/index.js';

export const DAY = 86_400_000;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const minuteRe = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const invalid = (field: string): never => { throw new Problem(422, 'VALIDATION_FAILED', `Invalid ${field}`); };
export function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !dateRe.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) return invalid(field);
  return value;
}
export function minute(value: unknown, field: string): string {
  if (typeof value !== 'string' || !minuteRe.test(value)) return invalid(field);
  return value;
}
export function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return invalid(field);
  return value;
}
export function dayAt(day: string, delta: number) { return new Date(Date.parse(day) + delta * DAY).toISOString().slice(0, 10); }
export function dow(day: string) { return new Date(day).getUTCDay() || 7; }

export function recurringDates(ctx: Context, rule: Row) {
  const zone = String(rule.tz);
  const start = String(rule.starts_on);
  const today = localMinute(ctx.now, zone).slice(0, 10);
  const dates: { day: string; local: string; at: string; choice?: string }[] = [];
  for (let i = 0; i < Number(rule.horizon_days); i++) {
    const day = dayAt(today, i);
    if (day < start || rule.ends_on && day > String(rule.ends_on) || list(rule.exceptions).includes(day)) continue;
    const rrule = rule.rrule as Data;
    if (rrule.freq === 'weekly' && !list(rrule.byday).includes(dow(day))) continue;
    const local = `${day}T${rrule.local_time}`;
    let choice: string | undefined;
    try { resolveLocal(local, zone); }
    catch (error) {
      if (!(error instanceof Problem)) throw error;
      if (error.code === 'DST_FOLD') choice = rule.dst_policy === 'later_occurrence' ? 'later_occurrence' : 'earlier_occurrence';
      else if (error.code === 'DST_GAP') { if (rule.dst_policy === 'skip') continue; choice = 'shift_forward'; }
      else throw error;
    }
    const at = resolveLocal(local, zone, choice).scheduled_at;
    if (time(at) >= time(ctx.now)) dates.push({ day, local, at, choice });
  }
  return dates;
}

export function queueSlots(ctx: Context, queue: Row) {
  const slots: { social_account_id: string; at: string; tz: string }[] = [];
  for (const slot of entries(queue.slots)) {
    const zone = String(slot.tz);
    const today = localMinute(ctx.now, zone).slice(0, 10);
    for (let i = 0; i < Number(queue.horizon_days); i++) {
      const day = dayAt(today, i);
      if (slot.weekday !== dow(day)) continue;
      const local = `${day}T${slot.local_time}`;
      let at: string;
      try { at = resolveLocal(local, zone, 'earlier_occurrence').scheduled_at; }
      catch (error) {
        if (!(error instanceof Problem) || error.code !== 'DST_GAP') throw error;
        at = resolveLocal(local, zone, 'shift_forward').scheduled_at;
      }
      if (time(at) >= time(ctx.now) && (!queue.expires_at || time(at) < time(queue.expires_at))) slots.push({ social_account_id: String(slot.social_account_id), at, tz: zone });
    }
  }
  return [...new Map(slots.sort((a, b) => time(a.at) - time(b.at)).map(slot => [JSON.stringify([slot.social_account_id, slot.at]), slot])).values()];
}

export function similarity(left: string, right: string) {
  const grams = (text: string) => {
    const normalized = `  ${text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}  `;
    return new Set(Array.from({ length: normalized.length - 2 }, (_, i) => normalized.slice(i, i + 3)));
  };
  if (!left.trim() || !right.trim()) return 0;
  const a = grams(left), b = grams(right);
  return [...a].filter(value => b.has(value)).length / new Set([...a, ...b]).size;
}
