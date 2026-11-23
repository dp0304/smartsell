import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError, type Session } from '@smartsell/sdk';
import { viewKey } from '../data/keys';
import { ViewContext } from '../data/use-view';
import { dismissSetup, saveSetupNavigation } from './setup-data';

const storage = new Map<string, string>();
const globals = globalThis as unknown as { localStorage?: unknown; document?: unknown };
globals.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
globals.document ??= { documentElement: {} };
registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });

const ws = 'w1';
const base = `/app/${ws}`;
const keys = {
  presence: viewKey(ws, '/views/agent-presence'),
  connections: viewKey(ws, '/agent-connections'),
  devices: viewKey(ws, '/devices'),
  sessions: viewKey(ws, '/browser-sessions'),
  stores: viewKey(ws, '/stores', {}, true),
  products: viewKey(ws, '/products', { status: 'active' }),
  catalog: viewKey(ws, '/worker-catalog'),
};
const client = () => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, retryOnMount: false } } });

async function render(queryClient: QueryClient, role = 'owner', entry: string | { pathname: string; state: unknown } = base, user = 'u1') {
  const { SetupLanding } = await import('./setup-landing');
  const workspace = { id: ws, name: 'Shop', role };
  const session: Session = { user: { id: user }, workspaces: [workspace] };
  return renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[entry]}>
    <ViewContext.Provider value={{ ws, base, session, workspace }}><Routes><Route element={<SetupLanding />}>
      <Route path={`${base}/*`} element={<h1>Dashboard content</h1>} />
    </Route></Routes></ViewContext.Provider>
  </MemoryRouter></QueryClientProvider>);
}

function placeholderReads(queryClient: QueryClient) {
  queryClient.setQueryData(viewKey(ws, '/brands'), { data: [{ id: 'default', status: 'active', name: 'Default brand' }] });
  queryClient.setQueryData(keys.presence, { data: { connections: 1, last_seen_at: null } });
  queryClient.setQueryData(keys.connections, { data: [{ id: 'issued', revoked: false, last_used_at: null }] });
  queryClient.setQueryData(keys.devices, { data: [{ id: 'pending', status: 'active', online: false }] });
  queryClient.setQueryData(keys.sessions, { data: [{ id: 'unverified', device_id: 'pending', status: 'pending_identity' }] });
  queryClient.setQueryData(keys.stores, { data: [{ id: 'draft', status: 'import_only', external_store_id: 'shop' }] });
  queryClient.setQueryData(keys.products, { data: [{ id: 'draft', status: 'draft', store_id: 'draft', title: 'Draft' }] });
}

test('an administrator sees actionable status after a denied read and can continue once it recovers', async () => {
  const queryClient = client();
  const loading = await render(queryClient, 'admin');
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(loading, /Dashboard content/);
  placeholderReads(queryClient);
  const denied = new ApiError(403, { code: 'FORBIDDEN' });
  await assert.rejects(queryClient.fetchQuery({ queryKey: keys.catalog, queryFn: async () => { throw denied; } }), denied);
  const blocked = await render(queryClient, 'admin');
  assert.match(blocked, /role="status">暫時無法確認初始化進度/);
  assert.match(blocked, /<button[^>]*>重試<\/button>/);
  assert.match(blocked, /href="\/app\/w1\/get-started"[^>]*>開始設定<\/a>/);
  assert.match(blocked, /href="\/app\/w1"[^>]*>前往總覽<\/a>/);
  assert.doesNotMatch(blocked, /Dashboard content/);
  assert.match(await render(queryClient, 'admin', { pathname: base, state: { skipSetupCheck: true } }), /Dashboard content/);

  await queryClient.fetchQuery({ queryKey: keys.catalog, queryFn: async () => ({ data: { bindings: [], jobs: [] } }) });
  assert.equal(await render(queryClient, 'admin'), ''); // Navigate renders no markup on the server.
});

test('trusted inventory opens the overview even if another critical read fails', async () => {
  const queryClient = client();
  placeholderReads(queryClient);
  queryClient.setQueryData(keys.products, { data: [{ id: 'p1', status: 'active', store_id: 's1', title: 'In stock' }] });
  await assert.rejects(queryClient.fetchQuery({ queryKey: keys.catalog, queryFn: async () => { throw new TypeError('Failed to fetch'); } }), /Failed to fetch/);
  assert.match(await render(queryClient, 'admin'), /Dashboard content/);
});

test('real inventory opens the dashboard, but active setup takes precedence until that user dismisses it', async () => {
  const queryClient = client();
  queryClient.setQueryData(keys.products, { data: [{ id: 'p1', status: 'active', store_id: 's1', title: 'In stock' }] });
  assert.match(await render(queryClient), /Dashboard content/);
  saveSetupNavigation(ws, 'u1', 'worker', ['agent']);
  assert.equal(await render(queryClient), '');
  assert.match(await render(queryClient, 'owner', base, 'another-user'), /Dashboard content/);
  dismissSetup(ws, 'u1');
  assert.match(await render(client()), /Dashboard content/);
});

test('the focused setup shell provides workspace and language controls without loading dashboard data', async () => {
  const { SetupShell } = await import('../ViewShell');
  const queryClient = client();
  const workspace = { id: ws, name: 'Shop', role: 'admin' };
  const session: Session = { user: { id: 'u1' }, workspaces: [workspace, { id: 'w2', name: 'Other shop', role: 'owner' }] };
  const out = renderToStaticMarkup(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[`${base}/get-started`]}>
    <ViewContext.Provider value={{ ws, base, session, workspace }}><Routes><Route element={<SetupShell />}>
      <Route path={`${base}/get-started`} element={<h1>Wizard content</h1>} />
    </Route></Routes></ViewContext.Provider>
  </MemoryRouter></QueryClientProvider>);
  assert.match(out, /<main[^>]*><h1>Wizard content<\/h1>/);
  assert.match(out, /Other shop/);
  assert.match(out, /<option[^>]*value="en"[^>]*>English<\/option>/);
  assert.match(out, /aria-label="登出"/);
  assert.doesNotMatch(out, /<aside/);
  assert.equal(queryClient.getQueryCache().getAll().length, 0);
});

test('non-administrators and explicit dashboard destinations bypass the inventory check', async () => {
  for (const [role, entry] of [['viewer', base], ['owner', `${base}/products/p1?q=fixture#detail`], ['owner', `${base}?brand=b1`]]) {
    const queryClient = client();
    assert.match(await render(queryClient, role, entry), /Dashboard content/);
    assert.equal(queryClient.getQueryCache().getAll().length, 0);
  }
});
