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
const storage = new Map<string, string>();
globals.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
globals.document ??= { documentElement: {} };
globals.window ??= { location: { origin: 'https://workbench.example.test' } };

const ws = 'setup-workspace';
const base = `/app/${ws}`;
const store = { id: 'store-1', name: 'North Store', provider: 'shopify', status: 'import_only', external_store_id: 'north-shop' };
const device = { id: 'worker-1', name: 'North Desktop', status: 'active', online: false, last_seen_at: '2025-01-01T00:00:00Z', client_version: 'fixture' };
const account = { id: 'account-1', status: 'active', display_name: 'North Social', external_account_id: 'north-social' };
const connection = { id: 'mcp-1', label: 'My Codex', client: 'codex', expires_at: null, last_used_at: null, revoked: false };

async function render(step: string, input: Record<string, unknown> = {}, role = 'owner', lang: 'zh' | 'en' = 'zh', management?: 'accounts' | 'imports') {
  const { useCopy } = await import('../../i18n');
  const { ViewContext } = await import('../data/use-view');
  const { ManageStoresPage, ManageWorkerAccountsPage } = await import('./worker-management');
  const { GetStartedPage } = await import('./GetStartedPage');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const defaults = { '/agent-connections': [], '/devices': [], '/social-accounts': [], '/stores': [], '/brands': [], '/browser-sessions': [], '/worker-catalog': { bindings: [], jobs: [] } };
  for (const [path, data] of Object.entries({ ...defaults, ...input })) {
    client.setQueryData(viewKey(ws, path, {}, ['/social-accounts', '/stores', '/brands'].includes(path)), { data });
  }
  const workspace = { id: ws, name: 'North', role };
  const session = { user: { id: 'owner-1' }, workspaces: [workspace] };
  function LocalizedSetup() {
    const { setLanguage } = useCopy();
    setLanguage(lang === 'en' ? 'en' : 'zh-Hant');
    if (management === 'accounts') return <ManageWorkerAccountsPage />;
    if (management === 'imports') return <ManageStoresPage phase="import" />;
    return <GetStartedPage />;
  }
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`${base}/get-started${step ? `?step=${step}` : ''}`]}>
    <ViewLang lang={lang}><ViewContext.Provider value={{ ws, base, session, workspace }}><LocalizedSetup /></ViewContext.Provider></ViewLang>
  </MemoryRouter></QueryClientProvider>);
}

test('the main agent introduction explains its role with an existing credential', async () => {
  const input = { '/agent-connections': [connection] };
  const zh = await render('agent', input);
  const en = await render('agent', input, 'owner', 'en');
  assert.match(zh, /<p>主 Agent 可讀取工作區資料、擬定營運計畫並提交工作。<\/p>/);
  assert.match(en, /<p>Your main agent can read workspace data, draft operating plans, and submit work\.<\/p>/);
  assert.doesNotMatch(zh, /將下方 MCP 設定加入/);
  assert.doesNotMatch(en, /add the MCP configuration below/);
});

test('both steps only complete with their own evidence', async () => {
  const online = { ...device, online: true };
  const pending = await render('agent', { '/agent-connections': [connection] }, 'owner', 'en');
  assert.doesNotMatch(pending, />Next step<\/button>/);
  const verified = { ...connection, mcp_client_verified_at: '2025-01-01T00:00:00Z' };
  assert.match(await render('agent', { '/agent-connections': [verified] }, 'owner', 'en'), />Next step<\/button>/);
  const summary = await render('summary', { '/agent-connections': [verified], '/devices': [{ ...online, status: 'revoked' }], '/stores': [store] }, 'owner', 'en');
  assert.match(summary, /Remaining steps/);
  assert.doesNotMatch(summary, /Both steps are complete/);
  const legacyPairing = { ...online, client_version: undefined };
  assert.match(await render('worker', { '/devices': [legacyPairing] }, 'owner', 'en'), /Paired, waiting for first heartbeat/);
  assert.match(await render('summary', { '/agent-connections': [verified], '/devices': [legacyPairing] }, 'owner', 'en'), /Remaining steps/);
  assert.match(await render('summary', { '/agent-connections': [verified], '/devices': [device] }, 'owner', 'en'), /Both steps are complete/);
});

test('setup keeps issued MCP credentials pending until the server reports real use', async () => {
  const pending = await render('agent', { '/agent-connections': [connection] });
  assert.equal((pending.match(/aria-current="step"/g) ?? []).length, 1);
  assert.match(pending, /憑證已發出，尚未使用/);
  assert.doesNotMatch(pending, /已驗證 MCP 連線/);
  assert.match(pending, /複製核對提示詞/);
  assert.match(pending, /產生新的接入提示詞/);
  const handshake = await render('agent', { '/agent-connections': [{ ...connection, last_used_at: new Date().toISOString() }] });
  assert.doesNotMatch(handshake, /已驗證 MCP 連線/);
  const connected = await render('agent', { '/agent-connections': [{ ...connection, mcp_client_verified_at: new Date().toISOString() }] });
  assert.match(connected, /已驗證 MCP 連線/);
  assert.match(connected, /My Codex/);
  assert.doesNotMatch(connected, /憑證已發出，尚未使用/);
  const revoked = await render('agent', { '/agent-connections': [{ ...connection, last_used_at: new Date().toISOString(), revoked: true }] });
  assert.doesNotMatch(revoked, /已驗證 MCP 連線/);
});

test('social setup offers brand creation and distinguishes a bound session from verified identity', async () => {
  const pending = { id: 'session-1', device_id: device.id, social_account_id: account.id, status: 'pending_identity' };
  const reads = { '/devices': [device], '/social-accounts': [account], '/browser-sessions': [pending] };
  const bound = await render('', reads, 'admin', 'zh', 'accounts');
  assert.match(bound, /建立品牌/);
  assert.match(bound, /已登記/);
  assert.match(bound, /North Desktop/);
  assert.match(bound, /待核驗身份/);
  assert.match(bound, /複製瀏覽器會話 ID/);
  assert.doesNotMatch(bound, /身份已核驗/);
  const verified = await render('', { ...reads, '/browser-sessions': [{ ...pending, status: 'verified' }] }, 'owner', 'zh', 'accounts');
  assert.match(verified, /身份已核驗/);
  assert.doesNotMatch(verified, /待核驗身份/);
  const mismatch = await render('', { ...reads, '/browser-sessions': [{ ...pending, status: 'identity_mismatch' }] }, 'owner', 'zh', 'accounts');
  assert.match(mismatch, /身份不符/);
  assert.doesNotMatch(mismatch, /身份已核驗/);
});

test('store jobs link to their exact batch and display offline separately from import progress', async () => {
  const job = { device_id: device.id, store_id: store.id, store_name: store.name, provider: store.provider, external_store_id: store.external_store_id };
  const bindings = [{ store_id: store.id, device_id: device.id, device_name: device.name, external_store_id: store.external_store_id }];
  const inputs = { '/stores': [store], '/devices': [device] };
  for (const [status, label] of [['queued', '排隊中'], ['claimed', 'Worker 已領取'], ['failed', 'WORKER_ERROR']]) {
    const out = await render('import', { ...inputs, '/worker-catalog': { bindings, jobs: [{ ...job, id: status, status, error_code: status === 'failed' ? label : undefined }] } }, 'owner', 'zh', 'imports');
    assert.match(out, /離線/);
    assert.ok(out.includes(label), status);
  }
  const preview = await render('import', { ...inputs, '/worker-catalog': { bindings, jobs: [{ ...job, id: 'previewed', status: 'previewed', import_id: 'preview-17' }] },
    '/imports/preview-17': { id: 'preview-17', store_id: store.id, template_key: 'product_list', status: 'awaiting_confirmation' } }, 'owner', 'zh', 'imports');
  assert.match(preview, /預覽已就緒/);
  assert.match(preview, /href="\/w\/setup-workspace\/commerce\?tab=store-imports&amp;store=store-1&amp;related=import&amp;rid=preview-17"/);
  assert.doesNotMatch(preview, /<button[^>]*>啟動商品匯入<\/button>/);
  const imported = await render('import', { ...inputs, '/worker-catalog': { bindings, jobs: [{ ...job, id: 'imported', status: 'imported', import_id: 'import-16' }] },
    '/imports/import-16': { id: 'import-16', store_id: store.id, template_key: 'product_list', status: 'merged', merged_rows: 1 } }, 'owner', 'zh', 'imports');
  assert.match(imported, /已匯入/);
  assert.match(imported, /href="\/app\/setup-workspace\/products"/);
});

test('worker shows registered connections and no standalone pairing fields', async () => {
  const session = { id: 'session-1', device_id: device.id, social_account_id: account.id, status: 'pending_identity' };
  const out = await render('worker', { '/devices': [device], '/social-accounts': [account], '/stores': [store], '/browser-sessions': [session] });
  assert.match(out, /North Desktop/);
  assert.match(out, /離線/);
  assert.match(out, /North Social/);
  assert.match(out, /待核驗身份/);
  assert.match(out, /North Store/);
  assert.match(out, /等待指定機器/);
  assert.doesNotMatch(out, /複製工作區 ID|複製服務地址|worker-pair=/);
});

test('the bare wizard resumes the worker step from old data and deep links', async () => {
  const reads = { '/agent-connections': [{ ...connection, mcp_client_verified_at: '2025-01-01T00:00:00Z' }] };
  assert.match(await render('', reads, 'owner', 'en'), /Step 2 of 2/);
  const { dismissSetup, readSetupNavigation, saveSetupNavigation, setupDismissed, setupStarted } = await import('./setup-data');
  try {
    const key = `smartsell.get-started.navigation:${JSON.stringify(['owner-1', ws])}`;
    storage.set(key, JSON.stringify({ location: 'import', skipped: ['worker', 'social'] }));
    assert.equal(setupStarted(ws, 'owner-1'), true);
    assert.equal(setupStarted(ws, 'other-user'), false);
    assert.equal(setupStarted('other-workspace', 'owner-1'), false);
    dismissSetup(ws, 'owner-1');
    assert.equal(setupDismissed(ws, 'owner-1'), true);
    assert.equal(setupStarted(ws, 'owner-1'), false);
    assert.deepEqual(readSetupNavigation(ws, 'owner-1'), { location: 'worker', skipped: ['worker'] });
    assert.match(await render('', {}, 'owner', 'en'), /Step 2 of 2/);
    for (const alias of ['social', 'store', 'import']) {
      assert.match(await render(alias, {}, 'owner', 'en'), /Step 2 of 2/);
    }
    const summary = await render('summary', reads, 'owner', 'en');
    assert.match(summary, /Remaining steps/);
    assert.match(summary, /Skipped for now/);
    assert.match(summary, /Finish later and go to overview/);
    saveSetupNavigation(ws, 'owner-1', 'summary', ['worker']);
    assert.equal(setupStarted(ws, 'owner-1'), true);
  } finally { storage.clear(); }
});

test('direct setup links show the role boundary without rendering pairing controls', async () => {
  const out = await render('worker', {}, 'editor');
  assert.match(out, /此設定需要工作區擁有者或管理員權限/);
  assert.doesNotMatch(out, /產生連接網址/);
  assert.match(out, /href="\/app\/setup-workspace"/);
});
