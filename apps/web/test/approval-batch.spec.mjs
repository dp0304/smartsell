import { randomUUID } from 'node:crypto';
import { expect, test as baseTest } from '@playwright/test';
import { localDev } from '../../../tests/web-e2e/local-dev.mjs';

const test = baseTest.extend({ dev: localDev });

test('batch approval previews live versions and publishes the decision only after confirmation', async ({ page, dev }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'batch@example.test', password: dev.password(), name: 'Approver', workspaceName: 'Batch QA' },
  });
  expect(setup.ok(), await setup.text()).toBe(true);
  const { workspaces: [{ id: ws }] } = await setup.json();
  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  const { csrf_token } = await csrf.json();
  const root = `${dev.origin}/api/v1/workspaces/${ws}`;
  async function post(path, data, version) {
    const response = await page.request.post(`${root}${path}`, { headers: {
      Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(), ...(version && { 'If-Match': `"${version}"` }),
    }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  }
  async function get(path) {
    const response = await page.request.get(`${root}${path}`);
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  }
  const brand = await post('/brands', { name: 'Batch Brand', slug: 'batch-brand' });
  const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: 'batch-account',
    display_name: 'Batch account', brand_id: brand.id, owned_account_confirmed: true });
  const { item } = await post('/content-items', { brand_id: brand.id, title: 'Batch content' });
  const { variant } = await post(`/content-items/${item.id}/variants`, { platform: 'facebook', market: 'TW', format: 'text', body_markdown: 'Review approval batch' });
  await post(`/content-variants/${variant.id}/revisions`, { expected_version: variant.version, base_revision_id: null });
  const scheduled_at = new Date(Date.now() + 86_400_000).toISOString();
  const target = await post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id, scheduled_at });
  const path = `/publish-targets/${target.id}`;
  const submitted = await post(`${path}/submit`, {}, target.version);
  const approval = (await get('/approvals')).find(row => row.id === submitted.approval_request_id);
  expect(approval).toBeTruthy();

  await page.goto(`${dev.origin}/w/${ws}/content/board`);
  await expect(page.getByRole('region', { name: 'Production board' }).getByRole('button', { name: 'Batch content' })).toBeVisible();
  await page.goto(`${dev.origin}/w/${ws}/approvals`);
  await page.getByRole('checkbox', { name: approval.title ?? approval.id, exact: true }).check();
  await page.getByRole('button', { name: /Preview batch approval/ }).click();
  const preview = page.getByRole('dialog', { name: 'Preview batch approval' });
  const confirm = preview.getByRole('button', { name: 'Confirm approval of 1' });
  await expect(confirm).toBeEnabled();
  expect((await get(path)).plan_status).toBe('awaiting_approval');
  const decision = page.waitForResponse(response => response.url() === `${root}/approvals/batch` && response.request().method() === 'POST');
  await confirm.click();
  const applied = await decision;
  expect(applied.ok(), await applied.text()).toBe(true);
  expect(applied.request().postDataJSON().items[0]).toMatchObject({ target_id: target.id, expected_version: submitted.version, approval_request_id: approval.id });
  await expect(preview.getByText('Batch approval results')).toBeVisible();
  await expect(preview.getByText('Ready', { exact: true })).toBeVisible();
  expect((await get(path)).plan_status).toBe('ready');
});
