import type { Context, Data, Row } from '@smartsell/contracts';
import { audit, fail, find, integer, iso, object, text, time } from './input.ts';

type TenantPauseContext = Context & { tenantScope?: { list(kind: 'job_pause_rule'): Row[] } };

export interface Terms { version: string; text: string }
export const defaultLimits = { max_per_hour: 2, min_interval_seconds: 120, daily_cap: 8 };
export type Limits = typeof defaultLimits;
export interface Window { start: string; end: string }
const HOUR = 3_600_000;

export function limits(input: Data, ceiling: Limits = defaultLimits): Limits {
  return {
    max_per_hour: integer(input.max_per_hour, 1, ceiling.max_per_hour),
    min_interval_seconds: integer(input.min_interval_seconds, ceiling.min_interval_seconds, 86400),
    daily_cap: integer(input.daily_cap, 1, ceiling.daily_cap),
  };
}

export function windows(value: unknown): Window[] {
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!Array.isArray(value) || value.length < 1 || value.length > 14) fail('INVALID_WINDOWS', 422);
  return value.map(item => {
    const row = object(item);
    const start = text(row.start, 5);
    const end = text(row.end, 5);
    if (!clock.test(start) || !clock.test(end) || start === end) fail('INVALID_WINDOWS', 422);
    return { start, end };
  });
}

export function local(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, clock: `${get('hour')}:${get('minute')}` };
}

const allowed = (clock: string, configured: Window[]) => configured.some(({ start, end }) =>
  start < end ? clock >= start && clock < end : clock >= start || clock < end);

export const policy = (ctx: Context) => find(ctx, 'connector_auto_policy', {});

export function setPolicy(ctx: Context, values: Data) {
  const row = policy(ctx);
  return row ? ctx.update('connector_auto_policy', row.id, values) : ctx.create('connector_auto_policy', values);
}

export function haltSources(ctx: Context, binding?: Row) {
  const row = policy(ctx);
  return [
    ...((Array.isArray(row?.ops_halt_rule_ids) && row.ops_halt_rule_ids.length ||
      (ctx as TenantPauseContext).tenantScope?.list('job_pause_rule').some(rule => rule.active === true &&
        rule.scope === 'connector_auto' && rule.scope_value === 'all' &&
        (!rule.expires_at || Date.parse(String(rule.expires_at)) > time(ctx)))) ? ['ops'] : []),
    ...(row?.halted_by_workspace === true ? ['workspace'] : []),
    ...(binding?.auto_halted === true ? ['account'] : []),
  ];
}

/** Trusted OP service. The caller applies this in each affected workspace. */
export function setOpsHalt(ctx: Context, ruleId: string, halted: boolean) {
  text(ruleId);
  const row = policy(ctx);
  const ids = new Set(Array.isArray(row?.ops_halt_rule_ids) ? row.ops_halt_rule_ids as string[] : []);
  if (halted) ids.add(ruleId);
  else ids.delete(ruleId);
  setPolicy(ctx, { ops_halt_rule_ids: [...ids], halt_generation: Number(row?.halt_generation ?? 0) + 1 });
  audit(ctx, 'account.connector_auto_halt.ops', { halted, rule_id: ruleId });
}

export function autoDenied(ctx: Context, binding: Row, terms: Terms | undefined) {
  const sources = haltSources(ctx, binding);
  if (sources.length) return { decision: 'denied', deny_reason: 'emergency_halt', halt_source: sources[0] } as const;
  if (binding.connector_mode !== 'auto') return { decision: 'denied', deny_reason: 'auto_stopped' } as const;
  if (!terms || binding.auto_ack_terms_version !== terms.version) return { decision: 'denied', deny_reason: 'terms_version_outdated' } as const;
}

function grantTimes(ctx: Context, accountId: string, excludeId?: string) {
  return ctx.list('auto_submit_permit')
    .filter(row => row.social_account_id === accountId && row.id !== excludeId)
    .map(row => Date.parse(String(row.granted_at))).filter(Number.isFinite);
}

export function countAutoGrants(ctx: Context, accountId: string, timezone: string) {
  const day = local(time(ctx), timezone).day;
  return grantTimes(ctx, accountId).filter(at => local(at, timezone).day === day).length;
}

export function evaluatePermit(ctx: Context, binding: Row, account: Row, terms: Terms | undefined, excludeId?: string) {
  const denial = autoDenied(ctx, binding, terms);
  if (denial) return denial;
  const now = time(ctx);
  const zone = String(account.default_timezone);
  const wall = local(now, zone);
  const configured = binding.allowed_windows as Window[];
  if (!allowed(wall.clock, configured)) return { decision: 'denied', deny_reason: 'outside_window' } as const;
  const submissions = grantTimes(ctx, account.id, excludeId).sort((a, b) => a - b);
  if (submissions.filter(at => local(at, zone).day === wall.day).length >= Number(binding.daily_cap)) {
    return { decision: 'denied', deny_reason: 'daily_cap' } as const;
  }
  const recent = submissions.filter(at => at > now - HOUR);
  const interval = (submissions.at(-1) ?? -Infinity) + Number(binding.min_interval_seconds) * 1000;
  const nextHour = recent.length >= Number(binding.max_per_hour) ? recent[recent.length - Number(binding.max_per_hour)] + HOUR : -Infinity;
  const retry = Math.max(interval, nextHour);
  if (retry > now) {
    if (!allowed(local(retry, zone).clock, configured)) return { decision: 'denied', deny_reason: 'outside_window' } as const;
    return { decision: 'deferred', deny_reason: interval >= nextHour ? 'min_interval' : 'hourly_cap', retry_at: iso(retry) } as const;
  }
  return { decision: 'granted' } as const;
}

export function stopAuto(ctx: Context, binding: Row, reason: string, blockId?: string, termsVersion?: string) {
  if (binding.connector_mode !== 'auto') return;
  ctx.update('account_execution_binding', binding.id, {
    connector_mode: 'assist', auto_stopped_at: ctx.now, auto_stop_reason: reason, auto_stop_block_id: blockId ?? null,
    auto_stop_terms_version: termsVersion ?? null,
  });
  ctx.emit('account.binding.auto_stopped', { binding_id: binding.id, social_account_id: binding.social_account_id, reason,
    ...(termsVersion && { terms_version: termsVersion }) });
}

export function recheckTerms(ctx: Context, terms: Terms) {
  for (const binding of ctx.list('account_execution_binding')) {
    if (binding.auto_ack_terms_version !== terms.version) stopAuto(ctx, binding, 'terms_outdated', undefined, terms.version);
  }
}
