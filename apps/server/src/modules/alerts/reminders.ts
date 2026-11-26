import { type Context, type MachineWarning, type Row, type WorkerJobStatus } from '@smartsell/contracts';
import { presenceSince } from '../worker/presence.js';
import { BLOCKER_COPY, STATUS_COPY, channelAt, fill, lead } from './copy.js';
import { ALERT_KIND, alertHooks, boundDevice, channelLabel, find, isHubChannel, localDate, localHourMinute, localLabel, machineLabel, presence,
  remoteUrl, str, time, workerJobs, workspaceTimezone } from './model.js';
import { createOwnerAlert } from './raise.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Approval reminders before the scheduled time (§4.2): 60 minutes (normal) and 10 minutes (urgent). */
export const APPROVAL_REMINDERS = [{ stage: '60', minutes: 60, severity: 'normal' }, { stage: '10', minutes: 10, severity: 'urgent' }] as const;
export const OFFLINE_ALERT_AFTER_MS = 10 * MINUTE;
export const OFFLINE_JOB_HORIZON_MS = 2 * HOUR;
/** AO-6: how long after not_before an assist job may still be preparing before the owner hears "not ready yet". */
export const CLICK_POST_NOT_READY_AFTER_MS = 2 * MINUTE;
/** E43: a machine_setup warning that has been gone this long notifies again when it comes back. */
export const SETUP_CLEAR_AFTER_MS = HOUR;
export const DAILY_SUMMARY_MINUTE = 21 * 60;
const DEFAULT_LATENESS_MIN = 30;
const LIVE_PUBLISH = new Set<string>(['queued', 'claimed', 'ready', 'needs_owner', 'running']);
const WAITING = new Set<string>(['queued', 'claimed', 'ready', 'needs_owner']);
const FINAL_PLAN = new Set(['cancelled', 'cancel_requested', 'superseded', 'closed']);

type Stage = 'created' | '60' | '10';

export interface ReminderScanOptions {
  /**
   * AO-4: when this hub process started (presence.ts `presenceSince()`). A machine's last contact before it is counted
   * from here, because the hub being down is not the machine being down. Omitted: the hub has been up all along.
   */
  hubStartedAt?: string;
}

function latenessMinutes(ctx: Context, socialAccountId: unknown): number {
  const settings = ctx.list('channel_settings').find(row => row.id === socialAccountId || row.social_account_id === socialAccountId);
  const value = Number(settings?.lateness_limit_min);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_LATENESS_MIN;
}

// ---------- approval_due ----------

/** Pending approval requests of hub posts still awaiting the owner (§4.2). */
export function pendingApprovals(ctx: Context): { request: Row; target: Row }[] {
  return ctx.list('approval_request').flatMap(request => {
    if (request.status !== 'pending' || request.resource_type !== 'planning.publish_target') return [];
    const target = find(ctx, 'publish_target', request.resource_id);
    if (!target || target.plan_status !== 'awaiting_approval' || (target.approval_request_id && target.approval_request_id !== request.id)) return [];
    return isHubChannel(ctx, target.social_account_id) ? [{ request, target }] : [];
  });
}

/** Raise one approval reminder. The notice at scheduling time is urgent when it is already the last one (≤ 10 minutes left). */
export function approvalAlert(ctx: Context, request: Row, target: Row, stage: Stage): Row | undefined {
  const zone = workspaceTimezone(ctx);
  const accountId = str(target.social_account_id);
  const machineId = boundDevice(ctx, accountId);
  const who = channelAt(machineLabel(ctx, machineId), channelLabel(ctx, accountId));
  const at = localLabel(target.scheduled_at, zone, ctx.now) || '預定時間';
  const deadline = localLabel(request.due_at, zone, ctx.now) || '期限';
  const leftMs = time(target.scheduled_at) - Date.parse(ctx.now);
  const severity = stage === '10' || (stage === 'created' && Number.isFinite(leftMs) && leftMs <= 10 * MINUTE) ? 'urgent' : 'normal';
  const when = stage === 'created' ? '' : `（${stage === '60' ? '還有 1 小時' : '還有 10 分鐘'}）`;
  return createOwnerAlert(ctx, {
    kind: 'approval_due', severity, dedupe_key: `${target.id}:${request.id}:${stage}`,
    code: 'approval_due', params: { machine: machineLabel(ctx, machineId) ?? null, channel: channelLabel(ctx, accountId) ?? null, at, deadline, stage },
    title: `${lead(who)}${at} 的貼文等你核准${when}，期限 ${deadline}。`,
    body: `${lead(who)}在 ${at} 有一則貼文需要你核准。請在 ${deadline} 前核准，之後這則不會發出。`,
    machine_id: machineId, social_account_id: accountId, post_id: target.id,
  });
}

function scanApprovals(ctx: Context): number {
  const now = Date.parse(ctx.now);
  let raised = 0;
  for (const { request, target } of pendingApprovals(ctx)) {
    if (now > time(request.due_at)) continue;   // lapsed: handled below as missed/not_approved
    const scheduled = time(target.scheduled_at);
    // A request created after a reminder point is covered by the notice at scheduling time.
    const due = Number.isFinite(scheduled) ? APPROVAL_REMINDERS.filter(reminder => {
      const at = scheduled - reminder.minutes * MINUTE;
      return now >= at && now < scheduled && time(request.created_at) < at;
    }) : [];
    // After downtime only the most urgent reminder that is due goes out, never a burst.
    const stage = due.at(-1)?.stage ?? 'created';
    if (approvalAlert(ctx, request, target, stage)) raised++;
  }
  return raised;
}

/** A post that waited for approval past `scheduled_at + lateness` is missed with reason not_approved (§4.2, Appendix C). */
function scanApprovalLapses(ctx: Context): number {
  const now = Date.parse(ctx.now);
  const zone = workspaceTimezone(ctx);
  let raised = 0;
  for (const target of ctx.list('publish_target')) {
    if (target.plan_status !== 'awaiting_approval' || !isHubChannel(ctx, target.social_account_id)) continue;
    const request = find(ctx, 'approval_request', target.approval_request_id);
    if (!request || !['pending', 'expired'].includes(String(request.status))) continue;
    const lapse = time(target.scheduled_at) + latenessMinutes(ctx, target.social_account_id) * MINUTE;
    if (!Number.isFinite(lapse) || now <= lapse) continue;
    const accountId = str(target.social_account_id);
    const machineId = boundDevice(ctx, accountId);
    const who = channelAt(machineLabel(ctx, machineId), channelLabel(ctx, accountId));
    const deadline = localLabel(new Date(Math.min(lapse, time(request.due_at) || lapse)).toISOString(), zone, ctx.now);
    if (createOwnerAlert(ctx, {
      kind: 'missed', severity: 'urgent', dedupe_key: `target:${target.id}:${request.id}`,
      code: 'missed', params: { machine: machineLabel(ctx, machineId) ?? null, channel: channelLabel(ctx, accountId) ?? null, deadline, reason_code: 'not_approved' },
      title: `${lead(who)}的貼文沒有發出（沒有在期限內核准）。`,
      body: `${who}：${fill(STATUS_COPY.missed_not_approved, { deadline })}`,
      machine_id: machineId, social_account_id: accountId, post_id: target.id,
    })) raised++;
  }
  return raised;
}

// ---------- click_post_soon ----------

export function jobMode(ctx: Context, job: Row): string {
  return (typeof job.social_account_id === 'string' ? alertHooks().effectiveMode?.(ctx, job.social_account_id) : undefined) ?? String(job.mode);
}

/** "Please click Post on Mac-B" (§4.5): `lead` at not_before − prepare_lead_min (normal), `due` at not_before (urgent). */
export function clickPostAlert(ctx: Context, job: Row, stage: 'lead' | 'due'): Row | undefined {
  const zone = workspaceTimezone(ctx);
  const device = find(ctx, 'connector_device', job.device_id);
  const machine = machineLabel(ctx, job.device_id) ?? '指定的機器';
  const channel = channelLabel(ctx, job.social_account_id) ?? '這個帳號';
  const from = localLabel(job.not_before, zone, ctx.now);
  const until = localLabel(job.not_after, zone, ctx.now);
  const remote = remoteUrl(device);
  const remoteLine = remote ? `也可以從遠端畫面操作：${remote}` : '';
  const early = stage === 'lead';
  return createOwnerAlert(ctx, {
    kind: 'click_post_soon', severity: early ? 'normal' : 'urgent', dedupe_key: `${job.id}:${stage}`,
    code: 'click_post_soon', params: { stage, machine, channel, from, until, remote: remote ?? null },
    title: early ? `${from} 要在 ${machine} 按「發布」：${channel}。` : `現在請在 ${machine} 按「發布」：${channel}（截止 ${until}）。`,
    body: [early
      ? `${machine} 的 ${channel} 在 ${from} 要發布，這個帳號沒有開啟代按發布。請在 ${from}–${until} 之間到 ${machine} 按「發布」。`
      : fill(BLOCKER_COPY.owner_click_required, { machine, channel, deadline: until }), remoteLine].filter(Boolean).join(''),
    machine_id: str(job.device_id), social_account_id: str(job.social_account_id), post_id: str(job.publish_target_id), job_id: job.id,
  });
}

/**
 * AO-6: at not_before the assist job is due but the Worker has not reported owner_click_required yet (asleep, still
 * preparing, waiting on media). Says so instead of claiming the draft is ready; the "ready" alert stays free for the report.
 */
export function clickPostNotReadyAlert(ctx: Context, job: Row): Row | undefined {
  const zone = workspaceTimezone(ctx);
  const machine = machineLabel(ctx, job.device_id) ?? '指定的機器';
  const channel = channelLabel(ctx, job.social_account_id) ?? '這個帳號';
  const from = localLabel(job.not_before, zone, ctx.now);
  const until = localLabel(job.not_after, zone, ctx.now);
  return createOwnerAlert(ctx, {
    kind: 'click_post_soon', severity: 'normal', dedupe_key: `${job.id}:due_timer`,
    code: 'click_post_not_ready', params: { machine, channel, from, until },
    title: `${machine} 還沒準備好 ${channel} 的草稿（截止 ${until}）。`,
    body: `${machine} 的 ${channel} 預定 ${from} 發布，但 ${machine} 還沒把草稿準備好，所以現在還不能按「發布」。準備好時會再通知你，截止 ${until}。`,
    machine_id: str(job.device_id), social_account_id: str(job.social_account_id), post_id: str(job.publish_target_id), job_id: job.id,
  });
}

function scanClickPost(ctx: Context): number {
  const now = Date.parse(ctx.now);
  let raised = 0;
  for (const job of workerJobs(ctx)) {
    if (job.kind !== 'publish_post' || job.dry_run === true || !LIVE_PUBLISH.has(String(job.status)) || jobMode(ctx, job) !== 'assist') continue;
    const notBefore = time(job.not_before);
    const notAfter = time(job.not_after);
    const leadMs = Math.max(0, Number(job.prepare_lead_min) || 0) * MINUTE;
    if (now >= notBefore - leadMs && now < notBefore && clickPostAlert(ctx, job, 'lead')) raised++;
    if (now < notBefore || now > notAfter) continue;
    // "Ready, click Post now" only once the Worker has actually prepared the draft (its owner_click_required report).
    const awaitingClick = job.status === 'needs_owner' && (job.blocker as { code?: unknown } | null)?.code === 'owner_click_required';
    if (awaitingClick) {
      if (clickPostAlert(ctx, job, 'due')) raised++;
      continue;
    }
    // Another blocker already raised its own worker_blocker alert; a job that was ready once is not "not ready" again.
    const readyBefore = ctx.list(ALERT_KIND).some(row => row.dedupe_key === `click_post_soon:${job.id}:due`);
    if (job.status !== 'needs_owner' && !readyBefore && now >= notBefore + CLICK_POST_NOT_READY_AFTER_MS && clickPostNotReadyAlert(ctx, job)) raised++;
  }
  return raised;
}

// ---------- machine_offline_with_jobs ----------

function lastSeen(ctx: Context, device: Row): string | undefined {
  const live = presence(ctx, device.id);
  const candidates = [live?.last_seen_at, str(device.last_seen_at)].filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
  return candidates.sort().at(-1);
}

function scanMachineOffline(ctx: Context, options: ReminderScanOptions): number {
  const now = Date.parse(ctx.now);
  const hubStarted = time(options.hubStartedAt);
  const zone = workspaceTimezone(ctx);
  let raised = 0;
  for (const device of ctx.list('connector_device')) {
    if (device.status !== 'active' || device.paused === true) continue;   // a paused machine is held on purpose
    const jobs = workerJobs(ctx).filter(job => job.device_id === device.id && job.kind === 'publish_post' && job.dry_run !== true &&
      WAITING.has(String(job.status)) && time(job.not_before) <= now + OFFLINE_JOB_HORIZON_MS && time(job.not_after) >= now)
      .sort((a, b) => String(a.not_before).localeCompare(String(b.not_before)));
    if (!jobs.length) continue;
    const seen = lastSeen(ctx, device);
    // AO-4: presence lives in memory and the row is written at most every 5 minutes, so right after a hub restart every
    // machine looks stale. Hub downtime is not machine downtime: count offline time from the later of the two.
    const offlineFrom = Math.max(seen ? Date.parse(seen) : Number.NEGATIVE_INFINITY, Number.isFinite(hubStarted) ? hubStarted : Number.NEGATIVE_INFINITY);
    if (Number.isFinite(offlineFrom) && now - offlineFrom <= OFFLINE_ALERT_AFTER_MS) continue;
    const machine = machineLabel(ctx, device.id) ?? '機器';
    const first = localLabel(jobs[0]!.not_before, zone, ctx.now);
    const since = seen ? localLabel(seen, zone, ctx.now) : '配對後';
    const channels = [...new Set(jobs.map(job => channelLabel(ctx, job.social_account_id)).filter(Boolean))].join('、');
    if (createOwnerAlert(ctx, {
      kind: 'machine_offline_with_jobs', severity: 'urgent', dedupe_key: `${device.id}:${seen ?? 'never'}`,
      code: 'machine_offline_with_jobs', params: { machine, n: jobs.length, first, since: seen ? since : null, channels: channels || null },
      title: `${machine} 離線，${jobs.length} 則貼文等待中，最早 ${first}。`,
      body: `${machine} 從 ${since} 起沒有連線，2 小時內有 ${jobs.length} 則貼文要由它發出（${channels || '帳號'}，最早 ${first}）。` +
        `請確認 ${machine} 已開機、沒有睡眠並連上網路；超過遲到上限仍離線的貼文不會補發。`,
      machine_id: device.id, social_account_id: jobs.length === 1 ? str(jobs[0]!.social_account_id) : undefined,
      post_id: jobs.length === 1 ? str(jobs[0]!.publish_target_id) : undefined,
    })) raised++;
  }
  return raised;
}

// ---------- machine_setup ----------

/** Fallback derivation of the §3.2 warnings that need only the machine row; S7's full derivation replaces it via configureAlerts. */
export function defaultMachineWarnings(ctx: Context, device: Row): MachineWarning[] {
  const machine = machineLabel(ctx, device.id) ?? '機器';
  const posture = (device.posture ?? null) as { sleep_idle_min?: number | null; power_plan_sleep_min?: number | null; auto_login?: string; filevault?: string } | null;
  const warnings: MachineWarning[] = [];
  const sleep = Math.max(Number(posture?.sleep_idle_min) || 0, Number(posture?.power_plan_sleep_min) || 0);
  if (sleep > 0) warnings.push({ code: 'sleep_enabled', message: `${machine} 閒置 ${sleep} 分鐘會睡眠。Worker 持有排程時會阻止閒置睡眠，但闔上螢幕或手動睡眠仍會錯過。` });
  if (posture?.auto_login === 'off') {
    warnings.push({ code: 'no_auto_login', message: `${machine} 重開機後要有人登入，Worker 才會啟動${posture.filevault === 'on' ? '（FileVault 已開啟）' : ''}。` });
  }
  const offset = Number(device.clock_offset_ms);
  if (Number.isFinite(offset) && Math.abs(offset) > 30_000) warnings.push({ code: 'clock_skew', message: `${machine} 的時鐘差了 ${Math.round(Math.abs(offset) / 1000)} 秒。` });
  const drivers = Array.isArray(device.drivers) ? device.drivers as { provider?: string; health?: string }[] : [];
  const outdated = drivers.filter(driver => driver.health === 'outdated').map(driver => driver.provider === 'tiktok' ? 'TikTok' : driver.provider === 'x' ? 'X' : String(driver.provider));
  if (outdated.length) warnings.push({ code: 'driver_outdated', message: `${machine} 上 ${outdated.join('、')} 的頁面可能改版。` });
  return warnings;
}

/** E43: what a warning says, without the numbers (idle minutes, clock offset, versions) that change without anything new to tell. */
export const setupState = (message: string) => message.replace(/\d+/g, '#');
/** The warning code of a machine_setup alert (rows from before E43 carry it only in their daily dedupe key). */
const setupCode = (row: Row) => str(row.setup_code) ?? String(row.dedupe_key ?? '').split(':')[2] ?? '';

/**
 * E43 (COH-5): a machine_setup alert, and so a push, only when a warning first appears, when what it says changes, or when
 * it comes back after being gone for SETUP_CLEAR_AFTER_MS. Today and the machine page keep showing the warnings (S7 views).
 */
function scanMachineSetup(ctx: Context): number {
  const now = Date.parse(ctx.now);
  const alerts = ctx.list(ALERT_KIND).filter(row => row.kind === 'machine_setup').sort((a, b) => Number(a.seq) - Number(b.seq));
  let raised = 0;
  for (const device of ctx.list('connector_device')) {
    if (device.status !== 'active') continue;
    const warnings = new Map((alertHooks().machineWarnings?.(ctx, device) ?? defaultMachineWarnings(ctx, device)).map(warning => [warning.code, warning] as const));
    const mine = alerts.filter(row => row.machine_id === device.id);
    for (const code of new Set<string>([...warnings.keys(), ...mine.map(setupCode)])) {
      const history = mine.filter(row => setupCode(row) === code);
      const latest = history.at(-1);
      const warning = warnings.get(code as MachineWarning['code']);
      if (!warning) {
        // Gone: remember since when; after an hour away, its return is a new appearance.
        if (latest && !latest.setup_cleared_at) {
          if (!latest.setup_absent_since) ctx.update(ALERT_KIND, latest.id, { setup_absent_since: ctx.now });
          else if (now - time(latest.setup_absent_since) >= SETUP_CLEAR_AFTER_MS) ctx.update(ALERT_KIND, latest.id, { setup_cleared_at: ctx.now });
        }
        continue;
      }
      const state = setupState(warning.message);
      if (latest && !latest.setup_cleared_at) {
        if (latest.setup_absent_since) ctx.update(ALERT_KIND, latest.id, { setup_absent_since: null });
        if ((str(latest.setup_state) ?? setupState(String(latest.body ?? ''))) === state) continue;
      }
      const row = createOwnerAlert(ctx, {
        kind: 'machine_setup', severity: 'normal', dedupe_key: `${device.id}:${code}:${history.length + 1}`,
        code: 'machine_setup', params: { machine: machineLabel(ctx, device.id) ?? null, os: (device.posture as { os?: string } | null)?.os ?? device.platform ?? null,
          warning: { code, ...(warning as { params?: Record<string, unknown> }).params } },
        // E25: the title names the machine and the kind; the body carries the warning (no duplicate text in push).
        title: `${machineLabel(ctx, device.id) ?? '機器'} 的設定需要調整`, body: warning.message, machine_id: device.id,
      });
      if (!row) continue;
      ctx.update(ALERT_KIND, row.id, { setup_code: code, setup_state: state });
      raised++;
    }
  }
  return raised;
}

// ---------- daily_summary ----------

const STATUS_LABEL: Partial<Record<WorkerJobStatus, string>> = { needs_owner: '等你處理', outcome_unknown: '結果不明', unreported: '機器未回報' };

export function dailySummary(ctx: Context): Row | undefined {
  const zone = workspaceTimezone(ctx);
  if (localHourMinute(ctx.now, zone) < DAILY_SUMMARY_MINUTE) return undefined;
  const today = localDate(ctx.now, zone);
  const tomorrow = localDate(new Date(Date.parse(ctx.now) + 86_400_000).toISOString(), zone);
  const posts = ctx.list('publish_target').filter(row => typeof row.scheduled_at === 'string' && !FINAL_PLAN.has(String(row.plan_status)) &&
    row.plan_status !== 'draft' && localDate(row.scheduled_at, zone) === tomorrow).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
  const issues = [
    ...workerJobs(ctx).filter(job => job.dry_run !== true && STATUS_LABEL[job.status as WorkerJobStatus])
      .map(job => `${channelLabel(ctx, job.social_account_id) ?? '帳號'}：${STATUS_LABEL[job.status as WorkerJobStatus]}`),
    ...pendingApprovals(ctx).map(({ target }) => `${channelLabel(ctx, target.social_account_id) ?? '帳號'}：等你核准`),
  ];
  const line = (row: Row) => {
    const machine = machineLabel(ctx, boundDevice(ctx, row.social_account_id));
    return `${localLabel(row.scheduled_at, zone, ctx.now).replace(/^明天 /, '')} ${channelLabel(ctx, row.social_account_id) ?? '帳號'}${machine ? `（${machine}）` : ''}`;
  };
  const body = [
    posts.length ? `明天的排程（${posts.length} 則）：` : '明天沒有排程。',
    ...posts.slice(0, 8).map(line), ...(posts.length > 8 ? [`另有 ${posts.length - 8} 則`] : []),
    issues.length ? `尚未處理（${issues.length} 件）：` : '沒有尚未處理的問題。',
    ...issues.slice(0, 5), ...(issues.length > 5 ? [`另有 ${issues.length - 5} 件`] : []),
  ].join('\n');
  return createOwnerAlert(ctx, {
    kind: 'daily_summary', severity: 'info', dedupe_key: today,
    title: `明天有 ${posts.length} 則排程，${issues.length} 件待處理。`, body,
    code: 'daily_summary', params: {
      posts: posts.slice(0, 8).map(row => ({ at: localLabel(row.scheduled_at, zone, ctx.now).replace(/^明天 /, ''), channel: channelLabel(ctx, row.social_account_id) ?? null,
        machine: machineLabel(ctx, boundDevice(ctx, row.social_account_id)) ?? null })), n_posts: posts.length,
      issues: [...workerJobs(ctx).filter(job => job.dry_run !== true && STATUS_LABEL[job.status as WorkerJobStatus])
        .map(job => ({ channel: channelLabel(ctx, job.social_account_id) ?? null, status: String(job.status) })),
      ...pendingApprovals(ctx).map(({ target }) => ({ channel: channelLabel(ctx, target.social_account_id) ?? null, status: 'awaiting_approval' }))].slice(0, 5),
      n_issues: issues.length,
    },
  });
}

/** Every time-based alert in §5.9 and §4.2. Idempotent: each reminder carries its own dedupe key. Returns how many were raised. */
export function scanAlertReminders(ctx: Context, options: ReminderScanOptions = {}): number {
  return scanApprovals(ctx) + scanApprovalLapses(ctx) + scanClickPost(ctx) + scanMachineOffline(ctx, options) + scanMachineSetup(ctx) +
    Number(!!dailySummary(ctx));
}

/** Fallback cadence when the host has not wired the alerts drain (which scans every 15 seconds). Knows when this hub started (AO-4). */
export const alertReminderSchedule = { id: 'alerts.reminders', intervalMs: 60_000,
  run: (ctx: Context) => scanAlertReminders(ctx, { hubStartedAt: presenceSince() }) };
