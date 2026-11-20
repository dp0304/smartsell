import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

test('PC06 links a changed price to its calendar target and refuses the old approval', async ({ page, dev }) => {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'pc06@smartsell.test', name: 'Catalog owner', workspaceName: 'PC06 acceptance', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { workspaces: [workspace] } = await setup.json();
  const web = `${dev.origin}/w/${workspace.id}`;
  const root = `${dev.origin}/api/v1/workspaces/${workspace.id}`;
  const { csrf_token } = await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json();
  expect(csrf_token).toEqual(expect.any(String));
  const request = (method, path, data, version) => page.request.fetch(`${root}${path}`, {
    method, data,
    headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
      ...(version === undefined ? {} : { 'If-Match': String(version) }) },
  });
  async function operation(method, path, data, version) {
    const response = await request(method, path, data, version);
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  }
  const post = (path, data, version) => operation('POST', path, data, version);
  const get = path => operation('GET', path);
  const brand = await post('/brands', { name: 'PC06 brand', slug: 'pc06' });
  const market = await post(`/brands/${brand.id}/markets`, {
    name: 'US', country_code: 'US', primary_language: 'en', currency: 'USD', timezone: 'America/New_York',
  });
  const store = await post('/stores', {
    brand_id: brand.id, name: 'Import-only test store', provider: 'shopify', default_currency: 'USD', default_locale: 'en',
  });
  expect(store.status).toBe('import_only');
  const marketKey = { market_id: market.id, channel: 'online_store' };
  await operation('PUT', `/stores/${store.id}/markets`, { ...marketKey, price_source: 'manual' });
  const product = await post('/products', { store_id: store.id, title: 'Travel cup', status: 'active' });
  const sku = await post(`/products/${product.id}/variants`, { sku: 'CUP-PC06' });
  const observePrice = price_amount_minor => post(`/variants/${sku.id}/listings`, { ...marketKey, price_amount_minor, currency: 'USD' });
  const before = await observePrice(1000);
  const otherChannel = { ...marketKey, channel: 'marketplace' };
  await operation('PUT', `/stores/${store.id}/markets`, { ...otherChannel, price_source: 'manual' });
  const unchanged = await post(`/variants/${sku.id}/listings`, { ...otherChannel, price_amount_minor: 1000, currency: 'USD' });
  const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: 'pc06-local',
    display_name: 'Local manual publishing', brand_id: brand.id, owned_account_confirmed: true });
  const scheduled_at = new Date(Date.now() + 8 * 86_400_000).toISOString();
  async function approveTarget(title, listing_snapshot_id) {
    const { variants: [variant] } = await post('/content-items/draft', {
      brand_id: brand.id, title, variants: [{ platform: 'facebook', format: 'text', locale: 'en', body: 'Travel cup costs $10.00',
        product_refs: [{ variant_id: sku.id, listing_snapshot_id, market_id: market.id, currency: 'USD', field: 'price', inserted_text: '$10.00' }],
      }],
    });
    const target = await post('/publish-targets', {
      social_account_id: account.id, content_variant_id: variant.id, variant_revision_id: variant.current_revision_id, scheduled_at, schedule_tz: 'UTC',
    });
    const targetPath = `/publish-targets/${target.id}`;
    const submitted = await post(`${targetPath}/submit`, {}, target.version);
    expect(submitted.plan_status).toBe('awaiting_approval');
    const approval = { approval_request_id: submitted.approval_request_id, resource_hash: submitted.frozen_hash };
    expect((await post(`${targetPath}/approve`, approval, submitted.version)).plan_status).toBe('ready');
    return { target, targetPath, approval };
  }
  const title = 'Travel cup price campaign';
  const controlTitle = 'Travel cup marketplace campaign';
  const { target, targetPath, approval } = await approveTarget(title, before.id);
  const control = await approveTarget(controlTitle, unchanged.id);
  const approved = await get(targetPath);
  expect(approved.approval).toMatchObject({ id: approval.approval_request_id, status: 'approved', resource_hash: approval.resource_hash });
  expect(approved.execution).toMatchObject({ status: 'scheduled', frozen_hash: approval.resource_hash });
  expect(await get('/change-events')).toEqual([]);

  const after = await observePrice(1200);
  expect(after.id).not.toBe(before.id);
  const precheck = { check_key: 'product_fact', severity: 'blocker', detail: { old_snapshot_id: before.id, snapshot_id: after.id } };
  await expect.poll(() => get(targetPath), { timeout: 15_000 }).toMatchObject({
    id: target.id, variant_revision_id: target.variant_revision_id, plan_status: 'awaiting_approval', frozen_hash: null,
    approval_invalidated_reason: 'product_price_claim_changed',
    approval: { id: approval.approval_request_id, status: 'invalidated' },
    precheck: { overall: 'blocked', items: expect.arrayContaining([expect.objectContaining(precheck)]) },
    execution: { id: approved.execution.id, status: 'blocked', status_reason: 'approval_invalid' },
  });
  const [change] = await get('/change-events');
  expect(change).toMatchObject({
    change_type: 'price_changed', snapshot_id: after.id, product_id: product.id, variant_id: sku.id, ...marketKey,
    before: { price_amount_minor: 1000, currency: 'USD' }, after: { price_amount_minor: 1200, currency: 'USD' },
    affected_target_count: 1, affected_targets: [{ id: target.id, title, scheduled_at: target.scheduled_at }],
  });

  expect(await get(control.targetPath)).toMatchObject({ plan_status: 'ready', approval: { status: 'approved' } });

  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(`${web}/commerce/changes`);
  const row = page.getByRole('row').filter({ hasText: 'CUP-PC06' });
  await expect(row).toBeVisible({ timeout: 12_000 });
  await expect(row.getByText(/USD\s+10\.00 → USD\s+12\.00/)).toBeVisible();
  await expect(row.getByRole('link', { name: controlTitle, exact: true })).toHaveCount(0);
  const affected = row.getByRole('link', { name: title, exact: true });
  await expect(affected).toHaveAttribute('href', new RegExp(`/calendar\\?id=${target.id}&date=`));
  await affected.click();
  await expect(page).toHaveURL(new RegExp(`/calendar\\?id=${target.id}&date=`));
  const marker = page.locator('.calendar-grid').getByRole('button', { name: new RegExp(`^Scheduled · .*${title}$`) });
  await expect(marker).toBeVisible();
  const warning = 'Price changed. Approval invalidated.';
  await expect(marker.locator('..').getByText(warning)).toBeVisible();
  const controlMarker = page.locator('.calendar-grid').getByRole('button', { name: new RegExp(`^Scheduled · .*${controlTitle}$`) });
  await expect(controlMarker).toBeVisible();
  await expect(controlMarker.locator('..').getByText(warning)).toHaveCount(0);
  await expect(page.getByText('Product price changed after revision', { exact: true })).toBeVisible();
  await expect(page.locator('.record-detail').getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await marker.click();
  expect(new URL(page.url()).searchParams.get('date')).toBeTruthy();
  await page.reload();
  await expect(marker.locator('..').getByText(warning)).toBeVisible();

  const invalidated = await get(targetPath);
  const refused = await request('POST', `${targetPath}/approve`, approval, invalidated.version);
  expect(refused.status(), await refused.text()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'INVALID_STATE', detail: 'Resubmit the target to obtain a pending request' });
  const taskPath = `/execution-tasks/${approved.execution.id}`;
  const execution = await post(`${taskPath}/run-now`, {}, invalidated.execution.version);
  expect(execution).toMatchObject({ status: 'blocked', status_reason: 'approval_invalid' });
  expect(await get(taskPath)).toMatchObject({ attempts: [], pending_side_effects: [], platform_post: null });
  expect(await get('/platform-posts')).toEqual([]);
});
