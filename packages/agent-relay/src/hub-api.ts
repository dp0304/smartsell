import { boundedText, validateHubOrigin } from './hub-connection.ts';
import { ToolError } from './errors.ts';

/** An error answer from the upload API, with the hub's code. */
export class HubApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HubApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface UploadConfig { max_upload_bytes: number; chunk_bytes: number; max_chunks_per_part: number; accepted_mime: string[] }
export interface UploadMedia {
  media_id: string; status: string; kind: 'video' | 'image'; mime: string; bytes: number | null; sha256: string; filename: string;
  duration_ms: number | null; width: number | null; height: number | null;
}
export interface UploadSessionView {
  upload_id: string | null; media_id: string; status: 'receiving' | 'assembling' | 'processing' | 'ready' | 'failed';
  chunk_bytes: number; chunks: number; received: number[]; bytes_received?: number; expires_at: string | null;
  bytes?: number; sha256?: string; mime?: string; filename?: string;
  error?: { code: string; message: string } | null; deduplicated?: boolean; media?: UploadMedia | null;
}

export const NETWORK_ERROR = 'HUB_UNREACHABLE';

/** A failure worth retrying with the same request: no answer, the hub restarting (5xx), a timeout or rate limit (§6.3 step 7). */
export const transientHubError = (error: unknown) => error instanceof HubApiError &&
  (error.code === NETWORK_ERROR || error.status >= 500 || error.status === 408 || error.status === 429);

export interface HubApiOptions { hubOrigin: string; token: string; fetch?: typeof fetch }

/** Client for /api/v1/agent/uploads* (§6.4). Never follows redirects; no proxies (Node fetch ignores proxy variables). */
export function createHubApi({ hubOrigin, token, fetch: request = fetch }: HubApiOptions) {
  const origin = validateHubOrigin(hubOrigin);
  async function call<T>(method: string, path: string, options: { json?: unknown; body?: Uint8Array; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...options.headers };
    let body: BodyInit | undefined;
    if (options.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.json); }
    else if (options.body) { headers['content-type'] = 'application/octet-stream'; body = options.body as unknown as BodyInit; }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try { response = await request(new URL(path, origin), { method, headers, body, redirect: 'manual', signal }); }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw new HubApiError(0, NETWORK_ERROR, 'The SmartSell hub is not reachable.');
    }
    const text = await boundedText(response, 1024 * 1024).catch(() => '');
    let value: unknown;
    try { value = text ? JSON.parse(text) : undefined; } catch { value = undefined; }
    if (response.status >= 200 && response.status < 300 && value && typeof value === 'object') return value as T;
    const error = (value as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
    throw new HubApiError(response.status, typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`,
      typeof error?.message === 'string' ? error.message : `SmartSell returned HTTP ${response.status}.`,
      error?.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : undefined);
  }
  const path = (id: string) => `/api/v1/agent/uploads/${encodeURIComponent(id)}`;
  return {
    origin,
    config: () => call<UploadConfig>('GET', '/api/v1/agent/uploads/config'),
    create: (input: { filename: string; bytes: number; sha256: string; mime: string; title?: string }) => call<UploadSessionView>('POST', '/api/v1/agent/uploads', { json: input }),
    status: (id: string, signal?: AbortSignal) => call<UploadSessionView>('GET', path(id), { signal }),
    putPart: (id: string, n: number, bytes: Uint8Array, sha256: string, signal?: AbortSignal) => call<{ received: number[] }>('PUT', `${path(id)}/parts/${n}`,
      { body: bytes, headers: { 'x-part-sha256': sha256 }, timeoutMs: 130_000, signal }),
    complete: (id: string, signal?: AbortSignal) => call<{ status: string }>('POST', `${path(id)}/complete`, { json: {}, signal }),
    abort: (id: string, reason: 'file_changed' | 'cancelled' | 'error', signal?: AbortSignal) => call<{ status: string }>('POST', `${path(id)}/abort`, { json: { reason }, signal }),
  };
}
export type HubApi = ReturnType<typeof createHubApi>;

/** Map an upload API failure to the tool error the model sees. */
export function toolErrorFromHub(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof HubApiError) {
    if (error.code === NETWORK_ERROR) return new ToolError(NETWORK_ERROR, 'The SmartSell hub is not reachable. Retry media_upload in a moment.',
      { owner_message: '目前連不上 SmartSell 中樞。請確認中樞電腦開著、Tailscale 已連線，再請 Agent 重試。' });
    if (error.status === 401) return new ToolError('UNAUTHENTICATED', 'SmartSell rejected this connection. Ask the owner to reconnect the agent in SmartSell.',
      { owner_message: 'SmartSell 拒絕了這個 Agent 連線（可能已撤銷或到期）。請在 SmartSell App 或網頁重新連接 Codex／Claude Code。' });
    return new ToolError(error.code, error.message, error.details);
  }
  return new ToolError('MEDIA_FAILED', (error as Error)?.message || 'Upload failed.');
}
