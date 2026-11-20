import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';

const origin = process.env.SMARTSELL_REVIEWER_ORIGIN;
const exact = { exact: true };
const owner = { name: 'Launch operator', email: 'launch-owner@example.test', password: randomBytes(24).toString('hex') };
const reviewer = { name: 'Launch reviewer', email: 'launch-reviewer@example.test', password: randomBytes(24).toString('hex') };
const workspaceName = 'Model-free launch';
const brandName = 'Synthetic launch brand';
const accountName = 'Synthetic launch account';
const campaignName = 'Travel mug launch';
const productName = 'Blue travel mug';
const title = 'Meet the travel mug';
const caption = 'A blue travel mug for the morning commute.';
const question = 'How much does this mug hold?';
const replyText = 'This travel mug holds 300 mL.';
const permalink = 'https://www.facebook.com/9011/posts/9012';
const inHours = hours => new Date(Date.now() + hours * 3600_000);

// The same disposable local TLS and PostgreSQL host as the two-session reviewer suite.
test.skip(!process.env.SMARTSELL_MODEL_FREE_API_PORT, 'Run with tests/acceptance/reviewer-sessions.sh model-free');
test.use({ ignoreHTTPSErrors: true, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });

async function data(response) {
  const text = await response.text();
  expect(response.ok(), `${response.status()} ${new URL(response.url()).pathname}: ${response.ok() ? '' : text}`).toBe(true);
  return text ? JSON.parse(text).data : undefined;
}

const english = page => page.getByRole('combobox', { name: /^(介面語言|Interface language)$/ }).selectOption('en');

async function currentUser(page, user, role, wid) {
  await expect(page).toHaveURL(`${origin}/w/${wid}/home`);
  await expect(page.getByText(user.name, exact)).toBeVisible();
  const session = await page.request.get(`${origin}/api/v1/session`);
  expect(session.status()).toBe(200);
  const current = await session.json();
  expect(current.user).toMatchObject({ id: expect.any(String), email: user.email });
  expect(current.workspaces).toContainEqual(expect.objectContaining({ id: wid, role }));
  return current.user;
}

async function mutation(page, method, path, submit) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname.endsWith(path), { timeout: 10_000 }),
    submit(),
  ]);
  return data(response);
}

const button = (scope, name) => scope.getByRole('button', { name, ...exact });
// Reference and enum fields render as dropdowns; plain fields stay text inputs.
const fill = async (scope, key, value) => {
  const field = scope.locator(`[name="${key}"]`);
  return await field.evaluate(node => node.tagName) === 'SELECT' ? field.selectOption(value) : field.fill(value);
};
const pick = (scope, key, value) => scope.locator(`select[name="${key}"]`).selectOption(value);
const nav = async (page, name) => {
  // Settings modules live in a folded sidebar section; open it when the link is hidden there.
  const settings = page.getByRole('navigation').getByRole('button', { name: 'Settings', ...exact });
  if (!await page.getByRole('navigation').getByRole('link', { name, ...exact }).count() && await settings.getAttribute('aria-expanded') === 'false') await settings.click();
  return page.getByRole('navigation').getByRole('link', { name, ...exact }).click();
};
const close = dialog => button(dialog, 'Close').click();

async function chooseReference(scope, key, name) {
  const option = scope.locator(`select[name="${key}"] option`).filter({ hasText: name });
  await expect(option).toHaveCount(1);
  expect(await option.textContent()).toMatch(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( · |$)`));
  await fill(scope, key, await option.getAttribute('value'));
}

async function confirmAction(page, name, path) {
  await button(page, name).click();
  await page.getByRole('checkbox').check();
  return mutation(page, 'POST', path, () => button(page, name).click());
}

async function form(page, name, method, path, fillForm = async () => {}, options = {}) {
  await button(page, options.trigger ?? name).click();
  const drawer = page.getByRole('dialog', { name, ...exact });
  await fillForm(drawer);
  if (await drawer.getByRole('checkbox').count()) await drawer.getByRole('checkbox').check();
  const result = await mutation(page, method, path, () => button(drawer, 'Save').click());
  await expect(drawer.getByRole('status')).toContainText('Saved');
  await (options.follow ? button(drawer, 'View').click() : close(drawer));
  return result;
}

async function seedAccess(page, wid) {
  const csrf = await page.request.get(`${origin}/api/v1/session/csrf`);
  expect(csrf.ok()).toBe(true);
  const { csrf_token } = await csrf.json();
  const root = `${origin}/api/v1/workspaces/${wid}`;
  return async (method, path, body, version) => data(await page.request.fetch(`${root}${path}`, {
    method, data: body, headers: {
      Origin: origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
      ...(version === undefined ? {} : { 'If-Match': String(version) }),
    }, maxRedirects: 0,
  }));
}

async function assertNoModels(call) {
  expect(await call('GET', '/ai/status')).toMatchObject({ enabled: false, purposes: [] });
  expect(await call('GET', '/model-providers')).toEqual([]);
  expect(await call('GET', '/model-routes')).toEqual([]);
}

async function stopApi(api) {
  if (api?.pid && api.exitCode === null && api.signalCode === null) {
    const exited = once(api, 'exit');
    api.kill();
    await exited;
  }
}

async function startApi(bindings = []) {
  const api = spawn(process.execPath, ['--import', 'tsx', 'src/command-main.ts'], {
    cwd: new URL('../../apps/server/', import.meta.url), stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', SMARTSELL_STORE: 'postgres',
      SMARTSELL_AGENT_MODEL_LOOPBACK: bindings.length ? '1' : '0', SMARTSELL_AGENT_MODELS: JSON.stringify(bindings),
      SMARTSELL_AGENT_SECRET_AI01: bindings.length ? 'synthetic-model-credential' : undefined },
  });
  try {
    await once(api, 'spawn');
    await expect.poll(async () => {
      const response = await fetch(`http://127.0.0.1:${process.env.SMARTSELL_MODEL_FREE_API_PORT}/readyz`, {
        signal: AbortSignal.timeout(1000),
      }).catch(() => undefined);
      return response?.status;
    }, { timeout: 10_000 }).toBe(200);
    return api;
  } catch (error) {
    await stopApi(api);
    throw error;
  }
}

test('AI01 | after removing model settings, humans complete the launch', async ({ browser, page }) => {
  test.setTimeout(90_000);
  const reviewContext = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  const offOrigin = [];
  const assistantRequests = [];
  const modelRequests = [];
  const model = createServer((request, response) => {
    modelRequests.push(`${request.method} ${request.url}`);
    response.writeHead(500).end();
  });
  let api;
  try {
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    api = await startApi();
    for (const context of [page.context(), reviewContext]) {
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          offOrigin.push(url.href);
          return route.abort();
        }
        if (/\/(assist|agent-jobs)(\/|$)/.test(url.pathname) && route.request().method() !== 'GET') {
          assistantRequests.push(url.pathname);
          return route.abort();
        }
        return route.continue();
      });
    }
    await page.goto(`${origin}/setup`);
    await english(page);
    await fill(page, 'email', owner.email);
    await fill(page, 'password', owner.password);
    await fill(page, 'workspaceName', workspaceName);
    await fill(page, 'name', owner.name);
    await fill(page, 'setupToken', process.env.SETUP_TOKEN);
    const [response] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${origin}/api/v1/setup`),
      button(page, 'First-time setup').click(),
    ]);
    expect(response.status()).toBe(201);
    const { workspaces: [{ id: wid }] } = await response.json();
    const operator = await currentUser(page, owner, 'owner', wid);
    const call = await seedAccess(page, wid);
    const invite = await call('POST', '/members/invite', { email: reviewer.email, role: 'reviewer' });
    const accepted = await reviewContext.request.post(`${origin}/api/v1/member-invitations/accept`, {
      headers: { Origin: origin }, data: { ...reviewer, token: invite.invitation_token },
    });
    expect(accepted.status()).toBe(204);
    const reviewPage = await reviewContext.newPage();
    await reviewPage.goto(`${origin}/login`);
    await english(reviewPage);
    await fill(reviewPage, 'email', reviewer.email);
    await fill(reviewPage, 'password', reviewer.password);
    await button(reviewPage, 'Sign in').click();
    const approver = await currentUser(reviewPage, reviewer, 'reviewer', wid);
    expect(approver.id).not.toBe(operator.id);
    await assertNoModels(call);
    const queryFixture = sql => execFileSync('docker', ['exec', process.env.SMARTSELL_MODEL_FREE_PG_CONTAINER,
      'psql', '-X', '-U', 'postgres', '-d', 'reviewer_acceptance', '-Atc', sql], { encoding: 'utf8' }).trim();
    const [tenantId, fixtureWorkspace] = queryFixture('SELECT tenant_id, id FROM ss.workspaces').split('|');
    expect(fixtureWorkspace).toBe(wid);
    const endpoint = `http://127.0.0.1:${model.address().port}/v1`;
    const secretId = 'ai01-loopback';
    await stopApi(api);
    api = await startApi([{ tenantId, workspaceId: wid, secretId, endpoint, protocol: 'openai_chat', secretEnv: 'SMARTSELL_AGENT_SECRET_AI01' }]);
    const provider = await call('POST', '/model-providers', {
      name: 'AI01 loopback provider', kind: 'openai_compatible', endpoint, secret_id: secretId, allowed_data_classes: ['public'],
    });
    await call('PATCH', `/model-providers/${provider.id}`, { status: 'active', confirm_egress: true }, provider.version);
    const route = await call('POST', '/model-routes', { purpose: 'draft', provider_id: provider.id, model: 'synthetic', enabled: true });
    expect(await call('GET', '/ai/status')).toEqual({ enabled: true, purposes: ['draft'] });

    // The workspace session does not expose tenant administration routes.
    const modelEgressRules = () => queryFixture(`
      SELECT rule->>'destination_id' FROM ss.entities,
      jsonb_array_elements((data->>'value')::jsonb->'rules') AS rule
      WHERE module = 'operation_runtime' AND kind = 'record' AND id LIKE 'row/egress_policy/%'
        AND rule->>'destination_kind' = 'model_provider'`);
    expect(modelEgressRules()).toBe(provider.id);

    await nav(page, 'AI & automation');
    await button(page, 'Model routes').click();
    await button(page, route.id).click();
    await form(page, 'Remove model route', 'DELETE', `/model-routes/${route.id}`);
    await button(page, 'Model providers').click();
    await button(page, provider.name).click();
    await form(page, 'Remove model provider', 'DELETE', `/model-providers/${provider.id}`);
    await assertNoModels(call);
    expect(modelEgressRules()).toBe('');
    await stopApi(api);
    api = await startApi();
    await assertNoModels(call);

    // External inputs and catalog prerequisites enter via the regular HTTP contracts.
    const brand = await call('POST', '/brands', { name: brandName, slug: 'model-free-launch' });
    const store = await call('POST', '/stores', { brand_id: brand.id, provider: 'file_import', name: 'Synthetic catalog', default_currency: 'USD', default_locale: 'en-US' });
    const product = await call('POST', '/products', { store_id: store.id, title: productName });
    await call('POST', `/products/${product.id}/variants`, { sku: 'AI01-MUG-300' });
    const account = await call('POST', '/social-accounts', { brand_id: brand.id, provider: 'meta_facebook', external_account_id: '9011', display_name: accountName, owned_account_confirmed: true });

    await nav(page, 'Campaigns');
    const campaign = await form(page, 'Create campaign', 'POST', '/campaigns', async drawer => {
      await fill(drawer, 'brand_id', brand.id);
      await fill(drawer, 'name', campaignName);
      await fill(drawer, 'utm_key', 'model-free-launch');
    });
    await button(page, campaignName).click();
    await page.getByRole('searchbox', { name: 'Search by title, handle, or SKU' }).fill('AI01-MUG-300');
    await page.getByRole('combobox', { name: 'Product', ...exact }).selectOption({ label: productName });
    await mutation(page, 'PUT', `/campaigns/${campaign.id}/products`, () => button(page, 'Add campaign product').click());
    await expect(page.getByText(`${productName} · Hero`, exact)).toBeVisible();

    await nav(page, 'Content studio');
    const { item } = await form(page, 'Create content', 'POST', '/content-items', async drawer => {
      await fill(drawer, 'brand_id', brand.id);
      await fill(drawer, 'campaign_id', campaign.id);
      await fill(drawer, 'title', title);
    });
    await button(page, title).click();
    const { variant } = await form(page, 'Create variant', 'POST', `/content-items/${item.id}/variants`, async drawer => {
      await pick(drawer, 'platform', 'facebook');
      await pick(drawer, 'format', 'text');
      await fill(drawer, 'locale', 'en-US');
      await fill(drawer, 'draft_text', caption);
    }, { follow: true });
    await expect(page.getByText(caption, exact)).toBeVisible();
    const { revision } = await form(page, 'Save revision', 'POST', `/content-variants/${variant.id}/revisions`);
    const scheduleAt = inHours(2).toISOString().slice(0, 16);
    const target = await form(page, 'Create schedule', 'POST', '/publish-targets', async drawer => {
      await expect(drawer.locator('[name=variant_revision_id]')).toHaveValue(revision.id);
      await chooseReference(drawer, 'social_account_id', 'Synthetic launch account');
      await fill(drawer, 'local_scheduled_at', scheduleAt);
      await fill(drawer, 'schedule_tz', 'UTC');
    }, { follow: true, trigger: 'Schedule revision 1' });
    const submitted = await form(page, 'Submit schedule / approval', 'POST', `/publish-targets/${target.id}/submit`);
    expect(submitted).toMatchObject({ plan_status: 'awaiting_approval', variant_revision_id: revision.id, campaign_id: campaign.id });
    await expect(button(page, 'Approve')).toHaveCount(0);
    await nav(reviewPage, 'Publishing calendar');
    await button(reviewPage, 'My approvals').click();
    await reviewPage.getByRole('row').filter({ hasText: target.id }).getByRole('button').click();
    const approved = await form(reviewPage, 'Approve', 'POST', `/publish-targets/${target.id}/approve`);
    expect(approved).toMatchObject({ plan_status: 'ready', frozen_hash: submitted.frozen_hash, scheduled_at: `${scheduleAt}:00.000Z` });

    await page.reload();
    await page.getByRole('link', { name: 'Open execution task', ...exact }).click();
    const taskId = new URL(page.url()).searchParams.get('id');
    expect(taskId).toBeTruthy();
    await form(page, 'Hand over to manual', 'POST', `/execution-tasks/${taskId}/handover`, drawer => fill(drawer, 'reason', 'Record a synthetic manual publication.'));
    const receipt = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzQAAAAASUVORK5CYII=', 'base64');
    const ticket = await call('POST', '/files/uploads', {
      purpose: 'evidence', mime_type: 'image/png', size_bytes: receipt.length,
      sha256: createHash('sha256').update(receipt).digest('hex'),
    });
    const evidence = await call('POST', `/files/uploads/${ticket.id}/complete`, { base64: receipt.toString('base64') });
    const publishedAt = inHours(-1).toISOString().slice(0, 16);
    const { platform_post: publication } = await form(page, 'Record manual publication', 'POST', `/execution-tasks/${taskId}/manual-complete`, async drawer => {
      await fill(drawer, 'permalink', permalink);
      await fill(drawer, 'published_at', publishedAt);
      await fill(drawer, 'evidence_file_ids', evidence.id);
    });
    expect(publication).toMatchObject({ publish_target_id: target.id, verification: 'manual_confirmed' });
    await expect(page.getByRole('link', { name: 'Open published post', ...exact })).toHaveAttribute('href', permalink);

    const { items: [{ conversation }] } = await call('POST', '/inbox/ingest', { messages: [{ brand_id: brand.id,
      social_account_id: account.id, provider: 'meta_facebook', external_message_id: 'model-free-comment', kind: 'comment_thread',
      external_user_id: 'synthetic-shopper', platform_post_id: publication.id, external_url: permalink,
      body_text: question, platform_created_at: inHours(-0.25).toISOString(),
    }] });
    const thread = `/conversations/${conversation.id}`;
    await nav(page, 'Inbox');
    await button(page.getByRole('row'), conversation.id).click();
    await expect(page.getByText(question, exact)).toBeVisible();
    await form(page, 'Acquire reply lease', 'POST', `${thread}/occupancy`);
    const reply = await form(page, 'Draft reply', 'POST', `${thread}/reply-drafts`, drawer => fill(drawer, 'body_text', replyText), { follow: true });
    expect(reply).toMatchObject({ reply_mode: 'public_reply', body_text: replyText });
    const draft = `/reply-drafts/${reply.id}`;
    await confirmAction(page, 'Submit reply for approval', `${draft}/submit-approval`);
    await nav(reviewPage, 'Inbox');
    await button(reviewPage.getByRole('row'), conversation.id).click();
    await button(reviewPage, replyText).click();
    await confirmAction(reviewPage, 'Approve reply', `${draft}/approve`);
    await page.reload();
    const delivery = await confirmAction(page, 'Stage manual reply', `${draft}/send`);
    expect(delivery).toMatchObject({ status: 'manual' });
    const replyUrl = `${permalink}?comment_id=9013`;
    await page.getByText('Record confirmed delivery', exact).click();
    const deliveryForm = page.locator('form').filter({ has: page.getByLabel('Platform reply link') });
    await deliveryForm.getByLabel('Platform reply link').fill(replyUrl);
    await deliveryForm.getByRole('checkbox', { name: 'I verified this reply on the platform.' }).check();
    const delivered = await mutation(page, 'POST', `/outbound-replies/${delivery.id}/manual-complete`, () => button(deliveryForm, 'Save').click());
    expect(delivered).toMatchObject({ status: 'delivered', verification: 'manual_evidence' });

    await call('POST', '/metrics/observations', { observations: [{ metric_key: 'norm.post.views', subject_type: 'platform_post',
      subject_id: publication.id, observed_at: inHours(-0.1).toISOString(), value: 37, dims: { campaign_id: campaign.id },
      availability: 'observed', source: { method: 'manual_import' },
    }] });
    await nav(page, 'Execution monitor');
    await button(page, 'Platform posts').click();
    await button(page.getByRole('row'), publication.id).click();
    await expect(page.getByRole('heading', { name: 'Metric history', ...exact })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'norm.post.views' }).getByRole('cell', { name: '37', ...exact })).toBeVisible();
    await assertNoModels(call);
    expect(await call('GET', '/agent-jobs')).toEqual([]);
    expect(await call('GET', '/ai-usage')).toEqual([]);
    expect(assistantRequests).toEqual([]);
    expect(modelRequests).toEqual([]);
    expect(offOrigin).toEqual([]);
  } finally {
    await Promise.allSettled([
      stopApi(api),
      reviewContext.close(),
      new Promise(resolve => model.close(resolve)),
    ]);
  }
});
