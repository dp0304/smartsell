import { useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, asRecord, request, workspacePath, type Method, type RecordData } from '@smartsell/sdk';
import { ProblemNotice } from '../api';
import { useCopy } from '../i18n';
import { fill } from './copy';
import { viewPrefix } from './data/keys';
import { decisionOutcome, useViewContext } from './data/use-view';
import type { PostAction, PostDetailView, PostPause, PostStatus } from './data/hub-types';
import { RouterLink, useText } from './parts';
import { hub, jobStatusText, loginText, modeText, ownerErrorText, postStatusText, postStatusTone, providerText } from './hub-copy';
import './pages/hub.css';

/** Shared pieces of the phase 1 pages (Today, machines, channels, posts). */

type L = ReturnType<typeof useText>['l'];
export const tr = (l: L, table: Record<string, readonly [string, string]>, key: string | null | undefined, fallback = '') =>
  key && table[key] ? l(table[key]) : fallback || String(key ?? '');

const DAY_MS = 86_400_000;
/** 'YYYY-MM-DD HH:mm' (the hub's local text) as 「今天 09:00」「明天 09:00」「11/27 09:00」. */
export function localLabel(local: string | null | undefined, today: string | undefined, lang: 'zh' | 'en'): string {
  if (!local) return '';
  const [day, clock = ''] = local.split(' ');
  if (today) {
    if (day === today) return `${lang === 'en' ? 'Today' : '今天'} ${clock}`;
    const next = new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    if (day === next) return `${lang === 'en' ? 'Tomorrow' : '明天'} ${clock}`;
  }
  const [, month, date] = day.split('-');
  return `${Number(month)}/${Number(date)} ${clock}`.trim();
}
/** Today's date in a zone (for localLabel when a view has no `date`). */
export function todayIn(zone?: string) {
  try { return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
/** The browser's own zone (list pages show times in it and say so, WV-6). */
export function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
/** WV-6: names the zone a page's times are in. */
export function ZoneNote({ zone }: { zone: string }) {
  const { l } = useText();
  return <small className="muted hub-small hub-zone">{fill(l(hub.today.timesIn), { zone })}</small>;
}
/** An ISO instant in a zone as 'YYYY-MM-DD HH:mm'. */
export function isoLocal(iso: string | null | undefined, zone?: string): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  try {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(iso));
  } catch { return iso.slice(0, 16).replace('T', ' '); }
}

export function Badge({ tone = 'neutral', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return <span className={`hub-badge tone-${tone}`} title={title}>{children}</span>;
}
export function PostStatusBadge({ status }: { status: PostStatus | string }) {
  const { l } = useText();
  return <Badge tone={postStatusTone[status] ?? 'neutral'}>{tr(l, postStatusText, status)}</Badge>;
}
const jobTone: Record<string, string> = { succeeded: 'good', needs_owner: 'critical', failed: 'critical', missed: 'critical', outcome_unknown: 'critical',
  unreported: 'warning', releasing: 'neutral', cancelled: 'neutral', superseded: 'neutral' };
export function JobStatusBadge({ status }: { status: string }) {
  const { l } = useText();
  return <Badge tone={jobTone[status] ?? 'info'}>{tr(l, jobStatusText, status)}</Badge>;
}
export function OnlineBadge({ online, paused }: { online: boolean; paused?: boolean }) {
  const { l } = useText();
  return <Badge tone={paused ? 'warning' : online ? 'good' : 'neutral'}><i className={`hub-dot ${online ? 'on' : 'off'}`} aria-hidden="true" />{l(paused ? hub.common.paused : online ? hub.common.online : hub.common.offline)}</Badge>;
}
export function LoginBadge({ state }: { state: string }) {
  const { l } = useText();
  const tone = state === 'verified' ? 'good' : ['login_required', 'identity_mismatch', 'challenge'].includes(state) ? 'critical' : 'neutral';
  return <Badge tone={tone}>{tr(l, loginText, state)}</Badge>;
}
export function ModeBadge({ mode }: { mode: string }) {
  const { l } = useText();
  return <Badge tone={mode === 'auto' ? 'info' : mode === 'assist' ? 'warning' : 'neutral'}>{tr(l, modeText, mode)}</Badge>;
}
export const providerName = (l: L, provider: string) => tr(l, providerText, provider, provider);
/** 'X @lurelab' with the platform as a small tag. */
export function ChannelName({ provider, handle, label }: { provider: string; handle: string | null; label?: string }) {
  const { l } = useText();
  return <span className="hub-channel-name"><span className={`hub-provider p-${provider}`}>{providerName(l, provider)}</span>{handle ? `@${handle}` : label?.replace(/^\S+\s/, '') ?? ''}</span>;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="hub-empty"><p>{children}</p>{action}</div>;
}

/** POST/PATCH/PUT/DELETE through the workspace API with CSRF (and If-Match when a version is given), refreshing every view. */
export function useHubWrite() {
  const { ws, session } = useViewContext();
  const client = useQueryClient();
  return async <T = unknown>(method: Method, path: string, body?: RecordData, options: { version?: number } = {}) => {
    try { return await request<T>(`${workspacePath(ws)}${path}`, { method, body, version: options.version, csrf: session.csrf_token }); }
    finally { void client.invalidateQueries({ queryKey: viewPrefix(ws) }); }
  };
}
/** GET inside the workspace API (outside the view cache), e.g. a target's version right before approving it. */
export function useHubRead() {
  const { ws } = useViewContext();
  return <T = unknown>(path: string) => request<T>(`${workspacePath(ws)}${path}`);
}

export const problemCode = (error: unknown) => error instanceof ApiError ? String(error.problem.code ?? '') : '';

/**
 * WV-11: what the owner reads for a refused action. zh-Hant: the hub's `details.owner_message` when it sends one, else the
 * owner copy for the code (Appendix C); English: the owner copy for the code. The Agent-facing `message` is the last resort
 * (undefined here: the caller then shows the plain problem). `action` names the button, for codes whose meaning depends on it.
 */
export function ownerProblemText(l: L, lang: 'zh' | 'en', error: unknown, action?: string): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const details = asRecord(error.problem.details);
  const owner = details.owner_message;
  if (lang === 'zh' && typeof owner === 'string' && owner.trim()) return owner;
  const code = String(error.problem.code ?? '');
  // Approving or rejecting without a pending request (deadline passed, or decided elsewhere): 409 INVALID_STATE.
  if (code === 'INVALID_STATE' && (action === 'approve' || action === 'reject')) return l(hub.action.notApprovable);
  const text = ownerErrorText[code];
  return text ? fill(l(text), { expected: String(details.expected ?? '') }) : undefined;
}
export function WriteError({ error, action }: { error: unknown; action?: string }) {
  const { l, lang } = useText();
  const { t } = useCopy();
  if (error === undefined || error === null) return null;
  const text = ownerProblemText(l, lang, error, action);
  if (!text || !(error instanceof ApiError)) return <ProblemNotice error={error} />;
  return <div className="problem" role="alert"><strong>{t('error')} · {error.status}</strong><p>{text}</p>
    {error.problem.code ? <small>{String(error.problem.code)}</small> : null}</div>;
}

/** WV-3: what an approve or reject answered with 200 really did (the hub can answer 200 without recording a decision). */
export function approvalNotice(l: L, action: 'approve' | 'reject', data: unknown): { tone: 'good' | 'warning'; text: string } {
  const outcome = decisionOutcome({ kind: 'publish_approval' }, data);
  if (outcome.kind === 'blocked') {
    return { tone: 'warning', text: outcome.blockers.length ? fill(l(hub.action.approveBlocked), { reasons: outcome.blockers.join('；') }) : l(hub.action.approveBlockedNone) };
  }
  if (outcome.kind === 'expired') return { tone: 'warning', text: l(hub.action.approveExpired) };
  void action;
  return { tone: 'good', text: l(hub.action.done) };
}

/**
 * WV-11: the time 「改到…」 starts from, as the datetime-local value ('YYYY-MM-DDTHH:mm') in the post's zone: the post's own
 * time while it is still ahead, else the next full hour (a missed or failed post's time is in the past and would be refused).
 */
export function defaultRescheduleTime(post: { scheduled_at: string | null; local_time: string | null }, zone: string | undefined, now = Date.now()): string {
  if (post.local_time && post.scheduled_at && Date.parse(post.scheduled_at) > now + 60_000) return post.local_time.replace(' ', 'T');
  const next = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
  return (isoLocal(new Date(next).toISOString(), zone) ?? '').replace(' ', 'T');
}

/** E35: the note on a post a pause holds — 「已暫停：恢復前不會發出」, who paused it, when, why, and where to resume. */
export function PauseNote({ pause, today, zone, compact = false }: { pause: PostPause; today: string; zone?: string; compact?: boolean }) {
  const { l, lang } = useText();
  const scope = pause.scope === 'machine' ? hub.channels.scope_machine : hub.channels[`scope_${pause.scope}`];
  const by = pause.by === 'agent' ? hub.channels.by_agent : pause.by === 'person' ? hub.channels.by_person : hub.channels.by_unknown;
  const resume = pause.resume_web_url.replace(/^https?:\/\/[^/]+/, '');
  return <div className="hub-callout warn" role="note"><strong>{l(hub.post.paused)}</strong>
    <p>{fill(l(hub.channels.pausedBy), { scope: l(scope), at: localLabel(isoLocal(pause.at, zone), today, lang), by: l(by), reason: pause.reason || '—' })}</p>
    {!compact && <p><RouterLink to={resume} className="vs-btn">{l(pause.scope === 'machine' ? hub.channels.resumeMachine : hub.channels.resumeLink)}</RouterLink></p>}
  </div>;
}

// ---------- Post actions (§5.14): human only, with the consequence spelled out ----------

type Panel = PostAction | null;
export function PostActions({ detail, compact = false }: { detail: PostDetailView; compact?: boolean }) {
  const { l } = useText();
  const { base } = useViewContext();
  const write = useHubWrite();
  const read = useHubRead();
  const [panel, setPanel] = useState<Panel>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ failure: unknown; action: PostAction }>();
  const [done, setDone] = useState<{ tone: 'good' | 'warning'; text: string }>();
  const post = detail.post;
  const job = detail.task;
  const machine = post.machine?.name ?? l(hub.common.unknownMachine);
  const zone = post.timezone;
  const [when, setWhen] = useState(() => defaultRescheduleTime(post, zone));
  const [url, setUrl] = useState('');
  const [sure, setSure] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  if (!detail.actions.length) return compact ? null : <p className="muted">{l(hub.post.noActions)}</p>;
  async function run(action: PostAction, event?: FormEvent) {
    event?.preventDefault();
    setPending(true); setError(undefined); setDone(undefined);
    const id = encodeURIComponent(post.post_id);
    const sent = { tone: 'good' as const, text: l(hub.action.done) };
    try {
      switch (action) {
        case 'approve': case 'reject': {
          const current = asRecord((await read<RecordData>(`/publish-targets/${id}`)).data).version;
          if (typeof current !== 'number') throw new ApiError(502, { code: 'INVALID_RESPONSE' });
          const target = current;
          const result = await write<RecordData>('POST', `/publish-targets/${id}/${action}`, action === 'approve'
            ? { ...(detail.approval.resource_hash && { resource_hash: detail.approval.resource_hash }) } : { ...(reason && { reason }) }, { version: target });
          // WV-3: 200 with decision_status 'blocked' or 'expired' recorded nothing; say so instead of 「已送出。」.
          setDone(approvalNotice(l, action, result.data));
          break;
        }
        case 'cancel': await write('POST', `/hub/posts/${id}/update`, { action: 'cancel', ...(reason && { reason }) }); setDone(sent); break;
        case 'reschedule': await write('POST', `/hub/posts/${id}/update`, { action: 'reschedule', when: when.replace('T', ' ').slice(0, 16), timezone: zone }); setDone(sent); break;
        case 'retry': await write('POST', `/hub/posts/${id}/retry`, {}); setDone(sent); break;
        case 'resume': await write('POST', `/hub/jobs/${encodeURIComponent(job!.task_id)}/resume`, {}); setDone(sent); break;
        case 'confirm_result': await write('POST', `/hub/posts/${id}/confirm-result`, { url: url.trim() }); setDone(sent); break;
        case 'mark_not_published': await write('POST', `/hub/posts/${id}/mark-not-published`, { confirm: true }); setDone(sent); break;
        case 'force_release': await write('POST', `/hub/jobs/${encodeURIComponent(job!.task_id)}/force-release`, { confirm_text: typed.trim() }); setDone(sent); break;
      }
      setPanel(null);
    } catch (failure) { setError({ failure, action }); }
    finally { setPending(false); }
  }
  const immediate = new Set<PostAction>(['approve', 'retry']);
  const forceText = fill(l(hub.action.forceText), { machine });
  return <div className="hub-actions">
    <div className="vs-actions">
      {detail.actions.map(action => <button key={action} type="button" disabled={pending}
        className={`vs-btn ${['approve', 'confirm_result', 'resume', 'retry'].includes(action) ? 'primary-soft' : ''} ${['force_release', 'cancel', 'reject'].includes(action) ? 'ghost' : ''}`}
        aria-expanded={!immediate.has(action) ? panel === action : undefined}
        onClick={() => immediate.has(action) ? void run(action) : setPanel(panel === action ? null : action)}>{l(hub.action[action])}</button>)}
      {compact && <RouterLink to={`${base}/posts/${encodeURIComponent(post.post_id)}`} className="vs-btn ghost">{l(hub.post.openFull)}</RouterLink>}
    </div>
    {!compact && <p className="muted hub-small">{l(hub.action.humanOnly)}</p>}
    {panel && <form className="hub-panel" onSubmit={event => void run(panel, event)}>
      {panel === 'cancel' && <><p>{l(hub.action.cancelHint)}</p><label className="hub-field">{l(hub.action.reason)}<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label></>}
      {panel === 'reject' && <label className="hub-field">{l(hub.action.reason)}<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label>}
      {panel === 'reschedule' && <><p>{fill(l(hub.action.rescheduleHint), { zone })}</p>
        <label className="hub-field">{l(hub.action.newTime)}<input type="datetime-local" required value={when} onChange={event => setWhen(event.target.value)} /></label></>}
      {panel === 'resume' && <p>{l(hub.action.resumeHint)}</p>}
      {panel === 'confirm_result' && <><p>{l(hub.action.confirmHint)}</p>
        <label className="hub-field">{l(hub.action.url)}<input type="url" required inputMode="url" placeholder={post.channel.provider === 'x' ? 'https://x.com/…/status/…' : 'https://www.tiktok.com/@…/video/…'}
          value={url} onChange={event => setUrl(event.target.value)} /></label></>}
      {panel === 'mark_not_published' && <><p>{l(hub.action.markHint)}</p>
        <label className="hub-check"><input type="checkbox" checked={sure} onChange={event => setSure(event.target.checked)} />{l(hub.action.markCheck)}</label></>}
      {panel === 'force_release' && <><p>{fill(l(hub.action.forceHint), { machine })}</p><p>{l(hub.action.forceType)}</p><blockquote className="hub-quote">{forceText}</blockquote>
        <label className="hub-field"><span className="vs-sr">{l(hub.action.forceType)}</span><input value={typed} onChange={event => setTyped(event.target.value)} /></label></>}
      <div className="vs-actions">
        <button className="vs-btn primary-soft" type="submit" disabled={pending || (panel === 'mark_not_published' && !sure) || (panel === 'force_release' && typed.trim() !== forceText)}>
          {pending ? l(hub.common.sending) : l(hub.action.confirm)}</button>
        <button className="vs-btn ghost" type="button" onClick={() => setPanel(null)}>{l(hub.common.close)}</button>
      </div>
    </form>}
    {done && <p className={`vs-notice ${done.tone}`} role={done.tone === 'good' ? 'status' : 'alert'}>{done.text}</p>}
    <WriteError error={error?.failure} action={error?.action} />
  </div>;
}

