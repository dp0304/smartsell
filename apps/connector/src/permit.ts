import { fields, opaqueId, parseChoice, positiveInteger, sha256, timestamp } from '../../../packages/connector-tasks/src/index.ts';

export const denyReasons = ['outside_window', 'daily_cap', 'emergency_halt', 'auto_stopped', 'terms_version_outdated'] as const;
export type PermitDenied = { decision: 'denied'; deny_reason: typeof denyReasons[number] };
export type SubmitPermitDecision = PermitDenied
  | { decision: 'granted'; permit_id: string; expires_at: string }
  | { decision: 'deferred'; deny_reason: 'min_interval' | 'hourly_cap'; retry_at: string };
export type ConsumePermitDecision = PermitDenied | { decision: 'granted' };
export type SubmitPermitRequest = { attempt_id: string; fencing_token: number; write_slot_token: number; request_hash: string };
export type ConsumePermitRequest = SubmitPermitRequest & { permit_id: string };
export interface SubmitPermitClient {
  request(request: SubmitPermitRequest): Promise<SubmitPermitDecision>;
  consume(request: ConsumePermitRequest): Promise<ConsumePermitDecision>;
}
export class PermitError extends Error {
  constructor(readonly status: number) { super(`Connector permit unavailable (HTTP ${status})`); this.name = 'PermitError'; }
}
function parseDenied(data: unknown): PermitDenied {
  const row = fields(data, ['decision', 'deny_reason'], ['halt_source']);
  return { decision: 'denied', deny_reason: parseChoice(row.deny_reason, denyReasons, 'deny_reason') };
}
export function parseSubmitPermitDecision(data: unknown): SubmitPermitDecision {
  const row = fields(data, ['decision'], ['deny_reason', 'halt_source', 'retry_at', 'permit_id', 'expires_at']);
  switch (row.decision) {
    case 'denied': return parseDenied(data);
    case 'granted':
      fields(data, ['decision', 'permit_id', 'expires_at']);
      return { decision: 'granted', permit_id: opaqueId(row.permit_id, 'permit_id'), expires_at: timestamp(row.expires_at, 'expires_at') };
    case 'deferred':
      fields(data, ['decision', 'deny_reason', 'retry_at']);
      return { decision: 'deferred', deny_reason: parseChoice(row.deny_reason, ['min_interval', 'hourly_cap'], 'deny_reason'), retry_at: timestamp(row.retry_at, 'retry_at') };
    default: throw new PermitError(502);
  }
}
export function parseConsumePermitDecision(data: unknown): ConsumePermitDecision {
  const row = fields(data, ['decision'], ['deny_reason', 'halt_source']);
  if (row.decision === 'denied') return parseDenied(data);
  fields(data, ['decision']);
  if (row.decision !== 'granted') throw new PermitError(502);
  return { decision: 'granted' };
}

type PermitTransport = (path: string, body: string) => Promise<unknown>;
export class TransportSubmitPermitClient implements SubmitPermitClient {
  constructor(private readonly transport: PermitTransport) {}
  private send(input: SubmitPermitRequest | ConsumePermitRequest, consume: boolean) {
    const attempt = opaqueId(input.attempt_id, 'attempt_id');
    const body = {
      fencing_token: positiveInteger(input.fencing_token, 'fencing_token'),
      write_slot_token: positiveInteger(input.write_slot_token, 'write_slot_token'),
      request_hash: sha256(input.request_hash, 'request_hash'),
      ...(consume ? { permit_id: opaqueId('permit_id' in input ? input.permit_id : undefined, 'permit_id') } : {}),
    };
    return this.transport(`/api/v1/attempts/${encodeURIComponent(attempt)}/submit-permit${consume ? '/consume' : ''}`, JSON.stringify(body));
  }
  async request(input: SubmitPermitRequest) { return parseSubmitPermitDecision(await this.send(input, false)); }
  async consume(input: ConsumePermitRequest) { return parseConsumePermitDecision(await this.send(input, true)); }
}
export class HttpSubmitPermitClient extends TransportSubmitPermitClient {
  constructor(origin: string, bearer: () => string, fetcher: typeof fetch = fetch) {
    const url = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new TypeError('Expected an HTTPS API origin or a loopback HTTP API origin');
    }
    super(async (path, body) => {
      const token = bearer();
      if (!/^[A-Za-z0-9._~+\/=-]{1,4096}$/.test(token)) throw new PermitError(401);
      const response = await fetcher(new URL(path, url.origin), {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new PermitError(response.status);
      const envelope = fields(await response.json(), ['data']);
      return envelope.data;
    });
  }
}
