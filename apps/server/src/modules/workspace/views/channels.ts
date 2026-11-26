import {
  AUTOMATION_NOTICE, AUTOMATION_NOTICE_VERSION, DRIVER_PROVIDERS, Problem, RISK_ACK_PROVIDERS, RISK_TERMS, RISK_TERMS_VERSION, riskAckCurrent,
  type ChannelDetail, type ChannelPause, type ChannelReadiness, type ChannelSummary, type Context, type DriverProvider, type HubProvider, type PostSummary, type Row,
} from '@smartsell/contracts';
import { activePause, locate, time } from '../../../../../../packages/domain/src/publishing/index.js';
import { channelLoginState, channelReadiness, channelSettingsOrDefault } from '../../account/channel-settings.js';
import {
  allJobs, channelDevice, effectiveModeOf, hasDriver, hubChannels, isHubProvider, localDay, machineName, machineOnline, str, workspaceZone,
} from './hub-model.js';
import { webUrl } from './links.js';
import { hubTargets, jobSummaryOf, postSummaryOf } from './posts.js';

/** Channel read models (phase1-design §3.3, §9.4): channelSummaries, channelDetail and the readiness blockers. */

const notReady = (): ChannelReadiness => ({ logged_in: false, automation_notice: false, defaults_ready: false, approval_mode_chosen: false,
  risk_ack_or_assist: false, dry_run_passed: false });
export function readinessOf(ctx: Context, accountId: string): ChannelReadiness {
  try { return channelReadiness(ctx, accountId); } catch { return notReady(); }
}

/**
 * The readiness items that stop scheduling (§7.2.3 blockers, §9.4; also Today's channel_setup cards). Codes are the ones the
 * Agent already reads; messages are for the owner (zh-Hant).
 */
export function channelBlockers(ctx: Context, account: Row): ChannelSummary['blockers'] {
  const blockers: ChannelSummary['blockers'] = [];
  const url = webUrl(ctx, 'channel', account.id);
  const readiness = readinessOf(ctx, account.id);
  const device = channelDevice(ctx, account.id);
  const settings = channelSettingsOrDefault(ctx, account.id);
  if (hasDriver(account.provider) && settings.execution_mode !== 'api') {
    if (!readiness.automation_notice) blockers.push({ code: 'automation_notice_missing', message: '這個帳號還沒確認自動化告知，請到帳號頁按「我了解」。', web_url: url });
    if (!device) blockers.push({ code: 'machine_binding_missing', message: '這個帳號還沒綁定機器，請在要發文的那台機器上用 SmartSell Worker 新增這個帳號。', web_url: url });
    else if (device.paused === true) blockers.push({ code: 'machine_paused', message: `${machineName(device)} 已暫停，排到這個帳號的貼文不會發出，直到你恢復機器。`, web_url: webUrl(ctx, 'machine', device.id) });
  }
  if (!readiness.defaults_ready) blockers.push({ code: 'channel_defaults_missing', message: 'TikTok 的預設選項（隱私、留言、合拍與拼接、商業內容揭露）還沒設定，請到帳號頁設定一次。', web_url: url });
  return blockers;
}

export function pauseOf(ctx: Context, account: Row): ChannelPause | null {
  const pause = activePause(ctx, { social_account_id: account.id, brand_id: account.brand_id }) as Row | undefined;
  if (!pause) return null;
  const scope = (['workspace', 'brand', 'social_account'] as const).find(value => value === pause.scope_type) ?? 'workspace';
  // Who paused it: the Operation runner stamps created_via ('agent' for an Agent credential); the page words it.
  const by = pause.created_via === 'agent' ? 'agent' : pause.activated_by || pause.created_via === 'human' ? 'person' : null;
  return { scope, reason: String(pause.reason ?? ''), by, at: String(pause.activated_at ?? pause.created_at),
    resume_web_url: `${webUrl(ctx, 'today').replace(/\/$/, '')}/settings#st-pause` };
}

/** Local-day counts of one channel in its own time zone, through the single status derivation. */
function dayCounts(ctx: Context, account: Row, zone: string, posts: PostSummary[]) {
  const today = localDay(ctx.now, zone);
  let scheduled = 0; let published = 0;
  for (const post of posts) {
    if (!post.scheduled_at || localDay(post.scheduled_at, zone) !== today) continue;
    if (post.status === 'published') published++;
    else if (['scheduled', 'ready', 'awaiting_approval', 'publishing', 'confirming', 'needs_owner'].includes(post.status)) scheduled++;
  }
  void account;
  return { scheduled, published };
}

function postsOf(ctx: Context, accountId: string): PostSummary[] {
  return hubTargets(ctx).filter(target => target.social_account_id === accountId).map(target => postSummaryOf(ctx, target));
}

export function channelSummaryOf(ctx: Context, account: Row): ChannelSummary {
  const settings = channelSettingsOrDefault(ctx, account.id);
  const device = channelDevice(ctx, account.id);
  const login = (() => { try { return channelLoginState(ctx, account.id); } catch { return { state: 'unknown' as const, checked_at: null, session_id: null }; } })();
  const session = login.session_id ? locate(ctx, 'browser_session', login.session_id) : undefined;
  const posts = postsOf(ctx, account.id);
  const counts = dayCounts(ctx, account, settings.timezone, posts);
  const now = time(ctx.now);
  const next = posts.filter(post => post.scheduled_at && time(post.scheduled_at) >= now - 30 * 60_000
    && ['scheduled', 'ready', 'awaiting_approval', 'publishing', 'needs_owner', 'blocked'].includes(post.status))
    .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)))[0] ?? null;
  const blockers = channelBlockers(ctx, account);
  const riskRequired = (RISK_ACK_PROVIDERS as readonly unknown[]).includes(account.provider);
  return {
    channel_id: account.id, provider: account.provider as HubProvider, handle: str(account.handle) ?? null,
    display_name: String(account.display_name ?? account.handle ?? account.external_account_id ?? ''),
    machine: device ? { id: device.id, name: machineName(device), online: machineOnline(ctx, device), ...(device.paused === true && { paused: true }),
      web_url: webUrl(ctx, 'machine', device.id) } : null,
    login: { state: login.state, checked_at: login.checked_at,
      evidence_url: str(session?.evidence_file_id) ? `/files/${encodeURIComponent(String(session!.evidence_file_id))}/download?inline=true` : null },
    execution_mode: settings.execution_mode, effective_mode: effectiveModeOf(ctx, account), approval_mode: settings.approval_mode,
    risk_ack: settings.risk_ack, risk_ack_required: riskRequired, risk_ack_current: riskAckCurrent(settings.risk_ack),
    daily_cap: settings.daily_cap, scheduled_today: counts.scheduled, published_today: counts.published,
    window: settings.window, timezone: settings.timezone, lateness_limit_min: settings.lateness_limit_min,
    defaults_ready: readinessOf(ctx, account.id).defaults_ready, pause: pauseOf(ctx, account), readiness: readinessOf(ctx, account.id),
    next_post: next, can_schedule: blockers.length === 0, blockers, web_url: webUrl(ctx, 'channel', account.id),
  };
}

/** C7 channelSummaries(ctx, filter): hub channels (X, TikTok, …), optionally by provider or machine. */
export function channelSummaries(ctx: Context, filter: { provider?: string; machine_id?: string } = {}): ChannelSummary[] {
  return hubChannels(ctx).filter(account => (!filter.provider || account.provider === filter.provider)
    && (!filter.machine_id || channelDevice(ctx, account.id)?.id === filter.machine_id)).map(account => channelSummaryOf(ctx, account));
}

/** C7 channelDetail(ctx, id): §9.4 channel page. */
export function channelDetail(ctx: Context, id: string): ChannelDetail {
  const account = locate(ctx, 'social_account', id);
  if (!account || !isHubProvider(account.provider)) throw new Problem(404, 'CHANNEL_NOT_FOUND', `Unknown channel_id ${id}. Call channels_list.`);
  const summary = channelSummaryOf(ctx, account);
  const settings = channelSettingsOrDefault(ctx, account.id);
  const now = time(ctx.now);
  const posts = postsOf(ctx, account.id).filter(post => !post.scheduled_at || time(post.scheduled_at) >= now - 14 * 86_400_000)
    .sort((a, b) => String(b.scheduled_at ?? b.created_at).localeCompare(String(a.scheduled_at ?? a.created_at))).slice(0, 40);
  const jobs = allJobs(ctx).filter(job => job.social_account_id === account.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const provider = (DRIVER_PROVIDERS as readonly string[]).includes(account.provider) ? account.provider as DriverProvider : null;
  return {
    ...summary, settings, posts,
    checks: jobs.filter(job => job.kind === 'check_login').slice(0, 10).map(job => jobSummaryOf(ctx, job)),
    dry_runs: jobs.filter(job => job.dry_run === true).slice(0, 10).map(job => jobSummaryOf(ctx, job)),
    risk_terms: provider ? { version: RISK_TERMS_VERSION, ...RISK_TERMS[provider] } : null,
    automation_notice: { version: AUTOMATION_NOTICE_VERSION, ...AUTOMATION_NOTICE, ack: settings.automation_notice_ack },
  };
}


