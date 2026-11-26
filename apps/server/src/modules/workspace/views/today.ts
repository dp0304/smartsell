import {
  OWNER_RESUME_BLOCKERS,
  type AttentionItem, type Context, type OverviewView, type PostGroup, type PostSummary, type Ref, type Row, type TodayView,
} from '@smartsell/contracts';
import { locate, object, time } from '../../../../../../packages/domain/src/publishing/index.js';
import { channelSettingsOrDefault } from '../../account/channel-settings.js';
import { workspace } from '../brands.js';
import { blockerShort, missedText } from './timeline.js';
import { channelBlockers, channelSummaries, readinessOf } from './channels.js';
import {
  allJobs, channelDevice, channelLabelOf, hubChannels, invalidQuery, latestJob, localDay, localText, machineConnected, machineName, platformPostFor, str,
  strictQuery, validZone, workspaceZone,
} from './hub-model.js';
import { webUrl } from './links.js';
import { machineSummaries, offlineWithJobs, pausedMachines, type MachineWarningWithParams } from './machines.js';
import { HOLDABLE_STATUSES, approvalOf, hubTargets, pauseCovers, pauseView, postSummaryOf, type HubPostSummary } from './posts.js';

/** Today and overview read models (phase1-design §9.2, §7.2.1): buildToday, buildOverview and the attention cards. */

const HOUR = 3_600_000;
const LOGIN_BLOCKERS = ['captcha', 'two_factor', 'login_expired', 'identity_mismatch'];
const PROVIDER_ORDER = ['x', 'tiktok', 'youtube', 'meta_instagram', 'meta_facebook'];
export type TodayPostGroup = PostGroup & {
  /** Additive: what the group is, for 「video.mp4 → X + TikTok」 — the content title, else the media file name. */
  title: string; media_filename: string | null;
};
export type TodayViewWithGroups = Omit<TodayView, 'upcoming' | 'attention'> & { upcoming: TodayPostGroup[]; attention: HubAttentionItem[] };
/** Additive (E35): one item per active publishing pause, so a pause set by the Agent is never invisible on Today. */
export type HubAttentionKind = AttentionItem['kind'] | 'publishing_paused';
/**
 * Additive (E30): whether this item stops scheduling. Only a channel's blockers do (the same list as channels[].blockers,
 * can_schedule false); setup reminders, logins, approvals, pauses (E35: posts scheduled meanwhile are submitted on release)
 * and machine cards never stop scheduling.
 */
export type HubAttentionItem = Omit<AttentionItem, 'kind'> & { kind: HubAttentionKind; blocks_scheduling: boolean } & CardText;
/**
 * U1 (additive): which sentence the card's title and detail are, and the values in them, so the web can write the card in the
 * owner's language. `title` and `detail` stay the zh-Hant text for the Agent (MCP) and older clients. The codes and params are
 * listed in apps/web/src/view/attention-text.ts.
 */
export type CardParams = Record<string, string | number | boolean | null | string[] | Record<string, unknown> | Record<string, unknown>[]>;
export interface CardText { code?: string; params?: CardParams }
const text = (code: string, params: CardParams): Required<CardText> => ({ code, params });
type PostEntry = { target: Row; post: HubPostSummary };
export type OverviewViewWithFlags = Omit<OverviewView, 'needs_owner'> & { needs_owner: HubAttentionItem[] };

const ref = (id: string, label: string, web_url: string): Ref => ({ id, label, web_url });
const postRef = (post: PostSummary): Ref => ref(post.post_id, `${post.channel.label}${post.local_time ? ` · ${post.local_time.slice(5)}` : ''}`, post.web_url);
const channelRef = (post: PostSummary): Ref => ref(post.channel.id, post.channel.label, post.channel.web_url);
const machineRef = (post: PostSummary): Ref | null => post.machine ? ref(post.machine.id, post.machine.name, post.machine.web_url) : null;
const hm = (local: string | null) => local?.slice(11) ?? '';
/** The values the blocker sentence (Appendix C.2) was made of, for the web to write it in another language (U1). */
function blockerParams(ctx: Context, job: Row | undefined, post: PostSummary, zone: string): Record<string, unknown> {
  const blocker = object(job?.blocker);
  return { code: post.blocker?.code ?? null, machine: str(blocker.machine_name) ?? post.machine?.name ?? null, channel: str(blocker.channel_label) ?? post.channel.label,
    deadline: hm(localText(job?.not_after, zone)) || null, step: str(blocker.step) ?? null, platform_message: str(blocker.platform_message) ?? null,
    resumable_by: post.blocker?.resumable_by ?? null };
}
/** E21 「重新登入」: first on every login card; the web renders it as its one 「重新登入」 button (a person's action only, E32). */
const openLogin = (channelId: string): AttentionItem['actions'][number] =>
  ({ kind: 'open_login', label: '重新登入', method: 'POST', path: `/hub/channels/${channelId}/check`, body: { open_login_window: true } });
const checkLogin = (channelId: string): AttentionItem['actions'][number] =>
  ({ kind: 'check_login', label: '檢查登入', method: 'POST', path: `/hub/channels/${channelId}/check`, body: {} });

function mediaFilename(ctx: Context, target: Row): string | null {
  const revision = locate(ctx, 'content_revision', target.variant_revision_id);
  const first = Array.isArray(revision?.media) ? object((revision!.media as unknown[])[0]) : {};
  const version = locate(ctx, 'asset_version', first.asset_version_id);
  const file = locate(ctx, 'file_object', version?.file_object_id);
  const asset = locate(ctx, 'asset', version?.asset_id ?? first.asset_id);
  return str(file?.original_filename) ?? str(asset?.title) ?? null;
}

/** One attention card per post that waits for the owner (§9.2 card kinds). */
function postCard(ctx: Context, target: Row, post: HubPostSummary, zone: string): CardDraft | undefined {
  const job = latestJob(ctx, target);
  const base = { machine: machineRef(post), channel: channelRef(post), post: postRef(post), web_url: post.web_url };
  const open = { kind: 'open' as const, label: '開啟貼文' };
  const reschedule = { kind: 'reschedule' as const, label: '改到…' };
  const when = post.local_time ? `${post.local_time.slice(5)}` : '';
  const id = `post:${post.post_id}`;
  const now = time(ctx.now);
  switch (post.status) {
    case 'awaiting_approval': {
      const { request } = approvalOf(ctx, target);
      const deadline = post.approval_deadline_local?.slice(5);
      // WV-2 (E34): 核准／駁回 only while the request is pending and before its due_at (the hub refuses the others). Past it, the
      // card says so and offers 改到…, which submits the post again.
      if (!(request?.status === 'pending' && time(request.due_at) > now)) {
        return { id, kind: 'approval', severity: 'urgent', ...text('approval_expired', { channel: post.channel.label, when, deadline: deadline ?? null }),
          title: `${post.channel.label} ${when} 的貼文核准期限已過`,
          detail: deadline ? `核准期限（${deadline}）已過，這則目前不會發出；改期即可重新送審。` : '這則目前沒有可以核准的請求，不會發出；改期即可重新送審。',
          due_at: post.approval_deadline, ...base, actions: [reschedule, open] };
      }
      return { id, kind: 'approval', severity: post.approval_deadline && time(post.approval_deadline) - now < HOUR ? 'urgent' : 'normal',
        ...text('approval_waiting', { channel: post.channel.label, when, deadline: deadline ?? null }),
        title: `${post.channel.label} ${when} 的貼文等你核准`, detail: deadline ? `請在 ${deadline} 前核准，之後這則不會發出。` : '核准後才會發出。',
        due_at: post.approval_deadline, ...base,
        actions: [{ kind: 'approve', label: '核准' }, { kind: 'reject', label: '駁回' }, open] };
    }
    case 'needs_owner': {
      const blocker = post.blocker;
      const code = String(blocker?.code ?? '');
      if (code === 'owner_click_required' && post.owner_action) {
        const action = post.owner_action;
        return { id, kind: 'click_post', severity: 'urgent',
          ...text('click_post', { from: hm(action.from_local), until: hm(action.until_local), machine: action.machine.name, channel: post.channel.label,
            blocker: blocker ? blockerParams(ctx, job, post, zone) : null }),
          title: `${hm(action.from_local)}–${hm(action.until_local)} 要你在 ${action.machine.name} 按「發布」`,
          detail: blocker?.message ?? `${post.channel.label} 已準備好，等你在 ${action.machine.name} 按「發布」。`, due_at: job?.not_after ?? null, ...base,
          actions: [...(action.machine.remote_url ? [{ kind: 'open_remote' as const, label: '開啟遠端畫面', path: action.machine.remote_url }] : []), open] };
      }
      if (code === 'login_expired' || code === 'identity_mismatch') {
        const machine = post.machine?.name ?? '那台機器';
        return { id, kind: 'login', severity: 'urgent',
          ...text('post_login', { channel: post.channel.label, machine: post.machine?.name ?? null, blocker: blockerParams(ctx, job, post, zone) }),
          title: `${post.channel.label} 要重新登入（${post.machine?.name ?? '機器'}）`,
          detail: `${blocker?.message ?? ''} 按「重新登入」，${machine} 會開啟這個帳號的 SmartSell Chrome 登入視窗，請到 ${machine} 登入；登入後這裡會自動更新。`.trim(),
          due_at: job?.not_after ?? null, ...base,
          actions: [openLogin(post.channel.id), checkLogin(post.channel.id), open] };
      }
      // WV-9: 恢復 only before the job's deadline, as on the post page (the hub answers RESUME_NOT_ALLOWED after it).
      const resumable = OWNER_RESUME_BLOCKERS.includes(code as never) && time(job?.not_after) > now;
      return { id, kind: code === 'driver_outdated' ? 'driver_outdated' : 'job_blocker', severity: 'urgent',
        ...text('job_blocker', { channel: post.channel.label, when, blocker: blockerParams(ctx, job, post, zone) }),
        title: `${post.channel.label}${when ? ` ${when}` : ''}：${blockerShort(code) || '需要你處理'}`,
        detail: `${blocker?.message ?? ''}${blocker?.resumable_by === 'auto' && !blocker.message.includes('自動繼續') ? ' 處理好後會自動繼續。' : ''}`.trim(), due_at: job?.not_after ?? null, ...base,
        actions: [...(resumable && job ? [{ kind: 'resume' as const, label: '恢復', method: 'POST' as const, path: `/hub/jobs/${job.id}/resume`, body: {} }] : []), open] };
    }
    case 'missed': {
      if (post.scheduled_at && time(post.scheduled_at) < now - 7 * 24 * HOUR) return undefined;
      const machine = post.machine?.name ?? '機器';
      if (post.missed_reason === 'released_unconfirmed') {
        // E36: a release of a job the hub saw start (written before E36). It may be live: check first, never one-click repost.
        return { id, kind: 'missed', severity: 'urgent', ...text('missed_released_unconfirmed', { channel: post.channel.label, when, machine }),
          title: `${post.channel.label} ${when} 的貼文可能已經發出`,
          detail: `你強制釋放了這則，但 ${machine} 當時可能已經發出。請先到平台確認，再決定要不要改期。`, due_at: null, ...base, actions: [open] };
      }
      const reason = post.missed_reason === 'not_approved' ? '沒有在期限內核准，所以沒有發出。'
        : post.missed_reason === 'machine_retired' ? `${machine} 已撤銷，帳號還沒換到別台機器，所以沒有發出。請先在帳號頁「換機器」，再改到別的時間。`
          : `${machine} 沒有發出（${missedText(post.missed_reason)}）。`;
      return { id, kind: 'missed', severity: 'urgent', ...text('missed', { channel: post.channel.label, when, machine, reason: post.missed_reason ?? null }),
        title: `${post.channel.label} ${when} 的貼文沒有發出`,
        detail: post.missed_reason === 'machine_retired' ? reason : `${reason}要改到別的時間嗎？`, due_at: null, ...base, actions: [reschedule, open] };
    }
    case 'unknown': {
      const machine = post.machine?.name ?? '機器';
      // WV-5: 「上線後會自動補報」 only while the machine is offline; an online machine that did not report will not report by itself.
      const variant = job?.status !== 'unreported' ? 'clicked' : post.machine && !post.machine.online ? 'offline' : 'unreported';
      const detail = variant === 'clicked' ? `${machine} 已按「發布」，但讀不到貼文網址。請貼上網址或確認沒有發出；系統不會自動重發。`
        : variant === 'offline' ? `${machine} 未回報（目前離線），上線後會自動補報。`
          : `${machine} 沒有回報這則的結果。請到平台確認：有就貼上網址，沒有就按「確認沒發出」；系統不會自動重發。`;
      return { id, kind: 'unknown', severity: 'urgent', ...text('unknown', { channel: post.channel.label, when, machine, variant }),
        title: `${post.channel.label} ${when} 的結果不明`, detail,
        due_at: null, ...base, actions: [{ kind: 'confirm_result', label: '貼上網址' }, { kind: 'mark_not_published', label: '確認沒發出' }, open] };
    }
    case 'blocked': {
      const items = ctx.list('precheck_item').filter(item => item.run_id === target.last_precheck_run_id && item.severity === 'blocker' && item.result !== 'pass');
      // Held only by its paused machine: the machine's 「已暫停」 card counts it and resumes it (U3).
      if (items.length && items.every(item => item.check_key === 'machine_paused') && post.pause?.scope === 'machine') return undefined;
      return { id, kind: 'job_blocker', severity: 'normal',
        ...text('precheck_blocked', { channel: post.channel.label, when, checks: items.map(item => String(item.check_key ?? '')).filter(Boolean).slice(0, 3) }),
        title: `${post.channel.label} ${when} 的貼文被預檢擋下`,
        detail: items.map(item => String(item.message ?? item.check_key)).filter(Boolean).slice(0, 3).join('；') || '請打開貼文查看要處理的項目。', due_at: post.scheduled_at, ...base,
        actions: [open] };
    }
    default: return undefined;
  }
}

/**
 * The channel's setup items that do not stop scheduling (E30), each worded with what it really changes. Only a missing dry run
 * changes nothing about scheduling or publishing; the others say how the next post goes out until the owner acts.
 */
function setupReminder(ctx: Context, account: Row, label: string, machine: string,
  open: { login: boolean; approval: boolean; risk: boolean; dryRun: boolean }): { title: string; detail: string; login: boolean; codes: string[] } | undefined {
  const lines: string[] = [];
  const codes = [...open.login ? ['login'] : [], ...open.approval ? [channelSettingsOrDefault(ctx, account.id).approval_mode === 'direct' ? 'approval_direct' : 'approval_none'] : [],
    ...open.risk ? ['risk'] : [], ...open.dryRun ? ['dry_run'] : []];
  if (open.login) lines.push(`還沒確認登入：按「檢查登入」確認。發文時 ${machine} 會先檢查登入，沒有登入的話那則貼文會停下來等你登入`);
  if (open.approval) {
    lines.push(channelSettingsOrDefault(ctx, account.id).approval_mode === 'direct'
      ? '還沒確認核准方式：目前是「直接發布」，排好的貼文不用你核准就會發出'
      : '還沒選擇核准方式：在你選擇之前，每則貼文都要你核准後才會發出');
  }
  if (open.risk) lines.push(`還沒確認代按發布的風險：在你確認之前，到發文時間要你在 ${machine} 自己按「發布」`);
  if (open.dryRun && lines.length === 0) {
    return { title: `建議：${label} 試跑一次`, login: false, codes,
      detail: `試跑會在 ${machine} 走一遍發文流程，在按「發布」之前停下，確認這台機器能替這個帳號發文。不影響排程與發布。` };
  }
  if (open.dryRun) lines.push(`還沒試跑：建議試跑一次，確認 ${machine} 能替這個帳號發文（不影響排程與發布）`);
  if (!lines.length) return undefined;
  return { title: `${label} 的設定提醒（${lines.length} 項，不影響排程）`, detail: `${lines.join('；')}。`, login: open.login, codes };
}

type CardDraft = Omit<AttentionItem, 'kind'> & { kind: HubAttentionKind; blocks_scheduling?: boolean } & CardText;

const SCOPE_LABEL: Record<string, string> = { workspace: '全部發布', brand: '品牌', campaign: '活動', social_account: '帳號' };
/**
 * E35: one item per active publishing pause (pause_switch) that covers a hub channel or holds a post: who paused it, why, how
 * many posts it holds and where to resume. Urgent while a held post is due within 48 hours. A paused machine has its own
 * card (pausedMachineItems).
 */
function pauseItems(ctx: Context, entries: PostEntry[], zone: string): CardDraft[] {
  const now = time(ctx.now);
  const channels = hubChannels(ctx);
  const items: CardDraft[] = [];
  for (const row of ctx.list('pause_switch').filter(item => !item.released_at)) {
    const covered = channels.filter(account => pauseCovers(ctx, row, { social_account_id: account.id, brand_id: account.brand_id }, account));
    const held = entries.filter(({ target, post }) => HOLDABLE_STATUSES.includes(post.status)
      && pauseCovers(ctx, row, target, ctx.list('social_account').find(account => account.id === target.social_account_id)))
      .sort((a, b) => String(a.post.scheduled_at ?? '').localeCompare(String(b.post.scheduled_at ?? '')));
    if (!covered.length && !held.length) continue;
    const view = pauseView(ctx, row);
    const brand = row.scope_type === 'brand' ? ctx.list('brand').find(item => item.id === row.scope_id) : undefined;
    // 'X @lurelab 已暫停' (a Latin label keeps its space), 「全部發布已暫停」, 「品牌「Lure Lab」已暫停」.
    const scope = row.scope_type === 'social_account' && covered[0] ? `${channelLabelOf(covered[0])} `
      : brand ? `品牌「${str(brand.name) ?? row.scope_id}」` : SCOPE_LABEL[String(row.scope_type)] ?? String(row.scope_type);
    const by = view.by === 'agent' ? 'Agent ' : view.by === 'person' ? '你' : '';
    const first = held.find(entry => entry.post.scheduled_at)?.post;
    const soon = held.some(({ post }) => post.scheduled_at && time(post.scheduled_at) <= now + 48 * HOUR);
    const firstText = first?.scheduled_at ? `最早一則是 ${localText(first.scheduled_at, zone)?.slice(5)}。` : '';
    items.push({ id: `pause:${row.id}`, kind: 'publishing_paused', blocks_scheduling: false, severity: soon ? 'urgent' : 'normal',
      ...text('publishing_paused', { scope: String(row.scope_type), scope_name: row.scope_type === 'social_account' && covered[0] ? channelLabelOf(covered[0]) : brand ? str(brand.name) ?? String(row.scope_id) : null,
        n: held.length, by: view.by ?? null, at: localText(view.at, zone)?.slice(5) ?? null, reason: view.reason || null,
        first: first?.scheduled_at ? localText(first.scheduled_at, zone)?.slice(5) ?? null : null }),
      title: held.length ? `${scope}已暫停：${held.length} 則貼文恢復前不會發出` : `${scope}已暫停：恢復前不會發出貼文`,
      detail: `${by}在 ${localText(view.at, zone)?.slice(5) ?? ''} 暫停${view.reason ? `（${view.reason}）` : ''}。${firstText}`
        + '恢復後，暫停期間排好的貼文會重新送出；已超過遲到上限的會顯示「沒有發出」，可以改期。',
      due_at: first?.scheduled_at ?? null, machine: null,
      channel: covered.length === 1 ? ref(covered[0].id, channelLabelOf(covered[0]), webUrl(ctx, 'channel', covered[0].id)) : null,
      post: null, web_url: view.resume_web_url, actions: [{ kind: 'open', label: '到設定頁恢復' }] });
  }
  return items;
}

/**
 * U3: one item per paused machine (connector_device.paused): who paused it, why, how many posts it holds and a 「恢復機器」
 * button. A paused machine is neither 「離線」 nor a channel that 「還不能排程」; this card replaces both.
 */
function pausedMachineItems(ctx: Context, entries: PostEntry[], zone: string): CardDraft[] {
  const now = time(ctx.now);
  return pausedMachines(ctx).map(({ device }) => {
    const machine = ref(device.id, machineName(device), webUrl(ctx, 'machine', device.id));
    const held = entries.filter(({ post }) => post.pause?.scope === 'machine' && post.machine?.id === device.id)
      .sort((a, b) => String(a.post.scheduled_at ?? '').localeCompare(String(b.post.scheduled_at ?? '')));
    const first = held.find(entry => entry.post.scheduled_at)?.post;
    const soon = held.some(({ post }) => post.scheduled_at && time(post.scheduled_at) <= now + 48 * HOUR);
    const reason = str(device.paused_reason);
    const by = String(device.paused_by ?? '').startsWith('agent') ? 'Agent ' : device.paused_by ? '你' : '';
    const at = localText(device.paused_at, zone)?.slice(5);
    const firstText = first?.scheduled_at ? `最早一則是 ${localText(first.scheduled_at, zone)?.slice(5)}。` : '';
    const offline = machineConnected(ctx, device) ? '' : `${machine.label} 目前也沒有連線，恢復後要等它上線才會發文。`;
    return { id: `machine_paused:${device.id}`, kind: 'publishing_paused' as const, blocks_scheduling: false, severity: soon ? 'urgent' as const : 'normal' as const,
      ...text('machine_paused', { machine: machine.label, reason: reason ?? null, n: held.length, by: by === 'Agent ' ? 'agent' : by ? 'person' : null, at: at ?? null,
        first: first?.scheduled_at ? localText(first.scheduled_at, zone)?.slice(5) ?? null : null, offline: !machineConnected(ctx, device) }),
      title: `${machine.label} 已暫停${reason ? `（${reason}）` : ''}${held.length ? `：${held.length} 則貼文恢復前不會發出` : ''}`,
      detail: `${at ? `${by}在 ${at} 暫停。` : ''}${held.length ? firstText : '這台機器上的帳號在恢復前都不會發文。'}`
        + `恢復後，暫停期間排好的貼文會照常送出；已超過遲到上限的會顯示「沒有發出」，可以改期。${offline}`,
      due_at: first?.scheduled_at ?? null, machine, channel: null, post: null, web_url: machine.web_url,
      actions: [{ kind: 'resume' as const, label: '恢復機器', method: 'POST' as const, path: `/hub/machines/${device.id}/resume`, body: {} },
        { kind: 'open' as const, label: '開啟機器' }] };
  });
}

/** §9.2 「要你處理」: posts, pauses, channels and machines, urgent first, then by deadline. Card times are in `zone`. */
export function attentionItems(ctx: Context, posts?: PostEntry[], zone = workspaceZone(ctx)): HubAttentionItem[] {
  const entries = posts ?? hubTargets(ctx).map(target => ({ target, post: postSummaryOf(ctx, target, zone) }));
  const items: CardDraft[] = [...pauseItems(ctx, entries, zone), ...pausedMachineItems(ctx, entries, zone)];
  const loginCards = new Set<string>();
  for (const { target, post } of entries) {
    const card = postCard(ctx, target, post, zone);
    if (!card) continue;
    // A post already stopped on a sign-in problem (captcha, 2FA, expired, wrong account) covers the channel's login state.
    if (card.kind === 'login' || LOGIN_BLOCKERS.includes(String(post.blocker?.code))) loginCards.add(post.channel.id);
    items.push(card);
  }
  const upcoming = new Map<string, number>();
  const now = time(ctx.now);
  for (const { post } of entries) {
    if (post.scheduled_at && time(post.scheduled_at) >= now && time(post.scheduled_at) <= now + 48 * HOUR && !['cancelled', 'published'].includes(post.status)) {
      upcoming.set(post.channel.id, (upcoming.get(post.channel.id) ?? 0) + 1);
    }
  }
  for (const account of hubChannels(ctx)) {
    const device = channelDevice(ctx, account.id);
    const label = channelLabelOf(account);
    const channel = ref(account.id, label, webUrl(ctx, 'channel', account.id));
    const machine = device ? ref(device.id, machineName(device), webUrl(ctx, 'machine', device.id)) : null;
    const session = ctx.list('browser_session').find(row => row.social_account_id === account.id && row.device_id === device?.id && row.status !== 'revoked');
    const status = String(session?.status);
    if (!loginCards.has(account.id) && ['login_required', 'identity_mismatch', 'challenge'].includes(status)) {
      const where = machine?.label ?? '那台機器';
      const [title, detail] = status === 'challenge'
        ? [`${label} 要完成驗證${machine ? `（${machine.label}）` : ''}`, `${where} 上的 ${label} 出現驗證，請到 ${where} 的 SmartSell Chrome 視窗完成，再按「檢查登入」；視窗沒有開著的話，按「重新登入」會在 ${where} 開啟它。`]
        : status === 'identity_mismatch'
          ? [`${label} 登入的不是這個帳號${machine ? `（${machine.label}）` : ''}`, `${where} 的 Chrome 登入的不是 ${label}。按「重新登入」，${where} 會開啟這個帳號的 SmartSell Chrome 登入視窗，請到 ${where} 切回 ${label}；切回後這裡會自動更新。`]
          : [`${label} 要重新登入${machine ? `（${machine.label}）` : ''}`, `${where} 上的 ${label} 登入已失效，排到這個帳號的貼文發不出去。按「重新登入」，${where} 會開啟這個帳號的 SmartSell Chrome 登入視窗，請到 ${where} 登入。`];
      loginCards.add(account.id);
      items.push({ id: `login:${account.id}`, kind: 'login', severity: upcoming.get(account.id) ? 'urgent' : 'normal', title,
        ...text('channel_login', { channel: label, machine: machine?.label ?? null, status }),
        detail,
        due_at: null, machine, channel, post: null, web_url: channel.web_url,
        actions: [openLogin(account.id), checkLogin(account.id), { kind: 'open', label: '開啟帳號' }] });
    }
    // S8-RM item 3, E30: what stops scheduling (the channel's blockers, can_schedule false) and setup reminders are separate
    // cards, so neither the owner nor the model reads a reminder such as 「還沒試跑」 as a threat to the next post.
    const readiness = readinessOf(ctx, account.id);
    // A paused machine has its own card (U3); the channel is not 「還沒設定完成」 because of it.
    const blockers = channelBlockers(ctx, account).filter(blocker => blocker.code !== 'machine_paused');
    if (blockers.length) {
      items.push({ id: `channel:${account.id}`, kind: 'channel_setup', blocks_scheduling: true, severity: upcoming.get(account.id) ? 'urgent' : 'normal',
        ...text('channel_blockers', { channel: label, machine: machine?.label ?? null, blockers: blockers.map(blocker => blocker.code) }),
        title: `${label} 還沒設定完成，還不能排程（${blockers.length} 項）`, detail: blockers.map(blocker => blocker.message).join('；'), due_at: null,
        machine, channel, post: null, web_url: channel.web_url, actions: [{ kind: 'open', label: '開啟帳號設定' }] });
    }
    const reminder = setupReminder(ctx, account, label, machine?.label ?? '那台機器', {
      login: !readiness.logged_in && !loginCards.has(account.id) && !blockers.some(blocker => blocker.code === 'machine_binding_missing'),
      approval: !readiness.approval_mode_chosen, risk: !readiness.risk_ack_or_assist, dryRun: !readiness.dry_run_passed,
    });
    if (reminder) {
      items.push({ id: `channel:${account.id}:reminder`, kind: 'channel_setup', blocks_scheduling: false, severity: 'normal', title: reminder.title,
        ...text('channel_reminder', { channel: label, machine: machine?.label ?? null, lines: reminder.codes }),
        detail: reminder.detail, due_at: null, machine, channel, post: null, web_url: channel.web_url,
        actions: [...(reminder.login ? [checkLogin(account.id)] : []), { kind: 'open', label: '開啟帳號設定' }] });
    }
    const dry = allJobs(ctx).filter(job => job.social_account_id === account.id && job.dry_run && job.status === 'succeeded')
      .sort((a, b) => String(b.finished_at ?? b.updated_at).localeCompare(String(a.finished_at ?? a.updated_at)))[0] as Row | undefined;
    const fallback = Array.isArray(dry?.driver_trace) && (dry!.driver_trace as unknown[]).map(object).some(step => step.matched === 'fallback');
    if (fallback) {
      items.push({ id: `dry_run:${account.id}`, kind: 'dry_run_fallback', severity: 'normal', ...text('dry_run_fallback', { channel: label }),
        title: `${label} 試跑時用了備用選擇器`,
        detail: '平台頁面可能改版。請在中樞執行 pnpm hub:update 更新選擇器，再試跑一次。', due_at: null, machine, channel, post: null, web_url: channel.web_url,
        actions: [{ kind: 'open', label: '開啟帳號' }] });
    }
  }
  for (const { device, waiting } of offlineWithJobs(ctx)) {
    const first = waiting[0];
    const machine = ref(device.id, machineName(device), webUrl(ctx, 'machine', device.id));
    items.push({ id: `offline:${device.id}`, kind: 'machine_offline', severity: time(first.not_before) - now < 2 * HOUR ? 'urgent' : 'normal',
      ...text('machine_offline', { machine: machine.label, n: waiting.length, first: localText(first.not_before, zone)?.slice(5) ?? null }),
      title: `${machine.label} 離線，${waiting.length} 則貼文等待中，最早 ${localText(first.not_before, zone)?.slice(5) ?? ''}`,
      detail: `請確認 ${machine.label} 已開機、已連上 Tailscale，SmartSell Worker 正在執行。`, due_at: String(first.not_before), machine, channel: null, post: null,
      web_url: machine.web_url, actions: [{ kind: 'open', label: '開啟機器' }] });
  }
  for (const machine of machineSummaries(ctx, { zone })) {
    if (!machine.warnings.length) continue;
    items.push({ id: `setup:${machine.machine_id}`, kind: 'machine_setup', severity: 'normal',
      ...text('machine_setup', { machine: machine.name, os: machine.os, warnings: machine.warnings.map(warning => ({ code: warning.code, ...(warning as MachineWarningWithParams).params })) }),
      title: `${machine.name} 的設定需要注意（${machine.warnings.length} 項）`,
      detail: machine.warnings.map(warning => warning.message).join(' '), due_at: null, machine: ref(machine.machine_id, machine.name, machine.web_url),
      channel: null, post: null, web_url: machine.web_url, actions: [{ kind: 'open', label: '開啟機器' }] });
  }
  return items.sort((a, b) => (a.severity === 'urgent' ? 0 : 1) - (b.severity === 'urgent' ? 0 : 1)
    || (a.due_at ?? '￿').localeCompare(b.due_at ?? '￿') || a.id.localeCompare(b.id))
    .map(item => ({ ...item, blocks_scheduling: item.blocks_scheduling === true }));
}

/** Today's counts. A post a pause holds (E35) is not counted as scheduled; a rejected one (E37) is not counted at all. */
function counts(ctx: Context, posts: HubPostSummary[], zone: string): TodayView['counts'] {
  const today = localDay(ctx.now, zone);
  const out = { scheduled: 0, published: 0, needs_owner: 0, missed: 0, unknown: 0 };
  for (const post of posts) {
    if (post.status === 'needs_owner') out.needs_owner++;
    if (post.status === 'unknown') out.unknown++;
    if (!post.scheduled_at || localDay(post.scheduled_at, zone) !== today) continue;
    if (post.status === 'published') out.published++;
    else if (['scheduled', 'ready', 'awaiting_approval', 'publishing', 'confirming'].includes(post.status) && !post.pause) out.scheduled++;
    else if (post.status === 'missed') out.missed++;
  }
  return out;
}

function publishedAt(ctx: Context, post: PostSummary): string | null {
  const platform = platformPostFor(ctx, post.post_id);
  if (str(platform?.published_at)) return String(platform!.published_at);
  const job = allJobs(ctx).find(row => row.id === post.task_id);
  return str(job?.result?.published_at) ?? str(job?.finished_at) ?? post.scheduled_at;
}

/**
 * C7 buildToday(ctx, tz). WV-6: every time on the page (rows, card text, deadlines, 下一則) is in the page's zone — `tz` when
 * given, else the workspace zone — the zone `timezone` names and `date` is computed in.
 */
export function buildToday(ctx: Context, tz?: string): TodayViewWithGroups {
  const zone = tz ?? workspaceZone(ctx);
  const now = time(ctx.now);
  const entries = hubTargets(ctx).map(target => ({ target, post: postSummaryOf(ctx, target, zone) }));
  const posts = entries.map(entry => entry.post);
  const groups = new Map<string, TodayPostGroup>();
  for (const { target, post } of entries.filter(({ post }) => post.scheduled_at && time(post.scheduled_at) >= now - HOUR && time(post.scheduled_at) <= now + 48 * HOUR
    && post.status !== 'cancelled').sort((a, b) => String(a.post.scheduled_at).localeCompare(String(b.post.scheduled_at))
    || PROVIDER_ORDER.indexOf(a.post.channel.provider) - PROVIDER_ORDER.indexOf(b.post.channel.provider) || a.post.channel.label.localeCompare(b.post.channel.label))) {
    const key = post.content_item_id || post.post_id;
    const item = locate(ctx, 'content_item', post.content_item_id);
    const group = groups.get(key) ?? {
      content_item_id: post.content_item_id, caption_excerpt: post.caption_excerpt, media_thumb_url: post.media_thumb_url, created_at: post.created_at,
      created_by_agent: post.created_by_agent, just_scheduled: false, posts: [], media_filename: mediaFilename(ctx, target),
      title: '',
    };
    group.posts.push(post);
    if (post.created_at < group.created_at) group.created_at = post.created_at;
    group.created_by_agent ||= post.created_by_agent;
    group.just_scheduled = group.created_by_agent && now - time(group.created_at) <= HOUR;
    if (!group.caption_excerpt && post.caption_excerpt) group.caption_excerpt = post.caption_excerpt;
    // 「video.mp4 → X + TikTok」: the media file names the schedule; the caption is shown under it.
    group.title = group.media_filename ?? str(item?.title) ?? group.caption_excerpt;
    groups.set(key, group);
  }
  const recent = posts.filter(post => post.status === 'published').map(post => ({ post, at: publishedAt(ctx, post) }))
    .filter(entry => entry.at && time(entry.at) >= now - 24 * HOUR).sort((a, b) => String(b.at).localeCompare(String(a.at))).map(entry => entry.post);
  return {
    generated_at: ctx.now, timezone: zone, date: localDay(ctx.now, zone),
    attention: attentionItems(ctx, entries, zone), upcoming: [...groups.values()], recent_published: recent,
    machines: machineSummaries(ctx, { zone }), counts: counts(ctx, posts, zone),
  };
}

/** C7 buildOverview(ctx): what smartsell_overview compacts (§7.2.1). */
export function buildOverview(ctx: Context): OverviewViewWithFlags {
  const zone = workspaceZone(ctx);
  const entries = hubTargets(ctx).map(target => ({ target, post: postSummaryOf(ctx, target, zone) }));
  return {
    workspace: { name: String(workspace(ctx).name ?? ''), timezone: zone, now_local: localText(ctx.now, zone) ?? ctx.now },
    machines: machineSummaries(ctx, { zone }), channels: channelSummaries(ctx),
    today: counts(ctx, entries.map(entry => entry.post), zone),
    needs_owner: attentionItems(ctx, entries, zone),
    alerts: { unread: ctx.list('owner_alert').filter(row => row.read_at == null).length },
    web_url: webUrl(ctx, 'today'),
  };
}

export function todayQuery(query: Record<string, string | undefined>): string | undefined {
  strictQuery(query, ['tz']);
  if (query.tz !== undefined && !validZone(query.tz)) invalidQuery('tz', 'tz must be an IANA time zone, e.g. Asia/Shanghai');
  return query.tz;
}
