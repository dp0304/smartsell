import { expect, test as baseTest } from '@playwright/test';
import { localDev } from '../../../tests/web-e2e/local-dev.mjs';

const test = baseTest.extend({ dev: localDev });
// Tools and the compatibility workbench are developer surfaces.
test.beforeEach(async ({ context }) => { await context.addInitScript(() => localStorage.setItem('smartsell.developer', '1')); });

test('default workspace shows provider status and runs permitted commands with recoverable errors', async ({ page, dev }) => {
  const email = 'default-tools@example.test';
  const password = dev.password();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${dev.origin}/setup`);
  await page.getByLabel('介面語言').selectOption('en');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Workspace name').fill('Tools QA');
  await page.locator('[name=setupToken]').fill(dev.setupToken);
  await page.getByRole('button', { name: 'First-time setup' }).click();
  // Setup lands on the dashboard; the command tools live in the advanced workbench.
  await expect(page).toHaveURL(/\/app\/[^/]+$/);
  const workspaceId = new URL(page.url()).pathname.split('/')[2];
  const workspacePath = `/w/${workspaceId}`;
  const workspaceApi = `${dev.origin}/api/v1/workspaces/${workspaceId}`;
  await page.goto(`${dev.origin}${workspacePath}/home`);
  await expect(page.getByRole('heading', { name: 'Today’s operations' })).toBeVisible();
  await page.getByRole('link', { name: 'Workspace status', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workspace status' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Publishing schedule.*Available/ })).toBeVisible();
  if (process.env.SMARTSELL_TEST_SCREENSHOT) await page.screenshot({ path: process.env.SMARTSELL_TEST_SCREENSHOT });

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Tools' });
  const action = drawer.getByRole('combobox', { name: 'Action', exact: true });
  await action.selectOption('workspace.create_brand');
  await drawer.locator('[name=name]').fill('Command Workshop');
  await drawer.locator('[name=slug]').fill('command-workshop');
  const executeUrl = `${workspaceApi}/commands/workspace/create_brand`;
  // Lose the first response after allowing the real write to complete.
  await page.route(executeUrl, async route => {
    await route.fetch();
    await route.abort('failed');
  }, { times: 1 });
  const firstRequest = page.waitForRequest(request => request.url() === executeUrl);
  await drawer.getByRole('button', { name: 'Run command' }).click();
  const first = await firstRequest;
  await expect(drawer.getByRole('alert')).toBeVisible();
  const replayRequest = page.waitForRequest(request => request.url() === executeUrl);
  await drawer.getByRole('button', { name: 'Retry same request' }).click();
  expect((await replayRequest).headers()['idempotency-key']).toBe(first.headers()['idempotency-key']);
  await expect(drawer.getByText('The server accepted the command.')).toBeVisible();
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();

  const response = await page.request.get(`${workspaceApi}/records/workspace/brand`);
  expect(response.ok()).toBe(true);
  expect((await response.json()).items.filter(row => row.data.slug === 'command-workshop')).toHaveLength(1);
  await page.getByRole('button', { name: 'Search command records' }).click();
  const search = page.getByRole('dialog', { name: 'Search workspace' });
  await search.getByRole('searchbox').fill('Command Workshop');
  await search.getByRole('button', { name: 'Search', exact: true }).click();
  await search.getByRole('link', { name: 'Command Workshop', exact: true }).click();
  const brand = page.getByRole('dialog', { name: 'Command Workshop', exact: true });
  await expect(brand.getByText('command-workshop', { exact: true })).toBeVisible();
  await brand.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Command API records')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Access control' }).click();
  const currentRole = page.getByRole('region', { name: 'Your current role', exact: true });
  await expect(currentRole.getByRole('heading', { name: 'Your current role', exact: true })).toBeVisible();
  await expect(currentRole.getByText('Owner', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(`${dev.origin}/login`);
  await dev.switchIdentity({ email, name: 'Viewer', role: 'viewer' });
  await page.goto(`${dev.origin}${workspacePath}/calendar`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${dev.origin}${workspacePath}/calendar`);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(drawer.getByRole('combobox', { name: 'Action', exact: true })).toBeVisible();
  await expect(drawer.locator('option[value="workspace.create_brand"]')).toHaveCount(0);
});
