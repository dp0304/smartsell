import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { Check, Circle } from 'lucide-react';
import { ApiError, asRecord } from '@smartsell/sdk';
import { fill } from '../copy';
import type { ChannelDetail, ChannelSettingsRecord, MachineSummary, MediaRecentItem, PublishWindow, TikTokDefaults } from '../data/hub-types';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, PageHeader, RouterLink, Section, useText } from '../parts';
import { RELOGIN, approvalModeText, hub, loginText } from '../hub-copy';
import { Badge, ChannelName, Empty, LoginBadge, ModeBadge, OnlineBadge, PostStatusBadge, WriteError, isoLocal, localLabel, problemCode, providerName, todayIn, tr, useHubWrite } from '../hub-parts';
import { pauseOf } from '../data/hub-types';
import { JobRows } from './MachinesPage';
import { READINESS_KEYS } from './ChannelsPage';

// ---------- 「重新登入」 (E21, §8.16 step 7): shared with Today's login card ----------

type L = ReturnType<typeof useText>['l'];
type ReloginWrite = (method: 'POST', path: string, body: Record<string, unknown>) => Promise<{ data: unknown }>;
/** hub_channels_check with open_login_window: true. People only: the hub answers an Agent credential 403 HUMAN_REQUIRED. */
export async function requestRelogin(write: ReloginWrite, channelId: string) {
  return (await write('POST', `/hub/channels/${encodeURIComponent(channelId)}/check`, { open_login_window: true })).data;
}
/** What the owner is told after 「重新登入」, from the hub's answer: only a check that will open the window says so. */
export function reloginMessage(l: L, result: unknown, names: { machine: string; channel: string }) {
  const data = asRecord(result);
  const reported = asRecord(data.machine).name;
  const values = { machine: typeof reported === 'string' && reported ? reported : names.machine, channel: names.channel };
  if (data.status === 'done') return fill(l(RELOGIN.done), values);
  if (data.open_login_window !== true) return fill(l(RELOGIN.busy), values);
  return fill(l(data.status === 'machine_offline' ? RELOGIN.offline : RELOGIN.opened), values);
}

type Settings = ChannelSettingsRecord;
const TIKTOK_DEFAULT: TikTokDefaults = { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false };
const PRIVACY: [TikTokDefaults['privacy_level'], readonly [string, string]][] = [
  ['PUBLIC_TO_EVERYONE', ['所有人', 'Everyone']], ['MUTUAL_FOLLOW_FRIENDS', ['互相追蹤的朋友', 'Friends']], ['FOLLOWER_OF_CREATOR', ['追蹤者', 'Followers']], ['SELF_ONLY', ['只有我', 'Only me']]];
const COMMERCIAL: [TikTokDefaults['commercial_disclosure'], readonly [string, string]][] = [
  ['none', ['不是商業內容', 'Not commercial']], ['your_brand', ['你的品牌', 'Your brand']], ['branded_content', ['品牌合作內容', 'Branded content']], ['both', ['兩者都是', 'Both']]];
const REPLY: ['everyone' | 'following' | 'mentioned' | 'verified', readonly [string, string]][] = [
  ['everyone', ['所有人', 'Everyone']], ['following', ['你追蹤的帳號', 'Accounts you follow']], ['mentioned', ['你提及的帳號', 'Accounts you mention']], ['verified', ['已驗證的帳號', 'Verified accounts']]];
const DAYS: [1 | 2 | 3 | 4 | 5 | 6 | 7, readonly [string, string]][] = [[1, ['一', 'Mon']], [2, ['二', 'Tue']], [3, ['三', 'Wed']], [4, ['四', 'Thu']], [5, ['五', 'Fri']], [6, ['六', 'Sat']], [7, ['日', 'Sun']]];

function Readiness({ channel }: { channel: ChannelDetail }) {
  const { l } = useText();
  const keys = READINESS_KEYS.filter(key => key !== 'defaults_ready' || channel.provider === 'tiktok');
  return <ol className="hub-checklist">{keys.map(key => <li key={key} className={channel.readiness[key] ? 'done' : 'todo'}>
    {channel.readiness[key] ? <Check size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}<span>{l(hub.channels[key])}</span>
    <span className="vs-sr">{l(channel.readiness[key] ? hub.common.yes : hub.common.no)}</span>
  </li>)}</ol>;
}

function useAction() {
  const write = useHubWrite();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState<string>();
  async function run(key: string, call: () => Promise<string | undefined>) {
    setPending(key); setError(undefined); setMessage(undefined);
    try { setMessage(await call()); } catch (failure) { setError(failure); } finally { setPending(undefined); }
  }
  return { write, pending, error, message, run, setError };
}

function HeaderTools({ channel }: { channel: ChannelDetail }) {
  const { l } = useText();
  const { base } = useViewContext();
  const { write, pending, error, message, run } = useAction();
  const machines = useView<MachineSummary[]>('/views/machines');
  const [binding, setBinding] = useState(false);
  const [device, setDevice] = useState('');
  const [owned, setOwned] = useState(false);
  const id = encodeURIComponent(channel.channel_id);
  const machine = channel.machine?.name ?? l(hub.common.unknownMachine);
  const label = `${providerName(l, channel.provider)} ${channel.handle ? `@${channel.handle}` : channel.display_name}`;
  const active = error instanceof ApiError && problemCode(error) === 'CHANNEL_HAS_ACTIVE_JOBS' ? (asRecord(asRecord(error.problem).details).post_ids as string[] | undefined) ?? [] : null;
  return <div className="hub-tools">
    <div className="vs-actions">
      <button type="button" className="vs-btn" disabled={!!pending || !channel.machine} onClick={() => void run('check', async () => {
        await write('POST', `/hub/channels/${id}/check`, {}); return fill(l(hub.channels.checkStarted), { machine });
      })}>{l(hub.channels.checkLogin)}</button>
      <button type="button" className="vs-btn" disabled={!!pending || !channel.machine} onClick={() => void run('relogin', async () =>
        reloginMessage(l, await requestRelogin(write, channel.channel_id), { machine, channel: label }))}>{l(RELOGIN.button)}</button>
      <button type="button" className="vs-btn" aria-expanded={binding} onClick={() => setBinding(!binding)}>{l(hub.channels.bind)}</button>
    </div>
    {channel.machine && ['login_required', 'identity_mismatch', 'challenge'].includes(channel.login.state) && <p className="hub-callout critical">
      {tr(l, loginText, channel.login.state)}：{fill(l(RELOGIN.hint), { machine })}</p>}
    {binding && <form className="hub-panel" onSubmit={(event: FormEvent) => { event.preventDefault(); void run('bind', async () => {
      await write('PUT', `/hub/channels/${id}/machine`, { device_id: device, owned_account_confirmed: true }); setBinding(false); return l(hub.action.done);
    }); }}>
      <h3>{l(hub.channels.bindTitle)}</h3>
      <p>{l(hub.channels.bindHint)}</p>
      <label className="hub-field">{l(hub.common.machine)}<select required value={device} onChange={event => setDevice(event.target.value)}>
        <option value="" disabled>—</option>
        {(machines.value ?? []).filter(item => item.machine_id !== channel.machine?.id).map(item => <option key={item.machine_id} value={item.machine_id}>{item.name}{item.online ? '' : ` (${l(hub.common.offline)})`}</option>)}
      </select></label>
      <label className="hub-check"><input type="checkbox" checked={owned} onChange={event => setOwned(event.target.checked)} />{l(hub.channels.ownedConfirm)}</label>
      <div className="vs-actions"><button className="vs-btn primary-soft" type="submit" disabled={!device || !owned || pending === 'bind'}>{l(hub.action.confirm)}</button></div>
    </form>}
    {active && <div className="hub-callout critical"><p>{l(hub.channels.bindActive)}</p>
      <ul>{active.map(postId => <li key={postId}><RouterLink to={`${base}/posts/${encodeURIComponent(postId)}`}>{l(hub.common.openPost)} {postId.slice(0, 8)}</RouterLink></li>)}</ul></div>}
    {message && <p className="vs-notice good" role="status">{message}</p>}
    {!active && <WriteError error={error} />}
  </div>;
}

function NoticeSection({ channel }: { channel: ChannelDetail }) {
  const { l, lang } = useText();
  const { write, pending, error, message, run } = useAction();
  const notice = channel.automation_notice;
  const current = notice.ack?.version === notice.version;
  return <Section title={l(hub.channels.notice)}>
    <p className="hub-terms">{lang === 'en' ? notice.en : notice.zh_hant}</p>
    {current ? <p className="muted">{l(hub.channels.noticeDone)}{localLabel(isoLocal(notice.ack!.at, channel.timezone), todayIn(channel.timezone), lang)} · {notice.ack!.via === 'worker_app' ? 'SmartSell Worker' : 'Web'}</p>
      : <button type="button" className="vs-btn primary-soft" disabled={!!pending} onClick={() => void run('notice', async () => {
        await write('POST', `/hub/channels/${encodeURIComponent(channel.channel_id)}/automation-notice`, { version: notice.version }); return l(hub.action.done);
      })}>{l(hub.channels.noticeAck)}</button>}
    {message && <p className="vs-notice good" role="status">{message}</p>}
    <WriteError error={error} />
  </Section>;
}

function RiskSection({ channel }: { channel: ChannelDetail }) {
  const { l, lang } = useText();
  const { write, pending, error, message, run } = useAction();
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState('');
  if (!channel.risk_ack_required || !channel.risk_terms) return null;
  const terms = channel.risk_terms;
  const ack = channel.risk_ack;
  const handle = channel.handle ? `@${channel.handle}` : '';
  const id = encodeURIComponent(channel.channel_id);
  return <Section title={l(hub.channels.risk)}>
    <p className="hub-terms">{lang === 'en' ? terms.en : terms.zh_hant}</p>
    <p className={channel.risk_ack_current ? 'hub-ok-text' : 'hub-alert-text'}>{channel.risk_ack_current ? fill(l(hub.channels.riskAccepted), { at: localLabel(isoLocal(ack!.at, channel.timezone), todayIn(channel.timezone), lang) })
      : ack ? l(hub.channels.riskOutdated) : l(hub.channels.riskNone)}</p>
    {channel.risk_ack_current ? <>
      <p className="muted hub-small">{l(hub.channels.riskWithdrawHint)}</p>
      <button type="button" className="vs-btn ghost" disabled={!!pending} onClick={() => void run('clear', async () => { await write('DELETE', `/hub/channels/${id}/risk-ack`); return l(hub.action.done); })}>{l(hub.channels.riskWithdraw)}</button>
    </> : !channel.handle ? <p className="hub-callout warn">{l(hub.channels.riskNeedsHandle)}</p> : <form className="hub-panel" onSubmit={(event: FormEvent) => { event.preventDefault(); void run('ack', async () => {
      await write('POST', `/hub/channels/${id}/risk-ack`, { terms_version: terms.version, typed_handle: typed.trim() }); return l(hub.action.done);
    }); }}>
      <label className="hub-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />{l(hub.channels.riskCheck)}</label>
      <label className="hub-field">{fill(l(hub.channels.riskType), { handle })}<input value={typed} autoComplete="off" spellCheck={false} placeholder={handle} onChange={event => setTyped(event.target.value)} /></label>
      <div className="vs-actions"><button type="submit" className="vs-btn primary-soft" disabled={!checked || typed.trim().replace(/^@/, '').toLowerCase() !== channel.handle.toLowerCase() || !!pending}>{l(hub.channels.riskAccept)}</button></div>
    </form>}
    {message && <p className="vs-notice good" role="status">{message}</p>}
    <WriteError error={error} />
  </Section>;
}

function PauseSection({ channel }: { channel: ChannelDetail }) {
  const { l, lang } = useText();
  const { write, pending, error, message, run } = useAction();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const pause = channel.pause;
  return <Section title={l(hub.channels.pause)}>
    {pause ? <div className="hub-callout warn"><p>{fill(l(hub.channels.pausedBy), {
      scope: l(hub.channels[`scope_${pause.scope}`]), at: localLabel(isoLocal(pause.at, channel.timezone), todayIn(channel.timezone), lang),
      by: pause.by === 'agent' ? l(hub.channels.by_agent) : l(hub.channels.by_person), reason: pause.reason || '—' })}</p>
      <RouterLink to={pause.resume_web_url.replace(/^https?:\/\/[^/]+/, '')} className="vs-btn">{l(hub.channels.resumeLink)}</RouterLink></div>
      : <><p className="muted">{l(hub.channels.notPaused)}</p>
        {!open ? <button type="button" className="vs-btn ghost" onClick={() => setOpen(true)}>{l(hub.channels.pauseThis)}</button>
          : <form className="hub-panel" onSubmit={(event: FormEvent) => { event.preventDefault(); void run('pause', async () => {
            await write('POST', '/hub/pause', { scope: 'channel', id: channel.channel_id, reason: reason.trim() }); setOpen(false); return l(hub.action.done);
          }); }}>
            <label className="hub-field">{l(hub.machines.pauseReason)}<input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
            <div className="vs-actions"><button className="vs-btn danger" type="submit" disabled={!reason.trim() || !!pending}>{l(hub.channels.pauseThis)}</button></div>
          </form>}</>}
    {message && <p className="vs-notice good" role="status">{message}</p>}
    <WriteError error={error} />
  </Section>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** E42: the IANA zones the browser knows, with the current one first when it is not among them (e.g. 'UTC' on some engines). */
export function timeZones(current: string): string[] {
  let zones: string[] = [];
  try { zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { zones = []; }
  const list = zones.includes('UTC') ? zones : ['UTC', ...zones];
  return current && !list.includes(current) ? [current, ...list] : list;
}

function SettingsForm({ channel }: { channel: ChannelDetail }) {
  const { l } = useText();
  const { write, pending, error, message, run, setError } = useAction();
  const initial = channel.settings;
  const [draft, setDraft] = useState<Settings>(initial);
  useEffect(() => setDraft(initial), [initial.version, initial.id]);  // a newer version from the stream replaces the draft
  const tiktok = channel.provider === 'tiktok';
  const defaults: TikTokDefaults = { ...TIKTOK_DEFAULT, ...draft.platform_defaults.tiktok };
  const window: PublishWindow | null = draft.window;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => { setDraft(current => ({ ...current, [key]: value })); setError(undefined); };
  const setTikTok = (patch: Partial<TikTokDefaults>) => set('platform_defaults', { ...draft.platform_defaults, tiktok: { ...defaults, ...patch } });
  const fields = (['execution_mode', 'approval_mode', 'daily_cap', 'window', 'timezone', 'lateness_limit_min', 'caption_limit', 'platform_defaults'] as const)
    .filter(key => !same(draft[key], initial[key]) || (key === 'approval_mode' && !initial.approval_mode_confirmed_at));
  async function save(event: FormEvent) {
    event.preventDefault();
    await run('save', async () => {
      const body = Object.fromEntries(fields.map(key => [key, draft[key]]));
      const result = asRecord((await write('PATCH', `/hub/channels/${encodeURIComponent(channel.channel_id)}/settings`, body, { version: initial.version })).data);
      const requeued = Number(result.requeued_posts ?? 0);
      const offline = channel.machine && !channel.machine.online ? ` ${fill(l(hub.channels.savedOffline), { machine: channel.machine.name })}` : '';
      return `${fill(l(hub.channels.saved), { n: requeued })}${offline}`;
    });
  }
  const conflict = error instanceof ApiError && (error.status === 409 || error.status === 412) && ['VERSION_CONFLICT', 'SETTINGS_VERSION_CONFLICT'].includes(problemCode(error));
  return <form className="hub-settings" onSubmit={event => void save(event)}>
    <Section title={l(hub.channels.publishing)}>
      <fieldset className="hub-radios"><legend>{l(hub.channels.mode)}</legend>
        <label><input type="radio" name="execution" checked={draft.execution_mode !== 'browser_assist'} onChange={() => set('execution_mode', 'browser_auto')} />{l(hub.channels.executionAuto)}</label>
        <label><input type="radio" name="execution" checked={draft.execution_mode === 'browser_assist'} onChange={() => set('execution_mode', 'browser_assist')} />{l(hub.channels.executionAssist)}</label>
        {draft.execution_mode !== 'browser_assist' && !channel.risk_ack_current && channel.risk_ack_required && <p className="muted hub-small">{l(hub.channels.riskNone)}</p>}
      </fieldset>
      <fieldset className="hub-radios"><legend>{l(hub.channels.approval)}</legend>
        <label><input type="radio" name="approval" checked={draft.approval_mode === 'direct'} onChange={() => set('approval_mode', 'direct')} />{tr(l, approvalModeText, 'direct')}</label>
        <label><input type="radio" name="approval" checked={draft.approval_mode === 'needs_approval'} onChange={() => set('approval_mode', 'needs_approval')} />{tr(l, approvalModeText, 'needs_approval')}
          <small className="muted">{l(hub.channels.approvalHint)}</small></label>
      </fieldset>
    </Section>
    <Section title={l(hub.channels.limits)}>
      <div className="hub-form-grid">
        <label className="hub-field">{l(hub.channels.dailyCap)}<input type="number" min={1} max={50} required value={draft.daily_cap} onChange={event => set('daily_cap', Number(event.target.value))} /></label>
        {/* E38: at least 2 minutes (the hub answers 422 below 2). */}
        <label className="hub-field">{l(hub.channels.lateness)}<input type="number" min={2} max={240} required value={draft.lateness_limit_min} onChange={event => set('lateness_limit_min', Number(event.target.value))} />
          <small className="muted">{l(hub.channels.latenessHint)}</small></label>
        {channel.provider === 'x' && <label className="hub-field">{l(hub.channels.captionLimit)}<select value={draft.caption_limit === 25000 ? '25000' : ''} onChange={event => set('caption_limit', event.target.value ? 25000 : null)}>
          <option value="">{l(hub.channels.captionDefault)} (280)</option><option value="25000">{l(hub.channels.xPremium)}</option></select></label>}
      </div>
      {/* E42: the channel's own zone, sent with the same settings PATCH (If-Match). */}
      <label className="hub-field">{l(hub.channels.timezone)}<select value={draft.timezone} onChange={event => set('timezone', event.target.value)}>
        {timeZones(draft.timezone).map(zone => <option key={zone} value={zone}>{zone}</option>)}</select>
        <small className="muted">{l(hub.channels.timezoneHint)}</small></label>
      <fieldset className="hub-window"><legend>{l(hub.channels.window)} <small className="muted">({draft.timezone})</small></legend>
        <label className="hub-check"><input type="checkbox" checked={!window} onChange={event => set('window', event.target.checked ? null : { start: '09:00', end: '21:00', days: [1, 2, 3, 4, 5, 6, 7] })} />{l(hub.channels.windowAny)}</label>
        {window && <div className="hub-form-grid">
          <label className="hub-field">{l(hub.channels.windowFrom)}<input type="time" required value={window.start} onChange={event => set('window', { ...window, start: event.target.value })} /></label>
          <label className="hub-field">{l(hub.channels.windowTo)}<input type="time" required value={window.end} onChange={event => set('window', { ...window, end: event.target.value })} /></label>
          <div className="hub-days" role="group" aria-label={l(hub.channels.days)}>{DAYS.map(([day, label]) => <label key={day} className="hub-day">
            <input type="checkbox" checked={window.days.includes(day)} onChange={event => set('window', { ...window, days: event.target.checked ? [...window.days, day].sort() : window.days.filter(item => item !== day) })} />{l(label)}</label>)}</div>
        </div>}
      </fieldset>
    </Section>
    <Section title={l(hub.channels.defaults)}>
      {tiktok ? <div className="hub-form-grid">
        <label className="hub-field">{l(hub.channels.privacy)}<select value={defaults.privacy_level} onChange={event => setTikTok({ privacy_level: event.target.value as TikTokDefaults['privacy_level'] })}>
          {PRIVACY.map(([value, label]) => <option key={value} value={value}>{l(label)}</option>)}</select></label>
        <label className="hub-field">{l(hub.channels.commercial)}<select value={defaults.commercial_disclosure} onChange={event => setTikTok({ commercial_disclosure: event.target.value as TikTokDefaults['commercial_disclosure'] })}>
          {COMMERCIAL.map(([value, label]) => <option key={value} value={value}>{l(label)}</option>)}</select></label>
        <label className="hub-check"><input type="checkbox" checked={defaults.allow_comment} onChange={event => setTikTok({ allow_comment: event.target.checked })} />{l(hub.channels.allowComment)}</label>
        <label className="hub-check"><input type="checkbox" checked={defaults.allow_duet && defaults.allow_stitch} onChange={event => setTikTok({ allow_duet: event.target.checked, allow_stitch: event.target.checked })} />{l(hub.channels.allowReuse)}</label>
        <label className="hub-check"><input type="checkbox" checked={defaults.ai_generated} onChange={event => setTikTok({ ai_generated: event.target.checked })} />{l(hub.channels.aiGenerated)}</label>
        {!channel.readiness.defaults_ready && <p className="hub-alert-text hub-span">{l(hub.channels.defaults_ready)} — {l(hub.common.no)}</p>}
      </div> : channel.provider === 'x' ? <label className="hub-field">{l(hub.channels.replySettings)}<select value={draft.platform_defaults.x?.reply_settings ?? 'everyone'}
        onChange={event => set('platform_defaults', { ...draft.platform_defaults, x: { reply_settings: event.target.value as 'everyone' } })}>
        {REPLY.map(([value, label]) => <option key={value} value={value}>{l(label)}</option>)}</select></label> : null}
    </Section>
    <div className="hub-savebar">
      <button type="submit" className="vs-btn primary-soft" disabled={!fields.length || pending === 'save'}>{pending === 'save' ? l(hub.common.saving) : l(hub.common.save)}</button>
      {message && <p className="vs-notice good" role="status">{message}</p>}
      {conflict ? <p className="vs-notice" role="alert">{l(hub.channels.conflict)}</p> : <WriteError error={error} />}
    </div>
  </form>;
}

function DryRun({ channel }: { channel: ChannelDetail }) {
  const { l } = useText();
  const { write, pending, error, message, run } = useAction();
  const media = useView<MediaRecentItem[]>('/views/media/recent');
  const [mediaId, setMediaId] = useState('');
  const today = todayIn(channel.timezone);
  return <Section title={l(hub.channels.dryRun)}>
    <p>{l(hub.channels.dryRunHint)}</p>
    <div className="hub-form-grid">
      <label className="hub-field">{l(hub.channels.dryRunMedia)}<select value={mediaId} onChange={event => setMediaId(event.target.value)}>
        <option value="">{l(hub.channels.dryRunBuiltIn)}</option>
        {(media.value ?? []).filter(item => item.status === 'ready' && (channel.provider !== 'tiktok' || item.kind === 'video')).map(item => <option key={item.media_id} value={item.media_id}>{item.filename}</option>)}
      </select></label>
    </div>
    <div className="vs-actions"><button type="button" className="vs-btn primary-soft" disabled={!channel.machine || !!pending} onClick={() => void run('dry', async () => {
      await write('POST', `/hub/channels/${encodeURIComponent(channel.channel_id)}/dry-run`, mediaId ? { media_id: mediaId } : {});
      return fill(l(hub.channels.dryRunStarted), { machine: channel.machine?.name ?? '' });
    })}>{l(hub.channels.dryRunStart)}</button></div>
    {message && <p className="vs-notice good" role="status">{message}</p>}
    <WriteError error={error} />
    <h3 className="vs-subhead">{l(hub.channels.dryRuns)}</h3>
    <JobRows jobs={channel.dry_runs} today={today} zone={channel.timezone} empty="—" />
    <h3 className="vs-subhead">{l(hub.channels.checks)}</h3>
    <JobRows jobs={channel.checks} today={today} zone={channel.timezone} empty="—" />
  </Section>;
}

/** /app/:ws/channels/:id — readiness, notice, posting mode, risk acknowledgement, pause, limits, defaults, dry run, posts (§9.4). */
export function ChannelPage() {
  const { id = '' } = useParams();
  const { l, lang } = useText();
  const { base } = useViewContext();
  const read = useView<ChannelDetail>(`/views/channels/${encodeURIComponent(id)}`);
  const channel = read.value?.channel_id === id ? read.value : undefined;
  // WV-6: every time on this page is in the channel's own zone (its posting window and daily cap use it); the subtitle names it.
  const today = todayIn(channel?.timezone);
  return <>
    <PageHeader title={channel ? `${channel.handle ? `@${channel.handle}` : channel.display_name}` : l(hub.channels.title)}
      subtitle={channel ? `${channel.display_name} · ${channel.timezone}` : undefined} asOf={read.asOf}>
      {channel && <><ChannelName provider={channel.provider} handle={null} /><LoginBadge state={channel.login.state} /><ModeBadge mode={channel.effective_mode} /></>}
    </PageHeader>
    <Loaded read={read}>{channel => <div className="hub-detail">
      <section className="vs-card">
        <dl className="hub-facts">
          <div><dt>{l(hub.common.machine)}</dt><dd>{channel.machine ? <><RouterLink to={`${base}/machines/${encodeURIComponent(channel.machine.id)}`}>{channel.machine.name}</RouterLink> <OnlineBadge online={channel.machine.online} /></> : l(hub.channels.noMachine)}</dd></div>
          <div><dt>{l(hub.channels.login)}</dt><dd><LoginBadge state={channel.login.state} />{channel.login.checked_at && <small className="muted"> · {localLabel(isoLocal(channel.login.checked_at, channel.timezone), today, lang)}</small>}</dd></div>
          <div><dt>{l(hub.channels.today)}</dt><dd>{channel.scheduled_today + channel.published_today} / {channel.daily_cap}</dd></div>
          <div><dt>{l(hub.channels.next)}</dt><dd>{channel.next_post ? <RouterLink to={`${base}/posts/${encodeURIComponent(channel.next_post.post_id)}`}>{localLabel(isoLocal(channel.next_post.scheduled_at, channel.timezone) ?? channel.next_post.local_time, today, lang)}</RouterLink> : '—'}</dd></div>
        </dl>
        <HeaderTools channel={channel} />
      </section>
      {channel.blockers.length > 0 && <div className="hub-callout critical" role="note"><ul>{channel.blockers.map(blocker => <li key={blocker.code}>{blocker.message}</li>)}</ul></div>}
      <div className="vs-columns">
        <Section title={l(hub.channels.checklist)}><Readiness channel={channel} /></Section>
        <NoticeSection channel={channel} />
      </div>
      <RiskSection channel={channel} />
      <SettingsForm channel={channel} />
      <PauseSection channel={channel} />
      <DryRun channel={channel} />
      <Section title={l(hub.channels.posts)}>
        {channel.posts.length ? <ul className="hub-rows">{channel.posts.map(post => <li key={post.post_id}>
          <RouterLink to={`${base}/posts/${encodeURIComponent(post.post_id)}`} className="hub-row">
            <span className="hub-row-time">{localLabel(isoLocal(post.scheduled_at, channel.timezone) ?? post.local_time, today, lang)}</span>
            <span className="hub-row-main"><span>{post.caption_excerpt || l(hub.common.noCaption)}</span><small className="muted">{post.machine?.name ?? l(hub.common.manual)}</small></span>
            <span className="hub-row-tags"><PostStatusBadge status={post.status} />{pauseOf(post) && <Badge tone="warning">{l(hub.common.paused)}</Badge>}</span>
          </RouterLink></li>)}</ul> : <Empty>{l(hub.channels.noPosts)}</Empty>}
      </Section>
      <p className="muted hub-small"><Badge tone="neutral">{channel.settings.chrome_profile_key}</Badge> {l(hub.machines.profile)}</p>
    </div>}</Loaded>
  </>;
}
