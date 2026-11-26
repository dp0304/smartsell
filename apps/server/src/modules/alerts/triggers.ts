import type { BlockerCode, Context, Data, Row } from '@smartsell/contracts';
import { BLOCKER_COPY, BLOCKER_SHORT, FAILED_REASON, MISSED_REASON, PAUSE_SCOPE, STATUS_COPY, channelAt, fill, lead, subject } from './copy.js';
import { boundDevice, channelLabel, detail, find, jobEvents, localLabel, machineLabel, providerLabel, str, workspaceTimezone } from './model.js';
import { createOwnerAlert } from './raise.js';
import { approvalAlert, clickPostAlert, pendingApprovals } from './reminders.js';

/**
 * Event-driven owner alerts (§5.9 table, §11.2 C13). Each helper below is safe to call inside the caller's short
 * transaction, never throws for missing rows and is idempotent per (kind, dedupe key). How each OwnerAlertKind is produced:
 *
 * | kind                      | producer                                                                                          |
 * |---------------------------|---------------------------------------------------------------------------------------------------|
 * | worker_blocker            | `worker.job.status_changed` to needs_owner (any code but owner_click_required; once per episode),  |
 * |                           | or to failed (not when the owner marked it not published)                                         |
 * | missed                    | `worker.job.status_changed` to missed; reminders scan: approval lapsed (reason not_approved)        |
 * | unknown                   | `worker.job.status_changed` to outcome_unknown or unreported                                        |
 * | late_fact_after_release   | `worker.job.late_fact`; or a successor cancelled with event successor_cancelled_predecessor_posted |
 * | approval_due              | `core.approval_request.created` (pending); reminders scan at T−60 and T−10 minutes                  |
 * | click_post_soon           | reminders scan at not_before − prepare_lead_min; needs_owner/owner_click_required ("ready", the   |
 * |                           | report or the scan); "not ready yet" when the Worker has not reported 2 minutes after not_before  |
 * | login_check_failed        | `worker.job.status_changed` of a check_login job to needs_owner or failed                          |
 * | upload_done               | `asset.version.created` for an `origin='agent_upload'` asset that is ready; or alertUploadDone()   |
 * | upload_failed             | S5 calls alertUploadFailed() when it marks the upload's asset failed (abort, hash, expiry)          |
 * | machine_offline_with_jobs | reminders scan: offline > 10 min (never counting hub downtime, AO-4) with a job due within 2 hours |
 * | machine_setup             | reminders scan: §3.2 warnings, when one first appears, changes, or returns after an hour (E43)      |
 * | published                 | `worker.job.status_changed` of a non-dry-run publish_post to succeeded                               |
 * | daily_summary             | reminders scan at 21:00 workspace time                                                              |
 * | offline_run_stale_settings| S3 calls alertOfflineStaleSettings() when it writes the offline_run_used_stale_settings job event  |
 * | handle_changed            | S3 calls alertHandleChanged() when it writes the handle_changed job event (E10)                    |
 */

export interface JobStatusChanged {
  job_id: string; from?: string | null; to: string; publish_target_id?: string | null; social_account_id?: string | null;
  device_id?: string | null; blocker_code?: string | null;
}

const LOGIN_STATE: Record<string, string> = {
  login_required: '登入已過期或還沒登入', identity_mismatch: 'Chrome 登入的不是這個帳號', challenge: '出現驗證碼或二次驗證',
  login_expired: '登入已過期或還沒登入', captcha: '出現驗證碼', two_factor: '要求二次驗證',
};

function context(ctx: Context, payload: JobStatusChanged) {
  const job = find(ctx, 'worker_job', payload.job_id);
  const machineId = str(payload.device_id) ?? str(job?.device_id);
  const accountId = str(payload.social_account_id) ?? str(job?.social_account_id);
  const postId = str(payload.publish_target_id) ?? str(job?.publish_target_id);
  const zone = workspaceTimezone(ctx);
  return {
    job, machineId, accountId, postId, zone,
    machine: machineLabel(ctx, machineId) ?? str((job?.blocker as Data | null)?.machine_name),
    channel: channelLabel(ctx, accountId) ?? str((job?.blocker as Data | null)?.channel_label),
    deadline: job ? localLabel(job.not_after, zone, ctx.now) : '',
    scheduled: job ? localLabel(job.not_before, zone, ctx.now) : '',
    refs: { machine_id: machineId, social_account_id: accountId, post_id: postId, job_id: payload.job_id },
  };
}

/** Whether `text` is already `template` filled in: it contains the fixed words just before {platform_message}. */
function isOwnerSentence(template: string, text: string | undefined) {
  const before = template.split('{platform_message}')[0]!.split('}').pop()!.trim();
  return !!text && template.includes('{platform_message}') && before.length > 0 && text.includes(before);
}

function blockerText(code: string | undefined, values: { machine?: string; channel?: string; deadline?: string }, job?: Row, failure?: Data) {
  const blocker = (job?.blocker ?? {}) as { code?: string; step?: string; message?: string; platform_message?: string };
  const template = code && Object.hasOwn(BLOCKER_COPY, code) ? BLOCKER_COPY[code as BlockerCode] : undefined;
  // {platform_message} is the platform's own error text (upload_rejected), clipped; it is never the caption. A stored blocker's
  // `message` is already the owner sentence made from that template (fullBlocker), so it is never filled in again (U7).
  const stored = str(blocker.message);
  const raw = str(blocker.platform_message) ?? str(failure?.message) ?? (template && blocker.code === code && isOwnerSentence(template, stored) ? undefined : stored);
  const platformMessage = raw?.slice(0, 200);
  if (template) return fill(template, { ...values, step: blocker.step, platform_message: platformMessage });
  return `${subject(values.machine, values.channel)} 需要你處理，已停止（截止 ${values.deadline || '期限'}）。`;
}

/** U1: the values of a blocker sentence (Appendix C.2), so the web can write it in the owner's language. */
function blockerParams(code: string | undefined, values: { machine?: string; channel?: string; deadline?: string }, job?: Row, failure?: Data) {
  const blocker = (job?.blocker ?? {}) as { step?: string; platform_message?: string };
  return { blocker_code: code ?? null, machine: values.machine ?? null, channel: values.channel ?? null, deadline: values.deadline || null,
    step: str(blocker.step) ?? null, platform_message: str(blocker.platform_message) ?? str(failure?.message) ?? null };
}

/** Reports after which a new needs_owner is a new episode: an auto blocker cleared by `prepared`, or the run going on. */
const EPISODE_END_EVENTS = new Set(['prepared', 'started']);

/**
 * AO-5: which needs_owner episode of this job this is, from the job's own events. Stable while the job stays blocked (the
 * blocking report itself is not counted), and different after the owner solved a blocker and the Worker went on.
 */
export function blockerEpisode(ctx: Context, job: Row | undefined): number {
  if (!job) return 0;
  return jobEvents(ctx, job.id).filter(event => EPISODE_END_EVENTS.has(String(event.event)) && detail(event).applied !== false).length;
}

function shortClause(code: string | undefined) {
  return code && Object.hasOwn(BLOCKER_SHORT, code) ? BLOCKER_SHORT[code as BlockerCode] : '需要你處理';
}

function missedReason(ctx: Context, job: Row | undefined): string {
  if (!job) return 'late';
  const events = jobEvents(ctx, job.id);
  for (const event of [...events].reverse()) {
    if (event.event === 'missed_unclaimed') return job.media_pending ? 'media_unavailable' : 'unclaimed';
    if (event.event === 'missed_machine_off') return 'machine_off';
    const reason = str(detail(event).reason);
    if ((event.event === 'missed' || event.event === 'go_denied' || event.event === 'missed_go_denied') && reason) return reason;
  }
  return job.media_pending ? 'media_unavailable' : 'late';
}

function pauseDetails(ctx: Context, accountId: string | undefined, machineId: string | undefined, zone: string) {
  const device = find(ctx, 'connector_device', machineId);
  if (device?.paused === true) {
    return { scope: PAUSE_SCOPE.machine, paused_at: localLabel(device.paused_at, zone, ctx.now) || undefined,
      paused_by: String(device.paused_by ?? '').startsWith('agent') ? ' Agent ' : '你' };
  }
  const account = find(ctx, 'social_account', accountId);
  const scopeOf = (row: Row) => ({ workspace: ctx.workspaceId, brand: account?.brand_id, social_account: accountId } as Record<string, unknown>)[String(row.scope_type)];
  const active = ctx.list('pause_switch').filter(row => row.released_at == null && row.scope_id === scopeOf(row))
    .sort((a, b) => String(b.activated_at ?? b.created_at).localeCompare(String(a.activated_at ?? a.created_at)))[0];
  return {
    scope: PAUSE_SCOPE[String(active?.scope_type)] ?? '帳號',
    paused_at: active ? localLabel(active.activated_at ?? active.created_at, zone, ctx.now) : undefined,
    paused_by: active?.created_via === 'agent' ? ' Agent ' : '你',
  };
}

/** Owner alert for a worker job status transition (event `worker.job.status_changed`, §11.2 C3). */
export function alertJobStatus(ctx: Context, payload: JobStatusChanged): Row | undefined {
  const c = context(ctx, payload);
  const job = c.job;
  const kind = str(job?.kind) ?? (c.postId ? 'publish_post' : undefined);
  const dryRun = job?.dry_run === true;
  const code = str(payload.blocker_code) ?? str((job?.blocker as Data | null)?.code);
  const who = subject(c.machine, c.channel);
  const post = channelAt(c.machine, c.channel);
  const values = { machine: c.machine, channel: c.channel, deadline: c.deadline };

  if (kind === 'check_login' && (payload.to === 'needs_owner' || payload.to === 'failed')) {
    const loginEvent = job && [...jobEvents(ctx, job.id)].reverse().find(event => event.event === 'login_state');
    const state = LOGIN_STATE[str(detail(loginEvent).state) ?? code ?? ''] ?? '沒有通過';
    return createOwnerAlert(ctx, {
      kind: 'login_check_failed', severity: 'urgent', dedupe_key: payload.job_id,
      code: 'login_check_failed', params: { machine: c.machine ?? null, channel: c.channel ?? null, state: str(detail(loginEvent).state) ?? code ?? null },
      title: `${who} 登入檢查失敗：${state}。`,
      body: `${who} 的登入檢查沒有通過（${state}）。排好的貼文到時可能發不出去；請在 ${c.machine ?? '那台機器'} 的 SmartSell Chrome 視窗重新登入，或在帳號頁按「檢查登入」再試一次。`,
      ...c.refs, post_id: undefined,
    });
  }
  if (kind !== 'publish_post') return undefined;

  switch (payload.to) {
    case 'needs_owner': {
      if (code === 'owner_click_required') return job && !dryRun ? clickPostAlert(ctx, job, 'due') : undefined;
      // A retried event for a transition the job has already left: the episode it named is over.
      if (job && job.status !== 'needs_owner') return undefined;
      // One alert per (code, owner resume, episode): a second captcha hours after a solved one is news (AO-5).
      const episode = blockerEpisode(ctx, job);
      const key = `${payload.job_id}:${code ?? 'unknown'}:${Number(job?.resume_token) || 0}`;
      return createOwnerAlert(ctx, {
        kind: 'worker_blocker', severity: 'urgent', dedupe_key: episode ? `${key}:e${episode}` : key,
        code: 'worker_blocker', params: { ...blockerParams(code, values, job), dry_run: dryRun },
        title: `${who}：${shortClause(code)}${dryRun ? '（試跑）' : ''}。`, body: blockerText(code, values, job), ...c.refs,
      });
    }
    case 'failed': {
      // Only the owner's own "mark not published" (§5.14) ends outcome_unknown/unreported in failed without an alert.
      if (job?.owner_marked_not_published === true || (job && jobEvents(ctx, job.id).some(item => item.event === 'owner_marked_not_published'))) return undefined;
      const event = detail(job && [...jobEvents(ctx, job.id)].reverse().find(item => item.event === 'failed'));
      const failure = code ?? str(event.code);
      if (payload.from === 'outcome_unknown' || payload.from === 'unreported') {
        // AO-7: the machine reported later that it stopped before sending; the follow-up the unreported alert promised.
        const reported = failure ?? str((job?.failure as Data | null)?.code);
        const reason = reported && reported !== 'default' && Object.hasOwn(FAILED_REASON, reported) ? FAILED_REASON[reported]! : FAILED_REASON.default!;
        return createOwnerAlert(ctx, {
          kind: 'worker_blocker', severity: 'urgent', dedupe_key: `${payload.job_id}:failed`,
          code: 'failed_late_report', params: { machine: c.machine ?? null, channel: c.channel ?? null, reason_code: reported ?? 'default', dry_run: dryRun },
          title: `${lead(post)}的貼文沒有發出（${c.machine ?? '機器'} 後來回報）${dryRun ? '（試跑）' : ''}。`,
          body: fill(STATUS_COPY.failed_late_report, { machine: c.machine, channel: c.channel, reason }), ...c.refs,
        });
      }
      return createOwnerAlert(ctx, {
        kind: 'worker_blocker', severity: 'urgent', dedupe_key: `${payload.job_id}:failed`,
        code: 'failed', params: { ...blockerParams(failure, values, job, event), dry_run: dryRun },
        title: `${who}：${shortClause(failure)}，這則沒有發出${dryRun ? '（試跑）' : ''}。`,
        body: blockerText(failure, values, job, event), ...c.refs,
      });
    }
    case 'missed': {
      if (dryRun) return undefined;
      const reason = missedReason(ctx, job);
      const label = MISSED_REASON[reason] ?? MISSED_REASON.late!;
      const body = reason === 'paused'
        ? `${who}：${fill(STATUS_COPY.missed_paused, pauseDetails(ctx, c.accountId, c.machineId, c.zone))}`
        : `${c.channel ?? '這個帳號'}：${fill(STATUS_COPY.missed, { machine: c.machine, deadline: c.deadline, reason: label })}`;
      return createOwnerAlert(ctx, {
        kind: 'missed', severity: 'urgent', dedupe_key: payload.job_id, title: `${lead(post)}的貼文沒有發出（${label}）。`, body, ...c.refs,
        code: 'missed', params: { machine: c.machine ?? null, channel: c.channel ?? null, deadline: c.deadline || null, reason_code: reason,
          ...(reason === 'paused' && (() => { const pause = pauseDetails(ctx, c.accountId, c.machineId, c.zone);
            return { pause_scope: Object.entries(PAUSE_SCOPE).find(([, word]) => word === pause.scope)?.[0] ?? null, paused_at: pause.paused_at ?? null,
              paused_by: pause.paused_by.includes('Agent') ? 'agent' : 'person' }; })()) },
      });
    }
    case 'outcome_unknown': case 'unreported': {
      if (dryRun) return undefined;
      const unreported = payload.to === 'unreported';
      const text = unreported ? fill(STATUS_COPY.unreported, { machine: c.machine, channel: c.channel, local_time: c.scheduled })
        : code === 'result_conflict' || code === 'platform_error' ? blockerText(code, values, job)
          : fill(STATUS_COPY.unknown, { machine: c.machine, channel: c.channel });
      return createOwnerAlert(ctx, {
        kind: 'unknown', severity: 'urgent', dedupe_key: `${payload.job_id}:${payload.to}`,
        code: unreported ? 'unreported' : code === 'result_conflict' || code === 'platform_error' ? 'unknown_blocker' : 'unknown',
        params: { ...blockerParams(code, values, job), local_time: c.scheduled || null },
        title: unreported ? `${c.machine ?? '機器'} 未回報 ${c.scheduled || '預定時間'} 的 ${c.channel ?? '帳號'} 貼文。`
          : `${lead(post)}的貼文結果不明，請確認有沒有發出。`,
        body: text, ...c.refs,
      });
    }
    case 'succeeded': {
      if (dryRun || (job?.result as Data | null)?.dry_run) return undefined;
      const at = localLabel((job?.result as Data | null)?.published_at ?? ctx.now, c.zone, ctx.now);
      return createOwnerAlert(ctx, {
        kind: 'published', severity: 'info', dedupe_key: c.postId ?? payload.job_id,
        code: 'published', params: { machine: c.machine ?? null, channel: c.channel ?? null, at },
        title: `${c.channel ?? '帳號'} 已由 ${c.machine ?? '機器'} 在 ${at} 發出。`,
        body: `${c.channel ?? '帳號'} 已由 ${c.machine ?? '機器'} 在 ${at} 發出，網址已回到 SmartSell。`, ...c.refs,
      });
    }
    case 'cancelled': {
      const predecessor = str(job?.waits_for_job_id);
      if (!job || !predecessor || !jobEvents(ctx, job.id).some(event => event.event === 'successor_cancelled_predecessor_posted')) return undefined;
      return alertLateFact(ctx, { job_id: predecessor, publish_target_id: c.postId ?? null, successor_cancelled: true });
    }
    default: return undefined;
  }
}

/** Event `worker.job.late_fact` (§5.4.3, §5.2): a revoked or force-released job reported that it posted. Keyed by the old job. */
export function alertLateFact(ctx: Context, payload: { job_id: string; publish_target_id?: string | null; successor_cancelled?: boolean }): Row | undefined {
  const c = context(ctx, { job_id: payload.job_id, to: 'late_fact', publish_target_id: payload.publish_target_id });
  const who = subject(c.machine, c.channel);
  const cancelled = payload.successor_cancelled === true;
  return createOwnerAlert(ctx, {
    kind: 'late_fact_after_release', severity: 'urgent', dedupe_key: payload.job_id,
    code: 'late_fact_after_release', params: { machine: c.machine ?? null, channel: c.channel ?? null, cancelled },
    title: `${who} 在撤回後仍發出了舊版本${cancelled ? '，新版本已取消' : ''}。`,
    body: cancelled ? fill(STATUS_COPY.late_fact_after_release, { machine: c.machine, channel: c.channel })
      : `${c.machine ?? '機器'} 在撤回或強制釋放後，仍回報已發出（或可能已發出）${c.channel ?? '這個帳號'} 的貼文；系統不會自動重發。請到貼文頁確認。`,
    ...c.refs,
  });
}

/** S3 (§5.4.3 `started`, go:'offline'): the job's hold or mode changed after the machine's last sync. Keyed by the job. */
export function alertOfflineStaleSettings(ctx: Context, payload: { job_id: string; publish_target_id?: string | null }): Row | undefined {
  const c = context(ctx, { job_id: payload.job_id, to: 'running', publish_target_id: payload.publish_target_id });
  return createOwnerAlert(ctx, {
    kind: 'offline_run_stale_settings', severity: 'urgent', dedupe_key: payload.job_id,
    code: 'offline_run_stale_settings', params: { machine: c.machine ?? null, channel: c.channel ?? null },
    title: `${subject(c.machine, c.channel)} 以舊設定離線發出。`,
    body: fill(STATUS_COPY.offline_run_stale_settings, { machine: c.machine, channel: c.channel }),
    ...c.refs,
  });
}

/**
 * E10 (§3.3): the handle a Worker read (prepare, check_login) or the owner's confirmed URL differs from the stored one.
 * The first handle ever seen for an account is not a change and raises nothing. Keyed by account and the old → new pair.
 */
export function alertHandleChanged(ctx: Context, input: { social_account_id: string; from?: string | null; to: string; machine_id?: string | null; job_id?: string }): Row | undefined {
  const clean = (value: unknown) => str(value)?.trim().replace(/^@/, '').toLowerCase();
  const from = clean(input.from);
  const to = clean(input.to);
  if (!from || !to || from === to) return undefined;
  const account = find(ctx, 'social_account', input.social_account_id);
  const machineId = str(input.machine_id) ?? boundDevice(ctx, input.social_account_id);
  const provider = providerLabel(account) ?? '平台';
  return createOwnerAlert(ctx, {
    kind: 'handle_changed', severity: 'normal', dedupe_key: `${input.social_account_id}:${from}:${to}`,
    code: 'handle_changed', params: { machine: machineLabel(ctx, machineId) ?? null, provider, from, to },
    title: `${provider} 帳號 @${from} 的名稱改成了 @${to}。`,
    body: fill(STATUS_COPY.handle_changed, { machine: machineLabel(ctx, machineId), provider, from, to }),
    social_account_id: input.social_account_id, ...(machineId && { machine_id: machineId }), ...(input.job_id && { job_id: input.job_id }),
  });
}

/** Event `core.approval_request.created`: notify once at scheduling time when a hub post needs the owner's approval (§4.2). */
export function alertApprovalCreated(ctx: Context, requestId: string): Row | undefined {
  const entry = pendingApprovals(ctx).find(({ request }) => request.id === requestId);
  return entry ? approvalAlert(ctx, entry.request, entry.target, 'created') : undefined;
}

const UPLOAD_REASON: Record<string, string> = {
  file_changed: '檔案在上傳中被改動', cancelled: '上傳被取消', error: '上傳出錯', expired: '24 小時內沒有完成',
  UPLOAD_HASH_MISMATCH: '檔案校驗不符', UPLOAD_EXPIRED: '24 小時內沒有完成',
};

/** upload_done (§6.3 step 9). S5 may call it after recordAssembledObject; the asset.version.created trigger covers it otherwise. */
export function alertUploadDone(ctx: Context, input: { media_id: string; filename?: string }): Row | undefined {
  const asset = find(ctx, 'asset', input.media_id);
  const name = input.filename ?? str(asset?.title) ?? '影片';
  return createOwnerAlert(ctx, {
    kind: 'upload_done', severity: 'normal', dedupe_key: input.media_id, code: 'upload_done', params: { filename: input.filename ?? str(asset?.title) ?? null },
    title: `${name} 已上傳完成。`, body: `${name} 已上傳到中樞並完成檢查，排好的貼文可以照常發出。`,
  });
}

/** upload_failed (§6.3, §6.4): S5 calls this in the transaction that marks the upload's asset failed. */
export function alertUploadFailed(ctx: Context, input: { media_id: string; filename?: string; reason?: string }): Row | undefined {
  const asset = find(ctx, 'asset', input.media_id);
  const name = input.filename ?? str(asset?.title) ?? '影片';
  const reason = (input.reason && UPLOAD_REASON[input.reason]) ?? '上傳沒有完成';
  return createOwnerAlert(ctx, {
    kind: 'upload_failed', severity: 'urgent', dedupe_key: input.media_id,
    code: 'upload_failed', params: { filename: input.filename ?? str(asset?.title) ?? null, reason_code: input.reason ?? null },
    title: `${name} 上傳失敗（${reason}）。`,
    body: `${name} 上傳失敗（${reason}），用到它的貼文在重新上傳前發不出去。請在 Codex 對這個檔案再執行一次上傳。`,
  });
}

export const TRIGGER_EVENTS: ReadonlySet<string> = new Set(['worker.job.status_changed', 'worker.job.late_fact', 'core.approval_request.created', 'asset.version.created']);

export function applyAlertEvent(ctx: Context, type: string, data: Data): Row | undefined {
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  switch (type) {
    case 'worker.job.status_changed': {
      const jobId = text(data.job_id);
      const to = text(data.to);
      return jobId && to ? alertJobStatus(ctx, { ...data, job_id: jobId, to } as JobStatusChanged) : undefined;
    }
    case 'worker.job.late_fact': {
      const jobId = text(data.job_id);
      return jobId ? alertLateFact(ctx, { job_id: jobId, publish_target_id: text(data.publish_target_id) ?? null,
        successor_cancelled: data.successor_cancelled === true }) : undefined;
    }
    case 'core.approval_request.created': {
      const requestId = text(data.request_id) ?? text(data.approval_request_id);
      return requestId ? alertApprovalCreated(ctx, requestId) : undefined;
    }
    case 'asset.version.created': {
      const asset = find(ctx, 'asset', data.asset_id);
      return asset && asset.origin === 'agent_upload' && asset.status === 'ready' ? alertUploadDone(ctx, { media_id: asset.id }) : undefined;
    }
    default: return undefined;
  }
}

export const alertTriggerSubscriber = {
  id: 'alerts.triggers',
  accepts: (type: string) => TRIGGER_EVENTS.has(type),
  run(ctx: Context, event: Data) {
    const data = (event.data ?? event.payload ?? {}) as Data;
    applyAlertEvent(ctx, String(event.type), data);
  },
};
