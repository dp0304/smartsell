import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { closeTarget, localMinute } from '../../../../../packages/domain/src/publishing/index.js';
import { ATTEMPT, FINAL, SLOT, TASK, isWorkerTask, after, availableWriteSlot, blockExecution, executionCheck, conflict, confirmCancellation, endAttempt, fence, find, holdWriteSlot, late, matchingPost, openAttempt, optional, pending, publish,
  activeVerification, attachEvidence, requestVerification, settleConnector, settleVerification, status, step, targetOf, text, time, transition, uncertain, url, verificationDelay } from './service.js';
import { handover, retry } from './ops.js';
import { isJobPaused } from '../ops/controls.js';
import { getLicenseState } from '../ops/metering.js';
import { dispatchConnector, type ConnectorDispatch } from './connector.js';

export interface Submission {
  task_id: string;
  social_account_id: string;
  client_request_id: string;
  request_hash: string;
  submission_started_at?: string;
  frozen: Data;
}
type Receipt = { status: 'accepted'; reference: string; processing?: 'processing' | 'awaiting_creator_action' | 'scheduled_on_platform' }
  | { status: 'unknown'; reason?: string; reference?: string }
  | { status: 'not_submitted'; error_class: 'transient' | 'rate_limited' | 'auth_expired' | 'quota_exhausted' | 'invalid_input'; evidence: string };
type Observation = { status: 'published'; external_post_id: string; permalink?: string; visibility?: 'public' | 'private' | 'unlisted' }
  | { status: 'absent'; complete_window: boolean; delay_elapsed: boolean }
  | { status: 'failed' | 'cancelled'; evidence: string }
  | { status: 'pending'; processing: 'processing' | 'under_review' | 'scheduled_on_platform' | 'published_limited' | 'awaiting_creator_action' }
  | { status: 'inconclusive' };
export interface ExecutionAdapter {
  provider: string;
  /** Prepare local media only. External effects must pass through submit. */
  prepare?(request: Submission): Promise<void>;
  submit(request: Submission): Promise<Receipt>;
  /** Request withdrawal only for a platform-native scheduled post. Observe must independently confirm the result. */
  cancelScheduled?(request: Submission, receipt: string): Promise<void>;
  /** Read-only. Report complete absence only once no remote request can still publish. */
  observe(request: Submission, receipt: string | undefined): Promise<Observation>;
  /** Independently match an owned-account publication after a connector attempt. */
  observeConnector?(request: Submission, candidate: Data | undefined): Promise<Observation>;
}
/** A transaction must commit before resolving, including at the submission boundary. */
export type Transact = <T>(action: (ctx: Context) => T) => Promise<T>;
const submission = (task: Row, attempt: Row): Submission => ({ task_id: task.id, social_account_id: String(task.social_account_id),
  client_request_id: String(attempt.client_request_id), request_hash: String(attempt.request_hash),
  submission_started_at: optional(attempt.submission_started_at), frozen: structuredClone(task.frozen as Data) });

function dispatchPaused(ctx: Context, task: Row) {
  const account = find(ctx, 'social_account', task.social_account_id);
  return ['read_only', 'terminated'].includes(getLicenseState(ctx)) || isJobPaused(ctx, {
    queue: 'publish', task_kind: 'publish', side_effect: true,
    provider: optional(account?.provider ?? account?.platform),
  });
}

export function createExecutionWorker(transact: Transact, adapters: readonly ExecutionAdapter[] = [], connector?: ConnectorDispatch) {
  const configured = new Map(adapters.map(adapter => [adapter.provider, adapter]));
  function adapterFor(ctx: Context, task: Row) {
    const account = ctx.get('social_account', String(task.social_account_id));
    return configured.get(String(account.provider ?? account.platform)) ?? configured.get(String((task.frozen as Data).platform));
  }
  function attemptAdapter(ctx: Context, task: Row, attempt: Row) {
    return attempt.adapter_provider ? configured.get(String(attempt.adapter_provider)) : adapterFor(ctx, task);
  }
  function verifyFence(ctx: Context, task: Row, attempt: Row) {
    const slot = ctx.list(SLOT).find(row => row.holder_id === attempt.id && row.fencing_token === attempt.write_slot_fencing_token);
    return task.active_attempt_id === attempt.id && task.fencing_token === attempt.fencing_token && slot && time(slot.lease_expires_at) > time(ctx.now);
  }
  const worker = {
    async dispatch(taskId: string) {
      const claim = await transact(ctx => {
        const task = ctx.get(TASK, taskId);
        // §5.2: Worker-route tasks belong to the job engine (modules/worker); this executor never dispatches them.
        if (isWorkerTask(task)) return undefined;
        if (task.schedule_kind === 'manual_date' || !['scheduled', 'queued'].includes(status(task)) || (!task.run_requested_at && time(task.due_at) > time(ctx.now)) || time(task.next_retry_at) > time(ctx.now)) return undefined;
        if (pending(ctx, task) || task.active_attempt_id || dispatchPaused(ctx, task)) return;
        const check = executionCheck(ctx, task);
        if (check.reason) { blockExecution(ctx, task, check); return; }
        if (late(ctx, task)) return;
        const adapter = adapterFor(ctx, task);
        const route = check.assessment?.route;
        if (route === 'connector' && connector) {
          try {
            if (dispatchConnector(ctx, task, connector)) return;
          } catch (error) {
            if (!(error instanceof Problem) || error.code !== 'ACCOUNT_BUSY') throw error;
            ctx.update(TASK, task.id, { next_retry_at: after(ctx, 15) });
            return;
          }
        }
        if (!adapter || route !== 'api') {
          const reason = route === 'api' ? 'no_configured_adapter' : 'manual_fallback';
          transition(ctx, task, 'manual', reason, { route: [{ executor: 'manual', reason }], sub_status: 'awaiting_assignee' });
          return;
        }
        let attempt: Row;
        try { ({ attempt } = openAttempt(ctx, task, 'api', 'execution_worker')); }
        catch (error) {
          if (!(error instanceof Problem) || error.code !== 'ACCOUNT_BUSY') throw error;
          ctx.update(TASK, task.id, { next_retry_at: after(ctx, 15) });
          return;
        }
        attempt = ctx.update(ATTEMPT, attempt.id, { adapter_provider: adapter.provider });
        ctx.update(TASK, task.id, { route: [{ executor: 'api', provider: adapter.provider }] });
        return { adapter, attemptId: attempt.id, request: submission(task, attempt) };
      });
      if (!claim) return;
      const { adapter, request, attemptId } = claim;
      try { await adapter.prepare?.(structuredClone(request)); }
      catch {
        return transact(ctx => {
          const task = ctx.get(TASK, taskId), attempt = ctx.get(ATTEMPT, attemptId);
          if (!verifyFence(ctx, task, attempt) || attempt.status !== 'claimed') return task;
          endAttempt(ctx, attempt, 'rejected', { pre_submit_failure: true, error_class: 'prepare_failed' });
          const count = Number(task.auto_retry_count);
          ctx.emit('execution.attempt.failed', { task_id: taskId, attempt_id: attemptId, error_class: 'prepare_failed' });
          return retryPreSubmit(ctx, task, 'prepare_failed', count);
        });
      }
      const begin = await transact(ctx => {
        const task = ctx.get(TASK, taskId), attempt = ctx.get(ATTEMPT, attemptId);
        if (!verifyFence(ctx, task, attempt) || attempt.status !== 'claimed') return false;
        if (dispatchPaused(ctx, task)) {
          endAttempt(ctx, attempt, 'abandoned', { pre_submit_failure: true });
          transition(ctx, task, 'queued', 'job_paused', fence(task));
          return false;
        }
        const check = executionCheck(ctx, task);
        if (check.reason || check.assessment?.route !== 'api') {
          endAttempt(ctx, attempt, 'abandoned', { pre_submit_failure: true });
          blockExecution(ctx, task, check.reason ? check : { reason: 'route_changed' }, fence(task));
          return false;
        }
        const delayed = late(ctx, task);
        if (delayed) {
          endAttempt(ctx, attempt, 'abandoned', { pre_submit_failure: true });
          ctx.update(TASK, task.id, fence(task));
          return false;
        }
        step(ctx, attempt, 'prepare_media');
        step(ctx, attempt, 'submit', { submission_intent: true });
        const started = ctx.update(ATTEMPT, attempt.id, { status: 'in_progress', side_effect_possible: true, submitted_by: 'api', submission_started_at: ctx.now });
        return submission(task, started);
      });
      if (!begin) return;
      let result: Receipt;
      try { result = await adapter.submit(begin); }
      catch { result = { status: 'unknown', reason: 'adapter_interrupted_after_submission_boundary' }; }
      return transact(ctx => {
        const task = ctx.get(TASK, taskId), attempt = ctx.get(ATTEMPT, attemptId);
        const reference = result && 'reference' in result ? optional(result.reference) : undefined;
        if (attempt.status === 'unknown' && pending(ctx, task)?.id === attempt.id && reference && !attempt.receipt) {
          ctx.update(ATTEMPT, attempt.id, { receipt: reference });
          return task;
        }
        if (task.active_attempt_id !== attempt.id || task.fencing_token !== attempt.fencing_token || attempt.status !== 'in_progress') return task;
        if (result?.status === 'not_submitted' && optional(result.evidence)) {
          const reason = result.error_class;
          endAttempt(ctx, attempt, 'rejected', { side_effect_possible: false, pre_submit_failure: true, error_class: reason, submitted_by: null });
          step(ctx, attempt, 'submit_rejected', { evidence: result.evidence, error_class: reason });
          settleVerification(ctx, attempt, 'verified_absent');
          ctx.emit('execution.attempt.failed', { task_id: taskId, attempt_id: attemptId, error_class: reason, submitted_by: null });
          if (task.cancel_requested_at) return confirmCancellation(ctx, task, reason);
          if (reason === 'transient' || reason === 'rate_limited') return retryPreSubmit(ctx, task, reason);
          return transition(ctx, task, 'blocked', reason, { ...fence(task), sub_status: reason });
        }
        if (result?.status !== 'accepted' || !reference) {
          if (reference) ctx.update(ATTEMPT, attempt.id, { receipt: reference });
          return uncertain(ctx, task, attempt, result?.status === 'unknown' ? optional(result.reason) ?? 'adapter_outcome_unknown' : 'missing_receipt');
        }
        const subStatus = result.processing === 'awaiting_creator_action' || result.processing === 'scheduled_on_platform' ? result.processing : 'processing';
        const receipt = endAttempt(ctx, attempt, 'accepted', { receipt: reference, provider_processing: subStatus, submitted_at: ctx.now, next_check_at: after(ctx, verificationDelay(task)) });
        const next = transition(ctx, task, task.cancel_requested_at ? 'cancel_pending' : 'accepted', 'adapter_accepted', { ...fence(task), sub_status: subStatus });
        ctx.emit('execution.attempt.accepted', { task_id: taskId, attempt_id: attemptId, executor: 'api', submitted_by: 'api' });
        requestVerification(ctx, next, receipt, 'adapter_accepted', String(receipt.next_check_at));
        return next;
      });
    },
    async cancelScheduled(taskId: string) {
      const claim = await transact(ctx => {
        const task = ctx.get(TASK, taskId), attempt = pending(ctx, task);
        if (task.status !== 'cancel_pending' || task.cancel_verify_only === true || !attempt || attempt.status !== 'accepted' ||
          attempt.provider_processing !== 'scheduled_on_platform' || attempt.cancel_dispatch_started_at || dispatchPaused(ctx, task)) return;
        const adapter = attemptAdapter(ctx, task, attempt);
        const receipt = optional(attempt.receipt);
        if (!adapter?.cancelScheduled || !receipt) return;
        let slot: Row | undefined;
        try { slot = availableWriteSlot(ctx, task.social_account_id); }
        catch (error) {
          if (error instanceof Problem && error.code === 'ACCOUNT_BUSY') return;
          throw error;
        }
        const token = Number(slot?.fencing_token ?? 0) + 1;
        const cancellationSlot = holdWriteSlot(ctx, slot, task.social_account_id, 'cancel_attempt', attempt.id, token, after(ctx, 600));
        step(ctx, attempt, 'cancel_dispatch', { cancellation_intent: true });
        ctx.update(ATTEMPT, attempt.id, { cancel_dispatch_started_at: ctx.now });
        return { adapter, attemptId: attempt.id, receipt, request: submission(task, attempt), token, slotId: cancellationSlot.id };
      });
      if (!claim) return;
      let acknowledgement = 'acknowledged';
      try { await claim.adapter.cancelScheduled!(claim.request, claim.receipt); }
      catch { acknowledgement = 'outcome_unknown'; }
      return transact(ctx => {
        const task = ctx.get(TASK, taskId), attempt = ctx.get(ATTEMPT, claim.attemptId);
        const slot = ctx.get(SLOT, claim.slotId);
        if (slot.holder_kind === 'cancel_attempt' && slot.holder_id === attempt.id && slot.fencing_token === claim.token) {
          ctx.update(SLOT, slot.id, { holder_kind: null, holder_id: null, lease_expires_at: null });
        }
        step(ctx, attempt, 'cancel_acknowledgement', { acknowledgement });
        if (pending(ctx, task)?.id === attempt.id) requestVerification(ctx, task, attempt, 'cancellation');
      });
    },
    async reconcile(taskId: string) {
      const check = await transact(ctx => {
        const task = ctx.get(TASK, taskId);
        const attempt = pending(ctx, task);
        if (!attempt || !['api', 'connector'].includes(String(attempt.executor)) || !['unknown', 'accepted'].includes(status(attempt))) return;
        const adapter = attemptAdapter(ctx, task, attempt);
        if (attempt.executor === 'connector' && !adapter?.observeConnector) return;
        return { attempt, adapter, request: submission(task, attempt) };
      });
      if (!check) return;
      let observation: Observation;
      try {
        const observed = check.attempt.executor === 'connector'
          ? await check.adapter?.observeConnector?.(check.request, check.attempt.connector_result as Data | undefined)
          : await check.adapter?.observe(check.request, optional(check.attempt.receipt));
        observation = observed ?? { status: 'inconclusive' };
      }
      catch { observation = { status: 'inconclusive' }; }
      return transact(ctx => {
        const task = ctx.get(TASK, taskId), attempt = pending(ctx, task);
        if (attempt?.id !== check.attempt.id || attempt.version !== check.attempt.version) return task;
        if (observation?.status === 'published') {
          const external_post_id = optional(observation.external_post_id);
          const visibility = observation.visibility ?? 'public';
          let permalink;
          try {
            if (!external_post_id || !['public', 'private', 'unlisted'].includes(visibility)) throw new Error('Invalid provider observation');
            permalink = observation.permalink == null ? null : url(observation.permalink);
            matchingPost(ctx, ctx.get('social_account', String(task.social_account_id)), { external_post_id, permalink }, task);
          } catch (error) {
            const reason = error instanceof Problem && error.code === 'POST_ALREADY_LINKED' ? 'post_already_linked' : 'invalid_provider_observation';
            step(ctx, attempt, 'verify_evidence', { outcome: 'inconclusive', reason });
            observation = { status: 'inconclusive' };
          }
          if (observation.status === 'published') {
            const proof = ctx.create('evidence', { kind: 'api_response', note: `Verified post ${external_post_id}`, captured_at: ctx.now,
              linked_resource_type: 'execution_attempt', linked_resource_id: attempt.id });
            return publish(ctx, task, attempt, { external_post_id, permalink, visibility, published_at: ctx.now,
              origin: 'system', verification: 'system_verified', post_status: visibility === 'private' ? 'private' : 'live',
              submitted_by: attempt.executor === 'connector' ? attempt.submitted_by ?? null : 'api', evidence_ids: [proof.id] });
          }
        }
        const absent = observation?.status === 'absent' && observation.complete_window === true && observation.delay_elapsed === true;
        const terminalEvidence = observation?.status === 'failed' || observation?.status === 'cancelled' ? optional(observation.evidence) : undefined;
        const failed = observation?.status === 'failed' && !!terminalEvidence;
        const cancelled = observation?.status === 'cancelled' && !!terminalEvidence;
        const outcome = absent ? 'verified_absent' : failed ? 'verified_failed' : cancelled ? 'verified_cancelled' : 'inconclusive';
        step(ctx, attempt, 'verify', { outcome, ...(absent ? { complete_window: true, delay_elapsed: true } : {}),
          ...(terminalEvidence ? { evidence: terminalEvidence } : {}) });
        if (absent || failed || cancelled) {
          settleVerification(ctx, attempt, outcome);
          endAttempt(ctx, attempt, outcome, { side_effect_possible: false, outcome_checked_at: ctx.now });
          settleConnector(ctx, attempt, 'failed');
          if (task.cancel_requested_at) return confirmCancellation(ctx, task, outcome);
          if (failed || cancelled) closeTarget(ctx, targetOf(ctx, task), 'failed_final');
          return transition(ctx, task, absent ? 'retryable' : 'failed', outcome, { ...fence(task), restore_hold: false, next_retry_at: null });
        }
        const count = Number(attempt.check_count ?? 0) + 1;
        const processing = observation?.status === 'pending' ? observation.processing : undefined;
        const next_check_at = after(ctx, verificationDelay(task, count));
        ctx.update(ATTEMPT, attempt.id, { check_count: count, outcome_checked_at: ctx.now, next_check_at,
          ...(processing ? { provider_processing: processing } : {}) });
        const request = activeVerification(ctx, attempt);
        if (request) ctx.update('execution_verification', request.id, { outcome, available_at: next_check_at });
        if (processing && task.status === 'accepted' && task.sub_status !== processing) {
          return transition(ctx, task, 'accepted', 'provider_processing', { sub_status: processing });
        }
        return task;
      });
    },
    async tick() {
      const candidates = await transact(ctx => {
        scanExecution(ctx);
        const requests = new Set(ctx.list('execution_verification').filter(row => row.status === 'requested' &&
          (!row.available_at || time(row.available_at) <= time(ctx.now))).map(row => row.attempt_id));
        return ctx.list(TASK).flatMap<{ id: string; action: 'dispatch' | 'reconcile' }>(task => {
          if (isWorkerTask(task)) return [];
          const attempt = pending(ctx, task);
          if (attempt && (attempt.executor === 'api' || attempt.executor === 'connector' && attemptAdapter(ctx, task, attempt)?.observeConnector) &&
            ['accepted', 'unknown'].includes(status(attempt)) && requests.has(attempt.id)) {
            return [{ id: task.id, action: 'reconcile' }];
          }
          return task.status === 'queued' && !task.restore_hold && !attempt && task.schedule_kind !== 'manual_date' &&
            (!task.due_at || task.run_requested_at || time(task.due_at) <= time(ctx.now)) &&
            (!task.next_retry_at || time(task.next_retry_at) <= time(ctx.now)) ? [{ id: task.id, action: 'dispatch' }] : [];
        });
      });
      const failures: { task_id: string; action: 'dispatch' | 'reconcile' }[] = [];
      for (const { id, action } of candidates) {
        try {
          if (action === 'reconcile') await worker.cancelScheduled(id);
          await worker[action](id);
        }
        catch { failures.push({ task_id: id, action }); }
      }
      return { processed: candidates.length, failures };
    },
  };
  return worker;
}

function retryPreSubmit(ctx: Context, task: Row, reason: string, count = Number(task.auto_retry_count)) {
  if (count >= Number(task.max_auto_retries)) {
    closeTarget(ctx, targetOf(ctx, task), 'failed_final');
    return transition(ctx, task, 'failed', 'retries_exhausted', fence(task));
  }
  const jitter = [...task.id].reduce((sum, char) => sum + char.charCodeAt(0), count) % 11;
  return transition(ctx, task, 'retryable', reason, { ...fence(task), next_retry_at: after(ctx, 15 * 2 ** count + jitter) });
}

/** The workspace scheduler has no external executor. Configured workers use tick() instead. */
export function scanWorkspaceExecution(ctx: Context, options?: { manualDatesOnly: boolean }) {
  if (!options?.manualDatesOnly) scanExecution(ctx);
  for (const task of ctx.list(TASK)) {
    if (isWorkerTask(task)) continue;
    if (options?.manualDatesOnly && task.schedule_kind !== 'manual_date') continue;
    if (!task.publish_target_id || task.status !== 'queued' || task.restore_hold || task.active_attempt_id || pending(ctx, task) ||
      (!task.run_requested_at && time(task.due_at) > time(ctx.now)) || time(task.next_retry_at) > time(ctx.now) || dispatchPaused(ctx, task)) continue;
    if (task.schedule_kind === 'manual_date') {
      const date = targetOf(ctx, task).local_scheduled_at;
      if (typeof date !== 'string' || localMinute(ctx.now, String(task.schedule_tz ?? 'UTC')).slice(0, 10) < date) continue;
    }
    const check = executionCheck(ctx, task);
    if (check.reason) { blockExecution(ctx, task, check); continue; }
    if (late(ctx, task)) continue;
    const reason = check.assessment?.route === 'manual' ? 'manual_route' : 'no_configured_executor';
    transition(ctx, task, 'manual', reason, { route: [{ executor: 'manual', reason }], sub_status: 'awaiting_assignee' });
  }
}

export function scanExecution(ctx: Context) {
  for (const watch of ctx.list('post_watch')) {
    if (watch.status === 'active' && time(watch.watch_until) <= time(ctx.now)) {
      ctx.update('post_watch', watch.id, { status: 'expired', completed_at: ctx.now });
    }
  }
  for (const task of ctx.list(TASK)) {
    if (!task.publish_target_id || FINAL.includes(status(task)) || isWorkerTask(task)) continue;
    const attempt = find(ctx, ATTEMPT, task.active_attempt_id);
    const connector = attempt?.executor === 'connector' ? ctx.list('connector_task').find(row => row.attempt_id === attempt.id) : undefined;
    if (attempt && connector?.status === 'abandoned' && !pending(ctx, task)) {
      endAttempt(ctx, attempt, 'abandoned', { pre_submit_failure: true });
      const stopped = ctx.update(TASK, task.id, fence(task));
      if (connector.abandoned_for_migration) {
        if (stopped.cancel_requested_at) {
          closeTarget(ctx, targetOf(ctx, stopped), 'cancelled');
          transition(ctx, stopped, 'cancelled', 'cancelled_before_submission');
        } else {
          transition(ctx, stopped, 'queued', 'binding_migration', { next_retry_at: null });
        }
      } else if (!late(ctx, stopped, String(connector.retry_at ?? ctx.now))) {
        retryPreSubmit(ctx, stopped, 'connector_abandoned_before_submission');
      }
      continue;
    }
    if (attempt && connector?.status === 'outcome_unknown' && (connector.result as Data | undefined)?.kind === 'accepted') {
      const result = connector.result as Data;
      const submitted_by = result.submitted_by === 'human' || result.submitted_by === 'auto' ? result.submitted_by : null;
      const receipt = endAttempt(ctx, attempt, 'accepted', { side_effect_possible: true, submitted_by, submitted_at: ctx.now,
        connector_result: result, receipt: optional(result.platform_post_id), next_check_at: after(ctx, verificationDelay(task)) });
      const next = transition(ctx, task, task.cancel_requested_at ? 'cancel_pending' : 'accepted', 'connector_accepted', { ...fence(task), sub_status: 'processing' });
      ctx.emit('execution.attempt.accepted', { task_id: task.id, attempt_id: attempt.id, executor: 'connector', submitted_by });
      requestVerification(ctx, next, receipt, 'connector_accepted', task.cancel_requested_at ? ctx.now : String(receipt.next_check_at));
      continue;
    }
    if (attempt && connector?.status === 'outcome_unknown') {
      const result = connector.result as Data | undefined;
      const updated = result?.submitted_by ? ctx.update(ATTEMPT, attempt.id, { submitted_by: result.submitted_by }) : attempt;
      uncertain(ctx, task, updated, 'connector_outcome_unknown');
      settleConnector(ctx, attempt, 'unknown');
      continue;
    }
    if (attempt && connector?.status === 'completed') {
      const result = connector.result as Data | undefined;
      const reason = optional(result?.reason) ?? 'connector_stopped';
      if (result?.kind === 'blocked' && reason === 'assist_submit_timeout' && result.handoff === 'manual' &&
          connector.effective_mode === 'assist' && connector.identity_checked_at) {
        step(ctx, attempt, 'assist_timeout', { page_closed_without_submission: true,
          delay_minutes: Math.max(0, Math.floor((time(ctx.now) - time(task.due_at ?? attempt.started_at)) / 60_000)) });
        endAttempt(ctx, attempt, 'abandoned', { pre_submit_failure: true, error_class: reason });
        settleVerification(ctx, attempt, 'verified_absent');
        const stopped = ctx.update(TASK, task.id, { active_attempt_id: null });
        if (stopped.cancel_requested_at) {
          closeTarget(ctx, targetOf(ctx, stopped), 'cancelled');
          transition(ctx, stopped, 'cancelled', 'cancelled_before_submission', fence(stopped));
        } else {
          handover(ctx, stopped, { reason });
        }
      } else if (!connector.identity_checked_at && result?.kind === 'blocked') {
        endAttempt(ctx, attempt, 'abandoned', { pre_submit_failure: true, error_class: reason });
        transition(ctx, task, 'blocked', reason, { ...fence(task), sub_status: reason });
      } else {
        uncertain(ctx, task, attempt, reason);
      }
      continue;
    }
    if (attempt && time(task.lease_expires_at) <= time(ctx.now)) {
      if (connector?.status === 'outcome_unknown' || connector?.status === 'claimed' || pending(ctx, task)?.id === attempt.id) uncertain(ctx, task, attempt, 'lease_expired_after_submission_boundary');
      else {
        endAttempt(ctx, attempt, 'abandoned', { pre_submit_failure: true });
        retryPreSubmit(ctx, task, 'lease_expired_before_submission');
      }
      continue;
    }
    const open = pending(ctx, task);
    if (open) {
      if (time(open.next_check_at) <= time(ctx.now)) requestVerification(ctx, task, open, 'scheduled_verification');
      const unresolvedSince = open.unknown_at ?? open.submitted_at;
      if (['outcome_unknown', 'accepted'].includes(status(task)) && time(ctx.now) - time(unresolvedSince) >= Number(task.unknown_to_manual_after_minutes) * 60_000) {
        transition(ctx, task, 'manual', 'verification_requires_human', { sub_status: 'awaiting_evidence' });
      }
      continue;
    }
    if (task.restore_hold || dispatchPaused(ctx, task)) continue;
    if (['scheduled', 'queued'].includes(status(task)) && task.schedule_kind !== 'manual_date' &&
      (task.run_requested_at || !task.due_at || time(task.due_at) <= time(ctx.now))) {
      const check = executionCheck(ctx, task);
      if (check.reason) blockExecution(ctx, task, check);
      else if (!late(ctx, task) && task.status === 'scheduled') transition(ctx, task, 'queued', 'schedule_due');
      continue;
    }
    if (task.status === 'retryable' && time(task.next_retry_at) <= time(ctx.now) && Number(task.auto_retry_count) < Number(task.max_auto_retries)) {
      const next = retry(ctx, task);
      if (next.status === 'queued') ctx.update(TASK, next.id, { auto_retry_count: Number(task.auto_retry_count) + 1 });
    }
    if (task.status === 'blocked' && !['late_awaiting_decision', 'reschedule_requested', 'auth_expired', 'quota_exhausted', 'invalid_input'].includes(String(task.sub_status))) {
      const check = executionCheck(ctx, task);
      if (check.reviewReason) blockExecution(ctx, task, check);
      else if (!check.reason && !late(ctx, task)) transition(ctx, task, task.resume_status === 'retryable' ? 'retryable' : 'queued', 'block_resolved', { resume_status: null, precheck_blockers: [] });
    }
  }
}

/** Called by restore orchestration before any dispatch resumes. */
export function holdRestoredExecution(ctx: Context) {
  return ctx.list(TASK).filter(task => !FINAL.includes(status(task)) && !isWorkerTask(task)).map(task => {
    const open = pending(ctx, task);
    if (open) {
      if (task.active_attempt_id === open.id || open.status === 'in_progress' || open.status === 'submitted') {
        return uncertain(ctx, ctx.update(TASK, task.id, { restore_hold: true }), open, 'restore_reconcile');
      }
      requestVerification(ctx, task, open, 'restore_reconcile');
      return ctx.update(TASK, task.id, { restore_hold: true });
    }
    const active = find(ctx, ATTEMPT, task.active_attempt_id);
    if (active) endAttempt(ctx, active, 'abandoned');
    return transition(ctx, task, 'blocked', 'restore_reconcile', { ...fence(task), restore_hold: true, sub_status: 'restore_reconcile' });
  });
}

export function releaseExecutionHold(ctx: Context, taskId: string, proof: { reason: string; evidence_file_ids: string[]; confirmed_no_pending_submission: true }) {
  const task = ctx.get(TASK, taskId);
  if (!task.restore_hold || pending(ctx, task)) throw conflict('OUTCOME_UNKNOWN', 'Resolve pending execution effects before recovery');
  if (proof?.confirmed_no_pending_submission !== true) throw conflict('RESTORE_RECONCILE_REQUIRED', 'Confirm that no pre-restore request can still publish');
  const reason = text(proof.reason, 'reason');
  const evidence_ids = attachEvidence(ctx, proof.evidence_file_ids, TASK, taskId);
  const reopened = ctx.update(TASK, task.id, { restore_hold: false });
  ctx.emit('execution.task.restore_released', { task_id: taskId, reason, evidence_ids, released_by: ctx.actorId });
  return reopened;
}
