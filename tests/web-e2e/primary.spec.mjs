import { createHash, randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });
test.use({ viewport: { width: 1280, height: 800 }, trace: 'off', screenshot: 'off', video: 'off' });

const email = 'owner@example.test';
const workspaceName = 'Primary acceptance';
const language = page => page.getByRole('combobox', { name: /^(介面語言|Interface language)$/ });

function responseFor(page, method, path) {
  const pending = page.waitForResponse(response =>
    response.request().method() === method && new URL(response.url()).pathname === path,
  { timeout: 8_000 });
  void pending.catch(() => {});
  return pending;
}

async function fillAuth(page, name, value) {
  try {
    await page.locator(`input[name=${name}]`).fill(value);
  } catch {
    throw new Error(`Could not fill the ${name} field`);
  }
}

const workspaceApi = page => `/api/v1/workspaces/${new URL(page.url()).pathname.split('/')[2]}`;

async function reloadFor(page, path) {
  const pending = responseFor(page, 'GET', path);
  await page.reload();
  const response = await pending;
  expect(response.status(), `GET ${path}`).toBe(200);
}

async function setupWorkspace(page, dev) {
  const password = dev.password();
  await page.goto(`${dev.origin}/`);
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
  // Operators no longer see developer entry points such as the compatibility workbench.
  await expect(page.getByRole('link', { name: '相容版工作台' })).toHaveCount(0);
  await page.getByRole('link', { name: '首次部署？建立第一個工作區', exact: true }).click();
  await expect(page).toHaveURL(`${dev.origin}/setup`);
  // The router can update the URL before React replaces the sign-in form.
  await expect(page.getByRole('heading', { name: '首次設定', exact: true })).toBeVisible();
  await fillAuth(page, 'email', email);
  await fillAuth(page, 'password', password);
  await fillAuth(page, 'workspaceName', workspaceName);
  await fillAuth(page, 'name', 'Acceptance Owner');
  await fillAuth(page, 'setupToken', dev.setupToken);
  await expect(page.locator('input[name=email]')).toHaveValue(email);
  const setup = responseFor(page, 'POST', '/api/v1/setup');
  await page.getByRole('button', { name: '首次設定', exact: true }).click();
  expect((await setup).status(), 'POST /api/v1/setup').toBe(201);
  return password;
}

async function workspaceSession(page, dev, password = dev.password()) {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { name: 'Acceptance Owner', email, workspaceName, password },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { workspaces: [workspace] } = await setup.json();
  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  expect(csrf.status()).toBe(200);
  const { csrf_token } = await csrf.json();
  const root = `/api/v1/workspaces/${workspace.id}`;
  async function op(method, path, data, version) {
    const response = await page.request.fetch(`${dev.origin}${root}${path}`, {
      method, data,
      headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
        ...(version === undefined ? {} : { 'If-Match': String(version) }) },
    });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  }
  return { root, base: `${dev.origin}/w/${workspace.id}`, op, post: (path, data, version) => op('POST', path, data, version), get: path => op('GET', path) };
}

async function expectNoHorizontalOverflow(page) {
  const width = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(width.content, 'document scroll width').toBeLessThanOrEqual(width.viewport);
}

test('primary root supports first-time setup and fresh-session sign-in in both languages', async ({ browser, page, dev }) => {
  const password = await setupWorkspace(page, dev);
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const loginPage = await fresh.newPage();
    await loginPage.goto(`${dev.origin}/`);
    await expect(loginPage).toHaveURL(`${dev.origin}/login`);
    await expect(loginPage.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(loginPage);
    await language(loginPage).selectOption('en');
    await expect(loginPage.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(loginPage);
    await fillAuth(loginPage, 'email', email);
    await fillAuth(loginPage, 'password', password);
    const login = responseFor(loginPage, 'POST', '/api/v1/session');
    await loginPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await login).status(), 'POST /api/v1/session').toBe(200);
    await expect(loginPage).toHaveURL(/\/w\/[^/]+\/home$/);
    await reloadFor(loginPage, `${workspaceApi(loginPage)}/catalog`);
    await expect(loginPage.getByRole('heading', { name: 'Today’s operations' })).toBeVisible();
    await expect(loginPage.getByRole('navigation', { name: 'Module directory' })).toBeVisible();
    await expectNoHorizontalOverflow(loginPage);
    await language(loginPage).selectOption('zh-Hant');
    await expect(loginPage.getByRole('heading', { name: '今日營運' })).toBeVisible();
    await expect(loginPage.getByRole('navigation', { name: '模組目錄' })).toBeVisible();
    await expectNoHorizontalOverflow(loginPage);
  } finally {
    await fresh.close();
  }
});

test('WS04 marks an approval notification read without closing its work item', async ({ page, dev }) => {
  const { base, root, post, get } = await workspaceSession(page, dev);
  const brand = await post('/brands', { name: 'Review brand', slug: 'review-brand' });
  const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: '1234',
    display_name: 'Review page', brand_id: brand.id, owned_account_confirmed: true });
  const { item } = await post('/content-items', { brand_id: brand.id, title: 'Local staff review' });
  const { variant } = await post(`/content-items/${item.id}/variants`, { platform: 'facebook', market: 'TW', format: 'text', body_markdown: 'Review this caption' });
  await post(`/content-variants/${variant.id}/revisions`, { expected_version: variant.version, base_revision_id: null });
  const target = await post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString() });
  const targetPath = `/publish-targets/${target.id}`;
  const submitted = await post(`${targetPath}/submit`, {}, target.version);
  expect(submitted.plan_status).toBe('awaiting_approval');

  await expect.poll(async () => (await get('/notifications?type=approval_requested')).items.map(row => row.resource_id))
    .toEqual([submitted.approval_request_id]);
  const { items: [notice] } = await get('/notifications?type=approval_requested');
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(`${base}/settings/brands?tab=notifications`);
  const notification = page.getByRole('row').filter({ hasText: 'Approval requested' });
  await expect(notification.getByText('Unread', { exact: true })).toBeVisible();
  await notification.getByRole('button', { name: 'Mark as read' }).click();
  const read = responseFor(page, 'POST', `${root}/notifications/read`);
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  expect((await read).status()).toBe(200);
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(notification.getByText('Read', { exact: true })).toBeVisible();
  expect((await get(`/work-items/${notice.work_item_id}`)).status).toBe('open');
  await expectNoHorizontalOverflow(page);

  await page.goto(`${base}/me`);
  await expect(page.getByRole('row').filter({ hasText: /Approval requested/i })).toHaveCount(1);
  expect((await post(`${targetPath}/approve`, {}, submitted.version)).plan_status).toBe('ready');
  await expect.poll(async () => (await get(`/work-items/${notice.work_item_id}`)).status).toBe('done');
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: /Approval requested/i })).toHaveCount(0);
  expect((await get('/notifications?type=approval_requested')).items).toEqual([
    expect.objectContaining({ id: notice.id, read_at: expect.any(String), archived_at: null }),
  ]);
});

test('WS05 distinguishes missing engagement data from an observed zero', async ({ page, dev }) => {
  const { base, post, get } = await workspaceSession(page, dev);
  const brand = await post('/brands', { name: 'Analytics brand', slug: 'analytics-brand' });
  async function register(external_account_id) {
    const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id,
      display_name: `Sample page ${external_account_id}`, brand_id: brand.id, owned_account_confirmed: true });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzQAAAAASUVORK5CYII=', 'base64');
    const ticket = await post('/files/uploads', { purpose: 'evidence', mime_type: 'image/png', size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    const evidence = await post(`/files/uploads/${ticket.id}/complete`, { base64: bytes.toString('base64') });
    return post('/platform-posts/register', { social_account_id: account.id, external_post_id: external_account_id,
      permalink: `https://www.facebook.com/${external_account_id}/posts/${external_account_id}`, evidence_file_ids: [evidence.id],
      published_at: new Date(Date.now() - 86_400_000).toISOString() });
  }
  const measured = await register('1234');
  await register('5678');
  const engagement = 'norm.post.engagements';
  const observation = { subject_type: 'platform_post', subject_id: measured.id, metric_key: engagement,
    source: { method: 'manual_import' } };
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(`${base}/home/summary`);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Post engagements', exact: true }) });
  const readMetric = async () => {
    const summary = await get('/overview/summary');
    const report = summary.cards.find(card => card.subject === 'platform_post').metrics;
    return [report.rows[0].values[engagement].value, report.coverage.subjects_observed, report.coverage.subjects_total];
  };
  expect(await readMetric()).toEqual([null, 0, 2]);
  await expect(row.getByRole('cell', { name: '—', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: '0 / 2', exact: true })).toBeVisible();

  const now = Date.now();
  const recorded = await post('/metrics/observations', { observations: [now - 43_200_000, now - 3_600_000].map(instant => ({
    ...observation, observed_at: new Date(instant).toISOString(), value: 0,
  })) });
  expect(recorded.inserted_count).toBe(2);
  expect(await readMetric()).toEqual([0, 1, 2]);
  await page.reload();
  await expect(row.getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: '1 / 2', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('WS02 Today reflects the workspace emergency stop until released', async ({ page, dev }) => {
  const { base, get, post } = await workspaceSession(page, dev);
  const emergencyItems = async () => (await get('/overview/today')).items.filter(item => item.kind === 'connector_auto_halted');
  expect(await emergencyItems()).toEqual([]);
  await post('/connector-auto-policy/halt', {});
  expect(await emergencyItems()).toMatchObject([{ sources: ['workspace'] }]);

  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(`${base}/home`);
  const stop = page.getByRole('row').filter({ hasText: 'Automatic mode emergency stop active' });
  await expect(stop).toHaveCount(1);
  await expect(stop).toContainText('Workspace');
  await expectNoHorizontalOverflow(page);

  await post('/connector-auto-policy/release', {});
  expect(await emergencyItems()).toEqual([]);
  await page.reload();
  await expect(page.getByText('No items need attention', { exact: true })).toBeVisible();
});

test('WS06 another administrator resumes setup and Today shows the skipped history impact', async ({ page, dev }) => {
  const password = dev.password();
  const { base, root, post } = await workspaceSession(page, dev, password);
  const flow = '/onboarding/initial_setup_v1';
  const step = `${flow}/steps/history_sync`;
  const before = await post(`${step}/check`, {});
  expect(before.status).toBe('blocked');

  const adminEmail = 'admin@example.test';
  dev.switchIdentity({ email: adminEmail, name: 'Second Administrator', role: 'admin' });
  const session = async (path, options) => {
    const response = await page.request.fetch(`${dev.origin}${path}`, options);
    expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
    return response.json();
  };
  const auth = await session('/api/v1/login', { method: 'POST', headers: { Origin: dev.origin }, data: { email: adminEmail, password } });
  expect(auth.user.id).not.toBe(before.updated_by_id);
  const { data: progress } = await session(root + flow);
  expect(progress.items.find(item => item.step_key === 'history_sync')).toMatchObject({ id: before.id, status: 'blocked' });
  const { csrf_token } = await session('/api/v1/session/csrf');
  const { data: skipped } = await session(`${root}${step}/skip`, { method: 'POST',
    headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token }, data: { reason: 'Legacy export is pending' } });
  expect(skipped).toMatchObject({ id: before.id, status: 'skipped', updated_by_id: auth.user.id });
  await page.goto(`${base}/home`);
  await expect(page.getByRole('heading', { name: '已略過的設定步驟' })).toBeVisible();
  await expect(page.getByText(/Historical metrics and comparisons may be incomplete/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('link', { name: '營運概覽', exact: true }).click();
  await expect(page.getByRole('heading', { name: '營運概覽', exact: true })).toBeVisible();
  const onTime = page.locator('.dashboard-stat').filter({ hasText: '準時率' });
  await expect(onTime.locator('strong')).toHaveText('—');
  await expect(onTime).toContainText('未採集');
  await expectNoHorizontalOverflow(page);
});


test('PC04 content studio inserts an approved fact and displays its pinned revision and collection time', async ({ page, dev }) => {
  const { base, post, get } = await workspaceSession(page, dev);
  const brand = await post('/brands', { name: 'Fact studio', slug: 'fact-studio' });
  const store = await post('/stores', { brand_id: brand.id, name: 'Fact store', external_store_id: 'pc04-ui', provider: 'shopify', default_currency: 'USD', default_locale: 'en' });
  const product = await post('/products', { store_id: store.id, title: 'Travel bottle' });
  const sku = await post(`/products/${product.id}/variants`, { sku: 'BOTTLE' });
  const propose = (fact_key, category, value) => post(`/products/${product.id}/facts`, { fact_key, category, value });
  const approve = fact => post(`/fact-revisions/${fact.current_revision_id}/approve`, {});
  const material = await propose('material', 'spec', 'Stainless steel');
  const revision = await approve(material);
  await approve(await propose('lifespan', 'speculation', 'Lasts forever'));
  const { item, variants: [variant] } = await post('/content-items', { brand_id: brand.id, title: 'Bottle caption',
    variants: [{ platform: 'facebook', format: 'text', locale: 'en', body: 'Pack light' }],
  });

  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(`${base}/content?id=${item.id}&related=variant&rid=${variant.id}`);
  await page.getByRole('button', { name: 'Insert product fact', exact: true }).click();
  await page.getByRole('combobox', { name: 'Product', exact: true }).selectOption(product.id);
  const facts = page.getByRole('combobox', { name: 'Approved product fact', exact: true });
  await expect(facts.getByRole('option')).toHaveCount(2);
  await expect(facts.getByRole('option', { name: /Lasts forever/ })).toHaveCount(0);
  await facts.selectOption(`${sku.id}:${revision.id}`);
  await page.getByRole('button', { name: 'Add to working draft', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Product fact added to the working draft.' })).toBeVisible();
  await page.reload();
  const pins = page.getByRole('region', { name: 'Product fact references' });
  await expect(pins).toContainText('Stainless steel');
  await expect(pins).toContainText(`#1 · ${revision.id}`);
  await expect(pins.locator('time')).toHaveAttribute('datetime', revision.created_at);
  const current = await get(`/content-variants/${variant.id}`);
  expect(current.variant.draft_doc.body).toBe('Pack light\nStainless steel');
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const variantPath = `/content-variants/${variant.id}`;
  await expect.poll(async () => (await get(`${variantPath}/revisions`)).length).toBe(1);
  const [committed] = await get(`${variantPath}/revisions`);
  const [approved] = await get(`/products/${product.id}/facts`);
  const revised = await post(`/facts/${material.id}/revisions`, { value: 'Aluminum' }, approved.version);
  await approve(revised);
  await expect.poll(async () => (await get(variantPath)).variant.readiness, { timeout: 15_000 }).toBe('stale');
  expect(await get(`/content-revisions/${committed.id}`)).toEqual(committed);
});
