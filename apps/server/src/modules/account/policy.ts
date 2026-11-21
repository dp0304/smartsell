import { text, type Context, type Entity, type Fields } from '../types.js';
import { approved, blocks, emit, ensure, get, identifier, integer, list, millis, stopAuto, update, upsert } from './model.js';

export interface PublishedTerms { version: string; text: { 'zh-Hant': string; en: string } }
export interface AutoLimits { max_per_hour: number; min_interval_seconds: number; daily_cap: number }
export type TermsSource = (ctx: Context) => Promise<PublishedTerms | undefined>;
interface Window { days: number[]; start: string; end: string }
const defaults: AutoLimits = { max_per_hour: 2, min_interval_seconds: 300, daily_cap: 5 };
const policyId = 'connector_auto_policy';
const policy = (ctx: Context) => ctx.get('account', 'connector_auto_policy', policyId);

export async function currentTerms(ctx: Context, source?: TermsSource) {
  const terms = await source?.(ctx);
  return terms?.version?.trim() && terms.text?.en?.trim() && terms.text?.['zh-Hant']?.trim() ? terms : undefined;
}

export async function haltGeneration(ctx: Context) {
  return (await policy(ctx))?.data.halt_generation ?? 0;
}

export async function halted(ctx: Context, binding?: Entity) {
  const state = (await policy(ctx))?.data;
  return Boolean(binding?.data.auto_halted || state?.halted_by_workspace || state?.ops_halt_rule_ids?.length);
}

export async function workspaceHalt(ctx: Context, halt: boolean, reason: string, opsRuleId?: string) {
  const before = (await policy(ctx))?.data ?? {};
  const rules = new Set<string>(before.ops_halt_rule_ids ?? []);
  let workspace = before.halted_by_workspace === true;
  if (opsRuleId) {
    if (halt) rules.add(opsRuleId);
    else rules.delete(opsRuleId);
  } else {
    ensure(halt || workspace || !rules.size, 'HALTED_BY_OPS');
    workspace = halt;
  }
  const effective = workspace || rules.size > 0;
  const halt_generation = (before.halt_generation ?? 0) + Number(effective && !before.halted);
  const row = await upsert(ctx, 'connector_auto_policy', policyId, { halted: effective, halted_by_workspace: workspace, ops_halt_rule_ids: [...rules], halt_generation });
  if (Boolean(before.halted) !== effective) {
    await emit(ctx, `connector_auto_policy.${effective ? 'halted' : 'resumed'}`, { source: opsRuleId ? 'ops' : 'workspace', ops_rule_id: opsRuleId ?? null, reason, actor_id: ctx.actorId });
  }
  return row;
}

export async function bindingHalt(ctx: Context, binding: Entity, halt: boolean, reason: string) {
  const result = await update(ctx, binding, { auto_halted: halt,
    auto_generation: (binding.data.auto_generation ?? 0) + Number(halt && !binding.data.auto_halted) });
  if (Boolean(binding.data.auto_halted) !== halt) await emit(ctx, `binding.${halt ? 'auto_halted' : 'auto_resumed'}`, { binding_id: binding.id, reason, actor_id: ctx.actorId });
  return result;
}

function windows(input: Fields): Window[] {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  const value = input.allowed_windows;
  ensure(Array.isArray(value) && value.length >= 1 && value.length <= 28, 'invalid_allowed_windows', 422);
  return value.map((window) => {
    ensure(window && Array.isArray(window.days) && window.days.length >= 1 && window.days.length <= 7 && window.days.every((day: unknown) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6) && typeof window.start === 'string' && typeof window.end === 'string' && time.test(window.start) && (time.test(window.end) || window.end === '24:00') && window.start < window.end, 'invalid_allowed_window', 422);
    return { days: [...new Set<number>(window.days)], start: window.start, end: window.end };
  });
}

export async function enableAuto(ctx: Context, binding: Entity, input: Fields, source: TermsSource | undefined, compatible: boolean, maximum = defaults) {
  approved(input, 'risk_acknowledged');
  const terms = await currentTerms(ctx, source);
  ensure(terms && identifier(input, 'terms_version') === terms.version, 'terms_version_outdated');
  ensure(!await halted(ctx, binding), 'emergency_halt');
  ensure(compatible, 'connector_auto_unavailable');
  ensure(!(await blocks(ctx, binding.id)).length, 'account_blocked');
  const settings = {
    max_per_hour: integer(input, 'max_per_hour', 1, maximum.max_per_hour),
    min_interval_seconds: integer(input, 'min_interval_seconds', maximum.min_interval_seconds, 86400),
    daily_cap: integer(input, 'daily_cap', 1, maximum.daily_cap),
    allowed_windows: windows(input),
  };
  const consent = { auto_ack_by: ctx.actorId, auto_ack_at: ctx.now, auto_ack_terms_version: terms.version, ...settings };
  const result = await update(ctx, binding, { connector_mode: 'auto', ...consent, auto_generation: (binding.data.auto_generation ?? 0) + 1,
    auto_stop_reason: null, auto_stop_block_id: null, auto_stopped_at: null, auto_consecutive_failures: 0 });
  await emit(ctx, 'binding.auto_enabled', { binding_id: binding.id, ...consent });
  return result;
}

export async function recheckTerms(ctx: Context, source?: TermsSource) {
  const terms = await currentTerms(ctx, source);
  ensure(terms, 'terms_unpublished');
  let count = 0;
  for (const binding of await list(ctx, 'account_execution_binding')) {
    if (binding.data.connector_mode === 'auto' && binding.data.auto_ack_terms_version !== terms.version) {
      await stopAuto(ctx, binding, 'terms_outdated', null);
      count++;
    }
  }
  return { count };
}

function localTime(now: number, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), time: `${parts.hour}:${parts.minute}` };
}

export async function autoDecision(ctx: Context, binding: Entity, source: TermsSource | undefined, reserved = false) {
  const data = binding.data;
  if (await halted(ctx, binding)) return { status: 'denied', reason: 'emergency_halt' } as const;
  if (data.connector_mode !== 'auto') return { status: 'denied', reason: 'auto_stopped' } as const;
  const terms = await currentTerms(ctx, source);
  if (!terms || data.auto_ack_terms_version !== terms.version) return { status: 'denied', reason: 'terms_version_outdated' } as const;
  const account = await get(ctx, 'social_account', data.social_account_id);
  const now = millis(ctx);
  const local = localTime(now, account.data.default_timezone);
  if (!(data.allowed_windows as Window[]).some(({ days, start, end }) => days.includes(local.day) && start <= local.time && local.time < end)) {
    return { status: 'denied', reason: 'outside_window' } as const;
  }
  const usage = (data.permit_usage ?? []) as number[];
  if (reserved) return { status: 'granted', usage } as const;
  if (usage.filter((time) => localTime(time, account.data.default_timezone).date === local.date).length >= data.daily_cap) return { status: 'denied', reason: 'daily_cap' } as const;
  const hourly = usage.filter((time) => time + 3600000 > now);
  const nextHourly = hourly.length >= data.max_per_hour ? hourly[hourly.length - data.max_per_hour] + 3600000 : 0;
  const nextInterval = (usage.at(-1) ?? 0) + data.min_interval_seconds * 1000;
  const next = Math.max(nextHourly, nextInterval);
  if (next > now) return { status: 'deferred', reason: nextHourly >= nextInterval ? 'hourly_cap' : 'min_interval', retry_at: new Date(next).toISOString() } as const;
  return { status: 'granted', usage: [...usage.filter((time) => time > now - 172800000), now] } as const;
}

export async function setWorkspaceHalt(ctx: Context, input: Fields, halt: boolean) {
  return workspaceHalt(ctx, halt, text(input, 'reason', 512));
}
