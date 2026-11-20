import { createHash, randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localOperations } from './local-dev.mjs';

const test = base.extend({ dev: localOperations });

test('inbox exposes manual moderation, reversible customer links, internal notes and read-only reviews', async ({ page, dev }) => {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { 'x-setup-token': dev.setupToken },
    data: { email: 'inbox-owner@example.test', name: 'Inbox Owner', workspaceName: 'Inbox acceptance', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const session = (await setup.json()).data;
  const workspace = session.workspaces[0].id;
  const csrf = (await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json()).csrf_token;
  async function seed(path, data, version, method = 'POST') {
    const response = await page.request.fetch(`${dev.origin}/api/v1/workspaces/${workspace}${path}`, { data, method,
      headers: { origin: dev.origin, 'x-csrf-token': csrf, ...(version && { 'if-match': String(version) }),
        ...(method !== 'GET' && { 'idempotency-key': randomUUID() }) } });
    expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(200);
    return (await response.json()).data;
  }
  const sourceUrl = 'https://social.example.test/comments/1';
  await seed('/inbox/sla-policies', { name: 'Support', conditions: { social_account_id: 'account' },
    first_response_minutes: 10, resolution_minutes: 60, pause_on_status: ['waiting_customer'] });
  const ingested = await seed('/inbox/ingest', { messages: [{ brand_id: 'brand', social_account_id: 'account', provider: 'meta_facebook',
    external_message_id: 'comment', kind: 'comment_thread', external_user_id: 'user', display_name: 'Same nickname',
    external_url: sourceUrl, body_text: 'Original comment', platform_created_at: '2026-11-19T00:00:00Z' }] });
  const { conversation, message } = ingested.items[0];
  await seed(`/messages/${message.id}/translations`, { target_lang: 'zh-Hant', text: '人工翻譯內容' });
  const brand = await seed('/brands', { name: 'Inbox support', slug: 'inbox-support' });
  const redAccount = await seed('/social-accounts', { provider: 'xiaohongshu', external_account_id: 'fixture-red', display_name: 'Red account',
    brand_id: brand.id, owned_account_confirmed: true });
  const facebookAccount = await seed('/social-accounts', { provider: 'meta_facebook', external_account_id: 'fixture-page', display_name: 'Facebook page',
    brand_id: brand.id, owned_account_confirmed: true });
  const customer = await seed('/customers', { brand_id: 'brand' });
  const identity = await seed(`/customers/${customer.id}/identities`, { kind: 'social_participant', namespace: 'browser-test', value_hash: createHash('sha256').update('fixture').digest('hex'), verified: true, verification_method: 'manual_evidence', evidence_ids: ['fixture'] }, customer.version);
  const source = await seed('/inbox/review-sources', { label: 'Public reviews', source_url: sourceUrl });
  const review = await seed(`/inbox/review-sources/${source.id}/import`, { external_review_id: 'public-review', source_url: sourceUrl, rating: 4, scale_max: 5 });

  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(`${dev.origin}/w/${workspace}/inbox?tab=conversations&id=${conversation.id}`);
  const translation = page.getByText('Show human translation · zh-Hant', { exact: true });
  const original = page.getByRole('article').getByText('Original comment', { exact: true });
  await expect(original).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('人工翻譯內容', { exact: true })).toBeHidden();
  await translation.click();
  await expect(page.getByText('人工翻譯內容', { exact: true })).toBeVisible();
  await expect(original).toBeVisible();
  await translation.click();
  await expect(page.getByText('人工翻譯內容', { exact: true })).toBeHidden();
  const timeline = page.getByRole('region', { name: 'Conversation activity' });
  await expect(timeline.getByText('No assignment or status changes yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Mark as read' }).click();
  const markRead = page.getByRole('dialog');
  const readResponse = page.waitForResponse(response => response.url().endsWith(`/conversations/${conversation.id}/read`) && response.request().method() === 'POST');
  await markRead.locator('button[type=submit]').click();
  expect((await readResponse).status()).toBe(200);
  await markRead.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(timeline.getByText('No assignment or status changes yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Triage conversation' }).click();
  const triage = page.getByRole('dialog');
  await triage.getByLabel('Status').selectOption('waiting_customer');
  await triage.getByLabel('Assignee').fill(session.user.id);
  const triageResponse = page.waitForResponse(response => response.url().endsWith(`/conversations/${conversation.id}`) && response.request().method() === 'PATCH');
  await triage.locator('button[type=submit]').click();
  const updated = await triageResponse;
  expect(updated.status(), await updated.text()).toBe(200);
  await triage.getByRole('button', { name: 'Close', exact: true }).first().click();
  const assignment = timeline.getByRole('listitem').filter({ hasText: 'Assignment changed' });
  const status = timeline.getByRole('listitem').filter({ hasText: 'Status changed' });
  await expect(assignment.locator('dd')).toHaveText([session.user.id, 'Unassigned', session.user.id]);
  await expect(status.locator('dd')).toHaveText([session.user.id, /^open$/i, /waiting customer|waiting for customer/i]);
  await expect(status.locator('time[datetime]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Service deadline sample' })).toBeVisible();
  await expect(page.getByText('Conversations with a policy').locator('xpath=following-sibling::dd[1]')).toHaveText('1');
  await expect(page.getByText('Conversations without a policy').locator('xpath=following-sibling::dd[1]')).toHaveText('0');
  const excluded = page.getByText('Time excluded by policy pauses (seconds)').locator('xpath=following-sibling::dd[1]');
  await dev.setTime(Date.now() + 65 * 60_000);
  await page.reload();
  await expect.poll(async () => Number(await excluded.textContent())).toBeGreaterThanOrEqual(3900);
  await expect(page.getByText('Matching nicknames never link automatically.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View original on platform' })).toHaveAttribute('href', sourceUrl);
  await expect(page.getByRole('button', { name: 'Record completed manual moderation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete comment', exact: true })).toHaveCount(0);

  async function submit(path, method = 'POST') {
    const dialog = page.getByRole('dialog');
    const confirmation = dialog.getByRole('checkbox');
    if (await confirmation.count()) await confirmation.check();
    const response = page.waitForResponse(result => result.url().endsWith(path) && result.request().method() === method);
    await dialog.locator('button[type=submit]').click();
    expect((await response).status()).toBe(200);
    await expect(dialog.getByRole('button', { name: 'Close', exact: true }).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  }
  await page.getByRole('button', { name: 'Record completed manual moderation' }).click();
  await page.getByLabel('Action taken on platform').selectOption('hide');
  await page.getByRole('dialog').locator('textarea[name=reason]').fill('Reviewed on the platform');
  await submit(`/conversations/${conversation.id}/moderation`);
  const moderation = page.getByRole('heading', { name: 'Comment moderation' }).locator('..');
  await expect(moderation.getByRole('article')).toContainText('Original comment');
  await expect(moderation.getByRole('article')).toContainText(session.user.id);
  await page.getByRole('button', { name: 'Confirm customer link' }).click();
  await page.getByLabel('Identity ID from the customer profile').fill(identity.id);
  await page.getByLabel(/Verification basis/).fill('Customer confirmed both channels');
  await submit(`/inbox/participants/${conversation.primary_participant_id}/link-customer`);
  await expect(page.getByRole('link', { name: customer.id })).toBeVisible();
  await page.getByRole('button', { name: 'Undo customer link' }).click();
  await page.getByLabel('Reason for undoing').fill('Corrected link');
  await submit(`/inbox/participants/${conversation.primary_participant_id}/link-customer`, 'DELETE');
  await expect(page.getByText(/Unlinked.*Corrected link/)).toBeVisible();
  await page.getByRole('button', { name: 'Add internal note' }).click();
  const note = page.getByRole('dialog');
  await note.getByLabel('Note text').fill('Internal note for the support team');
  await note.locator('button[type=submit]').click();
  await expect(page.getByRole('heading', { name: 'Internal notes' }).locator('..')).toContainText('Internal note for the support team');

  const replyInput = await seed('/inbox/ingest', { messages: [{ brand_id: brand.id, social_account_id: facebookAccount.id,
    provider: 'meta_facebook', kind: 'comment_thread', external_message_id: 'reply-target', external_user_id: 'reply-user',
    external_url: sourceUrl, body_text: 'Question for manual reply', platform_created_at: '2026-11-19T00:00:00Z' }] });
  const replyConversationId = replyInput.items[0].conversation.id;
  const conversationPath = `/conversations/${replyConversationId}`;
  const lease = await seed(`${conversationPath}/occupancy`, { purpose: 'reply' });
  const draft = await seed(`${conversationPath}/reply-drafts`, { reply_mode: 'public_reply', body_text: 'Approved manual reply' });
  const draftPath = `/reply-drafts/${draft.id}`;
  const pending = await seed(`${draftPath}/submit-approval`, {}, draft.version);
  const approved = await seed(`${draftPath}/approve`, {}, pending.version);
  const delivery = await seed(`${draftPath}/send`, { mode: 'manual', fencing_token: lease.fencing_token }, approved.version);
  await page.goto(`${dev.origin}/w/${workspace}/inbox?tab=conversations&id=${replyConversationId}&related=delivery&rid=${delivery.id}`);
  const deliveryView = page.getByRole('heading', { name: /Delivery status/ }).locator('..');
  await expect(deliveryView.getByRole('heading')).toContainText(/manual/i);
  await expect(deliveryView.getByText('Approved manual reply')).toBeVisible();
  await deliveryView.getByText('Record confirmed delivery', { exact: true }).click();
  await deliveryView.getByLabel('Platform reply link').fill(`${sourceUrl}#manual-reply`);
  await deliveryView.getByRole('checkbox').check();
  const recorded = page.waitForResponse(response => response.url().endsWith(`/outbound-replies/${delivery.id}/manual-complete`) && response.request().method() === 'POST');
  await deliveryView.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await recorded).status()).toBe(200);
  await expect(deliveryView.getByRole('heading')).toContainText(/delivered/i);
  await expect(deliveryView.locator('p').filter({ hasText: /delivered/i })).toHaveCount(1);
  const history = await seed(`/outbound-replies/${delivery.id}`, undefined, undefined, 'GET');
  expect(history.reply.verification).toBe('manual_evidence');
  expect(history.attempts).toMatchObject([{ attempt_no: 1, executor: 'manual', outcome: 'delivered', recorded_by: session.user.id }]);

  await page.goto(`${dev.origin}/w/${workspace}/inbox?tab=reviews&id=${review.id}`);
  await expect(page.getByText('Read-only review. Manage replies on the originating platform.')).toBeVisible();
  await expect(page.getByText('Rating 4 / 5 · open')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assign manual follow-up' })).toBeVisible();
  await expect(page.getByRole('button', { name: /delete review/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Assign manual follow-up' }).click();
  await page.getByLabel('Assignee').fill(session.user.id);
  await submit(`/reviews/${review.id}/handoff`);
  await page.getByRole('button', { name: 'Record observed platform reply' }).click();
  await page.getByLabel('Platform reply URL').fill(`${sourceUrl}#reply`);
  await page.getByLabel('Manual verification evidence').fill('Observed the reply on the review page');
  await submit(`/reviews/${review.id}/verify-reply`);
  await expect(page.locator('p').filter({ hasText: 'Observed the reply on the review page' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assign manual follow-up' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Channel coverage' }).click();
  const red = page.getByRole('listitem').filter({ hasText: 'Red account · Read comments' });
  await expect(red).toContainText('API unsupported; mobile route pending P1 evaluation');
  const facebook = page.getByRole('listitem').filter({ hasText: 'Facebook page · Read comments' });
  await expect(facebook).toContainText('Unverified');
  const unsupportedUrl = 'https://www.xiaohongshu.com/explore/fixture';
  const unsupported = await seed('/inbox/ingest', { messages: [{ brand_id: brand.id, social_account_id: redAccount.id,
    provider: 'xiaohongshu', kind: 'comment_thread', external_message_id: 'red-comment', external_user_id: 'red-user',
    external_url: unsupportedUrl, body_text: 'Imported Red comment', platform_created_at: '2026-11-19T00:00:00Z' }] });
  await page.goto(`${dev.origin}/w/${workspace}/inbox?tab=conversations&id=${unsupported.items[0].conversation.id}`);
  const unsupportedModeration = page.getByRole('heading', { name: 'Comment moderation' }).locator('..');
  await expect(unsupportedModeration.getByRole('link', { name: 'View original on platform' })).toHaveAttribute('href', unsupportedUrl);
  await expect(unsupportedModeration.getByRole('button')).toHaveText('Record completed manual moderation');

  const rule = await seed('/inbox/auto-rules', { trigger: 'keyword', keyword: 'help', social_account_id: facebookAccount.id,
    body_text: 'Draft only', window_minutes: 60, max_per_participant_per_day: 2 });
  await seed(`/inbox/auto-rules/${rule.id}`, { enabled: true }, rule.version, 'PATCH');
  const input = await seed('/inbox/ingest', { messages: [{ brand_id: brand.id, social_account_id: facebookAccount.id,
    provider: 'meta_facebook', external_message_id: 'rule-comment', kind: 'comment_thread', external_user_id: 'rule-user',
    body_text: 'I need help', platform_created_at: new Date().toISOString() }] });
  const target = input.items[0];
  await seed(`/conversations/${target.conversation.id}/occupancy`, { purpose: 'reply' });
  await seed(`/inbox/messages/${target.message.id}/evaluate-rules`, {});
  await page.goto(`${dev.origin}/w/${workspace}/inbox?tab=autoRules&id=${rule.id}`);
  const runs = page.getByRole('heading', { name: 'Rule run history' }).locator('..');
  await expect(runs.getByRole('listitem')).toContainText('Skipped: operator held the conversation');
  await expect(runs.getByRole('listitem')).toContainText(target.message.id);
});
