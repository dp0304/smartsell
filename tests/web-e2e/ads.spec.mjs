import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

test('ads shows report basis and zero spend, disabled draft fields, and evidence with manual next steps', async ({ page, dev }) => {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { 'x-setup-token': dev.setupToken },
    data: { email: 'ads-owner@example.test', name: 'Ads Owner', workspaceName: 'Ads acceptance', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const session = (await setup.json()).data;
  const workspace = session.workspaces[0].id;
  const csrfResponse = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  expect(csrfResponse.status()).toBe(200);
  const { csrf_token } = await csrfResponse.json();
  const origin = `${dev.origin}/api/v1/workspaces/${workspace}`;
  async function call(path, { data, method = data ? 'POST' : 'GET', version, status = 200 } = {}) {
    const response = await page.request.fetch(`${origin}${path}`, { method, data, headers: {
      origin: dev.origin, 'x-csrf-token': csrf_token, 'idempotency-key': randomUUID(), ...(version && { 'if-match': `"${version}"` }),
    } });
    expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
    const payload = await response.json();
    return status < 400 ? payload.data : payload;
  }
  const brand = await call('/brands', { data: { name: 'Ads brand', slug: 'ads-brand' } });
  const account = await call('/ad-accounts', { data: {
    brand_id: brand.id, provider: 'meta_ads', external_account_id: 'Ads test account', currency: 'USD', timezone: 'Asia/Taipei', spend_cap_snapshot: 500,
  } });
  const day = new Date(Date.now() - 48 * 60 * 60_000).toISOString().slice(0, 10);
  const laterDay = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const entity = { level: 'campaign', external_id: 'ext-campaign', name: 'Reporting campaign' };
  const observation = { metric_key: 'spend', date: day, definition: 'Provider billed daily spend in cents' };
  const { entity: target } = await call(`/ad-accounts/${account.id}/import`, { data: {
    source_ref: 'missing', entity, observations: [{ ...observation, availability: 'source_not_provided' }],
  } });
  const revision = {
    objective: 'sales', placements: ['facebook_feed', 'unknown_placement'], platform_options: { experimental: true },
    change: { kind: 'pause', target_entity_id: target.id },
    schedule: { starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 86_400_000).toISOString() },
    budget: { type: 'daily', amount_minor: 100, cap_minor: 120, currency: 'USD' },
    estimates: [{ metric: 'impressions', value: 500, source: 'historical worksheet' }],
  };
  const proposal = await call('/ad-proposals', { data: { name: 'Pause draft preview', ad_account_id: account.id, revision } });
  const detail = await call(`/ad-proposals/${proposal.id}`);
  expect(detail.preview).toMatchObject({ actual_spend_minor: null, planned_budget: { amount_minor: 100, cap_minor: 120 },
    estimates: [{ estimate: true }], unsupported_fields: [
      { field: 'placements', value: 'unknown_placement', disabled: true }, { field: 'platform_options.experimental', value: true, disabled: true },
    ] });

  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(`${dev.origin}/w/${workspace}/ads`);
  await page.getByLabel('Ad account for reporting').selectOption(account.id);
  await page.getByRole('button', { name: 'Edit account permissions' }).click();
  const permissionsDrawer = page.getByRole('dialog', { name: 'Edit account permissions' });
  const permissions = [{ actor_id: session.user.id, actions: ['read', 'draft'] }];
  await permissionsDrawer.getByLabel('Actor grants (actor_id, actions)').fill(JSON.stringify(permissions));
  const permissionResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname.endsWith(`/ad-accounts/${account.id}`));
  await permissionsDrawer.getByRole('button', { name: /submit|save/i }).click();
  const saved = await permissionResponse;
  expect(saved.status(), await saved.text()).toBe(200);
  expect(saved.request().postDataJSON()).toEqual({ permissions });
  expect((await saved.json()).data.permissions).toEqual([expect.objectContaining(permissions[0])]);
  await permissionsDrawer.getByRole('button', { name: 'Close', exact: true }).click();
  const performance = page.locator('form').filter({ has: page.getByRole('button', { name: 'Read performance', exact: true }) });
  await performance.getByLabel('Start date').fill(day);
  await performance.getByLabel('End date').fill(laterDay);
  const request = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/workspaces/${workspace}/ads/performance`);
  await page.getByRole('button', { name: 'Read performance' }).click();
  const reportResponse = await request;
  expect(reportResponse.status()).toBe(200);
  expect(Object.fromEntries(new URL(reportResponse.url()).searchParams)).toMatchObject({ ad_account_id: account.id, from: day, until: laterDay });
  await expect(page.getByText('Asia/Taipei', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Provider-native daily reporting', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Provider billed daily spend in cents' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Some dates are unreported/ }).getByRole('cell').first()).toHaveText('Not reported');

  const { observations: [evidence] } = await call(`/ad-accounts/${account.id}/import`, { data: {
    source_ref: 'reported', entity, observations: [{ ...observation, availability: 'observed', value: 0 }],
  } });
  await page.reload();
  await page.getByLabel('Ad account for reporting').selectOption(account.id);
  await performance.getByLabel('Start date').fill(day);
  await performance.getByLabel('End date').fill(laterDay);
  await page.getByRole('button', { name: 'Read performance' }).click();
  const partialReport = page.getByRole('row', { name: /50% · Some dates are unreported/ });
  await expect(partialReport.getByRole('cell').first()).toHaveText('USD 0');
  await page.getByLabel('Ad draft').selectOption(proposal.id);
  await expect(page.getByText('USD 100', { exact: true })).toBeVisible();
  await expect(page.getByText('USD 120', { exact: true })).toBeVisible();
  await expect(page.getByText('impressions · 500 · historical worksheet', { exact: true })).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: /^Not reported$/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'placements', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'platform_options.experimental', exact: true })).toBeDisabled();

  const suggestion = await call('/adjustment-suggestions', { data: {
    target_entity_id: target.id, kind: 'pause', rationale: 'Review the recorded campaign spend', evidence_refs: [evidence.id],
    checks: { sample_size: 1, minimum_sample_size: 10, promotion_overlap: true },
  } });
  const listed = await call(`/adjustment-suggestions?ad_account_id=${account.id}`);
  expect(listed).toEqual([expect.objectContaining({ id: suggestion.id, execution_mode: 'manual',
    evidence: [expect.objectContaining({ id: evidence.id, value: 0, definition: observation.definition })],
    limitations: expect.arrayContaining(['insufficient_sample', 'promotion_overlap']),
    manual_checklist: ['verify_target_and_evidence', 'review_limitations_and_rights', 'approve_draft_before_manual_change', 'record_platform_readback'],
  })]);
  await page.getByRole('button', { name: 'Adjustments', exact: true }).click();
  await page.getByRole('button', { name: suggestion.id, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Adjustment evidence' })).toBeVisible();
  await expect(page.getByText(new RegExp(`${evidence.id}.*ads\\.spend.*USD 0`))).toBeVisible();
  await expect(page.getByText('Insufficient sample size', { exact: true })).toBeVisible();
  await expect(page.getByText('Concurrent promotion', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Manual checklist' })).toBeVisible();
  await expect(page.getByText('Approve the draft before applying the change manually', { exact: true })).toBeVisible();
  const decision = await call(`/adjustment-suggestions/${suggestion.id}/decide`, { data: { decision: 'accepted', revision }, version: suggestion.version });
  const drafts = await call(`/ad-proposals?ad_account_id=${account.id}`);
  const draft = drafts.find(row => row.current_revision_id === decision.resulting_proposal_revision_id);
  expect(draft?.status).toBe('draft');
  expect((await call(`/ad-proposals/${draft.id}`)).approvals).toEqual([]);
});
