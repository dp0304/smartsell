import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '@smartsell/sdk';
import { StatusChip, type Tuple } from '@smartsell/ui';
import { useViewContext, type ViewResult } from '../data/use-view';
import { Loaded, Section, useText } from '../parts';
import { BrandForm, DeviceStatus, SaveButton, WorkerField, usableBrands } from './setup-connections';
import { setupText as text } from './setup-copy';
import { activeDevices, importPath, useSetupWrite, type Device, type Store, type WorkerBinding, type WorkerCatalog } from './setup-data';
import { StoreProductImport } from './setup-store-import';
import type { Row } from './settings-logic';
import { Field, WriteProblem } from './settings-parts';

const providers = {
  shopify: ['Shopify', 'Shopify'], tiktok_shop: ['TikTok Shop', 'TikTok Shop'], amazon_sp: ['Amazon', 'Amazon'],
  shopee: ['蝦皮購物', 'Shopee'], lazada: ['Lazada', 'Lazada'], other: ['其他商城', 'Other storefront'], file_import: ['檔案匯入', 'File import'],
} as const satisfies Record<string, Tuple>;
const storeText = {
  intro: ['先登記店鋪，再指定日後擷取商品的固定 Worker。', 'Register a store, then assign the worker that will retrieve its products.'],
  importIntro: ['選擇已綁定的店鋪，匯入官方商品清單。', 'Choose a store with a dedicated worker to import its official product export.'],
  chooseBound: ['選擇已綁定的店鋪', 'Choose a store with a dedicated worker'],
  unbound: ['店鋪尚未綁定固定 Worker。', 'This store has no dedicated worker assignment yet.'],
  noBound: ['尚無已綁定的店鋪。請先登記店鋪並指定 Worker。', 'No stores have a dedicated worker yet. Register a store and assign a worker first.'],
  goWorker: ['前往配對 Worker', 'Go to worker pairing'],
  goStore: ['前往商城設定', 'Go to store setup'],
  changeWorker: ['變更 Worker 綁定', 'Change worker assignment'],
  existing: ['選擇現有店鋪', 'Choose an existing store'],
} as const;
const providerLabel = (key: string) => Object.hasOwn(providers, key) ? providers[key as keyof typeof providers] : undefined;
const workerStoreId = /^[a-zA-Z0-9][a-zA-Z0-9_.:\x2f\x7c+\x2d]{0,159}$/;
const hasPortal = (provider: string) => ['shopify', 'tiktok_shop', 'amazon_sp', 'shopee', 'lazada'].includes(provider);

function StoreForm({ brands, stores, onCreated }: { brands: Row[]; stores: ViewResult<Store[]>; onCreated: (store: Store) => void }) {
  const { l, lang } = useText();
  const action = useSetupWrite();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const field = (name: string) => String(form.get(name) ?? '').trim();
    if (!field('name') || !workerStoreId.test(field('external_store_id'))) return;
    const body = {
      mode: 'import', provider: field('provider'), name: field('name'), brand_id: field('brand_id'),
      external_store_id: field('external_store_id'), default_currency: field('default_currency').toUpperCase(), default_locale: field('default_locale'),
    };
    const store = await action.run<Store>('POST', '/stores', body, async failure => {
      const duplicate = failure instanceof ApiError && failure.status === 409 && failure.problem.code === 'duplicate_store';
      const uncertain = failure instanceof TypeError || (failure instanceof ApiError && failure.status >= 500);
      if (!duplicate && !uncertain) return;
      // The attempt may already be saved (or another tab may have submitted it). Require a fresh exact match.
      const locale = Intl.getCanonicalLocales(body.default_locale)[0];
      const latest = await stores.refetch();
      if (!latest.isSuccess) return;
      return latest.data?.data.find(item => item.status === 'import_only' && !item.connection_id &&
        item.provider === body.provider && item.external_store_id === body.external_store_id && item.brand_id === body.brand_id &&
        item.name === body.name && item.default_currency === body.default_currency && item.default_locale === locale);
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
      <Field label={l(text.locale)} required><input name="default_locale" required maxLength={35} defaultValue={lang === 'en' ? 'en-US' : 'zh-TW'} /></Field>
    </div>
    <SaveButton pending={action.pending} label={l(text.newStore)} />
  </fieldset>{action.error !== undefined && <WriteProblem error={action.error} />}</form>;
}

function StoreWorkerForm({ store, saved, devices, onBound }: {
  store: Store; saved?: WorkerBinding; devices: Device[]; onBound: (binding: WorkerBinding) => void;
}) {
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
    if (result) {
      if (canAddId) setRecordedId(result.external_store_id);
      onBound(result);
    }
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

function StoreAssignment({ store, binding, devices, workerLink, onBound }: {
  store: Store; binding?: WorkerBinding; devices: Device[]; workerLink: string; onBound: () => void;
}) {
  const { l } = useText();
  const [editing, setEditing] = useState(false);
  const device = devices.find(item => item.id === binding?.device_id);
  return <>
    {binding ? <div className="vs-row-head"><strong>{binding.device_name}</strong><StatusChip status="connected" label={text.bound} />
      <DeviceStatus device={device} /></div> : <p>{l(storeText.unbound)}</p>}
    {!activeDevices(devices).length ? <>
      <p className="muted">{l(text.workerRequired)}</p>
      <Link className="vs-btn" to={workerLink}>{l(storeText.goWorker)}</Link>
    </> : (!binding || editing) ? <StoreWorkerForm store={store} saved={binding} devices={devices} onBound={() => {
      setEditing(false);
      onBound();
    }} /> : <button type="button" className="vs-btn" onClick={() => setEditing(true)}>{l(storeText.changeWorker)}</button>}
  </>;
}

export function StoreStep({ stores, brands, devices, catalog, phase = 'store' }: {
  stores: ViewResult<Store[]>; brands: ViewResult<Row[]>; devices: Device[]; catalog: ViewResult<WorkerCatalog>;
  phase?: 'store' | 'import';
}) {
  const { l } = useText();
  const { ws, base } = useViewContext();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Store>();
  const selected = params.get('store');
  const items = stores.value ?? [];
  const available = (created && !items.some(store => store.id === created.id) ? [...items, created] : items)
    .filter(store => store.status !== 'disabled');
  const bindings = catalog.value?.bindings ?? [];
  const bound = available.filter(store => bindings.some(binding => binding.store_id === store.id));
  const options = phase === 'store' ? available : bound;
  const selectedUnbound = phase === 'import' && available.find(item => item.id === selected && !bound.includes(item));
  const store = options.find(item => item.id === selected) ?? (selectedUnbound ? undefined : options[0]);
  const binding = bindings.find(item => item.store_id === store?.id);
  const platform = store && providerLabel(store.provider);
  const storeQuery = store ? `?${new URLSearchParams({ store: store.id })}` : '';
  function select(id: string) {
    setParams(current => {
      const next = new URLSearchParams(current);
      next.set('store', id);
      return next;
    }, { replace: true });
  }
  function picker(label: string) {
    return <Field label={label}><select value={store?.id ?? ''} onChange={event => select(event.target.value)}>
      {!store && <option value="" disabled>—</option>}
      {options.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></Field>;
  }

  if (phase === 'import') return <>
    <p>{l(storeText.importIntro)}</p>
    <Loaded read={stores}>{() => <Loaded read={catalog}>{data => store && binding ? <>
      {picker(l(storeText.chooseBound))}
      <StoreProductImport key={store.id} store={store} binding={binding} devices={devices}
        jobs={data.jobs.filter(job => job.store_id === store.id)} refresh={() => void catalog.refetch()} catalogError={catalog.isError} />
    </> : <>
      <p>{selectedUnbound ? <><strong>{selectedUnbound.name}</strong> · {l(storeText.unbound)}</> : l(available.length ? storeText.noBound : text.noStores)}</p>
      {bound.length > 0 && picker(l(storeText.chooseBound))}
      <Link className="vs-btn" to={`${base}/products/stores${storeQuery}`}>{l(storeText.goStore)}</Link>
    </>}</Loaded>}</Loaded>
  </>;

  return <>
    <p>{l(storeText.intro)}</p>
    <Section title={l(text.stores)}><Loaded read={stores}>{() => (creating || !store) ? <>
      {store && <button type="button" className="vs-btn" onClick={() => setCreating(false)}>{l(storeText.existing)}</button>}
      <Loaded read={brands}>{rows => {
        const usable = usableBrands(rows);
        return usable.length ? <StoreForm key={usable.length === 1 ? String(usable[0].id) : 'multiple'} brands={usable} stores={stores}
          onCreated={item => { setCreated(item); select(item.id); setCreating(false); }} /> : <BrandForm />;
      }}</Loaded>
    </> : <>
      {picker(l(storeText.existing))}
      <div className="vs-row-head"><StatusChip status={store.status} /><small>{[platform ? l(platform) : store.provider, store.external_store_id].filter(Boolean).join(' · ')}</small></div>
      <Loaded read={catalog}>{() => !catalog.isError && <StoreAssignment key={store.id} store={store} binding={binding} devices={devices}
        workerLink={`${base}/get-started?step=worker`} onBound={() => { select(store.id); void catalog.refetch(); }} />}</Loaded>
      <div className="vs-actions">
        <button type="button" className="vs-btn" onClick={() => setCreating(true)}>{l(text.newStore)}</button>
        {binding && <Link className="vs-btn" to={`${base}/products/stores/imports${storeQuery}`}>{l(text.import)}</Link>}
        <Link className="vs-btn" to={importPath(ws, undefined, store.id)}>{l(text.fileImport)}</Link>
      </div>
    </>}</Loaded></Section>
  </>;
}
