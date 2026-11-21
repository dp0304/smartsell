import { PUBLISH_ASSIST_WAIT_SECONDS, PUBLISH_RESULT_REPORT_SECONDS, parseConnectorClaim, parsePostResult, type ConnectorClaim, type ConnectorTask, type FrozenRevision, type MediaRef, type PostResult, type PublishTask } from '../../../packages/connector-tasks/src/index.ts';
export type { EvidenceKind, EvidenceRef, PostResult } from '../../../packages/connector-tasks/src/index.ts';
import { PermitError, parseConsumePermitDecision, parseSubmitPermitDecision, type PermitDenied, type SubmitPermitClient } from './permit.ts';
import { preflight, type BlockReason, type LocalState } from './preflight.ts';

export type StopReason = 'captcha' | 'risk_control' | 'identity_mismatch';
export type Result =
  | { kind: 'blocked'; reason: BlockReason; auto_stop?: StopReason; handoff: 'manual' | 'awaiting_creator_action' }
  | { kind: 'awaiting_submit_permit'; retry_at: string }
  | { kind: 'awaiting_user_click'; expires_at: string; downgrade_reason?: PermitDenied['deny_reason'] }
  | { kind: 'outcome_unknown'; submitted_by?: 'human' | 'auto' }
  | ({ kind: 'accepted'; submitted_by: 'human' | 'auto' } & PostResult)
  | ({ kind: 'result_captured' } & PostResult)
  | { kind: 'visibility_checked'; visible: boolean }
  | { kind: 'identity_verified' | 'media_pushed' | 'media_cleaned' };
export type TerminalResult = Exclude<Result, { kind: 'awaiting_submit_permit' | 'awaiting_user_click' }>;
export type Report = TerminalResult & { attempt_id: string; fencing_token: number; write_slot_token?: number };
export type IdentityObservation = { kind: 'signed_in'; platform_identity: string } | { kind: 'login_expired' | 'captcha' | 'risk_control' | 'app_prompt' };
export type AssistObservation = 'waiting' | 'closed' | 'submitted' | 'unknown';
export type MediaTask = PublishTask | Extract<ConnectorTask, { kind: 'mobile.push_media' }>;
export interface LocalDriver {
  state(): LocalState;
  identity(task: ConnectorTask): IdentityObservation;
  approvalValid(task: MediaTask): boolean;
  mediaAvailable(media: readonly MediaRef[]): boolean;
  pushMedia(task: MediaTask): boolean;
  draftMatches(task: PublishTask, id: string): boolean;
  stage(task: PublishTask, revision: FrozenRevision): void;
  openAssist(task: PublishTask, expiresAt: number): void;
  observeAssist(task: PublishTask): AssistObservation;
  closeAssist(task: PublishTask): AssistObservation;
  submitAuto(task: PublishTask): void;
  capture(task: ConnectorTask, sourceAttempt: string, expectedPost?: string): PostResult | undefined;
  verify(task: ConnectorTask, sourceAttempt: string, expectedPost: string): boolean;
  cleanup(task: Extract<ConnectorTask, { kind: 'mobile.cleanup_media' }>): boolean;
}

function freezeTask<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTask(child);
    Object.freeze(value);
  }
  return value;
}

export class ConnectorRun {
  readonly #claim: ConnectorClaim;
  #stage: 'new' | 'prepared' | 'assist' = 'new';
  #retryAt = 0;
  #assistExpiresAt = 0;
  #downgradeReason?: PermitDenied['deny_reason'];
  #auto: boolean;
  #terminal?: TerminalResult;
  #busy = false;
  constructor(input: unknown, private readonly driver: LocalDriver, private readonly permits: SubmitPermitClient,
    private readonly now: () => number = Date.now, private readonly assistTimeoutMs = PUBLISH_ASSIST_WAIT_SECONDS * 1000,
    private readonly authorizeReady?: (claim: ConnectorClaim, observedPlatformIdentity: string) => Promise<unknown>) {
    this.#claim = freezeTask(parseConnectorClaim(input));
    this.#auto = this.#claim.effective_mode === 'auto';
    if (!Number.isSafeInteger(assistTimeoutMs) || assistTimeoutMs <= 0) throw new RangeError('Invalid assist timeout');
  }
  applyHeartbeat(effectiveMode: 'assist' | 'auto'): void {
    if (effectiveMode === 'assist') this.#auto = false;
  }
  report(): Report | undefined {
    if (this.#terminal) return { ...structuredClone(this.#terminal), attempt_id: this.#claim.task.attempt_id,
      fencing_token: this.#claim.fencing_token, write_slot_token: this.#claim.write_slot_token };
  }
  #stop(reason: BlockReason): TerminalResult {
    const auto_stop = ['captcha', 'risk_control', 'identity_mismatch'].includes(reason) ? reason as StopReason : undefined;
    return { kind: 'blocked', reason, ...(auto_stop && { auto_stop }), handoff: this.#claim.task.kind === 'tiktok.app.publish' ? 'awaiting_creator_action' : 'manual' };
  }
  #check(task: ConnectorTask): BlockReason | undefined {
    if (this.now() >= Date.parse(this.#claim.lease_expires_at)) return 'lease_expired';
    const local = preflight(task, this.driver.state(), this.now());
    if (local) return local;
    const identity = this.driver.identity(task);
    if (identity.kind !== 'signed_in') return identity.kind;
    if (identity.platform_identity !== task.platform_identity) return 'identity_mismatch';
  }
  #prepareMedia(task: MediaTask): BlockReason | undefined {
    if (!this.driver.approvalValid(task)) return 'approval_invalid';
    if (!task.payload.revision.media.length) return;
    if (!this.driver.mediaAvailable(task.payload.revision.media)) return 'media_unverified';
    if (task.target.channel === 'mobile' && !this.driver.pushMedia(task)) return 'media_unverified';
  }
  #checkPrepared(task: PublishTask): BlockReason | undefined {
    const issue = this.#check(task);
    if (issue) return issue;
    if (!this.driver.approvalValid(task)) return 'approval_invalid';
    const { draft, media } = task.payload.revision;
    if (draft && !this.driver.draftMatches(task, draft.publish_id)) return 'draft_ambiguous';
    if (media.length && !this.driver.mediaAvailable(media)) return 'media_unverified';
  }
  #complete(task: PublishTask, submitted_by: 'human' | 'auto'): TerminalResult {
    try {
      const result = this.driver.capture(task, task.attempt_id);
      if (result) return { kind: 'accepted', submitted_by, ...parsePostResult(result) };
    } catch {
      // The submit may have succeeded. Preserve the original attempt for verification.
    }
    return { kind: 'outcome_unknown', submitted_by };
  }
  #assist(task: PublishTask): Result {
    if (this.#stage !== 'assist') {
      // Close while the claim is still valid so EX can fence a confirmed non-submission.
      const latestAssistClose = Date.parse(this.#claim.lease_expires_at) - PUBLISH_RESULT_REPORT_SECONDS * 1000;
      this.#assistExpiresAt = Math.min(this.now() + this.assistTimeoutMs, latestAssistClose);
      if (this.now() >= this.#assistExpiresAt) return this.#stop('lease_expired');
      this.#stage = 'assist';
      try {
        this.driver.openAssist(task, this.#assistExpiresAt);
      } catch {
        return { kind: 'outcome_unknown' };
      }
    }
    const timeout = this.now() >= this.#assistExpiresAt;
    const observation = timeout ? this.driver.closeAssist(task) : this.driver.observeAssist(task);
    if (observation === 'submitted') return this.#complete(task, 'human');
    if (observation === 'unknown') return { kind: 'outcome_unknown' };
    if (timeout || observation === 'closed') return this.#stop(timeout ? 'assist_submit_timeout' : 'assist_closed');
    return { kind: 'awaiting_user_click', expires_at: new Date(this.#assistExpiresAt).toISOString(), ...(this.#downgradeReason && { downgrade_reason: this.#downgradeReason }) };
  }
  async #publish(task: PublishTask): Promise<Result> {
    if (this.#stage === 'new') {
      const mediaIssue = this.#prepareMedia(task);
      if (mediaIssue) return this.#stop(mediaIssue);
      const { draft } = task.payload.revision;
      if (draft && !this.driver.draftMatches(task, draft.publish_id)) return this.#stop('draft_ambiguous');
      this.driver.stage(task, task.payload.revision);
      this.#stage = 'prepared';
    }
    const preparedIssue = this.#checkPrepared(task);
    if (preparedIssue) return this.#stop(preparedIssue);
    if (this.#auto && this.now() < this.#retryAt) return { kind: 'awaiting_submit_permit', retry_at: new Date(this.#retryAt).toISOString() };
    if (this.authorizeReady) {
      try {
        await this.authorizeReady(structuredClone(this.#claim), task.platform_identity);
      } catch (error) {
        return this.#stop(error instanceof PermitError && error.status === 409 ? 'late_or_stale' : 'permit_unavailable');
      }
      const issue = this.#checkPrepared(task);
      if (issue) return this.#stop(issue);
    }
    if (!this.#auto) return this.#assist(task);
    const permitInput = { attempt_id: task.attempt_id, fencing_token: this.#claim.fencing_token, write_slot_token: this.#claim.write_slot_token, request_hash: task.payload.frozen_hash };
    try {
      const decision = parseSubmitPermitDecision(await this.permits.request(permitInput));
      const interrupted = this.#checkPrepared(task);
      if (interrupted) return this.#stop(interrupted);
      if (!this.#auto) return this.#assist(task);
      if (decision.decision === 'denied') {
        this.#auto = false;
        this.#downgradeReason = decision.deny_reason;
        return this.#assist(task);
      }
      if (decision.decision === 'deferred') {
        this.#retryAt = Date.parse(decision.retry_at);
        if (this.#retryAt <= this.now()) return this.#stop('permit_unavailable');
        return { kind: 'awaiting_submit_permit', retry_at: decision.retry_at };
      }
      const expiry = Date.parse(decision.expires_at);
      if (this.now() >= expiry) return this.#stop('permit_unavailable');
      const consumption = parseConsumePermitDecision(await this.permits.consume({ ...permitInput, permit_id: decision.permit_id }));
      const postConsumeCheck = this.#checkPrepared(task);
      if (postConsumeCheck) return this.#stop(postConsumeCheck);
      if (consumption.decision === 'denied') {
        this.#auto = false;
        this.#downgradeReason = consumption.deny_reason;
      }
      if (!this.#auto) {
        return consumption.decision === 'denied' ? this.#assist(task) : this.#stop('permit_unavailable');
      }
      if (this.now() >= expiry) return this.#stop('permit_unavailable');
    } catch (error) {
      return this.#stop(error instanceof PermitError && error.status === 409 ? 'late_or_stale' : 'permit_unavailable');
    }
    try {
      this.driver.submitAuto(task);
    } catch {
      return { kind: 'outcome_unknown', submitted_by: 'auto' };
    }
    return this.#complete(task, 'auto');
  }
  async #advance(): Promise<Result> {
    const { task } = this.#claim;
    if (this.#stage === 'assist' && 'revision' in task.payload && task.kind !== 'mobile.push_media') {
      const publish = task as PublishTask;
      const observation = this.driver.observeAssist(publish);
      if (observation === 'submitted') return this.#complete(publish, 'human');
      if (observation === 'unknown') return { kind: 'outcome_unknown' };
      const issue = this.#checkPrepared(publish);
      if (issue) {
        const final = this.driver.closeAssist(publish);
        if (final === 'submitted') return this.#complete(publish, 'human');
        if (final === 'unknown') return { kind: 'outcome_unknown' };
        return this.#stop(issue);
      }
      return this.#assist(publish);
    }
    const issue = this.#check(task);
    if (issue) return this.#stop(issue);
    switch (task.kind) {
      case 'session.verify_identity':
      case 'mobile.verify_app_identity': return { kind: 'identity_verified' };
      case 'post.capture_result': {
        try {
          const result = this.driver.capture(task, task.payload.source_attempt_id, task.payload.platform_post_id);
          if (result) return { kind: 'result_captured', ...parsePostResult(result, task.payload.platform_post_id) };
        } catch { /* No usable receipt for the source attempt. */ }
        return this.#stop('result_not_found');
      }
      case 'post.verify_visible': return { kind: 'visibility_checked', visible: this.driver.verify(task, task.payload.source_attempt_id, task.payload.platform_post_id) };
      case 'mobile.cleanup_media': return this.driver.cleanup(task) ? { kind: 'media_cleaned' } : this.#stop('media_unverified');
      case 'mobile.push_media': {
        const failure = this.#prepareMedia(task);
        return failure ? this.#stop(failure) : { kind: 'media_pushed' };
      }
      default: return this.#publish(task);
    }
  }
  async advance(): Promise<Result> {
    if (this.#terminal) return structuredClone(this.#terminal);
    if (this.#busy) throw new Error('Connector run already in progress');
    this.#busy = true;
    try {
      const result = await this.#advance();
      if (result.kind !== 'awaiting_submit_permit' && result.kind !== 'awaiting_user_click') this.#terminal = result;
      return structuredClone(result);
    } catch (error) {
      // A failed assist observer cannot establish that the operator did not submit.
      if (this.#stage !== 'assist') throw error;
      this.#terminal = { kind: 'outcome_unknown' };
      return structuredClone(this.#terminal);
    } finally {
      this.#busy = false;
    }
  }
}
