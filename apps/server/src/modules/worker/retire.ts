import { Problem, hubSawStart, type Context, type Data, type Row } from '@smartsell/contracts';
import { requireHuman } from '../../agent-actor.js';
import { drainConnectorTasks } from '../account/connector-service.js';
import { audit } from '../account/input.js';
import { addEvent, bumpSyncGeneration, channelName, liveJobs, machineName, setJob } from './model.js';

/**
 * E41 hub_machines_retire (COH-3): a person retires a machine that is gone (broken, reinstalled, re-paired under a new
 * name). One transaction:
 * - the device becomes `revoked`, so its signed requests are refused (DEVICE_INACTIVE) and it leaves machines_list, the
 *   overview and machine_setup alerts;
 * - every live job on it is settled without ever re-posting something that may have been sent (E36): a job the hub saw start
 *   (go, started, submitting) becomes unreported, or outcome_unknown once it reported submitting — the owner checks the
 *   platform; a job being revoked ends as its revoke says; a post the machine held but never started goes back to the queue
 *   and follows the account to its next machine (換機器); queued posts stay queued for the same reason; login checks and dry
 *   runs end;
 * - its accounts are marked as needing a machine (binding.machine_retired_at, sessions revoked, account.binding.changed);
 * - the sync generation is bumped.
 */
const revokedStatus = (job: Row) => (job.revoke as Data | null)?.reason === 'superseded' ? 'superseded' : 'cancelled';

export interface RetireResult {
  machine_id: string; name: string; status: 'revoked'; already_retired: boolean;
  jobs: { waiting_for_machine: number; ended: number; to_confirm: number };
  channels: { social_account_id: string; label: string }[];
  posts_to_confirm: string[];
}

export function retireMachine(ctx: Context, id: string, body: Data): RetireResult {
  requireHuman(ctx, 'hub_machines_retire');
  const extra = Object.keys(body ?? {}).filter(key => key !== 'confirm');
  if (extra.length || body?.confirm !== true) {
    const issues = [...extra.map(path => ({ path, message: '不認得的欄位' })), ...(body?.confirm !== true ? [{ path: 'confirm', message: '請確認要撤銷這台機器（confirm: true）' }] : [])];
    throw new Problem(422, 'INVALID_ARGUMENTS', `欄位不正確：${issues.map(issue => issue.path).join('、')}`, { issues });
  }
  const device = ctx.get('connector_device', id);
  const name = machineName(ctx, device.id);
  const bindings = ctx.list('account_execution_binding').filter(row => row.device_id === device.id);
  const channels = bindings.map(row => ({ social_account_id: String(row.social_account_id), label: channelName(ctx, row.social_account_id) }));
  const counts = { waiting_for_machine: 0, ended: 0, to_confirm: 0 };
  const toConfirm = new Set<string>();
  if (device.status === 'revoked') {
    return { machine_id: device.id, name, status: 'revoked', already_retired: true, jobs: counts, channels, posts_to_confirm: [] };
  }
  for (const job of liveJobs(ctx, row => row.device_id === device.id)) {
    const status = String(job.status);
    const post = typeof job.publish_target_id === 'string' && job.kind === 'publish_post' && job.dry_run !== true ? job.publish_target_id : null;
    const note = (outcome: string) => addEvent(ctx, job, 'machine_retired', { previous_status: status, outcome, machine_name: name }, { actor: 'human' });
    if (status === 'outcome_unknown' || status === 'unreported') {
      counts.to_confirm++;
      if (post) toConfirm.add(post);
      continue;
    }
    if (status === 'submitting' || status === 'result_pending') {
      // It pressed Post: the result is unknown and only the owner can settle it (§5.8). Never re-posted.
      note('outcome_unknown');
      setJob(ctx, job, { status: 'outcome_unknown' });
      counts.to_confirm++;
      if (post) toConfirm.add(post);
      continue;
    }
    if (post && hubSawStart(job)) {
      // The hub said go or the machine started: it may have posted and can no longer tell us (E36).
      note('unreported');
      setJob(ctx, job, { status: 'unreported' });
      counts.to_confirm++;
      toConfirm.add(post);
      continue;
    }
    if (!post) {
      // A login check or a dry run of this machine is moot.
      note('cancelled');
      setJob(ctx, job, { status: 'cancelled', finished_at: ctx.now, blocker: null });
      counts.ended++;
      continue;
    }
    if (status === 'releasing' || job.revoke) {
      note(revokedStatus(job));
      setJob(ctx, job, { status: revokedStatus(job), finished_at: ctx.now, blocker: null });
      counts.ended++;
      continue;
    }
    if (status === 'queued' || !job.claimed_at) {
      // Never held by the machine: it waits for the account's next machine (換機器 moves it) or is missed at not_after.
      counts.waiting_for_machine++;
      continue;
    }
    // Held but never started: back to the queue with a new fence, no longer claimed by anyone, so 換機器 moves it and a
    // cancel ends it at once (WE-2). The retired machine cannot ask go any more (its requests are refused).
    note('requeued');
    setJob(ctx, job, { status: 'queued', fencing_token: Number(job.fencing_token ?? 0) + 1, lease_expires_at: null, claimed_at: null,
      preflight_at: null, prepared_at: null, blocker: null, retired_claim: { device_id: device.id, claimed_at: job.claimed_at ?? null } });
    counts.waiting_for_machine++;
  }
  // Its accounts need another machine: the binding keeps pointing here (so its queued posts can follow it), marked retired.
  for (const binding of bindings) {
    ctx.update('account_execution_binding', binding.id, { machine_retired_at: ctx.now });
    for (const session of ctx.list('browser_session').filter(row => row.binding_id === binding.id && row.device_id === device.id && row.status !== 'revoked')) {
      ctx.update('browser_session', session.id, { status: 'revoked', revoked_at: ctx.now });
    }
    ctx.emit('account.binding.changed', { binding_id: binding.id, social_account_id: binding.social_account_id, device_id: device.id, machine_retired: true });
  }
  drainConnectorTasks(ctx, row => row.device_id === device.id);
  const updated = ctx.update('connector_device', device.id, { status: 'revoked', revoked_at: ctx.now, revoked_by: ctx.actorId, paused: false });
  bumpSyncGeneration(ctx, [device.id], 'machine_retired');
  audit(ctx, 'account.device.retired', { device_id: device.id, channels: channels.map(item => item.social_account_id), ...counts });
  ctx.emit('account.device.retired', { device_id: device.id });
  return { machine_id: updated.id, name, status: 'revoked', already_retired: false, jobs: counts, channels, posts_to_confirm: [...toConfirm] };
}

/** Kept with the other §5.14 person-only operations; registered under its full hub_* name (§4.6, E41). */
export const retireOperation = {
  method: 'POST' as const, path: '/hub/machines/:id/retire', name: 'hub_machines_retire',
  summary: 'Retire a machine that is gone: it is revoked, its posts wait for another machine or for the owner to confirm (person only)',
  contract: { bodyRequired: true, body: { type: 'object', additionalProperties: false, required: ['confirm'], properties: { confirm: { type: 'boolean', enum: [true] } } } },
};
