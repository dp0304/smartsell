import { ApiError, asRecord, params, type Envelope, type RecordData } from './shared.js';

export { ApiError, asRecord, bindPath, type Envelope, type RecordData } from './shared.js';
export { callWorkspace, getWorkspaceOpenApi, type WorkspaceOpenApiDocument } from './workspace-api.js';

export interface Session {
  user: { id?: string; name?: string; email?: string; username?: string; locale?: string };
  workspaces: { id: string; name: string; locale?: string; role?: string }[];
  csrf_token?: string;
}
export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface Operation {
  module: string;
  name: string;
  method: Method;
  path: string;
  summary?: string;
  versionKind?: string;
  version_kind?: string;
  requires_if_match?: boolean;
  requires_version?: boolean;
  compatibility_command?: { action: string; fields: string[]; requires_version: boolean };
}

const methods = new Set<string>(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

export function workspacePath(id: string) {
  return `/api/v1/workspaces/${encodeURIComponent(id)}`;
}

export function operationPath(op: Operation, ws: string): string | undefined {
  if (typeof op.path !== 'string' || typeof op.method !== 'string' || !methods.has(op.method)) return;
  let path = op.path.split('?')[0];
  const workspacePrefix = /^\/api\/v1\/workspaces\/(?:\{(?:ws|workspace_id)\}|:(?:ws|workspace_id))(?=\/|$)/;
  path = path.replace(workspacePrefix, workspacePath(ws));
  if (path.startsWith('/api/')) {
    const base = workspacePath(ws);
    if (path !== base && !path.startsWith(`${base}/`)) return;
    path = path.slice(base.length) || '/';
  }
  if (!/^\/[\w/{}:-]*$/.test(path) || path.includes('//')) return;
  return path.length > 1 ? path.replace(/\/$/, '') : path;
}

export function operationKey(path: string) {
  return path.replace(params, ':');
}

export function parameterNames(path: string) {
  return Array.from(new Set(Array.from(path.matchAll(params), match => (match[1] ?? match[2])!)));
}

export function rows(value: unknown): RecordData[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

interface RequestOptions {
  method?: Method;
  body?: RecordData | FormData;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
  csrf?: string;
  setupToken?: string;
  version?: string | number;
  key?: string;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json, application/problem+json' });
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  if (method !== 'GET') {
    headers.set('Idempotency-Key', options.key ?? crypto.randomUUID());
    if (options.setupToken) headers.set('X-Setup-Token', options.setupToken);
    if (options.csrf) headers.set('X-CSRF-Token', options.csrf);
    if (options.version !== undefined && options.version !== '') {
      const version = String(options.version);
      headers.set('If-Match', version.startsWith('"') ? version : `"${version}"`);
    }
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== '') query.set(key, value);
  const response = await fetch(query.size ? `${path}?${query}` : path, {
    method, body, headers, credentials: 'same-origin', signal: options.signal, redirect: 'error', cache: 'no-store',
  });
  if (response.status === 204) return { data: undefined as T };
  const payload = asRecord(await response.json().catch(() => null));
  if (!response.ok) throw new ApiError(response.status, { ...asRecord(payload.error), ...payload });
  if (path === '/api/v1/session/csrf' && method === 'GET' && typeof payload.csrf_token === 'string') return { data: payload as T };
  if ((path === '/api/v1/session' || path === '/api/v1/setup') && !Object.hasOwn(payload, 'data') &&
      payload.user && Array.isArray(payload.workspaces)) return { data: payload as T };
  if (!Object.hasOwn(payload, 'data')) throw new ApiError(502, { code: 'INVALID_RESPONSE' });
  const envelope = { ...(payload as unknown as Envelope<T>), etag: response.headers.get('etag') ?? (typeof payload.etag === 'string' ? payload.etag : undefined) };
  return method === 'GET' ? unwrapPage(envelope) : envelope;
}

function unwrapPage<T>(envelope: Envelope<T>): Envelope<T> {
  const page = asRecord(envelope.data);
  return Array.isArray(page.data) && (page.next_cursor === null || typeof page.next_cursor === 'string')
    ? { ...envelope, data: page.data as T, next_cursor: page.next_cursor } : envelope;
}

export async function requestCompatibilityOperation<T>(ws: string, op: Operation, values: string[], options: RequestOptions) {
  const command = op.compatibility_command;
  if (!command || !/^operation_[a-z0-9_]+$/.test(command.action)) return;
  const names = parameterNames(op.path);
  if (names.length > 1 || (names.length && names[0] !== 'id')) return;
  if (command.requires_version && !options.version) return;
  const fields = op.method === 'GET' ? options.query ?? {} : options.body ?? {};
  if (fields instanceof FormData || Object.keys(fields).some(key => !command.fields.includes(key))) return;
  const result = await request<T>(`${workspacePath(ws)}/commands/${encodeURIComponent(op.module)}/${command.action}`, {
    ...options, method: 'POST', query: undefined, body: { ...(names.length && { id: values[0] }), fields },
  });
  return op.method === 'GET' ? unwrapPage(result) : result;
}

export async function readSession(signal?: AbortSignal): Promise<Envelope<Session | null>> {
  const result = await request<Session | null>('/api/v1/session', { signal });
  const session = result.data;
  if (!session?.user || session.csrf_token) return result;
  try {
    const { data } = await request<{ csrf_token?: string }>('/api/v1/session/csrf', { signal });
    return { ...result, data: { ...session, csrf_token: data?.csrf_token } };
  } catch (error) {
    if (error instanceof ApiError && [404, 405].includes(error.status)) return result;
    throw error;
  }
}

export interface SetupStatus {
  initialized: boolean;
  token_required: boolean;
  registration_enabled: boolean;
  password_min_length?: number;
}

export async function readSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
  const { data } = await request<SetupStatus>('/api/v1/setup/status', { signal });
  if (typeof data?.initialized !== 'boolean' || typeof data.token_required !== 'boolean' || typeof data.registration_enabled !== 'boolean') {
    throw new ApiError(502, { code: 'INVALID_RESPONSE' });
  }
  const { password_min_length: minimum, ...status } = data;
  return typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum > 0
    ? { ...status, password_min_length: minimum } : status;
}

export function signIn(input: { email: string; password: string } | { username: string; password: string }) {
  return request<unknown>('/api/v1/session', { method: 'POST', body: input });
}

export async function setupWorkspace(input: RecordData, setupToken?: string) {
  if (typeof input.username === 'string') {
    return request<Session>('/api/v1/setup', {
      method: 'POST', setupToken: setupToken?.trim(), body: { username: input.username.trim(), password: input.password },
    });
  }
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const workspace = input.workspace_name ?? input.workspaceName;
  const workspaceName = typeof workspace === 'string' ? workspace.trim() : '';
  const displayName = typeof input.name === 'string' ? input.name.trim() : '';
  const name = displayName || email.split('@')[0].slice(0, 120);
  return request<Session>('/api/v1/setup', {
    method: 'POST', setupToken: setupToken?.trim(), body: { email, password: input.password, name, workspaceName },
  });
}
