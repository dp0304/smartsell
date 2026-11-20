import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });
const published_at = '2025-06-04T12:00:00.000Z';
const observed_at = '2025-06-05T12:00:00.000Z';
const metric_key = 'norm.post.engagements';

async function workspace(page, dev) {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'audience@example.test', name: 'Audience operator', workspaceName: 'Audience QA', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: { workspaces: [workspace] } } = await setup.json();
  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  expect(csrf.status()).toBe(200);
  const { csrf_token } = await csrf.json();
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  return {
    reports: `${dev.origin}/w/${workspace.id}/reports`,
    async call(method, path, data) {
      const reply = await page.request.fetch(`${dev.origin}/api/v1/workspaces/${workspace.id}${path}`, {
        method, data, headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID() },
      });
      expect(reply.ok(), await reply.text()).toBe(true);
      return (await reply.json()).data;
    },
  };
}

async function addComparablePosts(dev, call, account, count) {
  const ids = Array.from({ length: count }, () => randomUUID());
  // A provider readback fixture supplies the normalized content type needed for comparison.
  dev.updateSnapshot(state => {
    const { tenantId, workspaceId } = state.scope;
    for (const id of ids) {
      const key = `row/platform_post/${id}`;
      const row = { id, version: 1, created_at: published_at, updated_at: published_at, published_at,
        social_account_id: account.id, provider: 'youtube', content_type: 'video' };
      state.records.push([JSON.stringify(['operation_runtime', 'record', key]), {
        id: key, module: 'operation_runtime', kind: 'record', version: 1, tenant_id: tenantId, workspace_id: workspaceId,
        created_at: published_at, updated_at: published_at, data: { value: JSON.stringify(row) },
      }]);
    }
  });
  await call('POST', '/metrics/observations', { observations: ids.map(subject_id => ({
    subject_type: 'platform_post', subject_id, metric_key, observed_at, value: 7, availability: 'observed',
    dims: { traffic_source: 'organic' }, source: { method: 'manual_import' },
  })) });
}

async function suggest(page) {
  const pending = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith('/posting-time-recommendations') &&
    reply.request().method() === 'POST');
  await page.getByRole('button', { name: 'Suggest posting times' }).click();
  const reply = await pending;
  expect(reply.status(), await reply.text()).toBe(200);
  return (await reply.json()).data;
}

test('AN10 Reports compares audience sources and keeps a nonzero low sample on manual scheduling', async ({ page, dev }, testInfo) => {
  const { call, reports } = await workspace(page, dev);
  const brand = await call('POST', '/brands', { name: 'Audience brand', slug: 'audience-brand' });
  const account = await call('POST', '/social-accounts', { provider: 'youtube', external_account_id: 'audience-fixture',
    brand_id: brand.id, display_name: 'Audience fixture', default_timezone: 'Asia/Taipei', owned_account_confirmed: true });
  for (const [source, source_ref, date, value] of [
    ['platform', 'youtube-studio-export', '2025-06-02', 120],
    ['owned_engagement', 'owned-comment-log', '2025-06-03', 0],
    ['third_party_estimate', 'external-audience-panel', '2025-06-04', 950],
  ]) {
    await call('POST', '/audience-insights', { social_account_id: account.id, source, source_ref, dimension: 'country',
      observed_at: date, values: [{ bucket: 'US', value }, { bucket: 'JP', value: null }] });
  }
  await addComparablePosts(dev, call, account, 1);

  await page.goto(reports);
  await expect(page.getByRole('heading', { name: 'Analytics & reports', exact: true })).toBeVisible({ timeout: 20_000 });
  const reading = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith('/audience-insights') && reply.request().method() === 'GET');
  await page.getByRole('button', { name: 'Audience insights', exact: true }).click();
  expect((await reading).status()).toBe(200);
  const table = page.getByRole('table', { name: 'Audience snapshots by source' });
  await expect(table.getByRole('columnheader')).toHaveText(['Platform data', 'Owned engagement', 'Third-party estimates']);
  const columns = table.getByRole('cell');
  for (const [index, basis, ref, date, value] of [
    [0, 'Observations reported by the platform.', 'youtube-studio-export', '2025-06-02', '120'],
    [1, 'Based on owned engagement records.', 'owned-comment-log', '2025-06-03', '0'],
    [2, 'Estimates provided by an external source.', 'external-audience-panel', '2025-06-04', '950'],
  ]) {
    const column = columns.nth(index);
    await expect(column.getByText(basis, { exact: true })).toBeVisible();
    await expect(column.getByText(`Source reference · ${ref}`, { exact: true })).toBeVisible();
    await expect(column.locator('time')).toHaveAttribute('datetime', `${date}T00:00:00.000Z`);
    await expect(column.locator('dd')).toHaveText([value, 'Unavailable']);
  }
  await page.getByLabel('Source account').selectOption(account.id);
  await expect(columns.nth(2).getByText('Source reference · external-audience-panel')).toBeVisible();
  await table.screenshot({ path: testInfo.outputPath('audience-comparison.png') });

  await page.getByLabel('Start date').fill('2025-06-01');
  await page.getByLabel('End date (exclusive)').fill('2025-06-10');
  await page.getByLabel('Social account ID').fill(account.id);
  await page.getByLabel('Content type').fill('video');
  expect(await suggest(page)).toMatchObject({ recommendation: null, sample_size: 1, minimum_sample_size: 30,
    reason: 'INSUFFICIENT_COMPARABLE_OBSERVATIONS', timezone: 'Asia/Taipei' });
  const result = page.getByRole('status', { name: 'Posting time result' });
  await expect(result.getByText('Comparable posts · 1 / 30')).toBeVisible();
  await expect(result.getByText('Account time zone · Asia/Taipei')).toBeVisible();
  await expect(result.getByText('Observation period (end exclusive) · 2025-06-01 – 2025-06-10')).toBeVisible();
  await expect(result.getByText('Too few comparable posts. Continue using manual scheduling.')).toBeVisible();
  await expect(result.getByRole('table')).toHaveCount(0);
  await expect(result.getByRole('button', { name: 'Save as planning slot templates' })).toHaveCount(0);
  expect(await call('GET', `/posting-time-recommendations?social_account_id=${account.id}`)).toEqual([]);

  await addComparablePosts(dev, call, account, 29);
  const recommendation = await suggest(page);
  expect(recommendation).toMatchObject({ status: 'proposed', sample_size: 30,
    slots: [{ weekday: 'Wed', hour: 20, sample_size: 30, score: 7 }] });
  await expect(result.getByRole('row', { name: 'Wed 20 30 7' })).toBeVisible();
  const applying = page.waitForResponse(reply => new URL(reply.url()).pathname.endsWith(`/posting-time-recommendations/${recommendation.id}/apply`) &&
    reply.request().method() === 'POST');
  await result.getByRole('button', { name: 'Save as planning slot templates' }).click();
  const applied = await applying;
  expect(applied.ok(), await applied.text()).toBe(true);
  expect((await applied.json()).data).toEqual({ recommendation_id: recommendation.id, slot_template_ids: [expect.any(String)] });
  await expect(result.getByText('Saved as editable planning slot templates.')).toBeVisible();
  expect(await call('GET', `/posting-time-recommendations?social_account_id=${account.id}`)).toEqual([expect.objectContaining({
    id: recommendation.id, status: 'applied',
  })]);
});
