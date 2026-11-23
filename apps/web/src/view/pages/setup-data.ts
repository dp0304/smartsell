import { useRef, useState } from 'react';
import type { Method, RecordData } from '@smartsell/sdk';
import { connectionState } from '../data/logic';
import type { AgentConnection } from '../data/types';
import { useViewWrite } from '../data/use-view';

export interface Device {
  id: string;
  name: string;
  platform?: string;
  status: string;
  online?: boolean;
  last_seen_at?: string | null;
  client_version?: string | null;
  allow_channel_registration?: boolean;
}

export interface BrowserSession {
  id: string;
  device_id: string;
  social_account_id: string;
  status: string;
  verified_at?: string;
}

export interface Store {
  id: string;
  name: string;
  provider: string;
  status: string;
  brand_id?: string;
  external_store_id?: string | null;
  connection_id?: string | null;
  default_currency?: string;
  default_locale?: string;
}

export interface WorkerBinding {
  store_id: string;
  device_id: string;
  device_name: string;
  external_store_id: string;
  portal_url?: string;
}

export interface CatalogJob {
  id: string;
  store_id: string;
  device_id: string;
  store_name: string;
  provider: string;
  external_store_id: string;
  status: string;
  expires_at?: string;
  import_id?: string;
  error_code?: string;
}

export interface WorkerCatalog { bindings: WorkerBinding[]; jobs: CatalogJob[] }
export const setupSteps = ['agent', 'worker'] as const;
export type SetupStep = typeof setupSteps[number];
export type SetupLocation = SetupStep | 'summary';
interface SetupNavigation { location?: SetupLocation; skipped: SetupStep[] }

export function setupLocation(value: unknown): SetupLocation | undefined {
  if (value === 'social' || value === 'store' || value === 'import') return 'worker';
  return value === 'summary' ? value : setupSteps.find(step => step === value);
}
export const canSetUp = (role?: string) => role === 'owner' || role === 'admin';
export const activeDevices = (devices: Device[] = []) => devices.filter(device => device.status === 'active');
export const mcpUsed = (connection: AgentConnection) => connectionState(connection) === 'active' && !!connection.mcp_client_verified_at;
// Only heartbeat writes client_version. Older pairing records may already have last_seen_at.
export const hasWorkerHeartbeat = (device: Device) => !!device.client_version?.trim() && Number.isFinite(Date.parse(device.last_seen_at ?? ''));
export const workerSetupComplete = (devices: Device[] = []) => activeDevices(devices).some(hasWorkerHeartbeat);
export const verifiedSession = (session: BrowserSession, devices: Device[] = []) => session.status === 'verified' && activeDevices(devices).some(device => device.id === session.device_id);

export function importPath(ws: string, id?: string, store?: string) {
  const params = new URLSearchParams({ tab: 'store-imports', ...(store && { store }), ...(id && { related: 'import', rid: id }) });
  return `/w/${encodeURIComponent(ws)}/commerce?${params}`;
}

function dismissalKey(ws: string, user?: string) { return `smartsell.get-started.dismissed:${user ?? ''}:${ws}`; }
export function setupDismissed(ws: string, user?: string) {
  try { return localStorage.getItem(dismissalKey(ws, user)) === '1'; } catch { return false; }
}
export function dismissSetup(ws: string, user?: string) {
  try { localStorage.setItem(dismissalKey(ws, user), '1'); } catch { /* Storage may be disabled. */ }
}

function navigationKey(ws: string, user?: string) {
  return `smartsell.get-started.navigation:${JSON.stringify([user ?? '', ws])}`;
}

export function readSetupNavigation(ws: string, user?: string): SetupNavigation {
  try {
    const value = JSON.parse(localStorage.getItem(navigationKey(ws, user)) ?? 'null');
    return {
      location: setupLocation(value?.location),
      skipped: setupSteps.filter(step => Array.isArray(value?.skipped) && value.skipped.includes(step)),
    };
  } catch { return { skipped: [] }; }
}

export function saveSetupNavigation(ws: string, user: string | undefined, location: SetupLocation, skipped: SetupStep[]) {
  try {
    localStorage.setItem(navigationKey(ws, user), JSON.stringify({ location, skipped }));
    localStorage.removeItem(dismissalKey(ws, user));
  } catch { /* Storage may be disabled. */ }
}

export function setupStarted(ws: string, user?: string) {
  return !setupDismissed(ws, user) && readSetupNavigation(ws, user).location !== undefined;
}

/** Retain the key on a retry of the same request, including a response lost after the write. */
export function useSetupWrite() {
  const write = useViewWrite();
  const retry = useRef<{ request: string; key: string }>(undefined);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const reset = () => { retry.current = undefined; setSaved(false); setError(undefined); };
  async function run<T>(method: Method, path: string, body: RecordData, recover?: (failure: unknown) => Promise<T | undefined>) {
    if (busy.current) return;
    const request = JSON.stringify([method, path, body]);
    if (retry.current?.request !== request) retry.current = { request, key: crypto.randomUUID() };
    busy.current = true;
    setPending(true); setSaved(false); setError(undefined);
    try {
      const result = await write<T>(method, path, body, retry.current.key);
      retry.current = undefined;
      setSaved(true);
      return result.data;
    } catch (failure) {
      const recovered = await recover?.(failure).catch(() => undefined);
      if (recovered !== undefined) {
        retry.current = undefined;
        setSaved(true);
        return recovered;
      }
      setError(failure);
    } finally { busy.current = false; setPending(false); }
  }
  return { run, reset, error, pending, saved };
}
