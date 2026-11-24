import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewLang } from '@smartsell/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { viewKey } from '../data/keys';
import type { AttentionItem, ChannelDetail, TodayData } from '../data/hub-types';

/** E21 「重新登入」 on the channel page and Today's login card (phase1-design §8.16 step 7, §9.2, §9.4). */

registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
const globals = globalThis as unknown as { localStorage?: unknown; document?: unknown; window?: unknown };
const storage = new Map<string, string>();
globals.localStorage ??= { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
globals.document ??= { documentElement: {} };
globals.window ??= { location: { origin: 'https://hub.example.ts.net', pathname: '/app/w1', search: '', hash: '' } };

const ws = 'w1';
const base = `/app/${ws}`;
const url = (path: string) => `https://hub.example.ts.net${base}${path}`;
const machineRef = { id: 'm-1', name: 'Mac-B', online: true, web_url: url('/machines/m-1') };

const channel = (state: ChannelDetail['login']['state']): ChannelDetail => ({
  channel_id: 'c-1', provider: 'x', handle: 'makemylure', display_name: 'MakeMyLure', machine: machineRef, login: { state, checked_at: '2026-11-24T11:00:00Z', evidence_url: null },
  execution_mode: 'browser_auto', effective_mode: 'auto', approval_mode: 'direct', risk_ack: null, risk_ack_required: true, risk_ack_current: true,
  daily_cap: 10, scheduled_today: 0, published_today: 0, window: null, timezone: 'Asia/Shanghai', lateness_limit_min: 30, defaults_ready: true, pause: null,
  readiness: { logged_in: state === 'verified', automation_notice: true, defaults_ready: true, approval_mode_chosen: true, risk_ack_or_assist: true, dry_run_passed: true },
  next_post: null, can_schedule: state === 'verified', blockers: [], web_url: url('/channels/c-1'),
  settings: { id: 's-1', social_account_id: 'c-1', version: 3, created_at: '', updated_at: '', execution_mode: 'browser_auto', approval_mode: 'direct', approval_mode_confirmed_at: '2026-11-24T10:00:00Z',
    automation_notice_ack: { at: '2026-11-24T10:00:00Z', via: 'worker_app', by: 'device:m-1', version: 'automation-notice-2026-11' }, risk_ack: null, daily_cap: 10, window: null,
    timezone: 'Asia/Shanghai', lateness_limit_min: 30, caption_limit: null, chrome_profile_key: 'ch-0123456789ab', platform_defaults: { x: { reply_settings: 'everyone' } },
    settings_generation: 1, approval_generation: 1 },
  posts: [], checks: [], dry_runs: [], risk_terms: null,
  automation_notice: { version: 'automation-notice-2026-11', zh_hant: 'SmartSell 會在這台機器上開啟並操作這個帳號的網頁……', en: 'SmartSell will open…',
    ack: { at: '2026-11-24T10:00:00Z', via: 'worker_app', by: 'device:m-1', version: 'automation-notice-2026-11' } },
});

const loginCard = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: 'login:c-1', kind: 'login', severity: 'urgent', title: 'X @makemylure 要重新登入（Mac-B）', detail: 'Mac-B 上的 X @makemylure 登入已失效，排到這個帳號的貼文發不出去。',
  due_at: null, machine: { id: 'm-1', label: 'Mac-B', web_url: url('/machines/m-1') }, channel: { id: 'c-1', label: 'X @makemylure', web_url: url('/channels/c-1') }, post: null,
  actions: [{ kind: 'check_login', label: '檢查登入', method: 'POST', path: '/hub/channels/c-1/check', body: {} }, { kind: 'open', label: '開啟帳號' }],
  web_url: url('/channels/c-1'), ...over,
});
const today = (attention: AttentionItem[]): TodayData => ({
  generated_at: '2026-11-24T12:00:00Z', timezone: 'Asia/Shanghai', date: '2026-11-24', attention, upcoming: [], recent_published: [], machines: [],
  counts: { scheduled: 0, published: 0, needs_owner: 0, missed: 0, unknown: 0 },
});

async function render(path: string, reads: Record<string, unknown>, lang: 'zh' | 'en' = 'zh') {
  const { useCopy } = await import('../../i18n');
  const { ViewContext } = await import('../data/use-view');
  const { TodayPage } = await import('./TodayPage');
  const { ChannelPage } = await import('./ChannelPage');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, data] of Object.entries(reads)) client.setQueryData(viewKey(ws, key, {}), { data });
  const workspace = { id: ws, name: 'MakeMyLure', role: 'owner' };
  const session = { user: { id: 'owner-1', name: 'Owner' }, workspaces: [workspace], csrf_token: 'csrf' };
  function Localized({ children }: { children: React.ReactNode }) { useCopy().setLanguage(lang === 'en' ? 'en' : 'zh-Hant'); return <>{children}</>; }
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`${base}${path}`]}><ViewLang lang={lang}>
    <ViewContext.Provider value={{ ws, base, session, workspace } as never}><Localized><Routes><Route path="/app/:ws">
      <Route index element={<TodayPage />} /><Route path="channels/:id" element={<ChannelPage />} />
    </Route></Routes></Localized></ViewContext.Provider></ViewLang></MemoryRouter></QueryClientProvider>);
}
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ');
const buttons = (html: string, label: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].filter(match => match[1] === label).length;
/** The interim wording S7 used before E21: press 重新登入 in the Worker App instead of on the web. */
const interim = /(?:Worker App|SmartSell Worker)[^。]*按[^。]*「重新登入」/;
const zh = (value: readonly [string, string]) => value[0];
const en = (value: readonly [string, string]) => value[1];

test('the channel page offers 重新登入 next to 檢查登入 and explains it on the machine, without the Worker-App interim copy', async () => {
  const signedOut = await render('/channels/c-1', { '/views/channels/c-1': channel('login_required'), '/views/machines': [], '/views/media/recent': [] });
  assert.equal(buttons(signedOut, '重新登入'), 1);
  assert.equal(buttons(signedOut, '檢查登入'), 1);
  assert.match(visible(signedOut), /要重新登入：按「重新登入」，Mac-B 會把這個帳號的 SmartSell Chrome 登入視窗帶到前景，請到 Mac-B 上登入。/);
  assert.doesNotMatch(visible(signedOut), interim);
  // Signed in: the button stays (§9.4 header), the callout does not.
  const signedIn = await render('/channels/c-1', { '/views/channels/c-1': channel('verified'), '/views/machines': [], '/views/media/recent': [] });
  assert.equal(buttons(signedIn, '重新登入'), 1);
  assert.doesNotMatch(signedIn, /登入視窗帶到前景/);
  // No machine: nothing to open a window on.
  const unbound = await render('/channels/c-1', { '/views/channels/c-1': { ...channel('unknown'), machine: null }, '/views/machines': [], '/views/media/recent': [] });
  assert.match(unbound, /<button type="button" class="vs-btn" disabled="">重新登入<\/button>/);
  const english = await render('/channels/c-1', { '/views/channels/c-1': channel('login_required'), '/views/machines': [], '/views/media/recent': [] }, 'en');
  assert.equal(buttons(english, 'Sign in again'), 1);
  assert.match(english, /brings this channel&#x27;s SmartSell Chrome sign-in window to the front on Mac-B/);
});

test('Today\'s login card has one 重新登入 button, also when the hub sends an open_login action, next to 檢查登入', async () => {
  const out = await render('', { '/views/today': today([loginCard()]) });
  assert.equal(buttons(out, '重新登入'), 1);
  assert.equal(buttons(out, '檢查登入'), 1);
  assert.match(out, /<button type="button" class="vs-btn primary-soft">重新登入<\/button>/);
  // (The card's title and detail text come from the hub's views/today.ts; its interim wording is requested in docs/restructure/requests/L-fix.md.)
  // A hub that sends the action (§9.2 `open_login`) gets the same single button, not a second generic one.
  const offered = await render('', { '/views/today': today([loginCard({ actions: [
    { kind: 'open_login', label: '重新登入', method: 'POST', path: '/hub/channels/c-1/check', body: { open_login_window: true } },
    { kind: 'check_login', label: '檢查登入', method: 'POST', path: '/hub/channels/c-1/check', body: {} }, { kind: 'open', label: '開啟帳號' }] })]) });
  assert.equal(buttons(offered, '重新登入'), 1);
  // Cards that are not about a login have no 重新登入.
  const offline = await render('', { '/views/today': today([loginCard({ id: 'machine:m-1', kind: 'machine_offline', title: 'Mac-B 離線', channel: null, actions: [] })]) });
  assert.equal(buttons(offline, '重新登入'), 0);
});

test('重新登入 asks the hub for the sign-in window and tells the owner exactly what will happen', async () => {
  const { RELOGIN } = await import('../hub-copy');
  const { reloginMessage, requestRelogin } = await import('./ChannelPage');
  const sent: unknown[][] = [];
  const answer = { channel_id: 'c-1', task_id: 'j-1', status: 'pending', login: 'checking', machine: { machine_id: 'm-1', name: 'Mac-B', online: true }, open_login_window: true };
  const result = await requestRelogin(async (...args) => { sent.push(args); return { data: answer }; }, 'c 1');
  assert.deepEqual(sent, [['POST', '/hub/channels/c%201/check', { open_login_window: true }]]);
  assert.equal(result, answer);
  const names = { machine: 'this machine', channel: 'X @makemylure' };
  // The window opens on the machine the hub names; the owner signs in there.
  const opened = reloginMessage(zh, answer, names);
  assert.equal(opened, RELOGIN.opened[0].replaceAll('{machine}', 'Mac-B').replaceAll('{channel}', 'X @makemylure'));
  assert.match(opened, /^已請 Mac-B 開啟 X @makemylure 的登入視窗。請到 Mac-B 上的 SmartSell Chrome 視窗登入/);
  assert.match(reloginMessage(en, answer, names), /^Asked Mac-B to open the sign-in window for X @makemylure\. Sign in in the SmartSell Chrome window on Mac-B/);
  // Offline: it opens only when the machine is back.
  assert.match(reloginMessage(zh, { ...answer, status: 'machine_offline', machine: { name: 'Win-C', online: false } }, names), /^Win-C 目前離線，X @makemylure 的登入視窗要等它上線才會開啟/);
  // The machine already holds a plain check: no window this time, and the owner is told so.
  assert.match(reloginMessage(zh, { ...answer, open_login_window: false }, names), /^Mac-B 正在檢查 X @makemylure 的登入，這次不會開啟登入視窗/);
  assert.match(reloginMessage(zh, { ...answer, status: 'done', open_login_window: false }, names), /^X @makemylure 的登入狀態已更新。$/);
  // Without a machine in the answer the page's own name is used.
  assert.match(reloginMessage(zh, { status: 'pending', open_login_window: true }, names), /^已請 this machine 開啟/);
  // A refusal (e.g. 403 HUMAN_REQUIRED) propagates to the page's error notice; nothing claims success.
  await assert.rejects(requestRelogin(async () => { throw new Error('HUMAN_REQUIRED'); }, 'c-1'), /HUMAN_REQUIRED/);
});
