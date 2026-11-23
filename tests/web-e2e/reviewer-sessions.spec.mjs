import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const origin = process.env.SMARTSELL_REVIEWER_ORIGIN;
const api = '/api/v1';
const compat = '/compat/workbench';
const exact = { exact: true };
const submitter = { email: 'submitter@example.test', name: 'Approval submitter', password: randomBytes(24).toString('hex') };
const reviewer = { email: 'reviewer@example.test', name: 'Approval reviewer', password: randomBytes(24).toString('hex') };
const approveButton = { name: 'Approve publish target', ...exact };
const fixedCopy = 'The same fixed launch copy must be approved.';

test.skip(!origin, 'Run with tests/acceptance/reviewer-sessions.sh');
test.use({ ignoreHTTPSErrors: true }); // The isolated loopback TLS proxy uses a disposable self-signed certificate.

async function responseJson(response, status, stage) {
  const json = response.status() === 204 ? undefined : await response.json().catch(() => undefined);
  expect(response.status(), `${stage} (${json?.error?.code ?? 'no error code'})`).toBe(status);
  return json;
}

function post(context, path, data, headers = {}) {
  return context.request.post(`${origin}${api}${path}`, {
    data, headers: { Origin: origin, 'Idempotency-Key': randomUUID(), ...headers }, maxRedirects: 0,
  });
}

async function get(context, path, status = 200) {
  return responseJson(await context.request.get(`${origin}${api}${path}`, { maxRedirects: 0 }), status, `GET ${path}`);
}

function watchPost(page, path) {
  const pending = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${api}${path}`);
  void pending.catch(() => {});
  return pending;
}

async function signIn(page, user, wid, role) {
  await page.goto(`${origin}${compat}/login`);
  await page.getByRole('combobox', { name: '介面語言', ...exact }).selectOption('en');
  await page.getByLabel('Username or email', exact).fill(user.email);
  await page.locator('input[name=password]').fill(user.password);
  const pending = watchPost(page, '/session');
  await page.getByRole('button', { name: 'Sign in', ...exact }).click();
  const session = await responseJson(await pending, 200, `${role} Web sign-in`);
  expect(session.user).toMatchObject({ id: expect.any(String), email: user.email, name: user.name });
  expect(session.workspaces).toEqual([expect.objectContaining({ id: wid, role })]);
  await expect(page).toHaveURL(`${origin}${compat}/w/${wid}/home`);
  await expect(page.getByLabel('Signed-in account', exact)).toHaveText(user.name);
  return session.user;
}

async function command(context, root, name, body, status = 200) {
  return responseJson(await post(context, `${root}/commands/${name}`, body), status, name);
}

async function runUiCommand(page, root, button, name) {
  await button.click();
  const tools = page.getByRole('dialog', { name: 'Tools', ...exact });
  const pending = watchPost(page, `${root}/commands/${name}`);
  await tools.getByRole('button', { name: 'Run command', ...exact }).click();
  await tools.getByRole('button', { name: 'Confirm operation', ...exact }).click();
  const response = await pending;
  const { data } = await responseJson(response, 200, name);
  await expect(tools.getByRole('status')).toContainText('The server accepted the command.');
  await tools.getByRole('button', { name: 'Close', ...exact }).click();
  return { data, input: response.request().postDataJSON() };
}

async function sessionCookie(context) {
  const cookie = (await context.cookies(origin)).find(({ name }) => name === '__Host-smartsell_session');
  expect(Boolean(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict')).toBe(true);
  return cookie.value;
}

test('real PostgreSQL members submit and approve in coexisting Web sessions', async ({ page, browser, context }) => {
  const reviewContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const setup = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const initial = await responseJson(await post(setup, '/setup', { ...submitter, workspaceName: 'Two-person approval' }, {
      'X-Setup-Token': process.env.SETUP_TOKEN,
    }), 201, 'first setup');
    await setup.close();
    const [{ id: wid }] = initial.workspaces;
    const root = `/workspaces/${wid}`;
    const owner = await signIn(page, submitter, wid, 'owner');
    expect(owner.id).toBe(initial.user.id);
    const ownerCookie = await sessionCookie(context);

    const { csrf_token } = await get(context, '/session/csrf');
    const invitationResponse = await post(context, `${root}/members/invite`, { email: reviewer.email, role: 'reviewer' }, { 'X-CSRF-Token': csrf_token });
    expect(invitationResponse.status(), 'create reviewer invitation').toBe(200);
    const { data: invite } = await invitationResponse.json();
    expect(Boolean(invite.invitation_id && /^[A-Za-z0-9_-]{43}$/.test(invite.invitation_token))).toBe(true);
    const accept = { ...reviewer, token: invite.invitation_token };
    expect((await responseJson(await post(reviewContext, '/member-invitations/accept', { ...accept, email: 'different@example.test' }), 403, 'wrong email')).error.code).toBe('invalid_invitation');
    await responseJson(await post(reviewContext, '/member-invitations/accept', accept), 204, 'accept invitation');
    expect((await responseJson(await post(reviewContext, '/member-invitations/accept', accept), 403, 'replayed invitation')).error.code).toBe('invalid_invitation');
    await get(reviewContext, '/session', 401);
    expect((await responseJson(await post(reviewContext, '/session', { email: reviewer.email, password: submitter.password }), 401, 'wrong member password')).error.code).toBe('invalid_credentials');
    const reviewPage = await reviewContext.newPage();
    const actor = await signIn(reviewPage, reviewer, wid, 'reviewer');
    const reviewCookie = await sessionCookie(reviewContext);
    expect(actor.id).not.toBe(owner.id);
    expect(reviewCookie === ownerCookie).toBe(false);
    const { data: members } = await get(context, `${root}/members`);
    expect(members).toHaveLength(2);
    expect(members).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: owner.id, role: 'owner' }),
      expect.objectContaining({ user_id: actor.id, role: 'reviewer' }),
    ]));
    const reviewCsrf = await get(reviewContext, '/session/csrf');
    await responseJson(await post(reviewContext, `${root}/members/invite`, { email: 'third@example.test', role: 'viewer' }, { 'X-CSRF-Token': reviewCsrf.csrf_token }), 403, 'reviewer cannot invite');

    const write = async (name, input) => (await command(context, root, name, input)).data;
    const brand = await write('workspace/create_brand', { name: 'Approval brand', slug: 'approval-brand' });
    const { item } = await write('content/content_create_item', { brand_id: brand.id, title: 'Fixed approval content' });
    const { variant } = await write('content/content_create_variant', {
      content_item_id: item.id, platform: 'facebook', format: 'text', locale: 'en', market: 'TW', draft_doc: { body: fixedCopy },
    });
    const { revision } = await write('content/content_commit_revision', { variant_id: variant.id, expected_version: variant.version, base_revision_id: null });
    await write('planning/set_publishing_profile', {
      account_id: 'manual-approval-profile', platform: 'facebook', timezone: 'UTC', formats: ['text'], active: true, manual_capability: true,
    });
    const target = await write('planning/create_target', {
      account_id: 'manual-approval-profile', content_variant_id: variant.id, route: 'manual', visibility: 'public',
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    await page.getByRole('link', { name: 'Approvals', ...exact }).click();
    await page.getByRole('button', { name: 'Publish target', ...exact }).click();
    await page.getByRole('button', { name: target.id, ...exact }).click();
    const targetDetail = page.getByRole('dialog', { name: target.id, ...exact });
    const { data: submitted } = await runUiCommand(page, root,
      targetDetail.getByRole('button', { name: 'Submit for publishing approval', ...exact }), 'planning/submit');
    const { approval_id, frozen_hash, revision_id } = submitted.data;
    expect(approval_id).toEqual(expect.any(String));
    expect(frozen_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(revision_id).toBe(revision.id);
    await targetDetail.getByRole('button', { name: 'Close', ...exact }).click();
    await page.getByRole('button', { name: target.id, ...exact }).click();
    await expect(targetDetail.getByText('Server details', exact)).toBeVisible();
    await expect(targetDetail.getByRole('button', approveButton)).toHaveCount(0);

    const decision = { target_id: target.id, expected_version: submitted.version, frozen_hash };
    const denied = await command(context, root, 'planning/approve', decision, 403);
    expect(denied.error.code).toBe('self_review_forbidden');
    const readTarget = async member => (await command(member, root, 'planning/get_target', { target_id: target.id })).data;
    const pending = await readTarget(context);
    const binding = { target_id: target.id, requested_by: owner.id, revision_author_id: owner.id, frozen_hash };
    const fixed = { owner_id: owner.id, approval_id, frozen_hash, revision_id, frozen: { revision: { id: revision.id, author_id: owner.id, body: fixedCopy } } };
    expect(pending).toMatchObject({
      id: target.id, version: submitted.version, data: { ...fixed, status: 'awaiting_approval' },
      approval: { id: approval_id, version: 1, data: { ...binding, status: 'pending' } },
    });
    expect(pending.approval.data.decided_by).toBeUndefined();
    expect(await readTarget(reviewContext)).toEqual(pending);

    await reviewPage.getByRole('link', { name: 'Approvals', ...exact }).click();
    await reviewPage.getByRole('button', { name: 'Approval request', ...exact }).click();
    await reviewPage.getByRole('button', { name: approval_id, ...exact }).click();
    const detail = reviewPage.getByRole('dialog', { name: approval_id, ...exact });
    await expect(detail.getByText(`Publishing target version ${submitted.version}`, exact)).toBeVisible();
    const approved = await runUiCommand(reviewPage, root, detail.getByRole('button', approveButton), 'planning/approve');
    expect(approved.input).toMatchObject(decision);
    expect(approved.data).toMatchObject({ id: target.id, version: submitted.version + 1, data: { ...fixed, status: 'scheduled' } });

    for (const [tab, member, role, user, cookie] of [
      [page, context, 'owner', owner, ownerCookie], [reviewPage, reviewContext, 'reviewer', actor, reviewCookie],
    ]) {
      await tab.reload();
      await expect(tab.getByLabel('Signed-in account', exact)).toHaveText(user.name);
      const readback = await get(member, '/session');
      expect(readback.user).toEqual(user);
      expect(readback.workspaces).toEqual([expect.objectContaining({ id: wid, role })]);
      expect(await sessionCookie(member) === cookie).toBe(true);
      const final = await readTarget(member);
      expect(final).toMatchObject({
        id: target.id, version: submitted.version + 1, data: { ...fixed, status: 'scheduled' },
        approval: { id: approval_id, version: 2, data: { ...binding, status: 'approved', decided_by: actor.id } },
      });
      expect(final.data.frozen).toEqual(pending.data.frozen);
    }
    console.log(JSON.stringify({ workspace: wid, requested_by: owner.id, decided_by: actor.id, approval_id, target_id: target.id,
      revision_id, frozen_hash, submitted_version: submitted.version, final_version: submitted.version + 1,
      self_review: '403 self_review_forbidden', approval: 'pending → approved', sessions: 'both original cookies retained' }));
  } finally {
    await setup.close();
    await reviewContext.close();
  }
});
