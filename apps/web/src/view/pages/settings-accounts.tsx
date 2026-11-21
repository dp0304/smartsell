import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AgentPrompt, StatusChip } from '@smartsell/ui';
import { timeZoneChoices } from '../../option-labels';
import { fill } from '../copy';
import { useViewContext, useViewWrite, type ViewResult } from '../data/use-view';
import { Loaded, Section, useText } from '../parts';
import { accountBody, can, defaultZone, platformText, platforms, type AccountDraft, type Row } from './settings-logic';
import { Dialog, Field, WriteProblem, useStableKey } from './settings-parts';
import { text } from './settings-text';

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };

export function RegisterForm({ brands, markets, initialBrand, workspaceZone, onDone, onBusy }: {
  brands: readonly Row[]; markets: readonly Row[]; initialBrand: string; workspaceZone?: string | null;
  onDone: (name: string) => void; onBusy: (busy: boolean) => void;
}) {
  const { l } = useText();
  const { workspace } = useViewContext();
  const write = useViewWrite();
  const key = useStableKey();
  const zoneFor = (brand: string) => defaultZone(brand, brands, markets, workspaceZone, browserZone());
  const [draft, setDraft] = useState<AccountDraft>({ brand_id: initialBrand, provider: '', display_name: '', external_account_id: '', default_timezone: zoneFor(initialBrand), owned: false });
  const [zoneTouched, setZoneTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [incomplete, setIncomplete] = useState(false);
  const set = <K extends keyof AccountDraft>(field: K, value: AccountDraft[K]) => {
    key.reset(); setError(undefined); setIncomplete(false);
    setDraft(current => ({ ...current, [field]: value, ...(field === 'brand_id' && !zoneTouched ? { default_timezone: zoneFor(String(value)) } : {}) }));
  };
  const result = accountBody(draft);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if ('missing' in result) { setIncomplete(true); return; }
    if (pending) return;
    setPending(true); onBusy(true); setError(undefined);
    try { await write('POST', '/social-accounts', result.body, key.take()); key.reset(); onDone(String(result.body.display_name)); }
    catch (failure) { setError(failure); }
    finally { setPending(false); onBusy(false); }
  }
  const zones = timeZoneChoices(draft.default_timezone);
  return <form className="vs-form st-form" onSubmit={submit}><fieldset disabled={pending}>
    <Field label={l(text.brand)} required>
      <select required value={draft.brand_id} onChange={event => set('brand_id', event.target.value)}>
        {brands.length !== 1 && <option value="">—</option>}
        {brands.map(row => <option key={String(row.id)} value={String(row.id)}>{String(row.name ?? row.id)}</option>)}
      </select></Field>
    <div className="vs-field-row">
      <Field label={l(text.platform)} required>
        <select required value={draft.provider} onChange={event => set('provider', event.target.value)}>
          <option value="">{l(text.pickPlatform)}</option>
          {platforms.map(value => <option key={value} value={value}>{l(platformText[value])}</option>)}
        </select></Field>
      <Field label={l(text.timezone)} hint={l(text.timezoneHint)} required>
        <select required value={draft.default_timezone} onChange={event => { setZoneTouched(true); set('default_timezone', event.target.value); }}>
          {zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
        </select></Field>
    </div>
    <Field label={l(text.displayName)} hint={l(text.displayNameHint)} required>
      <input required maxLength={256} value={draft.display_name} autoComplete="off" onChange={event => set('display_name', event.target.value)} /></Field>
    <Field label={l(text.accountId)} hint={l(text.accountIdHint)} required>
      <input required maxLength={256} value={draft.external_account_id} autoComplete="off" spellCheck={false} inputMode="text" onChange={event => set('external_account_id', event.target.value)} /></Field>
    <label className="st-check-field st-owned"><input type="checkbox" required checked={draft.owned} onChange={event => set('owned', event.target.checked)} />
      <span>{fill(l(text.owned), { workspace: workspace.name })}<small className="muted">{l(text.ownedHint)}</small></span></label>
    {incomplete && <p className="vs-notice warning" role="alert">{l(text.fillRequired)}</p>}
    <div className="vs-actions"><button type="submit" className="vs-btn primary-soft">{l(pending ? text.registering : text.registerSubmit)}</button></div>
  </fieldset>{error !== undefined && <WriteProblem error={error} />}</form>;
}

export function AccountsSection({ accounts, brands, brandsLoaded, markets, role, brandId, workspaceZone, pausedAccounts }: {
  accounts: ViewResult<Row[]>; brands: readonly Row[]; brandsLoaded: boolean; markets: readonly Row[]; role?: string; brandId?: string;
  workspaceZone?: string | null; pausedAccounts: ReadonlySet<string>;
}) {
  const { l } = useText();
  const { ws, base } = useViewContext();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<string>();
  const usable = brands.filter(row => row.status === undefined || row.status === 'active');
  const initialBrand = usable.some(row => row.id === brandId) ? String(brandId) : usable.length === 1 ? String(usable[0].id) : '';
  const brandName = (id: unknown) => { const brand = brands.find(row => row.id === id); return brand ? String(brand.name ?? brand.id) : undefined; };
  const action = !can('register', role) ? undefined : usable.length
    ? <button type="button" className="vs-btn primary-soft" onClick={() => { setOpen(true); setRegistered(undefined); }}>{l(text.register)}</button> : undefined;
  return <Section title={<span id="st-accounts">{l(text.accountsTitle)}</span>} action={action}>
    <p className="muted"><small>{l(text.accountsHint)}</small></p>
    {!can('register', role) && <p className="muted"><small>{l(text.registerNotAllowed)}</small></p>}
    {registered && <div className="st-registered" role="status">
      <p className="vs-notice good">{fill(l(text.registered), { name: registered })}</p>
      <AgentPrompt title={l(text.nextStep)} prompt={fill(l(text.registeredPrompt), { name: registered })} agentHref={`${base}/agent`} />
    </div>}
    <Loaded read={accounts}>{items => {
      const list = (Array.isArray(items) ? items : []).slice().sort((a, b) => Number(a.status === 'disabled') - Number(b.status === 'disabled') || String(a.display_name ?? '').localeCompare(String(b.display_name ?? '')));
      if (!list.length) return <div className="st-empty">
        <p><strong>{l(text.accountsEmpty)}</strong></p>
        {usable.length === 0 ? brandsLoaded && <p className="muted"><small>{l(text.noBrandForAccount)}</small></p> : can('register', role) &&
          <button type="button" className="vs-btn primary-soft" onClick={() => { setOpen(true); setRegistered(undefined); }}>{l(text.register)}</button>}
      </div>;
      return <ul className="vs-list st-accounts">{list.map(row => {
        const platform = platformText[String(row.provider)];
        const active = row.status === 'active';
        return <li key={String(row.id)}>
          <span className="st-platform" data-provider={String(row.provider ?? '')}>{platform ? l(platform) : String(row.provider ?? '—')}</span>
          <span className="vs-grow"><strong>{String(row.display_name ?? row.id)}</strong><br />
            <small className="muted">{[brandName(row.brand_id), row.external_account_id ? `${l(text.accountId)} ${String(row.external_account_id)}` : undefined, row.default_timezone ? String(row.default_timezone) : undefined].filter(Boolean).join(' · ')}</small></span>
          <span className="st-chips">
            {pausedAccounts.has(String(row.id)) && <StatusChip status="paused" label={text.accountPaused} />}
            <StatusChip status={String(row.status ?? 'unknown')} label={active ? text.accountActive : row.status === 'disabled' ? text.accountDisabled : undefined}
              tone={active ? 'good' : row.status === 'disabled' ? 'neutral' : undefined} />
          </span>
        </li>;
      })}</ul>;
    }}</Loaded>
    <p className="st-foot"><small className="muted">{l(text.authorizeHint)}</small> <Link to={`/w/${encodeURIComponent(ws)}/settings/accounts`}>{l(text.authorize)}</Link></p>
    {open && <Dialog title={l(text.registerDialog)} busy={busy} onClose={() => setOpen(false)}>
      <RegisterForm brands={usable} markets={markets} initialBrand={initialBrand} workspaceZone={workspaceZone} onBusy={setBusy}
        onDone={display => { setOpen(false); setRegistered(display); }} />
    </Dialog>}
  </Section>;
}
