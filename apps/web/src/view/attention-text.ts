import type { MachineWarning, OwnerAlert, TodayItem } from './data/hub-types';
import { blockerText, missedReasonText } from './hub-copy';

/**
 * U1: what the hub writes for the owner (Today's 「要你處理」 cards, machine warnings, notifications), in the owner's language.
 * The hub sends zh-Hant `title`/`detail` (kept for the Agent and older clients) plus a stable `code` and its `params`. zh-Hant
 * shows the hub's own text; English is written here from code + params, and falls back to the hub's text for a code this
 * table does not know yet.
 */

type Lang = 'zh' | 'en';
type Params = Record<string, unknown>;
type Text = { title: string; detail: string };

const s = (value: unknown, fallback = '') => typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : fallback;
/** The hub's times are 'MM-DD HH:mm', 'HH:mm' or (alerts) 「明天 09:00」. */
const when = (value: unknown) => s(value).replace(/^明天 /, 'tomorrow ');
const at = (value: unknown) => s(value) ? ` ${when(value)}` : '';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (text: string) => text.replace(/\s+/g, ' ').trim();

// ---------- Blockers (Appendix C.2) ----------

const BLOCKER_EN: Record<string, (p: Params) => string> = {
  captcha: p => `${s(p.channel)} on ${s(p.machine, 'the machine')} hit a CAPTCHA and stopped. Solve it in the SmartSell Chrome window on ${s(p.machine, 'that machine')}; it then continues by itself (the page is not reloaded). Deadline ${when(p.deadline) || 'the deadline'}.`,
  two_factor: p => `${s(p.channel)} on ${s(p.machine, 'the machine')} asks for two-factor verification. Complete it on ${s(p.machine, 'that machine')}; it then continues by itself (deadline ${when(p.deadline) || 'the deadline'}).`,
  login_expired: p => `${s(p.channel)} on ${s(p.machine, 'the machine')} is signed out, so this post cannot go out. Sign in again in the SmartSell Chrome window on ${s(p.machine, 'that machine')}; it then continues by itself (deadline ${when(p.deadline) || 'the deadline'}).`,
  identity_mismatch: p => `Chrome on ${s(p.machine, 'the machine')} is signed in to another account, not ${s(p.channel)}. Switch back to the right account on ${s(p.machine, 'that machine')}; it then continues by itself.`,
  risk_prompt: p => `${s(p.channel)} showed a platform risk warning; it stopped and will not retry. Read the platform message on ${s(p.machine, 'the machine')}; if all is well, click Resume to try again (deadline ${when(p.deadline) || 'the deadline'}).`,
  owner_click_required: p => `${s(p.channel)} on ${s(p.machine, 'the machine')} is ready and waits for you to click Post on ${s(p.machine, 'that machine')} (SmartSell does not click Post for this channel). Deadline ${when(p.deadline) || 'the deadline'}.`,
  driver_outdated: p => `The ${s(p.channel)} page may have changed: the driver could not find the element at "${s(p.step, 'a step')}", so this post did not go out. After calibrating, click Resume to try again.`,
  media_unavailable: p => `${s(p.machine, 'The machine')} cannot get the video for this post (still uploading, or the download failed).`,
  media_hash_mismatch: p => `The video ${s(p.machine, 'the machine')} downloaded does not match its checksum; it stopped.`,
  upload_rejected: p => `${s(p.channel)} rejected the video: "${s(p.platform_message, 'no reason given')}". This post did not go out.`,
  caption_rejected: p => `The ${s(p.channel)} text box did not accept the caption the program typed. The page is filled in; check it on ${s(p.machine, 'the machine')} and click Post yourself.`,
  confirm_dialog: p => `${s(p.channel)} showed a dialog that needs confirming; it is waiting on ${s(p.machine, 'the machine')}. Handle it, then click Resume.`,
  platform_error: p => `${s(p.channel)} reported an error; it may or may not have posted. Paste the post's URL on the post page, or confirm it was not posted; SmartSell never posts it again by itself.`,
  result_conflict: p => `The post ${s(p.channel)} reported is already linked to another schedule, so it is unclear which one it belongs to. Check on the post page.`,
  chrome_unavailable: p => `${s(p.machine, 'The machine')} cannot find or start Google Chrome; it tries again every 5 minutes.`,
  profile_in_use: p => `The ${s(p.channel)} Chrome profile on ${s(p.machine, 'the machine')} is in use by another program; close it and it continues by itself.`,
  machine_paused: p => `${s(p.machine, 'The machine')} is paused; this post will not go out until you resume the machine.`,
  owner_stopped: p => `Someone pressed the emergency stop on ${s(p.machine, 'the machine')}.`,
};
const AUTO_RESUMING = ['captcha', 'two_factor', 'login_expired', 'identity_mismatch', 'profile_in_use'];
/** The blocker's owner sentence in English, from the hub's blocker params (code, machine, channel, deadline, step, platform_message). */
export function blockerSentenceEn(p: Params): string | undefined {
  const code = s(p.code ?? p.blocker_code);
  return BLOCKER_EN[code]?.(p);
}
const short = (code: unknown) => blockerText[s(code)]?.[1] ?? 'Needs you';

// ---------- Machine warnings (§3.2) ----------

const WARNING_EN: Record<string, (p: Params) => string> = {
  sleep_enabled: p => `${s(p.name, 'The machine')} sleeps after ${s(p.minutes, 'some')} min idle. The Worker keeps it awake while it holds a post, but closing the lid or sleeping it by hand still misses posts.`,
  no_auto_login: p => `${s(p.name, 'The machine')} needs someone to sign in after a restart before the Worker starts${p.filevault === true ? ' (FileVault is on)' : ''}.`,
  app_outdated: p => `${s(p.name, 'The machine')} runs Worker ${s(p.version)}; ${s(p.latest)} is available.`,
  clock_skew: p => `${s(p.name, 'The machine')}'s clock is off by ${s(p.seconds)} s.`,
  driver_outdated: p => `The ${s(p.names, 'platform')} page may have changed${s(p.step) ? ` (no element found at "${s(p.step)}")` : ''}.`,
  sync_behind: p => `${s(p.name, 'The machine')} has not received your ${s(p.changed)} change yet (last seen ${s(p.seen)}).`,
};
/** One §3.2 warning's sentence: the hub's zh-Hant text, or English from its params. */
export function warningMessage(warning: MachineWarning & { params?: Params }, lang: Lang): string {
  if (lang === 'zh' || !warning.params) return warning.message;
  return WARNING_EN[warning.code]?.(warning.params) ?? warning.message;
}

// ---------- Today's cards (§9.2) ----------

const REMINDER_EN: Record<string, (p: Params) => string> = {
  login: p => `Sign-in not confirmed: click "Check sign-in". Before posting, ${s(p.machine, 'the machine')} checks the sign-in; if it is signed out, that post stops and waits for you`,
  approval_direct: () => 'Approval mode not confirmed: it is "Post directly", so scheduled posts go out without your approval',
  approval_none: () => 'Approval mode not chosen: until you choose, every post waits for your approval',
  risk: p => `SmartSell clicking Post is not confirmed: until you confirm, you click Post yourself on ${s(p.machine, 'the machine')} when it is time`,
  dry_run: p => `No dry run yet: try one to check that ${s(p.machine, 'the machine')} can post for this channel (scheduling and posting are not affected)`,
};
const CHANNEL_BLOCKER_EN: Record<string, (p: Params) => string> = {
  automation_notice_missing: () => 'The automation notice for this channel is not acknowledged yet; click "I understand" on the channel page.',
  machine_binding_missing: () => 'This channel has no machine yet; add it with SmartSell Worker on the machine that will post.',
  machine_paused: p => `${s(p.machine, 'Its machine')} is paused; posts to this channel will not go out until you resume it.`,
  channel_defaults_missing: () => 'The TikTok defaults (privacy, comments, duet and stitch, commercial disclosure) are not set; set them once on the channel page.',
};
const CHECK_EN: Record<string, string> = {
  automation_notice: 'the automation notice is not acknowledged', machine_binding: 'the channel has no usable machine', machine_paused: 'the machine is paused',
  channel_defaults: 'the TikTok defaults are not set', daily_cap: 'the channel is full for that day', publish_window: 'the time is outside the posting window',
  pause_switch: 'publishing is paused', caption_rules: 'the caption breaks the platform rules', media_rules: 'the media breaks the platform rules',
};
const PAUSE_SCOPE_EN: Record<string, string> = { workspace: 'All publishing', brand: 'Brand', campaign: 'Campaign', social_account: 'Channel' };
const pausedBy = (by: unknown) => by === 'agent' ? 'The Agent paused it' : by === 'person' ? 'You paused it' : 'Paused';
const RESUME_NOTE = 'After resuming, posts scheduled meanwhile are sent again; any past the lateness limit show as missed and can be rescheduled.';

const CARD_EN: Record<string, (p: Params) => Text> = {
  approval_expired: p => ({ title: `${s(p.channel)}${at(p.when)}: approval deadline passed`,
    detail: p.deadline ? `The approval deadline (${when(p.deadline)}) has passed, so this post will not go out; reschedule it to submit it again.`
      : 'There is nothing to approve for this post, so it will not go out; reschedule it to submit it again.' }),
  approval_waiting: p => ({ title: `${s(p.channel)}${at(p.when)}: waiting for your approval`,
    detail: p.deadline ? `Approve by ${when(p.deadline)}; after that this post will not go out.` : 'It goes out only after you approve it.' }),
  click_post: p => ({ title: `${s(p.from)}–${s(p.until)}: click Post on ${s(p.machine, 'the machine')}`,
    detail: (p.blocker ? blockerSentenceEn(p.blocker as Params) : undefined) || `${s(p.channel)} is ready and waits for you to click Post on ${s(p.machine, 'the machine')}.` }),
  post_login: p => ({ title: `${s(p.channel)} needs to sign in again (${s(p.machine, 'machine')})`,
    detail: sentence(`${blockerSentenceEn((p.blocker ?? {}) as Params) ?? ''} Click "Sign in again": ${s(p.machine, 'that machine')} opens this channel's SmartSell Chrome sign-in window; sign in there and this page updates by itself.`) }),
  job_blocker: p => {
    const blocker = (p.blocker ?? {}) as Params;
    const text = blockerSentenceEn(blocker) ?? '';
    const auto = blocker.resumable_by === 'auto' && !AUTO_RESUMING.includes(s(blocker.code)) ? ' It continues by itself once fixed.' : '';
    return { title: `${s(p.channel)}${at(p.when)}: ${short(blocker.code)}`, detail: sentence(`${text}${auto}`) };
  },
  missed_released_unconfirmed: p => ({ title: `${s(p.channel)}${at(p.when)}: this post may have gone out`,
    detail: `You force-released it, but ${s(p.machine, 'the machine')} may have posted it already. Check the platform first, then decide whether to reschedule.` }),
  missed: p => ({ title: `${s(p.channel)}${at(p.when)}: this post did not go out`,
    detail: p.reason === 'not_approved' ? 'It was not approved before the deadline, so it did not go out. Reschedule it?'
      : p.reason === 'machine_retired' ? `${s(p.machine, 'The machine')} was retired and the channel has not moved to another machine, so it did not go out. Use "Change machine" on the channel page first, then reschedule.`
        : `${s(p.machine, 'The machine')} did not post it (${missedReasonText[s(p.reason)]?.[1] ?? 'reason unknown'}). Reschedule it?` }),
  unknown: p => ({ title: `${s(p.channel)}${at(p.when)}: result unknown`,
    detail: p.variant === 'clicked' ? `${s(p.machine, 'The machine')} clicked Post but could not read the post's URL. Paste the URL or confirm it was not posted; SmartSell never posts it again by itself.`
      : p.variant === 'offline' ? `${s(p.machine, 'The machine')} has not reported (it is offline); it reports by itself once it is back.`
        : `${s(p.machine, 'The machine')} did not report the result. Check the platform: paste the URL if it is there, or click "Not posted"; SmartSell never posts it again by itself.` }),
  precheck_blocked: p => {
    const checks = (Array.isArray(p.checks) ? p.checks : []).map(key => CHECK_EN[s(key)]).filter(Boolean) as string[];
    return { title: `${s(p.channel)}${at(p.when)}: stopped by the pre-check`,
      detail: checks.length ? `${checks.join('; ').replace(/^./, c => c.toUpperCase())}.` : 'Open the post to see what to fix.' };
  },
  publishing_paused: p => {
    const scope = p.scope === 'social_account' || p.scope === 'brand' ? `${PAUSE_SCOPE_EN[s(p.scope)]} ${s(p.scope_name)}`.trim() : PAUSE_SCOPE_EN[s(p.scope)] ?? 'Publishing';
    const n = Number(p.n) || 0;
    return { title: n ? `${scope} paused: ${plural(n, 'post')} will not go out until resumed` : `${scope} paused: nothing goes out until resumed`,
      detail: sentence(`${pausedBy(p.by)}${p.at ? ` at ${when(p.at)}` : ''}${p.reason ? ` (${s(p.reason)})` : ''}. ${p.first ? `The first is at ${when(p.first)}. ` : ''}${RESUME_NOTE}`) };
  },
  machine_paused: p => {
    const n = Number(p.n) || 0;
    return { title: `${s(p.machine, 'Machine')} paused${p.reason ? ` (${s(p.reason)})` : ''}${n ? `: ${plural(n, 'post')} will not go out until resumed` : ''}`,
      detail: sentence(`${p.at ? `${pausedBy(p.by)} at ${when(p.at)}. ` : ''}${n ? (p.first ? `The first is at ${when(p.first)}. ` : '') : 'Its channels post nothing until it is resumed. '}`
        + `After resuming, posts scheduled meanwhile go out as usual; any past the lateness limit show as missed and can be rescheduled.`
        + `${p.offline ? ` ${s(p.machine, 'It')} is also not connected right now; once resumed it posts when it is back online.` : ''}`) };
  },
  channel_login: p => {
    const where = s(p.machine, 'that machine');
    if (p.status === 'challenge') return { title: `${s(p.channel)} needs verification${p.machine ? ` (${s(p.machine)})` : ''}`,
      detail: `${s(p.channel)} on ${where} shows a verification step. Complete it in the SmartSell Chrome window on ${where}, then click "Check sign-in"; if the window is closed, "Sign in again" opens it on ${where}.` };
    if (p.status === 'identity_mismatch') return { title: `${s(p.channel)}: Chrome is signed in to another account${p.machine ? ` (${s(p.machine)})` : ''}`,
      detail: `Chrome on ${where} is not signed in to ${s(p.channel)}. Click "Sign in again": ${where} opens this channel's SmartSell Chrome sign-in window; switch back to ${s(p.channel)} there and this page updates by itself.` };
    return { title: `${s(p.channel)} needs to sign in again${p.machine ? ` (${s(p.machine)})` : ''}`,
      detail: `${s(p.channel)} on ${where} is signed out, so posts to this channel cannot go out. Click "Sign in again": ${where} opens this channel's SmartSell Chrome sign-in window; sign in there.` };
  },
  channel_blockers: p => {
    const codes = (Array.isArray(p.blockers) ? p.blockers : []).map(value => s(value));
    return { title: `${s(p.channel)} is not set up yet and cannot be scheduled (${plural(codes.length, 'item')})`,
      detail: codes.map(code => CHANNEL_BLOCKER_EN[code]?.(p) ?? code).join(' ') };
  },
  channel_reminder: p => {
    const lines = (Array.isArray(p.lines) ? p.lines : []).map(value => s(value));
    if (lines.length === 1 && lines[0] === 'dry_run') return { title: `Suggested: a dry run for ${s(p.channel)}`,
      detail: `A dry run goes through posting on ${s(p.machine, 'the machine')} and stops before Post, to check this machine can post for the channel. Scheduling and posting are not affected.` };
    return { title: `${s(p.channel)}: setup reminders (${lines.length}, scheduling not affected)`,
      detail: `${lines.map(line => REMINDER_EN[line]?.(p) ?? line).join('; ')}.` };
  },
  dry_run_fallback: p => ({ title: `${s(p.channel)} used a fallback selector in its dry run`,
    detail: 'The platform page may have changed. Run pnpm hub:update on the hub to update the selectors, then do the dry run again.' }),
  machine_offline: p => ({ title: `${s(p.machine, 'Machine')} is offline: ${plural(Number(p.n) || 0, 'post')} waiting, the first at ${when(p.first)}`,
    detail: `Check that ${s(p.machine, 'it')} is on, connected to Tailscale, and that SmartSell Worker is running.` }),
  machine_setup: p => {
    const warnings = (Array.isArray(p.warnings) ? p.warnings : []) as Params[];
    return { title: `${s(p.machine, 'Machine')}: settings to check (${plural(warnings.length, 'item')})`,
      detail: warnings.map(warning => WARNING_EN[s(warning.code)]?.(warning) ?? '').filter(Boolean).join(' ') };
  },
};

type Coded = { code?: string; params?: Params };
/** A Today card's title and detail in `lang` (U1). */
export function attentionText(item: TodayItem, lang: Lang): Text {
  const coded = item as TodayItem & Coded;
  if (lang === 'en' && coded.code && coded.params && CARD_EN[coded.code]) {
    try { return CARD_EN[coded.code](coded.params); } catch { /* the hub's own text below */ }
  }
  return { title: item.title, detail: item.detail };
}

const ACTION_EN: Record<string, string> = {
  approve: 'Approve', reject: 'Reject', reschedule: 'Reschedule…', confirm_result: 'Paste URL', mark_not_published: 'Not posted', cancel: 'Cancel',
  retry: 'Retry', force_release: 'Force release', check_login: 'Check sign-in', open_remote: 'Open remote screen', resume: 'Resume',
};
/** A card button's words (U1): the hub's zh-Hant label, or English by action and card. */
export function actionLabel(action: { kind: string; label: string }, item: TodayItem, lang: Lang): string {
  if (lang === 'zh') return action.label;
  if (action.kind === 'resume' && item.id.startsWith('machine_paused:')) return 'Resume machine';
  if (action.kind !== 'open') return ACTION_EN[action.kind] ?? action.label;
  if (item.post) return 'Open post';
  if (item.id.startsWith('pause:')) return 'Resume in Settings';
  if (item.kind === 'machine_offline' || item.kind === 'machine_setup' || item.id.startsWith('machine_paused:')) return 'Open machine';
  if (item.kind === 'channel_setup') return 'Open channel settings';
  return 'Open channel';
}

// ---------- Notifications (§5.9) ----------

const FAILED_EN: Record<string, string> = {
  upload_rejected: 'the platform rejected the video', media_hash_mismatch: 'video checksum mismatch', caption_rejected: 'the caption was not accepted',
  driver_outdated: 'the page may have changed', media_unavailable: 'the video was not available', chrome_unavailable: 'Google Chrome could not start',
  profile_in_use: 'the Chrome profile was in use', default: 'the machine reported a failure',
};
const LOGIN_STATE_EN: Record<string, string> = {
  login_required: 'signed out or never signed in', identity_mismatch: 'Chrome is signed in to another account', challenge: 'a CAPTCHA or two-factor check appeared',
  login_expired: 'signed out or never signed in', captcha: 'a CAPTCHA appeared', two_factor: 'two-factor verification was asked for',
};
const who = (p: Params) => p.machine && p.channel ? `${s(p.channel)} on ${s(p.machine)}` : s(p.channel) || s(p.machine) || 'SmartSell';
const dry = (p: Params) => p.dry_run === true ? ' (dry run)' : '';

const ALERT_EN: Record<string, (p: Params) => { title: string; body: string }> = {
  worker_blocker: p => ({ title: `${who(p)}: ${short(p.blocker_code).toLowerCase()}${dry(p)}.`, body: blockerSentenceEn(p) ?? `${who(p)} needs you; it stopped.` }),
  failed: p => ({ title: `${who(p)}: ${short(p.blocker_code).toLowerCase()}; this post did not go out${dry(p)}.`,
    body: blockerSentenceEn(p) ?? `${who(p)}: this post did not go out.` }),
  failed_late_report: p => ({ title: `${who(p)}: the post did not go out (${s(p.machine, 'the machine')} reported later)${dry(p)}.`,
    body: `${s(p.machine, 'The machine')} reported later that this ${s(p.channel)} post did not go out (${FAILED_EN[s(p.reason_code)] ?? FAILED_EN.default}); it stopped before sending. Reschedule it?` }),
  missed: p => {
    const reason = missedReasonText[s(p.reason_code)]?.[1] ?? 'past the lateness limit';
    if (p.reason_code === 'not_approved') return { title: `${who(p)}: the post did not go out (not approved in time).`,
      body: `${who(p)}: this post was not approved by ${when(p.deadline) || 'the deadline'}, so it did not go out. Reschedule it?` };
    if (p.reason_code === 'paused') return { title: `${who(p)}: the post did not go out (paused).`,
      body: `${who(p)}: this post did not go out because ${p.pause_scope === 'machine' ? 'the machine' : p.pause_scope === 'workspace' ? 'the workspace' : p.pause_scope === 'brand' ? 'the brand' : 'this channel'} was paused${p.paused_at ? ` at ${when(p.paused_at)}` : ''} by ${p.paused_by === 'agent' ? 'the Agent' : 'you'}. Reschedule it?` };
    return { title: `${who(p)}: the post did not go out (${reason.toLowerCase()}).`,
      body: `${s(p.channel, 'This channel')}: ${s(p.machine, 'the machine')} did not start by ${when(p.deadline) || 'the deadline'} (${reason.toLowerCase()}), so it did not go out. Reschedule it?` };
  },
  unknown: p => ({ title: `${who(p)}: the result is unknown; check whether it went out.`,
    body: `${s(p.machine, 'The machine')} clicked Post but could not read the ${s(p.channel)} post's URL. Paste the URL, or confirm it was not posted; SmartSell never posts it again by itself.` }),
  unknown_blocker: p => ({ title: `${who(p)}: the result is unknown; check whether it went out.`, body: blockerSentenceEn(p) ?? '' }),
  unreported: p => ({ title: `${s(p.machine, 'The machine')} has not reported the ${when(p.local_time) || 'scheduled'} ${s(p.channel)} post.`,
    body: `${s(p.machine, 'The machine')} has not reported the ${when(p.local_time) || 'scheduled'} ${s(p.channel)} post (it is offline). It reports by itself once it is back online.` }),
  published: p => ({ title: `${s(p.channel)} was posted by ${s(p.machine, 'the machine')} at ${when(p.at)}.`,
    body: `${s(p.channel)} was posted by ${s(p.machine, 'the machine')} at ${when(p.at)}; its URL is back in SmartSell.` }),
  login_check_failed: p => {
    const state = LOGIN_STATE_EN[s(p.state)] ?? 'it did not pass';
    return { title: `${who(p)}: sign-in check failed (${state}).`,
      body: `The sign-in check of ${who(p)} did not pass (${state}). Scheduled posts may not go out; sign in again in the SmartSell Chrome window on ${s(p.machine, 'that machine')}, or click "Check sign-in" on the channel page.` };
  },
  approval_due: p => ({ title: `${who(p)}: the ${when(p.at)} post waits for your approval${p.stage === '60' ? ' (1 hour left)' : p.stage === '10' ? ' (10 minutes left)' : ''}; deadline ${when(p.deadline)}.`,
    body: `${who(p)} has a post at ${when(p.at)} that needs your approval. Approve it by ${when(p.deadline)}; after that it will not go out.` }),
  click_post_soon: p => p.stage === 'lead'
    ? { title: `At ${when(p.from)}, click Post on ${s(p.machine)}: ${s(p.channel)}.`,
      body: `${s(p.channel)} on ${s(p.machine)} posts at ${when(p.from)} and SmartSell does not click Post for this channel. Click Post on ${s(p.machine)} between ${when(p.from)} and ${when(p.until)}.${p.remote ? ` You can also use the remote screen: ${s(p.remote)}` : ''}` }
    : { title: `Click Post on ${s(p.machine)} now: ${s(p.channel)} (deadline ${when(p.until)}).`,
      body: `${BLOCKER_EN.owner_click_required({ machine: p.machine, channel: p.channel, deadline: p.until })}${p.remote ? ` You can also use the remote screen: ${s(p.remote)}` : ''}` },
  click_post_not_ready: p => ({ title: `${s(p.machine)} has not prepared the ${s(p.channel)} draft yet (deadline ${when(p.until)}).`,
    body: `${s(p.channel)} on ${s(p.machine)} posts at ${when(p.from)}, but ${s(p.machine)} has not prepared the draft, so you cannot click Post yet. You get another notice when it is ready; deadline ${when(p.until)}.` }),
  machine_offline_with_jobs: p => ({ title: `${s(p.machine, 'A machine')} is offline: ${plural(Number(p.n) || 0, 'post')} waiting, the first at ${when(p.first)}.`,
    body: `${s(p.machine, 'The machine')} has not been connected${p.since ? ` since ${when(p.since)}` : ' since it was paired'}, and ${plural(Number(p.n) || 0, 'post')} within 2 hours ${Number(p.n) === 1 ? 'is' : 'are'} due on it (${s(p.channels, 'its channels').replaceAll('、', ', ')}, the first at ${when(p.first)}). Check that it is on, not asleep and online; posts still offline past the lateness limit are not posted later.` }),
  machine_setup: p => {
    const warning = (p.warning ?? {}) as Params;
    return { title: `${s(p.machine, 'Machine')}: a setting needs changing`, body: WARNING_EN[s(warning.code)]?.(warning) ?? '' };
  },
  late_fact_after_release: p => ({ title: `${who(p)} posted the old version after it was withdrawn${p.cancelled ? '; the new version was cancelled' : ''}.`,
    body: p.cancelled ? `${s(p.machine, 'The machine')} posted the old version of the ${s(p.channel)} post after it was withdrawn; the new version was cancelled automatically and will not go out. Check on the post page.`
      : `${s(p.machine, 'The machine')} reported that it posted (or may have posted) the ${s(p.channel, 'channel')} post after it was withdrawn or force-released; SmartSell will not post it again by itself. Check on the post page.` }),
  offline_run_stale_settings: p => ({ title: `${who(p)} posted offline with old settings.`,
    body: `${s(p.machine, 'The machine')} could not reach the hub and posted the ${s(p.channel)} post on schedule, before it received your later pause or posting-mode change. Check on the post page.` }),
  handle_changed: p => ({ title: `The ${s(p.provider, 'platform')} account @${s(p.from)} is now called @${s(p.to)}.`,
    body: `${s(p.machine, 'The machine')} read that the ${s(p.provider, 'platform')} account name changed from @${s(p.from)} to @${s(p.to)}. SmartSell updated the name it shows and scheduled posts go out as usual; if you did not change it, check the channel page.` }),
  daily_summary: p => {
    const posts = (Array.isArray(p.posts) ? p.posts : []) as Params[];
    const issues = (Array.isArray(p.issues) ? p.issues : []) as Params[];
    const nPosts = Number(p.n_posts) || 0, nIssues = Number(p.n_issues) || 0;
    const status: Record<string, string> = { needs_owner: 'needs you', outcome_unknown: 'result unknown', unreported: 'machine has not reported', awaiting_approval: 'waiting for your approval' };
    return { title: `Tomorrow: ${plural(nPosts, 'post')} scheduled, ${plural(nIssues, 'item')} to handle.`,
      body: [nPosts ? `Tomorrow's schedule (${plural(nPosts, 'post')}):` : 'Nothing is scheduled for tomorrow.',
        ...posts.map(post => `${s(post.at)} ${s(post.channel, 'channel')}${post.machine ? ` (${s(post.machine)})` : ''}`), ...(nPosts > posts.length ? [`${nPosts - posts.length} more`] : []),
        nIssues ? `Still open (${plural(nIssues, 'item')}):` : 'Nothing is left open.',
        ...issues.map(issue => `${s(issue.channel, 'channel')}: ${status[s(issue.status)] ?? s(issue.status)}`), ...(nIssues > issues.length ? [`${nIssues - issues.length} more`] : [])].join('\n') };
  },
  upload_done: p => ({ title: `${s(p.filename, 'The video')} finished uploading.`,
    body: `${s(p.filename, 'The video')} is on the hub and checked; scheduled posts that use it can go out.` }),
  upload_failed: p => ({ title: `${s(p.filename, 'The video')} did not upload.`,
    body: `${s(p.filename, 'The video')} did not upload, so posts that use it cannot go out until it is uploaded again. Ask Codex to upload this file once more.` }),
};
/** A post, channel or machine label from the hub ('X @a 明天 09:00') in the page's language (U1). */
export function refLabel(label: string, lang: Lang): string {
  return lang === 'en' ? label.replace(/(^|\s)明天 /, '$1tomorrow ') : label;
}
/** A notification's title and body in `lang` (U1); a kind this table does not know keeps the hub's text. */
export function alertText(alert: OwnerAlert, lang: Lang): { title: string; body: string } {
  if (lang === 'en' && alert.code && alert.params && ALERT_EN[alert.code]) {
    try {
      const text = ALERT_EN[alert.code](alert.params);
      if (text.title && text.body) return text;
    } catch { /* the hub's own text below */ }
  }
  return { title: alert.title, body: alert.body };
}
