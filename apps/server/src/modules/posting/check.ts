import { Problem, type Context, type Row, type WorkerJobRecord } from '@smartsell/contracts';
import { deviceOnline, locate } from '../../../../../packages/domain/src/publishing/index.js';
import { requireHuman } from '../../agent-actor.js';
import { workerEngine } from '../account/channel-settings.js';
import { channelMachine, hasDriver, isHubProvider, isLiveJob, liveCheckLoginJob, loginSummary, machineRef, webUrl } from './model.js';
import { parseOperationBody } from './schemas.js';

/**
 * hub_channels_check (phase1-design §7.2.4, §5.12). Creates or reuses the channel's check_login job and returns at once; the
 * MCP tool layer waits for the result outside every transaction (integration/mcp-hub-tools.ts). A person may add
 * open_login_window: true (E21, the web's 「重新登入」); the result then carries open_login_window as well.
 */

export type CheckStatus = 'done' | 'pending' | 'machine_offline';

export function checkStatus(ctx: Context, job: Pick<WorkerJobRecord, 'status' | 'device_id'>): CheckStatus {
  if (!isLiveJob(job)) return 'done';
  return deviceOnline(ctx, locate(ctx, 'connector_device', job.device_id)) ? 'pending' : 'machine_offline';
}

/** The channel_check output (§7.2.4) for a check_login job. */
export function checkView(ctx: Context, account: Row, job: WorkerJobRecord) {
  const login = loginSummary(ctx, account.id);
  const { device } = channelMachine(ctx, account.id);
  const observed = typeof job.result === 'object' && job.result ? job.result as unknown as Record<string, unknown> : {};
  const handle = typeof account.handle === 'string' && account.handle ? `@${account.handle}` : null;
  return {
    channel_id: account.id, task_id: job.id, status: checkStatus(ctx, job), login: login.state,
    identity: typeof observed.identity === 'string' ? observed.identity : handle,
    checked_at: login.checked_at, machine: machineRef(ctx, device ?? locate(ctx, 'connector_device', job.device_id)),
    ...(job.status === 'failed' || job.status === 'missed' ? { job_status: job.status } : {}),
    ...(job.blocker && { blocker: { code: job.blocker.code, message: job.blocker.message } }),
    web_url: webUrl(ctx, 'channel', account.id),
  };
}

/** Whether this job, as the machine will see it, opens the sign-in window when the channel is signed out (§5.12). */
const opensLoginWindow = (job: WorkerJobRecord) => (job.payload as { open_login_window?: unknown } | null)?.open_login_window === true;

/** The channel_check view; open_login_window is present only when a person asked for the sign-in window. */
export type CheckResult = ReturnType<typeof checkView> & { open_login_window?: boolean };

export function checkChannel(ctx: Context, channelId: string, body: unknown): CheckResult {
  // E21/E32: only a person asks a machine to open a sign-in window. Refused before parsing and for any value. The shared runner's
  // AGENT_HUMAN_FIELDS gate (operations.ts) refuses it first for REST and MCP; this guard stays as defence in depth for direct callers.
  if (body && typeof body === 'object' && (body as Record<string, unknown>).open_login_window !== undefined) requireHuman(ctx, 'open_login_window');
  const { open_login_window: openWindow = false } = parseOperationBody('hub_channels_check', body);
  const account = locate(ctx, 'social_account', channelId);
  if (!account || account.status !== 'active' || !isHubProvider(account.provider)) {
    throw new Problem(422, 'CHANNEL_NOT_FOUND', `Unknown or inactive channel_id ${channelId}. Call channels_list.`, { channel_ids: [channelId], hint: 'call channels_list' });
  }
  const { device } = channelMachine(ctx, account.id);
  if (!hasDriver(account.provider) || !device) {
    throw new Problem(409, 'INVALID_STATE', 'This channel has no machine that can check its login. The owner adds the account on a machine with the SmartSell Worker.',
      { web_url: webUrl(ctx, 'channel', account.id), owner_message: '這個帳號沒有可以檢查登入的機器，請在那台機器上用 SmartSell Worker 新增這個帳號。' });
  }
  if (!openWindow) {
    // One open check per channel: an unfinished check_login is reused (idempotent).
    const job = liveCheckLoginJob(ctx, account.id) ?? workerEngine().createCheckLoginJob(ctx, account.id, { openLoginWindow: false });
    return checkView(ctx, account, job);
  }
  // 「重新登入」 (§8.16 step 7): the engine reuses an open check and turns a still-queued one into a sign-in-window check; a check the
  // machine already holds keeps its payload. open_login_window says which one the machine will run, so the web never claims a window
  // that will not open.
  const job = workerEngine().createCheckLoginJob(ctx, account.id, { openLoginWindow: true });
  return { ...checkView(ctx, account, job), open_login_window: opensLoginWindow(job) };
}
