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

async function render(step: string, input: Record<string, unknown> = {}, role = 'owner', lang: 'zh' | 'en' = 'zh', management?: 'accounts' | 'imports', failing: string[] = []) {
  const { useCopy } = await import('../../i18n');
  const { ViewContext } = await import('../data/use-view');
  const { ManageStoresPage, ManageWorkerAccountsPage } = await import('./worker-management');
  const { GetStartedPage } = await import('./GetStartedPage');
  // retryOnMount: false keeps a failed read failed in the static render (otherwise it is shown as loading again).
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, retryOnMount: false } } });
  const defaults = { '/agent-connections': [], '/devices': [], '/social-accounts': [], '/stores': [], '/brands': [], '/browser-sessions': [], '/worker-catalog': { bindings: [], jobs: [] },
    '': { name: 'North', default_timezone: 'UTC', version: 0 }, '/views/machines': [], '/views/channels': [], '/hub/alerts/channels': { channels: [], preferences: { published: true, daily_summary: true } } };
  for (const [path, data] of Object.entries({ ...defaults, ...input })) {
    if (failing.includes(path)) continue;
    client.setQueryData(viewKey(ws, path, {}, ['/social-accounts', '/stores', '/brands'].includes(path)), { data });
  }
  for (const path of failing) {
    client.getQueryCache().build(client, { queryKey: viewKey(ws, path, {}, false) })
      .setState({ status: 'error', fetchStatus: 'idle', error: new TypeError('Failed to fetch'), errorUpdatedAt: 1, data: undefined });
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

const machine = { machine_id: 'm-1', name: 'Mac-B', os: 'darwin', app_version: '0.2.0', latest_app_version: null, online: true, last_seen_at: '2026-11-24T12:00:00Z',
  paused: false, channels: [], queue: { queued: 0, ready: 0, running: 0, needs_owner: 0 }, next_job: null, drivers: [],
  warnings: [{ code: 'sleep_enabled', message: 'Mac-B 閒置 10 分鐘會睡眠。' }], remote_url: null, web_url: '/app/setup-workspace/machines/m-1' };
const readiness = { logged_in: true, automation_notice: true, defaults_ready: true, approval_mode_chosen: false, risk_ack_or_assist: false, dry_run_passed: false };
const channel = { channel_id: 'c-1', provider: 'x', handle: 'makemylure', display_name: 'MakeMyLure', machine: { id: 'm-1', name: 'Mac-B', online: true, web_url: '' },
  login: { state: 'verified', checked_at: null, evidence_url: null }, execution_mode: 'browser_auto', effective_mode: 'assist', approval_mode: 'needs_approval',
  risk_ack: null, risk_ack_required: true, risk_ack_current: false, daily_cap: 10, scheduled_today: 0, published_today: 0, window: null, timezone: 'Asia/Shanghai',
  lateness_limit_min: 30, defaults_ready: true, pause: null, readiness, next_post: null, can_schedule: true, blockers: [], web_url: '' };
const hubReads = { '': { name: 'North', default_timezone: 'Asia/Shanghai', version: 2 }, '/views/machines': [machine], '/views/channels': [channel],
  '/hub/alerts/channels': { channels: [], preferences: { published: true, daily_summary: true } } };

test('the wizard runs workspace → machines → channels → notifications → Codex and opens the first open step', async () => {
  const fresh = await render('', { '': { name: 'North', default_timezone: 'UTC', version: 0 } }, 'owner', 'en');
  assert.match(fresh, /Step 1 of 5/);
  assert.match(fresh, /Time zone/);
  const saved = await render('', { ...hubReads, '/views/machines': [] }, 'owner', 'en');
  assert.match(saved, /Step 2 of 5/);
  for (const alias of ['worker', 'social', 'store', 'import', 'machines']) assert.match(await render(alias, hubReads, 'owner', 'en'), /Step 2 of 5/, alias);
  const order = ['工作區', '連接機器', '新增帳號', '通知', '連接 Codex'];
  const zh = await render('machines', hubReads);
  assert.deepEqual(order.map(name => zh.indexOf(`<strong>${name}</strong>`) >= 0), [true, true, true, true, true]);
  assert.ok(order.every((name, index) => index === 0 || zh.indexOf(`<strong>${name}</strong>`) > zh.indexOf(`<strong>${order[index - 1]}</strong>`)));
});

test('the machine step shows one pairing path on the machine itself, the downloads and the paired machines with their warnings', async () => {
  const out = await render('machines', hubReads);
  assert.match(out, /中樞位址/);
  assert.match(out, /下載 SmartSell Worker/);
  assert.match(out, /macOS（Apple 晶片）/);
  assert.match(out, /這台機器叫什麼名字|用你平常叫它的名字/);
  assert.match(out, /Mac-B/);
  assert.match(out, /會睡眠/);
  assert.doesNotMatch(out, /worker-pair=|複製連接網址|產生連接網址/);
});

test('a failed machine read is an error with 重試, not "no machines yet", and its steps are not marked to do (W-specs #2)', async () => {
  const entry = (out: string, name: string) => out.match(new RegExp(`<strong>${name}</strong><small data-status="([a-z]+)">([^<]*)</small>`))?.slice(1);
  const machines = await render('machines', hubReads, 'owner', 'zh', undefined, ['/views/machines']);
  assert.match(machines, /已配對的機器/);
  assert.match(machines, /role="alert"/);
  assert.match(machines, /<button type="button">重試<\/button>/);
  assert.doesNotMatch(machines, /還沒有機器/);
  assert.deepEqual(entry(machines, '連接機器'), ['failed', '無法讀取']);
  // The channel step depends on the machine read: it shows the error too, not 「先完成「連接機器」」.
  const channels = await render('channels', { ...hubReads, '/views/channels': [] }, 'owner', 'zh', undefined, ['/views/machines']);
  assert.match(channels, /role="alert"/);
  assert.doesNotMatch(channels, /先完成「連接機器」/);
  assert.deepEqual(entry(channels, '新增帳號'), ['failed', '無法讀取']);
  // A successful empty read still says so, and the steps are 待設定.
  const empty = await render('machines', { ...hubReads, '/views/machines': [], '/views/channels': [] });
  assert.match(empty, /還沒有機器/);
  assert.deepEqual(entry(empty, '連接機器'), ['waiting', '待設定']);
  // A failed channel read is not "no channels on this machine".
  const channelRead = await render('channels', hubReads, 'owner', 'zh', undefined, ['/views/channels']);
  assert.match(channelRead, /role="alert"/);
  assert.doesNotMatch(channelRead, /這台機器還沒有帳號/);
});

test('the channel step says where to add an account and shows each channel\'s readiness', async () => {
  const out = await render('channels', hubReads);
  assert.match(out, /在 Mac-B 開啟 SmartSell Worker → 新增帳號/);
  assert.match(out, /@makemylure/);
  assert.match(out, /3\/6/);
  assert.match(out, /已選擇核准方式/);
});

test('the Codex step offers the App button and the Node relay; the old prompt is only under Advanced', async () => {
  const out = await render('agent', { ...hubReads, '/agent-connections': [connection] });
  assert.match(out, /方式一（建議）：筆電上的 SmartSell App/);
  assert.match(out, /方式二：Node relay/);
  assert.match(out, /codex mcp add smartsell -- node ~\/.smartsell\/relay.mjs/);
  const advanced = out.indexOf('進階：舊的接入方式');
  assert.ok(advanced > 0);
  assert.ok(!out.slice(0, advanced).includes('python3'), 'no Python heredoc before Advanced');
  const verified = await render('agent', { ...hubReads, '/agent-connections': [{ ...connection, mcp_client_verified_at: '2026-11-24T00:00:00Z' }] });
  assert.match(verified, /已有 Agent 透過 MCP 呼叫過 SmartSell/);
});

test('O4: the old prompt setup under Advanced ignores connections made by the relay token or the App', async () => {
  const relay = { ...connection, id: 'mcp-relay', label: 'North · Codex', mcp_url: 'https://hub.example.ts.net/mcp', setup_via: 'token' };
  const app = { ...connection, id: 'mcp-app', label: 'dp-mbp · Codex', mcp_url: 'https://hub.example.ts.net/mcp', setup_via: 'app' };
  for (const made of [relay, app]) {
    const out = await render('agent', { ...hubReads, '/agent-connections': [made] });
    const advanced = out.slice(out.indexOf('進階：舊的接入方式'));
    assert.doesNotMatch(advanced, /修復 Codex 連線|核對提示詞|完整退出並重開原客戶端|mcp-relay|mcp-app/, made.setup_via);
  }
  // A connection the prompt enrollment made (or one from before setup_via) still gets its check and repair prompts.
  const prompt = await render('agent', { ...hubReads, '/agent-connections': [{ ...relay, id: 'mcp-prompt', setup_via: 'prompt' }] });
  assert.match(prompt.slice(prompt.indexOf('進階：舊的接入方式')), /修復 Codex 連線或補上社媒路由「North · Codex」/);
});

test('O5: the relay steps cover Codex, Claude Code and WorkBuddy, Node.js 24, the token file, and real PowerShell on Windows', async () => {
  const { relayCommands } = await import('./setup-hub');
  const hub = 'https://hub.example.ts.net';
  const unix = relayCommands(hub, 'unix', '/Users/me');
  assert.equal(unix.install, `mkdir -p ~/.smartsell && curl -fsSL ${hub}/agent/relay.mjs -o ~/.smartsell/relay.mjs\nmv ~/Downloads/token ~/.smartsell/token && chmod 600 ~/.smartsell/token`);
  assert.equal(unix.codex, `codex mcp add smartsell -- node ~/.smartsell/relay.mjs --hub ${hub} --token-file ~/.smartsell/token`);
  assert.equal(unix.claude, `claude mcp add --scope user smartsell -- node ~/.smartsell/relay.mjs --hub ${hub} --token-file ~/.smartsell/token`);
  assert.deepEqual(JSON.parse(unix.workbuddy), { smartsell: { command: 'node', args: ['/Users/me/.smartsell/relay.mjs', '--hub', hub, '--token-file', '/Users/me/.smartsell/token'] } });
  const win = relayCommands(hub, 'windows', 'C:\\Users\\me');
  assert.equal(win.install, [
    'New-Item -ItemType Directory -Force "$HOME\\.smartsell" | Out-Null',
    `Invoke-WebRequest -UseBasicParsing "${hub}/agent/relay.mjs" -OutFile "$HOME\\.smartsell\\relay.mjs"`,
    'Move-Item -Force "$HOME\\Downloads\\token" "$HOME\\.smartsell\\token"',
  ].join('\n'));
  assert.doesNotMatch(Object.values(win).join('\n'), /chmod|curl|~\//);
  assert.equal(win.claude, `claude mcp add --scope user smartsell '--' node "$HOME\\.smartsell\\relay.mjs" --hub ${hub} --token-file "$HOME\\.smartsell\\token"`);
  assert.deepEqual(JSON.parse(win.workbuddy).smartsell.args, ['C:\\Users\\me\\.smartsell\\relay.mjs', '--hub', hub, '--token-file', 'C:\\Users\\me\\.smartsell\\token']);
  const out = await render('agent', hubReads);
  assert.match(out, /Node\.js 24 以上/);
  assert.match(out, /claude mcp add --scope user smartsell -- node ~\/\.smartsell\/relay\.mjs/);
  assert.match(out, /WorkBuddy/);
  assert.match(out, /Windows（PowerShell）/);
});

test('setup navigation storage still records start and dismissal per user and workspace', async () => {
  const { dismissSetup, setupDismissed, setupStarted, saveSetupNavigation } = await import('./setup-data');
  try {
    saveSetupNavigation(ws, 'owner-1', 'agent', []);
    assert.equal(setupStarted(ws, 'owner-1'), true);
    assert.equal(setupStarted(ws, 'other-user'), false);
    dismissSetup(ws, 'owner-1');
    assert.equal(setupDismissed(ws, 'owner-1'), true);
    assert.equal(setupStarted(ws, 'owner-1'), false);
  } finally { storage.clear(); }
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

test('direct setup links show the role boundary without rendering pairing controls', async () => {
  const out = await render('machines', {}, 'editor');
  assert.match(out, /此設定需要工作區擁有者或管理員權限/);
  assert.doesNotMatch(out, /中樞位址/);
  assert.match(out, /href="\/app\/setup-workspace"/);
});
