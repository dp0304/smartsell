import { workspaceApiPrefix, workspaceDtos, workspaceOpenApiFile, type WorkspaceDtoInput, type WorkspaceDtoName, type WorkspaceDtoOutput } from '@smartsell/contracts';
import { ApiError, asRecord, bindPath, type Envelope } from './shared.js';

export interface WorkspaceOpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

interface TransportOptions {
  /** Explicit deployment origin for Node clients. Browser callers can use the current origin. */
  origin?: string;
  auth?: { bearer: string } | { csrf?: string; cookie?: string };
  fetch?: typeof fetch;
}
interface CallOptions extends TransportOptions {
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined>;
  version?: string | number;
  idempotencyKey?: string;
}
type InputOptions<N extends WorkspaceDtoName> = CallOptions &
  ((typeof workspaceDtos)[N] extends { bodyRequired: true } ? { body: WorkspaceDtoInput<N> } : { body?: WorkspaceDtoInput<N> }) &
  ((typeof workspaceDtos)[N]['path'] extends `${string}/:id${string}` ? { params: { id: string } } : { params?: never });

function deploymentPath(path: string, origin?: string) {
  if (!origin) return path;
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.href !== `${url.origin}/` || url.username || url.password) {
    throw new TypeError('Expected a SmartSell HTTP(S) origin');
  }
  return `${url.origin}${path}`;
}

async function send(path: string, method: string, options: CallOptions & { body?: unknown }) {
  const headers = new Headers({ Accept: 'application/json, application/problem+json' });
  const auth = options.auth;
  if (auth && 'bearer' in auth) headers.set('Authorization', `Bearer ${auth.bearer}`);
  else if (auth?.cookie) headers.set('Cookie', auth.cookie);
  let body: string | undefined;
  if (method !== 'GET') {
    if (auth && 'csrf' in auth && auth.csrf) headers.set('X-CSRF-Token', auth.csrf);
    if (options.version !== undefined) headers.set('If-Match', String(options.version));
    headers.set('Idempotency-Key', options.idempotencyKey ?? crypto.randomUUID());
    if (method === 'POST' || options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body ?? {});
    }
  }
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(options.query ?? {})) if (value !== undefined) query.set(name, String(value));
  const url = deploymentPath(path, options.origin);
  const response = await (options.fetch ?? fetch)(query.size ? `${url}?${query}` : url, {
    method, body, headers, credentials: auth && 'bearer' in auth ? 'omit' : 'same-origin',
    cache: 'no-store', redirect: 'error', signal: options.signal,
  });
  const payload = asRecord(await response.json().catch(() => null));
  if (!response.ok) throw new ApiError(response.status, { ...asRecord(payload.error), ...payload });
  return { response, payload };
}

function bindWorkspace(workspaceId: string) {
  return bindPath(`${workspaceApiPrefix}/:ws`, { ws: workspaceId });
}

export async function getWorkspaceOpenApi(workspaceId: string, options: TransportOptions & { signal?: AbortSignal } = {}): Promise<WorkspaceOpenApiDocument> {
  const { payload } = await send(`${bindWorkspace(workspaceId)}/${workspaceOpenApiFile}`, 'GET', options);
  const info = asRecord(payload.info);
  if (payload.openapi !== '3.1.0' || !payload.paths || typeof payload.paths !== 'object' || Array.isArray(payload.paths) ||
      typeof info.title !== 'string' || typeof info.version !== 'string') {
    throw new ApiError(502, { code: 'INVALID_OPENAPI_DOCUMENT' });
  }
  return payload as unknown as WorkspaceOpenApiDocument;
}

/** Execute a built-in typed DTO. Downloaded OpenAPI metadata is never executed. */
export async function callWorkspace<N extends WorkspaceDtoName>(name: N, workspaceId: string,
  options: InputOptions<NoInfer<N>>): Promise<Envelope<WorkspaceDtoOutput<N>> & { status: number }> {
  const dto = workspaceDtos[name];
  if ('input' in dto && (options.body !== undefined || ('bodyRequired' in dto && dto.bodyRequired)) && !dto.input.safeParse(options.body).success) {
    throw new ApiError(422, { code: 'INVALID_WORKSPACE_INPUT' });
  }
  const path = bindPath(dto.path, options.params ?? {});
  const { response, payload } = await send(`${bindWorkspace(workspaceId)}${path}`, dto.method, options);
  // Older Campaign servers return the page nested inside the REST envelope.
  const page = name === 'campaign_list' && !Array.isArray(payload.data) ? asRecord(payload.data) : payload;
  const parsed = dto.output.safeParse(page.data);
  const cursor = page.next_cursor;
  if (!parsed.success || (Array.isArray(parsed.data) && cursor !== null && typeof cursor !== 'string')) {
    throw new ApiError(502, { code: 'INVALID_WORKSPACE_RESPONSE' });
  }
  return { data: parsed.data as WorkspaceDtoOutput<N>, status: response.status, etag: response.headers.get('etag') ?? undefined,
    ...(Array.isArray(parsed.data) && { next_cursor: cursor as string | null }) };
}
