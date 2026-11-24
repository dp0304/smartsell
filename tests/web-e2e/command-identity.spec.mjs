import { createRequire } from 'node:module';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';
import { expectToday } from './phase1-shell.mjs';

const { Secret, TOTP } = createRequire(new URL('../../packages/identity/package.json', import.meta.url))('otpauth');
const test = base.extend({ dev: localDev });
test.use({ viewport: { width: 1280, height: 800 }, trace: 'off', screenshot: 'off', video: 'off' });

const email = 'owner@example.test';
const sessionPath = '/api/v1/session';
const totpPath = '/api/v1/auth/totp';
const field = (page, name) => page.locator(`input[name=${name}]`);
const language = page => page.getByRole('combobox', { name: /^(介面語言|Interface language)$/ });

async function setup(page, dev) {
  const password = dev.password();
  const response = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email, password, name: 'Command owner', workspaceName: 'Command identity' },
  });
  expect(response.status()).toBe(201);
  const { data } = await response.json();
  return { password, userId: data.user.id, workspaceId: data.workspaces[0].id };
}

async function submit(page, button, path, status) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === path),
    page.getByRole('button', { name: button, exact: true }).click(),
  ]);
  expect(response.status(), `POST ${path}`).toBe(status);
  return response;
}

async function fillCredentials(page, email, password, identifier = 'identifier') {
  await field(page, identifier).fill(email);
  await field(page, 'password').fill(password);
}

test('Commands enrollment requires a fresh password and sign-in waits for a second factor', async ({ browser, page, dev }) => {
  const { password, workspaceId } = await setup(page, dev);
  const homePath = `/w/${workspaceId}/home`;
  const securityPath = `/w/${workspaceId}/settings/security`;
  const status = await page.request.get(`${dev.origin}${totpPath}`);
  expect(status.status()).toBe(200);
  expect((await status.json()).data).toMatchObject({ enabled: false, canManage: true, passwordRecheck: true });
  await page.goto(`${dev.origin}${securityPath}`);
  await language(page).selectOption('en');
  await expect(page.getByText('Two-step verification is off', { exact: true })).toBeVisible();
  await field(page, 'password').fill(password);
  await submit(page, 'Set up authenticator', `${totpPath}/enroll`, 200);
  const setupKey = page.getByLabel('Enter this setup key manually in your authenticator');
  const authenticator = new TOTP({ secret: Secret.fromBase32(await setupKey.inputValue()) });
  await field(page, 'password').fill(password);
  await field(page, 'totp').fill(authenticator.generate());
  await submit(page, 'Confirm and enable', `${totpPath}/confirm`, 200);
  const recoveryCodes = page.getByRole('list', { name: 'Recovery codes', exact: true });
  await expect(recoveryCodes).toBeVisible();
  const codes = await recoveryCodes.getByRole('listitem').allTextContents();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Two-step verification is on', { exact: true })).toBeVisible();

  const fresh = await browser.newContext({ viewport: page.viewportSize() });
  try {
    const login = await fresh.newPage();
    await login.goto(`${dev.origin}/login?next=${encodeURIComponent(homePath)}`);
    await language(login).selectOption('en');
    await fillCredentials(login, email, password);
    const gate = await submit(login, 'Sign in', sessionPath, 200);
    expect((await gate.json()).data.required).toBe(true);
    expect(await gate.headerValue('set-cookie')).toBeNull();
    expect((await login.request.get(`${dev.origin}${sessionPath}`)).status()).toBe(401);
    await expect(field(login, 'totp')).toBeVisible();
    await login.getByRole('button', { name: 'Use a recovery code' }).click();
    await field(login, 'recoveryCode').fill(codes[0]);
    await submit(login, 'Verify and sign in', `${totpPath}/challenge`, 200);
    // An explicit return path into the advanced workbench is honored after the second factor.
    await expect(login).toHaveURL(`${dev.origin}${homePath}`);
    await expect(login.getByRole('heading', { name: 'Today’s operations', exact: true })).toBeVisible();
    expect((await login.request.get(`${dev.origin}${sessionPath}`)).status()).toBe(200);
  } finally {
    await fresh.close();
  }

  await field(page, 'password').fill(password);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await field(page, 'recoveryCode').fill(codes[1]);
  await submit(page, 'Revoke recovery codes', `${totpPath}/recovery/revoke`, 200);
  await expect(page.getByText('Two-step verification is on', { exact: true })).toBeVisible();
});

test('Commands invitation acceptance leaves the owner and invited reviewer in separate sessions', async ({ browser, page, dev }) => {
  const { userId, workspaceId } = await setup(page, dev);
  const reviewerEmail = 'reviewer@example.test';
  const reviewerPassword = dev.password();
  const csrf = await page.request.get(`${dev.origin}${sessionPath}/csrf`);
  expect(csrf.status()).toBe(200);
  const { csrf_token: csrfToken } = await csrf.json();
  const invite = await page.request.post(`${dev.origin}/api/v1/workspaces/${workspaceId}/members/invite`, {
    headers: { Origin: dev.origin, 'X-CSRF-Token': csrfToken },
    data: { email: reviewerEmail, role: 'reviewer' },
  });
  expect(invite.status()).toBe(200);
  const { data: { invitation_token: token } } = await invite.json();

  const fresh = await browser.newContext({ viewport: page.viewportSize() });
  try {
    const reviewer = await fresh.newPage();
    await reviewer.goto(`${dev.origin}/invite#${token}`);
    await language(reviewer).selectOption('en');
    await fillCredentials(reviewer, reviewerEmail, reviewerPassword, 'email');
    await field(reviewer, 'name').fill('Invited reviewer');
    await submit(reviewer, 'Accept member invitation', '/api/v1/member-invitations/accept', 204);
    await expect(reviewer).toHaveURL(`${dev.origin}/login`);
    expect((await reviewer.request.get(`${dev.origin}${sessionPath}`)).status()).toBe(401);
    await fillCredentials(reviewer, reviewerEmail, reviewerPassword);
    await submit(reviewer, 'Sign in', sessionPath, 200);
    // Without a return path, sign-in lands on the dashboard index, which is Today in phase 1 (§9.1). A reviewer
    // cannot set the workspace up, so no wizard and no 「開始設定」 entry.
    await expect(reviewer).toHaveURL(`${dev.origin}/app/${workspaceId}`);
    await expectToday(reviewer, 'en');
    await expect(reviewer.getByRole('link', { name: 'Get started', exact: true })).toHaveCount(0);
    await expect(reviewer.getByRole('navigation', { name: 'Dashboard navigation' })).toBeVisible();
    const { data } = await (await reviewer.request.get(`${dev.origin}${sessionPath}`)).json();
    expect(data.user.id).not.toBe(userId);
    expect(data.workspaces).toEqual([expect.objectContaining({ id: workspaceId, role: 'reviewer' })]);
    const { data: ownerSession } = await (await page.request.get(`${dev.origin}${sessionPath}`)).json();
    expect(ownerSession.user.id).toBe(userId);
    expect(ownerSession.workspaces).toEqual([expect.objectContaining({ id: workspaceId, role: 'owner' })]);
  } finally {
    await fresh.close();
  }
});
