import { createHash, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { exportDevicePublicKey, fields, opaqueId, parseConnectorClaim, timestamp, type ConnectorClaim } from '../../../packages/connector-tasks/src/index.ts';
import { PermitError, parseConsumePermitDecision, parseSubmitPermitDecision, type ConsumePermitRequest, type SubmitPermitClient, type SubmitPermitRequest } from './permit.ts';
import type { Report } from './workflow.ts';
import { parseSocialStatusClaim, parseSocialStatusResult, type SocialStatusClaim, type SocialStatusResult } from './social-status.ts';
import type { ClaimRequest, ClaimResponse, GoRequest, GoResponse, HeartbeatV2Request, HeartbeatV2Response, JobReport, RemoteNextRequest, RemoteNextResponse, RemoteResultRequest } from '../../../packages/contracts/src/phase1.ts';
import { guardSocketTypeOfService } from './socket-guard.ts';

// Every signed hub request goes through global fetch: keep a reset hub connection from crashing the Worker (socket-guard.ts).
guardSocketTypeOfService();

export type DeviceAction = 'heartbeat' | 'claim' | 'catalog.claim' | 'catalog.upload' | 'channels.register' | 'browser.identity' | 'mobile.identity' | 'mobile.report' | 'attempt.ready' | 'attempt.permit' | 'attempt.consume' | 'attempt.report' | 'zhihu.stats.claim' | 'zhihu.stats.report' | 'social.status.claim' | 'social.status.report';
export type ZhihuStatsClaim = { id: string; workspace_id: string; device_id: string; fencing_token: number; lease_expires_at: string } & (
  | { mode?: never; profile_slug: string }
  | { mode: 'login_check'; profile_slug?: never }
);
export type ZhihuStatsBlockReason = 'identity_mismatch' | 'login_required' | 'unavailable';
export type ZhihuStatsResult = { status: 'completed'; profile_slug: string; followers_text: string; upvotes_text: string }
  | { status: 'blocked'; reason: ZhihuStatsBlockReason };
export type ZhihuLoginCheckResult = { status: 'completed'; profile_slug?: never; followers_text?: never; upvotes_text?: never }
  | { status: 'blocked'; reason: Exclude<ZhihuStatsBlockReason, 'identity_mismatch'> };
export type CatalogExport = { csv: string; xlsx_base64?: never } | { csv?: never; xlsx_base64: string };
export type DeviceBindings = { social: Record<string, number>; commerce: Record<string, number> };
export type ChannelSelection = { kind: 'social' | 'store'; platform: string; external_id: string; observed_at: string; display_name?: string; portal_url?: string;
  /** Phase 1 (§8.16): the per-channel Chrome profile, the visible handle and the automation notice the owner accepted. */
  profile_key?: string; handle?: string; automation_notice_version?: string };
export type ChannelRegistration = Pick<ChannelSelection, 'kind' | 'platform' | 'external_id'> & { resource_id: string; device_id: string };

export function channelSelectionKey({ kind, platform, external_id }: Pick<ChannelSelection, 'kind' | 'platform' | 'external_id'>) {
  return JSON.stringify([kind, platform, external_id]);
}

function bindingCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid device binding counts');
  const counts = Object.entries(value);
  for (const [provider, count] of counts) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(provider) || !Number.isSafeInteger(count) || count <= 0) {
      throw new TypeError('Invalid device binding count');
    }
  }
  return Object.fromEntries(counts);
}
const catalogBodyLimit = 1024 * 1024;
export type SignedDeviceRequest = { device_id: string; timestamp: string; nonce: string; signature: string };
export type SignedDeviceTransport = (action: DeviceAction, rawBody: Uint8Array, signed: SignedDeviceRequest, workspaceId?: string) => Promise<unknown>;

const devicePaths = {
  heartbeat: '/api/v1/device/heartbeat', claim: '/api/v1/device/claim', 'browser.identity': '/api/v1/device/browser-identity',
  'mobile.identity': '/api/v1/device/mobile-identity', 'mobile.report': '/api/v1/device/mobile-devices/report',
  'catalog.claim': '/api/v1/device/catalog/claim', 'catalog.upload': '/api/v1/device/catalog/upload',
  'channels.register': '/api/v1/device/channels/register',
  'zhihu.stats.claim': '/api/v1/device/zhihu-stats/claim', 'zhihu.stats.report': '/api/v1/device/zhihu-stats/report',
  'social.status.claim': '/api/v1/device/social-status/claim', 'social.status.report': '/api/v1/device/social-status/report',
} as const;
const attemptPaths = {
  'attempt.ready': 'ready', 'attempt.permit': 'submit-permit', 'attempt.consume': 'submit-permit/consume', 'attempt.report': 'device-report',
} as const;

export function apiOrigin(origin: string): string {
  const endpoint = new URL(origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) || endpoint.username || endpoint.password ||
    endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new TypeError('Expected an HTTPS API origin or a loopback HTTP API origin');
  return endpoint.origin;
}

async function postDeviceJson(origin: string, path: string, bytes: Uint8Array, fetcher: typeof fetch, headers: Record<string, string> = {}) {
  const response = await fetcher(new URL(path, origin), {
    method: 'POST', body: Uint8Array.from(bytes), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', ...headers },
  });
  if (!response.ok) throw new PermitError(response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing gateway response');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let json = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128_000) throw new Error('Gateway response too large');
      json += decoder.decode(value, { stream: true });
    }
    return fields(JSON.parse(json + decoder.decode()), ['data']).data;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function pairOverHttp(origin: string, workspaceId: string, pairingCode: string, platform: 'darwin' | 'win32',
  name: string, key: KeyObject, confirmation: { userInitiated: boolean; ownsDevice: boolean }, fetcher: typeof fetch = fetch) {
  const body = createPairingRequest(workspaceId, pairingCode, platform, name, key, confirmation);
  const { device_id } = fields(await postDeviceJson(apiOrigin(origin), '/api/v1/device/pair', Buffer.from(JSON.stringify(body)), fetcher, { 'x-smartsell-workspace': workspaceId }), ['device_id']);
  return opaqueId(device_id, 'device_id');
}

export function createSignedHttpTransport(origin: string, fetcher: typeof fetch = fetch): SignedDeviceTransport {
  const trustedOrigin = apiOrigin(origin);
  return async (action, bytes, signed, workspaceId) => {
    let path: string;
    if (Object.hasOwn(attemptPaths, action)) {
      const body = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
      const id = opaqueId(body.attempt_id, 'attempt_id');
      path = `/api/v1/attempts/${encodeURIComponent(id)}/${attemptPaths[action as keyof typeof attemptPaths]}`;
    } else {
      if (!Object.hasOwn(devicePaths, action)) throw new TypeError('Unknown device action');
      path = devicePaths[action as keyof typeof devicePaths];
    }
    return postDeviceJson(trustedOrigin, path, bytes, fetcher, {
      ...(workspaceId && { 'x-smartsell-workspace': workspaceId }),
      'x-smartsell-device': signed.device_id, 'x-smartsell-timestamp': signed.timestamp,
      'x-smartsell-nonce': signed.nonce, 'x-smartsell-signature': signed.signature,
    });
  };
}

function signature(key: KeyObject, bytes: Uint8Array): string {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new TypeError('Expected an Ed25519 device key');
  return sign(null, bytes, key).toString('base64url');
}
export function createPairingRequest(workspaceId: string, pairing_code: string, platform: 'darwin' | 'win32', name: string,
  key: KeyObject, confirmation: { userInitiated: boolean; ownsDevice: boolean }) {
  opaqueId(workspaceId, 'workspace_id');
  if (confirmation?.userInitiated !== true || confirmation?.ownsDevice !== true || !/^[A-Za-z0-9_-]{32}$/.test(pairing_code)
    || (platform !== 'darwin' && platform !== 'win32') || !name.trim() || name.trim() !== name || name.length > 100) throw new TypeError('Invalid pairing request');
  const public_key = exportDevicePublicKey(createPublicKey(key));
  const proof = signature(key, Buffer.from(JSON.stringify(['smartsell.pair.v1', workspaceId, pairing_code, public_key, platform, name])));
  return { pairing_code, public_key, platform, name, proof };
}
export class SignedDeviceClient implements SubmitPermitClient {
  constructor(private readonly workspaceId: string, private readonly deviceId: string, private readonly key: KeyObject,
    private readonly transport: SignedDeviceTransport, private readonly now: () => number = Date.now) {
    opaqueId(workspaceId, 'workspace_id');
    opaqueId(deviceId, 'device_id');
  }
  #send(action: DeviceAction, body: object) {
    const rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = new Date(this.now()).toISOString();
    const nonce = randomBytes(18).toString('base64url');
    const digest = createHash('sha256').update(rawBody).digest('hex');
    const bytes = Buffer.from(JSON.stringify(['smartsell.device.v1', this.workspaceId, this.deviceId, action, timestamp, nonce, digest]));
    return this.transport(action, rawBody, { device_id: this.deviceId, timestamp, nonce, signature: signature(this.key, bytes) }, this.workspaceId);
  }
  #assertScope(claim: ConnectorClaim) {
    if (claim.task.workspace_id !== this.workspaceId || claim.task.connector_device_id !== this.deviceId) throw new Error('Connector claim scope mismatch');
  }
  async #heartbeat(client_version: string, includeBindings: boolean, desktop = false) {
    if (!client_version.trim() || client_version.length > 80) throw new TypeError('Invalid client version');
    const reply = fields(await this.#send('heartbeat', {
      client_version, ...(includeBindings && { include_bindings: true }), ...(desktop && { include_browser_work: true, social_status_version: 1 }),
    }), ['status'], desktop ? ['bindings', 'browser_work', 'social_status_version'] : includeBindings ? ['bindings'] : []);
    if (reply.status !== 'online') throw new Error('Connector heartbeat failed');
    return reply;
  }
  async heartbeat(client_version: string) {
    await this.#heartbeat(client_version, false);
  }
  #bindingCounts(bindings: unknown): DeviceBindings | undefined {
    if (bindings === undefined) return;
    const { social, commerce } = fields(bindings, ['social', 'commerce']);
    return { social: bindingCounts(social), commerce: bindingCounts(commerce) };
  }
  async heartbeatWithBindings(client_version: string): Promise<DeviceBindings | undefined> {
    return this.#bindingCounts((await this.#heartbeat(client_version, true)).bindings);
  }
  async desktopHeartbeat(client_version: string) {
    const { bindings, browser_work, social_status_version } = await this.#heartbeat(client_version, true, true);
    const socialStatus = social_status_version === 1;
    const counts = this.#bindingCounts(bindings);
    if (browser_work === undefined) return { bindings: counts, socialStatus };
    const { pending_identity } = fields(browser_work, ['pending_identity']);
    if (!Array.isArray(pending_identity)) throw new TypeError('Invalid browser work');
    const pendingIdentity = pending_identity.flatMap(input => {
      const { session_id, binding_id, platform, identity } = fields(input, ['session_id', 'binding_id', 'platform', 'identity']);
      // Older bindings may predate the identity format used by signed task reports.
      let observed: string;
      try { observed = opaqueId(identity, 'identity'); }
      catch { return []; }
      return [{ sessionId: opaqueId(session_id, 'session_id'), bindingId: opaqueId(binding_id, 'binding_id'),
        platform: opaqueId(platform, 'platform'), identity: observed }];
    });
    return { bindings: counts, pendingIdentity, socialStatus };
  }
  async registerChannels(selections: readonly ChannelSelection[]): Promise<ChannelRegistration[]> {
    if (selections.length < 1 || selections.length > 20) throw new TypeError('Invalid channel selection count');
    const expected = new Map<string, Pick<ChannelSelection, 'kind' | 'platform' | 'external_id'>>();
    const rows = selections.map(({ kind, platform, external_id, observed_at, display_name, portal_url, profile_key, handle, automation_notice_version }) => {
      const identity = { kind, platform, external_id };
      const key = channelSelectionKey(identity);
      if ((kind !== 'social' && kind !== 'store') || !/^[a-z][a-z0-9_]{0,39}$/.test(platform) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.:/|+-]{0,159}$/.test(external_id) || expected.has(key) ||
        (profile_key !== undefined && !/^ch-[0-9a-f]{12}$/.test(profile_key)) ||
        (handle !== undefined && !/^[A-Za-z0-9_.]{1,64}$/.test(handle)) ||
        (automation_notice_version !== undefined && !/^[a-z0-9-]{1,80}$/.test(automation_notice_version))) throw new TypeError('Invalid channel selection');
      expected.set(key, identity);
      return { ...identity, observed_at: timestamp(observed_at, 'observed_at'), display_name, portal_url,
        ...(profile_key !== undefined && { profile_key }), ...(handle !== undefined && { handle }),
        ...(automation_notice_version !== undefined && { automation_notice_version }) };
    });
    const { registrations } = fields(await this.#send('channels.register', { confirmed: true, selections: rows }), ['registrations']);
    if (!Array.isArray(registrations) || registrations.length !== rows.length) throw new Error('Unexpected channel registrations');
    return registrations.map(item => {
      const row = fields(item, ['kind', 'platform', 'external_id', 'resource_id', 'device_id']);
      const key = JSON.stringify([row.kind, row.platform, row.external_id]);
      const identity = expected.get(key);
      if (!identity || row.device_id !== this.deviceId) throw new Error('Unexpected channel registration');
      expected.delete(key);
      return { ...identity, resource_id: opaqueId(row.resource_id, 'resource_id'), device_id: this.deviceId };
    });
  }
  async claim(bindingId?: string, channel?: 'browser'): Promise<ConnectorClaim | null> {
    const body = { ...(bindingId === undefined ? {} : { binding_id: opaqueId(bindingId, 'binding_id') }), ...(channel && { channel }) };
    const { claim } = fields(await this.#send('claim', body), ['claim']);
    if (claim === null) return null;
    const parsed = parseConnectorClaim(claim);
    this.#assertScope(parsed);
    if (channel && parsed.task.target.channel !== channel) throw new Error('Connector claim channel mismatch');
    return parsed;
  }
  async claimSocialStatus(): Promise<SocialStatusClaim | null> {
    const { claim } = fields(await this.#send('social.status.claim', {}), ['claim']);
    if (claim === null) return null;
    const parsed = parseSocialStatusClaim(claim);
    if (parsed.workspace_id !== this.workspaceId || parsed.device_id !== this.deviceId) throw new Error('Social status claim scope mismatch');
    return parsed;
  }
  async reportSocialStatus(claim: SocialStatusClaim, result: SocialStatusResult) {
    const { id, workspace_id, device_id, fencing_token } = parseSocialStatusClaim(claim);
    if (workspace_id !== this.workspaceId || device_id !== this.deviceId) throw new Error('Social status claim scope mismatch');
    const reply = fields(await this.#send('social.status.report', { id, fencing_token, result: parseSocialStatusResult(result, claim) }), ['id', 'status']);
    if (reply.id !== id || (reply.status !== 'completed' && reply.status !== 'blocked')) throw new Error('Unexpected social status acknowledgement');
    return reply.status;
  }
  async claimZhihuStats(): Promise<ZhihuStatsClaim | null> {
    const { claim } = fields(await this.#send('zhihu.stats.claim', {}), ['claim']);
    if (claim === null) return null;
    const row = fields(claim, ['id', 'workspace_id', 'device_id', 'fencing_token', 'lease_expires_at'], ['mode', 'profile_slug']);
    const { profile_slug, mode, fencing_token } = row;
    if (row.workspace_id !== this.workspaceId || row.device_id !== this.deviceId || typeof fencing_token !== 'number' ||
      !Number.isSafeInteger(fencing_token) || fencing_token < 1) throw new Error('Invalid Zhihu stats claim');
    const base = { id: opaqueId(row.id, 'id'), workspace_id: this.workspaceId, device_id: this.deviceId, fencing_token,
      lease_expires_at: timestamp(row.lease_expires_at, 'lease_expires_at') };
    if (mode === 'login_check' && !Object.hasOwn(row, 'profile_slug')) return { ...base, mode };
    if (!Object.hasOwn(row, 'mode') && typeof profile_slug === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(profile_slug)) {
      return { ...base, profile_slug };
    }
    throw new Error('Invalid Zhihu stats claim');
  }
  async reportZhihuStats(input: { id: string; fencing_token: number; result: ZhihuStatsResult | ZhihuLoginCheckResult }) {
    const id = opaqueId(input.id, 'id');
    if (!Number.isSafeInteger(input.fencing_token) || input.fencing_token < 1) throw new TypeError('Invalid fencing token');
    const { id: acknowledged, status } = fields(await this.#send('zhihu.stats.report', input), ['id', 'status']);
    if (acknowledged !== id || status !== input.result.status) throw new Error('Unexpected Zhihu stats acknowledgement');
    return { id, status };
  }
  async claimCatalog() {
    const { job } = fields(await this.#send('catalog.claim', {}), ['job']);
    if (job === null) return null;
    const row = fields(job, ['id', 'store_id', 'device_id', 'store_name', 'provider', 'external_store_id', 'claim_id', 'expires_at'], ['portal_url']);
    const device_id = opaqueId(row.device_id, 'device_id');
    if (device_id !== this.deviceId) throw new Error('商品任务未分配给此设备。');
    if (typeof row.store_name !== 'string' || !row.store_name.trim() || row.store_name.length > 256 ||
      typeof row.external_store_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/|+-]{0,159}$/.test(row.external_store_id) ||
      (row.portal_url != null && (typeof row.portal_url !== 'string' || row.portal_url.length > 2048))) throw new Error('商品任务中的店铺信息无效。');
    return {
      id: opaqueId(row.id, 'job_id'), store_id: opaqueId(row.store_id, 'store_id'), device_id,
      store_name: row.store_name, provider: opaqueId(row.provider, 'provider'), external_store_id: row.external_store_id,
      portal_url: typeof row.portal_url === 'string' ? row.portal_url : undefined,
      claim_id: opaqueId(row.claim_id, 'claim_id'), expires_at: timestamp(row.expires_at, 'expires_at'),
    };
  }
  async uploadCatalog(job: { id: string; claim_id: string }, observedStoreId: string, data: CatalogExport) {
    const file = data.csv === undefined ? { xlsx_base64: data.xlsx_base64 } : { csv: data.csv };
    const body = { job_id: job.id, claim_id: job.claim_id, observed_store_id: observedStoreId, confirmed: true, ...file };
    if (Buffer.byteLength(JSON.stringify(body)) > catalogBodyLimit) throw new Error('商品数据超过服务的请求大小限制，请分批导出。');
    const { import_id, status } = fields(await this.#send('catalog.upload', body), ['import_id', 'status']);
    if (status !== 'previewed') throw new Error('商品表尚未获得预览确认。');
    return { import_id: opaqueId(import_id, 'import_id'), status };
  }
  async reportAndroid(input: { hardware_id_hash: string; connection: 'usb' | 'lan'; model: string; serial_suffix: string; os_version: string; driver_version: string }) {
    const data = await this.#send('mobile.report', { ...input, platform: 'android', physical: true, emulator: false, cloud: false, connected: true, prerequisites_ready: true });
    const { status, mobile_device_id } = fields(data, ['status', 'mobile_device_id']);
    if (typeof status !== 'string') throw new Error('Unexpected mobile status');
    return { status, mobile_device_id: opaqueId(mobile_device_id, 'mobile_device_id') };
  }
  async reportIdentity(channel: 'browser' | 'mobile', sessionId: string, observedIdentity: string, pendingBindingId?: string) {
    const { status } = fields(await this.#send(channel === 'browser' ? 'browser.identity' : 'mobile.identity', {
      session_id: opaqueId(sessionId, 'session_id'), observed_platform_identity: opaqueId(observedIdentity, 'observed_platform_identity'),
      ...(pendingBindingId !== undefined && { pending_binding_id: opaqueId(pendingBindingId, 'pending_binding_id') }),
    }), ['status']);
    if (status !== 'verified' && status !== 'blocked') throw new Error('Unexpected identity status');
    return status;
  }
  async ready(claim: ConnectorClaim, observed_platform_identity: string) {
    this.#assertScope(claim);
    const { status } = fields(await this.#send('attempt.ready', { attempt_id: claim.task.attempt_id, fencing_token: claim.fencing_token,
      write_slot_token: claim.write_slot_token, observed_platform_identity }), ['status']);
    if (status !== 'verified') throw new PermitError(status === 'blocked' ? 409 : 502);
  }
  async request(input: SubmitPermitRequest) {
    const data = await this.#send('attempt.permit', input);
    if (data && typeof data === 'object' && 'decision' in data && data.decision === 'late') throw new PermitError(409);
    return parseSubmitPermitDecision(data);
  }
  async consume(input: ConsumePermitRequest) { return parseConsumePermitDecision(await this.#send('attempt.consume', input)); }
  report(report: Report) { return this.#send('attempt.report', report); }
}

// ---------- Phase 1 signed device protocol (§5.4, §6.6, §8.13, Appendix B.2) ----------
// The v2 client keeps the same Ed25519 request bytes as SignedDeviceClient but
// surfaces structured errors (code, Retry-After, Date) that the Worker runtime
// needs for its error table (§8.2). It never retries on its own.

/** Signed actions of the Phase 1 job protocol. Media and evidence embed their scope in the action string. */
export type DeviceProtocolAction = 'heartbeat' | 'jobs.claim' | 'jobs.report' | 'jobs.go' | 'driver_config.read' | 'channels.register'
  | `media.read:${string}:${string}:${number}` | `evidence.upload:${string}:${number}` | 'remote.next' | `remote.result:${string}`;

/** A non-2xx hub response. `details` carries extra fields of the error envelope (for example `expected` of SEQ_GAP). */
export class DeviceHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly details: Record<string, unknown>,
    readonly retryAfterMs: number | null, readonly serverDate: number | null) {
    super(`Hub rejected the device request (HTTP ${status}${code ? ` ${code}` : ''})`);
    this.name = 'DeviceHttpError';
  }
}
/** The hub could not be reached or did not answer in time. */
export class DeviceNetworkError extends Error {
  constructor(readonly kind: 'network' | 'timeout', options?: { cause?: unknown }) {
    super(kind === 'timeout' ? 'Hub request timed out' : 'Hub is unreachable', options);
    this.name = 'DeviceNetworkError';
  }
}

export function deviceSignatureHeaders(key: KeyObject, workspaceId: string, deviceId: string, action: string, rawBody: Uint8Array, nowMs: number) {
  const ts = new Date(nowMs).toISOString();
  const nonce = randomBytes(18).toString('base64url');
  const digest = createHash('sha256').update(rawBody).digest('hex');
  const bytes = Buffer.from(JSON.stringify(['smartsell.device.v1', workspaceId, deviceId, action, ts, nonce, digest]));
  return {
    'x-smartsell-workspace': workspaceId, 'x-smartsell-device': deviceId, 'x-smartsell-timestamp': ts,
    'x-smartsell-nonce': nonce, 'x-smartsell-signature': signature(key, bytes),
  };
}

export interface DeviceExchange<T> { data: T; sentAt: number; receivedAt: number; serverDate: number | null }

function retryAfter(value: string | null, now: number) {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
function serverDate(headers: Headers) {
  const value = headers.get('date');
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}
const responseLimit = 4 * 1024 * 1024;
async function readLimited(response: Response, limit = responseLimit) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Hub response too large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function httpError(response: Response, now: number) {
  let code: string | null = null;
  let details: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse((await readLimited(response, 64 * 1024)).toString('utf8')) as { error?: Record<string, unknown> };
    const error = parsed?.error;
    if (error && typeof error === 'object') {
      code = typeof error.code === 'string' ? error.code : null;
      const nested = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
      details = { ...nested, ...Object.fromEntries(Object.entries(error).filter(([name]) => name !== 'code' && name !== 'details')) };
    }
  } catch { /* A non-JSON error body still yields the HTTP status. */ }
  return new DeviceHttpError(response.status, code, details, retryAfter(response.headers.get('retry-after'), now), serverDate(response.headers));
}

export interface DeviceProtocolClientOptions {
  origin: string; workspaceId: string; deviceId: string; key: KeyObject;
  /** Hub-corrected time used for the signature timestamp (§8.2 clock). */
  now: () => number;
  /** Raw local time used to measure round trips; defaults to Date.now. */
  localNow?: () => number;
  fetch?: typeof fetch;
}

export class DeviceProtocolClient {
  readonly origin: string;
  readonly #fetch: typeof fetch;
  readonly #localNow: () => number;
  constructor(private readonly options: DeviceProtocolClientOptions) {
    this.origin = apiOrigin(options.origin);
    opaqueId(options.workspaceId, 'workspace_id');
    opaqueId(options.deviceId, 'device_id');
    this.#fetch = options.fetch ?? fetch;
    this.#localNow = options.localNow ?? Date.now;
  }

  get deviceId() { return this.options.deviceId; }
  get workspaceId() { return this.options.workspaceId; }

  async #call(method: 'GET' | 'POST' | 'PUT', path: string, action: DeviceProtocolAction, body: Uint8Array, timeoutMs: number,
    extra: Record<string, string> = {}, signal?: AbortSignal): Promise<{ response: Response; sentAt: number }> {
    const headers = { ...deviceSignatureHeaders(this.options.key, this.options.workspaceId, this.options.deviceId, action, body, this.options.now()), ...extra };
    const sentAt = this.#localNow();
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await this.#fetch(new URL(path, this.origin), {
        method, headers, redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        ...(method === 'GET' ? {} : { body: Uint8Array.from(body) }),
      });
      return { response, sentAt };
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DeviceNetworkError(timeout.aborted ? 'timeout' : 'network', { cause: error });
    }
  }

  async #json<T>(method: 'POST' | 'PUT', path: string, action: DeviceProtocolAction, payload: unknown, timeoutMs: number,
    raw?: { bytes: Uint8Array; headers: Record<string, string> }): Promise<DeviceExchange<T>> {
    const body = raw ? raw.bytes : Buffer.from(JSON.stringify(payload));
    const { response, sentAt } = await this.#call(method, path, action, body, timeoutMs,
      raw ? raw.headers : { 'content-type': 'application/json' });
    const receivedAt = this.#localNow();
    if (!response.ok) throw await httpError(response, receivedAt);
    let parsed: unknown;
    try { parsed = JSON.parse((await readLimited(response)).toString('utf8')); }
    catch (error) { throw new DeviceNetworkError('network', { cause: error }); }
    const data = parsed && typeof parsed === 'object' && 'data' in parsed ? (parsed as { data: T }).data : parsed as T;
    return { data, sentAt, receivedAt, serverDate: serverDate(response.headers) };
  }

  heartbeat(body: HeartbeatV2Request, timeoutMs = 10_000) {
    return this.#json<HeartbeatV2Response>('POST', '/api/v1/device/heartbeat', 'heartbeat', body, timeoutMs);
  }
  claim(body: ClaimRequest, timeoutMs = 10_000) {
    return this.#json<ClaimResponse>('POST', '/api/v1/device/jobs/claim', 'jobs.claim', body, timeoutMs);
  }
  report(body: JobReport, timeoutMs = 10_000) {
    return this.#json<{ status?: string }>('POST', '/api/v1/device/jobs/report', 'jobs.report', body, timeoutMs);
  }
  go(body: GoRequest, timeoutMs = 20_000) {
    return this.#json<GoResponse & { server_time?: string }>('POST', '/api/v1/device/jobs/go', 'jobs.go', body, timeoutMs);
  }
  /** E50 remote control: long poll for this machine's next command (the hub holds it up to wait_ms). */
  remoteNext(body: RemoteNextRequest, timeoutMs = 40_000) {
    return this.#json<RemoteNextResponse>('POST', '/api/v1/device/remote/next', 'remote.next', body, timeoutMs);
  }
  remoteResult(body: RemoteResultRequest, timeoutMs = 30_000) {
    opaqueId(body.command_id, 'command_id');
    return this.#json<{ accepted: boolean }>('POST', '/api/v1/device/remote/result', `remote.result:${body.command_id}`, body, timeoutMs);
  }
  registerChannels(selections: readonly ChannelSelection[], timeoutMs = 10_000) {
    return this.#json<{ registrations: ChannelRegistration[] }>('POST', '/api/v1/device/channels/register', 'channels.register',
      { confirmed: true, selections }, timeoutMs);
  }

  /** Signed media download (§6.6). Returns the open response (200 or 206); the caller streams the body. */
  async openMedia(fileId: string, jobId: string, fence: number, options: { start?: number; etag?: string; signal?: AbortSignal; timeoutMs?: number } = {}) {
    opaqueId(fileId, 'file_id');
    opaqueId(jobId, 'job_id');
    if (!Number.isSafeInteger(fence) || fence < 1) throw new TypeError('Invalid fencing token');
    const headers: Record<string, string> = { 'x-smartsell-job': jobId, 'x-smartsell-fence': String(fence) };
    if (options.start && options.start > 0) {
      headers.range = `bytes=${options.start}-`;
      if (options.etag) headers['if-range'] = options.etag;
    }
    const { response } = await this.#call('GET', `/api/v1/device/media/${encodeURIComponent(fileId)}`, `media.read:${fileId}:${jobId}:${fence}`,
      new Uint8Array(0), options.timeoutMs ?? 30_000, headers, options.signal);
    if (response.status !== 200 && response.status !== 206) throw await httpError(response, this.#localNow());
    return response;
  }

  /** Evidence upload (§8.13): raw JPEG/PNG bytes with PUT so the root guard accepts the body. */
  uploadEvidence(jobId: string, fence: number, bytes: Uint8Array, mime: 'image/jpeg' | 'image/png', timeoutMs = 30_000) {
    opaqueId(jobId, 'job_id');
    if (!Number.isSafeInteger(fence) || fence < 1) throw new TypeError('Invalid fencing token');
    if (bytes.byteLength > 4 * 1024 * 1024) throw new TypeError('Evidence exceeds 4 MiB');
    return this.#json<unknown>('PUT', `/api/v1/device/evidence/${encodeURIComponent(jobId)}`, `evidence.upload:${jobId}:${fence}`, undefined, timeoutMs,
      { bytes, headers: { 'content-type': mime, 'x-smartsell-fence': String(fence) } });
  }

  /** Selector data file (§8.11); served as a raw JSON file without the {data} envelope. */
  async driverConfig(timeoutMs = 10_000): Promise<DeviceExchange<Buffer>> {
    const { response, sentAt } = await this.#call('GET', '/api/v1/device/driver-config', 'driver_config.read', new Uint8Array(0), timeoutMs);
    const receivedAt = this.#localNow();
    if (!response.ok) throw await httpError(response, receivedAt);
    return { data: await readLimited(response, 1024 * 1024), sentAt, receivedAt, serverDate: serverDate(response.headers) };
  }
}
