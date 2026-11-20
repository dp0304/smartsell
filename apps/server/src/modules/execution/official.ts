import type { Context, Entity, Fields } from '../types.ts';
import { admins, DomainError } from '../types.ts';
import {
  activeAttempt, add, assertFence, conflict, finish, gate, int, lockDispatch, need, patch,
  QUOTA, recordPost, rows, TASK, transition, url,
} from './state.ts';

export interface OfficialRequest {
  tenant_id: string;
  workspace_id: string;
  account_id: string;
  account_identity: string;
  platform: string;
  target_id: string;
  attempt_id: string;
  fencing_token: number;
  client_request_id: string;
  frozen_hash: string;
  frozen: Readonly<Fields>;
}

export type OfficialReceipt =
  | { status: 'accepted' | 'unknown'; receipt_id?: string; code?: string }
  | { status: 'not_submitted'; code: string; evidence: string };
export type OfficialObservation =
  | { status: 'pending' | 'unknown'; code?: string }
  | { status: 'published'; external_post_id: string; permalink?: string; evidence: string }
  | { status: 'verified_absent'; evidence: string; no_pending_submission: true; visibility_window_elapsed: true }
  | { status: 'failed' | 'cancelled'; evidence: string };

export interface OfficialAdapter {
  // This is the only callback allowed to submit. Resolve credentials using the scoped request IDs.
  submit(request: OfficialRequest): Promise<OfficialReceipt>;
  // Read-only. Missing capability or inconclusive matching must return unknown, not verified_absent.
  observe(request: OfficialRequest, receiptId?: string): Promise<OfficialObservation>;
}

export interface CommittedTransactions {
  // Resolve only after commit. Bind every call to the same workspace and a privileged service principal.
  run<T>(work: (ctx: Context) => Promise<T>): Promise<T>;
}

function adapterText(value: unknown, max = 4096) {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
}

function adapterCode(value: unknown, fallback: string) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function service(ctx: Context) {
  if (!admins.includes(ctx.role)) throw new DomainError('forbidden', 'Official worker requires workspace admin authority', 403);
}

function requestOf(ctx: Context, task: Entity, attempt: Entity, frozen: Fields): OfficialRequest {
  return {
    tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId, account_id: task.data.account_id,
    account_identity: task.data.account_identity, platform: task.data.platform, target_id: task.data.target_id,
    attempt_id: attempt.id, fencing_token: attempt.data.fencing_token, client_request_id: attempt.data.client_request_id,
    frozen_hash: task.data.frozen_hash, frozen: structuredClone(frozen),
  };
}

export function createOfficialWorker(transactions: CommittedTransactions, adapters: ReadonlyMap<string, OfficialAdapter>) {
  const registry = new Map(adapters);

  return {
    async dispatch(taskId: string, fence: number) {
      const claim = await transactions.run(async ctx => {
        service(ctx);
        const task = await need(ctx, TASK, taskId);
        const attempt = await activeAttempt(ctx, task);
        if (!attempt || attempt.data.route !== 'official' || attempt.data.status !== 'prepared') return { task };
        const slot = await assertFence(ctx, attempt, task, int({ fence }, 'fence', 1, Number.MAX_SAFE_INTEGER));
        const stop = (reason: string, status = 'blocked') => finish(ctx, task, attempt, slot, {
          attemptStatus: 'abandoned', taskStatus: status, quota: 'released', reason, evidence: reason,
        });
        if (Date.parse(ctx.now) >= Date.parse(attempt.data.lease_until)) return { task: await stop('preparation_lease_expired', 'retryable') };
        if (!await lockDispatch(ctx)) return { task };
        const checked = await gate(ctx, task);
        if (!checked.passed) {
          const ended = await finish(ctx, checked.task, attempt, slot, {
            attemptStatus: 'abandoned', taskStatus: checked.task.data.status, quota: 'released',
            evidence: checked.task.data.reason ?? 'Dispatch gate rejected', reason: checked.task.data.reason,
          });
          return { task: ended };
        }
        if (!registry.has(task.data.adapter_key)) {
          const reason = 'official_adapter_unconfigured';
          const handover = await add(ctx, 'execution_handover', { task_id: task.id, from_route: 'official', to_route: 'manual', reason, assignee_id: task.data.assignee_id });
          await ctx.emit('execution.handover.completed', { task_id: task.id, handover_id: handover.id });
          return { task: await finish(ctx, task, attempt, slot, {
            attemptStatus: 'abandoned', taskStatus: 'scheduled', quota: 'released', evidence: reason, reason, extra: { route: 'manual' },
          }) };
        }
        const reservation = await need(ctx, QUOTA, attempt.data.quota_id);
        const day = ctx.now.slice(0, 10);
        if (reservation.data.date !== day) {
          const count = (await rows(ctx, QUOTA)).filter(row => row.data.slot_id === slot.id && row.data.date === day && row.data.status !== 'released').length;
          if (count >= checked.target.data.frozen.quota_limit) return { task: await stop('quota_exhausted') };
          await patch(ctx, reservation, { date: day });
        }
        await patch(ctx, attempt, {
          status: 'dispatched', submitted_at: ctx.now,
          lease_until: new Date(Date.parse(ctx.now) + 15 * 60_000).toISOString(),
        });
        const updated = await transition(ctx, task, 'dispatched');
        await ctx.emit('execution.attempt.dispatched', { task_id: task.id, attempt_id: attempt.id });
        return { task: updated, adapterKey: task.data.adapter_key as string, request: requestOf(ctx, task, attempt, checked.target.data.frozen) };
      });
      if (!claim.request) return { task: claim.task };
      const request = claim.request;
      let receipt: OfficialReceipt;
      try {
        receipt = await registry.get(claim.adapterKey)!.submit(request);
      } catch {
        receipt = { status: 'unknown', code: 'submit_transport_error' };
      }
      return transactions.run(async ctx => {
        service(ctx);
        if (ctx.tenantId !== request.tenant_id || ctx.workspaceId !== request.workspace_id) conflict('scope_changed', 'Worker transaction scope changed');
        const task = await need(ctx, TASK, taskId);
        const attempt = await activeAttempt(ctx, task);
        if (!attempt || attempt.id !== request.attempt_id || attempt.data.status !== 'dispatched') return { task };
        const slot = await assertFence(ctx, attempt, task, fence);
        if (receipt?.status === 'not_submitted' && adapterText(receipt.evidence)) {
          const reason = adapterCode(receipt.code, 'pre_submit_failed');
          return { task: await finish(ctx, task, attempt, slot, {
            attemptStatus: 'rejected', taskStatus: ['transient', 'rate_limited'].includes(reason) ? 'retryable' : 'blocked',
            quota: 'released', reason, evidence: receipt.evidence,
          }) };
        }
        const receiptId = receipt && 'receipt_id' in receipt ? adapterText(receipt.receipt_id, 1024) : undefined;
        const status = receipt?.status === 'accepted' && receiptId ? 'accepted' : 'outcome_unknown';
        const reason = status === 'accepted' ? null : adapterCode(receipt?.code, 'submit_outcome_unknown');
        const updated = await patch(ctx, attempt, { status, reason, receipt_id: receiptId ?? null });
        await ctx.emit(`execution.attempt.${status}`, { task_id: task.id, attempt_id: attempt.id, reason });
        return { task: await transition(ctx, task, task.data.cancel_requested_at ? 'cancel_pending' : status, { reason }), attempt: updated };
      });
    },

    async verify(taskId: string) {
      const claim = await transactions.run(async ctx => {
        service(ctx);
        const task = await need(ctx, TASK, taskId);
        const attempt = await activeAttempt(ctx, task);
        if (!attempt || attempt.data.route !== 'official' || !['accepted', 'outcome_unknown'].includes(attempt.data.status)) return { task };
        const target = await ctx.get('planning', 'publish_target', task.data.target_id);
        if (!target || target.workspace_id !== ctx.workspaceId || target.tenant_id !== ctx.tenantId || target.data.frozen_hash !== task.data.frozen_hash) {
          conflict('frozen_target_changed', 'Frozen request could not be recovered');
        }
        await assertFence(ctx, attempt, task, attempt.data.fencing_token);
        return { task, key: task.data.adapter_key as string, request: requestOf(ctx, task, attempt, target.data.frozen), receiptId: attempt.data.receipt_id as string | undefined };
      });
      if (!claim.request) return { task: claim.task };
      const request = claim.request;
      const adapter = registry.get(claim.key);
      let observation: OfficialObservation;
      try {
        observation = adapter ? await adapter.observe(request, claim.receiptId ?? undefined) : { status: 'unknown', code: 'official_adapter_unconfigured' };
      } catch {
        observation = { status: 'unknown', code: 'observe_transport_error' };
      }
      return transactions.run(async ctx => {
        service(ctx);
        if (ctx.tenantId !== request.tenant_id || ctx.workspaceId !== request.workspace_id) conflict('scope_changed', 'Worker transaction scope changed');
        const task = await need(ctx, TASK, taskId);
        const attempt = await activeAttempt(ctx, task);
        if (!attempt || attempt.id !== request.attempt_id) return { task };
        const slot = await assertFence(ctx, attempt, task, request.fencing_token);
        const evidence = observation && 'evidence' in observation ? adapterText(observation.evidence) : undefined;
        let result = observation?.status ?? 'unknown';
        let found: { external_post_id: string; permalink?: string } | undefined;
        if (observation?.status === 'published' && evidence) {
          const id = adapterText(observation.external_post_id, 256);
          try {
            if (id) found = { external_post_id: id, ...(observation.permalink ? { permalink: url(observation, 'permalink') } : {}) };
          } catch { /* Malformed provider evidence remains unresolved. */ }
          if (!found) result = 'unknown';
        } else if (result === 'published') result = 'unknown';
        if (!evidence && ['failed', 'cancelled', 'verified_absent'].includes(result)) result = 'unknown';
        if (observation?.status === 'verified_absent' && (observation.no_pending_submission !== true || observation.visibility_window_elapsed !== true)) result = 'unknown';
        const code = observation && 'code' in observation ? adapterCode(observation.code, 'verification_inconclusive') : 'verification_inconclusive';
        await add(ctx, 'verify_attempt', { task_id: task.id, attempt_id: attempt.id, status: result, evidence: evidence ?? null, code: result === 'unknown' ? code : null });
        if (found && evidence) {
          const post = await recordPost(ctx, task, attempt, { ...found, evidence, verification: 'system_verified' });
          return { task: await finish(ctx, task, attempt, slot, {
            attemptStatus: 'verified_published', taskStatus: 'published', quota: 'consumed', evidence,
            extra: { post_id: post.id, restore_review: false },
          }), post };
        }
        if (evidence && (result === 'verified_absent' || result === 'failed' || result === 'cancelled')) {
          const next = result === 'verified_absent' ? 'retryable' : result;
          return { task: await finish(ctx, task, attempt, slot, {
            attemptStatus: `verified_${result.replace('verified_', '')}`, taskStatus: next, quota: 'consumed', evidence,
            extra: { restore_review: false },
          }) };
        }
        await ctx.emit('execution.verification.inconclusive', { task_id: task.id, attempt_id: attempt.id, result, code });
        const next = task.data.cancel_requested_at ? 'cancel_pending' : result === 'pending' ? task.data.status : 'outcome_unknown';
        return { task: await transition(ctx, task, next, { reason: result === 'pending' ? 'platform_processing' : code }), attempt };
      });
    },
  };
}
