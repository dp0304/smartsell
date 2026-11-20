import { randomUUID } from 'node:crypto';
import { expect, test as baseTest } from '@playwright/test';
import { localDev } from '../../../tests/web-e2e/local-dev.mjs';

const test = baseTest.extend({ dev: localDev });
test.setTimeout(25_000);
test.use({ launchOptions: { executablePath: process.env.SMARTSELL_TEST_CHROME } });

test('initial setup, workspace operations, CSV commit and session lifecycle', async ({ page, dev: { origin: base, setupToken } }) => {
  const email = 'workbench-test@example.test';
  const password = 'workbench-test-password';
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(base);
  await page.getByRole('link', { name: /相容版工作台|Compatibility workbench/ }).click();
  await expect(page.getByRole('heading', { name: '登入' })).toBeVisible();
  await page.getByLabel('介面語言').selectOption('en');
  await page.getByRole('link', { name: 'First time? Set up a workspace' }).click();
  await page.getByLabel('Your name').fill('Workbench Operator');
  await page.getByLabel('Workspace name').fill('Workbench QA');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel(/Setup token/).fill(setupToken);
  await page.getByRole('button', { name: 'Set up SmartSell' }).click();
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await page.getByRole('button', { name: 'Workspace status' }).click();
  await expect(page.getByRole('heading', { name: 'Workspace status' })).toBeVisible();
  await page.getByRole('link', { name: 'Workspace settings' }).click();
  await page.getByRole('button', { name: 'Create brand' }).click();
  await page.locator('input[name=name]').fill('Test Brand');
  await page.getByLabel('Brand slug').fill('test-brand');
  await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByText('The server accepted the command.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test Brand', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Search workspace' }).click();
  await page.getByRole('searchbox', { name: 'Search workspace' }).fill('Test Brand');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Test Brand' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
  await page.getByRole('button', { name: 'Create campaign draft' }).click();
  await page.locator('select[name=brand_id]').selectOption({ label: 'Test Brand' });
  await page.locator('input[name=name]').fill('Test Launch');
  await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByText('The server accepted the command.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test Launch', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Content studio' }).click();
  await page.getByRole('button', { name: 'Create content', exact: true }).click();
  await page.locator('select[name=brand_id]').selectOption({ label: 'Test Brand' });
  await page.locator('input[name=title]').fill('Test Story');
  await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByText('The server accepted the command.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test Story', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Access control' }).click();
  const currentRole = page.getByRole('region', { name: 'Your current role', exact: true });
  await expect(currentRole.getByRole('heading', { name: 'Your current role', exact: true })).toBeVisible();
  await expect(currentRole.getByText('Owner', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Products & markets' }).click();
  await page.getByRole('button', { name: 'Store', exact: true }).click();
  await page.getByRole('button', { name: 'Create import store' }).click();
  await page.locator('input[name=name]').fill('QA Store');
  await page.getByLabel('Default currency').fill('TWD');
  await page.getByLabel('Default locale').fill('zh-Hant');
  await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByText('The server accepted the command.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Import batch', exact: true }).click();
  await page.getByRole('button', { name: 'Preview CSV import' }).click();
  await page.locator('select[name=store_id]').selectOption({ label: 'QA Store' });
  await page.locator('select[name=template_key]').selectOption('product_list');
  await page.locator('textarea[name=csv]').fill('external_product_id,external_variant_id,title,sku,price_amount_minor,currency\nP01,V01,QA Product,QA-SKU,500,TWD');
  await page.getByRole('button', { name: 'Run command' }).click();
  await page.getByRole('button', { name: 'Commit import', exact: true }).click();
  await page.getByRole('button', { name: 'Run command' }).click();
  await page.getByRole('button', { name: 'Confirm operation' }).click();
  await expect(page.getByText('The server accepted the command.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Product', exact: true }).click();
  await expect(page.getByRole('button', { name: 'QA Product', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Inbox', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.getByText(/No conversations/)).toBeVisible();
  const workspace = new URL(page.url()).pathname.split('/w/')[1].split('/')[0];
  const apiPath = `${base}/api/v1/workspaces/${workspace}`;
  const command = async (module, action, data) => {
    const response = await page.request.post(`${apiPath}/commands/${module}/${action}`, {
      headers: { Origin: new URL(base).origin, 'Idempotency-Key': randomUUID() }, data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  };
  const brandResult = await page.request.get(`${apiPath}/records/workspace/brand`);
  const brand = (await brandResult.json()).items.find(row => row.data.name === 'Test Brand');
  const account = await command('account', 'register_account', {
    brand_id: brand.id, name: 'Browser Test Channel', provider: 'youtube',
    external_account_id: 'browser-test-channel', default_timezone: 'Asia/Taipei', owned_account_confirmed: true,
  });
  const { conversation } = await command('inbox', 'ingest_message', {
    social_account_id: account.id, brand_id: brand.id, provider: 'youtube', kind: 'comment_thread',
    external_message_id: 'browser-test-message', platform_created_at: new Date().toISOString(), body_text: 'Is this product available?',
  });
  await page.reload();
  await page.getByRole('button', { name: new RegExp(conversation.id) }).click();
  await expect(page.getByText('Is this product available?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await page.getByLabel('Note text').fill('Check inventory before replying.');
  await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByText('The server accepted the command.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Check inventory before replying.', { exact: true })).toBeVisible();

  const period = { from: '2026-10-01', to: '2026-10-03', tz: 'UTC' };
  await command('analytics', 'reports_create', {
    title: 'Browser test report', kind: 'social_performance', period,
    sections: [{ key: 'views', type: 'table', query: { metrics: ['views'], subject: { type: 'platform_post' }, time: { ...period, basis: 'period' } } }],
  });
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page.getByRole('button', { name: 'Browser test report', exact: true }).click();
  await page.getByRole('button', { name: 'Generate report version' }).click();
  await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByText('The server accepted the command.')).toBeVisible();
  await page.getByRole('dialog', { name: 'Tools', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Version 1', exact: true }).click();
  await page.getByRole('button', { name: 'Finalize report version' }).click();
  await page.getByRole('button', { name: 'Run command' }).click();
  await page.getByRole('button', { name: 'Confirm operation' }).click();
  await expect(page.getByText('The server accepted the command.')).toBeVisible();
  await page.getByRole('dialog', { name: 'Tools', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Export report version' }).click();
  await page.locator('select[name=format]').selectOption('csv');
  await page.getByRole('button', { name: 'Run command' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download file' }).click()]);
  expect(download.suggestedFilename()).toBe('report-v1.csv');
  await page.getByRole('dialog', { name: 'Tools', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('dialog', { name: 'Browser test report', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'Publishing calendar' }).click();
  await page.getByRole('combobox', { name: 'Publishing calendar' }).selectOption('month');
  await page.getByRole('link', { name: 'Approvals', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByText(/1280 px/)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(`${base}/compat/workbench/login`);
  expect((await page.request.get(`${base}/api/v1/session`)).status()).toBe(401);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  if (process.env.SMARTSELL_TEST_SCREENSHOT) await page.screenshot({ path: process.env.SMARTSELL_TEST_SCREENSHOT });
});
