import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test as base } from '@playwright/test';
import { tsImport } from 'tsx/esm/api';

const test = base.extend({
  host: async ({}, use) => {
    const { collaborationHost } = await tsImport('./collaboration-host.ts', import.meta.url);
    const setupToken = randomUUID();
    const { app, store, origins } = collaborationHost(setupToken);
    const assets = {
      '/assets/app.js': ['public/assets/app.js', 'text/javascript'],
      '/assets/styles.css': ['public/assets/styles.css', 'text/css'],
      '/portal-assets/app.js': ['portal/assets/app.js', 'text/javascript'],
      '/portal-assets/styles.css': ['portal/assets/styles.css', 'text/css'],
    };
    const serve = (route, file, type) => app.get(route, async (_, reply) =>
      reply.type(type).send(await readFile(new URL(`../../apps/${file}`, import.meta.url), 'utf8')));
    for (const route of ['/landing/:slug', '/unsubscribe']) serve(route, 'public/index.html', 'text/html');
    for (const route of ['/share', '/creator']) app.get(route, async (_, reply) => {
      const html = await readFile(new URL('../../apps/portal/collaboration.html', import.meta.url), 'utf8');
      return reply.type('text/html').send(html.replaceAll('/assets/', '/portal-assets/'));
    });
    serve('/src/i18n.js', 'portal/src/i18n.js', 'text/javascript');
    for (const [path, [file, type]] of Object.entries(assets)) serve(path, file, type);
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      origins.add(origin);
      await use({ origin, setupToken, store });
    } finally {
      await app.close();
    }
  },
});

async function setup(request, { origin, setupToken }) {
  const response = await request.post(`${origin}/api/v1/setup`, {
    headers: { 'x-setup-token': setupToken },
    data: { email: 'owner@example.test', name: 'Owner', workspaceName: 'Collaboration', password: 'acceptance-only-1234' },
  });
  expect(response.status(), await response.text()).toBe(201);
  const workspaceId = (await response.json()).data.workspaces[0].id;
  async function post(path, data, status = 200) {
    const result = await request.post(`${origin}${path}`, { data, headers: { origin, 'idempotency-key': randomUUID() } });
    expect(result.status(), await result.text()).toBe(status);
    return (await result.json()).data;
  }
  return { workspaceId, post, command: (name, data, status) => post(`/api/v1/workspaces/${workspaceId}/commands/${name}`, data, status) };
}

test('LP04 EM01 | public form submits separate consent and signed unsubscribe withdraws one channel', async ({ page, request, host }) => {
  const { origin } = host;
  const { workspaceId, command, post } = await setup(request, host);
  const option = async (channel, purpose, text) => {
    const copy = await command('lifecycle/create_consent_text', { channel, purpose, text, locale: 'en' });
    return { channel, consent_text_version_id: copy.id };
  };
  const marketing = [await option('email', 'marketing', 'Email updates'), await option('sms', 'marketing', 'SMS updates')];
  const { page: landing, version } = await command('traffic/pages_create_draft', {
    title: 'Consent acceptance', description: 'Contact and subscriptions',
    service_contact: await option('email', 'service', 'Reply to my request'), channel_options: marketing,
  });
  await command('traffic/publish_landing_page', { page_id: landing.id, version_id: version.id, expected_version: landing.version });
  const path = `/landing/${landing.id}`;
  await page.goto(`${origin}${path}`);
  await expect(page.getByRole('checkbox')).toHaveCount(3);
  for (const checkbox of await page.getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked();
  await page.getByLabel('電子郵件', { exact: true }).fill('lead@example.test');
  await page.getByLabel(/^電話/).fill('+12025550123');
  await page.getByRole('group', { name: '服務聯絡', exact: true }).getByRole('checkbox').check();
  for (const checkbox of await page.getByRole('group', { name: /行銷訂閱/ }).getByRole('checkbox').all()) await checkbox.check();
  const submitted = page.waitForResponse(res => res.url().endsWith(`/api/public${path}`) && res.request().method() === 'POST');
  await page.getByRole('button', { name: '送出資料' }).click();
  const response = await submitted;
  expect(response.status(), await response.text()).toBe(200);
  expect(await response.json()).toEqual({ data: { accepted: true } });
  const [lead] = await command('traffic/leads_list', {});
  expect(lead.status).toBe('contact_permitted');
  expect(JSON.stringify(lead)).not.toContain('lead@example.test');
  // The operator list masks the customer ID. Resolve it only to arrange the unsubscribe fixture.
  const { cookies } = await request.storageState();
  const staffToken = cookies.find(cookie => cookie.name === 'smartsell_session').value;
  const { data: { customer_id } } = await host.store.workspace(createHash('sha256').update(staffToken).digest('hex'), workspaceId,
    ({ context }) => context.get('traffic', 'lead', lead.id));
  const state = async (channel, purpose) => (await command('lifecycle/get_consent_state', { customer_id, channel, purpose })).state;
  expect(await state('email', 'service')).toBe('opted_in');
  expect(await state('email', 'marketing')).toBe('pending');
  expect(await state('sms', 'marketing')).toBe('pending');
  expect(await state('sms', 'service')).toBe('unknown');
  for (const copy of marketing) await command('lifecycle/record_consent', {
    ...copy, customer_id, purpose: 'marketing', action: 'opt_in', evidence_ref: `fixture-${copy.channel}-confirmation`,
  });
  const preview = channel => command('lifecycle/segments_preview', { channel, definition: {} });
  expect((await preview('email')).eligible_count).toBe(1);
  expect((await preview('sms')).eligible_count).toBe(1);
  const link = await command('lifecycle/create_unsubscribe_link', { customer_id, channel: 'email' });
  const { token } = await post('/api/portal/unsubscribe-token', { workspaceId, linkId: link.id });
  await page.goto(`${origin}/unsubscribe#${token}`);
  const confirm = page.getByRole('button', { name: '確認取消訂閱' });
  await expect(confirm).toBeVisible();
  expect(await state('email', 'marketing')).toBe('opted_in');
  const withdrawal = page.waitForResponse(res => res.url().endsWith('/api/public/unsubscribe') && res.request().method() === 'POST');
  await confirm.click();
  const withdrawn = await withdrawal;
  expect(withdrawn.status(), await withdrawn.text()).toBe(200);
  expect(await withdrawn.json()).toEqual({ data: { accepted: true } });
  expect(await state('email', 'marketing')).toBe('opted_out');
  expect(await state('email', 'service')).toBe('opted_in');
  expect(await state('sms', 'marketing')).toBe('opted_in');
  expect(await preview('email')).toMatchObject({ eligible_count: 0, excluded: { opted_out: 1 } });
  expect((await preview('sms')).eligible_count).toBe(1);
});

async function publishSignedDelivery({ workspaceId, command, post }, title, description) {
  const delivery = await command('team/create_delivery', { title, description, items: [{ title: 'Monthly report', status: 'ready' }] });
  await command('team/publish_delivery', { id: delivery.id, version: delivery.version });
  const preview = await command('team/preview_share', { deliveryId: delivery.id });
  const share = await command('team/create_share', { deliveryId: delivery.id, previewVersion: preview.previewVersion,
    permissions: ['view'], expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const { token } = await post('/api/portal/share-token', { workspaceId, shareId: share.id });
  return { share, token };
}

async function shareWidths(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const root = document.documentElement;
    const { scrollY } = window;
    window.scrollTo(root.scrollWidth, scrollY);
    const { scrollX } = window;
    window.scrollTo(0, scrollY);
    return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth, scrollX };
  });
}

test('TE03 TE04 | signed client share hides internal records and revocation takes effect in the browser', async ({ page, request, host }) => {
  const { origin } = host;
  const staff = await setup(request, host);
  const { command } = staff;
  const task = await command('team/create_task', { title: 'Staff task' });
  await command('team/add_internal_note', { taskId: task.id, text: 'Private staff canary' });
  const draft = await command('team/create_delivery', { title: 'Private draft canary', description: 'Draft', items: [{ title: 'Draft', status: 'pending' }] });
  await command('team/preview_share', { deliveryId: draft.id }, 409);
  const { share, token } = await publishSignedDelivery(staff, 'October delivery', 'Shared work');
  await page.setViewportSize({ width: 1280, height: 800 });
  const readback = page.waitForResponse(res => res.url().endsWith('/api/portal/share') && res.request().method() === 'POST');
  await page.goto(`${origin}/share#${token}`);
  await expect(page.getByRole('heading', { name: 'October delivery' })).toBeVisible();
  await expect(page.getByText('Monthly report', { exact: true })).toBeVisible();
  const response = await readback;
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.text()).not.toMatch(/Private staff canary|Private draft canary/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await command('team/revoke_share', { id: share.id, version: share.version });
  const rejected = page.waitForResponse(res => res.url().endsWith('/api/portal/share') && res.status() === 404);
  await page.reload();
  await rejected;
  await expect(page.getByRole('heading', { name: 'October delivery' })).toHaveCount(0);
});

test('TE03 | legacy signed delivery descriptions fit the minimum desktop layout', async ({ page, request, host }, testInfo) => {
  const staff = await setup(request, host);
  const notice = page.getByText('此門戶為桌面版。建議使用寬度至少 1280px 的電腦瀏覽器。', { exact: true });
  const desktop = { clientWidth: 1280, scrollWidth: 1280, bodyScrollWidth: 1280, scrollX: 0 };
  const samples = [
    { title: 'Short signed delivery', text: '交付說明 · Monthly report ready.', wraps: false },
    { title: 'Long signed delivery', text: 'WideText'.repeat(90), wraps: true },
  ];
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const { title, text, wraps } of samples) {
    const { token } = await publishSignedDelivery(staff, title, text);
    await page.goto(`${host.origin}/share#${token}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByText('Monthly report', { exact: true })).toBeVisible();
    const home = page.getByRole('link', { name: 'SmartSell' });
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute('href', '/');
    await expect(notice).toBeHidden();
    const copy = page.locator('main .heading p').filter({ hasText: text });
    await expect(copy).toBeVisible();
    await expect(copy).toHaveText(text);
    const widths = await shareWidths(page);
    await testInfo.attach(title, { body: JSON.stringify(widths), contentType: 'application/json' });
    expect(widths).toEqual(desktop);
    const lines = await copy.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const { left, right, top, bottom } = element.getBoundingClientRect();
      const rects = Array.from(range.getClientRects());
      return { count: new Set(rects.map(rect => rect.top)).size,
        withinParagraph: rects.every(rect => rect.left >= left && rect.right <= right && rect.top >= top && rect.bottom <= bottom) };
    });
    expect(lines.withinParagraph).toBe(true);
    if (wraps) expect(lines.count).toBeGreaterThan(1);
    else expect(lines.count).toBe(1);
  }

  await page.setViewportSize({ width: 1279, height: 800 });
  await expect(notice).toBeVisible();
  await expect(page.getByText(samples[1].text, { exact: true })).toBeVisible();
  const narrow = await shareWidths(page);
  await testInfo.attach('1279px desktop boundary', { body: JSON.stringify(narrow), contentType: 'application/json' });
  expect(narrow).toEqual({ ...desktop, clientWidth: 1279, scrollX: 1 });
  expect(await page.locator('body').evaluate(body => body.getBoundingClientRect().width)).toBe(1280);
});


test('public language switch preserves form data, consent copy and unsubscribe token', async ({ page, host }) => {
  const consent = '電子郵件通知：請保留原文。';
  const versionId = 'Version_繁體';
  await page.route('**/api/public/landing/campaign', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ version_id: versionId, name: '張小華', email: 'lead@example.test', service_contact: true });
      await route.fulfill({ status: 409, json: { error: { code: 'version_conflict', message: 'Raw server detail' } } });
    } else {
      await route.fulfill({ json: { data: { title: '繁體活動', version_id: versionId, service_contact: { channel: 'email', text: consent } } } });
    }
  });
  await page.goto(`${host.origin}/landing/campaign?lang=zh-CN&ref=Original`);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('heading', { name: '繁體活動' })).toBeVisible();
  await page.getByLabel('姓名（选填）').fill('張小華');
  await page.getByLabel('电子邮件', { exact: true }).fill('lead@example.test');
  await page.getByRole('checkbox', { name: new RegExp(consent) }).check();
  await page.locator('#language').selectOption('en');
  await expect(page.getByLabel('Name (optional)')).toHaveValue('張小華');
  await expect(page.getByRole('checkbox', { name: new RegExp(consent) })).toBeChecked();
  expect(new URL(page.url()).searchParams.get('ref')).toBe('Original');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('status')).toContainText('latest consent wording');
  await page.locator('#language').selectOption('zh-Hans');
  await expect(page.getByRole('status')).toContainText('最新的同意条款');
  const token = 'Original_token-ABC';
  await page.goto(`${host.origin}/unsubscribe?lang=zh#${token}`);
  await expect(page.getByRole('heading', { name: '退订', exact: true })).toBeVisible();
  await page.locator('#language').selectOption('en');
  expect(new URL(page.url()).hash).toBe(`#${token}`);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Confirm unsubscribe' })).toBeVisible();
});

test('collaboration negotiates Simplified Chinese and preserves creator draft and token', async ({ browser, host }) => {
  const context = await browser.newContext({ locale: 'zh-SG' });
  try {
    const page = await context.newPage();
    const token = 'Original_Creator-Token';
    await page.route('**/api/portal/creator-submit', async route => {
      expect(route.request().postDataJSON()).toEqual({ token, post_url: 'https://example.test/post/Unchanged-ID' });
      await route.fulfill({ status: 410, json: { error: { code: 'gone', message: 'Raw server detail' } } });
    });
    await page.goto(`${host.origin}/creator#${token}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
    const field = page.getByLabel('帖子链接（HTTPS）');
    await field.fill('http://example.test/post/Unchanged-ID');
    await page.getByRole('button', { name: '提交帖子链接' }).click();
    await expect(page.getByRole('status')).toHaveText('请输入有效的 HTTPS 帖子链接。');
    await field.fill('https://example.test/post/Unchanged-ID');
    await page.getByRole('button', { name: '提交帖子链接' }).click();
    await expect(page.getByRole('status')).toHaveText('请联系邀请您的团队获取有效链接。');
    await page.locator('#language').selectOption('en');
    await expect(page.getByLabel('Post URL (HTTPS)')).toHaveValue('https://example.test/post/Unchanged-ID');
    await expect(page.getByRole('status')).toHaveText('Ask the team that invited you for a valid link.');
    expect(new URL(page.url()).hash).toBe(`#${token}`);
  } finally { await context.close(); }
});
