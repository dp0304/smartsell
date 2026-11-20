import { useState, type FormEvent, type ReactNode } from 'react';
import { ActorBadge, Busy, Glyph, StatusChip, formatDateTime, relativeTime, type Lang } from '@smartsell/ui';
import { fill } from '../copy';
import { useView, useViewContext, type ViewResult } from '../data/use-view';
import { Loaded, RouterLink, Section, useText } from '../parts';
import { can, heldBy, pauseBody, platformText, splitPauses, type PauseScope, type PauseSwitch, type Row } from './settings-logic';
import { Dialog, Field, WriteProblem, useSettingsWrite, useStableKey } from './settings-parts';
import { text } from './settings-text';

const quote = (name: string, lang: Lang) => lang === 'en' ? `“${name}”` : `「${name}」`;
const name = (row: Row | undefined) => row ? String(row.display_name ?? row.name ?? row.id) : undefined;

function useScopeLabel(brands: readonly Row[], accounts: readonly Row[]) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  return (row: PauseSwitch): ReactNode => {
    const id = String(row.scope_id ?? '');
    switch (row.scope_type) {
      case 'workspace': return l(text.scopeWorkspace);
      case 'brand': return <>{l(text.scopeBrand)} {quote(name(brands.find(brand => brand.id === id)) ?? id, lang)}</>;
      case 'social_account': {
        const account = accounts.find(item => item.id === id);
        const platform = account && platformText[String(account.provider)];
        return <>{l(text.scopeAccount)} {quote(name(account) ?? id, lang)}{platform && <> · {l(platform)}</>}</>;
      }
      case 'campaign': return <>{l(text.scopeCampaign)} <RouterLink to={`${base}/plans/${encodeURIComponent(id)}`}>{id.slice(0, 8)}</RouterLink></>;
      default: return <>{l(text.scopeOther)} {row.scope_type ?? ''}</>;
    }
  };
}

export function PauseForm({ brands, accounts, active, onDone, onBusy }: {
  brands: readonly Row[]; accounts: readonly Row[]; active: readonly PauseSwitch[]; onDone: () => void; onBusy: (busy: boolean) => void;
}) {
  const { l } = useText();
  const write = useSettingsWrite();
  const key = useStableKey();
  const [scope, setScope] = useState<PauseScope>('workspace');
  const [scopeId, setScopeId] = useState('');
  const [reason, setReason] = useState('');
  const [unschedule, setUnschedule] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [incomplete, setIncomplete] = useState(false);
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); key.reset(); setError(undefined); setIncomplete(false); };
  const draft = { scope_type: scope, scope_id: scopeId, reason, unschedule };
  const result = pauseBody(draft);
  const same = active.some(row => row.scope_type === scope && (scope === 'workspace' || row.scope_id === scopeId));
  const options = scope === 'brand' ? brands.filter(row => row.status !== 'archived').map(row => ({ id: String(row.id), label: name(row)! }))
    : scope === 'social_account' ? accounts.filter(row => row.status !== 'disabled').map(row => ({ id: String(row.id), label: `${name(row)} · ${l(platformText[String(row.provider)] ?? [String(row.provider), String(row.provider)])}` })) : [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if ('missing' in result) { setIncomplete(true); return; }
    if (pending || same) return;
    setPending(true); onBusy(true); setError(undefined);
    try { await write('POST', '/pause-switches', { body: result.body, key: key.take() }); key.reset(); onDone(); }
    catch (failure) { setError(failure); }
    finally { setPending(false); onBusy(false); }
  }
  const scopes: [PauseScope, string][] = [['workspace', l(text.scopeWorkspace)], ['brand', l(text.scopeBrand)], ['social_account', l(text.scopeAccount)]];
  return <form className="vs-form st-form" onSubmit={submit}><fieldset disabled={pending}>
    <fieldset className="st-radios"><legend>{l(text.pauseScope)}</legend>
      {scopes.map(([value, label]) => <label key={value} className="st-radio"><input type="radio" name="scope_type" value={value} checked={scope === value}
        onChange={() => { edit(setScope)(value); setScopeId(''); }} />{label}</label>)}
    </fieldset>
    {scope !== 'workspace' && <Field label={l(scope === 'brand' ? text.pickBrand : text.pickAccount)} required>
      <select required value={scopeId} onChange={event => edit(setScopeId)(event.target.value)}>
        <option value="">—</option>{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></Field>}
    <Field label={l(text.reason)} hint={l(text.reasonHint)} required>
      <textarea required rows={3} maxLength={1000} value={reason} placeholder={l(text.reasonPlaceholder)} onChange={event => edit(setReason)(event.target.value)} /></Field>
    <label className="st-check-field"><input type="checkbox" checked={unschedule} onChange={event => edit(setUnschedule)(event.target.checked)} />
      <span>{l(text.unschedule)}<small className="muted">{l(text.unscheduleHint)}</small></span></label>
    {incomplete && <p className="vs-notice warning" role="alert">{l(text.fillRequired)}</p>}
    {same ? <p className="vs-notice" role="status">{l(text.pauseSame)}</p> : <p className="vs-notice warning">{l(text.pauseWarning)}</p>}
    <div className="vs-actions"><button type="submit" className="vs-btn danger" disabled={same}>
      <Glyph name="critical" />{l(pending ? text.pausing : text.pauseSubmit)}</button></div>
  </fieldset>{error !== undefined && <WriteProblem error={error} />}</form>;
}

function HeldLine({ targets, pause }: { targets: ViewResult<Row[]>; pause: PauseSwitch }) {
  const { l } = useText();
  if (targets.isPending) return <small className="muted">{l(text.loadingShort)}…</small>;
  if (!Array.isArray(targets.value)) return <small className="muted">{l(text.heldUnknown)}</small>;
  const { held, missed } = heldBy(targets.value, pause.id);
  if (targets.nextCursor) return <small>{fill(l(text.heldAtLeast), { n: held })}</small>;
  if (!held) return <small className="muted">{l(text.heldNone)}</small>;
  return <small>{fill(l(text.held), { n: held })}{missed > 0 && <> · {fill(l(text.heldMissed), { n: missed })}</>}</small>;
}

function ActivePause({ pause, label, targets, role, timeZone, onReleased }: {
  pause: PauseSwitch; label: ReactNode; targets: ViewResult<Row[]>; role?: string; timeZone?: string; onReleased: () => void;
}) {
  const { l, lang } = useText();
  const { session } = useViewContext();
  const write = useSettingsWrite();
  const key = useStableKey();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const counts = Array.isArray(targets.value) && !targets.nextCursor ? heldBy(targets.value, pause.id) : undefined;
  async function release() {
    setPending(true); setError(undefined);
    // No If-Match: a stale one currently fails as a 500; the server already refuses a second release with 409.
    try { await write('POST', `/pause-switches/${encodeURIComponent(pause.id)}/release`, { body: {}, key: key.take() }); key.reset(); onReleased(); }
    catch (failure) { setError(failure); }
    finally { setPending(false); }
  }
  const self = pause.activated_by && pause.activated_by === session.user.id;
  return <li className="st-pause">
    <div className="vs-row-head"><strong>{label}</strong><StatusChip status="paused" /></div>
    {pause.reason && <p className="st-reason"><span className="vs-sr">{l(text.reason)}: </span>{pause.reason}</p>}
    <small className="muted st-meta">
      {pause.activated_at && <span>{l(text.pausedAt)} <time dateTime={pause.activated_at} title={formatDateTime(pause.activated_at, lang, timeZone)}>{relativeTime(pause.activated_at, lang)}</time></span>}
      {(pause.created_via === 'agent' || pause.created_via === 'human') && <span>{l(text.pausedBy)} <ActorBadge type={pause.created_via} label={pause.created_via === 'human' && self ? l(text.youShort) : undefined} /></span>}
      {pause.mode === 'hold_and_unschedule' && <span>{l(text.modeUnschedule)}</span>}
    </small>
    <HeldLine targets={targets} pause={pause} />
    {!can('release', role) ? <small className="muted">{l(text.releaseNotAllowed)}</small> : confirming ? <div className="st-confirm" role="group" aria-label={l(text.release)}>
      <p>{counts && counts.held > 0 ? fill(l(text.releaseImpact), { n: counts.held }) : l(text.releaseImpactNone)}
        {counts && counts.missed > 0 && <> {fill(l(text.releaseMissed), { n: counts.missed })}</>}</p>
      <div className="vs-actions">
        <button type="button" className="vs-btn primary-soft" disabled={pending} onClick={() => void release()}>{l(pending ? text.releasing : text.releaseConfirm)}</button>
        <button type="button" className="vs-btn ghost" disabled={pending} onClick={() => { setConfirming(false); setError(undefined); }}>{l(text.cancel)}</button>
      </div>
    </div> : <div className="vs-actions"><button type="button" className="vs-btn" onClick={() => setConfirming(true)}>{l(text.release)}</button></div>}
    {error !== undefined && <WriteProblem error={error} />}
  </li>;
}

export function PauseSection({ pauses, brands, accounts, role, timeZone }: {
  pauses: ViewResult<PauseSwitch[]>; brands: readonly Row[]; accounts: readonly Row[]; role?: string; timeZone?: string;
}) {
  const { l, lang } = useText();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'paused' | 'released'>();
  const { active, released } = splitPauses(pauses.value);
  const targets = useView<Row[]>('/publish-targets', { status: 'paused', limit: '200' }, { enabled: active.length > 0 });
  const scopeLabel = useScopeLabel(brands, accounts);
  const workspaceWide = active.some(row => row.scope_type === 'workspace');
  const pauseButton = can('pause', role)
    ? <button type="button" className={`vs-btn ${active.length ? '' : 'danger'}`} onClick={() => { setOpen(true); setNotice(undefined); }}>{l(active.length ? text.pauseMore : text.pauseButton)}</button>
    : <small className="muted">{l(text.pauseNotAllowed)}</small>;
  return <Section title={<span id="st-pause">{l(text.pauseTitle)}</span>} className={`vs-span-2 st-pause-card${active.length ? ' is-paused' : ''}`}>
    <Loaded read={pauses}>{() => <div className="st-pause-body">
      {active.length === 0 ? <p className="vs-all-clear st-state"><Glyph name="check" /><span><strong>{l(text.publishingOk)}</strong><br /><small className="muted">{l(text.pauseRunning)}</small></span></p>
        : <p className="st-state is-paused" role="status"><Glyph name="critical" /><strong>{fill(l(text.publishingPaused), { n: active.length })}</strong></p>}
      <p className="muted"><small>{l(text.pauseIntro)}</small></p>
      {notice && <p className="vs-notice good" role="status">{l(notice === 'paused' ? text.paused : text.released)}</p>}
      {active.length > 0 && <><p className="st-lead">{l(text.pauseActive)}</p>
        <ul className="vs-list st-pauses">{active.map(row => <ActivePause key={row.id} pause={row} label={scopeLabel(row)} targets={targets} role={role} timeZone={timeZone}
          onReleased={() => setNotice('released')} />)}</ul></>}
      {!workspaceWide && <div className="vs-actions">{pauseButton}</div>}
      {released.length > 0 && <details className="st-history"><summary>{l(text.history)} ({released.length})</summary>
        <ul className="vs-list">{released.slice(0, 5).map(row => <li key={row.id}><span className="vs-grow">{scopeLabel(row)}
          {row.reason && <><br /><small className="muted">{row.reason}</small></>}</span>
          {row.released_at && <small className="muted">{l(text.releasedAt)} <time dateTime={row.released_at} title={formatDateTime(row.released_at, lang, timeZone)}>{relativeTime(row.released_at, lang)}</time></small>}</li>)}</ul>
      </details>}
    </div>}</Loaded>
    {open && <Dialog title={l(text.pauseDialog)} busy={busy} onClose={() => setOpen(false)}>
      {pauses.isPending ? <Busy label={l(text.loadingShort)} /> : <PauseForm brands={brands} accounts={accounts} active={active} onBusy={setBusy}
        onDone={() => { setOpen(false); setNotice('paused'); }} />}
    </Dialog>}
  </Section>;
}
