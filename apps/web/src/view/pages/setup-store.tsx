import { useId, useState, type FormEvent } from 'react';
import { StoreMarketSetup } from './setup-store-market';
import { Link } from 'react-router-dom';
import { StatusChip, formatDateTime, type Tuple } from '@smartsell/ui';
import { useViewContext, type ViewResult } from '../data/use-view';
import { Loaded, Section, useText } from '../parts';
import { BrandForm, DeviceStatus, SaveButton, WorkerField, usableBrands } from './setup-connections';
import { setupText as text } from './setup-copy';
import { activeDevices, importPath, useSetupWrite, type CatalogJob, type Device, type Store, type WorkerBinding, type WorkerCatalog } from './setup-data';
import type { Row } from './settings-logic';
import { Field, WriteProblem } from './settings-parts';

const providers = {
  shopify: ['Shopify', 'Shopify'], tiktok_shop: ['TikTok Shop', 'TikTok Shop'], amazon_sp: ['Amazon', 'Amazon'],
  shopee: ['蝦皮購物', 'Shopee', '虾皮购物'], lazada: ['Lazada', 'Lazada'], other: ['其他商城', 'Other storefront'], file_import: ['檔案匯入', 'File import', '文件导入'],
} as const satisfies Record<string, Tuple>;
const jobLabels: Record<string, Tuple> = {
  queued: text.queued, claimed: text.claimed, previewed: text.previewed, imported: text.imported,
  failed: text.failed, expired: text.expiredJob, cancelled: text.cancelled,
};
const inProgress = new Set(['queued', 'claimed', 'previewed']);
const providerLabel = (key: string) => Object.hasOwn(providers, key) ? providers[key as keyof typeof providers] : undefined;
const workerStoreId = /^[a-zA-Z0-9][a-zA-Z0-9_.:\x2f\x7c+\x2d]{0,159}$/;
const hasPortal = (provider: string) => ['shopify', 'tiktok_shop', 'amazon_sp', 'shopee', 'lazada'].includes(provider);

function StoreForm({ brands, onCreated }: { brands: Row[]; onCreated: (store: Store) => void }) {
  const { l, lang } = useText();
  const action = useSetupWrite();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const field = (name: string) => String(form.get(name) ?? '').trim();
    if (!field('name') || !workerStoreId.test(field('external_store_id'))) return;
    const store = await action.run<Store>('POST', '/stores', {
      mode: 'import', provider: field('provider'), name: field('name'), brand_id: field('brand_id'),
      external_store_id: field('external_store_id'), default_currency: field('default_currency').toUpperCase(), default_locale: field('default_locale'),
    });
    if (store) { element.reset(); onCreated(store); }
  }
  return <form className="vs-form" onSubmit={submit} onChange={action.reset}><fieldset disabled={action.pending}>
    <div className="vs-field-row">
      <Field label={l(text.platform)} required><select name="provider" required defaultValue=""><option value="">—</option>
        {Object.entries(providers).map(([id, name]) => <option value={id} key={id}>{l(name)}</option>)}</select></Field>
      <Field label={l(text.brand)} required><select name="brand_id" defaultValue={brands.length === 1 ? String(brands[0].id) : ''} required>
        <option value="">—</option>{brands.map(brand => <option key={String(brand.id)} value={String(brand.id)}>{String(brand.name ?? brand.id)}</option>)}
      </select></Field>
    </div>
    <div className="vs-field-row">
      <Field label={l(text.storeName)} required><input name="name" required maxLength={256} pattern=".*\S.*" /></Field>
      <Field label={l(text.externalId)} hint={l(text.storeIdFormat)} required><input name="external_store_id" required maxLength={160} pattern={workerStoreId.source} spellCheck={false} /></Field>
    </div>
    <div className="vs-field-row">
      <Field label={l(text.currency)} required><input name="default_currency" required pattern="[A-Za-z]{3}" defaultValue="USD" /></Field>
      <Field label={l(text.locale)} required><input name="default_locale" required maxLength={35} defaultValue={lang === 'en' ? 'en-US' : lang === 'zh-Hans' ? 'zh-CN' : 'zh-TW'} /></Field>
    </div>
    <SaveButton pending={action.pending} label={l(text.newStore)} />
  </fieldset>{action.error !== undefined && <WriteProblem error={action.error} />}</form>;
}

function StoreWorkerForm({ store, saved, devices }: { store: Store; saved?: WorkerBinding; devices: Device[] }) {
  const { l } = useText();
  const action = useSetupWrite();
  const [recordedId, setRecordedId] = useState<string>();
  const candidates = activeDevices(devices);
  const path = `/stores/${encodeURIComponent(store.id)}/worker`;
  const existingId = store.external_store_id || saved?.external_store_id || recordedId;
  const canAddId = !existingId && store.status === 'import_only' && !store.connection_id;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const deviceId = String(form.get('device_id'));
    const portal = String(form.get('portal_url') ?? '').trim();
    const externalId = canAddId ? String(form.get('external_store_id') ?? '').trim() : existingId;
    if (!externalId || !workerStoreId.test(externalId) || !candidates.some(device => device.id === deviceId)) return;
    const result = await action.run<WorkerBinding>('PUT', path, {
      device_id: deviceId, external_store_id: externalId, ...(portal && { portal_url: portal }),
    });
    if (canAddId && result) setRecordedId(result.external_store_id);
  }
  if (store.status === 'disabled') return null;
  if (existingId && !workerStoreId.test(existingId)) return <p className="vs-notice">{l(text.storeIdInvalid)}</p>;
  if (!existingId && !canAddId) return <p className="vs-notice">{l(text.storeIdMissing)}</p>;
  if (!candidates.length) return <p className="muted">{l(text.workerRequired)}</p>;
  return <form className="vs-form" onSubmit={submit} onChange={action.reset}><fieldset disabled={action.pending}>
    {canAddId && <>
      <p className="muted">{l(text.storeIdBackfill)}</p>
      <Field label={l(text.existingStoreId)} hint={l(text.storeIdFormat)} required>
        <input name="external_store_id" required maxLength={160} pattern={workerStoreId.source} autoComplete="off" spellCheck={false} />
      </Field>
    </>}
    <div className="vs-field-row">
      <WorkerField devices={candidates} selected={saved?.device_id} />
      {hasPortal(store.provider) && <Field label={l(text.portal)}><input type="url" name="portal_url" defaultValue={saved?.portal_url ?? ''} placeholder="https://" maxLength={2048} /></Field>}
    </div>
    <SaveButton pending={action.pending} label={l(text.bind)} />
  </fieldset>{action.error !== undefined && <WriteProblem error={action.error} />}</form>;
}

function StoreAssignment({ store, binding, devices, pendingJob, onQueued }: {
  store: Store; binding?: WorkerBinding; devices: Device[]; pendingJob: boolean; onQueued: (job: CatalogJob) => void;
}) {
  const { l } = useText();
  const action = useSetupWrite();
  const marketSetupId = useId();
  const [showMarket, setShowMarket] = useState(false);
  const [marketSaved, setMarketSaved] = useState(false);
  const device = devices.find(item => item.id === binding?.device_id);
  async function queue() {
    const job = await action.run<CatalogJob>('POST', `/stores/${encodeURIComponent(store.id)}/worker/imports`, {});
    if (job) onQueued(job);
  }
  return <>
    {binding && <div className="vs-row-head"><strong>{binding.device_name}</strong><StatusChip status="connected" label={text.bound} /><DeviceStatus device={device} /></div>}
    <StoreWorkerForm store={store} saved={binding} devices={devices} />
    {binding && store.status !== 'disabled' && <>
      <div className="vs-actions">
        <button type="button" className="vs-btn" aria-expanded={showMarket} aria-controls={marketSetupId} onClick={() => setShowMarket(value => !value)}>{l(text.marketSetup)}</button>
        {marketSaved && <span role="status">{l(text.marketSaved)}</span>}
      </div>
      <div id={marketSetupId} hidden={!showMarket}>{showMarket && <StoreMarketSetup store={store} onReady={result => {
        if (result.status === 'configured') setMarketSaved(true);
        setShowMarket(false);
      }} />}</div>
      <div className="vs-actions">
        <button type="button" className="vs-btn primary-soft" disabled={pendingJob || action.pending || showMarket} onClick={() => void queue()}>{l(action.pending ? text.requestPending : text.startImport)}</button>
        {device?.online === false && <small className="muted">{l(text.offlineImport)}</small>}
      </div>
    </>}
    {action.error !== undefined && <WriteProblem error={action.error} />}
  </>;
}

function JobList({ jobs, devices }: { jobs: CatalogJob[]; devices: Device[] }) {
  const { l, lang } = useText();
  const { ws, base } = useViewContext();
  if (!jobs.length) return <p className="muted">{l(text.noJobs)}</p>;
  return <ul className="vs-list">{jobs.map(job => {
    const device = devices.find(item => item.id === job.device_id);
    return <li key={job.id} className="setup-list-item">
      <div className="vs-row-head"><strong>{job.store_name}</strong><StatusChip status={job.status} label={Object.hasOwn(jobLabels, job.status) ? jobLabels[job.status] : undefined} /></div>
      <div className="vs-row-head"><small>{device?.name ?? job.device_id} · {job.external_store_id}</small>
        {inProgress.has(job.status) && <DeviceStatus device={device} />}
      </div>
      {job.expires_at && inProgress.has(job.status) && <small>{l(text.expires)} <time dateTime={job.expires_at}>{formatDateTime(job.expires_at, lang)}</time></small>}
      {job.error_code && <small className="muted"><code>{job.error_code}</code></small>}
      {job.import_id && <div className="vs-actions"><Link className="vs-btn" to={importPath(ws, job.import_id, job.store_id)}>{l(text.review)}</Link>
        {job.status === 'imported' && <Link className="vs-btn" to={`${base}/products`}>{l(text.products)}</Link>}</div>}
    </li>;
  })}</ul>;
}

export function StoreStep({ stores, brands, devices, catalog }: {
  stores: ViewResult<Store[]>; brands: ViewResult<Row[]>; devices: Device[]; catalog: ViewResult<WorkerCatalog>;
}) {
  const { l } = useText();
  const { ws, base } = useViewContext();
  const [selected, setSelected] = useState('');
  const [created, setCreated] = useState<Store>();
  const [queued, setQueued] = useState<CatalogJob>();
  const items = stores.value ?? [];
  const available = created && !items.some(store => store.id === created.id) ? [...items, created] : items;
  const store = available.find(item => item.id === selected) ?? available[0];
  const platform = store && providerLabel(store.provider);
  const bindings = catalog.value?.bindings ?? [];
  const binding = bindings.find(item => item.store_id === store?.id);
  const serverJobs = catalog.value?.jobs ?? [];
  const jobs = queued && !serverJobs.some(job => job.id === queued.id) ? [queued, ...serverJobs] : serverJobs;
  return <>
    <p>{l(text.storeIntro)}</p>
    <Section title={l(text.stores)}><Loaded read={stores}>{() => store ? <>
      <Field label={l(text.stores)}><select value={store.id} onChange={event => setSelected(event.target.value)}>
        {available.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></Field>
      <div className="vs-row-head"><StatusChip status={store.status} /><small>{[platform ? l(platform) : store.provider, store.external_store_id].filter(Boolean).join(' · ')}</small></div>
      {catalog.isSuccess && <StoreAssignment key={store.id} store={store} binding={binding} devices={devices} onQueued={setQueued}
        pendingJob={jobs.some(job => job.store_id === store.id && inProgress.has(job.status))} />}
    </> : <p className="muted">{l(text.noStores)}</p>}</Loaded></Section>
    <Section title={l(text.newStore)}><Loaded read={brands}>{items => {
      const usable = usableBrands(items);
      return usable.length ? <StoreForm key={usable.length === 1 ? String(usable[0].id) : 'multiple'} brands={usable} onCreated={item => { setCreated(item); setSelected(item.id); }} /> : <BrandForm />;
    }}</Loaded></Section>
    <Section title={l(text.imports)}>
      {catalog.isError && <p className="vs-notice warning">{l(text.workerCatalog)}</p>}
      <Loaded read={catalog}>{() => <JobList jobs={jobs} devices={devices} />}</Loaded>
      <div className="vs-actions"><Link className="vs-btn" to={importPath(ws, undefined, store?.id)}>{l(text.fileImport)}</Link>
        <Link className="vs-btn" to={`${base}/products`}>{l(text.products)}</Link></div>
    </Section>
  </>;
}
