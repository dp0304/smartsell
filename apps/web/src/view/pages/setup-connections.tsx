import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CopyButton, StatusChip, formatDateTime } from '@smartsell/ui';
import { fill } from '../copy';
import { useViewContext, workspaceZone, type ViewResult } from '../data/use-view';
import { Loaded, Section, useText } from '../parts';
import { RegisterForm } from './settings-accounts';
import type { Row } from './settings-logic';
import { Field, WriteProblem } from './settings-parts';
import { text as settings } from './settings-text';
import { setupText as text } from './setup-copy';
import { activeDevices, useSetupWrite, type BrowserSession, type Device } from './setup-data';

export const usableBrands = (brands: Row[] = []) => brands.filter(brand => brand.status === 'active' || brand.status === undefined);

export function BrandForm() {
  const { l } = useText();
  const action = useSetupWrite();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name')).trim();
    if (name) void action.run('POST', '/brands', { name, slug: String(form.get('slug')).trim() });
  }
  return <form className="vs-form" onSubmit={submit} onChange={action.reset}>
    <p>{l(text.noBrand)}</p>
    <fieldset disabled={action.pending}><div className="vs-field-row">
      <Field label={l(text.brandName)} required><input name="name" required maxLength={250} pattern=".*\S.*" /></Field>
      <Field label={l(text.brandSlug)} required><input name="slug" required maxLength={100} pattern="[a-z0-9]+(?:\x2d[a-z0-9]+)*" autoComplete="off" /></Field>
    </div><SaveButton pending={action.pending} label={l(text.createBrand)} /></fieldset>
    {action.error !== undefined && <WriteProblem error={action.error} />}
  </form>;
}

export function SaveButton({ pending, label, disabled }: { pending: boolean; label: string; disabled?: boolean }) {
  const { l } = useText();
  return <div className="vs-actions"><button type="submit" className="vs-btn primary-soft" disabled={disabled}>{pending ? l(text.saving) : label}</button></div>;
}

export function DeviceStatus({ device }: { device?: Device }) {
  if (device && device.status !== 'active') return <StatusChip status={device.status} />;
  if (device?.online === true) return <StatusChip status="connected" label={text.online} />;
  if (device?.online === false && device.last_seen_at) return <StatusChip status="offline" label={text.offline} />;
  return <StatusChip status="unknown" label={text.unverified} />;
}

export function WorkerField({ devices, selected }: { devices: Device[]; selected?: string }) {
  const { l } = useText();
  return <Field label={l(text.fixedWorker)} required>
    <select name="device_id" required defaultValue={devices.some(device => device.id === selected) ? selected : ''}>
      <option value="">{l(text.chooseWorker)}</option>
      {devices.map(device => <option key={device.id} value={device.id}>{device.name} · {l(device.online ? text.online : device.last_seen_at ? text.offline : text.unverified)}</option>)}
    </select>
  </Field>;
}

interface PairingCode { pairing_code: string; expires_at: string }

export function WorkerStep({ devices }: { devices: ViewResult<Device[]> }) {
  const { l, lang } = useText();
  const { ws } = useViewContext();
  const action = useSetupWrite();
  const [code, setCode] = useState<PairingCode>();
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!code) return;
    const timeout = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(code.expires_at) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [code]);
  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!new FormData(event.currentTarget).has('owns')) return;
    const result = await action.run<PairingCode>('POST', '/devices/pairing-codes', { owned_device_confirmed: true });
    if (result) { setExpired(false); setCode(result); }
  }
  const origin = window.location.origin;
  return <>
    <p>{l(text.workerIntro)}</p>
    <dl className="setup-values">
      <dt>{l(text.workspaceId)}</dt><dd><code>{ws}</code><CopyButton text={ws} label={text.copyWorkspace} /></dd>
      <dt>{l(text.service)}</dt><dd><code>{origin}</code><CopyButton text={origin} label={text.copyService} /></dd>
    </dl>
    <form className="vs-form" onSubmit={pair} onChange={action.reset}><fieldset disabled={action.pending}>
      <label className="st-check-field"><input name="owns" type="checkbox" required /><span>{l(text.ownership)}</span></label>
      <SaveButton pending={action.pending} label={l(text.issue)} />
    </fieldset>{action.error !== undefined && <WriteProblem error={action.error} />}</form>
    {code && <div className="vs-notice" role="status">{expired ? l(text.expired) : <>
      <dl className="setup-values"><dt>{l(text.code)}</dt><dd><code>{code.pairing_code}</code><CopyButton text={code.pairing_code} label={text.copyCode} /></dd>
        <dt>{l(text.expires)}</dt><dd><time dateTime={code.expires_at}>{formatDateTime(code.expires_at, lang)}</time></dd></dl>
      <small>{l(text.codeHint)}</small>
    </>}</div>}
    <h3 className="vs-subhead">{l(text.devices)}</h3>
    <Loaded read={devices}>{items => items.length ? <ul className="vs-list">{items.map(device => <li key={device.id}>
      <div className="vs-grow"><strong>{device.name}</strong><br /><small className="muted">{device.platform}{device.last_seen_at && <> · {l(text.lastSeen)} {formatDateTime(device.last_seen_at, lang)}</>}</small></div>
      <DeviceStatus device={device} />
    </li>)}</ul> : <p className="muted">{l(text.noDevices)}</p>}</Loaded>
  </>;
}

function SocialBinding({ account, sessions, devices, sessionsKnown }: { account: Row; sessions: BrowserSession[]; devices: Device[]; sessionsKnown: boolean }) {
  const { l, lang } = useText();
  const { ws } = useViewContext();
  const session = sessions.length === 1 ? sessions[0] : undefined;
  const action = useSetupWrite();
  const candidates = activeDevices(devices);
  const fixed = devices.find(device => device.id === session?.device_id);
  const path = `/social-accounts/${encodeURIComponent(String(account.id))}/execution-binding`;
  function bind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.has('owns') && candidates.some(device => device.id === form.get('device_id'))) void action.run('PUT', path,
      { mode: 'connector', connector_channel: 'browser', device_id: String(form.get('device_id')), owned_account_confirmed: true });
  }
  return <li className="setup-list-item">
    <div className="vs-row-head"><strong>{String(account.display_name ?? account.id)}</strong>
      <StatusChip status={account.status === 'active' ? 'active' : String(account.status)} label={account.status === 'active' ? text.registered : undefined} />
    </div>
    {account.external_account_id != null && <small className="muted">{l(text.platformAccountId)} · {String(account.external_account_id)}</small>}
    {sessions.length > 1 ? <p>{l(text.multipleSessions)} <Link to={`/w/${encodeURIComponent(ws)}/settings/accounts`}>{l(text.advancedAccounts)}</Link></p> : session ? <>
      <div className="vs-row-head"><span>{l(text.dedicatedBrowser)} · {fixed?.name ?? session.device_id}</span>
        <StatusChip status="connected" label={text.bound} />
        <StatusChip status={session.status} label={session.status === 'verified' ? text.verified : session.status === 'pending_identity' ? text.pendingIdentity : undefined} />
        <DeviceStatus device={fixed} />
      </div>
      {session.status === 'verified' && session.verified_at && <small><time dateTime={session.verified_at}>{formatDateTime(session.verified_at, lang)}</time></small>}
      {account.status === 'active' && fixed?.status === 'active' && session.status !== 'verified' && <>
        <p>{l(text.verifyOnWorker)}</p>
        <dl className="setup-values"><dt>{l(text.browserSessionId)}</dt><dd><code>{session.id}</code><CopyButton text={session.id} label={text.copySession} /></dd></dl>
        <div className="vs-actions"><button className="vs-btn" type="button" disabled={action.pending} onClick={() => void action.run('POST', `/browser-sessions/${encodeURIComponent(session.id)}/request-login`, {})}>
          {l(action.pending ? text.requestPending : text.requestLogin)}</button>
          {action.saved && <span role="status">{l(text.loginRequested)}</span>}
        </div>
      </>}
    </> : account.status === 'active' && (!sessionsKnown ? <p className="muted">{l(text.unknownSessions)}</p>
      : candidates.length === 0 ? <p className="muted">{l(text.workerRequired)}</p>
      : <form className="vs-form" onSubmit={bind} onChange={action.reset}><fieldset disabled={action.pending}>
        <WorkerField devices={candidates} />
        <label className="st-check-field"><input name="owns" type="checkbox" required /><span>{l(text.ownedAccount)}</span></label>
        <SaveButton pending={action.pending} label={l(text.bind)} />
      </fieldset></form>)}
    {action.error !== undefined && <WriteProblem error={action.error} />}
  </li>;
}

export function SocialStep({ accounts, sessions, devices, brands }: {
  accounts: ViewResult<Row[]>; sessions: ViewResult<BrowserSession[]>; devices: Device[]; brands: ViewResult<Row[]>;
}) {
  const { l } = useText();
  const { ws } = useViewContext();
  const [registered, setRegistered] = useState<string>();
  const [form, setForm] = useState(0);
  return <>
    <p>{l(text.socialIntro)}</p>
    <Section title={l(settings.register)}><Loaded read={brands}>{items => {
      const usable = usableBrands(items);
      return usable.length ? <RegisterForm key={form} brands={usable} initialBrand={usable.length === 1 ? String(usable[0].id) : ''}
        markets={[]} workspaceZone={workspaceZone(ws)} onDone={name => { setRegistered(name); setForm(value => value + 1); }} onBusy={() => {}} /> : <BrandForm />;
    }}</Loaded>{registered && <p role="status" className="vs-notice good">{fill(l(settings.registered), { name: registered })}</p>}</Section>
    {sessions.isError && <WriteProblem error={sessions.error} />}
    <Loaded read={accounts}>{items => items.length ? <ul className="vs-list">{items.map(account => <SocialBinding key={String(account.id)} account={account}
      sessions={sessions.value?.filter(session => session.social_account_id === account.id) ?? []} sessionsKnown={sessions.isSuccess} devices={devices} />)}</ul>
      : <p className="muted">{l(text.socialEmpty)}</p>}</Loaded>
  </>;
}
