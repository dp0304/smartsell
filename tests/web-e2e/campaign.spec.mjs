import { completedReportVersion } from '../acceptance/report-version.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });
const day = 86_400_000;
const views = 'norm.post.views';
const campaignViews = 'views';
const exact = { exact: true };
const at = days => new Date(Date.now() + days * day).toISOString();
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function workspace(page, dev) {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'campaign@example.test', name: 'Campaign operator', workspaceName: 'Campaign QA', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: session } = await setup.json();
  const { id: wid } = session.workspaces[0];
  const root = `/api/v1/workspaces/${wid}`;
  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  expect(csrf.ok(), await csrf.text()).toBe(true);
  const { csrf_token } = await csrf.json();
  const request = (method, path, data, version) => page.request.fetch(`${dev.origin}${root}${path}`, {
    method, data, headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
      ...(version != null ? { 'If-Match': String(version) } : {}) },
  });
  async function call(method, path, data, version) {
    const response = await request(method, path, data, version);
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  }
  const get = path => call('GET', path);
  const post = (path, data, version) => call('POST', path, data, version);
  const brand = await post('/brands', { name: 'Campaign brand', slug: 'campaign-brand' });
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  const baseUrl = `${dev.origin}/w/${wid}`;
  // Seed upstream receipts that normally arrive from a verified domain or commerce provider.
  const seedExternal = (kind, data) => {
    const id = randomUUID();
    const now = new Date().toISOString();
    const key = `row/${kind}/${id}`;
    dev.updateSnapshot(state => state.records.push([JSON.stringify(['operation_runtime', 'record', key]), {
      id: key, module: 'operation_runtime', kind: 'record', version: 1,
      tenant_id: state.scope.tenantId, workspace_id: wid, created_at: now, updated_at: now,
      data: { value: JSON.stringify({ ...data, id, version: 1, created_at: now, updated_at: now }) },
    }]));
    return id;
  };
  return { get, post, request, brand, baseUrl, root, session, seedExternal };
}

function mutation(page, api, path, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === `${api.root}${path}` && response.request().method() === method);
}

async function saved(pending) {
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

async function openCampaign(page, api, campaign) {
  await page.goto(`${api.baseUrl}/campaigns/${campaign.id}`);
  const mounted = page.locator('#root > *').first();
  // A cold Vite optimizer can invalidate a dependency during the first navigation.
  try {
    await mounted.waitFor({ state: 'attached', timeout: 4000 });
  } catch (error) {
    if (await mounted.count()) throw error;
    await page.reload();
  }
  await expect(page.getByRole('heading', { name: 'Market goals', ...exact })).toBeVisible({ timeout: 10_000 });
}

function goal(due_at, overrides = {}) {
  return { metric_key: campaignViews, unit: 'count', baseline_value: 0, baseline_source: 'Local baseline', target_value: 100, due_at, ...overrides };
}

async function campaignFixture(api, name, fields = {}) {
  return api.post('/campaigns', { brand_id: api.brand.id, name, kind: 'launch', timezone: 'UTC',
    starts_at: at(-1), ends_at: at(30), ...fields });
}

const campaignPath = campaign => `/campaigns/${campaign.id}`;
const transition = (api, campaign, to) => api.post(`${campaignPath(campaign)}/transition`, { to }, campaign.version);

async function contentFixture(api, campaign, title, production_due_at) {
  const { item } = await api.post('/content-items', { brand_id: api.brand.id, campaign_id: campaign.id, title, production_due_at });
  const { variant } = await api.post(`/content-items/${item.id}/variants`, {
    platform: 'facebook', market: 'TW', format: 'text', body_markdown: `Caption for ${title}`,
  });
  await api.post(`/content-variants/${variant.id}/revisions`, { expected_version: variant.version, base_revision_id: null });
  return { item, variant };
}

function socialAccount(api, name, external_account_id) {
  return api.post('/social-accounts', { provider: 'meta_facebook', external_account_id, display_name: name,
    brand_id: api.brand.id, owned_account_confirmed: true });
}

function targetFixture(api, account, variant, scheduled_at) {
  return api.post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id, scheduled_at, schedule_tz: 'UTC' });
}

function panel(page, name) {
  return page.getByRole('heading', { name, ...exact }).locator('..');
}

async function fillGoal(panel, target, deadline, baseline = '0') {
  await panel.getByLabel('Metric key', exact).fill(campaignViews);
  await panel.getByRole('combobox', { name: 'Unit', ...exact }).selectOption('count');
  await panel.getByLabel('Baseline value', exact).fill(baseline);
  await panel.getByLabel('Target value', exact).fill(target);
  await panel.getByLabel('Due at', exact).fill(deadline);
}

test('CA01 | Market goals require a unit and deadline and persist under one campaign', async ({ page, dev }) => {
  const api = await workspace(page, dev);
  const markets = [];
  for (const [name, country_code, primary_language, currency, timezone] of [
    ['Taiwan market', 'TW', 'zh-TW', 'TWD', 'Asia/Taipei'], ['US market', 'US', 'en-US', 'USD', 'America/New_York'],
  ]) {
    markets.push(await api.post(`/brands/${api.brand.id}/markets`, { name, country_code, primary_language, currency, timezone }));
  }
  const campaign = await campaignFixture(api, 'Two-market launch', { markets: markets.map(market => ({ market_id: market.id, locales: [market.primary_language] })) });
  const context = await api.get(campaignPath(campaign));
  const [taiwan, us] = markets.map(market => context.markets.find(link => link.market_id === market.id));
  const firstGoal = goal(campaign.ends_at, { campaign_market_id: taiwan.id, baseline_value: 12, target_value: 120 });
  for (const field of ['unit', 'due_at']) {
    const invalid = { ...firstGoal };
    delete invalid[field];
    const response = await api.request('POST', `${campaignPath(campaign)}/goals`, invalid);
    expect(response.status(), await response.text()).toBe(422);
  }
  expect(await api.get(`${campaignPath(campaign)}/goals`)).toEqual([]);
  await api.post(`${campaignPath(campaign)}/goals`, firstGoal);

  await openCampaign(page, api, campaign);
  const goals = panel(page, 'Market goals');
  const deadline = at(10).slice(0, 16);
  await goals.getByRole('combobox', { name: 'Market', ...exact }).selectOption(us.id);
  await fillGoal(goals, '250', deadline, '25');
  const pending = mutation(page, api, `${campaignPath(campaign)}/goals`);
  await goals.getByRole('button', { name: 'Save goal', ...exact }).click();
  const created = await saved(pending);
  expect(created).toMatchObject({ campaign_id: campaign.id, campaign_market_id: us.id, metric_key: campaignViews,
    unit: 'count', baseline_value: 25, target_value: 250, due_at: `${deadline}:00.000Z`,
  });
  const readback = await api.get(`${campaignPath(campaign)}/goals`);
  expect(readback).toHaveLength(2);
  expect(readback).toEqual(expect.arrayContaining([
    expect.objectContaining({ campaign_id: campaign.id, ...firstGoal }), expect.objectContaining({ id: created.id, campaign_id: campaign.id }),
  ]));
  await page.reload();
  for (const [market, target] of [['Taiwan market', '120'], ['US market', '250']]) {
    const row = goals.getByRole('row').filter({ has: page.getByRole('cell', { name: market, ...exact }) });
    await expect(row.getByRole('cell', { name: target, ...exact })).toBeVisible();
  }
});

async function addApprovedRevision(api, brief, content) {
  const revision = await api.post(`/briefs/${brief.id}/revisions`, { body_doc: doc(content) }, brief.version);
  const path = `/brief-revisions/${revision.id}`;
  const submitted = await api.post(`${path}/submit`, {}, revision.version);
  return api.post(`${path}/approve`, {}, submitted.version);
}

function milestoneFixture(api, campaign, title, due_at) {
  return api.post(`${campaignPath(campaign)}/milestones`, { title, due_at, gate: 'ready_for_scheduling', assignee_id: api.session.user.id });
}

test('CA02 | Completing a workspace milestone unlocks scheduling and preserves brief history', async ({ page, dev }) => {
  const api = await workspace(page, dev);
  const campaign = await campaignFixture(api, 'Production launch');
  const original = 'First approved creative direction';
  const latest = 'Revised creative direction';
  const brief = await api.post(`${campaignPath(campaign)}/briefs`, { title: 'Creative brief' });
  const first = await addApprovedRevision(api, brief, original);
  const [currentBrief] = await api.get(`${campaignPath(campaign)}/briefs`);
  const second = await addApprovedRevision(api, currentBrief, latest);
  const revisions = await api.get(`/briefs/${brief.id}/revisions`);
  expect(revisions.map(row => [row.id, row.status, row.body_doc])).toEqual([
    [second.id, 'approved', doc(latest)], [first.id, 'superseded', doc(original)],
  ]);

  const due_at = at(2);
  const scheduled_at = at(4);
  const milestone = await milestoneFixture(api, campaign, 'Production sign-off', due_at);
  const { variant } = await contentFixture(api, campaign, 'Campaign creative', due_at);
  const account = await socialAccount(api, 'Local production account', '101');
  const target = await targetFixture(api, account, variant, scheduled_at);
  const before = await api.get(campaignPath(campaign));
  expect(before.progress).toMatchObject({ completed_tasks: 0, publish_targets: 1, published: 0 });
  expect(before.calendar.publication).toEqual([{ publish_target_id: target.id, scheduled_at, status: 'scheduled' }]);

  await openCampaign(page, api, campaign);
  const history = panel(page, 'Brief history');
  await expect(history.getByText(original, exact)).toBeVisible();
  await expect(history.getByText(latest, exact)).toBeVisible();
  const task = panel(page, 'Production milestones').getByRole('row').filter({ hasText: milestone.title });
  await expect(task.locator('time')).toHaveAttribute('datetime', due_at);
  const targetRow = panel(page, 'Channel matrix').getByRole('row').filter({ hasText: target.id });
  await expect(targetRow.locator('time')).toHaveAttribute('datetime', scheduled_at);
  await expect(task.getByText('Ready for scheduling', exact)).toHaveCount(0);
  const start = mutation(page, api, `/work-items/${milestone.id}`, 'PATCH');
  await task.getByRole('button', { name: 'Start work item', ...exact }).click();
  expect(await saved(start)).toMatchObject({ id: milestone.id, status: 'in_progress' });
  const complete = mutation(page, api, `/work-items/${milestone.id}/complete`);
  await task.getByRole('button', { name: 'Complete work item', ...exact }).click();
  await saved(complete);
  await expect(task.getByText('Ready for scheduling', exact)).toBeVisible();
  expect(await api.get(`/work-items/${milestone.id}`)).toMatchObject({ status: 'done', due_at });
  const after = await api.get(campaignPath(campaign));
  expect(after.progress).toMatchObject({ completed_tasks: 1, publish_targets: 1, published: 0 });
  expect(after.calendar).toEqual(before.calendar);
  expect(await api.get('/platform-posts')).toEqual([]);
});

test('CA03 | Channel matrix counts three accounts for one variant and flags unplanned content', async ({ page, dev }) => {
  const api = await workspace(page, dev);
  const campaign = await campaignFixture(api, 'Three-account launch');
  const scheduled_at = at(5);
  const shared = await contentFixture(api, campaign, 'Shared campaign caption');
  const unplanned = await contentFixture(api, campaign, 'Off-plan campaign caption');
  const accounts = [];
  for (const name of ['North channel', 'Central channel', 'South channel']) {
    const account = await socialAccount(api, name, String(201 + accounts.length));
    accounts.push({ id: account.id, name });
    await api.post(`${campaignPath(campaign)}/plan-slots`, { stage: 'launch', platform: 'meta_facebook', social_account_id: account.id, planned_count: 1 });
    await targetFixture(api, account, shared.variant, scheduled_at);
  }
  const matrix = await api.get(`${campaignPath(campaign)}/matrix`);
  expect(matrix.cells).toHaveLength(3);
  for (const cell of matrix.cells) {
    expect(cell.counts).toMatchObject({ scheduled: 1, published: 0 });
    expect(cell.actual).toEqual([expect.objectContaining({ social_account_id: cell.slot.social_account_id,
      content_variant_id: shared.variant.id, scheduled_at, status: 'scheduled' })]);
  }
  expect(matrix.outside_plan).toEqual([expect.objectContaining({ content_variant_id: unplanned.variant.id, scheduled_at: null })]);

  await openCampaign(page, api, campaign);
  const channel = panel(page, 'Channel matrix');
  const targets = channel.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Content variant', ...exact }) });
  await expect(targets.getByRole('cell', { name: new RegExp(shared.variant.id) })).toHaveCount(3);
  for (const account of accounts) {
    const row = targets.getByRole('row').filter({ has: page.getByRole('cell', { name: account.name, ...exact }) });
    await expect(row.getByRole('cell', { name: new RegExp(shared.variant.id) })).toBeVisible();
    await expect(row).not.toContainText(/Unplanned|Unscheduled/);
  }
  const outside = targets.getByRole('row').filter({ hasText: unplanned.variant.id });
  await expect(outside.getByText('Unplanned', exact)).toBeVisible();
  await expect(outside.getByText('Unscheduled', exact)).toBeVisible();
});

test('CA04 | Budget keeps planned, committed and spent separate and overrun permits other work', async ({ page, dev }) => {
  const api = await workspace(page, dev);
  const campaign = await campaignFixture(api, 'Overrun budget launch');
  const fx_date = '2025-01-08';
  const path = campaignPath(campaign);
  const line = await api.post(`${path}/budget-lines`, { category: 'production', amount_minor: 1000, currency: 'USD', fx_date });
  const twdLine = await api.post(`${path}/budget-lines`, { category: 'sample', amount_minor: 2700, currency: 'TWD', fx_date: '2025-01-09' });
  const commitment = await api.post(`${path}/cost-commitments`, { budget_line_id: line.id,
    source_ref: { type: 'external_po', id: 'local-quote' }, amount_minor: 600, currency: 'USD', fx_date, status: 'committed' });
  const cost = await api.post(`${path}/cost-entries`, { budget_line_id: line.id, source: 'manual',
    amount_minor: 800, currency: 'USD', incurred_on: fx_date });
  expect(commitment).toMatchObject({ amount_minor: 600, currency: 'USD', fx_date, status: 'committed' });
  expect(cost).toMatchObject({ amount_minor: 800, currency: 'USD', incurred_on: fx_date, fx_date });
  expect(await api.get(`${path}/budget-summary`)).toMatchObject({ lines: [expect.objectContaining({ budget_line_id: line.id, currency: 'USD', fx_date,
    budget_minor: 1000, committed_minor: 600, actual_minor: 800, remaining_minor: -400, overrun_minor: 400 }),
  expect.objectContaining({ budget_line_id: twdLine.id, currency: 'TWD', fx_date: '2025-01-09', budget_minor: 2700,
    committed_minor: 0, actual_minor: 0, remaining_minor: 2700, overrun_minor: 0 })] });
  expect(await api.get(`${path}/budget-approvals`)).toEqual([expect.objectContaining({ status: 'pending' })]);

  await openCampaign(page, api, campaign);
  const budget = panel(page, 'Campaign budget');
  const table = budget.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Planned', ...exact }) });
  const expected = { Planned: '1,000', Committed: '600', Spent: '800', Currency: 'USD', 'FX date': fx_date, Overrun: '400' };
  const headers = table.getByRole('columnheader');
  const budgetRow = table.getByRole('row', { name: /production USD 2025-01-08/ });
  await expect(budgetRow).toBeVisible();
  const columnNames = await headers.allTextContents();
  for (const [label, value] of Object.entries(expected)) {
    expect(columnNames).toContain(label);
    await expect(budgetRow.getByRole('cell').nth(columnNames.indexOf(label))).toHaveText(value);
  }

  await expect(table.getByRole('row', { name: /sample TWD 2025-01-09 2,700 0 0 0 0/ })).toBeVisible();

  const goals = panel(page, 'Market goals');
  await fillGoal(goals, '100', campaign.ends_at.slice(0, 16));
  const pending = mutation(page, api, `${campaignPath(campaign)}/goals`);
  await goals.getByRole('button', { name: 'Save goal', ...exact }).click();
  expect(await saved(pending)).toMatchObject({ campaign_id: campaign.id, metric_key: campaignViews });
  await expect(goals.getByRole('cell', { name: '100', ...exact })).toBeVisible();
  await expect(table.getByRole('cell', { name: '400', ...exact })).toBeVisible();
});



test('CA05 | Short links and content lead back to one campaign with separate clicks and coupon uses', async ({ page, dev }) => {
  const api = await workspace(page, dev);
  const campaign = await campaignFixture(api, 'Trackable launch', { utm_key: 'trackable-launch' });
  const path = campaignPath(campaign);
  const { item } = await contentFixture(api, campaign, 'Trackable campaign caption');
  const domain_id = api.seedExternal('link_domain', { hostname: 'campaign-links.example.test', verification_status: 'verified', tls_status: 'active' });
  await api.post('/redirect-allowlist', { hostname: 'shop.example.com' });
  const link = await api.post(`${path}/links`, { domain_id, code: 'trackable-launch', content_item_id: item.id,
    destination_url: 'https://shop.example.com/sale', utm_params: { utm_source: 'facebook' } });
  const detail = await api.get(`/short-links/${link.id}`);
  expect(detail).toMatchObject({ campaign_id: campaign.id, content_item_id: item.id });
  expect(new URL(detail.revisions[0].final_url).searchParams.get('utm_campaign')).toBe(campaign.utm_key);
  expect((await api.get(`/content-items/${item.id}`)).item).toMatchObject({ campaign_id: campaign.id });
  const store = await api.post('/stores', { provider: 'shopify', name: 'Local sales store', brand_id: api.brand.id, default_currency: 'USD', default_locale: 'en' });
  const promotion = await api.post('/promotions', { store_id: store.id, name: 'Trackable coupon', campaign_id: campaign.id,
    valid_from: at(-1), valid_until: at(7), state: 'scheduled', rule: { percent_off: 10 }, codes: [{ code: 'TRACK10' }] });
  api.seedExternal('click_event', { short_link_id: link.id, revision_id: link.current_revision_id,
    occurred_at: at(0), classification: 'human_likely' });
  for (const suffix of ['a', 'b']) {
    const order_id = api.seedExternal('order', { store_id: store.id, external_order_id: `local-order-${suffix}` });
    api.seedExternal('discount_usage', { order_id, promotion_id: promotion.id, code: 'TRACK10' });
  }
  expect(await api.get(`/short-links/${link.id}/stats`)).toMatchObject({ items: [expect.objectContaining({ redirects: 1 })] });
  expect(await api.get(`/promotions/${promotion.id}`)).toMatchObject({ usage_count: 2 });
  expect(await api.get(`${path}/tracking-summary`)).toMatchObject({ campaign_id: campaign.id,
    clicks: { items: [expect.objectContaining({ redirects: 1 })] }, observed_coupon_usage_count: 2,
    links: [expect.objectContaining({ id: link.id })], content_items: [expect.objectContaining({ id: item.id })],
    promotions: [expect.objectContaining({ promotion_id: promotion.id, observed_usage_count: 2 })],
  });

  await openCampaign(page, api, campaign);
  const section = panel(page, 'Campaign tracking');
  const counts = section.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Clicks', ...exact }) });
  await expect(counts.getByRole('columnheader', { name: 'Coupon uses', ...exact })).toBeVisible();
  await expect(counts.getByRole('row').nth(1).getByRole('cell').nth(0)).toHaveText('1');
  await expect(counts.getByRole('row').nth(1).getByRole('cell').nth(1)).toHaveText('2');
  for (const [linkLocator, detailUrl] of [
    [section.getByRole('link').and(page.locator(`a[href$="id=${link.id}"]`)), `${api.baseUrl}/traffic?tab=links&id=${link.id}`],
    [section.getByRole('link', { name: item.title, ...exact }), `${api.baseUrl}/content/items/${item.id}`],
  ]) {
    await linkLocator.click();
    await expect(page).toHaveURL(detailUrl);
    await page.getByRole('link', { name: campaign.name, ...exact }).click();
    await expect(page).toHaveURL(`${api.baseUrl}/campaigns/${campaign.id}`);
    await expect(section.getByRole('heading', { name: 'Campaign tracking', ...exact })).toBeVisible();
  }
});

async function registerPost(api, campaign, published_at) {
  const account = await socialAccount(api, 'Local reporting account', '451');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzQAAAAASUVORK5CYII=', 'base64');
  const ticket = await api.post('/files/uploads', { purpose: 'evidence', mime_type: 'image/png', size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  const evidence = await api.post(`/files/uploads/${ticket.id}/complete`, { base64: bytes.toString('base64') });
  return api.post('/platform-posts/register', { social_account_id: account.id, campaign_id: campaign.id, external_post_id: '452',
    permalink: 'https://www.facebook.com/451/posts/452', published_at, evidence_file_ids: [evidence.id] });
}

test('CA06 | Backfill creates a new report for a closed campaign and templates omit historical prices and rights', async ({ page, dev }) => {
  const api = await workspace(page, dev);
  const anchor = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const campaignTime = offset => new Date(anchor + offset * day).toISOString();
  let campaign = await campaignFixture(api, 'Closed collection launch', { starts_at: campaignTime(-10), ends_at: campaignTime(2), goals: [goal(campaignTime(1))] });
  const path = campaignPath(campaign);
  const sensitiveNote = 'Historical price USD 19.25 and authorization rights-old-license';
  const brief = await api.post(`${path}/briefs`, { title: 'Old campaign brief' });
  await addApprovedRevision(api, brief, sensitiveNote);
  const templateOffset = campaignTime(-5);
  await api.post(`${path}/plan-slots`, { stage: 'launch', platform: 'facebook', planned_count: 2, window_start: templateOffset, note: sensitiveNote });
  const milestone = await milestoneFixture(api, campaign, 'Expired rights rights-old-license', templateOffset);
  const published_at = campaignTime(-7);
  const publication = await registerPost(api, campaign, published_at);
  const observe = (ageHours, value) => api.post('/metrics/observations', { observations: [{ metric_key: views,
    subject_type: 'platform_post', subject_id: publication.id,
    observed_at: new Date(Date.parse(published_at) + ageHours * 3_600_000).toISOString(), value,
    dims: { campaign_id: campaign.id }, availability: 'observed', source: { method: 'manual_import' },
  }] });
  await observe(23, 15);
  const report = await api.post('/reports', { title: 'Collection campaign report', kind: 'campaign',
    scope: { campaign_ids: [campaign.id] }, period: { from: at(-9).slice(0, 10), to: at(-1).slice(0, 10), tz: 'UTC' },
    sections: [{ key: 'views', type: 'table', query: { metrics: [views], subject: { type: 'platform_post', filter: { subject_ids: [publication.id] } },
      time: { basis: 'published_at' }, age_bucket: '24h' } }],
  });
  const draft = await completedReportVersion(api.get, await api.post(`/reports/${report.id}/versions`, {}));
  const frozen = await api.post(`/report-versions/${draft.id}/finalize`, {}, draft.version);
  for (const state of ['planned', 'active', 'wrapping']) campaign = await transition(api, campaign, state);
  await openCampaign(page, api, campaign);
  const closeoutPanel = panel(page, 'Closeout');
  const preview = mutation(page, api, `${path}/closeout/draft`);
  await closeoutPanel.getByRole('button', { name: 'Review closeout checklist', ...exact }).click();
  expect((await saved(preview)).facts.unfinished).toEqual([expect.objectContaining({ type: 'work_item', id: milestone.id })]);
  await closeoutPanel.getByRole('combobox', { name: 'Report version for closeout', ...exact }).selectOption(frozen.id);
  await closeoutPanel.getByLabel('Retrospective', exact).fill('Keep the same production rhythm next season.');
  await closeoutPanel.getByLabel(new RegExp(`Reason to retain.*${milestone.id}`)).fill('Retained for follow-up');
  await closeoutPanel.getByLabel('Closeout checklist reviewed', exact).check();
  const close = mutation(page, api, `${path}/closeout`);
  await closeoutPanel.getByRole('button', { name: 'Close campaign', ...exact }).click();
  const closeout = await saved(close);
  expect((await api.get(path)).status).toBe('closed');
  expect(closeout.report_version_id).toBe(frozen.id);
  await observe(24, 75);

  const firstVersion = closeoutPanel.getByRole('row').filter({ hasText: 'Version 1' });
  await expect(firstVersion.getByText('Used for closeout', exact)).toBeVisible();
  const pending = mutation(page, api, `${path}/reports/${report.id}/backfill`);
  await closeoutPanel.getByRole('button', { name: 'Backfill report', ...exact }).click();
  const backfill = await saved(pending);
  expect(backfill.id).not.toBe(frozen.id);
  expect(backfill).toMatchObject({ report_id: report.id, version_no: 2 });
  const reportValue = version => version.results[0].data.rows[0].values[views].value;
  expect(reportValue(frozen)).toBe(15);
  expect(reportValue(backfill)).toBe(75);
  await expect(closeoutPanel.getByRole('row').filter({ hasText: 'Version 2' })).toBeVisible();
  await expect(firstVersion.getByText('Used for closeout', exact)).toBeVisible();
  await expect(closeoutPanel.getByText(/^closed$/i)).toBeVisible();
  expect(await api.get(`${path}/closeout`)).toEqual(closeout);
  expect((await api.get(path)).status).toBe('closed');

  await closeoutPanel.getByLabel('Template name', exact).fill('Reusable collection structure');
  const saveTemplate = mutation(page, api, `${path}/templates`);
  await closeoutPanel.getByRole('button', { name: 'Save campaign template', ...exact }).click();
  const template = await saved(saveTemplate);
  expect(JSON.stringify(template.structure)).not.toMatch(/19\.25|rights-old-license/);
  const nextStart = at(20).slice(0, 16);
  await closeoutPanel.getByLabel('New campaign name', exact).fill('Next collection draft');
  await closeoutPanel.getByLabel('Starts at', exact).fill(nextStart);
  const reuse = mutation(page, api, `/campaign-templates/${template.id}/instantiate`);
  await closeoutPanel.getByRole('button', { name: 'Create campaign from template', ...exact }).click();
  const reused = await saved(reuse);
  expect(reused).toMatchObject({ status: 'draft', template_id: template.id });
  expect(reused.utm_key).not.toBe(campaign.utm_key);
  const context = await api.get(campaignPath(reused));
  const nextOffset = new Date(Date.parse(reused.starts_at) + Date.parse(templateOffset) - Date.parse(campaign.starts_at)).toISOString();
  expect(context.calendar.production).toEqual([expect.objectContaining({ due_at: nextOffset })]);
  expect(context.plan_slots).toEqual([expect.objectContaining({ planned_count: 2 })]);
  expect(context.calendar.publication).toEqual([]);
  expect(JSON.stringify(context)).not.toMatch(/19\.25|rights-old-license/);
  await expect(closeoutPanel.getByRole('link', { name: 'Next collection draft', ...exact })).toBeVisible();
});
