// Signed jobs.* client used by the Supervisor and JobRunner (§8.1). It wraps
// the v2 transport in apps/connector/src/device-client.ts, keeps the hub clock
// current and classifies every failure into the categories of §8.2.
import {
  DeviceHttpError, DeviceNetworkError, DeviceProtocolClient, type ChannelSelection, type ChannelRegistration, type DeviceExchange,
} from '../../../connector/src/device-client.ts';
import type { ClaimRequest, ClaimResponse, GoRequest, GoResponse, HeartbeatV2Request, HeartbeatV2Response, JobReport } from './contracts.ts';
import { parseServerTime, type HubClock } from './clock.ts';

export type HubErrorKind =
  | 'network'          // connection error or timeout: back off
  | 'server'           // HTTP 5xx: back off; 502/503/504 count as "hub down" for offline go
  | 'busy'             // 503 DEVICE_BUSY: honour Retry-After
  | 'device_revoked'   // 401 DEVICE_INACTIVE / INVALID_DEVICE_PROOF, any 403: stop the connection
  | 'proof_expired'    // 401 DEVICE_PROOF_EXPIRED after one clock-corrected retry
  | 'fence_lost'       // 409 JOB_FENCE_LOST
  | 'seq_gap'          // 409 SEQ_GAP {expected}
  | 'seq_conflict'     // 409 SEQ_CONFLICT
  | 'client';          // any other 4xx

export class HubError extends Error {
  constructor(readonly kind: HubErrorKind, message: string, readonly status: number | null = null, readonly code: string | null = null,
    readonly expected: number | null = null, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = 'HubError';
  }
  /** §5.7 rule 1: only connection errors, timeouts and 502/503/504 mean the hub is unreachable. */
  get unreachable() {
    return this.kind === 'network' || (this.status !== null && [502, 503, 504].includes(this.status) && this.code !== 'DEVICE_BUSY');
  }
}

const JOB_SCOPED_403 = new Set(['MEDIA_FORBIDDEN']);
/** §8.13: the hub stores evidence up to 4 MiB. */
export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;

export function classify(error: unknown): HubError {
  if (error instanceof HubError) return error;
  if (error instanceof DeviceNetworkError) return new HubError('network', error.message);
  if (error instanceof DeviceHttpError) {
    const { status, code } = error;
    const expected = typeof error.details.expected === 'number' ? error.details.expected : null;
    if (status === 503 && code === 'DEVICE_BUSY') return new HubError('busy', error.message, status, code, null, error.retryAfterMs);
    if (status >= 500) return new HubError('server', error.message, status, code, null, error.retryAfterMs);
    if (status === 401 && code === 'DEVICE_PROOF_EXPIRED') return new HubError('proof_expired', error.message, status, code);
    // Job-scoped refusals of a signed request (media.read of a job that ended or moved, S3 ledger 16): not a revoked device.
    if (status === 403 && code !== null && JOB_SCOPED_403.has(code)) return new HubError('client', error.message, status, code);
    if (status === 403 ||(status === 401 && (code === 'DEVICE_INACTIVE' || code === 'INVALID_DEVICE_PROOF'))) {
      return new HubError('device_revoked', error.message, status, code);
    }
    if (status === 401) return new HubError('device_revoked', error.message, status, code);
    if (status === 409 && code === 'JOB_FENCE_LOST') return new HubError('fence_lost', error.message, status, code);
    if (status === 409 && code === 'SEQ_GAP') return new HubError('seq_gap', error.message, status, code, expected);
    if (status === 409 && code === 'SEQ_CONFLICT') return new HubError('seq_conflict', error.message, status, code);
    return new HubError('client', error.message, status, code);
  }
  return new HubError('network', error instanceof Error ? error.message : String(error));
}

/** What the runtime needs from the hub; a fake implements it in unit tests. */
export interface HubApi {
  heartbeat(body: HeartbeatV2Request): Promise<HeartbeatV2Response>;
  claim(body: ClaimRequest): Promise<ClaimResponse>;
  report(body: JobReport): Promise<{ status: 'ok' | 'duplicate' }>;
  go(body: GoRequest): Promise<GoResponse>;
  openMedia(fileId: string, jobId: string, fence: number, options: { start?: number; etag?: string; signal?: AbortSignal }): Promise<Response>;
  uploadEvidence(jobId: string, fence: number, bytes: Uint8Array, mime: 'image/jpeg' | 'image/png'): Promise<void>;
  driverConfig(): Promise<Buffer>;
  registerChannels(selections: ChannelSelection[]): Promise<ChannelRegistration[] | unknown>;
}

export class HubProtocol implements HubApi {
  constructor(private readonly client: DeviceProtocolClient, private readonly clock: HubClock,
    private readonly timeouts: { request: number; go: number } = { request: 10_000, go: 20_000 }) {}

  /** Runs a signed call; on 401 DEVICE_PROOF_EXPIRED corrects the clock from Date and retries once (§8.2). */
  async #exchange<T>(call: () => Promise<DeviceExchange<T>>, bodyTime?: (data: T) => unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const exchange = await call();
        const fromBody = bodyTime ? parseServerTime(bodyTime(exchange.data)) : null;
        this.clock.observe(exchange.sentAt, exchange.receivedAt, fromBody ?? exchange.serverDate);
        return exchange.data;
      } catch (error) {
        const failure = classify(error);
        if (failure.kind === 'proof_expired' && attempt === 0 && error instanceof DeviceHttpError && this.clock.observeDate(error.serverDate)) continue;
        throw failure;
      }
    }
  }

  heartbeat(body: HeartbeatV2Request) {
    return this.#exchange(() => this.client.heartbeat(body, this.timeouts.request), data => data?.server_time);
  }
  claim(body: ClaimRequest) {
    return this.#exchange(() => this.client.claim(body, this.timeouts.request), data => data?.server_time);
  }
  async report(body: JobReport) {
    const data = await this.#exchange(() => this.client.report(body, this.timeouts.request));
    return { status: data && typeof data === 'object' && data.status === 'duplicate' ? 'duplicate' as const : 'ok' as const };
  }
  go(body: GoRequest) {
    return this.#exchange(() => this.client.go(body, this.timeouts.go), data => (data as { server_time?: string })?.server_time);
  }
  async openMedia(fileId: string, jobId: string, fence: number, options: { start?: number; etag?: string; signal?: AbortSignal }) {
    try { return await this.client.openMedia(fileId, jobId, fence, options); }
    catch (error) { if (options.signal?.aborted) throw error; throw classify(error); }
  }
  async uploadEvidence(jobId: string, fence: number, bytes: Uint8Array, mime: 'image/jpeg' | 'image/png') {
    // WA-4: a local refusal (size, ids) is final, not a network failure to retry forever.
    if (bytes.byteLength > EVIDENCE_MAX_BYTES) throw new HubError('client', 'Evidence exceeds 4 MiB', null, 'EVIDENCE_TOO_LARGE');
    await this.#exchange(() => {
      // The device client validates synchronously (ids, fence, size) before any request is made.
      let pending: Promise<DeviceExchange<unknown>>;
      try { pending = this.client.uploadEvidence(jobId, fence, bytes, mime, this.timeouts.request * 3); }
      catch (error) { throw new HubError('client', error instanceof Error ? error.message : String(error), null, 'EVIDENCE_INVALID'); }
      return pending;
    });
  }
  driverConfig() {
    return this.#exchange(() => this.client.driverConfig(this.timeouts.request));
  }
  async registerChannels(selections: ChannelSelection[]) {
    const data = await this.#exchange(() => this.client.registerChannels(selections, this.timeouts.request));
    return (data as { registrations?: ChannelRegistration[] })?.registrations ?? data;
  }
}
