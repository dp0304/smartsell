import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

test('creator workbench persists evaluation overrides, contacts and deadline changes', async ({ page, dev }) => {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { 'x-setup-token': dev.setupToken },
    data: { email: 'creator-owner@example.test', name: 'Creator Owner', workspaceName: 'Creator acceptance', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const session = (await setup.json()).data;
  const wid = session.workspaces[0].id;
  const api = `${dev.origin}/api/v1/workspaces/${wid}/commands`;
  const web = `${dev.origin}/compat/workbench/w/${wid}`;
  async function seed(action, data) {
    const response = await page.request.post(`${api}/${action}`, {
      headers: { origin: dev.origin, 'idempotency-key': randomUUID() }, data,
    });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).data;
  }
  async function submit(action) {
    const tools = page.getByRole('dialog').last();
    const result = page.waitForResponse(response => response.url() === `${api}/${action}` && response.request().method() === 'POST');
    await tools.locator('button[type=submit]').click();
    const response = await result;
    expect(response.status(), await response.text()).toBe(200);
    await expect(tools.getByRole('status').getByText('The server accepted the command.')).toBeVisible();
    await tools.getByRole('button', { name: 'Close', exact: true }).click();
  }
  const brand = await seed('workspace/create_brand', { name: 'Creator brand', slug: 'creator-brand' });
  const campaign = await seed('campaign/create_draft', { brand_id: brand.id, name: 'Creator launch', kind: 'launch', timezone: 'UTC' });
  const csrf = (await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json()).csrf_token;
  async function rest(path, method = 'GET', data, version) {
    const response = await page.request.fetch(`${dev.origin}/api/v1/workspaces/${wid}${path}`, { method, data,
      headers: { origin: dev.origin, 'x-csrf-token': csrf, ...(version && { 'if-match': String(version) }) } });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).data;
  }
  const creator = await seed('creator/creators_create', { display_name: 'Mia Creator' });
  const collab = await seed('creator/collaborations_create', { creator_id: creator.id, campaign_id: campaign.id, type: 'gifted' });
  const delivery = await seed('creator/deliverables_create', { collaboration_id: collab.id, kind: 'short_video', due_at: '2027-01-10T12:00:00Z', acceptance_criteria: ['15 seconds'] });
  await seed('creator/creators_evaluate', { campaign_id: campaign.id, creator_id: creator.id, reason: 'Initial assessment', decision: 'shortlist', scores: {} });

  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(`${web}/campaigns?view=campaign&record=${campaign.id}`);
  await expect(page.getByRole('heading', { name: 'Creator evaluations' })).toBeVisible();
  await expect(page.getByText('Brand fit · Unknown')).toBeVisible();
  await page.getByRole('button', { name: 'Override evaluation' }).click();
  await page.locator('textarea[name=reason]').fill('Hold until market data arrives');
  await page.locator('select[name=decision]').selectOption('hold');
  await submit('creator/creators_override_evaluation');
  await page.getByText('Original scores and override history').click();
  await expect(page.getByText(/Hold until market data arrives/)).toBeVisible();
  await expect(page.getByText('shortlist (Unknown) → hold (Unknown)')).toBeVisible();

  await page.goto(`${web}/creators?view=creator&record=${creator.id}`);
  await page.getByRole('button', { name: 'Import creator contacts' }).click();
  await page.locator('input[name=source_ref]').fill('Creator supplied file');
  await page.locator('textarea[name=csv]').fill('channel,value\nemail,mia@example.test');
  await submit('creator/creators_import_contacts');
  await expect(page.getByText('email · mia@example.test · Creator supplied file')).toBeVisible();

  await page.goto(`${web}/creators?view=collaboration&record=${collab.id}`);
  await page.getByRole('button', { name: /^short_video/ }).click();
  await page.getByRole('button', { name: 'Change deliverable deadline' }).click();
  await page.locator('input[name=due_at]').fill('2027-01-12T12:00');
  await page.locator('textarea[name=reason]').fill('Creator requested an extension');
  await submit('creator/deliverables_change_deadline');
  await expect(page.getByText(/Creator requested an extension/)).toBeVisible();
  const saved = await seed('creator/deliverables_get', { deliverable_id: delivery.id });
  expect(saved.deliverable.status).toBe('requested');
  expect(saved.deadline_changes).toHaveLength(1);

  // The primary REST API and compatibility commands use distinct record stores.
  const nativeBrand = await rest('/brands', 'POST', { name: 'Creator REST brand', slug: 'creator-rest-brand' });
  const nativeCampaign = await rest('/campaigns', 'POST', { brand_id: nativeBrand.id, name: 'Creator REST launch', kind: 'launch', timezone: 'UTC' });
  const nativeCreator = await rest('/creators', 'POST', { display_name: 'Creator REST profile' });
  const nativeCollab = await rest('/collaborations', 'POST', { creator_id: nativeCreator.id, campaign_id: nativeCampaign.id, type: 'gifted', owner_user_id: session.user.id });
  const account = await rest('/social-accounts', 'POST', { provider: 'meta_facebook', external_account_id: 'creator-planning-fixture', display_name: 'Creator planning', brand_id: nativeBrand.id, owned_account_confirmed: true });
  const { item } = await rest('/content-items', 'POST', { brand_id: nativeBrand.id, title: 'Creator repost' });
  const { variant } = await rest(`/content-items/${item.id}/variants`, 'POST', { platform: 'facebook', market: 'TW', format: 'text', body_markdown: 'Local test caption' });
  await rest(`/content-variants/${variant.id}/revisions`, 'POST', { expected_version: variant.version, base_revision_id: null });
  const target = await rest('/publish-targets', 'POST', { campaign_id: nativeCampaign.id, social_account_id: account.id,
    content_variant_id: variant.id, scheduled_at: '2027-01-11T00:00:00Z', schedule_tz: 'UTC' });
  const nativeDelivery = await rest(`/collaborations/${nativeCollab.id}/deliverables`, 'POST', { kind: 'short_video', due_at: '2027-01-10T12:00:00Z', acceptance_criteria: [], publish_target_id: target.id });
  const change = await rest(`/deliverables/${nativeDelivery.id}/deadline`, 'PATCH', { due_at: '2027-01-12T12:00:00Z', reason: 'Creator extension' }, nativeDelivery.version);
  expect(change.deadline_change.impact).toMatchObject({ publish_target_id: target.id, review_required: true, deadline_after_schedule: true });
  expect((await rest(`/publish-targets/${target.id}`)).scheduled_at).toBe(target.scheduled_at);
  await expect.poll(async () => (await rest('/notifications?type=deliverable_deadline_changed')).items).toEqual([
    expect.objectContaining({ resource_type: 'publish_target', resource_id: target.id }),
  ]);
  const reconciliation = page.waitForResponse(response => response.url().endsWith(`/collaborations/${nativeCollab.id}/attribution-reconciliation`));
  await page.goto(`${dev.origin}/w/${wid}/creators?tab=collabs&id=${nativeCollab.id}`);
  expect((await reconciliation).status()).toBe(200);
  const panel = page.getByRole('region', { name: 'Creator attribution reconciliation' });
  await expect(panel.getByText('No orders to reconcile yet.')).toBeVisible();
  await expect(panel.getByText('Platform observations are order-level. Reconcile the two columns separately.')).toBeVisible();

  async function submitRest(path, method = 'POST', status = 200) {
    const dialog = page.getByRole('dialog');
    const confirmation = dialog.getByRole('checkbox');
    if (await confirmation.count()) await confirmation.check();
    const waiting = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === method);
    await dialog.locator('button[type=submit]').click();
    const response = await waiting;
    expect(response.status(), await response.text()).toBe(status);
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    return (await response.json()).data;
  }

  await page.getByRole('button', { name: 'Plan external live session' }).click();
  await page.getByLabel('Live platform').fill('youtube');
  await page.getByLabel(/Starts at/).fill('2027-01-14T12:00');
  await page.getByLabel(/Run sheet/).fill('Product demo\nQuestions');
  await page.getByLabel(/Warm-up publish target IDs/).fill(target.id);
  const plan = await submitRest('/live-sessions');
  await page.getByRole('link', { name: /youtube.*planning/ }).click();
  await expect(page.getByText('Product demo', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: target.id })).toBeVisible();
  await expect(page.getByRole('button', { name: /start (stream|live)/i })).toHaveCount(0);
  const livePath = `/live-sessions/${plan.id}`;
  for (const [status, evidence] of [['scheduled'], ['live', 'external-session-1'], ['ended', 'external-replay-1']]) {
    await page.getByRole('button', { name: 'Record external live progress' }).click();
    await page.getByRole('dialog').locator('select[name=status]').selectOption(status);
    if (evidence) await page.getByLabel(/Platform evidence/).fill(evidence);
    await submitRest(livePath, 'PATCH');
  }
  await expect(page.getByRole('list', { name: 'Platform observations' })).toContainText('external-session-1');
  await expect(page.getByRole('list', { name: 'Platform observations' })).toContainText('external-replay-1');
  const assetId = randomUUID(), versionId = randomUUID(), evidenceId = randomUUID();
  const market = await rest(`/brands/${nativeBrand.id}/markets`, 'POST', { name: 'Taiwan', country_code: 'TW', primary_language: 'zh-Hant', currency: 'TWD', timezone: 'Asia/Taipei' });
  dev.updateSnapshot(state => {
    const { tenantId, workspaceId } = state.scope;
    const now = new Date().toISOString();
    for (const [kind, id, fields] of [
      ['asset', assetId, { brand_id: nativeBrand.id, status: 'active' }],
      ['asset_version', versionId, { asset_id: assetId }],
      ['evidence', evidenceId, {}],
    ]) {
      const key = `row/${kind}/${id}`;
      const row = { id, version: 1, created_at: now, updated_at: now, ...fields };
      state.records.push([JSON.stringify(['operation_runtime', 'record', key]), {
        id: key, module: 'operation_runtime', kind: 'record', version: 1, tenant_id: tenantId, workspace_id: workspaceId,
        created_at: now, updated_at: now, data: { value: JSON.stringify(row) },
      }]);
    }
  });
  await page.getByRole('button', { name: 'Plan clip reuse' }).click();
  const clip = page.getByRole('dialog');
  // The asset is chosen from a dropdown; the remaining fields are typed.
  await clip.locator('select[name=asset_id]').selectOption(assetId);
  for (const [key, value] of Object.entries({ title: 'Unauthorized clip', asset_version_id: versionId,
    market_id: market.id, platform: 'youtube', reuse_at: '2099-05-01T12:00' })) await clip.locator(`input[name=${key}]`).fill(value);
  const refused = await submitRest(`${livePath}/clip-reuse`, 'POST', 409);
  expect(refused).toBeUndefined();
  expect((await rest(livePath)).clips).toEqual([]);

  await page.goto(`${dev.origin}/w/${wid}/creators?tab=creators&id=${nativeCreator.id}`);
  await expect(page.getByText('No audience observations')).toBeVisible();
  await page.getByRole('button', { name: 'Record audience observation' }).click();
  const audience = page.getByRole('dialog');
  await audience.locator('input[name=market]').fill('TW');
  await audience.getByLabel('Share (basis points)').fill('0');
  await audience.locator('select[name=source_kind]').selectOption('public');
  await page.getByLabel('Source reference').fill('Public audience export');
  await page.getByLabel('Observed at').fill('2026-11-18T12:00');
  await submitRest(`/creators/${nativeCreator.id}/audience-observations`);
  const publicObservation = page.getByText(/TW · 0% · Public data · Public audience export · 2026-11-/);
  await expect(publicObservation).toBeVisible();
  const profile = (await rest(`/creators/${nativeCreator.id}`)).creator;
  await rest(`/creators/${nativeCreator.id}/audience-observations`, 'POST', {
    market: 'TW', share_bps: 2550, source_kind: 'self_reported', source_ref: 'Creator audience export', observed_at: '2026-11-19T12:00:00Z',
  }, profile.version);
  await page.reload();
  await expect(publicObservation).toBeVisible();
  await expect(page.getByText(/TW · 25.5% · Self-reported · Creator audience export · 2026-11-/)).toBeVisible();

  const second = await rest('/creators', 'POST', { display_name: nativeCreator.display_name });
  expect(second.id).not.toBe(nativeCreator.id);
  expect(await rest(`/creators/${nativeCreator.id}/associations`)).toEqual([]);
  await page.getByRole('button', { name: 'Associate duplicate profiles' }).click();
  await page.getByLabel('Other creator profile').selectOption(second.id);
  await page.getByLabel(/Evidence IDs/).fill(evidenceId);
  await page.getByRole('dialog').locator('textarea[name=reason]').fill('Creator confirmed both profiles');
  const association = await submitRest(`/creators/${nativeCreator.id}/associations`);
  await page.getByRole('button', { name: 'Undo profile association' }).click();
  await page.getByRole('dialog').locator('textarea[name=reason]').fill('Keep profiles separate');
  await submitRest(`/creator-associations/${association.id}/revoke`);
  await expect(page.locator('li').filter({ hasText: 'Keep profiles separate' })).toContainText('revoked');
  expect((await rest(`/creators/${second.id}`)).creator.audience_markets).toEqual([]);
});
