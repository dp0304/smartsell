import { randomUUID } from 'node:crypto';
import { expect, test as baseTest } from '@playwright/test';
import { localDev } from '../../../tests/web-e2e/local-dev.mjs';

const test = baseTest.extend({ dev: localDev });

test('analytics workbench shows history and sample reasons and keeps model credits separate', async ({ page, dev: { origin: base, setupToken } }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/compat/workbench`);
  await expect(page).toHaveURL(`${base}/compat/workbench/login`);
  await page.getByLabel('介面語言').selectOption('en');
  await page.getByRole('link', { name: 'First time? Set up a workspace' }).click();
  await page.getByLabel('Your name').fill('Analytics Operator');
  await page.getByLabel('Workspace name').fill('Analytics QA');
  await page.getByLabel('Email').fill('analytics-test@example.test');
  await page.getByLabel('Password').fill('analytics-test-password');
  await page.getByLabel(/Setup token/).fill(setupToken);
  await page.getByRole('button', { name: 'Set up SmartSell' }).click();
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  const workspace = new URL(page.url()).pathname.split('/w/')[1].split('/')[0];
  const root = `${base}/api/v1/workspaces/${workspace}`;
  const run = async (module, action, data) => {
    const reply = await page.request.post(`${root}/commands/${module}/${action}`, { headers: { Origin: base, 'Idempotency-Key': randomUUID() }, data });
    expect(reply.ok(), await reply.text()).toBe(true);
    return (await reply.json()).data;
  };
  const store = await run('commerce', 'create_store', { name: 'Amazon browser store', provider: 'amazon_sp', default_currency: 'USD', default_locale: 'en-US' });
  await run('commerce', 'create_store', { name: 'Shopify browser store', provider: 'shopify', default_currency: 'USD', default_locale: 'en-US' });
  const brand = await run('workspace', 'create_brand', { name: 'Analytics Brand', slug: 'analytics-brand' });
  const account = await run('account', 'register_account', { brand_id: brand.id, provider: 'youtube', name: 'Analytics YouTube',
    external_account_id: 'analytics-browser-account', default_timezone: 'UTC', owned_account_confirmed: true });
  const placed = new Date(Date.now() - 86_400_000).toISOString();
  const preview = await run('commerce', 'preview_import', { store_id: store.id, template_key: 'order_list',
    csv: `external_order_id,placed_at,currency,total_minor,financial_status\nORDER-A,${placed},USD,101,paid\nORDER-B,${placed},USD,49,paid` });
  await run('commerce', 'commit_import', { batch_id: preview.batch_id, expected_version: preview.version });
  const queryPeriod = { from: placed, to: new Date().toISOString(), tz: 'UTC' };
  const comparisonBeforeEvidence = await run('analytics', 'attribution_query', { period: queryPeriod });
  const credited = comparisonBeforeEvidence.rows.find(row => row.order_total_minor === 101);
  expect(credited?.order_id).toBeTruthy();
  for (const [kind, subject_id] of [['link_session', 'browser-link'], ['discount_code', 'browser-code'], ['platform_reported', 'browser-platform']]) {
    await run('analytics', 'record_attribution_evidence', { order_id: credited.order_id, subject_type: 'campaign', subject_id, evidence_kind: kind,
      occurred_at: placed, source_ref: `browser:${kind}`, ...(kind === 'platform_reported' ? { reported_amount_minor: 123, currency: 'USD' } : {}) });
  }
  const period = JSON.stringify({ from: placed, to: new Date().toISOString(), tz: 'UTC' });
  const choose = async action => {
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption(`analytics.${action}`);
  };
  const submit = () => page.getByRole('button', { name: 'Run command' }).click();
  const close = () => page.getByRole('button', { name: 'Close', exact: true }).click();

  await choose('cohorts_list');
  await page.locator('textarea[name=period]').fill(period);
  await submit();
  const cohorts = page.getByRole('region', { name: 'First-purchase and repeat cohorts' });
  await expect(cohorts.getByText('This platform cannot reliably identify repeat buyers and is excluded from first-purchase cohorts.')).toBeVisible();
  await expect(cohorts.getByText('Order history start is unknown. New customers cannot be verified.')).toBeVisible();
  await close();

  await choose('attribution_query');
  await page.locator('textarea[name=period]').fill(period);
  await submit();
  const comparison = page.getByRole('region', { name: 'Attribution comparison' });
  await expect(comparison.getByText('USD · 150 · 2 orders')).toBeVisible();
  for (const model of ['Link session', 'Discount code', 'Platform reported']) await expect(comparison.getByRole('columnheader', { name: model })).toBeVisible();
  await expect(comparison.getByText('Unattributed · 49')).toHaveCount(2);
  await expect(comparison.getByText('browser-platform · 123')).toBeVisible();
  await close();

  await choose('posting_time_suggest');
  await page.locator('select[name=social_account_id]').selectOption(account.id);
  await page.getByLabel('Content type').fill('video');
  await page.locator('textarea[name=period]').fill(period);
  await submit();
  await expect(page.getByText('Too few comparable posts. Continue using manual scheduling. 0 / 30')).toBeVisible();
});
