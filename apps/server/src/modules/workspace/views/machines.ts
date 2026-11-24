import {
  Problem, type Context, type DevicePosture, type DriverTraceStep, type HubProvider, type JobSummary, type MachineDetail, type MachineSummary, type MachineWarning, type Row,
} from '@smartsell/contracts';
import { locate, object, time } from '../../../../../../packages/domain/src/publishing/index.js';
import { channelLoginState } from '../../account/channel-settings.js';
import { hostCaches } from '../../worker/host-cache.js';
import { deviceSyncState } from '../../worker/model.js';
import { compareWorkerVersions } from '../../../worker-downloads.js';
import {
  activeMachines, allJobs, channelDevice, hubChannels, lastSeen, localText, machineDrivers, machineName, machineOnline, presenceOf, remoteUrl,
  str, workspaceZone,
} from './hub-model.js';
import { webUrl } from './links.js';
import { jobSummaryOf } from './posts.js';

/** Machine read models (phase1-design §3.2, §9.3): machineSummaries, machineDetail and the §3.2 warnings. */

export type WarningLang = 'zh' | 'en';
const SYNC_GRACE_MS = 60_000;
const QUEUE_STATUSES = ['queued', 'claimed', 'ready', 'running', 'submitting', 'result_pending', 'needs_owner', 'releasing', 'outcome_unknown', 'unreported'];

function latestVersion(device: Row): string | null {
  try { return hostCaches().latestWorker(device)?.version ?? null; } catch { return null; }
}
function clockOffset(ctx: Context, device: Row): number | null {
  const value = presenceOf(ctx, device.id)?.clock_offset_ms ?? device.clock_offset_ms;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
const postureOf = (ctx: Context, device: Row): DevicePosture | null =>
  (presenceOf(ctx, device.id)?.posture ?? (device.posture && typeof device.posture === 'object' ? device.posture : null)) as DevicePosture | null;

/**
 * §3.2 machine warnings derived from the posture, version, clock, drivers and sync state. The web shows zh-Hant (`lang`
 * 'zh'); the Agent tools (S4) ask for 'en' and get the same codes from the same rules.
 */
export function machineWarnings(ctx: Context, device: Row, lang: WarningLang = 'zh'): MachineWarning[] {
  const name = machineName(device);
  const posture = postureOf(ctx, device);
  const warnings: MachineWarning[] = [];
  const add = (code: MachineWarning['code'], zh: string, en: string) => warnings.push({ code, message: lang === 'en' ? en : zh });
  const sleep = Math.max(Number(posture?.sleep_idle_min) || 0, Number(posture?.power_plan_sleep_min) || 0);
  if (sleep > 0) add('sleep_enabled', `${name} 閒置 ${sleep} 分鐘會睡眠。Worker 持有排程時會阻止閒置睡眠，但闔上螢幕或手動睡眠仍會錯過。`,
    `${name} sleeps after ${sleep} min idle.`);
  if (posture?.auto_login === 'off') add('no_auto_login', `${name} 重開機後要有人登入，Worker 才會啟動${posture.filevault === 'on' ? '（FileVault 已開啟）' : ''}。`,
    `${name} needs someone to log in after a restart.`);
  const version = str(presenceOf(ctx, device.id)?.client_version) ?? str(device.client_version);
  const latest = latestVersion(device);
  if (version && latest && compareWorkerVersions(version, latest) < 0) add('app_outdated', `${name} 的 Worker 是 ${version}，有 ${latest} 可更新。`,
    `${name} runs Worker ${version}; ${latest} is available.`);
  const offset = clockOffset(ctx, device);
  if (offset !== null && Math.abs(offset) > 30_000) add('clock_skew', `${name} 的時鐘差了 ${Math.round(Math.abs(offset) / 1000)} 秒。`,
    `${name}'s clock is off by ${Math.round(Math.abs(offset) / 1000)} s.`);
  const outdated = machineDrivers(ctx, device).filter(driver => driver.health === 'outdated');
  if (outdated.length) {
    const names = outdated.map(driver => driver.provider === 'x' ? 'X' : driver.provider === 'tiktok' ? 'TikTok' : String(driver.provider)).join('、');
    add('driver_outdated', `${names} 的頁面可能改版${outdated[0].step ? `（在「${outdated[0].step}」找不到元素）` : ''}。`, `The ${names} page may have changed.`);
  }
  const presence = presenceOf(ctx, device.id);
  const sync = deviceSyncState(ctx, device.id);
  // A machine online picks a change up within one heartbeat (15 s); only a change it has missed for a minute is worth telling the owner.
  if (presence && sync.generation > Number(presence.applied_sync_generation ?? 0) && time(ctx.now) - time(sync.at) >= SYNC_GRACE_MS) {
    const zone = workspaceZone(ctx);
    const changed = localText(sync.at, zone)?.slice(11) ?? '';
    const seen = localText(lastSeen(ctx, device), zone)?.slice(11) ?? '';
    add('sync_behind', `${name} 還沒收到你 ${changed} 的變更（最後連線 ${seen}）。`, `${name} has not received your ${changed} change yet (last seen ${seen}).`);
  }
  return warnings;
}

function jobsOn(ctx: Context, deviceId: string) {
  return allJobs(ctx).filter(job => job.device_id === deviceId);
}

/**
 * WV-7: 「下一則」 is the next post this machine will still run: queued, claimed, ready (before its deadline) or running. A post
 * whose result is unknown, an unreported or released job and one waiting for the owner are not "next".
 */
const NEXT_STATUSES = ['queued', 'claimed', 'ready', 'running'];
const isNext = (job: Row, now: number) => NEXT_STATUSES.includes(String(job.status)) && (job.status === 'running' || !(time(job.not_after) <= now));

/** One machine; `next_job.local_time` is in `zone` (the workspace zone, or Today's page zone, WV-6). */
export function machineSummaryOf(ctx: Context, device: Row, zone = workspaceZone(ctx)): MachineSummary {
  const own = jobsOn(ctx, device.id).filter(job => !job.dry_run);
  const count = (...statuses: string[]) => own.filter(job => statuses.includes(job.status)).length;
  const now = time(ctx.now);
  const next = own.filter(job => job.kind === 'publish_post' && isNext(job, now))
    .sort((a, b) => String(a.not_before).localeCompare(String(b.not_before)))[0];
  const posture = postureOf(ctx, device);
  return {
    machine_id: device.id, name: machineName(device), os: (posture?.os ?? (device.platform === 'win32' ? 'win32' : 'darwin')) as MachineSummary['os'],
    app_version: str(presenceOf(ctx, device.id)?.client_version) ?? str(device.client_version) ?? null, latest_app_version: latestVersion(device),
    online: machineOnline(ctx, device), last_seen_at: lastSeen(ctx, device), paused: device.paused === true,
    channels: hubChannels(ctx).filter(account => channelDevice(ctx, account.id)?.id === device.id).map(account => ({
      social_account_id: account.id, provider: account.provider as HubProvider, handle: str(account.handle) ?? null,
      login: (() => { try { return channelLoginState(ctx, account.id).state; } catch { return 'unknown' as const; } })(),
      web_url: webUrl(ctx, 'channel', account.id),
    })),
    queue: { queued: count('queued'), ready: count('claimed', 'ready'), running: count('running', 'submitting', 'result_pending'), needs_owner: count('needs_owner') },
    next_job: next ? { post_id: str(next.publish_target_id) ?? null, at: String(next.not_before),
      local_time: localText(next.not_before, zone) ?? String(next.not_before),
      provider: (locate(ctx, 'social_account', next.social_account_id)?.provider ?? 'x') as MachineSummary['channels'][number]['provider'] } : null,
    drivers: machineDrivers(ctx, device), warnings: machineWarnings(ctx, device), remote_url: remoteUrl(device), web_url: webUrl(ctx, 'machine', device.id),
  };
}

/** C7 machineSummaries(ctx): every active (paired, not revoked) machine. */
export function machineSummaries(ctx: Context, options: { includeOffline?: boolean; zone?: string } = {}): MachineSummary[] {
  return activeMachines(ctx).map(device => machineSummaryOf(ctx, device, options.zone)).filter(row => options.includeOffline !== false || row.online);
}

/** C7 machineDetail(ctx, id): §9.3 machine page. */
export function machineDetail(ctx: Context, id: string): MachineDetail {
  const device = locate(ctx, 'connector_device', id);
  if (!device || device.status === 'revoked') throw new Problem(404, 'MACHINE_NOT_FOUND', `Unknown machine_id ${id}`);
  const jobs = jobsOn(ctx, device.id);
  const upcoming: JobSummary[] = jobs.filter(job => QUEUE_STATUSES.includes(job.status))
    .sort((a, b) => String(a.not_before).localeCompare(String(b.not_before))).map(job => jobSummaryOf(ctx, job));
  const history: JobSummary[] = jobs.filter(job => !QUEUE_STATUSES.includes(job.status))
    .sort((a, b) => String(b.finished_at ?? b.updated_at).localeCompare(String(a.finished_at ?? a.updated_at))).slice(0, 50).map(job => jobSummaryOf(ctx, job));
  const traced = jobs.filter(job => Array.isArray((job as Row).driver_trace) && ((job as Row).driver_trace as unknown[]).length)
    .sort((a, b) => String(b.finished_at ?? b.updated_at).localeCompare(String(a.finished_at ?? a.updated_at)))[0];
  const provider = traced ? locate(ctx, 'social_account', traced.social_account_id)?.provider : undefined;
  let driverConfig: string | null = null;
  try { driverConfig = hostCaches().driverConfig()?.version ?? null; } catch { driverConfig = null; }
  return {
    ...machineSummaryOf(ctx, device), clock_offset_ms: clockOffset(ctx, device),
    paired_at: String(device.paired_at ?? device.created_at), posture: postureOf(ctx, device), driver_config_version: driverConfig,
    upcoming, history,
    last_driver_trace: traced && (provider === 'x' || provider === 'tiktok') ? {
      provider, job_id: traced.id,
      steps: ((traced as Row).driver_trace as unknown[]).map(object).map(step => ({
        step: String(step.step ?? ''), ms: Number(step.ms) || 0,
        matched: (['primary', 'fallback', 'none'] as const).find(value => value === step.matched) ?? 'none',
      }) satisfies DriverTraceStep),
    } : null,
  };
}

/** Machines that are offline while they hold posts due soon (Today 「離線機器」, §9.2 machine_offline). */
export function offlineWithJobs(ctx: Context, horizonMs = 48 * 3_600_000) {
  const now = time(ctx.now);
  return activeMachines(ctx).filter(device => !machineOnline(ctx, device)).map(device => {
    const waiting = jobsOn(ctx, device.id).filter(job => job.kind === 'publish_post' && !job.dry_run && ['queued', 'claimed', 'ready', 'needs_owner'].includes(job.status)
      && time(job.not_before) <= now + horizonMs).sort((a, b) => String(a.not_before).localeCompare(String(b.not_before)));
    return { device, waiting };
  }).filter(entry => entry.waiting.length > 0);
}
