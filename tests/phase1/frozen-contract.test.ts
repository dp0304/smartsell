// Contract test (phase1-design §10.2 "契約測試", S8): the frozen Appendix A constants agree with each other and with
// the design text, and the hub and the Worker use the very same values (one module, not copies).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as contracts from '../../packages/contracts/src/index.ts';
import * as workerContracts from '../../apps/connector-desktop/src/runtime/contracts.ts';
import { workerTiming } from '../../apps/server/src/modules/worker/model.ts';
import { BLOCKER_COPY } from '../../apps/server/src/modules/alerts/copy.ts';

const {
  AUTO_RESUME_BLOCKERS, OWNER_RESUME_BLOCKERS, FACT_EVENTS, READBACK_SCHEDULE_SEC, RESULT_PENDING_GUARD_SEC, TERMINAL_JOB_STATUSES,
  isFactReport, possiblySent, derivePostStatus, DRIVER_PROVIDERS, RISK_ACK_PROVIDERS, RISK_TERMS, HUB_PROVIDERS, MCP_PROVIDER,
} = contracts;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const phase1Source = readFileSync(join(root, 'packages/contracts/src/phase1.ts'), 'utf8');

/** The members of a string-literal union type exported by phase1.ts (types do not exist at run time). */
function unionMembers(name: string): string[] {
  const match = new RegExp(`export type ${name} =([^;]+);`).exec(phase1Source);
  assert.ok(match, `type ${name} in phase1.ts`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map(item => item[1]);
}

test('READBACK_SCHEDULE_SEC and RESULT_PENDING_GUARD_SEC: the guard is the whole read-back schedule plus 30 minutes (§5.8)', () => {
  assert.deepEqual([...READBACK_SCHEDULE_SEC], [30, 60, 120, 300, 600, 1200, 1200]);
  const total = READBACK_SCHEDULE_SEC.reduce((sum, value) => sum + value, 0);
  assert.equal(total, 3510, 'about 58.5 minutes of read-back');
  assert.equal(RESULT_PENDING_GUARD_SEC, total + 1800);
  assert.ok(READBACK_SCHEDULE_SEC.every((value, index) => index === 0 || value >= READBACK_SCHEDULE_SEC[index - 1]), 'non-decreasing back-off');
  // The hub derives its guard from the same constant (no test timing configured here).
  assert.equal(workerTiming().resultPendingGuardMs, RESULT_PENDING_GUARD_SEC * 1000);
});

test('FACT_EVENTS: exactly the reports that say something happened or may have happened on the platform (§5.4.3); everything else is a lease report', () => {
  const events = unionMembers('JobReportEvent');
  assert.deepEqual([...FACT_EVENTS].sort(), ['dry_run_done', 'outcome_unknown', 'result', 'started', 'submitted', 'submitting']);
  assert.ok(FACT_EVENTS.every(event => events.includes(event)), 'facts are report events');
  const lease = events.filter(event => !FACT_EVENTS.includes(event as never));
  assert.deepEqual(lease.sort(), ['blocked', 'failed', 'login_state', 'missed', 'prepare_blocked', 'prepared', 'readback_pending', 'released']);
  const blocker = (phase: string) => ({ code: 'captcha', phase, message: '', at: '' });
  assert.equal(isFactReport({ event: 'blocked', data: { event: 'blocked', blocker: blocker('after_submit') } as never }), true, 'after_submit blocked is a fact');
  assert.equal(isFactReport({ event: 'blocked', data: { event: 'blocked', blocker: blocker('before_submit') } as never }), false);
  for (const event of lease) assert.equal(isFactReport({ event: event as never, data: { event } as never }), false, `${event} is a lease report`);
  for (const event of FACT_EVENTS) assert.equal(isFactReport({ event, data: { event } as never }), true, `${event} is a fact`);
});

test('AUTO_RESUME_BLOCKERS and OWNER_RESUME_BLOCKERS are disjoint and cover every resumable code; the rest end the job another way (§5.9)', () => {
  const codes = unionMembers('BlockerCode');
  assert.equal(new Set(codes).size, codes.length);
  const auto = new Set(AUTO_RESUME_BLOCKERS), owner = new Set(OWNER_RESUME_BLOCKERS);
  assert.deepEqual([...auto].filter(code => owner.has(code)), [], 'disjoint');
  assert.deepEqual([...auto].sort(), ['captcha', 'chrome_unavailable', 'identity_mismatch', 'login_expired', 'media_unavailable', 'owner_click_required', 'profile_in_use', 'two_factor']);
  assert.deepEqual([...owner].sort(), ['caption_rejected', 'confirm_dialog', 'driver_outdated', 'platform_error', 'risk_prompt']);
  // Not resumable by design: a failed media hash or rejected upload fails the job, a paused machine is a hold, the
  // emergency stop is resumed in the App, and a result conflict is settled by the owner as outcome_unknown.
  const notResumable = ['machine_paused', 'media_hash_mismatch', 'owner_stopped', 'result_conflict', 'upload_rejected'];
  assert.deepEqual(codes.filter(code => !auto.has(code as never) && !owner.has(code as never)).sort(), notResumable,
    'every code is either auto-resume, owner-resume or explicitly not resumable');
  for (const code of codes) assert.ok(BLOCKER_COPY[code as never], `Appendix C.2 owner copy for ${code}`);
});

test('job statuses: outcome_unknown and unreported are deliberately not terminal; possiblySent agrees (§5.3, §5.11)', () => {
  const statuses = unionMembers('WorkerJobStatus');
  assert.deepEqual([...TERMINAL_JOB_STATUSES].sort(), ['cancelled', 'failed', 'missed', 'succeeded', 'superseded']);
  assert.ok(TERMINAL_JOB_STATUSES.every(status => statuses.includes(status)));
  for (const status of ['outcome_unknown', 'unreported'] as const) {
    assert.ok(!TERMINAL_JOB_STATUSES.includes(status));
    assert.equal(possiblySent({ status, submitting_at: null, started_at: null }), true);
  }
  for (const status of ['queued', 'claimed', 'ready', 'cancelled', 'superseded', 'missed', 'failed'] as const) {
    assert.equal(possiblySent({ status, submitting_at: null, started_at: null }), false, status);
  }
  assert.equal(possiblySent({ status: 'missed', submitting_at: '2026-11-25T01:00:00Z', started_at: '2026-11-25T01:00:00Z' }), true, 'a missed job that reported submitting');
  assert.equal(possiblySent({ status: 'needs_owner', submitting_at: null, started_at: '2026-11-25T01:00:00Z' }), true, 'assist draft open');
  assert.equal(possiblySent({ status: 'needs_owner', submitting_at: null, started_at: null }), false, 'blocked before it started');
  // The post status never says "published" without a result, and an unknown result is never shown as anything else.
  assert.equal(derivePostStatus({ plan_status: 'ready', has_platform_post: false, job_status: 'outcome_unknown' }), 'unknown');
  assert.equal(derivePostStatus({ plan_status: 'ready', has_platform_post: false, job_status: 'unreported' }), 'unknown');
  assert.equal(derivePostStatus({ plan_status: 'ready', has_platform_post: false, job_status: 'claimed', job_revoke_reason: 'cancelled' }), 'cancelling');
  assert.equal(derivePostStatus({ plan_status: 'ready', has_platform_post: false, job_status: 'cancelled', job_force_released: true }), 'missed', 'E17');
});

test('E37: PostStatus has rejected; derivePostStatus derives it from approval_rejected after cancellation and before everything else', () => {
  assert.ok(unionMembers('PostStatus').includes('rejected'));
  const base = { has_platform_post: false, approval_rejected: true };
  assert.equal(derivePostStatus({ ...base, plan_status: 'changes_requested' }), 'rejected');
  assert.equal(derivePostStatus({ ...base, plan_status: 'draft', precheck_summary: 'blocked' }), 'rejected', 'not blocked or draft');
  assert.equal(derivePostStatus({ ...base, plan_status: 'changes_requested', job_status: 'missed' }), 'rejected', 'an older missed run does not hide the rejection');
  assert.equal(derivePostStatus({ ...base, plan_status: 'rejected', approval_rejected: false }), 'rejected', 'a plan status of rejected also says so');
  assert.equal(derivePostStatus({ ...base, plan_status: 'cancelled' }), 'cancelled');
  assert.equal(derivePostStatus({ ...base, plan_status: 'changes_requested', has_platform_post: true }), 'published');
  assert.equal(derivePostStatus({ ...base, plan_status: 'awaiting_approval' }), 'awaiting_approval', 'a newer request is pending');
  assert.equal(derivePostStatus({ ...base, plan_status: 'ready' }), 'scheduled');
  assert.equal(derivePostStatus({ plan_status: 'changes_requested', has_platform_post: false }), 'draft', 'request changes is not a rejection');
});

test('E36: hubSawStart is the hub\'s own record of a possible run (go, started or submitting)', () => {
  assert.equal(contracts.hubSawStart({}), false);
  assert.equal(contracts.hubSawStart({ go_at: null, started_at: null, submitting_at: null }), false);
  for (const field of ['go_at', 'started_at', 'submitting_at'] as const) assert.equal(contracts.hubSawStart({ [field]: '2027-01-01T09:00:00Z' }), true, field);
});

test('timing and protocol constants match §5.4–§5.9 and §2.10', () => {
  assert.equal(contracts.GO_TIMEOUT_MS, 20_000);
  assert.equal(contracts.GO_OFFLINE_ATTEMPTS, 2);
  assert.equal(contracts.GO_OFFLINE_MIN_GAP_MS, 5_000);
  assert.equal(contracts.PAUSED_GO_RETRY_MS, 30_000);
  assert.equal(contracts.LOGIN_CHECK_MAX_AGE_H, 12);
  assert.equal(contracts.PREFLIGHT_SKIP_IF_CHECKED_WITHIN_MIN, 30);
  assert.equal(contracts.PRESENCE_WRITE_INTERVAL_MS, 5 * 60_000);
  assert.equal(contracts.CLOCK_MARGIN_MS, 2 * 60_000);
  assert.equal(contracts.BLOCKER_POLL_MS, 10_000);
});

test('providers: every driver provider needs and has risk terms; every hub provider maps to an MCP name', () => {
  assert.deepEqual([...RISK_ACK_PROVIDERS], [...DRIVER_PROVIDERS]);
  for (const provider of DRIVER_PROVIDERS) assert.ok(RISK_TERMS[provider].zh_hant && RISK_TERMS[provider].en, provider);
  assert.deepEqual(Object.keys(MCP_PROVIDER).sort(), [...HUB_PROVIDERS].sort());
});

test('the Worker runtime uses the same contract module as the hub (no copied constants)', () => {
  for (const name of ['READBACK_SCHEDULE_SEC', 'FACT_EVENTS', 'AUTO_RESUME_BLOCKERS', 'OWNER_RESUME_BLOCKERS', 'TERMINAL_JOB_STATUSES', 'isFactReport', 'possiblySent'] as const) {
    assert.equal((workerContracts as Record<string, unknown>)[name], (contracts as Record<string, unknown>)[name], name);
  }
  assert.equal(workerContracts.RESULT_PENDING_GUARD_SEC, RESULT_PENDING_GUARD_SEC);
});
