import { Link, Navigate } from 'react-router-dom';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, PageHeader, useText } from '../parts';
import type { Row } from './settings-logic';
import { WorkerAccounts } from './setup-connections';
import { setupText as text } from './setup-copy';
import { canSetUp, type BrowserSession, type Device, type Store, type WorkerCatalog } from './setup-data';
import { StoreStep } from './setup-store';
import './setup.css';

const polling = { refetchInterval: 10_000 };

function Accounts() {
  const { l } = useText();
  const { base } = useViewContext();
  const devices = useView<Device[]>('/devices', {}, polling);
  const accounts = useView<Row[]>('/social-accounts', {}, { allPages: true });
  const sessions = useView<BrowserSession[]>('/browser-sessions', {}, polling);
  const brands = useView<Row[]>('/brands', {}, { allPages: true });
  return <>
    <PageHeader title={l(['社群帳號與固定 Worker', 'Social accounts and dedicated workers'])}>
      <Link className="vs-btn" to={`${base}/settings`}>{l(['設定', 'Settings'])}</Link>
      <button className="vs-btn" onClick={() => { void devices.refetch(); void sessions.refetch(); void accounts.refetch(); }}>{l(text.refresh)}</button>
    </PageHeader>
    <section className="vs-card setup-panel"><Loaded read={devices}>{items =>
      <WorkerAccounts accounts={accounts} sessions={sessions} brands={brands} devices={items} />}</Loaded></section>
  </>;
}

function Stores({ phase }: { phase: 'store' | 'import' }) {
  const { l } = useText();
  const { base } = useViewContext();
  const devices = useView<Device[]>('/devices', {}, polling);
  const stores = useView<Store[]>('/stores', {}, { allPages: true });
  const brands = useView<Row[]>('/brands', {}, { allPages: true });
  const catalog = useView<WorkerCatalog>('/worker-catalog', {}, polling);
  return <>
    <PageHeader title={l(text[phase])}>
      <Link className="vs-btn" to={`${base}/products`}>{l(['商品', 'Products'])}</Link>
    </PageHeader>
    <section aria-label={l(text[phase])} className="vs-card setup-panel"><button type="button" className="vs-btn" onClick={() => { void devices.refetch(); void stores.refetch(); void brands.refetch(); void catalog.refetch(); }}>{l(text.refresh)}</button>
      <Loaded read={devices}>{items => <StoreStep phase={phase} stores={stores} brands={brands} catalog={catalog} devices={items} />}</Loaded></section>
  </>;
}

export function ManageWorkerAccountsPage() {
  const { workspace, base } = useViewContext();
  return canSetUp(workspace.role) ? <Accounts /> : <Navigate to={`${base}/settings`} replace />;
}

export function ManageStoresPage({ phase }: { phase: 'store' | 'import' }) {
  const { workspace, base } = useViewContext();
  return canSetUp(workspace.role) ? <Stores key={phase} phase={phase} /> : <Navigate to={`${base}/products`} replace />;
}
