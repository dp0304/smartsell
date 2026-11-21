import { ApiError, type Payload } from './workbench-api';

export interface SavedView {
  id: string;
  version: number;
  name: string;
  resource_type: string;
  filters: Payload;
  owner_id: string;
  shared: boolean;
}

const pathFor = (wid: string) => `/workspaces/${encodeURIComponent(wid)}/saved-views`;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? body?.code ?? 'http_error', body?.error?.message ?? body?.detail ?? '');
  if (body === null) throw new ApiError(response.status, 'invalid_response', '');
  return body as T;
}

export async function listSavedViews(wid: string, signal: AbortSignal) {
  const views: SavedView[] = [];
  const query = new URLSearchParams({ limit: '200' });
  while (true) {
    const page = await request<{ data: SavedView[]; next_cursor?: string | null }>(`${pathFor(wid)}?${query}`, { signal });
    views.push(...page.data);
    if (!page.next_cursor) return views;
    query.set('cursor', page.next_cursor);
  }
}

export async function saveView(wid: string, body: Payload, key: string, current?: SavedView) {
  const { csrf_token } = await request<{ csrf_token: string }>('/session/csrf');
  const headers = new Headers({ 'X-CSRF-Token': csrf_token, 'Idempotency-Key': key });
  if (current) headers.set('If-Match', `"${current.version}"`);
  const path = current ? `${pathFor(wid)}/${encodeURIComponent(current.id)}` : pathFor(wid);
  return (await request<{ data: SavedView }>(path, {
    method: current ? 'PATCH' : 'POST', headers, body: JSON.stringify(body),
  })).data;
}
