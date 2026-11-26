import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { ExternalLink, Monitor } from 'lucide-react';
import { asRecord } from '@smartsell/sdk';
import { fill } from '../copy';
import type { JobSummary, MachineDetail, MachineSummary } from '../data/hub-types';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, PageHeader, RouterLink, Section, useText } from '../parts';
import { blockerText, hub, jobKindText, warningFixFor, warningTitle } from '../hub-copy';
import { warningMessage } from '../attention-text';
import { Badge, ChannelName, Empty, JobStatusBadge, LoginBadge, OnlineBadge, WriteError, ZoneNote, browserZone, isoLocal, localLabel, todayIn, tr, useHubWrite } from '../hub-parts';

const osName = (os: string) => os === 'win32' ? 'Windows' : 'macOS';

function MachineCard({ machine, today }: { machine: MachineSummary; today: string }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const outdated = machine.latest_app_version && machine.app_version && machine.warnings.some(warning => warning.code === 'app_outdated');
  return <article className="hub-card">
    <header><h2><Monitor size={17} aria-hidden="true" /><RouterLink to={`${base}/machines/${encodeURIComponent(machine.machine_id)}`}>{machine.name}</RouterLink></h2>
      <OnlineBadge online={machine.online} paused={machine.paused} /></header>
    <dl className="hub-facts tight">
      <div><dt>{l(hub.machines.os)}</dt><dd>{osName(machine.os)}</dd></div>
      <div><dt>{l(hub.machines.version)}</dt><dd>{machine.app_version ?? '—'}{outdated && <Badge tone="warning">{l(hub.machines.outdated)} {machine.latest_app_version}</Badge>}</dd></div>
      <div><dt>{l(hub.common.lastSeen)}</dt><dd>{localLabel(isoLocal(machine.last_seen_at), today, lang) || l(hub.common.never)}</dd></div>
      <div><dt>{l(hub.machines.queue)}</dt><dd>{machine.queue.queued + machine.queue.ready} · {machine.queue.running} {l(hub.machines.running)}{machine.queue.needs_owner > 0 && <> · <strong className="hub-alert-text">{machine.queue.needs_owner} {l(hub.machines.needsOwner)}</strong></>}</dd></div>
      <div><dt>{l(hub.today.nextJob)}</dt><dd>{machine.next_job ? <RouterLink to={machine.next_job.post_id ? `${base}/posts/${encodeURIComponent(machine.next_job.post_id)}` : `${base}/machines/${encodeURIComponent(machine.machine_id)}`}>{localLabel(isoLocal(machine.next_job.at), today, lang)}</RouterLink> : '—'}</dd></div>
      <div><dt>{l(hub.machines.drivers)}</dt><dd>{machine.drivers.length ? machine.drivers.map(driver => <Badge key={driver.provider} tone={driver.health === 'ok' ? 'good' : driver.health === 'outdated' ? 'warning' : 'neutral'}>{driver.version}</Badge>) : '—'}</dd></div>
    </dl>
    <ul className="hub-chip-list">{machine.channels.map(channel => <li key={channel.social_account_id}>
      <RouterLink to={`${base}/channels/${encodeURIComponent(channel.social_account_id)}`}><ChannelName provider={channel.provider} handle={channel.handle} /></RouterLink> <LoginBadge state={channel.login} />
    </li>)}</ul>
    {machine.warnings.length > 0 && <ul className="hub-warnings">{machine.warnings.map(warning => <li key={warning.code}><strong>{tr(l, warningTitle, warning.code)}</strong> {warningMessage(warning, lang)}</li>)}</ul>}
  </article>;
}

export function MachinesPage() {
  const { l } = useText();
  const { base } = useViewContext();
  const read = useView<MachineSummary[]>('/views/machines');
  const today = todayIn();
  return <>
    <PageHeader title={l(hub.machines.title)} subtitle={l(hub.machines.subtitle)} asOf={read.asOf}>
      <ZoneNote zone={browserZone()} />
      <RouterLink to={`${base}/get-started?step=machines`} className="vs-btn primary-soft">{l(hub.machines.pair)}</RouterLink>
    </PageHeader>
    <Loaded read={read}>{machines => machines.length ? <div className="hub-card-grid">{machines.map(machine => <MachineCard key={machine.machine_id} machine={machine} today={today} />)}</div>
      : <section className="vs-card"><Empty action={<RouterLink to={`${base}/get-started?step=machines`} className="vs-btn primary-soft">{l(hub.machines.pair)}</RouterLink>}>{l(hub.machines.empty)}</Empty></section>}</Loaded>
  </>;
}

/** Job rows; each time is the job's instant in `zone` (the page's zone, the same one `today` is computed in, WV-6). */
export function JobRows({ jobs, today, zone, empty }: { jobs: JobSummary[]; today: string; zone?: string; empty: string }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  if (!jobs.length) return <Empty>{empty}</Empty>;
  return <ul className="hub-rows">{jobs.map(job => <li key={job.task_id}>
    <RouterLink to={job.post_id ? `${base}/posts/${encodeURIComponent(job.post_id)}` : job.web_url.replace(/^https?:\/\/[^/]+/, '')} className="hub-row">
      <span className="hub-row-time">{localLabel(isoLocal(job.not_before, zone) ?? job.local_time, today, lang)}</span>
      <span className="hub-row-main"><span>{job.channel_label}</span><small className="muted">{tr(l, jobKindText, job.kind)}{job.dry_run ? ` · ${l(hub.channels.dryRun)}` : ''}{job.blocker ? ` · ${tr(l, blockerText, job.blocker.code)}` : ''}</small></span>
      <span className="hub-row-tags"><JobStatusBadge status={job.status} /></span>
    </RouterLink>
    {job.url && <a className="hub-ext hub-row-ext" href={job.url} target="_blank" rel="noreferrer noopener">{l(hub.common.platformPost)}<ExternalLink size={13} aria-hidden="true" /></a>}
  </li>)}</ul>;
}

/** E41: what POST /hub/machines/:id/retire answered (worker/retire.ts). */
export interface RetireResult {
  machine_id: string; name: string; already_retired: boolean;
  jobs: { waiting_for_machine: number; ended: number; to_confirm: number };
  channels: { social_account_id: string; label: string }[]; posts_to_confirm: string[];
}
export function readRetireResult(data: unknown): RetireResult {
  const row = asRecord(data);
  const jobs = asRecord(row.jobs);
  return { machine_id: String(row.machine_id ?? ''), name: String(row.name ?? ''), already_retired: row.already_retired === true,
    jobs: { waiting_for_machine: Number(jobs.waiting_for_machine) || 0, ended: Number(jobs.ended) || 0, to_confirm: Number(jobs.to_confirm) || 0 },
    channels: (Array.isArray(row.channels) ? row.channels : []).map(asRecord).map(item => ({ social_account_id: String(item.social_account_id ?? ''), label: String(item.label ?? '') })),
    posts_to_confirm: (Array.isArray(row.posts_to_confirm) ? row.posts_to_confirm : []).map(String) };
}

/** E41: after 「撤銷這台機器」 the page says what happened to the machine's posts and which channels must move. */
export function RetiredNotice({ result }: { result: RetireResult }) {
  const { l } = useText();
  const { base } = useViewContext();
  return <section className="vs-card hub-detail" aria-live="polite">
    <p className="vs-notice good" role="status">{fill(l(hub.machines.retired), { machine: result.name })}</p>
    {result.jobs.waiting_for_machine > 0 && <p>{fill(l(hub.machines.retiredWaiting), { n: result.jobs.waiting_for_machine })}</p>}
    {result.posts_to_confirm.length > 0 && <div className="hub-callout critical"><p>{l(hub.machines.retiredConfirm)}</p>
      <ul>{result.posts_to_confirm.map(postId => <li key={postId}><RouterLink to={`${base}/posts/${encodeURIComponent(postId)}`}>{l(hub.common.openPost)} {postId.slice(0, 8)}</RouterLink></li>)}</ul></div>}
    {result.channels.length > 0 && <div className="hub-callout warn"><p>{l(hub.machines.retiredChannels)}</p>
      <ul>{result.channels.map(channel => <li key={channel.social_account_id}><RouterLink to={`${base}/channels/${encodeURIComponent(channel.social_account_id)}`}>{channel.label}</RouterLink> · {l(hub.channels.bind)}</li>)}</ul></div>}
    <p><RouterLink to={`${base}/machines`} className="vs-btn">{l(hub.machines.title)}</RouterLink></p>
  </section>;
}

function MachineHeaderTools({ machine, onRetired }: { machine: MachineDetail; onRetired: (result: RetireResult) => void }) {
  const { l } = useText();
  const write = useHubWrite();
  const [mode, setMode] = useState<'rename' | 'pause' | 'retire' | null>(null);
  const [name, setName] = useState(machine.name);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const id = encodeURIComponent(machine.machine_id);
  async function send(event: FormEvent | null, method: 'PATCH' | 'POST', path: string, body: Record<string, unknown>) {
    event?.preventDefault();
    setPending(true); setError(undefined);
    try { await write(method, path, body); setMode(null); } catch (failure) { setError(failure); } finally { setPending(false); }
  }
  async function retire(event: FormEvent) {
    event.preventDefault();
    setPending(true); setError(undefined);
    try { onRetired(readRetireResult((await write('POST', `/hub/machines/${id}/retire`, { confirm: true })).data)); }
    catch (failure) { setError(failure); } finally { setPending(false); }
  }
  return <div className="hub-tools">
    <div className="vs-actions">
      {machine.remote_url && <a className="vs-btn" href={machine.remote_url}>{l(hub.machines.remote)}</a>}
      <button type="button" className="vs-btn" aria-expanded={mode === 'rename'} onClick={() => setMode(mode === 'rename' ? null : 'rename')}>{l(hub.machines.rename)}</button>
      {machine.paused ? <button type="button" className="vs-btn primary-soft" disabled={pending} onClick={() => void send(null, 'POST', `/hub/machines/${id}/resume`, {})}>{l(hub.machines.resume)}</button>
        : <button type="button" className="vs-btn ghost" aria-expanded={mode === 'pause'} onClick={() => setMode(mode === 'pause' ? null : 'pause')}>{l(hub.machines.pause)}</button>}
      <button type="button" className="vs-btn ghost" aria-expanded={mode === 'retire'} onClick={() => { setMode(mode === 'retire' ? null : 'retire'); setTyped(''); }}>{l(hub.machines.retire)}</button>
    </div>
    {mode === 'retire' && <form className="hub-panel" onSubmit={event => void retire(event)}>
      <p>{fill(l(hub.machines.retireHint), { machine: machine.name })}</p>
      <label className="hub-field">{fill(l(hub.machines.retireType), { machine: machine.name })}
        <input value={typed} autoComplete="off" spellCheck={false} placeholder={machine.name} onChange={event => setTyped(event.target.value)} /></label>
      <div className="vs-actions"><button className="vs-btn danger" type="submit" disabled={pending || typed.trim() !== machine.name}>{l(hub.machines.retireConfirm)}</button>
        <button className="vs-btn ghost" type="button" onClick={() => setMode(null)}>{l(hub.common.close)}</button></div>
    </form>}
    {mode === 'rename' && <form className="hub-panel" onSubmit={event => void send(event, 'PATCH', `/hub/machines/${id}`, { display_name: name.trim() })}>
      <label className="hub-field">{l(hub.machines.rename)}<input required maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
      <p className="muted hub-small">{l(hub.machines.renameHint)}</p>
      <div className="vs-actions"><button className="vs-btn primary-soft" type="submit" disabled={pending}>{l(hub.common.save)}</button></div>
    </form>}
    {mode === 'pause' && <form className="hub-panel" onSubmit={event => void send(event, 'POST', `/hub/machines/${id}/pause`, reason.trim() ? { reason: reason.trim() } : {})}>
      <p>{l(hub.machines.pauseHint)}</p>
      <label className="hub-field">{l(hub.machines.pauseReason)}<input maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="vs-actions"><button className="vs-btn danger" type="submit" disabled={pending}>{l(hub.machines.pause)}</button></div>
    </form>}
    <WriteError error={error} />
  </div>;
}

function CheckLogin({ channelId }: { channelId: string }) {
  const { l } = useText();
  const write = useHubWrite();
  const [state, setState] = useState<'idle' | 'pending' | 'done'>('idle');
  const [error, setError] = useState<unknown>();
  return <><button type="button" className="vs-btn" disabled={state !== 'idle'} onClick={async () => {
    setState('pending'); setError(undefined);
    try { await write('POST', `/hub/channels/${encodeURIComponent(channelId)}/check`, {}); setState('done'); } catch (failure) { setError(failure); setState('idle'); }
  }}>{state === 'done' ? l(hub.action.done) : l(hub.machines.checkLogin)}</button><WriteError error={error} /></>;
}

export function MachinePage() {
  const { id = '' } = useParams();
  const { l, lang } = useText();
  const { base } = useViewContext();
  const read = useView<MachineDetail>(`/views/machines/${encodeURIComponent(id)}`);
  const [retired, setRetired] = useState<RetireResult>();
  const today = todayIn();
  const value = read.value?.machine_id === id ? read.value : undefined;
  return <>
    <PageHeader title={retired?.name ?? value?.name ?? l(hub.machines.title)} subtitle={value ? [osName(value.os), value.posture?.os_version].filter(Boolean).join(' · ') : undefined} asOf={read.asOf}>
      {!retired && <ZoneNote zone={browserZone()} />}
      {value && !retired && <OnlineBadge online={value.online} paused={value.paused} />}
    </PageHeader>
    {retired ? <RetiredNotice result={retired} /> : <Loaded read={read}>{machine => <div className="hub-detail">
      <section className="vs-card">
        <dl className="hub-facts">
          <div><dt>{l(hub.common.lastSeen)}</dt><dd>{localLabel(isoLocal(machine.last_seen_at), today, lang) || l(hub.common.never)}</dd></div>
          <div><dt>{l(hub.machines.version)}</dt><dd>{machine.app_version ?? '—'}{machine.latest_app_version && machine.app_version !== machine.latest_app_version && <> → {machine.latest_app_version}</>}</dd></div>
          <div><dt>{l(hub.machines.clock)}</dt><dd>{machine.clock_offset_ms === null ? '—' : `${Math.round(machine.clock_offset_ms / 1000)} s`}</dd></div>
          <div><dt>{l(hub.machines.paired)}</dt><dd>{localLabel(isoLocal(machine.paired_at), today, lang)}</dd></div>
        </dl>
        <MachineHeaderTools machine={machine} onRetired={setRetired} />
      </section>
      <Section title={l(hub.machines.settings)}>
        {machine.warnings.length ? <ul className="hub-warnings">{machine.warnings.map(warning => <li key={warning.code}>
          <strong>{tr(l, warningTitle, warning.code)}</strong> {warningMessage(warning, lang)}<br /><small className="muted">{l(warningFixFor(warning.code, machine.posture?.os ?? machine.os) ?? [warning.code, warning.code])}</small></li>)}</ul>
          : <p className="muted">{l(hub.machines.noWarnings)}</p>}
      </Section>
      <Section title={l(hub.machines.channels)}>
        {machine.channels.length ? <ul className="hub-rows">{machine.channels.map(channel => <li key={channel.social_account_id} className="hub-row static two">
          <span className="hub-row-main"><RouterLink to={`${base}/channels/${encodeURIComponent(channel.social_account_id)}`}><ChannelName provider={channel.provider} handle={channel.handle} /></RouterLink></span>
          <span className="hub-row-tags"><LoginBadge state={channel.login} /><CheckLogin channelId={channel.social_account_id} /></span>
        </li>)}</ul> : <Empty>{l(hub.machines.noChannels)}</Empty>}
      </Section>
      <Section title={`${l(hub.machines.upcoming)} (${machine.upcoming.length})`}><JobRows jobs={machine.upcoming} today={today} empty={l(hub.machines.noUpcoming)} /></Section>
      <Section title={l(hub.machines.history)}><JobRows jobs={machine.history} today={today} empty={l(hub.machines.noHistory)} /></Section>
      <Section title={l(hub.machines.driver)}>
        <dl className="hub-facts">
          <div><dt>{l(hub.machines.drivers)}</dt><dd>{machine.drivers.length ? machine.drivers.map(driver => <Badge key={driver.provider} tone={driver.health === 'ok' ? 'good' : driver.health === 'outdated' ? 'warning' : 'neutral'}>{driver.version}{driver.step ? ` · ${driver.step}` : ''}</Badge>) : '—'}</dd></div>
          <div><dt>{l(hub.machines.selectors)}</dt><dd>{machine.driver_config_version ?? '—'}</dd></div>
        </dl>
        {machine.last_driver_trace && <><h3 className="vs-subhead">{l(hub.machines.lastTrace)}</h3>
          <ol className="hub-trace">{machine.last_driver_trace.steps.map((step, index) => <li key={index} className={`m-${step.matched}`}><span>{step.step}</span><small className="muted">{step.ms} ms · {step.matched}</small></li>)}</ol></>}
      </Section>
    </div>}</Loaded>}
  </>;
}
