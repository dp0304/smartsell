import { createHash, randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });
// These tests drive the developer surfaces (Tools, the compatibility workbench and raw operations),
// which operators only see with developer mode on.
const developerMode = () => localStorage.setItem('smartsell.developer', '1');
test.beforeEach(async ({ context }) => { await context.addInitScript(developerMode); });
const operator = { email: 'operator@smartsell.test', name: 'Local operator', workspaceName: 'Local acceptance workspace' };
const brandName = 'Local Launch Brand';
const campaignName = 'Local Launch Campaign';
const draftTitle = 'Local Launch Content';
const exact = { exact: true };
const compat = '/compat/workbench';
const entryTimeout = 20_000; // Vite transforms the module graph on a cold development load.

function responseFor(page, method, path) {
  const pending = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === `/api/v1${path}`, { timeout: 8_000 });
  void pending.catch(() => {});
  return pending;
}

async function checkResponse(response, status, stage) {
  const actual = response.status();
  if (status ? actual !== status : !response.ok()) {
    const body = await response.json().catch(() => null);
    const code = body?.error?.code;
    const safeCode = typeof code === 'string' && /^[A-Za-z][A-Za-z_]{0,63}$/.test(code) ? ` ${code}` : '';
    throw new Error(`${stage} returned HTTP ${actual}${safeCode}${status ? `, expected ${status}` : ''}`);
  }
  return response;
}

async function enter(page, dev, heading = '登入') {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message === 'EOF is not defined' ? 'EOF is not defined' : error.name));
  const entry = await page.goto(`${dev.origin}${compat}`);
  expect(entry.status()).toBe(200);
  try {
    await expect(page).toHaveURL(`${dev.origin}${compat}/login`, { timeout: entryTimeout });
    await expect(page.getByRole('heading', { name: heading, ...exact })).toBeVisible({ timeout: entryTimeout });
  } catch (error) {
    if (failures.length) throw new Error(`Compatibility entry failed to render authentication (${[...new Set(failures)].join(', ')})`);
    throw error;
  }
}

async function setupInUi(page, dev, password) {
  await enter(page, dev, '註冊');
  await page.getByRole('link', { name: '進階初始化', ...exact }).click();
  await expect(page.getByRole('heading', { name: '設定 SmartSell', ...exact })).toBeVisible();
  await page.locator('input[name=name]').fill(operator.name);
  await page.locator('input[name=workspaceName]').fill(operator.workspaceName);
  await page.locator('input[name=email]').fill(operator.email);
  await fillSecret(page, 'password', password);
  await fillSecret(page, 'setupToken', dev.setupToken);
  const setup = responseFor(page, 'POST', '/setup');
  await page.getByRole('button', { name: '設定 SmartSell', ...exact }).click();
  await checkResponse(await setup, 201, 'UI setup');
  await expect(page).toHaveURL(/\/w\/[^/]+\/home$/);
  await expect(page.getByLabel('切換工作區')).toContainText(operator.workspaceName);
}

async function fillSecret(page, name, value) {
  const field = page.locator(`input[name=${name}]`);
  await expect(field).toBeVisible();
  try { await field.fill(value); } catch { throw new Error(`Could not populate the ${name} field`); }
}

async function english(page) {
  await page.getByRole('combobox', { name: '介面語言', ...exact }).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

async function viaTools(page, command) {
  await page.getByRole('button', { name: 'Tools', ...exact }).click();
  const dialog = page.getByRole('dialog', { name: 'Tools', ...exact });
  await dialog.getByRole('combobox', { name: 'Action', ...exact }).selectOption(command);
  return dialog;
}

async function field(dialog, name, value) {
  const input = dialog.locator(`[name=${name}]`);
  if (typeof value === 'object') await input.selectOption(value);
  else if (await input.evaluate(element => element instanceof HTMLSelectElement)) await input.selectOption(String(value));
  else await input.fill(String(value));
}

async function fields(dialog, values) {
  for (const [name, value] of Object.entries(values)) await field(dialog, name, value);
}

async function runCommand(page, dialog, wid, command, { confirm = false, status } = {}) {
  const pending = responseFor(page, 'POST', `/workspaces/${wid}/commands/${command.replace('.', '/')}`);
  await dialog.getByRole('button', { name: 'Run command', ...exact }).click();
  if (confirm) await dialog.getByRole('button', { name: 'Confirm operation', ...exact }).click();
  const response = await checkResponse(await pending, status, command);
  const json = await response.json();
  if (response.ok()) {
    await expect(dialog.getByRole('status')).toContainText('The server accepted the command.');
    await expect(dialog.locator('pre')).toContainText(JSON.stringify(json.data, null, 2));
  }
  return json;
}

const workspaceId = page => new URL(page.url()).pathname.match(/\/w\/([^/]+)/)?.[1];
const workbenchNav = page => page.getByRole('navigation', { name: 'Operations workspace', ...exact });
const close = dialog => dialog.getByRole('button', { name: 'Close', ...exact }).click();
const row = (page, name) => page.getByRole('row').filter({ has: page.getByRole('cell', { name, ...exact }) });

async function createBrand(page, wid) {
  await page.getByRole('link', { name: 'Workspace settings', ...exact }).click();
  await page.getByRole('button', { name: 'Create brand', ...exact }).click();
  const dialog = page.getByRole('dialog', { name: 'Tools', ...exact });
  await fields(dialog, { name: brandName, slug: 'local-launch' });
  const { data } = await runCommand(page, dialog, wid, 'workspace.create_brand');
  expect(data).toMatchObject({ id: expect.any(String), data: { name: brandName } });
  await close(dialog);
  await expect(row(page, brandName)).toBeVisible();
  return data;
}

async function createDrafts(page, wid) {
  const brand = await createBrand(page, wid);
  await page.getByRole('link', { name: 'Campaigns', ...exact }).click();
  await page.getByRole('button', { name: 'Create campaign draft', ...exact }).click();
  let dialog = page.getByRole('dialog', { name: 'Tools', ...exact });
  await fields(dialog, { brand_id: { label: brandName }, name: campaignName });
  const { data: campaign } = await runCommand(page, dialog, wid, 'campaign.create_draft');
  expect(campaign.data).toMatchObject({ brand_id: brand.id, name: campaignName, status: 'draft' });
  await close(dialog);
  await expect(row(page, campaignName)).toContainText('Draft');

  await workbenchNav(page).getByRole('link', { name: 'Content studio', ...exact }).click();
  await page.getByRole('button', { name: 'Create content', ...exact }).click();
  dialog = page.getByRole('dialog', { name: 'Tools', ...exact });
  await fields(dialog, { brand_id: { label: brandName }, campaign_id: { label: campaignName }, title: draftTitle });
  const { data: content } = await runCommand(page, dialog, wid, 'content.content_create_item');
  expect(content.item.data).toMatchObject({ brand_id: brand.id, campaign_id: campaign.id, title: draftTitle });
  await close(dialog);
  await expect(row(page, draftTitle)).toBeVisible();
  await row(page, draftTitle).getByRole('cell').first().getByRole('button').click();
  await page.getByRole('dialog', { name: draftTitle, ...exact }).getByRole('button', { name: 'Create content variant', ...exact }).click();
  dialog = page.getByRole('dialog', { name: 'Tools', ...exact });
  const text = 'Local product launch draft';
  await fields(dialog, { platform: { value: 'facebook' }, format: { value: 'text' }, locale: 'en', draft_doc: JSON.stringify({ body: text }) });
  const { data: { variant } } = await runCommand(page, dialog, wid, 'content.content_create_variant');
  expect(variant.data).toMatchObject({ readiness: 'draft', draft_doc: { body: text } });
  await close(dialog);
  await close(page.getByRole('dialog', { name: draftTitle, ...exact }));
  const records = responseFor(page, 'POST', `/workspaces/${wid}/commands/content/content_list`);
  await page.reload();
  const persisted = await (await checkResponse(await records, 200, 'Reload content records')).json();
  expect(persisted.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: content.item.id })]));
  await expect(row(page, draftTitle)).toBeVisible();
  dialog = await viaTools(page, 'content.content_get_variant');
  await field(dialog, 'variant_id', { value: variant.id });
  const { data: persistedVariant } = await runCommand(page, dialog, wid, 'content.content_get_variant');
  expect(persistedVariant.variant).toMatchObject({ id: variant.id, data: { draft_doc: { body: text } } });
}

// Diagnostic setup uses the deployed HTTP contract and the browser context's cookie jar.
async function diagnosticSetup(page, dev) {
  const credentials = { ...operator, password: dev.password() };
  const response = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken }, data: credentials, maxRedirects: 0,
  }).catch(() => { throw new Error('Diagnostic bootstrap did not receive an HTTP response'); });
  await checkResponse(response, 201, 'Diagnostic bootstrap');
  return (await response.json()).workspaces[0].id;
}

async function diagnosticEntry(page, dev) {
  const wid = await diagnosticSetup(page, dev);
  await page.goto(`${dev.origin}${compat}`);
  await expect(page).toHaveURL(new RegExp(`/w/${wid}/home$`));
  await english(page);
  return wid;
}

async function discovery(page, dev, wid) {
  const response = await page.request.get(`${dev.origin}/api/v1/workspaces/${wid}/commands`, { maxRedirects: 0 });
  return (await (await checkResponse(response, 200, 'Workbench command discovery')).json()).items;
}

test('strict UI | default setup, catalog-backed write and reciprocal workspace links', async ({ page, dev }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const password = dev.password();
  await page.goto(dev.origin);
  await expect(page).toHaveURL(`${dev.origin}/login`, { timeout: entryTimeout });
  await expect(page.getByRole('heading', { name: '註冊', ...exact })).toBeVisible();
  await english(page);

  await page.getByRole('link', { name: 'Compatibility workbench', ...exact }).click();
  await expect(page).toHaveURL(`${dev.origin}${compat}/login`);
  await page.getByRole('link', { name: 'Back to main workspace', ...exact }).click();
  await page.getByRole('link', { name: 'Advanced setup', ...exact }).click();
  await page.getByLabel('Your name', exact).fill(operator.name);
  await page.getByLabel('Workspace name', exact).fill(operator.workspaceName);
  await page.getByLabel('Email', exact).fill(operator.email);
  await fillSecret(page, 'password', password);
  await fillSecret(page, 'setupToken', dev.setupToken);
  const setup = responseFor(page, 'POST', '/setup');
  await page.getByRole('button', { name: 'First-time setup', ...exact }).click();
  const { data: session } = await (await checkResponse(await setup, 201, 'Default UI setup')).json();
  const wid = session.workspaces[0].id;
  const home = `${dev.origin}/w/${wid}/home`;
  // Setup lands on the dashboard; this test covers the advanced workbench, so continue there.
  await expect(page).toHaveURL(`${dev.origin}/app/${wid}`);
  await page.goto(home);

  // Settings modules live in a folded sidebar section.
  const settings = page.getByRole('navigation').getByRole('button', { name: 'Settings', ...exact });
  if (await settings.getAttribute('aria-expanded') === 'false') await settings.click();
  await page.getByRole('navigation').getByRole('link', { name: 'Brands & workspace', ...exact }).click();
  await page.getByRole('button', { name: 'Create brand', ...exact }).click();
  const dialog = page.getByRole('dialog', { name: 'Create brand', ...exact });
  await fields(dialog, { name: brandName, slug: 'local-launch' });
  const create = responseFor(page, 'POST', `/workspaces/${wid}/brands`);
  await dialog.getByRole('button', { name: 'Save', ...exact }).click();
  const created = await checkResponse(await create, undefined, 'Default UI brand creation');
  expect(await created.request().headerValue('x-csrf-token')).toBeTruthy();
  await expect(dialog.getByRole('status')).toContainText('Saved');
  await close(dialog);
  await expect(row(page, brandName)).toBeVisible();

  const brandPath = new URL(page.url()).pathname;
  const browsePath = `${brandPath}?tab=brands#brands`;
  await page.goto(`${dev.origin}${browsePath}`);
  const sharedHome = `${dev.origin}${compat}/workspace/w/${wid}/home`;
  // Verify workspace continuity across cold navigation, reload, and return.
  for (const visit of ['first visit', 'return visit']) {
    await test.step(`Open both workspace entries: ${visit}`, async () => {
      await page.getByRole('link', { name: 'Compatibility workbench', ...exact }).click();
      await expect(page).toHaveURL(`${dev.origin}${compat}/workspace${browsePath}`);
      await expect(page.getByRole('combobox', { name: 'Workspace', ...exact })).toHaveValue(wid);
      if (visit === 'first visit') await page.reload();
      await expect(row(page, brandName)).toBeVisible();
      await page.getByRole('link', { name: 'Back to workspace view', ...exact }).click();
      await expect(page).toHaveURL(`${dev.origin}${browsePath}`);
      await expect(page.getByRole('combobox', { name: 'Workspace', ...exact })).toHaveValue(wid);
      await expect(row(page, brandName)).toBeVisible();
    });
  }

  await page.getByRole('link', { name: 'Compatibility workbench', ...exact }).click();
  await page.getByRole('link', { name: 'Command API records', ...exact }).click();
  await expect(page).toHaveURL(`${dev.origin}${compat}/w/${wid}/home`);
  await expect(page.getByRole('combobox', { name: 'Switch workspace', ...exact })).toHaveValue(wid);
  await workbenchNav(page).getByRole('link', { name: 'Workspace settings', ...exact }).click();
  await expect(page).toHaveURL(`${dev.origin}${compat}/w/${wid}/settings`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Workspace settings', ...exact })).toBeVisible();
  await page.getByRole('link', { name: 'Back to main workspace', ...exact }).click();
  await expect(page).toHaveURL(sharedHome);
  await page.getByRole('link', { name: 'Back to workspace view', ...exact }).click();
  await expect(page).toHaveURL(home);

  const logout = responseFor(page, 'DELETE', '/session');
  await page.getByRole('button', { name: 'Sign out', ...exact }).click();
  await checkResponse(await logout, 204, 'Default UI sign-out');
  expect((await page.request.get(`${dev.origin}/api/v1/session`)).status()).toBe(401);
  await page.getByRole('link', { name: 'Compatibility workbench', ...exact }).click();
  await expect(page).toHaveURL(`${dev.origin}${compat}/login`);
  await page.getByRole('link', { name: 'Back to main workspace', ...exact }).click();
  await page.getByLabel('Username or email', exact).fill(operator.email);
  await fillSecret(page, 'password', password);
  const login = responseFor(page, 'POST', '/session');
  await page.getByRole('button', { name: 'Sign in', ...exact }).click();
  await checkResponse(await login, 200, 'Default UI sign-in');
  await expect(page).toHaveURL(`${dev.origin}/app/${wid}`);
  expect(errors).toEqual([]);
});

test('strict UI | compatibility setup, fresh-browser sign-in and both languages', async ({ page, browser, dev }) => {
  const password = dev.password();
  await test.step('Create the first owner and workspace in the setup form', () => setupInUi(page, dev, password));
  const fresh = await browser.newPage();
  await fresh.addInitScript(developerMode);
  try {
    await test.step('Sign in through the ordinary entry using a fresh cookie jar', async () => {
      await enter(fresh, dev);
      await fresh.locator('input[name=identifier]').fill(operator.email);
      await fillSecret(fresh, 'password', password);
      const login = responseFor(fresh, 'POST', '/session');
      await fresh.getByRole('button', { name: '登入', ...exact }).click();
      await checkResponse(await login, 200, 'UI sign-in');
      await expect(fresh).toHaveURL(/\/w\/[^/]+\/home$/);
    });
    await test.step('Switch to English and back to Traditional Chinese', async () => {
      await english(fresh);
      await expect(fresh.getByRole('link', { name: 'Campaigns', ...exact })).toBeVisible();
      await fresh.getByRole('combobox', { name: 'Interface language', ...exact }).selectOption('zh-Hant');
      await expect(fresh.locator('html')).toHaveAttribute('lang', 'zh-Hant');
      await expect(fresh.getByRole('link', { name: '行銷活動', ...exact })).toBeVisible();
    });
  } finally {
    await fresh.close();
  }
});

test('strict UI | compatibility creates a brand, campaign and content draft and reloads', async ({ page, dev }) => {
  await setupInUi(page, dev, dev.password());
  await english(page);
  await createDrafts(page, workspaceId(page));
});

test('diagnostic | operator shell fits 1280 × 800 and renders an unavailable workspace notice', async ({ page, dev }) => {
  await diagnosticEntry(page, dev);
  await expect(page.getByRole('navigation', { name: 'Operations workspace' })).toBeVisible();
  const dimensions = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth }));
  expect(await dimensions()).toEqual({ width: 1280, height: 800, scroll: 1280 });
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.getByText(/Scroll horizontally to continue/)).toBeVisible();
  expect((await dimensions()).scroll).toBeGreaterThan(1200);
  await page.goto(`${dev.origin}${compat}/w/unassigned-workspace/home`);
  await expect(page.getByText('This workspace is unavailable to your account.', exact)).toBeVisible();
});

test('diagnostic | authenticated discovery serves the workbench command and records contracts', async ({ page, dev }) => {
  const wid = await diagnosticSetup(page, dev);
  const [commands, records] = await Promise.allSettled([
    discovery(page, dev, wid),
    page.request.get(`${dev.origin}/api/v1/workspaces/${wid}/records/workspace/brand`, { maxRedirects: 0 })
      .then(async response => (await (await checkResponse(response, 200, 'Workbench brand records')).json()).items),
  ]);
  expect.soft(commands.status === 'rejected' ? commands.reason.message : commands.value).toEqual(expect.arrayContaining([
    expect.objectContaining({ module: 'workspace', action: 'create_brand' }),
    expect.objectContaining({ module: 'planning', action: 'approve' }),
    expect.objectContaining({ module: 'execution', action: 'reconcile_manual' }),
  ]));
  expect.soft(records.status === 'rejected' ? records.reason.message : records.value).toEqual([]);
});

test('diagnostic | downstream draft forms with API bootstrap', async ({ page, dev }) => {
  const wid = await diagnosticEntry(page, dev);
  await createDrafts(page, wid);
});

async function seedCommand(page, dev, wid, command, data) {
  const response = await page.request.post(`${dev.origin}/api/v1/workspaces/${wid}/commands/${command.replace('.', '/')}`, {
    headers: { Origin: dev.origin, 'Idempotency-Key': randomUUID() }, data, maxRedirects: 0,
  });
  return (await (await checkResponse(response, undefined, `Diagnostic prerequisite ${command}`)).json()).data;
}

async function seedManualTarget(page, dev, wid) {
  const seed = (command, input) => seedCommand(page, dev, wid, command, input);
  const brand = await seed('workspace.create_brand', { name: 'Approval brand', slug: 'approval-brand' });
  const { item } = await seed('content.content_create_item', { brand_id: brand.id, title: 'Approval prerequisite' });
  const { variant } = await seed('content.content_create_variant', {
    content_item_id: item.id, platform: 'facebook', format: 'text', locale: 'en', market: 'TW', draft_doc: { body: 'Local approval check' },
  });
  await seed('content.content_commit_revision', { variant_id: variant.id, expected_version: variant.version, base_revision_id: null });
  await seed('planning.set_publishing_profile', {
    account_id: 'local-manual-profile', platform: 'facebook', timezone: 'UTC', formats: ['text'], active: true, manual_capability: true,
  });
  return seed('planning.create_target', {
    account_id: 'local-manual-profile', content_variant_id: variant.id, route: 'manual',
    visibility: 'public', scheduled_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
}

async function submitTargetInUi(page, wid, target) {
  await page.getByRole('link', { name: 'Approvals', ...exact }).click();
  await page.getByRole('button', { name: 'Publish target', ...exact }).click();
  await page.getByRole('button', { name: target.id, ...exact }).click();
  const detail = page.getByRole('dialog', { name: target.id, ...exact });
  await detail.getByRole('button', { name: 'Submit for publishing approval', ...exact }).click();
  const dialog = page.getByRole('dialog', { name: 'Tools', ...exact });
  const { data: submitted } = await runCommand(page, dialog, wid, 'planning.submit', { confirm: true });
  expect(submitted.data).toMatchObject({ status: 'awaiting_approval', frozen_hash: expect.any(String) });
  await close(dialog);
  await close(detail);
  return submitted;
}

test('strict UI | owner self-review is denied and a different reviewer approves the target', async ({ page, browser, dev }) => {
  const password = dev.password();
  await setupInUi(page, dev, password);
  await english(page);
  const wid = workspaceId(page);
  const sessionResponse = await page.request.get(`${dev.origin}/api/v1/session`);
  const ownerSession = await (await checkResponse(sessionResponse, 200, 'Submitter session')).json();
  const owner = ownerSession.user;
  expect(owner).toMatchObject({ id: expect.any(String), email: operator.email });
  expect(ownerSession.workspaces).toContainEqual(expect.objectContaining({ id: wid, role: 'owner' }));
  await expect(page.getByLabel('Signed-in account', exact)).toHaveText(operator.name);
  const target = await seedManualTarget(page, dev, wid);
  const submitted = await submitTargetInUi(page, wid, target);
  const { approval_id, frozen_hash, revision_id } = submitted.data;
  const decision = { target_id: submitted.id, expected_version: submitted.version, frozen_hash };
  const approveButton = { name: 'Approve publish target', ...exact };

  await page.getByRole('button', { name: 'Approval request', ...exact }).click();
  await expect(page.getByText('There are no records in this view.', exact)).toBeVisible();
  await expect(page.getByRole('button', { name: approval_id, ...exact })).toHaveCount(0);
  await page.getByRole('button', { name: 'Publish target', ...exact }).click();
  await page.getByRole('button', { name: target.id, ...exact }).click();
  const targetDetail = page.getByRole('dialog', { name: target.id, ...exact });
  await expect(targetDetail.getByText('Server details', exact)).toBeVisible();
  await expect(targetDetail.getByRole('button', approveButton)).toHaveCount(0);
  await close(targetDetail);

  const denial = await page.request.post(`${dev.origin}/api/v1/workspaces/${wid}/commands/planning/approve`, {
    headers: { Origin: dev.origin, 'Idempotency-Key': randomUUID() }, data: decision, maxRedirects: 0,
  });
  const denied = await (await checkResponse(denial, 403, 'Submitter approval')).json();
  expect(denied.error.code).toBe('self_review_forbidden');
  const pending = await seedCommand(page, dev, wid, 'planning.get_target', { target_id: target.id });
  expect(pending).toMatchObject({
    id: target.id, version: submitted.version, data: { status: 'awaiting_approval', frozen_hash, revision_id },
    approval: { id: approval_id, data: { status: 'pending', requested_by: owner.id, frozen_hash } },
  });
  expect(pending.approval.data.decided_by).toBeUndefined();

  const reviewer = { id: randomUUID(), email: 'reviewer@smartsell.test', name: 'Local reviewer', role: 'reviewer' };
  dev.switchIdentity(reviewer);
  const fresh = await browser.newPage();
  await fresh.addInitScript(developerMode);
  try {
    await enter(fresh, dev);
    await english(fresh);
    await fresh.getByLabel('Username or email', exact).fill(reviewer.email);
    await fillSecret(fresh, 'password', password);
    const login = responseFor(fresh, 'POST', '/session');
    await fresh.getByRole('button', { name: 'Sign in', ...exact }).click();
    const session = await (await checkResponse(await login, 200, 'Reviewer sign-in')).json();
    expect(session.user).toMatchObject({ id: reviewer.id, email: reviewer.email });
    expect(session.user.id).not.toBe(owner.id);
    expect(session.workspaces).toContainEqual(expect.objectContaining({ id: wid, role: 'reviewer' }));
    await expect(fresh).toHaveURL(new RegExp(`/w/${wid}/home$`));
    await expect(fresh.getByLabel('Signed-in account', exact)).toHaveText(reviewer.name);
    await fresh.getByRole('link', { name: 'Workspace settings', ...exact }).click();
    await expect(fresh.getByRole('heading', { name: 'Workspace settings', ...exact })).toBeVisible();
    await expect(fresh.getByRole('button', { name: 'Create brand', ...exact })).toHaveCount(0);
    await fresh.getByRole('link', { name: 'Approvals', ...exact }).click();
    await fresh.getByRole('button', { name: 'Approval request', ...exact }).click();
    await fresh.getByRole('button', { name: approval_id, ...exact }).click();
    const detail = fresh.getByRole('dialog', { name: approval_id, ...exact });
    await expect(detail.getByText(`Publishing target version ${submitted.version}`, exact)).toBeVisible();
    await detail.getByRole('button', approveButton).click();
    const dialog = fresh.getByRole('dialog', { name: 'Tools', ...exact });
    const approval = responseFor(fresh, 'POST', `/workspaces/${wid}/commands/planning/approve`);
    const { data: scheduled } = await runCommand(fresh, dialog, wid, 'planning.approve', { confirm: true, status: 200 });
    expect((await approval).request().postDataJSON()).toMatchObject(decision);
    expect(scheduled).toMatchObject({ id: target.id, version: submitted.version + 1, data: { status: 'scheduled', frozen_hash, revision_id } });
  } finally {
    await fresh.close();
  }

  dev.switchIdentity({ ...operator, id: owner.id, role: 'owner' });
  await page.goto(`${dev.origin}${compat}/login`);
  await page.getByLabel('Username or email', exact).fill(operator.email);
  await fillSecret(page, 'password', password);
  const login = responseFor(page, 'POST', '/session');
  await page.getByRole('button', { name: 'Sign in', ...exact }).click();
  const session = await (await checkResponse(await login, 200, 'Owner sign-in after review')).json();
  expect(session.user).toMatchObject({ id: owner.id, email: operator.email });
  expect(session.workspaces).toContainEqual(expect.objectContaining({ id: wid, role: 'owner' }));
  await expect(page).toHaveURL(new RegExp(`/w/${wid}/home$`));
  const reviewed = await seedCommand(page, dev, wid, 'planning.get_target', { target_id: target.id });
  expect(reviewed).toMatchObject({
    id: target.id, version: submitted.version + 1, data: { status: 'scheduled', frozen_hash, revision_id },
    approval: { id: approval_id, data: { status: 'approved', requested_by: owner.id, decided_by: reviewer.id, frozen_hash } },
  });

  let dialog = await viaTools(page, 'execution.enqueue');
  await field(dialog, 'target_id', { value: target.id });
  const { data: task } = await runCommand(page, dialog, wid, 'execution.enqueue', { confirm: true });
  expect(task.data).toMatchObject({ target_id: target.id, due_at: target.data.scheduled_at, route: 'manual', status: 'scheduled' });
  await close(dialog);

  // Approval requires a future schedule, but the manual claim requires it to be due.
  await dev.setTime(Date.parse(task.data.due_at));
  dialog = await viaTools(page, 'execution.begin_manual');
  await field(dialog, 'task_id', task.id);
  const { data: started } = await runCommand(page, dialog, wid, 'execution.begin_manual', { confirm: true });
  expect(started.task, 'Manual claim must pass the execution gate').toMatchObject({ id: task.id, data: { status: 'manual_in_progress', reason: null } });
  expect(started.attempt).toMatchObject({ id: expect.any(String), data: { fencing_token: expect.any(Number) } });
  await close(dialog);

  const { attempt } = started;
  const permalink = 'https://facebook.example/post/1';
  const evidence = 'Operator viewed the page and matched the approved copy';
  dialog = await viaTools(page, 'execution.reconcile_manual');
  await fields(dialog, {
    task_id: task.id, attempt_id: attempt.id, fencing_token: attempt.data.fencing_token,
    outcome: { value: 'published' }, permalink, evidence,
  });
  const { data: published } = await runCommand(page, dialog, wid, 'execution.reconcile_manual', { confirm: true });
  expect(published.task).toMatchObject({ id: task.id, data: { status: 'published', post_id: published.post.id } });

  await page.reload();
  dialog = await viaTools(page, 'execution.get_task');
  await field(dialog, 'task_id', task.id);
  const { data: persisted } = await runCommand(page, dialog, wid, 'execution.get_task', { status: 200 });
  expect(persisted).toMatchObject({
    task: { id: task.id, data: { status: 'published', post_id: published.post.id } },
    post: { id: published.post.id, data: { target_id: target.id, task_id: task.id, attempt_id: attempt.id, permalink, evidence, verification: 'manual_confirmed' } },
  });
});

test('diagnostic | a stale brand edit returns a visible conflict and preserves the newer version', async ({ page, dev }) => {
  const wid = await diagnosticEntry(page, dev);
  const brand = await createBrand(page, wid);
  const second = await page.context().newPage();
  try {
    await second.goto(`${dev.origin}${compat}`);
    const updatedName = 'Local Launch Brand Updated';
    const edit = async (tab, name) => {
      const dialog = await viaTools(tab, 'workspace.update_brand');
      await fields(dialog, { id: { value: brand.id }, expected_version: brand.version, name });
      return dialog;
    };
    const stale = await edit(page, 'Stale title');
    const current = await edit(second, updatedName);
    await runCommand(second, current, wid, 'workspace.update_brand');
    const { error } = await runCommand(page, stale, wid, 'workspace.update_brand', { status: 409 });
    expect(error.code).toMatch(/version|conflict/i);
    await expect(stale.getByRole('alert')).toContainText(error.message);
    await close(stale);
    await page.reload();
    await expect(row(page, updatedName)).toBeVisible();
    await expect(row(page, 'Stale title')).toHaveCount(0);
  } finally {
    await second.close();
  }
});

test('CO02 CO03 CO05 CO06 CO08 | content board, accessibility, translations and reuse', async ({ page, dev }) => {
  const wid = await diagnosticEntry(page, dev);
  const seed = (command, input) => seedCommand(page, dev, wid, command, input);
  const brand = await seed('workspace.create_brand', { name: 'Content QA brand', slug: 'content-qa' });
  const title = 'Content QA source';
  const { item } = await seed('content.content_create_item', { brand_id: brand.id, title, blocked_reason: 'Awaiting final rights review' });
  const create = (platform, format) => seed('content.content_create_variant', { content_item_id: item.id, platform, format, locale: 'en' });
  const { variant: source } = await create('generic', 'text');
  const { variant: media } = await create('instagram', 'reel');
  const { variant: tiktok } = await create('tiktok', 'text');
  const first = await seed('content.content_commit_revision', { variant_id: source.id, expected_version: source.version, base_revision_id: null, draft_doc: { body: 'English original' } });

  await workbenchNav(page).getByRole('link', { name: 'Content studio', ...exact }).click();
  await expect(page).toHaveURL(`${dev.origin}${compat}/w/${wid}/content`);
  const studio = page.getByRole('main');
  await expect(studio.getByRole('heading', { name: 'Content studio', ...exact })).toBeVisible();
  await studio.getByRole('button', { name: 'Production board', ...exact }).click();
  const accepted = page.getByRole('region', { name: 'Accepted', exact: true });
  const drafting = page.getByRole('region', { name: 'Drafting', exact: true });
  await expect(accepted.getByText('Awaiting final rights review')).toBeVisible();
  const moved = responseFor(page, 'POST', `/workspaces/${wid}/commands/content/content_set_stage`);
  await accepted.locator('article').filter({ hasText: title }).dragTo(drafting);
  await checkResponse(await moved, 200, 'Drag production card');
  await expect(drafting.getByRole('button', { name: title, exact: true })).toBeVisible();
  expect(await seed('planning.list_targets', {})).toEqual([]);
  expect((await seed('execution.list_tasks', {})).tasks).toEqual([]);
  await drafting.getByRole('button', { name: title, exact: true }).click();
  const itemDrawer = page.getByRole('dialog', { name: title, exact: true });
  const tools = page.getByRole('dialog', { name: 'Tools', exact: true });
  const openVariant = async name => itemDrawer.getByRole('button', { name, exact: true }).click();
  const back = () => itemDrawer.getByRole('button', { name: /Back to/ }).click();

  await openVariant('instagram · en');
  await itemDrawer.getByRole('button', { name: 'Save working draft', exact: true }).click();
  await field(tools, 'draft_doc', JSON.stringify({ body: 'Reel copy', media: [{ asset_version_id: 'local-unavailable-original', alt_text: 'A red bicycle', caption_rendition_id: 'local-unavailable-caption' }] }));
  const savedMedia = await runCommand(page, tools, wid, 'content.content_autosave_variant');
  expect(savedMedia.data.id).toBe(media.id);
  await close(tools);
  await expect(itemDrawer.getByRole('heading', { name: 'Approximate publishing preview' })).toBeVisible();
  await expect(itemDrawer.getByText('This platform and format do not support alt text. The draft retains it.', { exact: false })).toBeVisible();
  await expect(itemDrawer.getByText('This platform and format do not support caption files. The draft retains them.', { exact: false })).toBeVisible();
  await expect(itemDrawer.getByText('The media rendition is not ready.', { exact: false })).toBeVisible();
  await back();

  await openVariant('tiktok · en');
  await itemDrawer.getByRole('button', { name: 'Save working draft', exact: true }).click();
  await field(tools, 'draft_doc', JSON.stringify({ body: 'TikTok copy' }));
  const savedTikTok = await runCommand(page, tools, wid, 'content.content_autosave_variant');
  expect(savedTikTok.data.id).toBe(tiktok.id);
  await close(tools);
  await expect(itemDrawer.getByText('Select TikTok privacy manually.', { exact: false })).toBeVisible();
  await expect(itemDrawer.getByText('Select TikTok commercial disclosure manually.', { exact: false })).toBeVisible();
  expect((await seed('content.content_get_variant', { variant_id: media.id })).variant.data.draft_doc.body).toBe('Reel copy');
  expect((await seed('content.content_get_variant', { variant_id: tiktok.id })).variant.data.draft_doc.body).toBe('TikTok copy');
  await back();

  await openVariant('generic · en');
  const localized = [];
  for (const [locale, body] of [['fr', 'Offre française'], ['ja', '日本向けの紹介']]) {
    await itemDrawer.getByRole('button', { name: 'Create translation', exact: true }).click();
    await fields(tools, { locale, body });
    const { data } = await runCommand(page, tools, wid, 'content.content_create_translation');
    localized.push(data);
    await close(tools);
  }
  await itemDrawer.getByRole('button', { name: 'Commit content revision', exact: true }).click();
  await field(tools, 'draft_doc', JSON.stringify({ body: 'English revision' }));
  const { data: second } = await runCommand(page, tools, wid, 'content.content_commit_revision');
  await close(tools);
  await back();
  await expect(itemDrawer.getByText('Source changed · Review required', { exact: true })).toHaveCount(2);
  await openVariant('generic · fr');
  await expect(itemDrawer.getByText('Offre française', { exact: true })).toBeVisible();
  await itemDrawer.getByRole('button', { name: 'Keep market rewrite', exact: true }).click();
  await field(tools, 'note', 'Market terminology');
  await runCommand(page, tools, wid, 'content.content_mark_divergence');
  await close(tools);
  await expect(itemDrawer.getByText('Market rewrite retained', { exact: true })).toBeVisible();
  await seed('content.content_commit_revision', { variant_id: source.id, expected_version: second.variant.version, base_revision_id: second.revision.id, body: 'English final' });
  await back();
  await expect(itemDrawer.getByText('Source changed · Review required', { exact: true })).toHaveCount(2);
  for (const entry of localized) {
    const persisted = await seed('content.content_get_variant', { variant_id: entry.variant.id });
    expect(persisted.variant.data.current_revision_id).toBe(entry.revision.id);
    expect(persisted.variant.data.draft_doc.body).toBe(entry.revision.data.body);
  }

  await itemDrawer.getByRole('button', { name: 'Reuse as new draft', exact: true }).click();
  await field(tools, 'title', 'Content QA reused');
  const { data: copy } = await runCommand(page, tools, wid, 'content.content_duplicate');
  expect(copy.item.data.derived_from_item_id).toBe(item.id);
  expect(copy.variants.find(row => row.data.locale === 'fr').data).toMatchObject({ derived_from_revision_id: localized[0].revision.id, parent_variant_id: localized[0].variant.id, current_revision_id: null });
  await close(tools);
  await close(itemDrawer);
  await page.getByRole('button', { name: 'Content QA reused', exact: true }).click();
  const copyDrawer = page.getByRole('dialog', { name: 'Content QA reused', exact: true });
  await expect(copyDrawer.getByText(`Source content ${item.id}`, { exact: true })).toBeVisible();
  await copyDrawer.getByRole('button', { name: 'generic · fr', exact: true }).click();
  await expect(copyDrawer.getByText(`Source revision ${localized[0].revision.id}`, { exact: true })).toBeVisible();
  await expect(copyDrawer.getByText('Offre française', { exact: true })).toBeVisible();
  expect((await seed('content.content_get_variant', { variant_id: source.id })).current_revision.id).not.toBe(first.revision.id);
});

async function planningRest(page, dev, wid, method, path, data) {
  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  const { csrf_token } = await (await checkResponse(csrf, 200, 'Operations CSRF')).json();
  const response = await page.request.fetch(`${dev.origin}/api/v1/workspaces/${wid}${path}`, {
    method, data, headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token },
  });
  return (await (await checkResponse(response, undefined, `${method} ${path}`)).json()).data;
}

async function planningOperation(page, name) {
  if (!await page.getByRole('button', { name: new RegExp(name) }).isVisible()) {
    await page.getByRole('button', { name: 'Advanced operations', ...exact }).click();
  }
  await page.getByRole('button', { name: new RegExp(name) }).click();
  return page.getByRole('dialog', { name, ...exact });
}

test('PL01 | Calendar grid distinguishes an unknown outcome from a production deadline', async ({ page, dev }) => {
  const wid = await diagnosticSetup(page, dev);
  const rest = (method, path, data) => planningRest(page, dev, wid, method, path, data);
  const post = (path, data) => rest('POST', path, data);
  const brand = await post('/brands', { name: 'Calendar review', slug: 'calendar-review' });
  const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: 'pl01-local', display_name: 'Local PL01', brand_id: brand.id, owned_account_confirmed: true });
  await post('/approval-policies', { name: 'Local manual policy', mode: 'optional', conditions: { social_account_ids: [account.id] } });
  const scheduled_at = new Date().toISOString();
  const { item } = await post('/content-items', { brand_id: brand.id, title: 'Calendar draft', production_due_at: scheduled_at });
  const { variant } = await post(`/content-items/${item.id}/variants`, { platform: 'facebook', market: 'TW', format: 'text', body_markdown: 'Local test caption' });
  await post(`/content-variants/${variant.id}/revisions`, { expected_version: variant.version, base_revision_id: null });
  const target = await post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id, scheduled_at, schedule_tz: 'UTC' });
  await post(`/publish-targets/${target.id}/submit`, {});
  const [task] = await rest('GET', '/execution-tasks');
  const path = `/execution-tasks/${task.id}`;
  await post(`${path}/handover`, {});
  await post(`${path}/manual-start`, {});
  expect(await post(`${path}/reconcile`, { outcome_unknown: true })).toMatchObject({ task: { status: 'outcome_unknown' } });

  await page.goto(`${dev.origin}/w/${wid}/calendar?tab=targets`);
  await english(page);
  const grid = page.locator('.calendar-grid');
  await expect(grid.getByRole('button', { name: /^Scheduled ·/ })).toBeVisible();
  await expect(grid.getByText('Outcome unknown', exact)).toBeVisible();
  await expect(grid.getByRole('link', { name: /^Deadline · .*Calendar draft/ })).toBeVisible();
  await expect(grid.getByRole('link', { name: /^Published ·/ })).toHaveCount(0);
  expect(await rest('GET', path)).toMatchObject({ status: 'outcome_unknown' });
  expect(await rest('GET', `/publish-targets/${target.id}`)).toMatchObject({ display_status: 'outcome_unknown' });
  expect(await rest('GET', '/platform-posts')).toEqual([]);
});

test('PL07 | Workbench requests official schedule read and reports missing authorization without claims', async ({ page, dev }) => {
  const wid = await diagnosticSetup(page, dev);
  const post = (path, data) => planningRest(page, dev, wid, 'POST', path, data);
  const brand = await post('/brands', { name: 'Schedule review', slug: 'schedule-review' });
  const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: '1234', owned_account_confirmed: true, display_name: 'Unconnected page', brand_id: brand.id });
  await page.goto(`${dev.origin}/w/${wid}/calendar`);
  await english(page);
  const dialog = await planningOperation(page, 'publishing_reconcile_platform_schedule');
  await dialog.locator('[name="parameter-id"]').fill(account.id);
  const pending = responseFor(page, 'GET', `/workspaces/${wid}/reconciliation/platform-schedules/${account.id}`);
  await dialog.getByRole('button', { name: 'Run operation', ...exact }).click();
  await checkResponse(await pending, 409, 'Unauthorized schedule read');
  await expect(dialog.getByRole('alert')).toContainText('Connect the Facebook Page');
  for (const route of ['/reconciliation/candidates', '/platform-posts', '/publish-targets']) {
    expect(await planningRest(page, dev, wid, 'GET', route)).toEqual([]);
  }
});

test('PL08 | Publishing pauses display each native withdrawal result', async ({ page, dev }) => {
  const wid = await diagnosticSetup(page, dev);
  const rest = (method, path, data) => planningRest(page, dev, wid, method, path, data);
  const post = (path, data) => rest('POST', path, data);
  const brand = await post('/brands', { name: 'Pause review', slug: 'pause-review' });
  await post('/approval-policies', { name: 'Local manual policy', mode: 'optional' });
  const { item } = await post('/content-items', { brand_id: brand.id, title: 'Pause draft' });
  const { variant } = await post(`/content-items/${item.id}/variants`, { platform: 'facebook', market: 'TW', format: 'text', body_markdown: 'Local scheduled caption' });
  await post(`/content-variants/${variant.id}/revisions`, { expected_version: variant.version, base_revision_id: null });

  const targets = [];
  for (const label of ['Pending', 'Confirmed']) {
    const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: `pl08-${label}`, display_name: label, brand_id: brand.id, owned_account_confirmed: true });
    const scheduled_at = new Date().toISOString();
    const target = await post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id, scheduled_at, schedule_tz: 'UTC' });
    await post(`/publish-targets/${target.id}/submit`, {});
    const task = (await rest('GET', '/execution-tasks')).find(row => row.publish_target_id === target.id);
    const path = `/execution-tasks/${task.id}`;
    await post(`${path}/handover`, {});
    const { attempt } = await post(`${path}/manual-start`, {});
    dev.seedNativeScheduleReceipt(task.id, attempt.id);
    targets.push({ id: target.id, path });
  }
  const [pending, confirmed] = targets;
  const pause = await post('/pause-switches', { mode: 'hold_and_unschedule', reason: 'Local crisis pause' });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzQAAAAASUVORK5CYII=', 'base64');
  const ticket = await post('/files/uploads', { purpose: 'evidence', mime_type: 'image/png', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const evidence = await post(`/files/uploads/${ticket.id}/complete`, { base64: bytes.toString('base64') });
  await post(`${confirmed.path}/reconcile`, { outcome: 'verified_absent', confirmed_no_pending_submission: true, visibility_window_elapsed: true, evidence_file_ids: [evidence.id] });

  await page.goto(`${dev.origin}/w/${wid}/calendar?${new URLSearchParams({ tab: 'pauses', id: pause.id })}`);
  await english(page);
  const withdrawals = page.getByRole('region', { name: 'Platform schedule withdrawals' });
  const targetRow = target => withdrawals.getByRole('row').filter({ has: page.locator(`a[href$="id=${target.id}"]`) });
  await expect(targetRow(pending)).toContainText('Withdrawal pending verification');
  await expect(targetRow(confirmed)).toContainText('Cancelled');
  const audit = await rest('GET', `/pause-switches/${pause.id}`);
  expect(audit.platform_withdrawals).toHaveLength(2);
  expect(audit.platform_withdrawals).toEqual(expect.arrayContaining([
    expect.objectContaining({ target_id: pending.id, plan_status: 'cancel_requested', execution_status: 'cancel_pending' }),
    expect.objectContaining({ target_id: confirmed.id, plan_status: 'cancelled', execution_status: 'cancelled' }),
  ]));
  expect(await rest('GET', '/platform-posts')).toEqual([]);
});

test('PL09 | Workbench previews evergreen expiry and reads the fresh approval after a revision', async ({ page, dev }) => {
  const wid = await diagnosticSetup(page, dev);
  const rest = (method, path, data) => planningRest(page, dev, wid, method, path, data);
  const post = (path, data) => rest('POST', path, data);
  const brand = await post('/brands', { name: 'Evergreen guides', slug: 'evergreen-guides' });
  const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: '1234', owned_account_confirmed: true, display_name: 'Evergreen page', brand_id: brand.id });
  const { item } = await post('/content-items', { brand_id: brand.id, title: 'Reusable guide' });
  const { variant } = await post(`/content-items/${item.id}/variants`, { platform: 'facebook', market: 'TW', format: 'text', body_markdown: 'First version' });
  const revisionPath = `/content-variants/${variant.id}/revisions`;
  const first = await post(revisionPath, { expected_version: variant.version, base_revision_id: null });
  const next = new Date(Date.now() + 86_400_000);
  next.setUTCHours(12, 0, 0, 0);
  const queue = await post('/evergreen-queues', { category: 'Guides', social_account_ids: [account.id], horizon_days: 14,
    slots: [{ social_account_id: account.id, weekday: next.getUTCDay() || 7, local_time: '12:00', tz: 'UTC' }] });
  const itemPath = `/evergreen-queues/${queue.id}/items`;
  await post(itemPath, { content_item_id: item.id, variant_map: { [account.id]: variant.id }, expires_at: new Date(next.valueOf() + 86_400_000).toISOString() });
  const expandPath = `/evergreen-queues/${queue.id}/expand`;
  await page.goto(`${dev.origin}/w/${wid}/calendar`);
  await english(page);
  const dialog = await planningOperation(page, 'publishing_expand_evergreen');
  await dialog.locator('[name="parameter-id"]').fill(queue.id);
  await dialog.locator('[name="payload"]').fill('{"dry_run":true}');
  await dialog.getByRole('checkbox').check();
  const pending = responseFor(page, 'POST', `/workspaces/${wid}${expandPath}`);
  await dialog.getByRole('button', { name: 'Run operation', ...exact }).click();
  const preview = (await (await checkResponse(await pending, undefined, 'Evergreen workbench preview')).json()).data;
  expect(preview).toEqual([expect.objectContaining({ at: next.toISOString(), revision_id: first.revision.id }), expect.objectContaining({ status: 'no_eligible_content' })]);
  await expect(dialog.locator('pre')).toContainText('no_eligible_content');
  await close(dialog);
  await post(expandPath, { dry_run: false });
  const planned = (await rest('GET', '/publish-targets'))[0];
  expect(planned).toMatchObject({ plan_status: 'awaiting_approval', variant_revision_id: first.revision.id });
  const edit = await post(revisionPath, { expected_version: first.variant.version, base_revision_id: first.revision.id, body_markdown: 'Updated mother copy' });
  const targetPath = `/publish-targets/${planned.id}`;
  await expect.poll(() => rest('GET', targetPath), { timeout: 15000 }).toMatchObject({
    variant_revision_id: edit.revision.id, plan_status: 'awaiting_approval', scheduled_at: planned.scheduled_at,
    approval_request_id: expect.not.stringMatching(planned.approval_request_id), frozen_hash: expect.not.stringMatching(planned.frozen_hash),
  });
});


test('EX07 | Workbench retains maintenance audit and metrics after confirmed deletion', async ({ page, dev }) => {
  const wid = await diagnosticSetup(page, dev);
  const rest = (method, path, data) => planningRest(page, dev, wid, method, path, data);
  const post = (path, data) => rest('POST', path, data);
  const brand = await post('/brands', { name: 'Execution review', slug: 'execution-review' });
  const account = await post('/social-accounts', { provider: 'youtube', external_account_id: 'local-ex07-fixture', display_name: 'Local EX07', brand_id: brand.id, owned_account_confirmed: true });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzQAAAAASUVORK5CYII=', 'base64');
  const ticket = await post('/files/uploads', { purpose: 'evidence', mime_type: 'image/png', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const evidence = await post(`/files/uploads/${ticket.id}/complete`, { base64: bytes.toString('base64') });
  const permalink = 'https://example.test/local-post';
  const publication = await post('/platform-posts/register', { social_account_id: account.id, permalink, published_at: '2025-01-01T00:00:00Z', evidence_file_ids: [evidence.id] });
  const path = `/platform-posts/${publication.id}`;
  const metricsPath = `/performance/posts/${publication.id}/history`;
  await post('/metrics/observations', { observations: [{ metric_key: 'views', subject_type: 'platform_post', subject_id: publication.id,
    period_kind: 'day', period_start: '2025-01-04T00:00:00Z', period_end: '2025-01-05T00:00:00Z', observed_at: '2025-01-05T00:00:00Z',
    value: 42, availability: 'observed', source: { method: 'import', batch_id: 'ex07-local' } }] });
  const beforeMetrics = await rest('GET', metricsPath);
  await page.goto(`${dev.origin}/w/${wid}/posts?${new URLSearchParams({ tab: 'posts', id: publication.id })}`);
  await english(page);
  await expect(page.getByRole('heading', { name: 'Publication audit', exact: false })).toBeVisible();
  await expect(page.getByRole('cell', { name: '42', ...exact })).toBeVisible();
  await page.getByRole('button', { name: 'Request post maintenance', ...exact }).click();
  let dialog = page.getByRole('dialog', { name: 'Request post maintenance', ...exact });
  await dialog.locator('[name=kind]').selectOption('edit_caption');
  await dialog.locator('[name=caption]').fill('Corrected local caption');
  await dialog.locator('[name=reason]').fill('Correct local test publication');
  await dialog.getByRole('checkbox').check();
  let editResponse = responseFor(page, 'POST', `/workspaces/${wid}${path}/operations`);
  await dialog.getByRole('button', { name: 'Save', ...exact }).click();
  const edit = (await (await checkResponse(await editResponse, undefined, 'Request caption edit')).json()).data;
  await close(dialog);
  await page.getByRole('button', { name: 'Record maintenance result', ...exact }).click();
  dialog = page.getByRole('dialog', { name: 'Record maintenance result', ...exact });
  await dialog.locator('[name=outcome]').selectOption('completed');
  await dialog.locator('[name=evidence_file_ids]').fill(evidence.id);
  await dialog.getByRole('checkbox').check();
  editResponse = responseFor(page, 'POST', `/workspaces/${wid}/post-operations/${edit.id}/manual-complete`);
  await dialog.getByRole('button', { name: 'Save', ...exact }).click();
  expect((await editResponse).status()).toBe(422);
  expect(await rest('GET', path)).toMatchObject({ post_operations: [{ id: edit.id, status: 'manual' }] });
  await dialog.locator('[name=observed_caption]').fill('Corrected local caption');
  editResponse = responseFor(page, 'POST', `/workspaces/${wid}/post-operations/${edit.id}/manual-complete`);
  await dialog.getByRole('button', { name: 'Save', ...exact }).click();
  await checkResponse(await editResponse, undefined, 'Record caption read-back');
  await close(dialog);
  expect(await rest('GET', path)).toMatchObject({ caption_snapshot: 'Corrected local caption', post_operations: [{ id: edit.id, status: 'verified' }] });

  await page.getByRole('button', { name: 'Request post maintenance', ...exact }).click();
  dialog = page.getByRole('dialog', { name: 'Request post maintenance', ...exact });
  await dialog.locator('[name=kind]').selectOption('delete');
  await dialog.locator('[name=reason]').fill('Remove local test publication');
  await dialog.getByRole('checkbox').check();
  let pending = responseFor(page, 'POST', `/workspaces/${wid}${path}/operations`);
  await dialog.getByRole('button', { name: 'Save', ...exact }).click();
  const operation = (await (await checkResponse(await pending, undefined, 'Request deletion')).json()).data;
  expect(operation).toMatchObject({ kind: 'delete', status: 'manual', action_url: permalink, before_snapshot: { post_status: 'live' } });
  await close(dialog);
  await expect(page.getByRole('link', { name: 'Open post on platform', ...exact })).toHaveAttribute('href', permalink);
  await page.getByRole('button', { name: 'Record maintenance result', ...exact }).click();
  dialog = page.getByRole('dialog', { name: 'Record maintenance result', ...exact });
  await dialog.locator('[name=outcome]').selectOption('completed');
  await dialog.locator('[name=evidence_file_ids]').fill(evidence.id);
  await dialog.getByRole('checkbox').check();
  pending = responseFor(page, 'POST', `/workspaces/${wid}/post-operations/${operation.id}/manual-complete`);
  await dialog.getByRole('button', { name: 'Save', ...exact }).click();
  await checkResponse(await pending, undefined, 'Record deletion evidence');
  await close(dialog);
  await expect(page.getByRole('heading', { name: /Publication audit.*deleted/i })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Post maintenance history' })).toContainText('Remove local test publication');
  await expect(page.getByRole('cell', { name: '42', ...exact })).toBeVisible();
  const audit = await rest('GET', path);
  expect(audit).toMatchObject({ id: publication.id, post_status: 'deleted', permalink, evidence_ids: publication.evidence_ids,
    post_operations: expect.arrayContaining([
      expect.objectContaining({ id: edit.id, status: 'verified', observed_caption: 'Corrected local caption' }),
      expect.objectContaining({ id: operation.id, status: 'verified', verification: 'manual_confirmed',
        before_snapshot: expect.objectContaining({ post_status: 'live', caption_snapshot: 'Corrected local caption' }),
        after_snapshot: expect.objectContaining({ post_status: 'deleted' }), evidence_ids: [expect.any(String)] }),
    ]) });
  expect(audit.post_operations).toHaveLength(2);
  expect(await rest('GET', metricsPath)).toEqual(beforeMetrics);
});


test('EX03 | Workbench gates an overdue publication and records the late decision', async ({ page, dev }) => {
  const wid = await diagnosticSetup(page, dev);
  const rest = (method, path, data) => planningRest(page, dev, wid, method, path, data);
  const post = (path, data) => rest('POST', path, data);
  const brand = await post('/brands', { name: 'Overdue review', slug: 'overdue-review' });
  const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: 'ex03-local', display_name: 'Local EX03', brand_id: brand.id, owned_account_confirmed: true });
  await post('/approval-policies', { name: 'Local manual test policy', mode: 'optional', conditions: { social_account_ids: [account.id] } });
  const { item } = await post('/content-items', { brand_id: brand.id, title: 'Overdue test' });
  const { variant } = await post(`/content-items/${item.id}/variants`, { platform: 'facebook', market: 'TW', format: 'text', body_markdown: 'Local test caption' });
  await post(`/content-variants/${variant.id}/revisions`, { expected_version: variant.version, base_revision_id: null });
  const target = await post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id,
    scheduled_at: new Date(Date.now() - 7_200_000).toISOString(), schedule_tz: 'Asia/Taipei', late_policy: 'notify', grace_minutes: 30 });
  expect(await post(`/publish-targets/${target.id}/submit`, {})).toMatchObject({ plan_status: 'ready' });
  const [task] = await rest('GET', '/execution-tasks');
  const path = `/execution-tasks/${task.id}`;
  const current = await rest('GET', path);
  if (current.sub_status !== 'late_awaiting_decision') {
    const { csrf_token } = await (await checkResponse(await page.request.get(`${dev.origin}/api/v1/session/csrf`), 200, 'Operations CSRF')).json();
    const check = await page.request.post(`${dev.origin}/api/v1/workspaces/${wid}${path}/run-now`, {
      data: {}, headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token },
    });
    // The background worker can complete the same precheck before this request.
    if (check.status() === 409) expect((await check.json()).error.code).toBe('INVALID_STATE');
    else await checkResponse(check, 200, 'Check overdue task');
  }
  expect(await rest('GET', path)).toMatchObject({
    status: 'blocked', sub_status: 'late_awaiting_decision', schedule_tz: 'Asia/Taipei', delay_minutes: 120,
  });
  await page.goto(`${dev.origin}/w/${wid}/execution?${new URLSearchParams({ tab: 'tasks', id: task.id })}`);
  await english(page);
  await expect(page.getByRole('button', { name: 'Resolve late task', ...exact })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hand over to manual', ...exact })).toHaveCount(0);
  await page.getByRole('button', { name: 'Resolve late task', ...exact }).click();
  const dialog = page.getByRole('dialog', { name: 'Resolve late task', ...exact });
  await dialog.locator('[name=decision]').selectOption('skip');
  await dialog.getByRole('checkbox').check();
  const pending = responseFor(page, 'POST', `/workspaces/${wid}${path}/late-decision`);
  await dialog.getByRole('button', { name: 'Save', ...exact }).click();
  await checkResponse(await pending, undefined, 'Record late decision');
  await close(dialog);
  await expect(page.getByRole('heading', { name: /Task outcome.*expired/i })).toBeVisible();
  expect(await rest('GET', path)).toMatchObject({ status: 'expired', attempts: [], schedule_tz: 'Asia/Taipei' });
  expect(await rest('GET', `/publish-targets/${target.id}`)).toMatchObject({ plan_status: 'closed', close_reason: 'expired_skipped' });
});
