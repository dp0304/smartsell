import {
  DRIVER_PROVIDERS, HUB_PROVIDERS, Problem, renderCaption,
  type CheckLoginPayload, type Context, type Data, type DriverProvider, type HubProvider, type JobChannel, type JobMedia,
  type PlatformDefaults, type PublishPostPayload, type Row,
} from '@smartsell/contracts';
import { channelEffectiveMode, channelSettingsFor, digest, entries, object } from '../../../../../packages/domain/src/publishing/index.js';
import { ensureChannelSettings } from '../account/channel-settings.js';
import { TASK } from '../execution/service.js';
import { JOB, addEvent, bumpSyncGeneration, iso, isTerminal, liveJobs, locate, now, setJob, str, time, workerHost, workerTiming } from './model.js';
import { requestRevoke } from './revoke.js';

const isDriverProvider = (provider: unknown): provider is DriverProvider => (DRIVER_PROVIDERS as readonly unknown[]).includes(provider);
export const bindingOf = (ctx: Context, accountId: unknown) =>
  ctx.list('account_execution_binding').find(row => row.social_account_id === accountId);

/** The Worker route for a channel account: a driver provider, a browser binding to an active machine and mode auto/assist. */
function workerRoute(ctx: Context, accountId: unknown) {
  const account = locate(ctx, 'social_account', accountId);
  const settings = account ? channelSettingsFor(ctx, account.id) : undefined;
  if (!account || !settings || !isDriverProvider(account.provider)) return undefined;
  const mode = channelEffectiveMode(account.provider, settings);
  if (mode === 'owner') return undefined;
  const binding = bindingOf(ctx, account.id);
  if (!binding || typeof binding.device_id !== 'string' || binding.connector_channel !== 'browser' || !['connector', 'hybrid'].includes(String(binding.mode))) return undefined;
  const device = locate(ctx, 'connector_device', binding.device_id);
  if (!device || device.status !== 'active') return undefined;
  return { account, settings, binding, device, mode };
}

/** C3: whether a target's execution belongs to the Worker job engine. */
export function isWorkerRoute(ctx: Context, target: Row): boolean {
  const task = ctx.list(TASK).find(row => row.publish_target_id === target.id);
  if (Array.isArray(task?.route) && (task!.route as Data[])[0]?.executor === 'worker') return true;
  return !!workerRoute(ctx, target.social_account_id);
}

export function jobChannel(account: Row, settings: { chrome_profile_key: string }): JobChannel {
  return {
    social_account_id: account.id, handle: str(account.handle) ?? null,
    display_name: str(account.display_name) ?? str(account.handle) ?? String(account.external_account_id ?? ''),
    profile_key: settings.chrome_profile_key, expected_identity: String(account.external_account_id ?? ''),
  };
}

/** JobMedia for one frozen media item; file_id stays null while the upload is still in flight (§5.2). */
function jobMedia(ctx: Context, item: Data): { media: JobMedia; ref: { asset_id: string | null; asset_version_id: string | null } } {
  const version = locate(ctx, 'asset_version', item.asset_version_id);
  const asset = locate(ctx, 'asset', item.asset_id ?? version?.asset_id);
  const file = locate(ctx, 'file_object', version?.file_object_id);
  const session = asset ? ctx.list('media_upload_session').filter(row => row.media_id === asset.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] : undefined;
  const meta = object(version?.meta);
  const mime = String(file?.mime_type ?? version?.mime_type ?? '');
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    media: {
      file_id: file && !file.deleted_at ? file.id : null, sha256: String(version?.sha256 ?? file?.sha256 ?? ''),
      bytes: Number(file?.size_bytes ?? file?.byte_size ?? session?.bytes ?? 0), mime,
      filename: String(file?.original_filename ?? session?.filename ?? asset?.title ?? 'media'),
      kind: asset?.kind === 'image' || mime.startsWith('image/') ? 'image' : 'video',
      duration_ms: number(meta.duration_ms), width: number(meta.width), height: number(meta.height),
    },
    ref: { asset_id: asset?.id ?? null, asset_version_id: version?.id ?? null },
  };
}

/** §5.4.2 buildPublishPayload: caption via renderCaption, media from the frozen revision, options from its platform options. */
export function buildPublishPayload(ctx: Context, target: Row, task: Row, account: Row, settings: { chrome_profile_key: string; timezone: string; window: unknown; daily_cap: number }) {
  const frozen = object(task.frozen);
  const rendered = object(frozen.rendered);
  const provider = account.provider as DriverProvider;
  const tags = Array.isArray(rendered.tags) ? rendered.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const items = entries(frozen.media).filter(item => !item.role || ['primary', 'slide'].includes(String(item.role))).map(item => jobMedia(ctx, item));
  const platformOptions = object(object(frozen.options).platform_options);
  const options = (Object.keys(object(platformOptions[provider])).length ? { [provider]: platformOptions[provider] } : {}) as PlatformDefaults;
  const payload: PublishPostPayload = {
    schema: 'smartsell.worker.publish.v1', provider, channel: jobChannel(account, settings),
    caption: { text: renderCaption(typeof rendered.text === 'string' ? rendered.text : '', tags), title: str(rendered.title) ?? null },
    media: items.map(item => item.media), options,
    publish_target_id: target.id, execution_task_id: task.id, approval_request_id: str(target.approval_request_id) ?? null, frozen_hash: str(task.frozen_hash) ?? null,
    scheduled_at: String(target.scheduled_at ?? ctx.now), timezone: settings.timezone,
    limits: { window: (settings.window ?? null) as PublishPostPayload['limits']['window'], daily_cap: settings.daily_cap },
  };
  return { payload, refs: items.map(item => item.ref) };
}

/**
 * §5.2 not_before: the scheduled time; a post scheduled "now" (or a retry) gets 30 s for the Worker to claim and prepare.
 * A late re-dispatch keeps its original window, so the lateness limit still counts from the scheduled time.
 */
function notBefore(ctx: Context, scheduledAt: unknown) {
  const at = time(scheduledAt);
  const current = now(ctx);
  if (!Number.isFinite(at)) return current + 30_000;
  return at >= current - 60_000 && at < current + 30_000 ? current + 30_000 : at;
}

function baseJob(ctx: Context, input: { kind: 'publish_post' | 'check_login'; account: Row; binding: Row; device: Row; settings: { chrome_profile_key: string; settings_generation?: number };
  mode: 'auto' | 'assist'; not_before: number; not_after: number; prepare_lead_min: number }) {
  return {
    kind: input.kind, status: 'queued', device_id: input.device.id, device_history: [input.device.id], social_account_id: input.account.id,
    binding_id: input.binding.id, chrome_profile_key: input.settings.chrome_profile_key, publish_target_id: null, execution_task_id: null, attempt_id: null,
    dry_run: false, mode: input.mode, not_before: iso(input.not_before), not_after: iso(input.not_after), prepare_lead_min: input.prepare_lead_min,
    offline_go_max_staleness_min: workerTiming().offlineStalenessMin, settings_generation: Number(input.settings.settings_generation ?? 1),
    frozen_hash: null, fencing_token: 0, lease_expires_at: null, seq_by_fence: {}, waits_for_job_id: null, media_pending: false, resume_token: 0,
    claimed_at: null, preflight_at: null, prepared_at: null, go_at: null, started_at: null, submitting_at: null, submitted_at: null, finished_at: null,
    go_source: null, submitted_by: null, revoke: null, blocker: null, result: null, driver: null, retry_of_job_id: null,
  };
}

/**
 * C3 (§5.2): called by ensureTask in the same transaction whenever a Worker-route target is ready. Idempotent: a live job
 * with the same frozen hash and scheduled time is returned; a different one is superseded and the new job waits for it.
 */
export function dispatchWorkerJob(ctx: Context, target: Row, task: Row, opts: { retryOf?: string } = {}): Row | undefined {
  const route = workerRoute(ctx, target.social_account_id);
  if (!route || target.plan_status !== 'ready') return undefined;
  const { account, settings, binding, device, mode } = route;
  const live = liveJobs(ctx, job => job.publish_target_id === target.id && job.kind === 'publish_post' && job.dry_run !== true);
  // A job already being revoked is never reused: the new job waits for it instead (§5.2).
  const same = live.find(job => !job.revoke && job.status !== 'releasing' && job.frozen_hash === task.frozen_hash &&
    job.scheduled_for === target.scheduled_at && job.execution_task_id === task.id);
  if (same) {
    if (target.worker_job_id !== same.id) ctx.update('publish_target', target.id, { worker_job_id: same.id });
    if (task.worker_job_id !== same.id) ctx.update(TASK, task.id, { worker_job_id: same.id });
    return same;
  }
  let waitsFor: string | null = null;
  for (const old of live) {
    requestRevoke(ctx, old, 'superseded');
    const current = locate(ctx, JOB, old.id);
    if (current && !isTerminal(current)) waitsFor = current.id;
  }
  const start = notBefore(ctx, target.scheduled_at);
  const timing = workerTiming();
  const { payload, refs } = buildPublishPayload(ctx, target, task, account, settings);
  const pending = payload.media.some(item => item.file_id === null);
  const job = ctx.create(JOB, {
    ...baseJob(ctx, { kind: 'publish_post', account, binding, device, settings, mode: mode as 'auto' | 'assist', not_before: start,
      not_after: start + settings.lateness_limit_min * 60_000, prepare_lead_min: timing.prepareLeadMin }),
    publish_target_id: target.id, execution_task_id: task.id, frozen_hash: task.frozen_hash ?? null, scheduled_for: target.scheduled_at ?? null,
    payload, payload_hash: digest(payload), media_refs: refs, media_pending: pending, waits_for_job_id: waitsFor, retry_of_job_id: opts.retryOf ?? null,
  });
  ctx.update('publish_target', target.id, { worker_job_id: job.id });
  ctx.update(TASK, task.id, { route: [{ executor: 'worker', device_id: device.id }], worker_job_id: job.id });
  addEvent(ctx, job, 'dispatched', { not_before: job.not_before, not_after: job.not_after, mode, media_pending: pending, waits_for_job_id: waitsFor,
    ...(opts.retryOf && { retry_of_job_id: opts.retryOf }) });
  bumpSyncGeneration(ctx, [device.id], 'job_dispatched');
  ctx.emit('worker.job.dispatched', { job_id: job.id, publish_target_id: target.id, social_account_id: account.id, device_id: device.id, not_before: job.not_before });
  return job;
}

/** C3 (§5.12): one open check_login per account is reused; the machine is the account's current binding. */
export function createCheckLoginJob(ctx: Context, socialAccountId: string, opts: { openLoginWindow: boolean }): Row {
  // A check being withdrawn (revoke set) is not reused: its machine is dropping it.
  let existing: Row | undefined = liveJobs(ctx, job => job.kind === 'check_login' && job.social_account_id === socialAccountId && !job.revoke)[0];
  if (existing) {
    const payload = existing.payload as CheckLoginPayload;
    if (opts.openLoginWindow && !payload.open_login_window && existing.status === 'queued') {
      const next = { ...payload, open_login_window: true };
      return setJob(ctx, existing, { payload: next, payload_hash: digest(next) });
    }
    // WE-5: 「重新登入」 while a held check waits on its machine (Chrome would not start) replaces it with a sign-in-window
    // check instead of returning one that will never open the window.
    if (opts.openLoginWindow && !payload.open_login_window && existing.status === 'needs_owner') {
      requestRevoke(ctx, existing, 'superseded');
      existing = undefined;
    } else return existing;
  }
  const account = ctx.get('social_account', socialAccountId);
  if (!(HUB_PROVIDERS as readonly unknown[]).includes(account.provider)) throw new Problem(422, 'CHANNEL_PROVIDER_UNSUPPORTED', '這個平台不支援登入檢查');
  const binding = bindingOf(ctx, account.id);
  const device = locate(ctx, 'connector_device', binding?.device_id);
  if (!binding || !device || binding.connector_channel !== 'browser') throw new Problem(409, 'MACHINE_BINDING_REQUIRED', '這個帳號還沒有綁定機器，請先在帳號頁選擇機器');
  if (device.status !== 'active') throw new Problem(409, 'DEVICE_INACTIVE', '綁定的機器已停用或撤銷');
  const settings = ensureChannelSettings(ctx, account.id);
  const mode = channelEffectiveMode(account.provider, settings);
  const payload: CheckLoginPayload = {
    schema: 'smartsell.worker.check_login.v1', provider: account.provider as HubProvider, channel: jobChannel(account, settings), open_login_window: opts.openLoginWindow,
  };
  const start = now(ctx);
  const job = ctx.create(JOB, {
    ...baseJob(ctx, { kind: 'check_login', account, binding, device, settings, mode: mode === 'auto' ? 'auto' : 'assist', not_before: start,
      not_after: start + 10 * 60_000, prepare_lead_min: 0 }),
    payload, payload_hash: digest(payload),
  });
  addEvent(ctx, job, 'dispatched', { kind: 'check_login', open_login_window: opts.openLoginWindow });
  bumpSyncGeneration(ctx, [device.id], 'check_login_requested');
  ctx.emit('worker.job.dispatched', { job_id: job.id, publish_target_id: null, social_account_id: account.id, device_id: device.id, not_before: job.not_before });
  return job;
}

/** §5.14 hub_channels_dry_run: a publish_post job without a target; the Worker stops before Post and discards the draft. */
export function createDryRunJob(ctx: Context, socialAccountId: string, input: { media_id?: string; caption?: string }): Row {
  const route = workerRoute(ctx, socialAccountId) ?? (() => {
    const account = ctx.get('social_account', socialAccountId);
    if (!isDriverProvider(account.provider)) throw new Problem(422, 'DRIVER_UNAVAILABLE', '這個平台第 3 階段才支援 Worker，無法試跑');
    throw new Problem(409, 'MACHINE_BINDING_REQUIRED', '這個帳號還沒有綁定可用的機器，請先在帳號頁選擇機器');
  })();
  const { account, settings, binding, device } = route;
  if (liveJobs(ctx, job => job.dry_run === true && job.social_account_id === account.id).length) {
    throw new Problem(409, 'DRY_RUN_IN_PROGRESS', '這個帳號已有一個試跑在進行中');
  }
  let media: JobMedia[];
  let refs: { asset_id: string | null; asset_version_id: string | null }[] = [];
  if (input.media_id) {
    const asset = locate(ctx, 'asset', input.media_id);
    if (!asset || !asset.current_version_id) throw new Problem(422, 'MEDIA_NOT_FOUND', 'Unknown media_id');
    const item = jobMedia(ctx, { asset_id: asset.id, asset_version_id: asset.current_version_id });
    if (!item.media.file_id) throw new Problem(422, 'MEDIA_FAILED', '這支影片還沒上傳完成');
    media = [item.media];
    refs = [item.ref];
  } else {
    const clip = workerHost().bundledClip;
    // The Worker uses its own bundled clip (resources/test-clip.mp4) and never downloads it; the hub only names it.
    media = [{ file_id: null, bundled: 'test-clip-v1', sha256: clip?.sha256 ?? '0'.repeat(64), bytes: clip?.bytes ?? 0, mime: 'video/mp4',
      filename: 'test-clip.mp4', kind: 'video', duration_ms: clip?.duration_ms ?? null, width: clip?.width ?? null, height: clip?.height ?? null }];
  }
  const defaults = settings.platform_defaults as PlatformDefaults;
  const provider = account.provider as DriverProvider;
  const payload: PublishPostPayload = {
    schema: 'smartsell.worker.publish.v1', provider, channel: jobChannel(account, settings),
    caption: { text: typeof input.caption === 'string' ? input.caption.slice(0, 2200) : '', title: null }, media,
    options: defaults[provider] ? { [provider]: defaults[provider] } as PlatformDefaults : {},
    publish_target_id: null, execution_task_id: null, approval_request_id: null, frozen_hash: null,
    scheduled_at: ctx.now, timezone: settings.timezone, limits: { window: null, daily_cap: settings.daily_cap },
  };
  const start = now(ctx);
  const job = ctx.create(JOB, {
    ...baseJob(ctx, { kind: 'publish_post', account, binding, device, settings, mode: 'auto', not_before: start, not_after: start + 30 * 60_000,
      prepare_lead_min: 0 }),
    dry_run: true, payload, payload_hash: digest(payload), media_refs: refs,
  });
  addEvent(ctx, job, 'dispatched', { dry_run: true, bundled: !input.media_id }, { actor: 'human' });
  bumpSyncGeneration(ctx, [device.id], 'dry_run_requested');
  ctx.emit('worker.job.dispatched', { job_id: job.id, publish_target_id: null, social_account_id: account.id, device_id: device.id, not_before: job.not_before });
  return job;
}

/**
 * §5.2 media still uploading: once the asset version has its file object, fill file_id, recompute payload_hash and clear
 * media_pending; a job the lifecycle had parked as needs_owner(media_unavailable) before any claim returns to queued.
 */
export function refreshPendingMedia(ctx: Context) {
  for (const job of liveJobs(ctx, row => row.media_pending === true)) {
    const payload = job.payload as PublishPostPayload;
    const refs = Array.isArray(job.media_refs) ? job.media_refs as { asset_id: string | null; asset_version_id: string | null }[] : [];
    const media = payload.media.map((item, index) => {
      if (item.file_id || item.bundled) return item;
      const ref = refs[index];
      if (!ref?.asset_version_id) return item;
      const fresh = jobMedia(ctx, { asset_id: ref.asset_id, asset_version_id: ref.asset_version_id }).media;
      return fresh.file_id ? { ...item, ...fresh, sha256: item.sha256 || fresh.sha256 } : item;
    });
    if (media.some(item => !item.file_id && !item.bundled)) continue;
    const next = { ...payload, media };
    const parked = job.status === 'needs_owner' && (job.blocker as Data | null)?.code === 'media_unavailable' && !job.claimed_at;
    setJob(ctx, job, { payload: next, payload_hash: digest(next), media_pending: false, ...(parked && { status: 'queued', blocker: null }) });
    addEvent(ctx, job, 'media_ready', { files: media.map(item => item.file_id) });
    bumpSyncGeneration(ctx, [String(job.device_id)], 'media_ready');
  }
}
