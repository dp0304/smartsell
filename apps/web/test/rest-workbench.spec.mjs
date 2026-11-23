import { randomUUID } from 'node:crypto';
import { expect, test as baseTest } from '@playwright/test';
import { localDev } from '../../../tests/web-e2e/local-dev.mjs';

const test = baseTest.extend({ dev: localDev });

test('default workbench performs real versioned writes and renders all module entries at 1280px', async ({ page, dev: { origin, setupToken } }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const email = 'workbench-owner@example.test';
  const password = randomUUID();

  await page.goto(`${origin}/setup`);
  await page.locator('[name=email]').fill(email);
  await page.locator('[name=password]').fill(password);
  await page.locator('[autocomplete=organization]').fill('Workbench QA');
  await page.locator('[name=setupToken]').fill(setupToken);
  const setupResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/v1/setup'));
  await page.getByRole('button', { name: '首次設定', exact: true }).click();
  const setup = await setupResponse;
  expect(setup.request().postDataJSON().workspaceName).toBe('Workbench QA');
  expect(setup.status()).toBe(201);
  const { data: { workspaces: [{ id: wid }] } } = await setup.json();
  const dashboard = `/app/${wid}`;
  // Explicit deployment setup also enters the guide for an empty workspace. Leave it
  // undismissed while exercising the advanced workbench through its direct route.
  await expect(page.getByRole('heading', { name: '開始設定', exact: true })).toBeVisible();
  await expect(page).toHaveURL(url => url.pathname === `${dashboard}/get-started`);
  await page.goto(`${origin}/w/${wid}/home`);
  await expect(page.getByRole('heading', { name: '今日營運' })).toBeVisible();
  await page.getByLabel('介面語言').selectOption('en');
  await expect(page.getByText('No items need attention')).toBeVisible();

  const directory = page.getByRole('navigation', { name: 'Module directory' });
  // Settings modules sit in a folded section; open it to list every module entry.
  const settings = directory.getByRole('button', { name: 'Settings', exact: true });
  if (await settings.getAttribute('aria-expanded') === 'false') await settings.click();
  const links = await directory.locator('a:not([href$="/security"]):not([href$="/access"])').evaluateAll(anchors => anchors.map(anchor => anchor.getAttribute('href')));
  // Overview, 19 modules and the My approvals shortcut.
  expect(links).toHaveLength(21);
  await directory.getByRole('link', { name: 'Brands & workspace' }).click();
  await page.getByRole('button', { name: 'Create brand', exact: true }).first().click();
  const form = page.getByRole('dialog');
  await form.locator('[name=name]').fill('QA Studio');
  await form.locator('[name=slug]').fill('qa-studio');
  const createResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/brands'));
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const created = await createResponse;
  expect(created.ok(), await created.text()).toBeTruthy();
  expect(created.request().headers()['x-csrf-token']).toBeTruthy();
  expect(created.request().headers()['idempotency-key']).toBeTruthy();
  await form.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'QA Studio', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await form.locator('[name=name]').fill('QA Studio Updated');
  const updateResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/brands\/[^/]+$/.test(response.url()));
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const updated = await updateResponse;
  expect(updated.ok(), await updated.text()).toBeTruthy();
  expect(updated.request().headers()['if-match']).toMatch(/^"\d+"$/);
  await form.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'QA Studio Updated', exact: true })).toBeVisible();

  const workspace = new URL(page.url()).pathname.split('/').slice(0, 3).join('/');
  for (const path of [...links, ...['approvals', 'execution/manual', 'home/summary', 'me'].map(section => `${workspace}/${section}`)]) {
    await page.goto(new URL(path, origin).href);
    await expect(page.locator('main h1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBe(1280);
  }
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.getByText(/Use a desktop browser at 1280px/)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Username or email').fill(email);
  await page.locator('[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Get started', exact: true })).toBeVisible();
  await expect(page).toHaveURL(url => url.pathname === `${dashboard}/get-started`);
  const agentStep = main.getByRole('region', { name: 'Main agent', exact: true });
  await expect(agentStep.getByText('Step 1 of 2', { exact: true })).toBeVisible();
  await main.getByRole('link', { name: 'Finish later and go to overview', exact: true }).click();
  await expect(main.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page).toHaveURL(origin + dashboard);
});
