import { expect, test as base } from '@playwright/test';
import { RISK_TERMS_VERSION } from '../../packages/contracts/src/phase1.ts';
import { localDev, localWorkerOnboarding } from './local-dev.mjs';
import { mcpClient, ownerWorkspace, pairMachine, postingFixture, schedulePost, sessionRest } from './phase1-fixture.mjs';
import { expectStepStatus, expectToday, expectWizardStep, wizardSteps } from './phase1-shell.mjs';

// The phase-1 owner dashboard (phase1-design §9) on real data: a machine paired with the signed protocol, an X channel
// that machine registered, media uploaded through the relay code and posts scheduled by an Agent over MCP.
const test = base.extend({ dev: localDev });
test.use({ viewport: { width: 1280, height: 800 }, timezoneId: 'UTC' });

function responseFor(page, method, path) {
  const pending = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path, { timeout: 10_000 });
  void pending.catch(() => {});
  return pending;
}

test('Today: the owner approves a post Codex scheduled, inline from 要你處理', async ({ page, dev }) => {
  const fixture = await postingFixture(page, dev);
  const { ws, channelId } = fixture;
  const { day, post, scheduled } = await schedulePost(fixture, { caption: '新魚餌實測' });
  // A new channel waits for the owner's approval (§12.3 default) and the Worker stops before Post (no risk accepted, §4.5).
  expect(post).toMatchObject({ channel_id: channelId, provider: 'x', handle: '@fixture_x', status: 'awaiting_approval', approval: 'awaiting_owner',
    approval_deadline_local: `${day} 09:30`, route: { kind: 'machine', machine_name: 'Mac-B', mode: 'assist' } });
  expect(scheduled.web_url).toContain(`/app/${ws.id}/calendar?view=week&week=`);

  await page.goto(ws.app);
  await expectToday(page);
  const main = page.getByRole('main');
  const attention = main.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: /^要你處理/ }) });
  const card = attention.getByRole('article', { name: /^X @fixture_x .*09:00 的貼文等你核准$/ });
  await expect(card).toHaveCount(1);
  await expect(card.getByText('核准', { exact: true })).toBeVisible();
  await expect(card).toContainText(`請在 ${day.slice(5)} 09:30 前核准，之後這則不會發出。`);
  await expect(card.getByText('新魚餌實測', { exact: true })).toBeVisible();
  // Every card links to its post, machine and channel (§9.6).
  await expect(card.getByRole('link', { name: 'Mac-B', exact: true })).toHaveAttribute('href', `/app/${ws.id}/machines/${fixture.machine.id}`);
  await expect(card.getByRole('link', { name: 'X @fixture_x', exact: true })).toHaveAttribute('href', `/app/${ws.id}/channels/${channelId}`);
  await expect(card.getByRole('link', { name: '開啟貼文', exact: true })).toHaveAttribute('href', `/app/${ws.id}/posts/${post.post_id}`);

  // 接下來 48 小時: one card per schedule, 「video.mp4 → X」, marked as just scheduled by Codex.
  const upcoming = main.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: '接下來 48 小時', exact: true }) });
  const group = upcoming.getByRole('article').filter({ has: page.getByRole('heading', { level: 3, name: 'video.mp4 → X', exact: true }) });
  await expect(group).toHaveCount(1);
  await expect(group.getByText('剛由 Codex 排程', { exact: true })).toBeVisible();
  const row = group.getByRole('link').filter({ hasText: '@fixture_x' });
  await expect(row).toHaveAttribute('href', `/app/${ws.id}/posts/${post.post_id}`);
  await expect(row).toContainText('Mac-B');
  await expect(row).toContainText('要你按發布');
  await expect(row).toContainText('待你核准');

  // Approve inline: the card opens the post's own actions (§9.2 approval card, §5.14).
  const toggle = card.getByRole('button', { name: '核准 / 駁回', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(card).toContainText('待你核准');
  const approved = responseFor(page, 'POST', `${ws.root}/publish-targets/${post.post_id}/approve`);
  await card.getByRole('button', { name: '核准', exact: true }).click();
  const response = await approved;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().headers()['if-match']).toMatch(/^"?\d+"?$/);
  expect(response.request().headers()['x-csrf-token']).toBeTruthy();

  // The card leaves 要你處理 and the row shows the post as scheduled.
  await expect(attention.getByRole('article', { name: /的貼文等你核准$/ })).toHaveCount(0, { timeout: 15_000 });
  await expect(row).toContainText('已排程');
  await expect(row).not.toContainText('待你核准');
  const detail = await ws.rest('GET', `/views/posts/${post.post_id}`);
  expect(detail.approval.status).toBe('approved');
  expect(detail.post.status).toBe('scheduled');
  // The approved post is dispatched to the channel's machine ahead of time (§5.2).
  const [job] = await fixture.machine.claim();
  expect(job).toMatchObject({ kind: 'publish_post', mode: 'assist', dry_run: false });
  expect(job.payload).toMatchObject({ publish_target_id: post.post_id, provider: 'x', scheduled_at: `${day}T09:00:00.000Z`,
    media: [expect.objectContaining({ filename: 'video.mp4', sha256: fixture.media.sha256 })] });
});

test('Channel page: 代按發布 needs the box checked and the handle typed, and can be withdrawn', async ({ page, dev }) => {
  const ws = await ownerWorkspace(page, dev);
  const machine = await pairMachine(dev, ws, 'Mac-B');
  await machine.heartbeat();
  const channelId = await machine.addChannel('x', 'fixture_x');
  await machine.heartbeat();
  // The server is the guard, not the button: a handle that does not match is refused (§4.5).
  const mismatch = await ws.rest('POST', `/hub/channels/${channelId}/risk-ack`, { terms_version: RISK_TERMS_VERSION, typed_handle: '@someone_else' }, { status: 422 });
  expect(mismatch).toMatchObject({ code: 'HANDLE_MISMATCH' });

  await page.goto(`${ws.app}/channels`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: '帳號', exact: true })).toBeVisible();
  const card = main.getByRole('article').filter({ has: page.getByRole('heading', { level: 2, name: /@fixture_x$/ }) });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Mac-B');
  await expect(card).toContainText('已登入');
  await expect(card).toContainText('要你按發布');
  await expect(card).toContainText('要我在網頁按核准');
  await card.getByRole('link', { name: /@fixture_x$/ }).click();
  await expect(page).toHaveURL(`${ws.app}/channels/${channelId}`);
  await expect(main.getByRole('heading', { level: 1, name: '@fixture_x', exact: true })).toBeVisible();
  const header = page.locator('.vs-page-head');
  await expect(header).toContainText('要你按發布');

  const checklist = main.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: '就緒清單', exact: true }) });
  const riskItem = checklist.getByRole('listitem').filter({ hasText: '已確認代按發布的風險' });
  await expect(riskItem).toContainText('否');
  const risk = main.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: '代按發布', exact: true }) });
  await expect(risk).toContainText('尚未同意：到點會停在發布前，等你在機器上按「發布」。');
  const accept = risk.getByRole('button', { name: '同意並允許代按發布', exact: true });
  const agree = risk.getByRole('checkbox', { name: '我了解並接受上述風險，允許 Worker 在這個帳號代按發布', exact: true });
  const typed = risk.getByRole('textbox', { name: '輸入帳號名稱 @fixture_x 確認' });
  await expect(accept).toBeDisabled();
  await agree.check();
  await expect(accept).toBeDisabled();
  await typed.fill('@someone_else');
  await expect(accept).toBeDisabled();
  await agree.uncheck();
  await typed.fill('FIXTURE_X');
  await expect(accept).toBeDisabled();
  await agree.check();
  await expect(accept).toBeEnabled();
  const acked = responseFor(page, 'POST', `${ws.root}/hub/channels/${channelId}/risk-ack`);
  await accept.click();
  const response = await acked;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ terms_version: RISK_TERMS_VERSION, typed_handle: 'FIXTURE_X' });
  await expect(risk.getByText(/^已同意（.+）$/)).toBeVisible();
  await expect(risk.getByRole('button', { name: '撤回同意', exact: true })).toBeVisible();
  await expect(riskItem).toContainText('是');
  await expect(header).toContainText('Worker 自動發');
  expect(await ws.rest('GET', `/views/channels/${channelId}`)).toMatchObject({ risk_ack_current: true, effective_mode: 'auto',
    risk_ack: expect.objectContaining({ terms_version: RISK_TERMS_VERSION }) });
  // The next heartbeat tells the machine it may click Post for this channel (§5.4.1 channels[].effective_mode).
  expect((await machine.heartbeat()).channels).toEqual([expect.objectContaining({ social_account_id: channelId, effective_mode: 'auto' })]);

  // Withdrawing goes back to stopping before Post.
  const cleared = responseFor(page, 'DELETE', `${ws.root}/hub/channels/${channelId}/risk-ack`);
  await risk.getByRole('button', { name: '撤回同意', exact: true }).click();
  expect((await cleared).status()).toBe(200);
  await expect(risk).toContainText('尚未同意：到點會停在發布前，等你在機器上按「發布」。');
  await expect(header).toContainText('要你按發布');
  await expect(riskItem).toContainText('否');
  expect(await ws.rest('GET', `/views/channels/${channelId}`)).toMatchObject({ risk_ack_current: false, effective_mode: 'assist' });
});

test('Post page: timeline from the machine, then the owner reschedules and cancels a claimed post', async ({ page, dev }) => {
  const fixture = await postingFixture(page, dev);
  const { ws, channelId, machine } = fixture;
  // The owner lets Codex post directly on this channel (§4.1), so the post is scheduled and dispatched at once.
  const { settings } = await ws.rest('GET', `/views/channels/${channelId}`);
  await ws.rest('PATCH', `/hub/channels/${channelId}/settings`, { approval_mode: 'direct' }, { version: settings.version });
  const { day, post } = await schedulePost(fixture, { caption: '新魚餌實測' });
  expect(post).toMatchObject({ status: 'scheduled', approval: 'approved_by_channel_policy', local_time: `${day} 09:00 UTC` });

  await page.goto(`${ws.app}/posts/${post.post_id}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'X @fixture_x · 新魚餌實測', exact: true })).toBeVisible();
  const facts = main.locator('.hub-facts').first();
  await expect(main.locator('.hub-post-head')).toContainText('已排程');
  await expect(main.locator('.hub-post-head')).toContainText('09:00');
  await expect(main.locator('.hub-post-head')).toContainText('由 Agent 建立');
  await expect(facts.getByRole('link', { name: /@fixture_x$/ })).toHaveAttribute('href', `/app/${ws.id}/channels/${channelId}`);
  await expect(facts.getByRole('link', { name: 'Mac-B', exact: true })).toHaveAttribute('href', `/app/${ws.id}/machines/${machine.id}`);
  await expect(facts).toContainText('已依帳號設定自動核准');
  await expect(facts.getByRole('link', { name: '在日曆中查看', exact: true })).toHaveAttribute('href',
    new RegExp(`^/app/${ws.id}/calendar\\?view=week&week=\\d{4}-\\d{2}-\\d{2}&event=publish:${post.post_id}$`));
  const content = main.getByRole('region', { name: '內容', exact: true });
  await expect(content.getByText('新魚餌實測', { exact: true })).toBeVisible();
  await expect(content.locator('figcaption')).toContainText('video.mp4');
  await expect(content.locator('figcaption')).toContainText(`SHA-256 ${fixture.media.sha256.slice(0, 12)}`);
  const timeline = main.getByRole('region', { name: '時間線', exact: true }).getByRole('listitem');
  await expect(timeline).toHaveText([/已排入 Mac-B 的佇列$/]);
  const actions = main.getByRole('region', { name: '動作', exact: true });
  await expect(actions.getByRole('button')).toHaveText(['改到…', '取消這則']);
  await expect(actions).toContainText('這些動作只能由你在網頁上做，Agent 不能代做。');

  // 改到…: the owner picks a new local time; the queued job follows it.
  await actions.getByRole('button', { name: '改到…', exact: true }).click();
  await expect(actions).toContainText('選新的時間（UTC）。需要核准的帳號會重新送審。');
  await actions.getByLabel('新的時間').fill(`${day}T10:30`);
  const rescheduled = responseFor(page, 'POST', `${ws.root}/hub/posts/${post.post_id}/update`);
  await actions.getByRole('button', { name: '確認', exact: true }).click();
  const update = await rescheduled;
  expect(update.status(), await update.text()).toBe(200);
  expect(update.request().postDataJSON()).toEqual({ action: 'reschedule', when: `${day} 10:30`, timezone: 'UTC' });
  await expect(actions.getByRole('status')).toHaveText('已送出。');
  await expect(main.locator('.hub-post-head')).toContainText('10:30');
  expect((await ws.rest('GET', `/views/posts/${post.post_id}`)).post).toMatchObject({ scheduled_at: `${day}T10:30:00.000Z`, status: 'scheduled' });

  // The machine claims the job and reports its pre-check; both land on the timeline in order (§3.6, §9.5).
  const [job] = await machine.claim();
  expect(job).toMatchObject({ kind: 'publish_post', not_before: `${day}T10:30:00.000Z` });
  await machine.report(job, 'prepared', { stage: 'preflight', login: 'verified', identity: 'fixture_x', handle: 'fixture_x', media_ok: true,
    driver: { provider: 'x', version: 'x@2026.11.1' } });
  await machine.heartbeat();
  await expect(timeline.last()).toHaveText(/Mac-B 完成預檢：已登入 @fixture_x$/, { timeout: 15_000 });
  await expect(timeline.filter({ hasText: /Mac-B 已領取$/ })).toHaveCount(1);

  // 取消這則 on a claimed post: 取消中 until the machine confirms it dropped the job (§5.10, Appendix C.2).
  await actions.getByRole('button', { name: '取消這則', exact: true }).click();
  await expect(actions).toContainText('取消後這則不會發出。機器已領取的，會先顯示「取消中」，機器確認後才算取消。');
  await actions.getByLabel('原因（選填）').fill('改用新影片');
  const cancelled = responseFor(page, 'POST', `${ws.root}/hub/posts/${post.post_id}/update`);
  await actions.getByRole('button', { name: '確認', exact: true }).click();
  const cancel = await cancelled;
  expect(cancel.status(), await cancel.text()).toBe(200);
  expect(cancel.request().postDataJSON()).toEqual({ action: 'cancel', reason: '改用新影片' });
  await expect(main.locator('.hub-post-head')).toContainText('取消中');
  await expect(timeline.last()).toHaveText(/已要求 Mac-B 放棄這則$/);
  const revoked = await machine.heartbeat();
  expect(revoked.revoked_jobs).toEqual([expect.objectContaining({ job_id: job.job_id })]);
  machine.release(job.job_id);
  await machine.heartbeat();
  await expect(main.locator('.hub-post-head')).toContainText('已取消', { timeout: 15_000 });
  await expect(timeline.last()).toHaveText(/Mac-B 已放棄這則$/);
  await expect(actions.getByRole('button')).toHaveCount(0);
  await expect(actions).toContainText('這則貼文目前沒有需要你做的事。');
  expect((await ws.rest('GET', `/views/posts/${post.post_id}`)).post.status).toBe('cancelled');
});

test('Notifications bell: alerts link to what they are about, one is marked read, then all', async ({ page, dev }) => {
  const fixture = await postingFixture(page, dev, { withoutDailySummary: true });
  const { ws } = fixture;
  const { post } = await schedulePost(fixture);
  // The upload finishing and the approval request each raise an owner alert (§5.9, S10).
  const unread = () => ws.rest('GET', '/views/alerts?unread=true');
  await expect.poll(async () => (await unread()).map(alert => alert.kind).sort(), { timeout: 20_000 }).toEqual(['approval_due', 'upload_done']);
  const alerts = await unread();
  const approval = alerts.find(alert => alert.kind === 'approval_due');
  expect(approval.post).toMatchObject({ id: post.post_id });

  await page.goto(ws.app);
  await expectToday(page);
  const bell = page.getByRole('button', { name: '通知 · 2 則未讀', exact: true });
  await expect(bell).toHaveAttribute('aria-expanded', 'false');
  await bell.click();
  const panel = page.getByRole('dialog', { name: '通知', exact: true });
  const rows = panel.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  const approvalRow = rows.filter({ hasText: '等你核准' });
  await expect(approvalRow.getByRole('link', { name: approval.title, exact: true })).toHaveAttribute('href', new URL(approval.web_url).pathname);
  await expect(approvalRow.getByRole('link', { name: approval.post.label, exact: true })).toHaveAttribute('href', `/app/${ws.id}/posts/${post.post_id}`);
  await expect(panel.getByRole('link', { name: '查看全部通知', exact: true })).toHaveAttribute('href', `/app/${ws.id}/notifications`);

  // One alert marked read on its own.
  const uploadRow = rows.filter({ hasText: '上傳完成' });
  const single = responseFor(page, 'POST', `${ws.root}/hub/alerts/read`);
  await uploadRow.getByRole('button', { name: '標為已讀', exact: true }).click();
  expect((await single).request().postDataJSON()).toEqual({ ids: [alerts.find(alert => alert.kind === 'upload_done').id] });
  await expect(page.getByRole('button', { name: '通知 · 1 則未讀', exact: true })).toBeVisible();
  await expect(uploadRow.getByRole('button', { name: '標為已讀', exact: true })).toHaveCount(0);

  // 全部標為已讀.
  const all = responseFor(page, 'POST', `${ws.root}/hub/alerts/read`);
  await panel.getByRole('button', { name: '全部標為已讀', exact: true }).click();
  expect((await all).request().postDataJSON()).toEqual({ all: true });
  await expect(page.getByRole('button', { name: '通知', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '全部標為已讀', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '標為已讀', exact: true })).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  expect(await unread()).toEqual([]);

  // The full list keeps them, read; the unread filter is empty; the alert's link opens the post.
  await panel.getByRole('link', { name: '查看全部通知', exact: true }).click();
  await expect(page).toHaveURL(`${ws.app}/notifications`);
  const list = page.getByRole('main').getByRole('listitem');
  await expect(list).toHaveCount(2);
  // The filter lives in the URL; the box follows it after the navigation, so click and then assert the state.
  const unreadOnly = page.getByRole('main').getByRole('checkbox', { name: '只看未讀', exact: true });
  await unreadOnly.click();
  await expect(page).toHaveURL(`${ws.app}/notifications?unread=true`);
  await expect(unreadOnly).toBeChecked();
  await expect(page.getByRole('main').getByText('沒有通知。', { exact: true })).toBeVisible();
  await expect(list).toHaveCount(0);
  await unreadOnly.click();
  await expect(page).toHaveURL(`${ws.app}/notifications`);
  await expect(unreadOnly).not.toBeChecked();
  await expect(list).toHaveCount(2);
  await page.getByRole('main').getByRole('link', { name: approval.title, exact: true }).click();
  await expect(page).toHaveURL(`${ws.app}/posts/${post.post_id}`);
  await expect(page.getByRole('main').locator('.hub-post-head')).toContainText('待你核准');
});

// ---------- Wave 6 (G4-web) ----------

test('Today: approving while the machine is paused says why nothing was approved, never 已送出 (WV-3)', async ({ page, dev }) => {
  const fixture = await postingFixture(page, dev);
  const { ws, machine } = fixture;
  const { post } = await schedulePost(fixture, { caption: '新魚餌實測' });
  await ws.rest('POST', `/hub/machines/${machine.id}/pause`, { reason: '換網路' });

  await page.goto(ws.app);
  await expectToday(page);
  const card = page.getByRole('main').getByRole('article', { name: /^X @fixture_x .*09:00 的貼文等你核准$/ });
  await card.getByRole('button', { name: '核准 / 駁回', exact: true }).click();
  const approved = responseFor(page, 'POST', `${ws.root}/publish-targets/${post.post_id}/approve`);
  await card.getByRole('button', { name: '核准', exact: true }).click();
  const response = await approved;
  expect(response.status(), await response.text()).toBe(200);
  expect((await response.json()).data.decision_status).toBe('blocked');
  // Before: a green 「已送出。」 although no decision was recorded.
  const notice = card.getByRole('alert');
  await expect(notice).toContainText('沒有核准：');
  await expect(notice).toContainText('Mac-B 已暫停');
  await expect(card.getByText('已送出。', { exact: true })).toHaveCount(0);
  expect((await ws.rest('GET', `/views/posts/${post.post_id}`)).post.status).toBe('awaiting_approval');
});

test('Today: 檢查登入 on a login card stays usable after one success while the problem remains (WV-9)', async ({ page, dev }) => {
  const ws = await ownerWorkspace(page, dev);
  const machine = await pairMachine(dev, ws, 'Mac-B');
  await machine.heartbeat();
  const channelId = await machine.addChannel('x', 'fixture_x');
  await machine.heartbeat();
  await ws.rest('POST', `/hub/channels/${channelId}/check`, {});
  const check = (await machine.claim()).find(job => job.kind === 'check_login');
  expect(check).toBeTruthy();
  await machine.report(check, 'login_state', { state: 'login_required', identity: null, handle: null, evidence_sha256: [] });

  await page.goto(ws.app);
  await expectToday(page);
  const card = page.getByRole('main').getByRole('article', { name: 'X @fixture_x 要重新登入（Mac-B）', exact: true });
  const button = card.getByRole('button', { name: '檢查登入', exact: true });
  for (let press = 0; press < 2; press++) {
    const sent = responseFor(page, 'POST', `${ws.root}/hub/channels/${channelId}/check`);
    await button.click();
    expect((await sent).status()).toBe(200);
    await expect(card.getByRole('status')).toHaveText('已送出。');
    // Before: the button turned into a disabled 「已送出。」 until the page was opened again.
    await expect(button).toBeEnabled();
  }
});

test('Post page: moving to another post from the bell, and back, starts each page fresh (WV-8)', async ({ page, dev }) => {
  const fixture = await postingFixture(page, dev, { withoutDailySummary: true });
  const { ws } = fixture;
  const first = await schedulePost(fixture, { at: '09:00', caption: '第一則' });
  const second = await schedulePost(fixture, { at: '15:00', caption: '第二則' });
  const approvalAlerts = async () => (await ws.rest('GET', '/views/alerts')).filter(alert => alert.kind === 'approval_due').map(alert => alert.post?.id).sort();
  await expect.poll(approvalAlerts, { timeout: 20_000 }).toEqual([first.post.post_id, second.post.post_id].sort());

  await page.goto(`${ws.app}/posts/${first.post.post_id}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'X @fixture_x · 第一則', exact: true })).toBeVisible();
  const actions = main.getByRole('region', { name: '動作', exact: true });
  await actions.getByRole('button', { name: '改到…', exact: true }).click();
  await expect(actions.getByLabel('新的時間')).toHaveValue(`${first.day}T09:00`);

  await page.getByRole('button', { name: /^通知/ }).click();
  await page.getByRole('dialog', { name: '通知', exact: true }).locator(`a[href="/app/${ws.id}/posts/${second.post.post_id}"]`).first().click();
  await expect(page).toHaveURL(`${ws.app}/posts/${second.post.post_id}`);
  await expect(main.getByRole('heading', { level: 1, name: 'X @fixture_x · 第二則', exact: true })).toBeVisible();
  // Before: the first post's open 改到… panel, with its 09:00, stayed on the second post's page.
  await expect(actions.getByLabel('新的時間')).toHaveCount(0);
  await actions.getByRole('button', { name: '改到…', exact: true }).click();
  await expect(actions.getByLabel('新的時間')).toHaveValue(`${second.day}T15:00`);

  await page.goBack();
  await expect(page).toHaveURL(`${ws.app}/posts/${first.post.post_id}`);
  await expect(main.getByRole('heading', { level: 1, name: 'X @fixture_x · 第一則', exact: true })).toBeVisible();
  await expect(actions.getByLabel('新的時間')).toHaveCount(0);
});

test('Machine page: 撤銷這台機器 needs the name typed, then says what happens to its posts and channels (E41)', async ({ page, dev }) => {
  const fixture = await postingFixture(page, dev);
  const { ws, machine, channelId } = fixture;
  const { settings } = await ws.rest('GET', `/views/channels/${channelId}`);
  await ws.rest('PATCH', `/hub/channels/${channelId}/settings`, { approval_mode: 'direct' }, { version: settings.version });
  const { post } = await schedulePost(fixture, { caption: '新魚餌實測' });
  expect(post.status).toBe('scheduled');

  await page.goto(`${ws.app}/machines/${machine.id}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Mac-B', exact: true })).toBeVisible();
  await main.getByRole('button', { name: '撤銷這台機器', exact: true }).click();
  await expect(main).toContainText('撤銷後，Mac-B 不能再連到中樞');
  await expect(main).toContainText('已經開始或已按「發布」的貼文不會重發');
  const confirm = main.getByRole('button', { name: '撤銷', exact: true });
  const typed = main.getByRole('textbox', { name: '輸入機器名稱 Mac-B 確認', exact: true });
  await expect(confirm).toBeDisabled();
  await typed.fill('Mac-C');
  await expect(confirm).toBeDisabled();
  await typed.fill('Mac-B');
  const retired = responseFor(page, 'POST', `${ws.root}/hub/machines/${machine.id}/retire`);
  await confirm.click();
  const response = await retired;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ confirm: true });
  await expect(main.getByRole('status')).toHaveText('已撤銷 Mac-B。');
  await expect(main).toContainText('1 則還沒開始的貼文等待新的機器');
  await expect(main.getByRole('link', { name: 'X @fixture_x', exact: true })).toHaveAttribute('href', `/app/${ws.id}/channels/${channelId}`);
  expect(await ws.rest('GET', '/views/machines')).toEqual([]);
});

test('Channel page: the channel time zone is picked on the page and saved with the settings; lateness starts at 2 minutes (E42, E38)', async ({ page, dev }) => {
  const ws = await ownerWorkspace(page, dev);
  const machine = await pairMachine(dev, ws, 'Mac-B');
  await machine.heartbeat();
  const channelId = await machine.addChannel('x', 'fixture_x');
  await machine.heartbeat();
  const before = await ws.rest('GET', `/views/channels/${channelId}`);

  await page.goto(`${ws.app}/channels/${channelId}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: '@fixture_x', exact: true })).toBeVisible();
  await expect(main.getByRole('spinbutton', { name: /^遲到上限/ })).toHaveAttribute('min', '2');
  const zone = main.getByRole('combobox', { name: /^時區/ });
  await expect(zone).toHaveValue(before.settings.timezone);
  await zone.selectOption('Asia/Taipei');
  const saved = responseFor(page, 'PATCH', `${ws.root}/hub/channels/${channelId}/settings`);
  await main.getByRole('button', { name: '儲存', exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ timezone: 'Asia/Taipei' });
  expect(response.request().headers()['if-match']).toBe(`"${before.settings.version}"`);
  await expect(page.locator('.vs-page-head')).toContainText('Asia/Taipei');
  expect((await ws.rest('GET', `/views/channels/${channelId}`)).timezone).toBe('Asia/Taipei');
});

const onboarding = base.extend({ dev: localWorkerOnboarding });
onboarding.use({ viewport: { width: 1280, height: 800 }, timezoneId: 'UTC', serviceWorkers: 'block' });

onboarding('First-run wizard: workspace, a machine, its channel, notifications and Codex, then Today', async ({ page, dev }) => {
  test.setTimeout(120_000);
  const issued = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/devices/pairing-codes')) issued.push(request);
  });
  await page.goto(dev.origin);
  await expect(page.getByRole('heading', { name: '註冊', exact: true })).toBeVisible();
  await page.getByLabel('使用者名稱', { exact: true }).fill('wizard-owner');
  await page.getByLabel('密碼', { exact: true }).fill(dev.password());
  const setup = responseFor(page, 'POST', '/api/v1/setup');
  await page.getByRole('button', { name: '註冊', exact: true }).click();
  const { data: { workspaces: [{ id }] } } = await (await setup).json();
  const { rest, root, app } = await sessionRest(page, dev, id);
  const ws = { id, rest, root, app };

  // Step 1, 工作區 (§2.9 step 2): name, time zone and currency, saved by the owner.
  let panel = await expectWizardStep(page, 'workspace');
  for (const step of wizardSteps) await expectStepStatus(page, step, step === 'notifications' ? 'optional' : 'todo');
  await panel.getByRole('textbox', { name: '工作區名稱', exact: true }).fill('Lure Lab');
  await panel.getByRole('combobox', { name: /^時區/ }).selectOption('Asia/Taipei');
  await panel.getByRole('combobox', { name: '報表幣別', exact: true }).selectOption('TWD');
  const saved = responseFor(page, 'PATCH', root);
  await panel.getByRole('button', { name: '儲存並繼續', exact: true }).click();
  const workspace = await saved;
  expect(workspace.status(), await workspace.text()).toBe(200);
  expect(workspace.request().postDataJSON()).toEqual({ name: 'Lure Lab', default_timezone: 'Asia/Taipei', reporting_currency: 'TWD' });
  await expect(page).toHaveURL(`${app}/get-started?step=machines`);
  panel = await expectWizardStep(page, 'machines');
  await expectStepStatus(page, 'workspace', 'done');
  expect(await rest('GET', '')).toMatchObject({ name: 'Lure Lab', default_timezone: 'Asia/Taipei', reporting_currency: 'TWD' });

  // Step 2, 連接機器 (§2.9 step 3): the hub address, the downloads, where each step happens, and no pairing link.
  await expect(panel.getByText(dev.origin, { exact: true })).toBeVisible();
  await expect(panel).toContainText('開發模式：沒有中樞資訊，以目前的網址為準。');
  await expect(panel.getByRole('button', { name: '複製中樞位址' })).toBeVisible();
  const downloads = panel.locator('.hub-downloads').getByRole('listitem');
  await expect(downloads).toHaveCount(3);
  await expect(downloads.filter({ hasText: 'macOS（Apple 晶片）' })).toContainText('尚未建置');
  await expect(panel.getByRole('list').filter({ hasText: '安裝 Tailscale' }).getByRole('listitem')).toHaveCount(4);
  await expect(panel.getByText('還沒有機器。照上面的步驟在那台機器完成配對。', { exact: true })).toBeVisible();
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await dev.writeMacWorkerPackage(Buffer.from('fixture worker package'));
  await page.reload();
  panel = await expectWizardStep(page, 'machines');
  const mac = panel.locator('.hub-downloads').getByRole('listitem').filter({ hasText: 'macOS（Apple 晶片）' });
  await expect(mac.getByRole('link', { name: '下載', exact: true })).toHaveAttribute('href', '/api/v1/worker-downloads/mac-arm64');
  await expect(panel.locator('.hub-downloads').getByRole('listitem').filter({ hasText: 'Windows' })).toContainText('尚未建置');

  // The machine pairs from its own Worker App (the /worker-connect grant); the page shows it by itself.
  const machine = await pairMachine(dev, ws, 'Mac-B');
  const paired = panel.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Mac-B', exact: true }) });
  await expect(paired).toBeVisible({ timeout: 15_000 });
  await expect(paired).toContainText('離線');
  await expectStepStatus(page, 'machines', 'todo');
  await machine.heartbeat();
  await expect(paired).toContainText('在線', { timeout: 15_000 });
  await expect(paired).toContainText('0.2.0');
  await expectStepStatus(page, 'machines', 'done');
  await expect(paired.getByRole('link', { name: 'Mac-B', exact: true })).toHaveAttribute('href', `/app/${id}/machines/${machine.id}`);

  // Step 3, 新增帳號 (§2.9 step 4): channels are added on that machine; the new one appears with its readiness.
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page).toHaveURL(`${app}/get-started?step=channels`);
  panel = await expectWizardStep(page, 'channels');
  const machineGroup = panel.locator('section').filter({ has: page.getByRole('heading', { level: 3, name: /^Mac-B/ }) });
  await expect(machineGroup).toContainText('在 Mac-B 開啟 SmartSell Worker → 新增帳號 → 選平台（X 或 TikTok）→ 在跳出的 Chrome 視窗登入 → 確認加入');
  await expect(machineGroup.getByText('這台機器還沒有帳號。', { exact: true })).toBeVisible();
  const channelId = await machine.addChannel('x', 'lure_lab');
  await machine.heartbeat();
  const channelRow = machineGroup.getByRole('listitem').filter({ has: page.getByRole('link', { name: /@lure_lab$/ }) });
  await expect(channelRow).toBeVisible({ timeout: 15_000 });
  await expect(channelRow.getByRole('link', { name: /@lure_lab$/ })).toHaveAttribute('href', `/app/${id}/channels/${channelId}`);
  await expect(channelRow).toContainText('已登入');
  const [summary] = await rest('GET', '/views/channels');
  const done = Object.values(summary.readiness).filter(Boolean).length;
  await expect(channelRow).toContainText(`${done}/6`);
  await expect(channelRow).toContainText('到帳號頁完成就緒清單：');
  await expectStepStatus(page, 'channels', summary.can_schedule ? 'done' : 'todo');

  // Step 4, 通知 (§2.9 step 5): optional phone push, the laptop App and the tailnet note.
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  panel = await expectWizardStep(page, 'notifications');
  await expect(panel.getByText('還沒有設定手機推播（選填，但建議）。', { exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: '設定手機推播並傳一則測試', exact: true })).toHaveAttribute('href', `/app/${id}/settings/notifications`);
  await expect(panel).toContainText('筆電與手機也要加入同一個 tailnet，通知中的連結才打得開。');
  await expectStepStatus(page, 'notifications', 'optional');

  // Step 5, 連接 AI 助手 (§2.9 step 6, §6.2): the relay way creates a connection and hands over a token file.
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  panel = await expectWizardStep(page, 'agent');
  await expect(panel.getByRole('heading', { level: 3, name: '方式一（建議）：筆電上的 SmartSell App', exact: true })).toBeVisible();
  await panel.getByRole('textbox', { name: '連線名稱', exact: true }).fill('Lure laptop · Codex');
  const created = responseFor(page, 'POST', `${root}/agent-connections`);
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: '建立連線並下載權杖檔', exact: true }).click();
  const enrolled = await created;
  expect(enrolled.status(), await enrolled.text()).toBe(201);
  expect(enrolled.request().postDataJSON()).toEqual({ label: 'Lure laptop · Codex', client: 'codex', expires_days: 365 });
  const connection = (await enrolled.json()).data;
  const tokenFile = await download;
  // The file name is checked in its own test below; here, the file holds exactly the token.
  expect(await (await import('node:fs/promises')).readFile(await tokenFile.path(), 'utf8')).toBe(`${connection.token}\n`);
  await expect(panel.getByRole('status')).toHaveText('已建立「Lure laptop · Codex」。權杖檔已下載為 token（在「下載」資料夾）；下面第 1 步會把它移到 .smartsell 資料夾。');
  await panel.getByRole('button', { name: 'macOS／Linux（終端機）', exact: true }).click();
  await expect(panel).toContainText('mv ~/Downloads/token ~/.smartsell/token && chmod 600 ~/.smartsell/token');
  await expect(panel).toContainText(`codex mcp add smartsell -- node ~/.smartsell/relay.mjs --hub ${dev.origin} --token-file ~/.smartsell/token`);
  // A connection that has not called a tool yet is not done.
  const agent = mcpClient(connection.mcp_url, connection.token);
  await agent.initialize();
  expect((await agent.rpc('tools/list')).tools).toHaveLength(14);   // 11 posting tools + 3 remote-control tools (E50)
  await page.reload();
  panel = await expectWizardStep(page, 'agent');
  await expectStepStatus(page, 'agent', 'todo');
  await expect(panel.getByText('已有 Agent 透過 MCP 呼叫過 SmartSell。', { exact: true })).toHaveCount(0);
  const overview = await agent.call('smartsell_overview');
  expect(overview.channels).toEqual([expect.objectContaining({ channel_id: channelId, machine: 'Mac-B' })]);
  await expect(panel.getByText('已有 Agent 透過 MCP 呼叫過 SmartSell。', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expectStepStatus(page, 'agent', 'done');
  expect(issued).toHaveLength(0);

  // 完成，前往今日: Today shows the machine, and the wizard does not come back.
  await page.getByRole('main').getByRole('link', { name: '完成，前往今日', exact: true }).click();
  await expect(page).toHaveURL(app);
  await expectToday(page);
  const machines = page.getByRole('main').locator('section').filter({ has: page.getByRole('heading', { level: 2, name: '機器', exact: true }) });
  const mini = machines.getByRole('link', { name: /^Mac-B/ });
  await expect(mini).toHaveAttribute('href', `/app/${id}/machines/${machine.id}`);
  await expect(mini).toContainText('在線');
  await expect(mini).toContainText('1 個帳號');
  await page.goto(dev.origin);
  await expect(page).toHaveURL(app);
  await expectToday(page);
});

test('Agent page: the relay token file is saved under the name the page tells the owner', async ({ page, dev }) => {
  // W-specs.md #1: Chrome appends ".txt" to a text/plain download; the page and the relay command name ~/.smartsell/token.
  const ws = await ownerWorkspace(page, dev);
  await page.goto(`${ws.app}/agent`);
  const relay = page.getByRole('main').locator('section').filter({ has: page.getByRole('heading', { level: 3, name: '方式二：Node relay（Windows 筆電或沒有 App 時）', exact: true }) });
  const download = page.waitForEvent('download');
  await relay.getByRole('button', { name: '建立連線並下載權杖檔', exact: true }).click();
  const file = await download;
  await expect(relay.getByRole('status')).toContainText('權杖檔已下載為 token（在「下載」資料夾）');
  await expect(page.getByRole('main').getByText(/mv ~\/Downloads\/token ~\/\.smartsell\/token/)).toBeVisible();
  expect(file.suggestedFilename()).toBe('token');
});

test('Wizard: a failed machine read is shown as an error, not as "no machines yet"', async ({ page, dev }) => {
  // W-specs.md #2: an unknown machine list is not an empty one.
  const ws = await ownerWorkspace(page, dev);
  const machine = await pairMachine(dev, ws, 'Mac-B');
  await machine.heartbeat();
  await page.route(`${dev.origin}${ws.root}/views/machines*`, route => route.abort());
  await page.goto(`${ws.app}/get-started?step=machines`);
  const panel = await expectWizardStep(page, 'machines');
  await expect(panel.getByText('已配對的機器（新配對的會自動出現）', { exact: true })).toBeVisible();
  // The paired, online machine must not be reported as missing while its read fails.
  await expect(panel.getByRole('alert')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByText('還沒有機器。照上面的步驟在那台機器完成配對。', { exact: true })).toHaveCount(0);
  // The progress list says the state is unknown instead of 待設定, for the machine step and the channel step that needs it.
  await expectStepStatus(page, 'machines', 'unread');
  await expectStepStatus(page, 'channels', 'unread');
  await page.getByRole('main').getByRole('button', { name: '下一步', exact: true }).click();
  const channels = await expectWizardStep(page, 'channels');
  await expect(channels.getByRole('alert')).toBeVisible();
  await expect(channels.getByText('先完成「連接機器」。', { exact: true })).toHaveCount(0);
  // 重試 reads again once the hub answers: the machine appears and its step is done.
  await page.unroute(`${dev.origin}${ws.root}/views/machines*`);
  await page.getByRole('main').getByRole('button', { name: '上一步', exact: true }).click();
  const machines = await expectWizardStep(page, 'machines');
  await machines.getByRole('alert').getByRole('button', { name: '重試', exact: true }).click();
  await expect(machines.getByRole('link', { name: 'Mac-B', exact: true })).toBeVisible();
  await expect(machines.getByRole('alert')).toHaveCount(0);
  await expectStepStatus(page, 'machines', 'done');
});
