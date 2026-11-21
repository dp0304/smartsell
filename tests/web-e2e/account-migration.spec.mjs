import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

function seedMetadata(dev, workspaceId, rows) {
  dev.updateSnapshot(state => {
    expect(state.scope.workspaceId).toBe(workspaceId);
    const now = new Date().toISOString();
    const metadata = { version: 1, created_at: now, updated_at: now };
    for (const [rowKind, row] of rows) {
      const module = 'operation_runtime';
      const kind = 'record';
      const id = `row/${rowKind}/${row.id}`;
      state.records.push([JSON.stringify([module, kind, id]), {
        id, module, kind, workspace_id: workspaceId, tenant_id: state.scope.tenantId, ...metadata,
        data: { value: JSON.stringify({ ...metadata, ...row }) },
      }]);
    }
  });
}

async function recoveryFixture(page, dev, request) {
  const password = dev.password();
  const email = 'recovery-admin@example.invalid';
  const bootstrap = await request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'recovery-owner@example.invalid', name: 'Recovery owner', workspaceName: 'Recovery fixture', password },
  });
  expect(bootstrap.status()).toBe(201);
  const { data: { workspaces: [workspace] } } = await bootstrap.json();
  // The local store supports one identity. Provision an admin and sign in through the browser.
  dev.switchIdentity({ email, name: 'Recovery administrator', role: 'admin' });

  await page.goto(`${dev.origin}/`);
  // The launcher can serve HTML before Vite finishes loading the application.
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible({ timeout: 35_000 });
  await page.getByRole('textbox', { name: '使用者名稱或電子郵件', exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill(password);
  const login = await clickForResponse(page, page.getByRole('button', { name: '登入', exact: true }), 'POST', `${dev.origin}/api/v1/session`);
  expect(login.status()).toBe(200);
  // Sign-in lands on the dashboard; account recovery lives in the advanced workbench.
  await expect(page).toHaveURL(`${dev.origin}/app/${workspace.id}`);
  await expect(page.getByRole('heading', { name: '總覽', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  const home = `/w/${workspace.id}/home`;
  const advanced = page.getByRole('link', { name: '進階工作台', exact: true });
  await expect(advanced).toHaveAttribute('href', home);
  await advanced.click();
  await expect(page).toHaveURL(dev.origin + home);
  await expect(page.getByRole('heading', { name: '今日營運', exact: true })).toBeVisible();
  const securityPath = `/w/${workspace.id}/settings/security`;
  // Account security sits in the folded settings section of the sidebar.
  await page.getByRole('navigation', { name: '模組目錄' }).getByRole('button', { name: '設定與管理', exact: true }).click();
  const localizedSecurity = page.getByRole('navigation', { name: '模組目錄' }).getByRole('link', { name: '帳號安全', exact: true });
  await expect(localizedSecurity).toBeVisible();
  await expect(localizedSecurity).toHaveAttribute('href', securityPath);
  await page.getByRole('combobox', { name: '介面語言', exact: true }).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Today’s operations', exact: true })).toBeVisible();

  const session = await page.request.get(`${dev.origin}/api/v1/session`);
  expect(session.status()).toBe(200);
  const { data: { user, workspaces } } = await session.json();
  expect(workspaces.find(item => item.id === workspace.id)?.role).toBe('admin');
  const root = `${dev.origin}/api/v1/workspaces/${workspace.id}`;
  const csrfResponse = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  expect(csrfResponse.status()).toBe(200);
  const { csrf_token } = await csrfResponse.json();
  expect(Boolean(csrf_token)).toBe(true);
  async function call(method, path, data) {
    const reply = await page.request.fetch(root + path, { method, data, headers: {
      Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
    } });
    expect(reply.ok(), await reply.text()).toBe(true);
    return (await reply.json()).data;
  }

  const brand = await call('POST', '/brands', { name: 'Recovery fixture', slug: 'recovery-fixture' });
  const account = await call('POST', '/social-accounts', {
    provider: 'xiaohongshu', external_account_id: `fixture-${randomUUID()}`, display_name: 'Fixture social account',
    brand_id: brand.id, owned_account_confirmed: true,
  });
  const device = name => ({ id: randomUUID(), name, platform: 'darwin', status: 'active', owner_id: user.id, last_seen_at: new Date().toISOString() });
  const source = device('Fixture source desktop');
  const target = device('Fixture destination desktop');
  const phone = { id: randomUUID(), device_id: source.id, platform: 'android', model: 'Fixture Android', serial_suffix: 'E2E1', status: 'ready' };
  const retained = { id: randomUUID(), social_account_id: account.id, status: 'outcome_unknown' };
  // Local dev has no signed device ingress. Supply only the local metadata needed by the real account operations.
  seedMetadata(dev, workspace.id, [
    ['connector_device', source], ['connector_device', target], ['mobile_device', phone], ['execution_task', retained],
  ]);
  const bindingPath = `/social-accounts/${account.id}/execution-binding`;
  const { binding } = await call('PUT', bindingPath, {
    mode: 'connector', connector_channel: 'browser', device_id: source.id, owned_account_confirmed: true,
  });
  const app = await call('POST', `/mobile-devices/${phone.id}/app-bindings`, {
    social_account_id: account.id, app: 'xhs', owned_account_confirmed: true,
  });

  const security = page.getByRole('navigation', { name: 'Module directory' }).getByRole('link', { name: 'Account security', exact: true });
  await expect(security).toHaveAttribute('href', securityPath);
  await security.click();
  await expect(page).toHaveURL(dev.origin + securityPath);
  const recovery = page.getByRole('region', { name: 'Workspace execution and device recovery' });
  await expect(recovery).toBeVisible();
  return { account, source, target, phone, app, retained, binding, migrationPath: `${bindingPath}/migration`, root, call, recovery };
}

async function clickForResponse(page, button, method, url) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === url && response.request().method() === method),
    button.click(),
  ]);
  return response;
}

test('Account Recovery previews a migration and refuses completion without destination identity', async ({ page, dev, request }) => {
  const { account, source, target, retained, binding, root, migrationPath, call, recovery } = await recoveryFixture(page, dev, request);
  const migration = recovery.getByRole('region', { name: 'Execution location migration' });
  const accountSelect = migration.getByRole('combobox', { name: 'Social account', exact: true });
  await accountSelect.selectOption({ label: `${account.display_name} · xiaohongshu` });

  const preview = await clickForResponse(page, migration.getByRole('button', { name: 'Preview impact' }), 'GET', `${root}${migrationPath}/preview`);
  expect(preview.status(), await preview.text()).toBe(200);
  expect((await preview.json()).data).toMatchObject({
    binding_id: binding.id, queued: [], draining: [], retained: [{ id: retained.id, status: 'outcome_unknown' }],
  });
  await expect(migration.getByRole('heading', { name: 'Queued tasks (0)' })).toBeVisible();
  await expect(migration.getByRole('heading', { name: 'In-flight tasks (0)' })).toBeVisible();
  await expect(migration.getByRole('heading', { name: 'Retained for reconciliation (1)' })).toBeVisible();
  await expect(migration.getByRole('listitem').filter({ hasText: retained.id })).toContainText('Outcome unknown');

  await expect(migration.getByLabel('Destination channel').locator('option:checked')).toHaveText('Desktop browser');
  await migration.getByLabel('Connector device').selectOption({ label: target.name });
  const start = migration.getByRole('button', { name: 'Start migration' });
  await expect(start).toBeDisabled();
  await migration.getByRole('checkbox', { name: /I reviewed the impact and confirm/ }).check();
  const started = await clickForResponse(page, start, 'POST', root + migrationPath);
  expect(started.ok(), await started.text()).toBe(true);
  const { data: { migration: state } } = await started.json();
  expect(state).toMatchObject({
    status: 'draining', source_device_id: source.id, target_device_id: target.id,
    source_connector_channel: 'browser', target_connector_channel: 'browser', target_session_id: expect.any(String),
  });
  await expect(migration.getByRole('status')).toHaveText('Migration in progress');
  await expect(migration.getByText(`Source · Desktop browser · ${source.name}`, { exact: true })).toBeVisible();
  await expect(migration.getByText(`Destination · Desktop browser · ${target.name}`, { exact: true })).toBeVisible();
  await expect(migration.getByText(`Destination verification record · ${state.target_session_id}`, { exact: true })).toBeVisible();

  const refused = await clickForResponse(page, migration.getByRole('button', { name: 'Complete migration' }), 'POST', `${root}${migrationPath}/complete`);
  expect(refused.status(), await refused.text()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'FRESH_IDENTITY_CHECK_REQUIRED' });
  await expect(migration.getByRole('alert')).toContainText('FRESH_IDENTITY_CHECK_REQUIRED');
  await expect(migration.getByRole('status')).toHaveText('Migration in progress');
  expect(await call('GET', migrationPath)).toMatchObject({
    migration: { id: state.id, status: 'draining', source_device_id: source.id, target_device_id: target.id },
    impact: { binding_id: binding.id, retained: [{ id: retained.id, status: 'outcome_unknown' }] },
  });
});

test('Account Recovery previews and confirms mobile unbinding and device revocation', async ({ page, dev, request }) => {
  const { account, source, target, phone, app, call, recovery } = await recoveryFixture(page, dev, request);
  const unbind = recovery.getByRole('region', { name: 'Unbind mobile app' });
  const appSelect = unbind.getByLabel('Mobile app binding');
  await appSelect.selectOption({ label: `xhs · ${phone.model} · ${phone.serial_suffix} · ${account.display_name}` });
  await unbind.getByRole('button', { name: 'Preview impact' }).click();
  await expect(unbind.getByRole('listitem').filter({ hasText: account.id })).toBeVisible();
  const unbindButton = unbind.getByRole('button', { name: 'Unbind mobile app' });
  await expect(unbindButton).toBeDisabled();
  await unbind.getByRole('checkbox', { name: 'I have reviewed this operation and its effects' }).check();
  await unbindButton.click();
  await expect(unbind.getByRole('status')).toHaveText('Mobile app unbound.');
  await expect(unbind.getByText(/revoke its USB or LAN debugging authorization/)).toBeVisible();
  await expect(appSelect.getByRole('option', { name: /Fixture Android/ })).toHaveCount(0);
  expect(await call('GET', '/mobile-app-bindings')).toContainEqual(expect.objectContaining({ id: app.id, status: 'revoked' }));

  const revoke = recovery.getByRole('region', { name: 'Revoke device' });
  const deviceSelect = revoke.getByLabel('Connector device');
  await deviceSelect.selectOption({ label: source.name });
  await revoke.getByRole('button', { name: 'Preview impact' }).click();
  await expect(revoke.getByRole('listitem').filter({ hasText: account.id })).toBeVisible();
  const revokeButton = revoke.getByRole('button', { name: 'Revoke device' });
  await expect(revokeButton).toBeDisabled();
  await revoke.getByRole('checkbox', { name: 'I have reviewed this operation and its effects' }).check();
  await revokeButton.click();
  await expect(revoke.getByRole('status')).toHaveText('Device revoked.');
  await expect(deviceSelect.getByRole('option', { name: source.name })).toHaveCount(0);
  expect(await call('GET', '/devices')).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: source.id, status: 'revoked', online: false }),
    expect.objectContaining({ id: target.id, status: 'active' }),
  ]));
  expect(await call('GET', '/mobile-devices')).toContainEqual(expect.objectContaining({ id: phone.id, status: 'disabled' }));
});
