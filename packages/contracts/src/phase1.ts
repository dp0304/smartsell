// ---------- Providers & modes ----------
export const HUB_PROVIDERS = ['x', 'tiktok', 'youtube', 'meta_instagram', 'meta_facebook'] as const;
export type HubProvider = typeof HUB_PROVIDERS[number];
export const DRIVER_PROVIDERS = ['x', 'tiktok'] as const;            // 第 1 階段有驅動
export type DriverProvider = typeof DRIVER_PROVIDERS[number];
/** 每個以瀏覽器驅動的平台都需要風險確認；第 3 階段加入驅動時必須同時加入 RISK_TERMS。 */
export const RISK_ACK_PROVIDERS: readonly HubProvider[] = DRIVER_PROVIDERS;
export const MCP_PROVIDER: Record<HubProvider, 'x' | 'tiktok' | 'youtube' | 'instagram' | 'facebook'> =
  { x: 'x', tiktok: 'tiktok', youtube: 'youtube', meta_instagram: 'instagram', meta_facebook: 'facebook' };
export type ExecutionMode = 'browser_auto' | 'browser_assist' | 'api';
export type ApprovalMode = 'direct' | 'needs_approval';
export type EffectiveMode = 'auto' | 'assist' | 'owner';
export type RouteKind = 'machine' | 'api' | 'owner';

// ---------- Channel settings ----------
export const RISK_TERMS_VERSION = 'browser-automation-risk-2026-11';
export const RISK_TERMS: Record<DriverProvider, { zh_hant: string; en: string }> = {
  x: { zh_hant: 'X 的自動化規則寫明：以非 API 方式自動化（例如用腳本操作 X 網站）可能導致帳號被永久停權。SmartSell 只會在這台機器上的原版 Chrome 以正常速度操作，不偽造指紋、不規避偵測，遇到驗證碼會停下交給你。我了解並接受風險，允許 Worker 在這個帳號代按發布。',
       en: "X's automation rules state that non-API automation, such as scripting the X website, may result in permanent suspension. SmartSell only operates the stock Chrome on this machine at a normal pace, never spoofs fingerprints or evades detection, and stops for any captcha. I understand and accept the risk and allow the Worker to click Post for this account." },
  tiktok: { zh_hant: 'TikTok 的服務條款禁止以自動化方式操作服務。SmartSell 只會在這台機器上的原版 Chrome 以正常速度操作，不偽造指紋、不規避偵測，遇到驗證碼會停下交給你。我了解並接受風險，允許 Worker 在這個帳號代按發布。',
            en: "TikTok's Terms of Service prohibit automated access. SmartSell only operates the stock Chrome on this machine at a normal pace, never spoofs fingerprints or evades detection, and stops for any captcha. I understand and accept the risk and allow the Worker to click Post for this account." },
};
export const AUTOMATION_NOTICE_VERSION = 'automation-notice-2026-11';
export const AUTOMATION_NOTICE: { zh_hant: string; en: string } = {
  zh_hant: 'SmartSell 會在這台機器上開啟並操作這個帳號的網頁（登入檢查、準備貼文、試跑）。平台的規則涵蓋以程式操作網站的行為，即使不代按發布也有風險。代按發布另外需要風險確認。',
  en: 'SmartSell will open and operate this account\'s pages on this machine (login checks, preparing posts, dry runs). Platform rules cover scripted use of their websites, so this carries risk even without clicking Post. Clicking Post additionally requires the risk acknowledgement.',
};
export interface RiskAck { at: string; by_user_id: string; terms_version: string; text_sha256: string }
export interface AutomationNoticeAck { at: string; via: 'worker_app' | 'web'; by: string; version: string }
export function riskAckCurrent(ack: RiskAck | null): boolean { return !!ack && ack.terms_version === RISK_TERMS_VERSION; }
export interface PublishWindow { start: string; end: string; days: (1 | 2 | 3 | 4 | 5 | 6 | 7)[] } // 'HH:mm'; 1 = Monday
export interface TikTokDefaults {
  privacy_level: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  allow_comment: boolean;
  allow_duet: boolean; allow_stitch: boolean;   // 沿用既有鍵；介面上是一個「允許內容再利用」開關，同時寫入兩者
  commercial_disclosure: 'none' | 'your_brand' | 'branded_content' | 'both';
  ai_generated: boolean;
}
export interface XDefaults { reply_settings: 'everyone' | 'following' | 'mentioned' | 'verified' }
export interface PlatformDefaults { tiktok?: TikTokDefaults; x?: XDefaults }
export interface ChannelSettingsRecord {
  id: string; social_account_id: string; version: number; created_at: string; updated_at: string;
  execution_mode: ExecutionMode; approval_mode: ApprovalMode; approval_mode_confirmed_at: string | null;
  automation_notice_ack: AutomationNoticeAck | null; risk_ack: RiskAck | null;
  daily_cap: number; window: PublishWindow | null; timezone: string; lateness_limit_min: number;
  caption_limit: number | null; chrome_profile_key: string; platform_defaults: PlatformDefaults;
  settings_generation: number; approval_generation: number;
  // 帳號的暫停一律用 pause_switch（scope_type='social_account'），這裡沒有 paused 欄位
}
export type LoginState = 'unknown' | 'checking' | 'verified' | 'login_required' | 'identity_mismatch' | 'challenge';
export interface ChannelReadiness {
  logged_in: boolean; automation_notice: boolean; defaults_ready: boolean; approval_mode_chosen: boolean;
  risk_ack_or_assist: boolean; dry_run_passed: boolean;
}

// ---------- Timing constants ----------
export const READBACK_SCHEDULE_SEC: readonly number[] = [30, 60, 120, 300, 600, 1200, 1200];   // 合計 3510 秒
export const RESULT_PENDING_GUARD_SEC = READBACK_SCHEDULE_SEC.reduce((sum, value) => sum + value, 0) + 1800;
export const GO_TIMEOUT_MS = 20_000;
export const GO_OFFLINE_ATTEMPTS = 2;
export const GO_OFFLINE_MIN_GAP_MS = 5_000;
export const PAUSED_GO_RETRY_MS = 30_000;
export const LOGIN_CHECK_MAX_AGE_H = 12;
export const PREFLIGHT_SKIP_IF_CHECKED_WITHIN_MIN = 30;
export const PRESENCE_WRITE_INTERVAL_MS = 300_000;
export const CLOCK_MARGIN_MS = 120_000;
export const BLOCKER_POLL_MS = 10_000;

// ---------- Worker jobs ----------
export const WORKER_JOB_KINDS = ['publish_post', 'check_login'] as const;
export const RESERVED_JOB_KINDS = ['read_metrics', 'read_comments', 'send_reply', 'import_catalog'] as const;
export type WorkerJobKind = typeof WORKER_JOB_KINDS[number];
export type WorkerJobStatus = 'queued' | 'claimed' | 'ready' | 'running' | 'submitting' | 'result_pending' | 'succeeded'
  | 'needs_owner' | 'failed' | 'missed' | 'outcome_unknown' | 'unreported' | 'releasing' | 'cancelled' | 'superseded';
export const TERMINAL_JOB_STATUSES: readonly WorkerJobStatus[] = ['succeeded', 'failed', 'missed', 'cancelled', 'superseded'];
export type RevokeReason = 'cancelled' | 'approval_invalidated' | 'superseded';
export type BlockerCode = 'captcha' | 'two_factor' | 'login_expired' | 'identity_mismatch' | 'risk_prompt' | 'owner_click_required'
  | 'driver_outdated' | 'media_unavailable' | 'media_hash_mismatch' | 'upload_rejected' | 'caption_rejected' | 'confirm_dialog'
  | 'chrome_unavailable' | 'profile_in_use' | 'platform_error' | 'machine_paused' | 'owner_stopped' | 'result_conflict';
/** Worker 自己等到狀況解除就繼續（驗證類只唯讀觀察同一分頁，§5.9）。 */
export const AUTO_RESUME_BLOCKERS: readonly BlockerCode[] = ['captcha', 'two_factor', 'login_expired', 'identity_mismatch',
  'chrome_unavailable', 'profile_in_use', 'media_unavailable', 'owner_click_required'];
/** 停止、不重試；主人按「恢復」（hub_jobs_resume）後才重新準備一次。 */
export const OWNER_RESUME_BLOCKERS: readonly BlockerCode[] = ['risk_prompt', 'platform_error', 'driver_outdated', 'caption_rejected', 'confirm_dialog'];
export interface Blocker {
  code: BlockerCode; phase: 'prepare' | 'before_submit' | 'after_submit'; message: string;
  resumable_by: 'auto' | 'owner' | 'none';
  machine_id: string; machine_name: string; social_account_id: string; channel_label: string;
  step?: string; url?: string; evidence_sha256?: string[]; at: string;
  /** 附加（U7）：平台自己的錯誤文字（例如 upload_rejected 的原因），未經套版；message 已是套好版的主人文案。 */
  platform_message?: string;
}
export interface JobChannel { social_account_id: string; handle: string | null; display_name: string; profile_key: string; expected_identity: string }
export interface JobMedia {
  file_id: string | null;      // null：media_pending 的 job（claim 時一定有值），或使用內建測試影片
  bundled?: 'test-clip-v1';    // 只出現在試跑
  sha256: string; bytes: number; mime: string; filename: string; kind: 'video' | 'image';
  duration_ms: number | null; width: number | null; height: number | null;
}
export interface PublishPostPayload {
  schema: 'smartsell.worker.publish.v1'; provider: DriverProvider; channel: JobChannel;
  caption: { text: string; title: string | null }; media: JobMedia[]; options: PlatformDefaults;
  publish_target_id: string | null; execution_task_id: string | null; approval_request_id: string | null; frozen_hash: string | null;
  scheduled_at: string; timezone: string; limits: { window: PublishWindow | null; daily_cap: number };
}
export interface CheckLoginPayload { schema: 'smartsell.worker.check_login.v1'; provider: HubProvider; channel: JobChannel; open_login_window: boolean }
export interface WorkerJobRecord {
  id: string; version: number; created_at: string; updated_at: string; kind: WorkerJobKind; status: WorkerJobStatus;
  device_id: string; device_history: string[]; social_account_id: string; binding_id: string; chrome_profile_key: string;
  publish_target_id: string | null; execution_task_id: string | null; attempt_id: string | null;
  dry_run: boolean; mode: 'auto' | 'assist'; not_before: string; not_after: string; prepare_lead_min: number; offline_go_max_staleness_min: number;
  payload: PublishPostPayload | CheckLoginPayload; payload_hash: string; settings_generation: number; frozen_hash: string | null;
  fencing_token: number; lease_expires_at: string | null; seq_by_fence: Record<string, number>;
  waits_for_job_id: string | null; media_pending: boolean; resume_token: number;
  claimed_at: string | null; preflight_at: string | null; prepared_at: string | null; go_at: string | null; started_at: string | null;
  submitting_at: string | null; submitted_at: string | null; finished_at: string | null;
  go_source: 'hub' | 'offline' | null; submitted_by: 'auto' | 'owner' | null;
  revoke: null | { reason: RevokeReason; requested_at: string };
  blocker: Blocker | null;
  result: null | { url: string | null; external_post_id: string | null; published_at: string | null; evidence_sha256: string[];
    late_by_sec: number; dry_run?: true; fence_override?: true };
  driver: null | { provider: string; version: string }; retry_of_job_id: string | null;
  /** Lead amendment E17: set by hub_jobs_force_release (the job is then cancelled). */
  force_released?: boolean;
}
/** 可能已在平台上產生效果的 job：後繼 job 不得放行（§5.11）。 */
export function possiblySent(job: Pick<WorkerJobRecord, 'status' | 'submitting_at' | 'started_at'>): boolean {
  if (['running', 'submitting', 'result_pending', 'succeeded', 'outcome_unknown', 'unreported'].includes(job.status)) return true;
  if (job.submitting_at) return true;
  return !!job.started_at && (job.status === 'needs_owner' || job.status === 'releasing');
}

/**
 * Lead amendment E36: the hub has its own record that the job may have run — it said go, or the machine reported started or
 * submitting. Such a job is never force-released (409 POSSIBLY_SENT) and E17's missed applies only to the others.
 */
export function hubSawStart(job: object): boolean {
  const row = job as Partial<Record<'go_at' | 'started_at' | 'submitting_at', unknown>>;
  return !!(row.go_at || row.started_at || row.submitting_at);
}

// ---------- Device protocol (signed; §5.4) ----------
export interface DriverHealth { provider: DriverProvider; version: string; health: 'ok' | 'outdated' | 'unknown'; step?: string }
export interface DevicePosture {
  os: 'darwin' | 'win32'; os_version: string; sleep_idle_min: number | null; on_battery: boolean | null;
  auto_login: 'on' | 'off' | 'unknown'; filevault: 'on' | 'off' | 'unknown' | 'n/a'; power_plan_sleep_min: number | null;
}
export interface RemoteAccess { kind: 'vnc' | 'rdp'; host: string }
export interface HeartbeatV2Request {
  client_version: string; protocol: 2; drivers: DriverHealth[];
  jobs: { job_id: string; local_state: string; fencing_token: number }[]; released_jobs?: string[];
  outbox_depth: number; worker_time: string; applied_sync_generation: number;
  posture?: DevicePosture; remote_access?: RemoteAccess | null;
  /** Lead amendment after wave 2: CPU architecture, so latest_worker names the right macOS package. */
  arch?: 'arm64' | 'x64';
}
export type GoDenyReason = 'fence_lost' | 'invalid_state' | 'too_early' | 'too_late' | 'revoked' | 'approval_invalid' | 'paused'
  | 'rebound' | 'daily_cap_reached' | 'outside_window';
export interface HeldJobState {
  job_id: string; fencing_token: number; hold: boolean; hold_reason: GoDenyReason | null; mode: 'auto' | 'assist'; resume_token: number;
}
export interface HeartbeatV2Response {
  status: 'online'; protocol: 2; server_time: string; paused: boolean; pause_all: boolean; claimable: number; sync_generation: number;
  jobs: HeldJobState[];
  revoked_jobs: { job_id: string; reason: RevokeReason }[];
  channels: { social_account_id: string; provider: HubProvider; handle: string | null; expected_identity: string; profile_key: string;
    effective_mode: EffectiveMode; paused: boolean; settings_generation: number; login_check_requested: boolean }[];
  latest_worker: { version: string; platform: 'mac-arm64' | 'mac-x64' | 'win-x64'; url: string; sha256: string } | null;
  driver_config: { version: string; sha256: string } | null;
}
export interface ClaimRequest { kinds: WorkerJobKind[]; horizon_minutes: number; max: number; held_job_ids: string[] }
export interface ClaimedJob {
  job_id: string; kind: WorkerJobKind; fencing_token: number; mode: 'auto' | 'assist'; dry_run: boolean;
  not_before: string; not_after: string; lease_expires_at: string; prepare_lead_min: number; offline_go_max_staleness_min: number;
  payload_hash: string; payload: PublishPostPayload | CheckLoginPayload;
}
export interface ClaimResponse { jobs: ClaimedJob[]; server_time: string }
export type JobReportEvent = 'prepared' | 'prepare_blocked' | 'started' | 'submitting' | 'submitted' | 'readback_pending' | 'result'
  | 'blocked' | 'failed' | 'missed' | 'dry_run_done' | 'outcome_unknown' | 'released' | 'login_state';
export type DeviceBlocker = Omit<Blocker, 'machine_id' | 'machine_name' | 'social_account_id' | 'channel_label' | 'resumable_by'>;
export type JobReportData =
  | { event: 'prepared'; stage: 'preflight' | 'final'; login: 'verified'; identity: string; handle: string | null; media_ok: true; driver: { provider: string; version: string } }
  | { event: 'prepare_blocked'; stage: 'preflight' | 'final'; blocker: DeviceBlocker }
  | { event: 'blocked'; blocker: DeviceBlocker }
  | { event: 'started'; go: 'hub' | 'offline'; mode: 'auto' | 'assist' }
  | { event: 'submitting' }
  | { event: 'submitted'; toast_url?: string }
  | { event: 'readback_pending'; attempt: number; next_at: string }
  | { event: 'result'; url: string | null; external_post_id: string | null; published_at: string | null; evidence_sha256: string[]; submitted_by: 'auto' | 'owner'; go: 'hub' | 'offline' }
  | { event: 'failed'; code: 'media_hash_mismatch' | 'upload_rejected' | 'caption_rejected'; message: string; evidence_sha256?: string[] }
  | { event: 'missed'; reason: 'late' | 'machine_was_off' | 'owner_not_clicked' | 'prepare_blocked' | 'chrome_unavailable' | 'paused' }
  | { event: 'dry_run_done'; evidence_sha256: string[]; trace: DriverTraceStep[] }
  | { event: 'outcome_unknown'; reason: string; evidence_sha256: string[] }
  | { event: 'released' }
  | { event: 'login_state'; state: Exclude<LoginState, 'unknown' | 'checking'>; identity: string | null; handle: string | null; evidence_sha256: string[] };
export interface JobReport { job_id: string; fencing_token: number; seq: number; event_id: string; worker_time: string; event: JobReportEvent; data: JobReportData }
/** 事實：不論 fencing 與 job 狀態都收下（§5.4.3）。其他事件是租約回報，需要 fencing 相符。 */
export const FACT_EVENTS: readonly JobReportEvent[] = ['started', 'submitting', 'submitted', 'result', 'outcome_unknown', 'dry_run_done'];
export function isFactReport(report: Pick<JobReport, 'event' | 'data'>): boolean {
  if (FACT_EVENTS.includes(report.event)) return true;
  return report.event === 'blocked' && (report.data as { blocker?: { phase?: string } }).blocker?.phase === 'after_submit';
}
export interface GoRequest { job_id: string; fencing_token: number }
export type GoResponse = { go: true; mode: 'auto' | 'assist'; server_time: string } | { go: false; reason: GoDenyReason; release: boolean };
export interface Presence {
  last_seen_at: string; last_job_sync_at: string | null; protocol: 1 | 2; client_version: string; drivers: DriverHealth[];
  clock_offset_ms: number | null; outbox_depth: number; posture: DevicePosture | null; applied_sync_generation: number;
}
export interface DriverTraceStep { step: string; ms: number; matched: 'primary' | 'fallback' | 'none' }

// ---------- Owner alerts (S10, §5.9) ----------
export type OwnerAlertKind = 'worker_blocker' | 'missed' | 'unknown' | 'late_fact_after_release' | 'approval_due' | 'click_post_soon'
  | 'login_check_failed' | 'upload_done' | 'upload_failed' | 'machine_offline_with_jobs' | 'machine_setup' | 'published' | 'daily_summary'
  // Lead amendment after wave 1: a Worker ran a post offline with hold/mode that changed after its last sync (§5.4.3 `started`).
  | 'offline_run_stale_settings'
  // Lead amendment after wave 2: the platform handle a Worker read differs from the stored one (§3.3 'handle_changed 通知主人').
  | 'handle_changed';
export interface OwnerAlert {
  id: string; kind: OwnerAlertKind; severity: 'urgent' | 'normal' | 'info'; title: string; body: string; at: string;
  machine: Ref | null; channel: Ref | null; post: Ref | null; web_url: string; read_at: string | null;
  /** 附加（U1）：title／body 是哪一句話與其中的值，網頁依介面語言重寫；title／body 仍是繁中，給 Agent 與舊版用戶端。 */
  code?: string; params?: Record<string, unknown>;
}
export type AlertChannelConfig =
  | { kind: 'ntfy'; url: string; token_set: boolean }
  | { kind: 'bark'; url: string }
  | { kind: 'telegram'; chat_id: string; token_set: boolean };

// ---------- Post status (single derivation used by every view and MCP) ----------
export type PostStatus = 'draft' | 'blocked' | 'awaiting_approval' | 'scheduled' | 'ready' | 'publishing' | 'confirming'
  | 'published' | 'needs_owner' | 'missed' | 'failed' | 'unknown' | 'cancelling' | 'cancelled'
  // Lead amendment E37: the owner rejected the post (the latest approval request was rejected, no newer request since).
  | 'rejected';
export function derivePostStatus(input: {
  plan_status: string; precheck_summary?: string | null; has_platform_post: boolean;
  job_status?: WorkerJobStatus | null; job_revoke_reason?: RevokeReason | null;
  approval_lapsed?: boolean;   // plan_status==='awaiting_approval' 且已超過 scheduled_at + lateness_limit_min
  /** Lead amendment E17: the latest job was force-released by the owner (hub_jobs_force_release). */
  job_force_released?: boolean;
  /** Lead amendment E37: the latest approval request of the target was rejected and no newer request exists. */
  approval_rejected?: boolean;
}): PostStatus {
  const { plan_status, precheck_summary, has_platform_post, job_status, job_revoke_reason, approval_lapsed, job_force_released, approval_rejected } = input;
  if (has_platform_post || job_status === 'succeeded') return 'published';
  const live = !!job_status && !TERMINAL_JOB_STATUSES.includes(job_status);
  if (live) {   // 有 live job 時先看 job，再看 plan_status
    switch (job_status) {
      case 'submitting': return 'publishing';
      case 'result_pending': return 'confirming';
      case 'outcome_unknown': case 'unreported': return 'unknown';
    }
    if (job_revoke_reason === 'cancelled') return 'cancelling';
    switch (job_status) {
      case 'running': return 'publishing';
      case 'needs_owner': return 'needs_owner';
      case 'ready': return 'ready';
      case 'queued': case 'claimed': return 'scheduled';
    }
    // releasing 而原因不是取消（核准失效、換版）：往下依 plan_status 顯示
  }
  if (plan_status === 'cancelled' || plan_status === 'cancel_requested') return 'cancelled';
  // E37: a post the owner rejected stays rejected until it is changed or explicitly resubmitted (a newer request then exists).
  if ((approval_rejected || plan_status === 'rejected') && !['ready', 'paused', 'awaiting_approval'].includes(plan_status)) return 'rejected';
  if (job_status === 'missed' || approval_lapsed) return 'missed';
  // E17: a force-released job on a post that was not cancelled will never run; it is a missed run the owner can reschedule.
  if (job_status === 'cancelled' && job_force_released) return 'missed';
  if (job_status === 'failed') return 'failed';
  // job 為 cancelled／superseded 但貼文沒有取消（例如核准失效、換版）：依 plan_status 顯示
  if (plan_status === 'ready' || plan_status === 'paused') return 'scheduled';
  if (plan_status === 'awaiting_approval') return 'awaiting_approval';
  return precheck_summary === 'blocked' ? 'blocked' : 'draft';
}

// ---------- Caption helpers ----------
// X weighted length, following twitter-text v3 (config/v3.json and js/src/parseTweet.js, F11): the text is NFC-normalized;
// every URL twitter-text extracts — with https?:// or a bare domain that ends in a known TLD — counts transformedURLLength
// (23); every emoji, including ZWJ, skin-tone, keycap and flag sequences, counts defaultWeight (2); every other code point
// counts 1 in the four light ranges and 2 elsewhere. The TLD lists are twitter-text's validGTLD.js and validCCTLD.js (ASCII).
const X_URL_LENGTH = 23;
const X_GTLDS = 'zuerich|zone|zippo|zip|zero|zara|zappos|yun|youtube|you|yokohama|yoga|yodobashi|yandex|yamaxun|yahoo|yachts|xyz|xxx|xperia|xin|' +
  'xihuan|xfinity|xerox|xbox|wtf|wtc|wow|world|works|work|woodside|wolterskluwer|wme|winners|wine|windows|win|williamhill|wiki|wien|whoswho|weir|' +
  'weibo|wedding|wed|website|weber|webcam|weatherchannel|weather|watches|watch|warman|wanggou|wang|walter|walmart|wales|vuelos|voyage|voto|voting|' +
  'vote|volvo|volkswagen|vodka|vlaanderen|vivo|viva|vistaprint|vista|vision|visa|virgin|vip|vin|villas|viking|vig|video|viajes|vet|versicherung|' +
  'vermögensberatung|vermögensberater|verisign|ventures|vegas|vanguard|vana|vacations|ups|uol|uno|university|unicom|uconnect|ubs|ubank|tvs|tushu|' +
  'tunes|tui|tube|trv|trust|travelersinsurance|travelers|travelchannel|travel|training|trading|trade|toys|toyota|town|tours|total|toshiba|toray|top|' +
  'tools|tokyo|today|tmall|tkmaxx|tjx|tjmaxx|tirol|tires|tips|tiffany|tienda|tickets|tiaa|theatre|theater|thd|teva|tennis|temasek|telefonica|' +
  'telecity|tel|technology|tech|team|tdk|tci|taxi|tax|tattoo|tatar|tatamotors|target|taobao|talk|taipei|tab|systems|symantec|sydney|swiss|' +
  'swiftcover|swatch|suzuki|surgery|surf|support|supply|supplies|sucks|style|study|studio|stream|store|storage|stockholm|stcgroup|stc|statoil|' +
  'statefarm|statebank|starhub|star|staples|stada|srt|srl|spreadbetting|spot|sport|spiegel|space|soy|sony|song|solutions|solar|sohu|software|' +
  'softbank|social|soccer|sncf|smile|smart|sling|skype|sky|skin|ski|site|singles|sina|silk|shriram|showtime|show|shouji|shopping|shop|shoes|' +
  'shiksha|shia|shell|shaw|sharp|shangrila|sfr|sexy|sex|sew|seven|ses|services|sener|select|seek|security|secure|seat|search|scot|scor|scjohnson|' +
  'science|schwarz|schule|school|scholarships|schmidt|schaeffler|scb|sca|sbs|sbi|saxo|save|sas|sarl|sapo|sap|sanofi|sandvikcoromant|sandvik|' +
  'samsung|samsclub|salon|sale|sakura|safety|safe|saarland|ryukyu|rwe|run|ruhr|rugby|rsvp|room|rogers|rodeo|rocks|rocher|rmit|rip|rio|ril|' +
  'rightathome|ricoh|richardli|rich|rexroth|reviews|review|restaurant|rest|republican|report|repair|rentals|rent|ren|reliance|reit|reisen|reise|' +
  'rehab|redumbrella|redstone|red|recipes|realty|realtor|realestate|read|raid|radio|racing|qvc|quest|quebec|qpon|pwc|pub|prudential|pru|' +
  'protection|property|properties|promo|progressive|prof|productions|prod|pro|prime|press|praxi|pramerica|post|porn|politie|poker|pohl|pnc|plus|' +
  'plumbing|playstation|play|place|pizza|pioneer|pink|ping|pin|pid|pictures|pictet|pics|piaget|physio|photos|photography|photo|phone|philips|phd|' +
  'pharmacy|pfizer|pet|pccw|pay|passagens|party|parts|partners|pars|paris|panerai|panasonic|pamperedchef|page|ovh|ott|otsuka|osaka|origins|' +
  'orientexpress|organic|org|orange|oracle|open|ooo|onyourside|online|onl|ong|one|omega|ollo|oldnavy|olayangroup|olayan|okinawa|office|off|' +
  'observer|obi|nyc|ntt|nrw|nra|nowtv|nowruz|now|norton|northwesternmutual|nokia|nissay|nissan|ninja|nikon|nike|nico|nhk|ngo|nfl|nexus|nextdirect|' +
  'next|news|newholland|new|neustar|network|netflix|netbank|net|nec|nba|navy|natura|nationwide|name|nagoya|nadex|nab|mutuelle|mutual|museum|mtr|' +
  'mtpc|mtn|msd|movistar|movie|mov|motorcycles|moto|moscow|mortgage|mormon|mopar|montblanc|monster|money|monash|mom|moi|moe|moda|mobily|mobile|' +
  'mobi|mma|mls|mlb|mitsubishi|mit|mint|mini|mil|microsoft|miami|metlife|merckmsd|meo|menu|men|memorial|meme|melbourne|meet|media|med|mckinsey|' +
  'mcdonalds|mcd|mba|mattel|maserati|marshalls|marriott|markets|marketing|market|map|mango|management|man|makeup|maison|maif|madrid|macys|luxury|' +
  'luxe|lupin|lundbeck|ltda|ltd|lplfinancial|lpl|love|lotto|lotte|london|lol|loft|locus|locker|loans|loan|llp|llc|lixil|living|live|lipsy|link|' +
  'linde|lincoln|limo|limited|lilly|like|lighting|lifestyle|lifeinsurance|life|lidl|liaison|lgbt|lexus|lego|legal|lefrak|leclerc|lease|lds|lawyer|' +
  'law|latrobe|latino|lat|lasalle|lanxess|landrover|land|lancome|lancia|lancaster|lamer|lamborghini|ladbrokes|lacaixa|kyoto|kuokgroup|kred|krd|' +
  'kpn|kpmg|kosher|komatsu|koeln|kiwi|kitchen|kindle|kinder|kim|kia|kfh|kerryproperties|kerrylogistics|kerryhotels|kddi|kaufen|juniper|juegos|' +
  'jprs|jpmorgan|joy|jot|joburg|jobs|jnj|jmp|jll|jlc|jio|jewelry|jetzt|jeep|jcp|jcb|java|jaguar|iwc|iveco|itv|itau|istanbul|ist|ismaili|iselect|' +
  'irish|ipiranga|investments|intuit|international|intel|int|insure|insurance|institute|ink|ing|info|infiniti|industries|inc|immobilien|immo|imdb|' +
  'imamat|ikano|iinet|ifm|ieee|icu|ice|icbc|ibm|hyundai|hyatt|hughes|htc|hsbc|how|house|hotmail|hotels|hoteles|hot|hosting|host|hospital|horse|' +
  'honeywell|honda|homesense|homes|homegoods|homedepot|holiday|holdings|hockey|hkt|hiv|hitachi|hisamitsu|hiphop|hgtv|hermes|here|helsinki|help|' +
  'healthcare|health|hdfcbank|hdfc|hbo|haus|hangout|hamburg|hair|guru|guitars|guide|guge|gucci|guardian|group|grocery|gripe|green|gratis|graphics|' +
  'grainger|gov|got|gop|google|goog|goodyear|goodhands|goo|golf|goldpoint|gold|godaddy|gmx|gmo|gmbh|gmail|globo|global|gle|glass|glade|giving|' +
  'gives|gifts|gift|ggee|george|genting|gent|gea|gdn|gbiz|gay|garden|gap|games|game|gallup|gallo|gallery|gal|fyi|futbol|furniture|fund|fun|' +
  'fujixerox|fujitsu|ftr|frontier|frontdoor|frogans|frl|fresenius|free|fox|foundation|forum|forsale|forex|ford|football|foodnetwork|food|foo|fly|' +
  'flsmidth|flowers|florist|flir|flights|flickr|fitness|fit|fishing|fish|firmdale|firestone|fire|financial|finance|final|film|fido|fidelity|fiat|' +
  'ferrero|ferrari|feedback|fedex|fast|fashion|farmers|farm|fans|fan|family|faith|fairwinds|fail|fage|extraspace|express|exposed|expert|exchange|' +
  'everbank|events|eus|eurovision|etisalat|esurance|estate|esq|erni|ericsson|equipment|epson|epost|enterprises|engineering|engineer|energy|emerck|' +
  'email|education|edu|edeka|eco|eat|earth|dvr|dvag|durban|dupont|duns|dunlop|duck|dubai|dtv|drive|download|dot|doosan|domains|doha|dog|dodge|' +
  'doctor|docs|dnp|diy|dish|discover|discount|directory|direct|digital|diet|diamonds|dhl|dev|design|desi|dentist|dental|democrat|delta|deloitte|' +
  'dell|delivery|degree|deals|dealer|deal|dds|dclk|day|datsun|dating|date|data|dance|dad|dabur|cyou|cymru|cuisinella|csc|cruises|cruise|crs|' +
  'crown|cricket|creditunion|creditcard|credit|cpa|courses|coupons|coupon|country|corsica|coop|cool|cookingchannel|cooking|contractors|contact|' +
  'consulting|construction|condos|comsec|computer|compare|company|community|commbank|comcast|com|cologne|college|coffee|codes|coach|clubmed|club|' +
  'cloud|clothing|clinique|clinic|click|cleaning|claims|cityeats|city|citic|citi|citadel|cisco|circle|cipriani|church|chrysler|chrome|christmas|' +
  'chloe|chintai|cheap|chat|chase|charity|channel|chanel|cfd|cfa|cern|ceo|center|ceb|cbs|cbre|cbn|cba|catholic|catering|cat|casino|cash|caseih|' +
  'case|casa|cartier|cars|careers|career|care|cards|caravan|car|capitalone|capital|capetown|canon|cancerresearch|camp|camera|cam|calvinklein|call|' +
  'cal|cafe|cab|bzh|buzz|buy|business|builders|build|bugatti|budapest|brussels|brother|broker|broadway|bridgestone|bradesco|box|boutique|bot|' +
  'boston|bostik|bosch|boots|booking|book|boo|bond|bom|bofa|boehringer|boats|bnpparibas|bnl|bmw|bms|blue|bloomberg|blog|blockbuster|blanco|' +
  'blackfriday|black|biz|bio|bingo|bing|bike|bid|bible|bharti|bet|bestbuy|best|berlin|bentley|beer|beauty|beats|bcn|bcg|bbva|bbt|bbc|bayern|' +
  'bauhaus|basketball|baseball|bargains|barefoot|barclays|barclaycard|barcelona|bar|bank|band|bananarepublic|banamex|baidu|baby|azure|axa|aws|' +
  'avianca|autos|auto|author|auspost|audio|audible|audi|auction|attorney|athleta|associates|asia|asda|arte|art|arpa|army|archi|aramco|arab|' +
  'aquarelle|apple|app|apartments|aol|anz|anquan|android|analytics|amsterdam|amica|amfam|amex|americanfamily|americanexpress|alstom|alsace|ally|' +
  'allstate|allfinanz|alipay|alibaba|alfaromeo|akdn|airtel|airforce|airbus|aigo|aig|agency|agakhan|africa|afl|afamilycompany|aetna|aero|aeg|adult|' +
  'ads|adac|actor|active|aco|accountants|accountant|accenture|academy|abudhabi|abogado|able|abc|abbvie|abbott|abb|abarth|aarp|aaa|onion';
const X_CCTLDS = 'zw|zm|za|yt|ye|ws|wf|vu|vn|vi|vg|ve|vc|va|uz|uy|us|um|uk|ug|ua|tz|tw|tv|tt|tr|tp|to|tn|tm|tl|tk|tj|th|tg|tf|td|tc|sz|sy|sx|sv|su|' +
  'st|ss|sr|so|sn|sm|sl|sk|sj|si|sh|sg|se|sd|sc|sb|sa|rw|ru|rs|ro|re|qa|py|pw|pt|ps|pr|pn|pm|pl|pk|ph|pg|pf|pe|pa|om|nz|nu|nr|np|no|nl|ni|ng|nf|' +
  'ne|nc|na|mz|my|mx|mw|mv|mu|mt|ms|mr|mq|mp|mo|mn|mm|ml|mk|mh|mg|mf|me|md|mc|ma|ly|lv|lu|lt|ls|lr|lk|li|lc|lb|la|kz|ky|kw|kr|kp|kn|km|ki|kh|kg|' +
  'ke|jp|jo|jm|je|it|is|ir|iq|io|in|im|il|ie|id|hu|ht|hr|hn|hm|hk|gy|gw|gu|gt|gs|gr|gq|gp|gn|gm|gl|gi|gh|gg|gf|ge|gd|gb|ga|fr|fo|fm|fk|fj|fi|eu|' +
  'et|es|er|eh|eg|ee|ec|dz|do|dm|dk|dj|de|cz|cy|cx|cw|cv|cu|cr|co|cn|cm|cl|ck|ci|ch|cg|cf|cd|cc|ca|bz|by|bw|bv|bt|bs|br|bq|bo|bn|bm|bl|bj|bi|bh|' +
  'bg|bf|be|bd|bb|ba|az|ax|aw|au|at|as|ar|aq|ao|an|am|al|ai|ag|af|ae|ad|ac';
const X_LATIN = '\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u024f';
const X_PATH_CHAR = `[a-z0-9\\u0400-\\u04ff${X_LATIN}!*';:=+,.$/%#\\[\\]\\-\\u2013_~&|@]`;
/** Characters a URL path or query may end with (twitter-text validUrlPathEndingChars / validUrlQueryEndingChars). */
const X_URL_END = new RegExp(`[+\\-a-z0-9\\u0400-\\u04ff${X_LATIN}=_#/&]`, 'iu');
let xUrlPattern: RegExp | undefined;
function xUrls(): RegExp {
  if (!xUrlPattern) {
    const tlds = [...X_GTLDS.split('|'), ...X_CCTLDS.split('|')].sort((a, b) => b.length - a.length).join('|');
    const label = `[a-z0-9_${X_LATIN}][a-z0-9_\\-${X_LATIN}]*`;
    xUrlPattern = new RegExp(
      `(?<![a-z0-9@\\uff20$#\\uff03])(https?:\\/\\/)?((?:${label}\\.)+(?:${tlds}|xn--[a-z0-9-]+)(?=[^a-z0-9@+\\-]|$))` +
      `(?::\\d{1,5})?(?:\\/(?:${X_PATH_CHAR}|\\(${X_PATH_CHAR}*\\))*)?(?:\\?[a-z0-9!?*'@();:&=+$/%#\\[\\]\\-_.,~|]*)?`, 'giu');
  }
  return xUrlPattern;
}
/** [start, end) spans (UTF-16 indexes) of the URLs X counts as 23 each. */
function xUrlSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const pattern = xUrls();
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    const before = start > 0 ? text[start - 1] : '';
    // A bare domain right after - _ . or / is part of something else (twitter-text invalidUrlWithoutProtocolPrecedingChars).
    if (!match[1] && /[-_./]/.test(before)) continue;
    const hostEnd = start + (match[1]?.length ?? 0) + match[2].length;
    let end = start + match[0].length;
    // Trailing punctuation is not part of the URL: "makemylure.com/shop." ends before the period; a ')' only closes a '('.
    while (end > hostEnd) {
      const last = text[end - 1];
      const body = text.slice(hostEnd, end);
      if (last === ')' ? body.split('(').length > body.split(')').length - 1 : X_URL_END.test(last)) break;
      end--;
    }
    spans.push([start, end]);
    pattern.lastIndex = end;
  }
  return spans;
}
let xEmojiPattern: RegExp | null | undefined;
function isXEmoji(grapheme: string): boolean {
  if (xEmojiPattern === undefined) {
    try { xEmojiPattern = new RegExp('^\\p{RGI_Emoji}$', 'v'); }
    catch { xEmojiPattern = null; }
  }
  if (xEmojiPattern) return xEmojiPattern.test(grapheme);
  // Runtimes without the `v` flag: a pictographic grapheme, a flag (two regional indicators) or a keycap.
  return /\p{Extended_Pictographic}|^\p{Regional_Indicator}{2}$|^[#*0-9]️?⃣$/u.test(grapheme);
}
const xCodePointWeight = (cp: number) => (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)) ? 1 : 2;
function xTextWeight(text: string): number {
  let total = 0;
  const graphemes = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment) : Array.from(text);
  for (const grapheme of graphemes) {
    if (isXEmoji(grapheme)) { total += 2; continue; }
    for (const char of grapheme) total += xCodePointWeight(char.codePointAt(0)!);
  }
  return total;
}
/** X weighted length (twitter-text v3, F11): NFC; each URL (also a bare domain with a known TLD) 23; each emoji 2; other code points 1 or 2. */
export function xWeightedLength(text: string): number {
  const normalized = text.normalize('NFC');
  let total = 0;
  let at = 0;
  for (const [start, end] of xUrlSpans(normalized)) {
    total += xTextWeight(normalized.slice(at, start)) + X_URL_LENGTH;
    at = end;
  }
  return total + xTextWeight(normalized.slice(at));
}
/** 文字與標籤都可以是空的；兩者都空時回傳空字串。 */
export function renderCaption(text: string, tags: readonly string[] = []): string {
  const present = new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map(match => match[1].toLowerCase()));
  const extra = tags.filter(tag => !present.has(tag.toLowerCase())).map(tag => `#${tag}`);
  return [text.trimEnd(), extra.join(' ')].filter(part => part.length > 0).join(' ');
}

// ---------- Views (§9.7) ----------
export interface Ref { id: string; label: string; web_url: string }
export interface OwnerAction { kind: 'click_post'; machine: { id: string; name: string; remote_url: string | null }; from_local: string; until_local: string }
export interface PostSummary {
  post_id: string; status: PostStatus; scheduled_at: string | null; local_time: string | null; latest_local_time: string | null;
  content_item_id: string; created_at: string; created_by_agent: boolean;
  channel: { id: string; provider: HubProvider; handle: string | null; label: string; web_url: string };
  // paused（附加，U3）：機器已暫停但仍在連線時 online 為 false、paused 為 true，畫面寫「已暫停」而不是「離線」
  machine: { id: string; name: string; online: boolean; paused?: boolean; web_url: string } | null;
  route_kind: RouteKind; mode: EffectiveMode; caption_excerpt: string; media_thumb_url: string | null;
  url: string | null; blocker: { code: BlockerCode | string; message: string; resumable_by: Blocker['resumable_by'] } | null; task_id: string | null;
  approval: 'approved_by_channel_policy' | 'approved' | 'awaiting_owner' | 'not_submitted' | 'rejected';
  approval_deadline: string | null; approval_deadline_local: string | null; owner_action: OwnerAction | null;
  missed_reason: 'not_approved' | 'late' | 'machine_was_off' | 'owner_not_clicked' | 'paused' | 'media_unavailable' | string | null;
  plan_tag: string | null; web_url: string;
}
export interface MachineWarning {
  code: 'sleep_enabled' | 'no_auto_login' | 'app_outdated' | 'clock_skew' | 'driver_outdated' | 'sync_behind';   // vault 無法解鎖時機器無法簽章，中樞只看得到離線（§8.2）
  message: string;
}
export interface MachineSummary {
  machine_id: string; name: string; os: 'darwin' | 'win32'; app_version: string | null; latest_app_version: string | null;
  online: boolean; last_seen_at: string | null;
  paused: boolean; channels: { social_account_id: string; provider: HubProvider; handle: string | null; login: LoginState; web_url: string }[];
  queue: { queued: number; ready: number; running: number; needs_owner: number };
  next_job: { post_id: string | null; at: string; local_time: string; provider: HubProvider } | null;
  drivers: DriverHealth[]; warnings: MachineWarning[]; remote_url: string | null; web_url: string;
}
export interface JobSummary { task_id: string; kind: WorkerJobKind; status: WorkerJobStatus; post_id: string | null; channel_label: string;
  not_before: string; local_time: string; blocker: Blocker | null; url: string | null; dry_run: boolean; web_url: string }
export interface MachineDetail extends MachineSummary {
  clock_offset_ms: number | null; paired_at: string; posture: DevicePosture | null; driver_config_version: string | null;
  upcoming: JobSummary[]; history: JobSummary[];
  last_driver_trace: { provider: DriverProvider; job_id: string; steps: DriverTraceStep[] } | null;
  /** E50: what the owner allowed for remote control on this machine (off by default). */
  remote_control?: RemoteControlSettings;
}
export interface ChannelPause { scope: 'workspace' | 'brand' | 'social_account'; reason: string; by: string | null; at: string; resume_web_url: string }
export interface ChannelSummary {
  channel_id: string; provider: HubProvider; handle: string | null; display_name: string;
  machine: { id: string; name: string; online: boolean; paused?: boolean; web_url: string } | null;
  login: { state: LoginState; checked_at: string | null; evidence_url: string | null };
  execution_mode: ExecutionMode; effective_mode: EffectiveMode; approval_mode: ApprovalMode;
  risk_ack: RiskAck | null; risk_ack_required: boolean; risk_ack_current: boolean;
  daily_cap: number; scheduled_today: number; published_today: number;
  window: PublishWindow | null; timezone: string; lateness_limit_min: number; defaults_ready: boolean; pause: ChannelPause | null;
  readiness: ChannelReadiness;
  next_post: PostSummary | null; can_schedule: boolean; blockers: { code: string; message: string; web_url: string }[]; web_url: string;
}
export interface ChannelDetail extends ChannelSummary {
  settings: ChannelSettingsRecord; posts: PostSummary[]; checks: JobSummary[]; dry_runs: JobSummary[];
  risk_terms: { version: string; zh_hant: string; en: string } | null;
  automation_notice: { version: string; zh_hant: string; en: string; ack: AutomationNoticeAck | null };
}
export interface TimelineEntry { at: string; at_local: string; event: string; actor: 'hub' | 'device' | 'human' | 'agent'; text: string; detail: Record<string, unknown> }
export type PostAction = 'approve' | 'reject' | 'cancel' | 'reschedule' | 'retry' | 'resume' | 'confirm_result' | 'mark_not_published' | 'force_release';
export interface PostDetailView {
  post: PostSummary & { timezone: string; created_by: { type: 'agent' | 'human'; label: string | null } };
  content: { content_item_id: string; revision_id: string; caption: string; platform: string };
  media: { media_id: string; file_id: string | null; kind: 'video' | 'image'; filename: string; bytes: number; sha256: string;
    duration_ms: number | null; width: number | null; height: number | null; status: 'ready' | 'processing' | 'uploading' | 'failed';
    uploaded_bytes: number | null; preview_url: string | null; thumbnail_url: string | null }[];
  approval: { status: PostSummary['approval']; request_id: string | null; decided_at: string | null; decided_by: string | null; resource_hash: string | null; deadline: string | null };
  task: (JobSummary & { attempts: number; timeline: TimelineEntry[]; not_after: string; go_source: 'hub' | 'offline' | null }) | null;
  result: { platform_post_id: string; url: string | null; external_post_id: string | null; published_at: string | null;
    verification: 'system_verified' | 'manual_confirmed'; late_by_sec: number; evidence: { file_id: string; url: string; label: string }[] } | null;
  actions: PostAction[];
  links: { calendar: string; machine: string | null; channel: string };
}
export interface JobDetailView extends JobSummary {
  machine: { id: string; name: string; online: boolean; web_url: string }; channel: { id: string; provider: HubProvider; handle: string | null; web_url: string };
  not_after: string; timeline: TimelineEntry[]; result: WorkerJobRecord['result'];
}
export interface AttentionItem {
  id: string;
  kind: 'job_blocker' | 'approval' | 'click_post' | 'login' | 'machine_offline' | 'machine_setup' | 'missed' | 'unknown'
    | 'driver_outdated' | 'dry_run_fallback' | 'channel_setup';
  severity: 'urgent' | 'normal'; title: string; detail: string; due_at: string | null;
  machine: Ref | null; channel: Ref | null; post: Ref | null;
  actions: { kind: PostAction | 'open' | 'check_login' | 'open_login' | 'open_remote'; label: string; method?: 'POST'; path?: string; body?: Record<string, unknown> }[];
  web_url: string;
}
export interface PostGroup {
  content_item_id: string; caption_excerpt: string; media_thumb_url: string | null; created_at: string; created_by_agent: boolean;
  just_scheduled: boolean;   // 最近 1 小時內由 Agent 建立
  posts: PostSummary[];
}
export interface TodayView {
  generated_at: string; timezone: string; date: string;
  attention: AttentionItem[]; upcoming: PostGroup[];   // 現在起 48 小時內，以內容分組
  recent_published: PostSummary[]; machines: MachineSummary[];
  counts: { scheduled: number; published: number; needs_owner: number; missed: number; unknown: number };
}
export interface OverviewView {
  workspace: { name: string; timezone: string; now_local: string };
  machines: MachineSummary[]; channels: ChannelSummary[];
  today: TodayView['counts']; needs_owner: AttentionItem[]; alerts: { unread: number }; web_url: string;
}
export interface MediaRecentItem { media_id: string; filename: string; kind: 'video' | 'image'; bytes: number; status: 'ready' | 'processing' | 'uploading' | 'failed'; thumbnail_url: string | null; created_at: string }

// ---------- Remote control (core-automation-proposal §2 item 2, steps 4–5; design E50) ----------
/**
 * What the owner allowed on one machine (human-only: hub_machines_remote_control). Off by default. The browser works in
 * the owner's own Chrome (own-Chrome mode, E49) and only on `sites` (host or its subdomains, https); a phone only in
 * `apps` (Android package names).
 */
export interface RemoteControlSettings {
  browser: { enabled: boolean; sites: string[] };
  phone: { enabled: boolean; apps: string[] };
  updated_at: string | null;
}
export const REMOTE_CONTROL_OFF: RemoteControlSettings = { browser: { enabled: false, sites: [] }, phone: { enabled: false, apps: [] }, updated_at: null };
/** What a Worker can do right now, sent with every remote poll. */
export interface RemoteCapabilities { browser: boolean; phones: { serial: string; model: string | null; state: string }[] }
export type RemoteTarget = 'browser' | 'phone';
export interface RemoteCommandEnvelope {
  command_id: string; target: RemoteTarget; serial?: string;
  /** browser: sessions.ts RemoteCommand; phone: { op: 'snapshot' } | { op: 'act', action } (android.ts PhoneAction). */
  command: Record<string, unknown>;
  expires_at: string;
}
export interface RemoteNextRequest { wait_ms: number; capabilities: RemoteCapabilities }
export interface RemoteNextResponse { command: RemoteCommandEnvelope | null; settings: RemoteControlSettings; server_time: string }
export type RemoteResultRequest =
  | { command_id: string; ok: true; result: Record<string, unknown> }
  | { command_id: string; ok: false; error: { code: string; message: string } };
/** Largest result body (a snapshot with its JPEG screenshot). */
export const REMOTE_RESULT_MAX_BYTES = 6 * 1024 * 1024;
