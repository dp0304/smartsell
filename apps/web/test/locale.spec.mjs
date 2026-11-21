import { expect, test as baseTest } from '@playwright/test';
import { localDev } from '../../../tests/web-e2e/local-dev.mjs';

const test = baseTest.extend({ dev: localDev });
test.use({ locale: 'zh-CN' });

test('Simplified Chinese follows browser settings and switches across workspace entries', async ({ page, context, dev }) => {
  await page.goto(`${dev.origin}/login`);
  const root = page.locator('html');
  await expect(root).toHaveAttribute('lang', 'zh-Hans');
  await expect(page.getByRole('heading', { name: '注册', exact: true })).toBeVisible();
  const picker = page.getByRole('combobox', { name: '界面语言', exact: true });
  await expect(picker).toHaveValue('zh-Hans');

  const workbench = await context.newPage();
  await workbench.goto(`${dev.origin}/compat/workbench/login`);
  await expect(workbench.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await workbench.getByRole('combobox', { name: '界面语言', exact: true }).selectOption('en');
  await expect(root).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Register', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Interface language', exact: true })).toHaveValue('en');

  await page.getByRole('combobox', { name: 'Interface language', exact: true }).selectOption('zh-Hans');
  await expect(workbench.getByRole('combobox', { name: '界面语言', exact: true })).toHaveValue('zh-Hans');
  await expect(workbench.getByRole('heading', { name: '注册', exact: true })).toBeVisible();
  await workbench.reload();
  await expect(workbench.locator('html')).toHaveAttribute('lang', 'zh-Hans');
});

test('Simplified Chinese localizes sign-in errors and the dashboard, not workspace names', async ({ page, context, dev }) => {
  const name = '繁體商舖 · SKU_燕麥01';
  const email = 'locale-owner@example.test';
  const password = dev.password();
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { name: 'Locale QA', email, workspaceName: name, password },
  });
  expect(setup.status()).toBe(201);
  await context.clearCookies();

  await page.goto(`${dev.origin}/login`);
  await page.getByLabel('用户名或电子邮箱').fill(email);
  const field = page.getByLabel('密码', { exact: true });
  await field.fill('incorrect-password');
  const submit = page.getByRole('button', { name: '登录', exact: true });
  await submit.click();
  await expect(page.getByRole('alert')).toHaveText('用户名、电子邮箱或密码不正确。');
  await field.fill(password);
  await submit.click();
  await page.getByRole('link', { name: '稍后设置，前往总览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('zh-Hant');
  await expect(page.getByRole('heading', { name: '總覽', exact: true })).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
});
