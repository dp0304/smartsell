import { completedReportVersion } from '../acceptance/report-version.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test as base } from '@playwright/test';
import { localDev, localWithoutWorker } from './local-dev.mjs';

const test = base.extend({ dev: localDev });
const withoutWorker = base.extend({ dev: localWithoutWorker });

async function openAnalytics(page, url) {
  await page.goto(url);
  // On cold Vite runs, the HTML can load before the workspace mounts.
  await page.getByRole('heading', { name: 'Analytics & reports', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
}

test('primary Reports uses REST to show cohort exclusions and history warnings', async ({ page, dev }) => {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'analytics@example.test', name: 'Analytics operator', workspaceName: 'Analytics QA', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: session } = await setup.json();
  const wid = session.workspaces[0].id;
  const root = `${dev.origin}/api/v1/workspaces/${wid}`;
  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  expect(csrf.status()).toBe(200);
  const { csrf_token } = await csrf.json();
  const headers = () => ({ Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID() });
  const brand = await page.request.post(`${root}/brands`, { headers: headers(), data: { name: 'Analytics Brand', slug: 'analytics-test' } });
  expect(brand.ok(), await brand.text()).toBe(true);
  const { data: { id: brand_id } } = await brand.json();
  for (const [provider, name] of [['amazon_sp', 'Amazon REST store'], ['shopee', 'Shopee REST store'], ['shopify', 'Shopify REST store']]) {
    const reply = await page.request.post(`${root}/stores`, {
      headers: headers(),
      data: { provider, name, brand_id, default_currency: 'USD', default_locale: 'en-US' },
    });
    expect(reply.ok(), await reply.text()).toBe(true);
  }
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await openAnalytics(page, `${dev.origin}/w/${wid}/reports?tab=cohorts`);
  await page.locator('input[name=from]').fill('2025-01-01');
  await page.locator('input[name=to]').fill('2025-02-01');
  const pending = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/cohorts') && response.request().method() === 'GET');
  await page.getByRole('button', { name: 'Query first-purchase and repeat cohorts' }).click();
  const reply = await pending;
  expect(reply.status()).toBe(200);
  const items = (await reply.json()).data;
  expect(items.filter(item => item.excluded).map(item => item.provider).sort()).toEqual(['amazon_sp', 'shopee']);
  const summary = page.getByRole('region', { name: 'First-purchase and repeat cohorts' });
  await expect(summary.getByText('This platform cannot reliably identify repeat buyers and is excluded from first-purchase cohorts.')).toHaveCount(2);
  await expect(summary.getByText('Order history start is unknown. New customers cannot be verified.')).toBeVisible();
});

const period = { from: '2025-01-01', to: '2025-01-08', tz: 'UTC' };
async function workspace(page, dev) {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'analytics@example.test', name: 'Analytics operator', workspaceName: 'Analytics QA', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: { workspaces: [workspace] } } = await setup.json();
  const root = `${dev.origin}/api/v1/workspaces/${workspace.id}`;
  const { csrf_token } = await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json();
  const request = (method, path, data, version) => page.request.fetch(`${root}${path}`, { method, data, headers: {
    Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(), ...(version && { 'If-Match': String(version) }),
  } });
  async function call(method, path, data, version) {
    const reply = await request(method, path, data, version);
    expect(reply.ok(), await reply.text()).toBe(true);
    return (await reply.json()).data;
  }
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  return { call, request, workspace, reports: `${dev.origin}/w/${workspace.id}/reports` };
}

async function submit(page, name, path, method = 'GET', range = period) {
  await page.locator('input[name=from]').fill(range.from);
  await page.locator('input[name=to]').fill(range.to);
  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(path) && reply.request().method() === method);
  await page.getByRole('button', { name, exact: true }).click();
  const reply = await pending;
  expect(reply.status(), await reply.text()).toBe(200);
  return (await reply.json()).data;
}

// Insert normalized provider facts into the isolated local workspace before querying its real REST routes.
function seedProviderFacts(dev, run) {
  let result;
  dev.updateSnapshot(state => {
    const records = new Map(state.records);
    const { tenantId, workspaceId } = state.scope;
    const now = new Date().toISOString();
    const create = (kind, values) => {
      const id = randomUUID();
      const key = `row/${kind}/${id}`;
      const row = { id, version: 1, created_at: now, updated_at: now, ...values };
      records.set(JSON.stringify(['operation_runtime', 'record', key]), {
        id: key, module: 'operation_runtime', kind: 'record', version: 1, tenant_id: tenantId, workspace_id: workspaceId,
        created_at: now, updated_at: now, data: { value: JSON.stringify(row) },
      });
      return row;
    };
    result = run(create);
    state.records = [...records];
  });
  return result;
}

test('AN04 primary Reports keeps three overlapping attribution models and the transaction total separate', async ({ page, dev }) => {
  const { call, reports } = await workspace(page, dev);
  const brand = await call('POST', '/brands', { name: 'Attribution brand', slug: 'attribution-brand' });
  const store = await call('POST', '/stores', { provider: 'shopify', name: 'Attribution store', brand_id: brand.id,
    default_currency: 'USD', default_locale: 'en-US' });
  const { credited, link, promo, platform } = seedProviderFacts(dev, create => {
    const link = create('short_link', {});
    create('short_link_revision', { short_link_id: link.id, created_at: '2024-12-30T00:00:00Z',
      utm_params: { utm_campaign: 'launch', utm_content: 'clip' } });
    const promo = create('campaign', {});
    const platform = create('campaign', {});
    const promotion = create('promotion', { store_id: store.id, campaign_id: promo.id });
    const facts = { store_id: store.id, placed_at: '2025-01-02T00:00:00Z', currency: 'USD', financial_status: 'paid' };
    const credited = create('order', { ...facts, external_order_id: 'CREDITED', total_minor: 101, utm: { campaign: 'launch', content: 'clip' } });
    create('discount_usage', { order_id: credited.id, code: 'PROMO', amount_minor: 10, promotion_id: promotion.id });
    create('order', { ...facts, external_order_id: 'OTHER', total_minor: 49 });
    create('coverage_segment', { store_id: store.id, resource: 'refunds', status: 'complete',
      window_start: period.from, window_end: new Date(Date.now() + 86_400_000).toISOString() });
    return { credited, link, promo, platform };
  });
  for (const model_key of ['link_session', 'discount_code']) {
    expect(await call('POST', '/attribution/runs', { ...period, store_id: store.id, model_key })).toMatchObject({ orders: 2 });
  }
  expect(await call('POST', '/attribution/reported', { model_key: 'platform_reported', provider: 'shopify', rows: [{ order_id: credited.id,
    external_id: 'reported-1', credited_subject_type: 'campaign', credited_subject_id: platform.id, credited_amount_minor: 123,
    currency: 'USD', occurred_at: '2025-01-01T12:00:00Z' }] })).toMatchObject({ inserted: 1 });
  const explanation = await call('GET', `/attribution/orders/${credited.id}/explain`);
  expect(explanation.models.filter(model => model.records.length).map(model => [model.model_key, model.records[0].credited_subject_id,
    model.records[0].evidence[0].evidence_kind])).toEqual([
    ['link_session', link.id, 'order_utm'], ['discount_code', promo.id, 'discount_usage'], ['platform_reported', platform.id, 'platform_reported'],
  ]);
  await openAnalytics(page, `${reports}?tab=attribution`);
  await page.getByLabel('Store ID (optional)').fill(store.id);
  const result = await submit(page, 'Compare order attribution', '/attribution/query', 'POST');
  expect(result.transaction_totals).toEqual([{ currency: 'USD', orders: 2, net_order_minor: 150 }]);
  expect(result.rows.map(row => [row.model_key, row.credited_minor, row.uncredited_minor, row.unattributed_orders, row.reconcilable])).toEqual([
    ['link_session', 101, 49, 1, true], ['discount_code', 101, 49, 1, true], ['platform_reported', 123, null, null, false],
  ]);
  expect(result.rows[2].warning).toBe('POSSIBLE_DOUBLE_CREDIT');
  const comparison = page.getByRole('region', { name: 'Attribution comparison' });
  await expect(comparison.getByRole('listitem')).toHaveText('USD · 150 · 2 orders');
  await expect(comparison.getByRole('columnheader')).toHaveText(['Currency', 'Link session', 'Discount code', 'Platform reported']);
  const cells = comparison.getByRole('row', { name: /^USD / }).getByRole('cell');
  await expect(cells).toHaveText(['USD', /Credited · 101\s*Unattributed · 49/, /Credited · 101\s*Unattributed · 49/, /Credited · 123\s*Unattributed · —/]);
  await expect(comparison.getByText(/Platform-reported credit can overlap/)).toBeVisible();
});

test('AN07 primary Reports shows low confidence across disconnected and unknown order history', async ({ page, dev }) => {
  const { call, reports } = await workspace(page, dev);
  const brand = await call('POST', '/brands', { name: 'Cohort brand', slug: 'cohort-brand' });
  const createStore = (provider, name) => call('POST', '/stores', { provider, name, brand_id: brand.id,
    default_currency: 'USD', default_locale: 'en-US' });
  const gap = await createStore('shopify', 'History gap');
  const unknown = await createStore('shopify', 'Unknown tail');
  seedProviderFacts(dev, create => {
    for (const store of [gap, unknown]) {
      const source = create('data_source', { kind: 'store', store_id: store.id });
      const segment = (from, to, status = 'complete') => create('coverage_segment', { data_source_id: source.id, resource: 'orders', from, to, status });
      segment('2025-01-01', '2025-05-01');
      if (store.id === gap.id) {
        segment('2025-05-01', '2025-06-01', 'failed');
        segment('2025-06-01', '2025-07-01');
        segment('2025-07-01', '2025-11-01');
      }
      for (const [month, day] of [['07', '15'], ['09', '15']]) {
        const buyer = create('store_customer', { store_id: store.id, identity_verified: true, opaque_provider_id: 'private-fixture-ref' });
        create('order', { store_id: store.id, external_order_id: `${month}-purchase`, placed_at: `2025-${month}-${day}T00:00:00Z`,
          currency: 'USD', financial_status: 'paid', total_minor: 100, store_customer_id: buyer.id, customer_order_index: 1 });
      }
    }
  });
  await openAnalytics(page, `${reports}?tab=cohorts`);
  const result = await submit(page, 'Query first-purchase and repeat cohorts', '/cohorts', 'GET', { from: '2025-07-01', to: '2025-11-01' });
  const byStore = Object.fromEntries(result.map(item => [item.store_id, item]));
  expect(byStore[gap.id]).toMatchObject({ history_coverage_from: '2025-06-01T00:00:00.000Z', history_reliable_from: '2025-09-01T00:00:00.000Z',
    limitations: ['INSUFFICIENT_ORDER_HISTORY'], rows: [
      { month: '2025-07', first_seen: 1, confirmed_new: 0, new_customer_reliability: 'low', repeat_rate: 0 },
      { month: '2025-09', first_seen: 1, confirmed_new: 1, new_customer_reliability: 'high', repeat_rate: 0 },
    ] });
  expect(byStore[unknown.id]).toMatchObject({ history_coverage_from: null, history_reliable_from: null, limitations: ['HISTORY_START_UNKNOWN'], rows: [
    { month: '2025-07', first_seen: 1, confirmed_new: 0, new_customer_reliability: 'low' },
    { month: '2025-09', first_seen: 1, confirmed_new: 0, new_customer_reliability: 'low' },
  ] });
  expect(JSON.stringify(result)).not.toMatch(/private-fixture-ref|store_customer_id/);
  const cohorts = page.getByRole('region', { name: 'First-purchase and repeat cohorts' });
  const short = cohorts.locator('section').filter({ has: page.getByRole('heading', { name: 'History gap · Shopify' }) });
  const missing = cohorts.locator('section').filter({ has: page.getByRole('heading', { name: 'Unknown tail · Shopify' }) });
  await expect(short.getByText(/Order history start · 2025-06-01/)).toBeVisible();
  await expect(short.getByText('Available order history is too short to verify first purchases.')).toBeVisible();
  await expect(short.getByRole('row', { name: '2025-07 1 0 Low 0%' })).toBeVisible();
  await expect(short.getByRole('row', { name: '2025-09 1 1 High 0%' })).toBeVisible();
  await expect(missing.getByText('Order history start is unknown. New customers cannot be verified.')).toBeVisible();
  await expect(missing.getByRole('row', { name: '2025-09 1 0 Low 0%' })).toBeVisible();
});

test('AN06 contribution distinguishes missing, zero and complete inputs in the browser', async ({ page, dev }) => {
  const { call, reports } = await workspace(page, dev);
  const query = { ...period, scope: 'campaign:local', currency: 'USD' };
  const rows = Object.entries({ net_sales: 500, product_cost: 200, shipping: 0, payment_fees: 20, ad_spend: 40,
    fixed_collaboration_fees: 0, samples_and_production: 10 })
    .map(([item, amount_minor]) => ({ item, amount_minor, source_ref: `fixture:${item}`, complete: true }));
  await call('POST', '/contribution/inputs', { ...query, rows });
  await openAnalytics(page, `${reports}?tab=contribution`);
  await page.getByLabel('Scope', { exact: true }).fill(query.scope);
  const incomplete = await submit(page, 'Query estimated contribution', '/contribution');
  expect(incomplete).toMatchObject({ value_minor: null, missing_items: ['commission'], formula_version: 1 });
  const result = page.getByRole('region', { name: 'Estimated contribution result' });
  await expect(result.getByText('Estimated contribution, not financial profit.')).toBeVisible();
  await expect(result.getByText('Missing inputs · Commission')).toBeVisible();
  await expect(result.getByRole('row', { name: /Shipping.*0.*Complete.*fixture:shipping/ })).toBeVisible();
  await expect(result.getByRole('row', { name: /Commission.*—.*Missing/ })).toBeVisible();
  await call('POST', '/contribution/inputs', { ...query, rows: ['ads', 'creator'].map(source => ({ item: 'commission', amount_minor: 30,
    settlement_id: 'settlement:1', source_ref: `fixture:${source}`, complete: true })) });
  const complete = await submit(page, 'Query estimated contribution', '/contribution');
  expect(complete).toMatchObject({ value_minor: 200, missing_items: [] });
  await expect(result.getByText('Estimated contribution · USD · 200')).toBeVisible();
  await expect(result.getByText('Missing inputs', { exact: false })).toHaveCount(0);
});

test('AN05 revenue shows observed refunds separately while coverage remains incomplete', async ({ page, dev }) => {
  const { call, reports } = await workspace(page, dev);
  const brand = await call('POST', '/brands', { name: 'Settlement brand', slug: 'settlement-brand' });
  const store = await call('POST', '/stores', { provider: 'amazon_sp', name: 'Fixture store', brand_id: brand.id,
    default_currency: 'USD', default_locale: 'en-US' });
  async function importCsv(template_key, csv) {
    const batch = await call('POST', `/stores/${store.id}/imports`, { template_key, csv });
    expect(batch.stats.invalid).toBe(0);
    const merged = await call('POST', `/imports/${batch.id}/confirm`, {});
    expect(merged.status).toBe('merged');
  }
  await importCsv('order_list', 'external_order_id,placed_at,currency,total_minor,status\nCANCELLED,2025-01-02T10:00:00Z,USD,900,cancelled\nPAID,2025-01-02T10:00:00Z,USD,700,paid');
  await importCsv('refund_list', 'external_order_id,external_refund_id,external_updated_at,currency,amount_minor,status\nCANCELLED,R-1,2025-02-02T12:00:00Z,USD,900,succeeded\nPAID,R-2,2025-02-02T12:00:00Z,USD,120,pending');
  await openAnalytics(page, `${reports}?tab=revenue`);
  const result = await submit(page, 'Query revenue reconciliation', '/revenue/daily');
  expect(result.rows).toEqual([expect.objectContaining({ day: '2025-01-02', store_id: store.id, net_sales_minor: null,
    observed_refunds_requested_minor: 120, observed_refunds_succeeded_minor: 900, refunds_succeeded_minor: null,
    warnings: ['ORDER_COVERAGE_INCOMPLETE', 'REFUND_COVERAGE_INCOMPLETE'] })]);
  const reconciliation = page.getByRole('region', { name: 'Revenue reconciliation result' });
  await expect(reconciliation.getByText('Refund data incomplete')).toBeVisible();
  await expect(reconciliation.getByRole('cell', { name: '120 (observed only)' })).toBeVisible();
  await expect(reconciliation.getByRole('cell', { name: '900 (observed only)' })).toBeVisible();
});

test('DS07 frozen revenue and attribution read original import rows and legacy references', async ({ page, dev }) => {
  const { call, request, reports } = await workspace(page, dev);
  const brand = await call('POST', '/brands', { name: 'Lineage brand', slug: 'lineage-brand' });
  const store = await call('POST', '/stores', { provider: 'amazon_sp', name: 'Lineage store', brand_id: brand.id,
    default_currency: 'USD', default_locale: 'en-US' });
  async function importCsv(template_key, csv) {
    const batch = await call('POST', `/stores/${store.id}/imports`, { template_key, csv });
    expect(batch.stats.invalid).toBe(0);
    expect((await call('POST', `/imports/${batch.id}/confirm`, {})).status).toBe('merged');
    return batch;
  }
  const header = 'external_order_id,placed_at,currency,total_minor,status';
  const order = await importCsv('order_list', `${header}\nLINEAGE-ORDER,2025-01-02T10:00:00Z,USD,900,cancelled`);
  const refund = await importCsv('refund_list', 'external_order_id,external_refund_id,external_updated_at,currency,amount_minor,status\nLINEAGE-ORDER,LINEAGE-REFUND,2025-01-03T12:00:00Z,USD,900,succeeded');
  const report = await call('POST', '/reports', { title: 'Commerce lineage', kind: 'ecommerce', period, sections: [
    { key: 'sales', source: 'revenue', query: { store_id: store.id } },
    { key: 'credit', source: 'attribution', query: { store_id: store.id } },
    { key: 'notes', type: 'narrative' },
  ] });
  const draft = await completedReportVersion(path => call('GET', path), await call('POST', `/reports/${report.id}/versions`, {}));
  const frozen = await call('POST', `/report-versions/${draft.id}/finalize`, {}, draft.version);
  const path = `/report-versions/${draft.id}/commerce-provenance?section_key=`;
  expect((await request('GET', `${path}notes`)).status()).toBe(404);
  for (const [section, key] of [['sales', `2025-01-02 · ${store.id} · USD`], ['credit', 'transaction_totals · USD']]) {
    const trace = await call('GET', path + section);
    expect(trace.status).toBe('captured');
    expect(trace.rows.find(row => row.key === key)?.sources).toEqual([
      expect.objectContaining({ kind: 'order', import_batch_id: order.id, status: 'available', payload: expect.objectContaining({ external_order_id: 'LINEAGE-ORDER' }) }),
      expect.objectContaining({ kind: 'refund', import_batch_id: refund.id, status: 'available', payload: expect.objectContaining({ external_refund_id: 'LINEAGE-REFUND' }) }),
    ]);
  }
  const correction = await importCsv('order_list', `${header}\nLINEAGE-ORDER,2025-01-02T10:00:00Z,USD,950,cancelled`);
  expect(JSON.stringify(await call('GET', `${path}sales`))).not.toContain(correction.id);
  await openAnalytics(page, `${reports}/${report.id}/v/1`);
  const sales = page.getByRole('region', { name: 'Frozen section · sales' });
  const credit = page.getByRole('region', { name: 'Frozen section · credit' });
  await expect(sales.getByRole('cell', { name: '900 (observed only)' })).toBeVisible();
  await expect(credit.getByText('USD · 0 · 1 orders')).toBeVisible();
  for (const [section, rawId] of [[sales, 'LINEAGE-REFUND'], [credit, 'LINEAGE-ORDER']]) {
    await section.getByText('Trace transaction sources', { exact: true }).first().click();
    const firstRow = section.getByRole('link', { name: `Import batch ${rawId === 'LINEAGE-ORDER' ? order.id : refund.id}` }).locator('..');
    await firstRow.getByText('View source row', { exact: true }).click();
    await expect(firstRow.locator('pre')).toContainText(rawId);
  }
  expect((await call('GET', `/report-versions/${draft.id}`)).results).toEqual(frozen.results);

  // Simulate a version saved before commerce lineage existed.
  dev.updateSnapshot(state => {
    const records = new Map(state.records);
    const saved = records.get(JSON.stringify(['operation_runtime', 'record', `row/report_version/${draft.id}`]));
    const row = JSON.parse(saved.data.value);
    delete row.commerce_lineage;
    row.evidence = { sales: [{ module: 'commerce', kind: 'order', id: 'saved-reference', version: 1 }] };
    saved.data.value = JSON.stringify(row);
    state.records = [...records];
  });
  expect(await call('GET', `${path}sales`)).toEqual({ status: 'not_captured', rows: [],
    references: [{ module: 'commerce', kind: 'order', id: 'saved-reference', version: 1 }] });
  await page.reload();
  await sales.getByText('Trace transaction sources', { exact: true }).click();
  await expect(sales.getByText('Commerce sources were not captured for this version.')).toBeVisible();
  await expect(page.getByText('saved-reference', { exact: true })).toBeVisible();
  await expect(sales.getByText('View source row', { exact: true })).toHaveCount(0);
});

async function postFixtures(call) {
  const brand = await call('POST', '/brands', { name: 'Social brand', slug: 'social-brand' });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRzQAAAAASUVORK5CYII=', 'base64');
  const ticket = await call('POST', '/files/uploads', { purpose: 'evidence', mime_type: 'image/png', size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  const evidence = await call('POST', `/files/uploads/${ticket.id}/complete`, { base64: bytes.toString('base64') });
  return async (provider, external_post_id, permalink) => {
    const account = await call('POST', '/social-accounts', { provider, external_account_id: external_post_id,
      display_name: external_post_id, brand_id: brand.id, owned_account_confirmed: true });
    return call('POST', '/platform-posts/register', { social_account_id: account.id, external_post_id, permalink,
      evidence_file_ids: [evidence.id], published_at: '2025-01-01T00:00:00Z' });
  };
}

const metric = 'norm.post.views';
const observation = (post, observed_at, value, availability = 'observed') => ({
  subject_type: 'platform_post', subject_id: post.id, metric_key: metric, observed_at, value, availability,
  source: { method: 'manual_import' },
});

test('AN01/02 show native definition, separate unavailable states and keep same-age cross-platform totals split', async ({ page, dev }) => {
  const { call, reports } = await workspace(page, dev);
  const register = await postFixtures(call);
  const facebook = await register('meta_facebook', '1234', 'https://www.facebook.com/1234/posts/1234');
  const youtube = await register('youtube', '12345678901', 'https://www.youtube.com/watch?v=12345678901');
  const definitions = await call('GET', '/metric-definitions?keys=yt.video.views');
  expect(definitions.items[0]).toMatchObject({ native_name: 'views', revision: 1 });
  await openAnalytics(page, `${reports}?tab=metrics`);
  await expect(page.getByRole('columnheader', { name: 'Original name' })).toBeVisible();
  await expect(page.getByRole('row', { name: /^yt.video.views views 1 / })).toBeVisible();
  await call('POST', '/metrics/observations', { observations: [
    observation(facebook, '2025-01-01T23:00:00Z', 0), observation(youtube, '2025-01-01T22:00:00Z', 12),
    ...[['norm.post.engagements', 'no_permission'], ['norm.post.impressions', 'source_not_provided']]
      .map(([metric_key, status]) => ({ ...observation(facebook, '2025-01-02T00:00:00Z', null, status), metric_key })),
  ] });
  await openAnalytics(page, `${reports}?tab=performance`);
  await page.locator('[name=metric_keys]').fill([metric, 'norm.post.engagements', 'norm.post.impressions', 'yt.video.views'].join(','));
  const result = await submit(page, 'Compare posts at the same age', '/metrics/query', 'POST');
  expect(result.warnings).toContain('NON_ADDITIVE_ACROSS_PLATFORMS');
  expect(result.rows.map(row => [row.group.platform, row.values[metric].value])).toEqual([['facebook', 0], ['youtube', 12]]);
  const surface = page.getByRole('region', { name: 'Metric query results' });
  await expect(surface.getByText('These metrics cannot be summed across platforms. Results are kept separate.')).toBeVisible();
  const metrics = surface.getByRole('table').first();
  for (const pattern of [/facebook norm.post.views 0 Observed/, /norm.post.engagements — No permission/,
    /norm.post.impressions — Source did not provide/, /yt.video.views — Not collected/]) {
    await expect(metrics.getByRole('row', { name: pattern }).first()).toBeVisible();
  }
  const deviation = surface.getByRole('region', { name: 'Same-age observation deviation' });
  await expect(deviation.getByRole('row', { name: /facebook Nearest earlier observation 3,600 82,800/ })).toBeVisible();
  await expect(deviation.getByText('Earlier observations may understate same-age performance.', { exact: false })).toBeVisible();
  await page.locator('[name=subject_ids]').fill(facebook.id);
  const selected = await submit(page, 'Compare posts at the same age', '/metrics/query', 'POST');
  expect(selected.rows.map(row => row.group.subject_id)).toEqual([facebook.id]);
});

test('DS06 and DS07 chart marks and report provenance distinguish availability and retention', async ({ page, dev }, testInfo) => {
  const { call, request, reports } = await workspace(page, dev);
  const register = await postFixtures(call);
  const expected = [
    [0, 'observed', '0 · Observed zero', '.metric-chart-mark.zero'],
    [15, 'estimated', '15 · Estimated', '.metric-chart-mark.estimated'],
    [null, 'not_collected', '— · Not collected', null],
    [null, 'no_permission', '— · No permission', null],
    [null, 'source_not_provided', '— · Source did not provide', null],
  ];
  const posts = [];
  for (const i of expected.keys()) posts.push(await register('meta_facebook', `450${i}`, `https://www.facebook.com/450${i}/posts/450${i}`));
  const { ids } = await call('POST', '/metrics/observations', { observations: posts.map((post, i) =>
    observation(post, '2025-01-02T00:00:00Z', expected[i][0], expected[i][1])) });
  const source = await call('POST', '/data-sources', { name: 'Isolated collection fixture', kind: 'vendor', provider: 'vendor:fixture',
    contract_ref: 'fixture-terms', resources: ['post_metrics'], allowed_uses: { display: true, cache_days: 2 } });
  const { sync_run_id } = await call('POST', `/data-sources/${source.id}/refresh`, { resource: 'post_metrics' });
  const rawId = randomUUID();
  const key = (kind, id) => JSON.stringify(['operation_runtime', 'record', `row/${kind}/${id}`]);
  // Adapter results are trusted input. Seed those rows in this fixture's private SQLite snapshot.
  dev.updateSnapshot(state => {
    const rows = new Map(state.records);
    const patch = (k, data) => {
      const row = rows.get(k);
      row.data.value = JSON.stringify({ ...JSON.parse(row.data.value), ...data });
      return row;
    };
    const sync = patch(key('sync_run', sync_run_id), { status: 'succeeded' });
    patch(key('metric_observation', ids[0]), { ingest_evidence: { data_source_id: source.id, sync_run_id, raw_record_id: rawId, mapping_version: 4 } });
    rows.set(key('raw_record', rawId), { ...sync, id: `row/raw_record/${rawId}`, data: { value: JSON.stringify({ id: rawId,
      data_source_id: source.id, sync_run_id, payload: { views: 0 }, retention_until: new Date(Date.now() + 86_400_000).toISOString() }) } });
    state.records = [...rows];
  });
  const report = await call('POST', '/reports', { title: 'Metric availability', period, sections: [{ key: 'views', type: 'chart',
    query: { metrics: [metric], group_by: ['subject_id'], include_estimates: true, age_bucket: '24h',
      subject: { type: 'platform_post', filter: { subject_ids: posts.map(post => post.id) } }, time: { basis: 'published_at' } } }] });
  const saved = await completedReportVersion(path => call('GET', path), await call('POST', `/reports/${report.id}/versions`, {}));
  const path = `/report-versions/${saved.id}/provenance?observation_id=${ids[0]}`;
  expect((await request('GET', `/report-versions/${saved.id}/provenance?observation_id=unknown`)).status()).toBe(404);
  expect(await call('GET', path)).toMatchObject({ data_source_id: source.id, sync_run_id, mapping_version: 4,
    raw_evidence: { status: 'available', raw_record_id: rawId } });
  expect(saved.results[0].data.rows.find(row => row.group.subject_id === posts[0].id).values[metric]).toMatchObject({ value: 0, refs: [ids[0]] });

  const url = `${reports}/${report.id}/v/1`;
  await openAnalytics(page, url);
  const chart = page.getByRole('figure', { name: `Metric chart · ${metric}`, exact: true });
  for (const [i, [, status, label, mark]] of expected.entries()) {
    const point = chart.getByRole('listitem').filter({ hasText: posts[i].id });
    await expect(point).toHaveText(`${posts[i].id} · ${label}`);
    await expect(point).toHaveAttribute('data-availability', status);
    if (mark) await expect(point.locator(mark)).toBeVisible();
    else await expect(point.locator('.metric-chart-mark')).toHaveCount(0);
  }
  await chart.screenshot({ path: testInfo.outputPath('metric-availability.png') });
  const traceValue = page.getByRole('button', { name: `Trace value · ${metric} · ${posts[0].id}` });
  const trace = page.getByRole('region', { name: 'Ingest provenance', exact: true });
  await chart.getByRole('button', { name: `${posts[0].id} · 0 · Observed zero` }).click();
  await expect(trace.getByText(`Data source · ${source.name} · ${source.id}`)).toBeVisible();
  await expect(trace.getByText(`Sync run · ${sync_run_id} · succeeded`)).toBeVisible();
  await expect(trace.getByText('Mapping version · 4')).toBeVisible();
  await expect(trace.getByText(`Raw record · ${rawId}`)).toBeVisible();
  await expect(trace.locator('pre')).toContainText('"views": 0');

  dev.updateSnapshot(state => {
    const rows = new Map(state.records);
    const raw = rows.get(key('raw_record', rawId));
    const tombstoneId = randomUUID();
    rows.set(key('raw_record_tombstone', tombstoneId), { ...raw, id: `row/raw_record_tombstone/${tombstoneId}`,
      data: { value: JSON.stringify({ id: tombstoneId, raw_record_id: rawId, data_source_id: source.id, sync_run_id, deleted_at: new Date().toISOString() }) } });
    rows.delete(key('raw_record', rawId));
    state.records = [...rows];
  });
  expect(await call('GET', path)).toMatchObject({ sync_run_id, raw_evidence: { status: 'deleted' } });
  expect((await request('GET', `/raw-records/${rawId}`)).status()).toBe(404);
  await page.reload();
  await traceValue.click();
  await expect(trace.getByText('Deleted under the retention policy')).toBeVisible();
  await expect(trace.getByText(`Sync run · ${sync_run_id} · succeeded`)).toBeVisible();
  await expect(trace.locator('pre')).toHaveCount(0);
});

test('DS07 campaign, client monthly and custom reports retain original metric evidence through scheduled cleanup', async ({ page, dev }) => {
  const { call, request, reports } = await workspace(page, dev);
  const register = await postFixtures(call);
  const post = await register('meta_facebook', '4570', 'https://www.facebook.com/4570/posts/4570');
  const { ids: [observationId] } = await call('POST', '/metrics/observations', {
    observations: [observation(post, '2025-01-02T00:00:00Z', 42, 'observed')],
  });
  const collect = async (name, views, mapping_version, retention_until) => {
    const source = await call('POST', '/data-sources', { name, kind: 'vendor', provider: 'vendor:fixture',
      contract_ref: 'fixture-terms', resources: ['post_metrics'], allowed_uses: { display: true, cache_days: 7 } });
    const { sync_run_id } = await call('POST', `/data-sources/${source.id}/refresh`, { resource: 'post_metrics' });
    const raw = seedProviderFacts(dev, create => create('raw_record', { data_source_id: source.id, sync_run_id,
      resource: 'post_metrics', payload: { views }, retention_until }));
    return { data_source_id: source.id, sync_run_id, raw_record_id: raw.id, mapping_version };
  };
  const startedAt = Date.now();
  const day = 86_400_000;
  const original = await collect('Original collection', 42, 4, new Date(startedAt + day).toISOString());
  const bind = link => dev.updateSnapshot(state => {
    const rows = new Map(state.records);
    const entry = rows.get(JSON.stringify(['operation_runtime', 'record', `row/metric_observation/${observationId}`]));
    entry.data.value = JSON.stringify({ ...JSON.parse(entry.data.value), ingest_evidence: link });
    state.records = [...rows];
  });
  bind(original);
  const published = [];
  for (const [kind, type] of [['campaign', 'kpi'], ['client_monthly', 'chart'], ['custom', 'table']]) {
    const report = await call('POST', '/reports', { title: `DS07 ${kind}`, kind, period, sections: [
      { key: 'views', type, query: { metrics: [metric], group_by: ['subject_id'], age_bucket: '24h',
        subject: { type: 'platform_post', filter: { subject_ids: [post.id] } }, time: { basis: 'published_at' } } },
      { key: 'notes', type: 'narrative' },
    ] });
    await openAnalytics(page, `${reports}?tab=reports&id=${report.id}`);
    await page.getByRole('button', { name: 'Generate report version', exact: true }).click();
    const generated = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(`/reports/${report.id}/versions`) && reply.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const reply = await generated;
    expect(reply.status(), await reply.text()).toBe(202);
    const { data: receipt } = await reply.json();
    await expect(page.getByText('Operation completed', { exact: true })).toBeVisible();
    const draft = await completedReportVersion(path => call('GET', path), receipt);
    const version = await call('POST', `/report-versions/${draft.id}/finalize`, {}, draft.version);
    expect(version.results).toHaveLength(1);
    expect(version.results[0].data.rows[0].values[metric]).toMatchObject({ value: 42, refs: [observationId] });
    published.push({ report, version, path: `/report-versions/${version.id}/provenance?observation_id=${observationId}` });
  }
  const replacement = await collect('Replacement collection', 999, 9, new Date(startedAt + 6 * day).toISOString());
  bind(replacement);
  const nextDraft = await completedReportVersion(path => call('GET', path), await call('POST', `/reports/${published.at(-1).report.id}/versions`, {}));
  const nextPath = `/report-versions/${nextDraft.id}/provenance?observation_id=${observationId}`;
  expect(await call('GET', nextPath)).toMatchObject({ data_source_id: replacement.data_source_id,
    sync_run_id: replacement.sync_run_id, mapping_version: 9, raw_evidence: { status: 'available', raw_record_id: replacement.raw_record_id } });

  const readBack = async status => {
    for (const { report, version, path } of published) {
      expect((await call('GET', `/report-versions/${version.id}`)).results).toEqual(version.results);
      expect(await call('GET', path)).toMatchObject({ data_source_id: original.data_source_id,
        sync_run_id: original.sync_run_id, mapping_version: 4, raw_record_id: original.raw_record_id, raw_evidence: { status } });
      await openAnalytics(page, `${reports}/${report.id}/v/1`);
      await page.getByRole('button', { name: `Trace value · ${metric} · ${post.id}`, exact: true }).click();
      const trace = page.getByRole('region', { name: 'Ingest provenance', exact: true });
      await expect(trace.getByText(`Data source · Original collection · ${original.data_source_id}`)).toBeVisible();
      await expect(trace.getByText(new RegExp(`Sync run · ${original.sync_run_id}`))).toBeVisible();
      await expect(trace.getByText('Mapping version · 4')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Frozen section · notes', exact: true }).getByRole('button')).toHaveCount(0);
      if (status === 'available') {
        await expect(trace.getByText(`Raw record · ${original.raw_record_id}`)).toBeVisible();
        await expect(trace.locator('pre')).toContainText('"views": 42');
      } else {
        await expect(trace.getByText('Deleted under the retention policy')).toBeVisible();
        await expect(trace.locator('pre')).toHaveCount(0);
      }
    }
  };
  await readBack('available');
  // Make the original record and the daily schedule due without expiring the browser session.
  dev.updateSnapshot(state => {
    const rows = new Map(state.records);
    const raw = rows.get(JSON.stringify(['operation_runtime', 'record', `row/raw_record/${original.raw_record_id}`]));
    raw.data.value = JSON.stringify({ ...JSON.parse(raw.data.value), retention_until: new Date(startedAt - 1000).toISOString() });
    rows.delete(JSON.stringify(['operation_runtime', 'record', 'schedule/ingest.purge_expired']));
    state.records = [...rows];
  });
  await expect.poll(async () => (await request('GET', `/raw-records/${original.raw_record_id}`)).status(), { timeout: 10_000 }).toBe(404);
  expect((await request('GET', `/raw-records/${replacement.raw_record_id}`)).status()).toBe(200);
  await readBack('deleted');
});

test('AN09 finalized conclusion links resolve to the saved result and source observation after backfill', async ({ page, dev }) => {
  const { call, request, reports } = await workspace(page, dev);
  const register = await postFixtures(call);
  const post = await register('meta_facebook', '3456', 'https://www.facebook.com/3456/posts/3456');
  const record = async (observed_at, value) => call('POST', '/metrics/observations', { observations: [observation(post, observed_at, value)] });
  const { ids: [source] } = await record('2025-01-01T23:00:00Z', 0);
  const query = { metrics: [metric], subject: { type: 'platform_post', filter: { subject_ids: [post.id] } },
    time: { basis: 'published_at' }, age_bucket: '24h' };
  const report = await call('POST', '/reports', { title: 'Frozen performance', period, sections: [{ key: 'views', type: 'table', query }] });
  const draft = await completedReportVersion(path => call('GET', path), await call('POST', `/reports/${report.id}/versions`, {}));
  const path = `/report-versions/${draft.id}`;
  const narrative = refs => ({ narrative: [{ section_key: 'views', blocks: [{ kind: 'fact', text: 'The original observation was zero.', refs }] }] });
  expect((await request('PATCH', `${path}/narrative`, narrative(['unknown-observation']), draft.version)).status()).toBe(400);
  const revised = await call('PATCH', `${path}/narrative`, narrative(['views', source]), draft.version);
  const finalized = await call('POST', `${path}/finalize`, {}, revised.version);
  expect((await request('PATCH', `${path}/narrative`, narrative(['views']), finalized.version)).status()).toBe(409);
  await record('2025-01-02T00:00:00Z', 7);
  const backfilled = await completedReportVersion(path => call('GET', path), await call('POST', `/reports/${report.id}/versions`, {}));
  expect(backfilled.results[0].data.rows[0].values[metric].value).toBe(7);
  const frozen = await call('GET', path);
  expect(frozen.results[0].data.rows[0].values[metric].value).toBe(0);
  expect(frozen.results[0].data.evidence[0].observations[0]).toMatchObject({ id: source, value: 0, definition_revision: 1 });
  await openAnalytics(page, `${reports}/${report.id}/v/1`);
  const trace = page.getByRole('region', { name: 'Report traceability' });
  await expect(trace.getByRole('heading', { name: 'Frozen report version 1 · finalized' })).toBeVisible();
  for (const [linkName, targetText] of [['View frozen section · views', 'norm.post.views'], [`View source observation · ${source}`, '2025-01-01T23:00:00.000Z']]) {
    const link = trace.getByRole('link', { name: linkName });
    await link.click();
    const target = await link.getAttribute('href');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(decodeURIComponent(target.slice(1)));
    await expect(page.locator(`:target`)).toContainText(targetText);
  }
  await expect(trace.getByRole('region', { name: 'Frozen section · views' }).getByRole('cell', { name: '0', exact: true })).toBeVisible();
});


test('AN10 primary audience view separates official, owned and estimated snapshots', async ({ page, dev }) => {
  const { call, reports } = await workspace(page, dev);
  const brand = await call('POST', '/brands', { name: 'Audience brand', slug: 'audience-brand' });
  const account = await call('POST', '/social-accounts', { provider: 'youtube', external_account_id: 'audience-fixture',
    brand_id: brand.id, display_name: 'Audience fixture', owned_account_confirmed: true });
  for (const [source, value] of [['platform', 120], ['owned_engagement', 0], ['third_party_estimate', 950]]) {
    await call('POST', '/audience-insights', { social_account_id: account.id, source, source_ref: source,
      observed_at: '2025-06-01', dimension: 'country', values: [{ bucket: 'US', value }] });
  }
  await openAnalytics(page, `${reports}?tab=audience`);
  const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Third-party estimates' }) });
  await expect(table.getByRole('columnheader')).toHaveText(['Platform data', 'Owned engagement', 'Third-party estimates']);
  const cells = table.getByRole('cell');
  await expect(cells.nth(0).locator('dd')).toHaveText('120');
  await expect(cells.nth(1).locator('dd')).toHaveText('0');
  await expect(cells.nth(2).locator('dd')).toHaveText('950');
});


test('AI05 compatibility Reports keeps finalization and the synchronous CSV download', async ({ page, dev }) => {
  const { call, workspace: { id } } = await workspace(page, dev);
  const definition = await call('POST', '/commands/analytics/reports_create', {
    title: 'Legacy report version', kind: 'custom', period,
    sections: [{ key: 'views', type: 'table', query: { metrics: ['norm.post.views'], subject: { type: 'platform_post' }, time: { basis: 'published_at' } } }],
  });
  await page.goto(`${dev.origin}/compat/workbench/w/${id}/reports?view=report&record=${definition.id}`);
  await page.getByRole('button', { name: 'Generate report version', exact: true }).click({ timeout: 20_000 });
  const dialog = page.getByRole('dialog').last();
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/commands/analytics/reports_generate_version'));
  await dialog.locator('button[type=submit]').click();
  const reply = await accepted;
  expect(reply.status(), await reply.text()).toBe(202);
  const { data: receipt } = await reply.json();
  await expect(dialog.getByRole('button', { name: 'Finalize report version', exact: true })).toBeVisible();
  const job = await call('GET', `/operations/${receipt.operation_id}`);
  expect(job.result_ref).toMatchObject({ report_id: definition.id, version_no: 1 });
  await dialog.getByRole('button', { name: 'Finalize report version', exact: true }).click();
  await dialog.locator('button[type=submit]').click();
  await dialog.getByRole('button', { name: 'Confirm operation' }).click();
  await dialog.getByRole('button', { name: 'Export report version', exact: true }).click();
  await dialog.getByLabel('File format').selectOption('csv');
  const exported = page.waitForResponse(response => response.url().endsWith('/commands/analytics/reports_export'));
  await dialog.locator('button[type=submit]').click();
  const exportResponse = await exported;
  expect(exportResponse.status(), await exportResponse.text()).toBe(200);
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download file', exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('report-v1.csv');
  expect(await readFile(await file.path(), 'utf8')).toContain('"report_version","data_cutoff_at"');
});


test('AI05 official Reports resumes a pinned export and downloads its workbook', async ({ page, dev }) => {
  const { call, reports } = await workspace(page, dev);
  const report = await call('POST', '/reports', { title: 'Published export', period, sections: [{ key: 'notes', type: 'narrative' }] });
  const generate = async text => {
    const draft = await completedReportVersion(path => call('GET', path), await call('POST', `/reports/${report.id}/versions`, {}));
    const revision = await call('PATCH', `/report-versions/${draft.id}/narrative`, {
      narrative: [{ section_key: 'notes', blocks: [{ kind: 'fact', text, refs: ['notes'] }] }],
    }, draft.version);
    return call('POST', `/report-versions/${revision.id}/finalize`, {}, revision.version);
  };
  await generate('已凍結 =測試 🌱');
  await generate('Second snapshot');
  await openAnalytics(page, `${reports}/${report.id}/v/1`);
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith(`/reports/${report.id}/versions/1/export`));
  await page.getByLabel('File format').selectOption('xlsx');
  await page.getByRole('button', { name: 'Export report', exact: true }).click();
  const reply = await accepted;
  expect(reply.status()).toBe(202);
  const { data: { operation_id } } = await reply.json();
  await page.reload();
  await expect(page.getByText(operation_id, { exact: true })).toBeVisible();
  const link = page.getByRole('link', { name: 'Download XLSX' });
  await expect(link).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await link.click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('report-v1.xlsx');
  const bytes = await readFile(await file.path());
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
  const job = await call('GET', `/operations/${operation_id}`);
  expect(job.result_ref).toMatchObject({ report_id: report.id, version_no: 1, format: 'xlsx' });
});

withoutWorker('AI05 official Reports cancels a queued export after reload', async ({ page, dev }) => {
  const { call, reports } = await workspace(page, dev);
  const report = await call('POST', '/reports', { title: 'Queued export', period, sections: [{ key: 'notes', type: 'narrative' }] });
  seedProviderFacts(dev, create => create('report_version', { report_id: report.id, version_no: 1, status: 'finalized',
    data_cutoff_at: '2025-01-08T00:00:00Z', results: [], narrative: [] }));
  await openAnalytics(page, `${reports}/${report.id}/v/1`);
  const queued = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/versions/1/export'));
  await page.getByRole('button', { name: 'Export report', exact: true }).click();
  const accepted = await queued;
  expect(accepted.status()).toBe(202);
  const { data: { operation_id } } = await accepted.json();
  await page.reload();
  const cancel = page.getByRole('button', { name: 'Cancel export' });
  await expect(cancel).toBeVisible();
  const cancellation = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/operations/${operation_id}/cancel`));
  await cancel.click();
  const response = await cancellation;
  expect(response.status(), await response.text()).toBe(200);
  await expect(cancel).toHaveCount(0);
  expect(await call('GET', `/operations/${operation_id}`)).toMatchObject({ status: 'cancelled' });
  await page.reload();
  await expect(page.getByText(operation_id, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveCount(0);
});
