import { bindPath, request, workspacePath } from '@smartsell/sdk';

export type SocialAccount = { id: string; display_name: string; provider: string; status: string };
export type ConnectorDevice = { id: string; name: string; status: string; online: boolean };
export type MobileDevice = { id: string; device_id: string; model: string; serial_suffix: string; status: string };
export type MobileAppBinding = { id: string; mobile_device_id: string; social_account_id: string; app: string; status: string };

type Channel = 'browser' | 'mobile';
export type MigrationTarget = { device_id: string; owned_account_confirmed: true } & (
  { connector_channel: 'browser' } | { connector_channel: 'mobile'; mobile_device_id: string; mobile_app: string }
);

type Task = { id: string; status: string };
export type MigrationImpact = { binding_id: string; queued: Task[]; draining: Task[]; retained: Task[] };
export type Migration = {
  status: 'draining' | 'completed';
  source_device_id: string;
  target_device_id: string;
  source_connector_channel: Channel;
  target_connector_channel: Channel;
  source_mobile_device_id?: string | null;
  target_mobile_device_id?: string | null;
  target_session_id?: string | null;
};
type MigrationState = { migration: Migration; impact: MigrationImpact } | { migration: null; impact: MigrationImpact | null };
export type RecoveryImpact = { social_account_ids: string[]; execution_task_ids: string[]; connector_task_ids: string[] };
type MobileUnbindImpact = RecoveryImpact & { id: string; status: string; can_unbind: boolean; guidance: string[] };

export function accountSecurityApi(ws: string, csrf: string) {
  const base = workspacePath(ws);
  const migration = (id: string) => bindPath('/social-accounts/:id/execution-binding/migration', { id });
  const revoke = (id: string) => bindPath('/devices/:id/revoke', { id });
  const appBinding = (id: string) => bindPath('/mobile-app-bindings/:id', { id });
  const get = async <T,>(path: string, signal?: AbortSignal) => (await request<T>(`${base}${path}`, { signal })).data;
  const post = async <T,>(path: string, body: Record<string, unknown>) => (await request<T>(`${base}${path}`, { method: 'POST', csrf, body })).data;
  return {
    accounts: (signal: AbortSignal) => get<SocialAccount[]>('/social-accounts', signal),
    devices: (signal: AbortSignal) => get<ConnectorDevice[]>('/devices', signal),
    phones: (signal: AbortSignal) => get<MobileDevice[]>('/mobile-devices', signal),
    appBindings: (signal: AbortSignal) => get<MobileAppBinding[]>('/mobile-app-bindings', signal),
    migrationState: (id: string, signal: AbortSignal) => get<MigrationState>(migration(id), signal),
    migrationPreview: (id: string, signal: AbortSignal) => get<MigrationImpact>(`${migration(id)}/preview`, signal),
    startMigration: (id: string, target: MigrationTarget) => post<MigrationState>(migration(id), target),
    completeMigration: (id: string) => post<MigrationState>(`${migration(id)}/complete`, {}),
    revokePreview: (id: string) => post<RecoveryImpact>(revoke(id), { dry_run: true }),
    revokeDevice: (id: string) => post<RecoveryImpact>(revoke(id), {}),
    unbindPreview: (id: string) => get<MobileUnbindImpact>(`${appBinding(id)}/impact`),
    unbindApp: async (id: string) => (await request<MobileUnbindImpact & { status: 'revoked' }>(`${base}${appBinding(id)}`, { method: 'DELETE', csrf })).data,
  };
}
