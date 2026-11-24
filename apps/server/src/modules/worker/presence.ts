import { PRESENCE_WRITE_INTERVAL_MS, type Context, type DevicePosture, type DriverHealth, type Presence, type Row } from '@smartsell/contracts';

/**
 * In-memory machine presence (phase1-design §2.10). Heartbeats and claims update this map only; the connector_device row
 * is written when a value changes, every PRESENCE_WRITE_INTERVAL_MS, or when the machine goes on/offline (90 s).
 */
export const ONLINE_WINDOW_MS = 90_000;
type Entry = Presence & { written_at: number | null; remote_access?: unknown; /** last_seen_at as this process last wrote or saw it in the row. */ row_seen_at: string | null };
const presence = new Map<string, Entry>();

const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;

/** C3: the live presence of a machine, or undefined after a hub restart until its next heartbeat. */
export function machinePresence(deviceId: string): Presence | undefined {
  const entry = presence.get(deviceId);
  if (!entry) return undefined;
  const { written_at: _written, remote_access: _remote, row_seen_at: _row, ...value } = entry;
  return value;
}

/**
 * Memory is authoritative while the row still holds what this process wrote; a row changed by another writer (an older
 * code path that stamps last_seen_at, a restore, an operator) wins over memory.
 */
function current(device: Row): Entry | undefined {
  const entry = presence.get(device.id);
  if (!entry) return undefined;
  return (entry.row_seen_at ?? null) === (typeof device.last_seen_at === 'string' ? device.last_seen_at : null) ? entry : undefined;
}

/** C14 with the stored row at hand (workspace-services): presence unless the row was changed by someone else. */
export function presenceFor(ctx: Pick<Context, 'list'>, deviceId: string): Presence | undefined {
  const device = ctx.list('connector_device').find(row => row.id === deviceId);
  return device && current(device) ? machinePresence(deviceId) : undefined;
}

/** A legacy (v1) heartbeat stamped last_seen_at on the row itself. */
export function notePresenceRowWrite(deviceId: string, at: string) {
  const entry = presence.get(deviceId);
  if (entry) { entry.row_seen_at = at; entry.written_at = Date.parse(at); }
}

/** When this process started tracking presence (≈ hub process start). Memory holds nothing older than this. */
let trackingSince = new Date().toISOString();

/**
 * AO-4: the time presence tracking started in this process. A machine whose last contact predates it may only look
 * offline because the hub itself was down (the row is written at most every PRESENCE_WRITE_INTERVAL_MS).
 */
export function presenceSince(): string { return trackingSince; }

/** Test helper: forget all presence (simulates a hub restart, optionally at a fixture time). */
export function resetPresence(at?: string) {
  presence.clear();
  trackingSince = at ?? new Date().toISOString();
}

/** C3: §3.2 online rule. Reads memory first and falls back to the stored row (hub just restarted). */
export function isMachineOnline(ctx: Pick<Context, 'now'>, device: Row | undefined): boolean {
  if (!device || device.paused === true || device.status !== 'active') return false;
  const seen = time(current(device)?.last_seen_at ?? device.last_seen_at);
  return Number.isFinite(seen) && time(ctx.now) - seen < ONLINE_WINDOW_MS;
}

/** max(last_seen_at, last_job_sync_at) and the error bound of that value (§5.6): 0 from memory, the write interval from the row. */
export function lastContact(device: Row): { at: number | null; errorMs: number } {
  const entry = current(device);
  if (entry) {
    const values = [time(entry.last_seen_at), time(entry.last_job_sync_at)].filter(Number.isFinite);
    return { at: values.length ? Math.max(...values) : null, errorMs: 0 };
  }
  const values = [time(device.last_seen_at), time(device.last_job_sync_at)].filter(Number.isFinite);
  return { at: values.length ? Math.max(...values) : null, errorMs: PRESENCE_WRITE_INTERVAL_MS };
}

export interface HeartbeatPresence {
  protocol: 1 | 2; client_version: string; drivers?: DriverHealth[]; worker_time?: string; outbox_depth?: number;
  posture?: DevicePosture; remote_access?: unknown; applied_sync_generation?: number;
}

const driverKey = (drivers: DriverHealth[] | undefined) => JSON.stringify((drivers ?? []).map(item => [item.provider, item.version, item.health, item.step ?? null]));

/**
 * Records a heartbeat in memory and returns the connector_device patch to write, or undefined when nothing needs a write
 * (§2.10: value changed, 5 minutes since the last write, or the machine just came online).
 */
export function recordHeartbeatPresence(ctx: Pick<Context, 'now'>, device: Row, input: HeartbeatPresence): Record<string, unknown> | undefined {
  const now = time(ctx.now);
  const previous = presence.get(device.id);
  const workerTime = time(input.worker_time);
  const offset = Number.isFinite(workerTime) ? now - workerTime : previous?.clock_offset_ms ?? null;
  const next = {
    last_seen_at: ctx.now, last_job_sync_at: previous?.last_job_sync_at ?? (typeof device.last_job_sync_at === 'string' ? device.last_job_sync_at : null),
    protocol: input.protocol, client_version: input.client_version, drivers: input.drivers ?? previous?.drivers ?? [],
    clock_offset_ms: offset, outbox_depth: input.outbox_depth ?? 0, posture: input.posture ?? previous?.posture ?? (device.posture as DevicePosture | null) ?? null,
    applied_sync_generation: input.applied_sync_generation ?? previous?.applied_sync_generation ?? 0,
    written_at: previous?.written_at ?? null, remote_access: input.remote_access !== undefined ? input.remote_access : previous?.remote_access,
    row_seen_at: typeof device.last_seen_at === 'string' ? device.last_seen_at : null,
  };
  const trusted = previous && (previous.row_seen_at ?? null) === next.row_seen_at ? previous : undefined;
  if (!trusted) next.written_at = null;
  const wasOnline = trusted ? now - time(trusted.last_seen_at) < ONLINE_WINDOW_MS
    : Number.isFinite(time(device.last_seen_at)) && now - time(device.last_seen_at) < ONLINE_WINDOW_MS;
  const patch: Record<string, unknown> = {};
  if (device.client_version !== next.client_version) patch.client_version = next.client_version;
  if (device.protocol !== next.protocol) patch.protocol = next.protocol;
  if (input.drivers && driverKey(device.drivers as DriverHealth[] | undefined) !== driverKey(input.drivers)) patch.drivers = input.drivers;
  if (input.posture && JSON.stringify(device.posture ?? null) !== JSON.stringify(input.posture)) patch.posture = input.posture;
  if (input.remote_access !== undefined && JSON.stringify(device.remote_access ?? null) !== JSON.stringify(input.remote_access)) patch.remote_access = input.remote_access;
  if (offset !== null && (typeof device.clock_offset_ms !== 'number' || Math.abs(device.clock_offset_ms - offset) > 5_000)) patch.clock_offset_ms = offset;
  const stale = next.written_at === null || now - next.written_at >= PRESENCE_WRITE_INTERVAL_MS;
  if (Object.keys(patch).length || stale || !wasOnline) {
    patch.last_seen_at = next.last_seen_at;
    if (next.last_job_sync_at) patch.last_job_sync_at = next.last_job_sync_at;
    next.written_at = now;
    next.row_seen_at = next.last_seen_at;
  }
  presence.set(device.id, next);
  return Object.keys(patch).length ? patch : undefined;
}

/** jobs.claim only touches memory (§2.10). */
export function recordClaimPresence(ctx: Pick<Context, 'now'>, device: Row) {
  const entry = presence.get(device.id);
  if (entry) entry.last_job_sync_at = ctx.now;
  else presence.set(device.id, {
    last_seen_at: typeof device.last_seen_at === 'string' ? device.last_seen_at : ctx.now, last_job_sync_at: ctx.now, protocol: 2,
    client_version: String(device.client_version ?? ''), drivers: (device.drivers as DriverHealth[] | undefined) ?? [], clock_offset_ms: null,
    outbox_depth: 0, posture: (device.posture as DevicePosture | null) ?? null, applied_sync_generation: 0, written_at: null,
    row_seen_at: typeof device.last_seen_at === 'string' ? device.last_seen_at : null,
  });
}

/** Writes pending presence for machines that went offline since the last write (lifecycle, §2.10 「上下線」). */
export function presenceOfflinePatches(ctx: Pick<Context, 'now' | 'list'>): { id: string; patch: Record<string, unknown> }[] {
  const now = time(ctx.now);
  const out: { id: string; patch: Record<string, unknown> }[] = [];
  for (const device of ctx.list('connector_device')) {
    const entry = current(device);
    if (!entry || now - time(entry.last_seen_at) < ONLINE_WINDOW_MS) continue;
    if (device.last_seen_at === entry.last_seen_at && (entry.last_job_sync_at == null || device.last_job_sync_at === entry.last_job_sync_at)) continue;
    out.push({ id: device.id, patch: { last_seen_at: entry.last_seen_at, ...(entry.last_job_sync_at && { last_job_sync_at: entry.last_job_sync_at }) } });
    entry.written_at = now;
    entry.row_seen_at = entry.last_seen_at;
  }
  return out;
}
