import { waitForReportVersion, type ReportGenerationStatus } from './report-generation';

export type Payload = Record<string, unknown>;
export interface Entity {
  id: string;
  module: string;
  kind: string;
  data: Payload;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface Workspace { id: string; name: string; role: string }
export interface Session { user: { id: string; name?: string; email?: string }; workspaces: Workspace[] }
export interface Command { module: string; action: string }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? body?.code ?? 'http_error', body?.error?.message ?? body?.detail ?? '');
  if (body === null) throw new ApiError(response.status, 'invalid_response', '');
  return body as T;
}

const part = encodeURIComponent;
const workspace = (id: string) => `/workspaces/${part(id)}`;
export const api = {
  session: (signal?: AbortSignal) => request<Session>('/session', { signal }),
  signIn: (body: Payload) => request('/session', { method: 'POST', body: JSON.stringify(body) }),
  setup: (body: Payload, token?: string) => request('/setup', { method: 'POST', body: JSON.stringify(body), headers: token ? { 'X-Setup-Token': token } : undefined }),
  signOut: () => request('/session', { method: 'DELETE' }),
  commands: (id: string, signal?: AbortSignal) => request<{ items: Command[] }>(`${workspace(id)}/commands`, { signal }),
  permissionOperations: async (id: string, signal?: AbortSignal) => (await request<{ data: { name: string }[] }>(`${workspace(id)}/catalog`, { signal })).data,
  members: async <T>(id: string, signal?: AbortSignal) => (await request<{ data: T[] }>(`${workspace(id)}/members`, { signal })).data,
  saveMember: async (id: string, member: string | undefined, body: Payload) => {
    const { csrf_token } = await request<{ csrf_token: string }>('/session/csrf');
    const path = member ? `/members/${part(member)}/roles` : '/members/invite';
    return (await request<{ data: unknown }>(`${workspace(id)}${path}`, {
      method: member ? 'PATCH' : 'POST', body: JSON.stringify(body), headers: { 'X-CSRF-Token': csrf_token, 'Idempotency-Key': crypto.randomUUID() },
    })).data;
  },
  records: async (id: string, module: string, kind: string, signal?: AbortSignal) =>
    (await request<{ items: Entity[] }>(`${workspace(id)}/records/${part(module)}/${part(kind)}`, { signal })).items,
  async execute(id: string, command: Command, body: Payload, key: string, signal?: AbortSignal) {
    const { data } = await request<{ data: unknown }>(`${workspace(id)}/commands/${part(command.module)}/${part(command.action)}`, {
      method: 'POST', signal, body: JSON.stringify(body), headers: { 'Idempotency-Key': key },
    });
    const operationId = (data as Payload | null)?.operation_id;
    if (command.module !== 'analytics' || command.action !== 'reports_generate_version' || typeof operationId !== 'string') return data;
    const { version_id } = await waitForReportVersion(async () => (
      await request<{ data: ReportGenerationStatus }>(`${workspace(id)}/operations/${part(operationId)}`, { signal })
    ).data);
    return (await request<{ data: unknown }>(`${workspace(id)}/commands/analytics/reports_get`, {
      method: 'POST', signal, body: JSON.stringify({ version_id }), headers: { 'Idempotency-Key': crypto.randomUUID() },
    })).data;
  },
};

export function recordOptions(id: string, module: string, kind: string) {
  return {
    queryKey: ['workspace', id, 'records', module, kind],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.records(id, module, kind, signal),
  };
}

export interface Submission { body: Payload; key: string }
export function submission(body: Payload, previous?: Submission): Submission {
  return previous && JSON.stringify(previous.body) === JSON.stringify(body)
    ? previous : { body, key: crypto.randomUUID() };
}
