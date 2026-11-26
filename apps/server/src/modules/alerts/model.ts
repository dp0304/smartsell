import { Problem, type Context, type Data, type HubProvider, type MachineWarning, type OwnerAlertKind, type Presence, type Row } from '@smartsell/contracts';

/** Record kinds owned by S10 (phase1-design §3.1). */
export const ALERT_KIND = 'owner_alert';
export const CHANNEL_KIND = 'alert_channel';
export const PREFERENCE_KIND = 'alert_preference';
export const TEST_KIND = 'alert_push_test';

export const OWNER_ALERT_KINDS: readonly OwnerAlertKind[] = ['worker_blocker', 'missed', 'unknown', 'late_fact_after_release',
  'approval_due', 'click_post_soon', 'login_check_failed', 'upload_done', 'upload_failed', 'machine_offline_with_jobs',
  'machine_setup', 'published', 'daily_summary', 'offline_run_stale_settings', 'handle_changed'];
/** The only kinds the owner may switch off in phase 1 (§5.9: no quiet hours). */
export const OPTIONAL_ALERT_KINDS = ['published', 'daily_summary'] as const;
export type OptionalAlertKind = typeof OPTIONAL_ALERT_KINDS[number];
export const SEVERITIES = ['urgent', 'normal', 'info'] as const;

export type WebUrlKind = 'post' | 'machine' | 'channel' | 'today' | 'notifications';

/**
 * Host wiring for the alerts module. Everything is optional: the defaults work in tests and in development.
 * S1 sets `secretKey` and `publicOrigin` from the hub configuration; S7 replaces `webUrl` with its route builder;
 * S2 provides `effectiveMode`; S7 provides `machineWarnings` (§3.2). See docs/restructure/requests/S10.md.
 */
export interface AlertHooks {
  publicOrigin?: string;
  webUrl?(ctx: Context, kind: WebUrlKind, id?: string): string;
  /** 32-byte key that seals push tokens at rest. */
  secretKey?: Uint8Array;
  effectiveMode?(ctx: Context, socialAccountId: string): 'auto' | 'assist' | 'owner' | undefined;
  machineWarnings?(ctx: Context, device: Row): MachineWarning[];
  /** Outbound HTTP for push delivery; tests pass a fetch bound to a local fake server. */
  fetch?: typeof fetch;
  /**
   * S6: push may reach private and loopback addresses (the home hub's own ntfy on 127.0.0.1 or the tailnet). Set for hub
   * mode and by SMARTSELL_PUSH_PRIVATE_NETWORK=1; otherwise (SaaS) ntfy and Bark URLs must resolve to public addresses.
   */
  privateEgress?: boolean;
  telegramApiBase?: string;
  pushTimeoutMs?: number;
}
let hooks: AlertHooks = {};
export function configureAlerts(next: AlertHooks) { hooks = { ...hooks, ...next }; }
/** Test helper: forget every hook. */
export function resetAlertHooks() { hooks = {}; }
export const alertHooks = (): Readonly<AlertHooks> => hooks;

export const invalidArgs = (message: string, path?: string): never => {
  throw new Problem(422, 'INVALID_ARGUMENTS', message, path ? { issues: [{ path, message }] } : undefined);
};

export const str = (value: unknown) => typeof value === 'string' && value ? value : undefined;
export const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : Number.NaN;

export function find(ctx: Context, kind: string, id: unknown): Row | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  try { return ctx.get(kind, id); } catch { return undefined; }
}

// ---------- Time ----------

export function workspaceTimezone(ctx: Context): string {
  const zone = str(ctx.list('workspace')[0]?.default_timezone) ?? 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } catch { return 'UTC'; }
}

function parts(at: number, zone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, month: values.month!, day: values.day!, hm: `${values.hour}:${values.minute}`,
    hour: Number(values.hour), minute: Number(values.minute) };
}
/** Local calendar date (YYYY-MM-DD) in `zone`. */
export const localDate = (iso: string, zone: string) => parts(Date.parse(iso), zone).date;
export const localHourMinute = (iso: string, zone: string) => { const p = parts(Date.parse(iso), zone); return p.hour * 60 + p.minute; };
/** "09:00" today, "明天 09:00" tomorrow, otherwise "11/27 09:00" (all in the workspace time zone). */
export function localLabel(iso: unknown, zone: string, nowIso: string): string {
  const at = time(iso);
  if (!Number.isFinite(at)) return '';
  const target = parts(at, zone);
  const today = parts(Date.parse(nowIso), zone);
  if (target.date === today.date) return target.hm;
  if (target.date === parts(Date.parse(nowIso) + 86_400_000, zone).date) return `明天 ${target.hm}`;
  return `${Number(target.month)}/${Number(target.day)} ${target.hm}`;
}
/** Absolute short stamp for push messages: "11/25 09:00". */
export function localStamp(iso: string, zone: string): string {
  const p = parts(Date.parse(iso), zone);
  return `${Number(p.month)}/${Number(p.day)} ${p.hm}`;
}

// ---------- Labels and links ----------

const PROVIDER_LABEL: Record<HubProvider, string> = { x: 'X', tiktok: 'TikTok', youtube: 'YouTube', meta_instagram: 'Instagram', meta_facebook: 'Facebook' };

/** "X", "TikTok", … for a social_account row (raw provider key for anything else). */
export const providerLabel = (account: Row | undefined) => PROVIDER_LABEL[account?.provider as HubProvider] ?? str(account?.provider);

export function machineLabel(ctx: Context, deviceId: unknown): string | undefined {
  const device = find(ctx, 'connector_device', deviceId);
  if (!device) return undefined;
  return str(device.display_name) ?? str(device.name) ?? '未命名機器';
}

/** Same rule as S2's channelLabel (§11.2 C2): "X @makemylure". */
export function channelLabel(ctx: Context, socialAccountId: unknown): string | undefined {
  const account = find(ctx, 'social_account', socialAccountId);
  if (!account) return undefined;
  const provider = PROVIDER_LABEL[account.provider as HubProvider] ?? str(account.provider) ?? '帳號';
  const handle = str(account.handle)?.replace(/^@/, '');
  if (handle) return `${provider} @${handle}`;
  const name = str(account.display_name);
  return name ? `${provider} ${name}` : provider;
}

export function publicOrigin(): string {
  const configured = hooks.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3401}`;
  return configured.replace(/\/+$/, '');
}

/** Web route for an alert link (§9.6). S7's `webUrl` replaces this through `configureAlerts`. */
export function webUrl(ctx: Context, kind: WebUrlKind, id?: string): string {
  if (hooks.webUrl) return hooks.webUrl(ctx, kind, id);
  const base = `${publicOrigin()}/app/${encodeURIComponent(ctx.workspaceId)}`;
  switch (kind) {
    case 'post': return `${base}/posts/${encodeURIComponent(id ?? '')}`;
    case 'machine': return `${base}/machines/${encodeURIComponent(id ?? '')}`;
    case 'channel': return `${base}/channels/${encodeURIComponent(id ?? '')}`;
    case 'notifications': return `${base}/settings/notifications`;
    default: return base;
  }
}

export function presence(ctx: Context, deviceId: string): Presence | undefined {
  return (ctx as Context & { presence?: (id: string) => Presence | undefined }).presence?.(deviceId);
}

/** Remote-screen link for a machine that reported one (§3.2 remote_access). */
export function remoteUrl(device: Row | undefined): string | null {
  const access = device?.remote_access as { kind?: string; host?: string } | null | undefined;
  if (!access || typeof access.host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(access.host)) return null;
  if (access.kind === 'vnc') return `vnc://${access.host}`;
  if (access.kind === 'rdp') return `rdp://full%20address=s:${access.host}`;
  return null;
}

export const isHubChannel = (ctx: Context, socialAccountId: unknown) => typeof socialAccountId === 'string' &&
  ctx.list('channel_settings').some(row => row.id === socialAccountId || row.social_account_id === socialAccountId);

/** The machine bound to a channel (Worker route binding, §3.3). */
export function boundDevice(ctx: Context, socialAccountId: unknown): string | undefined {
  if (typeof socialAccountId !== 'string') return undefined;
  const binding = ctx.list('account_execution_binding').filter(row => row.social_account_id === socialAccountId && typeof row.device_id === 'string' &&
    row.status !== 'revoked' && row.status !== 'inactive').sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  return str(binding?.device_id);
}

export function preferences(ctx: Context): Record<OptionalAlertKind, boolean> {
  const row = ctx.list(PREFERENCE_KIND)[0];
  return { published: row?.published !== false, daily_summary: row?.daily_summary !== false };
}

export function workerJobs(ctx: Context): Row[] { return ctx.list('worker_job'); }
export function jobEvents(ctx: Context, jobId: string): Row[] {
  return ctx.list('worker_job_event').filter(row => row.job_id === jobId).sort((a, b) => String(a.at ?? a.created_at).localeCompare(String(b.at ?? b.created_at)));
}
export const detail = (row: Row | undefined): Data => (row?.detail && typeof row.detail === 'object' ? row.detail as Data : {});
