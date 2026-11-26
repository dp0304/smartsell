import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewLang } from '@smartsell/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { viewKey } from '../data/keys';
import type { ChannelDetail, MachineDetail, OwnerAlert, PostDetailView, PostSummary, TodayData } from '../data/hub-types';

registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
// The browser's zone for the pages that show times in it (machines and channels lists, WV-6); fixed so the tests do not depend on the host.
process.env.TZ = 'Asia/Shanghai';
const globals = globalThis as unknown as { localStorage?: unknown; document?: unknown; window?: unknown };
const storage = new Map<string, string>();
globals.localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
globals.document ??= { documentElement: {} };
globals.window ??= { location: { origin: 'https://hub.example.ts.net', pathname: '/app/w1', search: '', hash: '' } };

const ws = 'w1';
const base = `/app/${ws}`;
const url = (path: string) => `https://hub.example.ts.net${base}${path}`;
const machineRef = { id: 'm-1', name: 'Mac-B', online: true, web_url: url('/machines/m-1') };
const post = (over: Partial<PostSummary> = {}): PostSummary => ({
  post_id: 'p-1', status: 'scheduled', scheduled_at: '2026-11-25T01:00:00Z', local_time: '2026-11-25 09:00', latest_local_time: '2026-11-25 09:30',
  content_item_id: 'ci-1', created_at: '2026-11-24T12:00:00Z', created_by_agent: true,
  channel: { id: 'c-1', provider: 'x', handle: 'makemylure', label: 'X @makemylure', web_url: url('/channels/c-1') }, machine: machineRef,
  route_kind: 'machine', mode: 'auto', caption_excerpt: 'New lure test', media_thumb_url: null, url: null, blocker: null, task_id: 'j-1',
  approval: 'approved_by_channel_policy', approval_deadline: null, approval_deadline_local: null, owner_action: null, missed_reason: null, plan_tag: null,
  web_url: url('/posts/p-1'), ...over,
});
const machine: MachineDetail = {
  machine_id: 'm-1', name: 'Mac-B', os: 'darwin', app_version: '0.2.0', latest_app_version: '0.2.1', online: true, last_seen_at: '2026-11-24T12:00:00Z', paused: false,
  channels: [{ social_account_id: 'c-1', provider: 'x', handle: 'makemylure', login: 'verified', web_url: url('/channels/c-1') }],
  queue: { queued: 1, ready: 1, running: 0, needs_owner: 1 }, next_job: { post_id: 'p-1', at: '2026-11-25T01:00:00Z', local_time: '2026-11-25 09:00', provider: 'x' },
  drivers: [{ provider: 'x', version: 'x@2026.11.1', health: 'outdated', step: 'compose' }],
  warnings: [{ code: 'sleep_enabled', message: 'Mac-B 閒置 10 分鐘會睡眠。' }, { code: 'app_outdated', message: 'Mac-B 的 Worker 是 0.2.0，有 0.2.1 可更新。' }],
  remote_url: 'vnc://mac-b.tail1234.ts.net', web_url: url('/machines/m-1'), clock_offset_ms: 1200, paired_at: '2026-11-20T00:00:00Z',
  posture: null, driver_config_version: '2026.11.2',
  upcoming: [{ task_id: 'j-1', kind: 'publish_post', status: 'claimed', post_id: 'p-1', channel_label: 'X @makemylure', not_before: '2026-11-25T01:00:00Z', local_time: '2026-11-25 09:00', blocker: null, url: null, dry_run: false, web_url: url('/posts/p-1') }],
  history: [], last_driver_trace: { provider: 'x', job_id: 'j-0', steps: [{ step: 'open_compose', ms: 820, matched: 'primary' }] },
};
const today: TodayData = {
  generated_at: '2026-11-24T12:00:00Z', timezone: 'Asia/Shanghai', date: '2026-11-24',
  attention: [
    { id: 'post:p-2', kind: 'job_blocker', severity: 'urgent', title: 'X @makemylure 11-24 21:00：出現驗證碼', detail: 'Mac-B 的 X @makemylure 出現驗證碼，已停止。 處理好後會自動繼續。',
      due_at: '2026-11-24T13:30:00Z', machine: { id: 'm-1', label: 'Mac-B', web_url: url('/machines/m-1') }, channel: { id: 'c-1', label: 'X @makemylure', web_url: url('/channels/c-1') },
      post: { id: 'p-2', label: 'X @makemylure', web_url: url('/posts/p-2') }, actions: [{ kind: 'open', label: '開啟貼文' }], web_url: url('/posts/p-2') },
    { id: 'post:p-3', kind: 'approval', severity: 'normal', title: 'TikTok @lurelab 11-25 09:00 的貼文等你核准', detail: '請在 11-25 09:30 前核准，之後這則不會發出。', due_at: '2026-11-25T01:30:00Z',
      machine: null, channel: null, post: { id: 'p-3', label: 'TikTok @lurelab', web_url: url('/posts/p-3') },
      actions: [{ kind: 'approve', label: '核准' }, { kind: 'reject', label: '駁回' }, { kind: 'open', label: '開啟貼文' }], web_url: url('/posts/p-3') },
  ],
  upcoming: [{ content_item_id: 'ci-1', caption_excerpt: 'New lure test', media_thumb_url: null, created_at: '2026-11-24T11:50:00Z', created_by_agent: true, just_scheduled: true,
    title: 'video.mp4', media_filename: 'video.mp4',
    posts: [post(), post({ post_id: 'p-3', status: 'awaiting_approval', mode: 'assist', approval: 'awaiting_owner', approval_deadline_local: '2026-11-25 09:30',
      channel: { id: 'c-2', provider: 'tiktok', handle: 'lurelab', label: 'TikTok @lurelab', web_url: url('/channels/c-2') }, machine: { ...machineRef, id: 'm-2', name: 'Win-C' } })] }],
  recent_published: [post({ post_id: 'p-0', status: 'published', url: 'https://x.com/makemylure/status/1', local_time: '2026-11-24 08:00' })],
  machines: [machine], counts: { scheduled: 2, published: 1, needs_owner: 1, missed: 0, unknown: 0 },
};
const detail: PostDetailView = {
  post: { ...post({ status: 'unknown', blocker: { code: 'platform_error', message: 'X 回報錯誤，可能已經發出，也可能沒有。', resumable_by: 'none' } }), timezone: 'Asia/Shanghai', created_by: { type: 'agent', label: 'Agent' } },
  content: { content_item_id: 'ci-1', revision_id: 'r-1', caption: '', platform: 'x' },
  media: [{ media_id: 'a-1', file_id: 'f-1', kind: 'video', filename: 'video.mp4', bytes: 31457280, sha256: 'b'.repeat(64), duration_ms: 20000, width: 1080, height: 1920, status: 'ready', uploaded_bytes: 31457280, preview_url: null, thumbnail_url: null }],
  approval: { status: 'approved_by_channel_policy', request_id: 'ar-1', decided_at: null, decided_by: 'channel_policy', resource_hash: 'h', deadline: null },
  task: { task_id: 'j-1', kind: 'publish_post', status: 'outcome_unknown', post_id: 'p-1', channel_label: 'X @makemylure', not_before: '2026-11-25T01:00:00Z', local_time: '2026-11-25 09:00',
    blocker: null, url: null, dry_run: false, web_url: url('/posts/p-1'), attempts: 1, not_after: '2026-11-25T01:30:00Z', go_source: 'hub',
    timeline: [{ at: '2026-11-25T01:00:05Z', at_local: '2026-11-25 09:00', event: 'started', actor: 'device', text: 'Mac-B 開始發布', detail: {} },
      { at: '2026-11-25T01:00:09Z', at_local: '2026-11-25 09:00', event: 'outcome_unknown', actor: 'device', text: '已按「發布」，但讀不到貼文網址；系統不會自動重發', detail: {} }] },
  result: null, actions: ['confirm_result', 'mark_not_published'], links: { calendar: url('/calendar?view=week&week=2026-11-24&event=publish:p-1'), machine: url('/machines/m-1'), channel: url('/channels/c-1') },
};
const channel: ChannelDetail = {
  channel_id: 'c-1', provider: 'x', handle: 'makemylure', display_name: 'MakeMyLure', machine: machineRef, login: { state: 'verified', checked_at: '2026-11-24T11:00:00Z', evidence_url: null },
  execution_mode: 'browser_auto', effective_mode: 'assist', approval_mode: 'needs_approval', risk_ack: null, risk_ack_required: true, risk_ack_current: false,
  daily_cap: 10, scheduled_today: 1, published_today: 1, window: null, timezone: 'Asia/Shanghai', lateness_limit_min: 30, defaults_ready: true, pause: null,
  readiness: { logged_in: true, automation_notice: true, defaults_ready: true, approval_mode_chosen: false, risk_ack_or_assist: false, dry_run_passed: false },
  next_post: post(), can_schedule: true, blockers: [], web_url: url('/channels/c-1'),
  settings: { id: 's-1', social_account_id: 'c-1', version: 3, created_at: '', updated_at: '', execution_mode: 'browser_auto', approval_mode: 'needs_approval', approval_mode_confirmed_at: null,
    automation_notice_ack: { at: '2026-11-24T10:00:00Z', via: 'worker_app', by: 'device:m-1', version: 'automation-notice-2026-11' }, risk_ack: null, daily_cap: 10, window: null,
    timezone: 'Asia/Shanghai', lateness_limit_min: 30, caption_limit: null, chrome_profile_key: 'ch-0123456789ab', platform_defaults: { x: { reply_settings: 'everyone' } },
    settings_generation: 1, approval_generation: 1 },
  posts: [post()], checks: [], dry_runs: [],
  risk_terms: { version: 'browser-automation-risk-2026-11', zh_hant: 'X 的自動化規則寫明……', en: "X's automation rules state…" },
  automation_notice: { version: 'automation-notice-2026-11', zh_hant: 'SmartSell 會在這台機器上開啟並操作這個帳號的網頁……', en: 'SmartSell will open…',
    ack: { at: '2026-11-24T10:00:00Z', via: 'worker_app', by: 'device:m-1', version: 'automation-notice-2026-11' } },
};
const alerts: OwnerAlert[] = [{ id: 'al-1', kind: 'worker_blocker', severity: 'urgent', title: 'Mac-B 的 X @makemylure 出現驗證碼', body: '完成後會自動繼續。', at: '2026-11-24T12:00:00Z',
  machine: { id: 'm-1', label: 'Mac-B', web_url: url('/machines/m-1') }, channel: { id: 'c-1', label: 'X @makemylure', web_url: url('/channels/c-1') },
  post: { id: 'p-2', label: 'X @makemylure 21:00', web_url: url('/posts/p-2') }, web_url: url('/posts/p-2'), read_at: null }];

async function render(path: string, reads: Record<string, unknown>, lang: 'zh' | 'en' = 'zh') {
  const { useCopy } = await import('../../i18n');
  const { ViewContext } = await import('../data/use-view');
  const pages = await import('./TodayPage');
  const machines = await import('./MachinesPage');
  const { ChannelPage } = await import('./ChannelPage');
  const { ChannelsPage } = await import('./ChannelsPage');
  const { PostPage } = await import('./PostPage');
  const { NotificationsPage } = await import('./NotificationsPage');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, data] of Object.entries(reads)) {
    client.setQueryData(viewKey(ws, key, {}), { data });
    client.setQueryData(viewKey(ws, key, {}, true), { data });   // pages that read every page (WV-13)
  }
  const workspace = { id: ws, name: 'MakeMyLure', role: 'owner' };
  const session = { user: { id: 'owner-1', name: 'Owner' }, workspaces: [workspace], csrf_token: 'csrf' };
  function Localized({ children }: { children: React.ReactNode }) { useCopy().setLanguage(lang === 'en' ? 'en' : 'zh-Hant'); return <>{children}</>; }
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`${base}${path}`]}><ViewLang lang={lang}>
    <ViewContext.Provider value={{ ws, base, session, workspace } as never}><Localized><Routes><Route path="/app/:ws">
      <Route index element={<pages.TodayPage />} /><Route path="machines" element={<machines.MachinesPage />} /><Route path="machines/:id" element={<machines.MachinePage />} />
      <Route path="channels" element={<ChannelsPage />} /><Route path="channels/:id" element={<ChannelPage />} /><Route path="posts/:id" element={<PostPage />} />
      <Route path="notifications" element={<NotificationsPage />} />
    </Route></Routes></Localized></ViewContext.Provider></ViewLang></MemoryRouter></QueryClientProvider>);
}
const rawCodes = /\b(?:needs_owner|awaiting_approval|outcome_unknown|job_blocker|approved_by_channel_policy|sleep_enabled|app_outdated|worker_blocker|browser_auto|needs_approval|login_required)\b/;
const visible = (html: string) => html.replace(/<[^>]+>/g, ' ');

test('Today shows what needs the owner, the next 48 hours grouped by content, machines and recent posts, every row linked', async () => {
  const out = await render('', { '/views/today': today });
  assert.match(out, /要你處理/);
  assert.match(out, /Mac-B 的 X @makemylure 出現驗證碼/);
  assert.match(out, /href="\/app\/w1\/posts\/p-2"/);
  assert.match(out, /href="\/app\/w1\/machines\/m-1"/);
  assert.match(out, /video\.mp4 <span class="muted">→ X \+ TikTok<\/span>/);
  assert.match(out, /剛由 Codex 排程/);
  assert.match(out, /明天 09:00/);
  assert.match(out, /要你按發布/);
  assert.match(out, /期限 明天 09:30/);
  assert.match(out, /https:\/\/x\.com\/makemylure\/status\/1/);
  assert.doesNotMatch(visible(out), rawCodes);
  const en = await render('', { '/views/today': today }, 'en');
  assert.match(en, /Needs you/);
  assert.match(en, /Next 48 hours/);
  assert.match(en, /Tomorrow 09:00/);
});

test('U4: 要你處理 is one number on Today (count and badge), setup reminders fold into one entry below the cards', async () => {
  const reminder = (id: string, title: string) => ({ id: `channel:${id}:reminder`, kind: 'channel_setup' as const, blocks_scheduling: false, severity: 'normal' as const,
    title, detail: '還沒試跑：建議試跑一次（不影響排程與發布）。', due_at: null, machine: null, channel: { id, label: 'X @a', web_url: url(`/channels/${id}`) }, post: null,
    actions: [{ kind: 'open' as const, label: '開啟帳號設定' }], web_url: url(`/channels/${id}`) });
  const paused = { id: 'machine_paused:m-3', kind: 'publishing_paused' as const, blocks_scheduling: false, severity: 'urgent' as const,
    title: 'Mac-C 已暫停（換網路）：1 則貼文恢復前不會發出', detail: '你在 11-24 12:00 暫停。', due_at: null, machine: { id: 'm-3', label: 'Mac-C', web_url: url('/machines/m-3') },
    channel: null, post: null, web_url: url('/machines/m-3'),
    actions: [{ kind: 'resume' as const, label: '恢復機器', method: 'POST' as const, path: '/hub/machines/m-3/resume', body: {} }, { kind: 'open' as const, label: '開啟機器' }] };
  const data = { ...today, attention: [paused, ...today.attention, reminder('c-7', '建議：X @a 試跑一次'), reminder('c-8', 'X @b 的設定提醒（2 項，不影響排程）')] };
  const out = await render('', { '/views/today': data });
  // counts.needs_owner from the hub is 1 (posts stopped on the machine); the page counts the three cards it shows.
  assert.match(out, /<dt>要你處理<\/dt><dd>3<\/dd>/);
  assert.match(out, /<h2[^>]*>要你處理<span class="vs-badge">3<\/span><\/h2>/);
  const [cards, folded] = out.split('<details class="hub-reminders">');
  assert.equal(cards.match(/<article class="hub-attn/g)?.length, 3);
  assert.ok(cards.indexOf('Mac-C 已暫停') < cards.indexOf('出現驗證碼'), 'the urgent pause card is on top');
  assert.match(folded, /^<summary>設定提醒（2 項，不影響排程）<\/summary>/);
  assert.equal(folded.match(/<article class="hub-attn/g)?.length, 2);
  // U3: the paused machine's card offers 恢復機器 as a button, and opens the machine.
  assert.match(cards, /<button type="button" class="vs-btn primary-soft">恢復機器<\/button>/);
  assert.match(cards, /<a class="vs-btn" href="\/app\/w1\/machines\/m-3"[^>]*>開啟機器</);
  // Calendar's number is narrower (this period's posts) and says so.
  const { t } = await import('./calendar-text');
  assert.deepEqual(t.needsTitle, ['要你處理的貼文', 'Posts that need you']);
});

test('machine detail: warnings with how to fix, channels, queue linked to posts, remote screen, drivers and selectors', async () => {
  const out = await render('/machines/m-1', { '/views/machines/m-1': machine });
  assert.match(out, /Mac-B 閒置 10 分鐘會睡眠/);
  assert.match(out, /能源/);
  assert.match(out, /href="vnc:\/\/mac-b\.tail1234\.ts\.net"/);
  assert.match(out, /href="\/app\/w1\/channels\/c-1"/);
  assert.match(out, /href="\/app\/w1\/posts\/p-1"/);
  assert.match(out, /2026\.11\.2/);
  assert.match(out, /0\.2\.0 → 0\.2\.1/);
  assert.doesNotMatch(visible(out), rawCodes);
  const list = await render('/machines', { '/views/machines': [machine] });
  assert.match(list, /有新版 0\.2\.1/);
  assert.match(list, /配對新機器/);
});

test('channel detail: readiness checklist, notice, risk acknowledgement that types the handle, settings and dry run', async () => {
  const out = await render('/channels/c-1', { '/views/channels/c-1': channel, '/views/machines': [machine], '/views/media/recent': [] });
  assert.match(out, /就緒清單/);
  assert.match(out, /已選擇核准方式/);
  assert.match(out, /X 的自動化規則寫明/);
  assert.match(out, /輸入帳號名稱 @makemylure 確認/);
  assert.match(out, /尚未同意：到點會停在發布前/);
  assert.match(out, /Worker 準備好、我自己按/);
  assert.match(out, /要我在網頁按核准/);
  assert.match(out, /每日上限/);
  assert.match(out, /誰可以回覆/);
  assert.match(out, /試跑一次/);
  assert.match(out, /內建測試影片/);
  assert.match(out, /href="\/app\/w1\/machines\/m-1"/);
  assert.doesNotMatch(visible(out), rawCodes);
  const list = await render('/channels', { '/views/channels': [channel], '/views/machines': [machine] });
  assert.match(list, /就緒 3\/6/);
});

test('post detail: timeline in words, the unknown result actions with their consequences, and links to channel, machine and calendar', async () => {
  const out = await render('/posts/p-1', { '/views/posts/p-1': detail });
  assert.match(out, /結果不明/);
  assert.match(out, /不帶文字/);
  assert.match(out, /video\.mp4/);
  assert.match(out, /SHA-256 bbbbbbbbbbbb/);
  assert.match(out, /Mac-B 開始發布/);
  assert.match(out, /貼上網址（確認已發出）/);
  assert.match(out, /確認沒發出/);
  assert.match(out, /這些動作只能由你在網頁上做/);
  assert.match(out, /href="\/app\/w1\/channels\/c-1"/);
  assert.match(out, /href="\/app\/w1\/calendar\?view=week&amp;week=2026-11-24&amp;event=publish:p-1"/);
  assert.doesNotMatch(visible(out), rawCodes);
  const en = await render('/posts/p-1', { '/views/posts/p-1': detail }, 'en');
  assert.match(en, /Clicked Post, URL unknown/);
  assert.match(en, /It was not posted/);
});

test('notifications list every alert linked to its post, channel and machine', async () => {
  const out = await render('/notifications', { '/views/alerts': alerts });
  assert.match(out, /需要你處理/);
  assert.match(out, /href="\/app\/w1\/posts\/p-2"/);
  assert.match(out, /href="\/app\/w1\/machines\/m-1"/);
  assert.match(out, /標為已讀/);
});

test('agent-connect accepts only the App\'s request and hands back workspace, code, state and connection in the fragment', async () => {
  const { agentReturnUrl, parseAgentConnect } = await import('../../agent-connect');
  const state = 'A'.repeat(43);
  const intent = parseAgentConnect(`?client=codex&port=51234&state=${state}&label=${encodeURIComponent('dp-mbp · Codex')}`)!;
  assert.deepEqual(intent, { client: 'codex', port: '51234', state, label: 'dp-mbp · Codex' });
  for (const bad of [`?client=gpt&port=51234&state=${state}&label=x`, `?client=codex&port=80&state=${state}&label=x`, `?client=codex&port=51234&state=short&label=x`,
    `?client=codex&port=51234&state=${state}&label=x&extra=1`, `?client=codex&port=51234&state=${state}&label=`]) assert.equal(parseAgentConnect(bad), undefined, bad);
  const back = agentReturnUrl(intent, 'd4a7c9e1-6f5b-4d8c-9e0a-9b8c7f6e5d43', { id: '5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e', client: 'codex', code: 'c'.repeat(120) });
  const parsed = new URL(back);
  assert.equal(parsed.origin, 'http://127.0.0.1:51234');
  assert.equal(parsed.pathname, '/smartsell-agent');
  assert.equal(parsed.search, '');
  assert.deepEqual([...new URLSearchParams(parsed.hash.slice(1)).keys()], ['workspace', 'code', 'state', 'connection']);
});

test('the setup page reads the setup token from the URL fragment only', async () => {
  const { readSetupToken } = await import('../../authentication-form');
  assert.equal(readSetupToken('#setup-token=abc_DEF-123'), 'abc_DEF-123');
  assert.equal(readSetupToken('#other=1'), undefined);
  assert.equal(readSetupToken(''), undefined);
  assert.equal(readSetupToken('#setup-token=has%20space'), undefined);
});

// ---------- Wave 6 (G4-web) ----------

test('WV-4 (E35): Today shows a pause item that links to settings, and held rows say 已暫停; WV-6: the upcoming list names its zone', async () => {
  const paused = { scope: 'workspace', reason: '先全部暫停', by: 'agent', at: '2026-11-24T04:00:00Z', resume_web_url: url('/settings#st-pause'), pause_id: 'ps-1' };
  const data: TodayData = { ...today,
    attention: [{ id: 'pause:ps-1', kind: 'publishing_paused', severity: 'urgent', title: '全部發布已暫停：1 則貼文恢復前不會發出', blocks_scheduling: false,
      detail: 'Agent 在 11-24 12:00 暫停（先全部暫停）。', due_at: '2026-11-25T01:00:00Z', machine: null, channel: null, post: null,
      actions: [{ kind: 'open', label: '到設定頁恢復' }], web_url: url('/settings#st-pause') }],
    upcoming: [{ ...today.upcoming[0], posts: [{ ...post(), pause: paused } as PostSummary] }] };
  const out = await render('', { '/views/today': data });
  assert.match(out, /<span class="hub-badge tone-critical">已暫停<\/span>/);
  assert.match(out, /全部發布已暫停：1 則貼文恢復前不會發出/);
  assert.match(out, /href="\/app\/w1\/settings#st-pause"[^>]*>到設定頁恢復/);
  assert.match(out, /已排程<\/span><span class="hub-badge tone-warning">已暫停<\/span>/);
  assert.match(out, /時間以 Asia\/Shanghai 顯示/);
  assert.doesNotMatch(visible(out), /publishing_paused/);
});

test('WV-2/WV-9: a lapsed approval card offers 改到…; a card button that sent once stays usable (no latched 已送出)', async () => {
  const data: TodayData = { ...today, attention: [
    { id: 'post:p-3', kind: 'approval', severity: 'urgent', title: 'TikTok @lurelab 11-25 09:00 的貼文核准期限已過', detail: '核准期限（11-24 21:00）已過，這則目前不會發出；改期即可重新送審。',
      due_at: '2026-11-24T13:00:00Z', machine: null, channel: null, post: { id: 'p-3', label: 'TikTok @lurelab', web_url: url('/posts/p-3') },
      actions: [{ kind: 'reschedule', label: '改到…' }, { kind: 'open', label: '開啟貼文' }], web_url: url('/posts/p-3') },
    { id: 'login:c-1', kind: 'login', severity: 'urgent', title: 'X @makemylure 要重新登入（Mac-B）', detail: 'Mac-B 上的 X @makemylure 登入已失效。', due_at: null,
      machine: { id: 'm-1', label: 'Mac-B', web_url: url('/machines/m-1') }, channel: { id: 'c-1', label: 'X @makemylure', web_url: url('/channels/c-1') }, post: null,
      actions: [{ kind: 'check_login', label: '檢查登入', method: 'POST', path: '/hub/channels/c-1/check', body: {} }, { kind: 'open', label: '開啟帳號' }], web_url: url('/channels/c-1') },
  ] };
  const out = await render('', { '/views/today': data });
  assert.match(out, /<button type="button" class="vs-btn primary-soft" aria-expanded="false">改到…<\/button>/);
  assert.doesNotMatch(out, />核准 \/ 駁回</);
  assert.match(out, /<button type="button" class="vs-btn primary-soft">檢查登入<\/button>/);
  const { cardSignature } = await import('./TodayPage');
  const card = data.attention[1];
  assert.equal(cardSignature(card), cardSignature({ ...card }));
  assert.notEqual(cardSignature(card), cardSignature({ ...card, detail: '另一個問題' }), 'a changed card drops the earlier notice');
});

test('post page: E35 pause note, E37 rejected status and note, WV-10 approval time in the post zone, E36 force-release copy', async () => {
  const paused = { scope: 'social_account', reason: '檢查文案', by: 'person', at: '2026-11-24T04:00:00Z', resume_web_url: url('/settings#st-pause'), pause_id: 'ps-1' };
  const held = { ...detail, post: { ...detail.post, status: 'scheduled', blocker: null, pause: paused }, actions: ['reschedule', 'cancel'],
    approval: { ...detail.approval, status: 'approved', decided_by: 'owner-1', decided_at: '2026-11-24T01:15:00Z' } } as PostDetailView;
  const out = await render('/posts/p-1', { '/views/posts/p-1': held });
  assert.match(out, /已暫停：恢復前不會發出/);
  assert.match(out, /這個帳號在 [^<]*12:00 被人工暫停：檢查文案/);
  assert.match(out, /href="\/app\/w1\/settings#st-pause"/);
  assert.match(out, /已核准<small class="muted"> · [^<]*09:15<\/small>/, 'decided_at 01:15Z is 09:15 in Asia/Shanghai');
  assert.doesNotMatch(out, /01:15/);
  const rejected = { ...detail, post: { ...detail.post, status: 'rejected', approval: 'rejected', blocker: null }, actions: ['reschedule', 'cancel'],
    approval: { ...detail.approval, status: 'rejected', decided_at: '2026-11-24T01:15:00Z' } } as PostDetailView;
  const no = await render('/posts/p-1', { '/views/posts/p-1': rejected });
  assert.match(no, /<span class="hub-badge tone-neutral">已駁回<\/span>/);
  assert.match(no, /你駁回了這則，它不會發出。要發的話，按「改到…」選時間就會重新送審。/);
  assert.doesNotMatch(visible(no), /\brejected\b/);
  const { hub } = await import('../hub-copy');
  assert.match(hub.action.forceHint[0], /中樞沒有收到它開始發布的紀錄/);
});

test('WV-3: an approval answered 200 but blocked or expired is not shown as 已送出', async () => {
  const { approvalNotice } = await import('../hub-parts');
  const zh = (label: readonly [string, string]) => label[0];
  assert.deepEqual(approvalNotice(zh, 'approve', { decision_status: 'blocked', precheck: { items: [
    { severity: 'blocker', result: 'fail', message: 'Win-C 已暫停，這則不會發出，直到你恢復機器。' }, { severity: 'risk', result: 'fail', message: 'ignored' }] } }),
  { tone: 'warning', text: '沒有核准：Win-C 已暫停，這則不會發出，直到你恢復機器。' });
  assert.deepEqual(approvalNotice(zh, 'approve', { decision_status: 'expired' }), { tone: 'warning', text: '核准期限已過，這則不會發出；可以改期重新送審。' });
  assert.deepEqual(approvalNotice(zh, 'approve', { plan_status: 'ready' }), { tone: 'good', text: '已送出。' });
});

test('WV-11: refused actions read in zh-Hant owner copy (details.owner_message first); 改到… starts at a future time', async () => {
  const { ApiError } = await import('@smartsell/sdk');
  const { defaultRescheduleTime, ownerProblemText } = await import('../hub-parts');
  const zh = (label: readonly [string, string]) => label[0];
  const en = (label: readonly [string, string]) => label[1];
  const past = new ApiError(422, { code: 'TIME_IN_PAST', detail: '2026-11-24 09:00 Asia/Taipei is in the past (now 2026-11-24 10:12). Use a later time or "now".' });
  assert.equal(ownerProblemText(zh, 'zh', past), '這個時間已經過了，請選一個之後的時間。');
  assert.equal(ownerProblemText(en, 'en', past), 'That time has passed; pick a later time.');
  const locked = new ApiError(409, { code: 'POST_LOCKED', detail: 'Publishing is in progress; wait for the result.', details: { owner_message: '正在發布中，無法修改；請等結果。' } });
  assert.equal(ownerProblemText(zh, 'zh', locked), '正在發布中，無法修改；請等結果。');
  assert.equal(ownerProblemText(zh, 'zh', new ApiError(409, { code: 'POST_FINAL', detail: 'Final. Use post_schedule to post again.' })), '這則已經發出或已取消，不能再改。要再發一次，請在 Codex 重新排程。');
  const stale = new ApiError(409, { code: 'INVALID_STATE', detail: 'Resubmit the target to obtain a pending request' });
  assert.equal(ownerProblemText(zh, 'zh', stale, 'approve'), '這則目前沒有可以核准的請求（期限已過或已處理），不會發出；改期即可重新送審。');
  assert.equal(ownerProblemText(zh, 'zh', new ApiError(409, { code: 'POSSIBLY_SENT', detail: '這則可能已經發出' })),
    '這則可能已經發出，不能強制釋放。請先到平台確認：有就按「貼上網址」，沒有就按「確認沒發出」。');
  assert.equal(ownerProblemText(zh, 'zh', new ApiError(422, { code: 'CONFIRM_TEXT_MISMATCH', details: { expected: '我確認 Mac-B 已關機或已斷網，不會發出這則貼文。' } })),
    '請輸入：我確認 Mac-B 已關機或已斷網，不會發出這則貼文。');
  for (const code of ['APPROVAL_STALE', 'RETRY_NOT_ALLOWED', 'RESUME_NOT_ALLOWED', 'POST_RESULT_UNKNOWN', 'TIME_NONEXISTENT', 'TIME_AMBIGUOUS']) {
    assert.match(ownerProblemText(zh, 'zh', new ApiError(409, { code, detail: 'English for the Agent' })) ?? '', /\p{Script=Han}/u, code);
  }
  assert.equal(ownerProblemText(zh, 'zh', new ApiError(500, { code: 'SOMETHING_NEW', detail: 'x' })), undefined, 'unknown codes fall back to the plain problem');
  const now = Date.parse('2026-11-24T02:12:00Z');   // 10:12 in Asia/Taipei
  assert.equal(defaultRescheduleTime({ scheduled_at: '2026-11-24T01:00:00Z', local_time: '2026-11-24 09:00' }, 'Asia/Taipei', now), '2026-11-24T11:00');
  assert.equal(defaultRescheduleTime({ scheduled_at: '2026-11-25T01:00:00Z', local_time: '2026-11-25 09:00' }, 'Asia/Taipei', now), '2026-11-25T09:00');
});

test('U8: errors read in plain words; status, code and the server text are only under 詳細資料', async () => {
  const { ApiError } = await import('@smartsell/sdk');
  const { ProblemNotice, problemMessage } = await import('../../api');
  const { ownerProblemText } = await import('../hub-parts');
  const zh = (label: readonly [string, string]) => label[0];
  const en = (label: readonly [string, string]) => label[1];
  const t = (key: string) => key;
  assert.equal(problemMessage(new ApiError(500, { code: 'INTERNAL', detail: 'boom' }), zh, t),
    '中樞處理這個要求時出了問題，請稍後再試。一直發生的話，請在中樞那台電腦執行 pnpm hub:doctor。');
  assert.equal(problemMessage(new TypeError('Failed to fetch'), zh, t), '中樞沒有回應。請確認中樞那台電腦開著、SmartSell 正在執行，再按「重新載入」。');
  assert.equal(problemMessage(new ApiError(502, {}), en, t), 'The hub is not responding. Check that the hub computer is on and SmartSell is running, then reload.');
  assert.equal(problemMessage(new ApiError(422, { code: 'INVALID_ARGUMENTS', detail: 'bad', details: { issues: [{ path: 'when', message: 'when must be …' }, { path: 'body.url', message: 'x' }] } }), zh, t),
    '有欄位不正確：時間、網址。請修改後再送出。');
  assert.equal(problemMessage(new ApiError(409, { code: 'FRESH_IDENTITY_CHECK_REQUIRED', detail: 'Check the identity again first.' }), en, t), 'Check the identity again first.',
    'a specific refusal keeps the server sentence');
  const out = renderToStaticMarkup(<ProblemNotice error={new ApiError(500, { code: 'INTERNAL', detail: 'boom', request_id: 'req-1' })} retry={() => undefined} />);
  const [shown, folded] = out.split('<details class="problem-details">');
  assert.doesNotMatch(shown, /500|INTERNAL|boom/, 'nothing for developers above the fold');
  assert.match(folded, /^<summary>詳細資料<\/summary><small>500 · INTERNAL<\/small><small>boom<\/small><small>request_id req-1<\/small><\/details>/);
  // 貼上網址 refused: say which link is wanted, for this channel's handle.
  const pasted = new ApiError(422, { code: 'INVALID_ARGUMENTS', detail: '這不是 X 的網址', details: { issues: [{ path: 'url', message: '這不是 X 的網址' }] } });
  const subject = { provider: 'x', handle: 'fixture_x' };
  assert.equal(ownerProblemText(zh, 'zh', pasted, 'confirm_result', subject),
    '中樞不接受這個網址（這不是 X 的網址）。請貼上 @fixture_x 在 X 上這則貼文的網址，例如 https://x.com/fixture_x/status/1860000000000000000');
  assert.equal(ownerProblemText(en, 'en', pasted, 'confirm_result', { provider: 'tiktok', handle: 'minglures' }),
    'That link was not accepted. Paste the link to this post by @minglures on TikTok, e.g. https://www.tiktok.com/@minglures/video/7300000000000000000');
  assert.equal(ownerProblemText(zh, 'zh', new ApiError(422, { code: 'INVALID_ARGUMENTS', details: { issues: [{ path: 'reason', message: 'Unknown field' }] } })),
    '有欄位不正確：原因。請修改後再送出。');
});

test('E41 machine page offers 撤銷這台機器 with a typed name; WV-6 machine times are in the browser zone it names', async () => {
  const out = await render('/machines/m-1', { '/views/machines/m-1': machine });
  assert.match(out, /撤銷這台機器/);
  assert.match(out, /時間以 Asia\/Shanghai 顯示/);
  const list = await render('/machines', { '/views/machines': [{ ...machine, next_job: { ...machine.next_job!, local_time: '2026-11-24 20:00' } }] });
  assert.match(list, /下一則<\/dt><dd><a [^>]*>[^<]*09:00<\/a>/, 'next_job.at 01:00Z in the page zone, not the hub-rendered text');
  const { readRetireResult, RetiredNotice } = await import('./MachinesPage');
  const result = readRetireResult({ machine_id: 'm-1', name: 'Mac-B', status: 'revoked', already_retired: false, jobs: { waiting_for_machine: 2, ended: 1, to_confirm: 1 },
    channels: [{ social_account_id: 'c-1', label: 'X @makemylure' }], posts_to_confirm: ['p-9abcdef0'] });
  const { hub } = await import('../hub-copy');
  assert.match(hub.machines.retireHint[0], /不會重發/);
  const { ViewContext } = await import('../data/use-view');
  const html = renderToStaticMarkup(<MemoryRouter><ViewContext.Provider value={{ ws, base } as never}><RetiredNotice result={result} /></ViewContext.Provider></MemoryRouter>);
  assert.match(html, /已撤銷 Mac-B。/);
  assert.match(html, /2 則還沒開始的貼文等待新的機器/);
  assert.match(html, /href="\/app\/w1\/posts\/p-9abcdef0"/);
  assert.match(html, /href="\/app\/w1\/channels\/c-1"[^>]*>X @makemylure<\/a> · 換機器/);
});

test('channel page: E42 time-zone select, E38 lateness from 2 minutes, WV-6 post times in the channel zone', async () => {
  const later = { ...channel, timezone: 'America/New_York', settings: { ...channel.settings, timezone: 'America/New_York' },
    posts: [post({ local_time: '2026-11-25 09:00' })], next_post: post({ local_time: '2026-11-25 09:00' }) };
  const out = await render('/channels/c-1', { '/views/channels/c-1': later, '/views/machines': [machine], '/views/media/recent': [] });
  assert.match(out, /時區<select><option value="America\/New_York" selected="">America\/New_York<\/option>|時區<select>[\s\S]*<option value="America\/New_York" selected="">/);
  assert.match(out, /<input type="number" min="2" max="240"/);
  assert.match(out, /<span class="hub-row-time">[^<]*20:00<\/span>/, '01:00Z is 20:00 the day before in New York');
  const { timeZones } = await import('./ChannelPage');
  assert.ok(timeZones('UTC').includes('UTC'));
  assert.equal(timeZones('Mars/Olympus')[0], 'Mars/Olympus');
});

test('E46: the setup wizard warns when Tailscale Funnel exposes the hub', async () => {
  const { HubAddress } = await import('./setup-hub');
  const { useCopy } = await import('../../i18n');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const warning = '中樞被 Tailscale Funnel 公開到網際網路（https://hub.example.ts.net）：任何人都能連到登入頁、配對與 Agent 連線端點。請執行：tailscale serve --bg --https=443 http://127.0.0.1:3401。';
  client.setQueryData(['hub-info'], { development: false, info: { public_origin: 'https://hub.example.ts.net', request_origin_ok: true,
    tailscale: { serve_ok: true, funnel_on: true, funnel_warning: warning } } });
  function Localized({ children }: { children: React.ReactNode }) { useCopy().setLanguage('zh-Hant'); return <>{children}</>; }
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ViewLang lang="zh"><Localized><HubAddress /></Localized></ViewLang></QueryClientProvider>);
  assert.match(html, /中樞被公開到網際網路/);
  assert.match(html, /tailscale serve --bg --https=443/);
  client.setQueryData(['hub-info'], { development: false, info: { public_origin: 'https://hub.example.ts.net', tailscale: { serve_ok: true, funnel_on: false, funnel_warning: null } } });
  assert.doesNotMatch(renderToStaticMarkup(<QueryClientProvider client={client}><ViewLang lang="zh"><Localized><HubAddress /></Localized></ViewLang></QueryClientProvider>), /公開到網際網路/);
});
