import { createHash } from 'node:crypto';
import { admins, DomainError, text } from '../types.ts';
import type { Context, Entity, Fields } from '../types.ts';
import { checkExecution } from '../planning/index.ts';

export const moduleKey = 'execution';
export const TASK = 'execution_task';
export const ATTEMPT = 'execution_attempt';
export const SLOT = 'account_write_slot';
export const QUOTA = 'quota_reservation';
export const GUARD = 'execution_guard';
const MAX_ATTEMPTS = 4;
export const terminal = new Set(['published', 'cancelled', 'expired', 'failed']);
export const pending = new Set(['dispatched', 'accepted', 'outcome_unknown', 'manual_in_progress']);

export function stableId(...parts: (string | number)[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function scoped(ctx: Context, row: Entity | undefined) {
  return row?.tenant_id === ctx.tenantId && row.workspace_id === ctx.workspaceId ? row : undefined;
}

export async function get(ctx: Context, kind: string, id: string) {
  return scoped(ctx, await ctx.get(moduleKey, kind, id));
}

export async function need(ctx: Context, kind: string, id: string) {
  const row = await get(ctx, kind, id);
  if (!row) throw new DomainError('not_found', `${kind} not found`, 404);
  return row;
}

export async function rows(ctx: Context, kind: string) {
  return (await ctx.list(moduleKey, kind)).filter(row => scoped(ctx, row));
}

export function add(ctx: Context, kind: string, data: Fields, id?: string) {
  return ctx.insert(moduleKey, kind, data, id);
}

export function patch(ctx: Context, row: Entity, data: Fields) {
  if (!scoped(ctx, row) || row.module !== moduleKey) throw new DomainError('not_found', 'Record not found', 404);
  return ctx.update(moduleKey, row.kind, row.id, data, row.version);
}

export function conflict(code: string, message: string): never {
  throw new DomainError(code, message, 409);
}

export function int(input: Fields, key: string, minimum: number, maximum: number, fallback?: number) {
  const value = input[key] ?? fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainError('invalid_input', `Invalid ${key}`);
  }
  return value as number;
}

export function url(input: Fields, key: string) {
  const value = text(input, key, 2048);
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.href;
  } catch { /* Report invalid URLs through the command contract. */ }
  throw new DomainError('invalid_input', `Invalid HTTPS URL for ${key}`);
}

export async function targetFor(ctx: Context, id: string) {
  const target = scoped(ctx, await ctx.get('planning', 'publish_target', id));
  if (!target) throw new DomainError('not_found', 'Publish target not found', 404);
  return target;
}

export function taskId(targetId: string) {
  return stableId(TASK, targetId);
}

export async function taskFor(ctx: Context, input: Fields) {
  return need(ctx, TASK, text(input, 'task_id', 128));
}

export async function activeAttempt(ctx: Context, task: Entity) {
  return task.data.active_attempt_id ? need(ctx, ATTEMPT, task.data.active_attempt_id) : undefined;
}

export async function transition(ctx: Context, task: Entity, status: string, values: Fields = {}) {
  const changed = await patch(ctx, task, { ...values, status });
  await ctx.emit(`execution.task.${status}`, { task_id: task.id, target_id: task.data.target_id, ...values });
  return changed;
}

export async function recordBlock(ctx: Context, task: Entity, code: string, blockers?: unknown) {
  if (task.data.status === 'blocked' && task.data.reason === code &&
    JSON.stringify(task.data.blockers) === JSON.stringify(blockers ?? [])) return task;
  return transition(ctx, task, 'blocked', { reason: code, blockers: blockers ?? [] });
}

export function guardId(ctx: Context) { return stableId(GUARD, ctx.workspaceId); }

export async function guard(ctx: Context) {
  const id = guardId(ctx);
  return (await get(ctx, GUARD, id)) ?? add(ctx, GUARD, { restore_hold: false }, id);
}

// All paths into a new side effect share this version with restore controls.
export async function lockDispatch(ctx: Context) {
  const row = await guard(ctx);
  if (row.data.restore_hold) return false;
  await patch(ctx, row, { checked_at: ctx.now });
  return true;
}

export async function gate(ctx: Context, task: Entity) {
  const target = await targetFor(ctx, task.data.target_id);
  const blockers = (await checkExecution(ctx, target)).blockers;
  if (target.data.status !== 'scheduled' || target.data.frozen_hash !== task.data.frozen_hash) {
    return { task: await recordBlock(ctx, task, 'frozen_target_changed'), target, passed: false };
  }
  if (blockers.length) return { task: await recordBlock(ctx, task, blockers[0].code, blockers), target, passed: false };
  if (task.data.retry_at && Date.parse(ctx.now) < Date.parse(task.data.retry_at)) {
    return { task, target, passed: false };
  }
  const late = Date.parse(ctx.now) - Date.parse(task.data.due_at);
  if (late < 0) return { task: await recordBlock(ctx, task, 'not_due'), target, passed: false };
  const until = task.data.late_override_until ? Date.parse(task.data.late_override_until) : 0;
  if (late > task.data.grace_seconds * 1000 && Date.parse(ctx.now) > until) {
    const stopped = task.data.late_policy === 'notify'
      ? await recordBlock(ctx, task, 'late_awaiting_decision')
      : await transition(ctx, task, 'expired', { reason: 'schedule_window_passed' });
    return { task: stopped, target, passed: false };
  }
  return { task, target, passed: true };
}

export async function assertFence(ctx: Context, attempt: Entity, task: Entity, token: number) {
  const slot = await need(ctx, SLOT, attempt.data.slot_id);
  if (task.data.active_attempt_id !== attempt.id || slot.data.attempt_id !== attempt.id ||
    slot.data.fencing_token !== token || attempt.data.fencing_token !== token) {
    conflict('stale_fence', 'Attempt no longer owns the account write slot');
  }
  return slot;
}

export async function quotaState(ctx: Context, attempt: Entity, status: 'consumed' | 'released') {
  if (!attempt.data.quota_id) return;
  const reservation = await need(ctx, QUOTA, attempt.data.quota_id);
  if (reservation.data.status === 'reserved') {
    await patch(ctx, reservation, { status, finalized_at: ctx.now });
    await ctx.emit(`execution.quota.${status}`, { attempt_id: attempt.id, reservation_id: reservation.id });
  }
}

export async function finish(ctx: Context, task: Entity, attempt: Entity, slot: Entity, args: {
  attemptStatus: string; taskStatus: string; quota: 'consumed' | 'released'; evidence: string; reason?: string;
  extra?: Fields;
}) {
  await quotaState(ctx, attempt, args.quota);
  await patch(ctx, slot, { attempt_id: null });
  await patch(ctx, attempt, { status: args.attemptStatus, evidence: args.evidence, finished_at: ctx.now });
  await ctx.emit(`execution.attempt.${args.attemptStatus}`, { attempt_id: attempt.id, task_id: task.id });
  let status = args.taskStatus;
  if (task.data.cancel_requested_at && status !== 'published') status = 'cancelled';
  if (status === 'retryable' && attempt.data.attempt_no >= MAX_ATTEMPTS) status = 'failed';
  if (task.data.cancel_requested_at && status === 'published') {
    await ctx.emit('execution.task.cancel_failed', { task_id: task.id, attempt_id: attempt.id });
  }
  return transition(ctx, task, status, {
    active_attempt_id: null, last_attempt_id: attempt.id, reason: args.reason ?? null,
    retry_at: status === 'retryable' ? new Date(Date.parse(ctx.now) + 15_000 * 2 ** (attempt.data.attempt_no - 1)).toISOString() : null,
    ...args.extra,
  });
}

export async function recordPost(ctx: Context, task: Entity, attempt: Entity, evidence: {
  external_post_id: string; permalink?: string; evidence: string; verification: 'system_verified' | 'manual_confirmed';
}) {
  const id = stableId('platform_post', task.data.platform, task.data.account_identity, evidence.external_post_id);
  const existing = await get(ctx, 'platform_post', id);
  if (existing && existing.data.target_id !== task.data.target_id) {
    conflict('post_already_linked', 'Platform post already belongs to another target');
  }
  return existing ?? add(ctx, 'platform_post', {
    ...evidence, task_id: task.id, target_id: task.data.target_id, attempt_id: attempt.id,
    account_id: task.data.account_id, social_account_id: task.data.account_id, platform: task.data.platform,
    origin: attempt.data.route === 'manual' ? 'native' : 'system', observed_at: ctx.now,
    recorded_by: ctx.actorId, post_status: 'published',
  }, id);
}

export function authorizeAssigned(ctx: Context, task: Entity) {
  if (task.data.assignee_id !== ctx.actorId && !admins.includes(ctx.role)) {
    throw new DomainError('forbidden', 'Only the assignee or a workspace admin can manage this task', 403);
  }
}

export async function prepare(ctx: Context, task: Entity, route: 'official' | 'manual') {
  if (terminal.has(task.data.status)) return { task };
  const existing = await activeAttempt(ctx, task);
  if (existing) return { task, attempt: existing };
  if (task.data.route !== route) conflict('wrong_route', 'Use the task’s selected execution path');
  if (task.data.restore_review || !await lockDispatch(ctx)) return { task: await recordBlock(ctx, task, 'restore_hold') };
  const checked = await gate(ctx, task);
  if (!checked.passed) return { task: checked.task };
  const number = task.data.attempt_count + 1;
  if (number > MAX_ATTEMPTS) return { task: await transition(ctx, task, 'failed', { reason: 'retry_limit' }) };
  const id = stableId(ATTEMPT, task.id, number);
  const slotId = stableId(SLOT, task.data.platform, task.data.account_identity);
  const previousSlot = await get(ctx, SLOT, slotId);
  if (previousSlot?.data.attempt_id) return { task: await recordBlock(ctx, task, 'account_busy') };
  const token = (previousSlot?.data.fencing_token ?? 0) + 1;
  let quotaId: string | null = null;
  if (route === 'official') {
    const date = ctx.now.slice(0, 10);
    const quotaLimit = checked.target.data.frozen.quota_limit;
    if (!Number.isSafeInteger(quotaLimit) || quotaLimit < 1) {
      return { task: await recordBlock(ctx, task, 'quota_limit_unconfigured') };
    }
    const count = (await rows(ctx, QUOTA)).filter(row => row.data.slot_id === slotId && row.data.date === date && row.data.status !== 'released').length;
    if (count >= quotaLimit) return { task: await recordBlock(ctx, task, 'quota_exhausted') };
    quotaId = stableId(QUOTA, id);
    await add(ctx, QUOTA, { attempt_id: id, slot_id: slotId, date, status: 'reserved' }, quotaId);
    await ctx.emit('execution.quota.reserved', { attempt_id: id, reservation_id: quotaId });
  }
  const slotData = { attempt_id: id, fencing_token: token, account_id: task.data.account_id };
  if (previousSlot) await patch(ctx, previousSlot, slotData);
  else await add(ctx, SLOT, slotData, slotId);
  const status = route === 'official' ? 'prepared' : 'manual_in_progress';
  const attempt = await add(ctx, ATTEMPT, {
    task_id: task.id, target_id: task.data.target_id, attempt_no: number, route, status,
    client_request_id: id, slot_id: slotId, fencing_token: token, quota_id: quotaId,
    lease_until: new Date(Date.parse(ctx.now) + 15 * 60_000).toISOString(), actor_id: ctx.actorId,
  }, id);
  await ctx.emit(`execution.attempt.${status}`, { task_id: task.id, attempt_id: id, fencing_token: token });
  return { task: await transition(ctx, task, status, { active_attempt_id: id, attempt_count: number, reason: null, blockers: [] }), attempt };
}
