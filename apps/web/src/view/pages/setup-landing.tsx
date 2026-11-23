import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useMatch } from 'react-router-dom';
import { Busy } from '@smartsell/ui';
import { useCopy } from '../../i18n';
import type { AgentConnection } from '../data/types';
import { useView, useViewContext } from '../data/use-view';
import { setupText } from './setup-copy';
import { canSetUp, mcpUsed, setupDismissed, setupStarted, verifiedSession, workerSetupComplete,
  type BrowserSession, type Device, type WorkerCatalog } from './setup-data';

const rows = <T extends object,>(value: T[] | undefined): T[] =>
  Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];
const hasDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function CheckWorkspace() {
  const { base } = useViewContext();
  const { t, label } = useCopy();
  const presence = useView<{ last_seen_at?: string | null }>('/views/agent-presence');
  const connections = useView<AgentConnection[]>('/agent-connections');
  const devices = useView<Device[]>('/devices');
  const sessions = useView<BrowserSession[]>('/browser-sessions');
  const stores = useView<Record<string, unknown>[]>('/stores', {}, { allPages: true });
  const products = useView<Record<string, unknown>[]>('/products', { status: 'active' });
  const catalog = useView<WorkerCatalog>('/worker-catalog');
  const [showOverview, setShowOverview] = useState(false);
  const knownDevices = devices.isError ? [] : rows(devices.value);
  // Only completed connections, verified accounts, and active inventory count as configuration.
  const configured = (!presence.isError && hasDate(presence.value?.last_seen_at)) ||
    (!connections.isError && rows(connections.value).some(item => hasDate(item.last_used_at) && mcpUsed(item))) ||
    workerSetupComplete(knownDevices) ||
    (!sessions.isError && rows(sessions.value).some(item => item.device_id && verifiedSession(item, knownDevices))) ||
    (!stores.isError && rows(stores.value).some(store =>
      store.status === 'active' && typeof store.connection_id === 'string' && !!store.connection_id && hasDate(store.last_snapshot_at))) ||
    (!products.isError && rows(products.value).some(item => item.status === 'active' &&
      typeof item.store_id === 'string' && !!item.store_id && typeof item.title === 'string' && !!item.title.trim())) ||
    (!catalog.isError && rows(catalog.value?.jobs).some(job => job.status === 'imported' && !!job.import_id));
  useEffect(() => { if (configured) setShowOverview(true); }, [configured]);
  if (configured || showOverview) return <Outlet />;
  const reads = [presence, connections, devices, sessions, stores, products, catalog];
  if (reads.some(read => read.isPending || read.isFetching)) {
    return <main className="view-shell vs-setup-shell" aria-busy="true"><div className="vs-content"><Busy label={t('loading')} /></div></main>;
  }
  const failed = reads.filter(read => read.isError);
  const setup = `${base}/get-started`;
  if (failed.length) return <main className="view-shell vs-setup-shell"><div className="vs-content">
    <div className="vs-notice warning">
      <p role="status">{label(['暫時無法確認初始化進度', 'Could not confirm setup progress right now'])}</p>
      <div className="vs-actions">
        <button type="button" className="vs-btn" onClick={() => { for (const read of failed) void read.refetch(); }}>{t('retry')}</button>
        <Link className="vs-btn" to={setup}>{label(setupText.title)}</Link>
        <Link className="vs-btn" to={base} state={{ skipSetupCheck: true }} replace>{label(setupText.finish)}</Link>
      </div>
    </div>
  </div></main>;
  return <Navigate to={setup} replace />;
}

/** Only the workspace index uses this check. Sections and filtered overview links remain direct destinations. */
export function SetupLanding() {
  const { base, ws, workspace, session } = useViewContext();
  const { key, search, hash, state } = useLocation();
  const index = useMatch('/app/:ws');
  const filters = new URLSearchParams(search);
  if (!index || !canSetUp(workspace.role) || setupDismissed(ws, session.user.id) || state?.skipSetupCheck === true ||
      hash || ['brand', 'from', 'to'].some(name => filters.has(name))) return <Outlet />;
  if (setupStarted(ws, session.user.id)) return <Navigate to={`${base}/get-started`} replace />;
  return <CheckWorkspace key={`${key}/${ws}/${session.user.id}`} />;
}
