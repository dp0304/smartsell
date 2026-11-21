import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Data } from '@smartsell/contracts';

const deliveryKinds = ['transaction', 'esp', 'crm', 'report'] as const;
export type SignedWebhookKind = typeof deliveryKinds[number];

/** Deployment configuration only. Omitting workspaceId explicitly grants tenant-wide use. */
export interface SignedWebhookTarget {
  id: string;
  tenantId: string;
  workspaceId?: string;
  kinds: readonly SignedWebhookKind[];
  url: string;
  signingKey: string | Uint8Array;
}

export interface SignedWebhookOptions {
  targets: readonly SignedWebhookTarget[];
  timeoutMs?: number;
  /** Optional deployment DNS policy returning a validated IPv4 address to pin for HTTPS. */
  resolveHttpsAddress?(hostname: string): Promise<string>;
  /** For offline testing. Only literal 127.0.0.1 and [::1] can use HTTP. */
  allowLoopbackHttp?: boolean;
}

/** Scope must come from an authenticated host context after domain and egress checks. */
export interface SignedWebhookDelivery {
  tenantId: string;
  workspaceId: string;
  targetId: string;
  kind: SignedWebhookKind;
  /** Durable ID for this logical delivery. Persist the data snapshot with it for retries. */
  eventId: string;
  eventType: string;
  data: Data;
}

interface AttemptEvidence {
  idempotencyKey: string;
  payloadSha256: string;
}

export type SignedWebhookResult =
  | { status: 'blocked'; reason: 'target_unavailable' | 'invalid_event' | 'payload_too_large' }
  | (AttemptEvidence & { status: 'delivered'; responseStatus: number; receiptId?: string })
  | (AttemptEvidence & { status: 'rejected'; responseStatus: number })
  | (AttemptEvidence & { status: 'unknown'; responseStatus: number; reason: 'ambiguous_response' })
  | (AttemptEvidence & { status: 'unknown'; responseStatus: null; reason: 'timeout' | 'transport_error' });

export interface SignedWebhookAdapter {
  deliver(event: SignedWebhookDelivery): Promise<SignedWebhookResult>;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && value.trim().length > 0;
}

function configuredUrl(value: string, allowLoopbackHttp: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid signed webhook target URL'); }
  const loopback = allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.hash) {
    throw new Error('Signed webhook targets must use HTTPS without credentials or fragments');
  }
  return url;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function signedBody(event: SignedWebhookDelivery, idempotencyKey: string): string {
  return JSON.stringify({
    id: event.eventId, type: event.eventType, data: event.data, kind: event.kind,
    tenant_id: event.tenantId, workspace_id: event.workspaceId, delivery_id: idempotencyKey,
  }, (_key, value: unknown) => {
    // Persisted JSON can come back with a different key order. Preserve array order.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return Object.fromEntries(entries);
    }
    return value;
  });
}

function prepare(event: SignedWebhookDelivery) {
  const idempotencyKey = sha256(JSON.stringify([event.tenantId, event.workspaceId, event.targetId, event.kind, event.eventId]));
  const body = signedBody(event, idempotencyKey);
  return { body, evidence: { idempotencyKey, payloadSha256: sha256(body) } };
}

/** Capture correlation metadata before handing an immutable delivery snapshot to the transport. */
export function signedWebhookEvidence(event: SignedWebhookDelivery): AttemptEvidence {
  return prepare(event).evidence;
}

function post(url: URL, body: string, key: Buffer, evidence: AttemptEvidence, timeoutMs: number,
  resolveAddress?: SignedWebhookOptions['resolveHttpsAddress']): Promise<SignedWebhookResult> {
  return new Promise((resolve) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const signature = createHmac('sha256', key).update(body).digest('hex');
    const req = send(url, {
      method: 'POST', agent: false, signal, maxHeaderSize: 16_384,
      ...(url.protocol === 'https:' && resolveAddress ? {
        family: 4, autoSelectFamily: false,
        lookup: (hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
          void resolveAddress(hostname).then(address => callback(null, address, 4), () => callback(new Error('Webhook endpoint is unavailable'), '', 4));
        },
      } : {}),
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Idempotency-Key': evidence.idempotencyKey, 'X-SmartSell-Signature': `sha256=${signature}`,
      },
    }, response => {
      const responseStatus = response.statusCode!;
      if (responseStatus >= 200 && responseStatus < 300) {
        const receipt = response.headers['x-smartsell-receipt-id'];
        const receiptId = typeof receipt === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(receipt) ? receipt : undefined;
        resolve({ ...evidence, status: 'delivered', responseStatus, ...(receiptId ? { receiptId } : {}) });
      } else if (responseStatus >= 400 && responseStatus < 500 && ![408, 409, 425, 429, 499].includes(responseStatus)) {
        resolve({ ...evidence, status: 'rejected', responseStatus });
      } else {
        resolve({ ...evidence, status: 'unknown', responseStatus, reason: 'ambiguous_response' });
      }
      // HTTP status is the transport observation. Never follow Location or read untrusted response bodies.
      response.destroy();
    });
    const transportError = () => resolve({ ...evidence, status: 'unknown', responseStatus: null,
      reason: signal.aborted ? 'timeout' : 'transport_error' });
    req.once('error', transportError);
    req.once('close', transportError);
    req.end(body);
  });
}

/** A single HTTP attempt. A 2xx acknowledges receipt only. Reconcile unknown outcomes before replay. */
export function createSignedWebhookAdapter(options: SignedWebhookOptions): SignedWebhookAdapter {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Invalid signed webhook timeout');
  const targets = new Map<string, Map<string, { workspaceId?: string; kinds: Set<SignedWebhookKind>; url: URL; key: Buffer }>>();
  for (const target of options.targets) {
    if (!isIdentifier(target.tenantId) || !isIdentifier(target.id) ||
        (target.workspaceId !== undefined && !isIdentifier(target.workspaceId)) || !target.kinds.length ||
        target.kinds.some(kind => !deliveryKinds.includes(kind))) throw new Error('Invalid signed webhook target scope');
    const tenantTargets = targets.get(target.tenantId) ?? new Map();
    if (tenantTargets.has(target.id)) throw new Error('Duplicate signed webhook target ID in tenant');
    const key = typeof target.signingKey === 'string' ? Buffer.from(target.signingKey, 'utf8') : Buffer.from(target.signingKey);
    if (!key.length) throw new Error('Missing signed webhook signing key');
    tenantTargets.set(target.id, { workspaceId: target.workspaceId, kinds: new Set(target.kinds),
      url: configuredUrl(target.url, options.allowLoopbackHttp === true), key });
    targets.set(target.tenantId, tenantTargets);
  }

  return {
    async deliver(event) {
      if (!isIdentifier(event.tenantId) || !isIdentifier(event.workspaceId) || !isIdentifier(event.targetId) ||
          !isIdentifier(event.eventId) || !isIdentifier(event.eventType) || !deliveryKinds.includes(event.kind) ||
          !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return { status: 'blocked', reason: 'invalid_event' };
      const target = targets.get(event.tenantId)?.get(event.targetId);
      if (!target || (target.workspaceId !== undefined && target.workspaceId !== event.workspaceId) || !target.kinds.has(event.kind)) {
        return { status: 'blocked', reason: 'target_unavailable' };
      }
      let prepared: ReturnType<typeof prepare>;
      try { prepared = prepare(event); } catch { return { status: 'blocked', reason: 'invalid_event' }; }
      const { body, evidence } = prepared;
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) return { status: 'blocked', reason: 'payload_too_large' };
      return post(target.url, body, target.key, evidence, timeoutMs, options.resolveHttpsAddress);
    },
  };
}
