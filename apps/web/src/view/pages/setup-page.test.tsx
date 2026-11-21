import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewLang } from '@smartsell/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { viewKey } from '../data/keys';

registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
const globals = globalThis as unknown as { localStorage?: unknown; document?: unknown; window?: unknown };
globals.localStorage ??= { getItem: () => null, setItem: () => undefined };
globals.document ??= { documentElement: {} };
globals.window ??= { location: { origin: 'https://workbench.example.test' } };

const ws = 'setup-workspace';
const base = `/app/${ws}`;
const store = { id: 'store-1', name: 'North Store', provider: 'shopify', status: 'import_only', external_store_id: 'north-shop' };
const device = { id: 'worker-1', name: 'North Desktop', status: 'active', online: false, last_seen_at: '2025-01-01T00:00:00Z' };
const account = { id: 'account-1', status: 'active', display_name: 'North Social', external_account_id: 'north-social' };
const connection = { id: 'mcp-1', label: 'My Codex', client: 'codex', expires_at: null, last_used_at: null, revoked: false };

async function render(step: string, input: Record<string, unknown> = {}, role = 'owner') {
  const { ViewContext } = await import('../data/use-view');
  const { GetStartedPage } = await import('./GetStartedPage');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const defaults = { '/agent-connections': [], '/devices': [], '/social-accounts': [], '/stores': [], '/brands': [], '/browser-sessions': [], '/worker-catalog': { bindings: [], jobs: [] } };
  for (const [path, data] of Object.entries({ ...defaults, ...input })) {
    client.setQueryData(viewKey(ws, path, {}, ['/social-accounts', '/stores', '/brands'].includes(path)), { data });
  }
  const workspace = { id: ws, name: 'North', role };
  const session = { user: { id: 'owner-1' }, workspaces: [workspace] };
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`${base}/get-started?step=${step}`]}>
    <ViewLang lang="zh"><ViewContext.Provider value={{ ws, base, session, workspace }}><GetStartedPage /></ViewContext.Provider></ViewLang>
  </MemoryRouter></QueryClientProvider>);
}

test('setup keeps issued MCP credentials pending until the server reports real use', async () => {
  const pending = await render('agent', { '/agent-connections': [connection] });
  assert.equal((pending.match(/aria-current="step"/g) ?? []).length, 1);
  assert.match(pending, /憑證已發出，尚未使用/);
  assert.doesNotMatch(pending, /已驗證 MCP 連線/);
  const connected = await render('agent', { '/agent-connections': [{ ...connection, last_used_at: new Date().toISOString() }] });
  assert.match(connected, /已驗證 MCP 連線/);
  assert.match(connected, /My Codex/);
  assert.doesNotMatch(connected, /憑證已發出，尚未使用/);
});

test('social setup offers brand creation and distinguishes a bound session from verified identity', async () => {
  const pending = { id: 'session-1', device_id: device.id, social_account_id: account.id, status: 'pending_identity' };
  const reads = { '/devices': [device], '/social-accounts': [account], '/browser-sessions': [pending] };
  const bound = await render('social', reads, 'admin');
  assert.match(bound, /建立品牌/);
  assert.match(bound, /已登記/);
  assert.match(bound, /North Desktop/);
  assert.match(bound, /待核驗身份/);
  assert.match(bound, /複製瀏覽器會話 ID/);
  assert.doesNotMatch(bound, /身份已核驗/);
  const verified = await render('social', { ...reads, '/browser-sessions': [{ ...pending, status: 'verified' }] });
  assert.match(verified, /身份已核驗/);
  assert.doesNotMatch(verified, /待核驗身份/);
});

test('store jobs link to their exact batch and display offline separately from import progress', async () => {
  const job = { device_id: device.id, store_id: store.id, store_name: store.name, external_store_id: store.external_store_id };
  const out = await render('store', { '/stores': [store], '/devices': [device], '/worker-catalog': {
    bindings: [{ store_id: store.id, device_id: device.id, device_name: device.name, external_store_id: store.external_store_id }],
    jobs: [
      { ...job, id: 'queued', status: 'queued' }, { ...job, id: 'claimed', status: 'claimed' },
      { ...job, id: 'previewed', status: 'previewed', import_id: 'preview-17' },
      { ...job, id: 'imported', status: 'imported', import_id: 'import-16' },
      { ...job, id: 'failed', status: 'failed', error_code: 'WORKER_ERROR' },
    ],
  } });
  for (const label of ['離線', '排隊中', 'Worker 已領取', '預覽已就緒', '已匯入', 'WORKER_ERROR']) assert.ok(out.includes(label));
  assert.match(out, /href="\/w\/setup-workspace\/commerce\?tab=store-imports&amp;store=store-1&amp;related=import&amp;rid=preview-17"/);
  assert.match(out, /href="\/app\/setup-workspace\/products"/);
  assert.match(out, /<button[^>]*disabled[^>]*>啟動商品匯入<\/button>/);
});

test('pairing shows the workspace, origin and device state separately', async () => {
  const out = await render('worker', { '/devices': [device, { id: 'worker-2', name: 'Unverified Desktop', status: 'active' }] });
  assert.match(out, /https:\/\/workbench\.example\.test/);
  assert.match(out, /複製工作區 ID/);
  assert.match(out, /複製服務地址/);
  assert.match(out, /North Desktop/);
  assert.match(out, /離線/);
  assert.match(out, /尚未驗證在線/);
  assert.doesNotMatch(out, /[?&]pairing_code=/);
});

test('direct setup links show the role boundary without rendering pairing controls', async () => {
  const out = await render('worker', {}, 'editor');
  assert.match(out, /此設定需要工作區擁有者或管理員權限/);
  assert.doesNotMatch(out, /產生配對碼/);
  assert.match(out, /href="\/app\/setup-workspace"/);
});
