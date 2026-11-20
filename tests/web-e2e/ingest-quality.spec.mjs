import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });

async function workspace(page, dev) {
  const response = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'ingest@example.test', name: 'Ingest operator', workspaceName: 'Ingest QA', password: dev.password() },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { data: { workspaces: [{ id: wid }] } } = await response.json();
  const { csrf_token } = await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json();
  const api = `${dev.origin}/api/v1/workspaces/${wid}`;
  const workbench = `${dev.origin}/w/${wid}/data`;
  const post = async (path, data, method = 'POST') => {
    const reply = await page.request.fetch(`${api}${path}`, { method, data, headers: {
      Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
    } });
    expect(reply.ok(), await reply.text()).toBe(true);
    return (await reply.json()).data;
  };
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  return { api, post, workbench };
}

test('ingest workbench shows unrecoverable backfill intervals and budget pause', async ({ page, dev }) => {
  const { post, workbench } = await workspace(page, dev);
  const source = await post('/data-sources', {
    name: 'Ingest QA vendor', kind: 'vendor', provider: 'vendor:fixture', contract_ref: 'fixture-contract', resources: ['post_metrics'],
  });
  const now = new Date().toISOString();
  dev.updateSnapshot(state => {
    const id = randomUUID();
    const key = JSON.stringify(['operation_runtime', 'record', `row/vendor_usage/${id}`]);
    const sourceKey = JSON.stringify(['operation_runtime', 'record', `row/data_source/${source.id}`]);
    const sourceRecord = new Map(state.records).get(sourceKey);
    state.records.push([key, { ...sourceRecord, id: `row/vendor_usage/${id}`, data: { value: JSON.stringify({ id, version: 1, created_at: now, updated_at: now,
      data_source_id: source.id, period: now.slice(0, 7), units: 1, requests: 1, cost_minor: 0 }) } }]);
  });
  const batch = await post('/backfills', { data_source_id: source.id, resources: ['post_metrics'], from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' });
  await post('/collection-budgets', { data_source_id: source.id, cap_units: 1, on_exceed: 'pause' }, 'PUT');
  await page.goto(`${workbench}/backfills/${batch.id}`);
  await expect(page.getByText('Beyond retention · Unrecoverable')).toBeVisible();
  await expect(page.getByText('Completed shards 0 / 0')).toBeVisible();
  await page.goto(`${workbench}/sources/${source.id}`);
  await expect(page.getByText('Collection paused because the budget was reached.')).toBeVisible();
});

test('DS04 source details show the callback polling reason and clear it after recovery', async ({ page, dev }) => {
  const { post, workbench } = await workspace(page, dev);
  const source = await post('/data-sources', {
    name: 'Shopify callback source', kind: 'store', provider: 'shopify', resources: ['products'],
  });
  // Simulate an ops reachability check without contacting any provider.
  const id = randomUUID();
  const rowId = `row/callback_endpoint/${id}`;
  const key = JSON.stringify(['operation_runtime', 'record', rowId]);
  const setReachable = reachable => dev.updateSnapshot(state => {
    const records = new Map(state.records);
    const sourceKey = JSON.stringify(['operation_runtime', 'record', `row/data_source/${source.id}`]);
    records.set(key, { ...records.get(sourceKey), id: rowId, data: { value: JSON.stringify({ id, version: 1,
      created_at: source.created_at, updated_at: source.updated_at, provider: 'shopify', reachable, fallback_polling: !reachable }) } });
    state.records = [...records];
  });
  const openDetails = async () => {
    await page.locator('summary').getByText('Record data', { exact: true }).click();
    return page.locator('details[open]').filter({ hasText: 'fallback_polling_reason' });
  };
  setReachable(false);
  await page.goto(`${workbench}/sources/${source.id}`);
  await expect(await openDetails()).toContainText(/"fallback_polling_reason"\s*:\s*"callback_unreachable"/);
  setReachable(true);
  await page.reload();
  await expect(await openDetails()).toContainText(/"fallback_polling_reason"\s*:\s*null/);
});

test('corrected import links the previous batch and preserves its rejected row', async ({ page, dev }) => {
  const { api, post, workbench } = await workspace(page, dev);
  const brand = await post('/brands', { name: 'Import brand', slug: 'import-brand' });
  const store = await post('/stores', { brand_id: brand.id, name: 'Fixture store', provider: 'shopify', default_currency: 'USD', default_locale: 'en-US' });
  const csv = price => `Handle,Title,Variant SKU,Variant Price,Currency\nhat,Hat,SKU2,${price},USD`;
  const original = await post(`/stores/${store.id}/imports`, { template_key: 'product_list', csv: csv('wrong') });
  await post(`/imports/${original.id}/confirm`, {});
  const products = async () => (await (await page.request.get(`${api}/products`)).json()).data;
  expect(await products()).toEqual([]);
  await page.goto(`${workbench}?related=import&rid=${original.id}`);
  await page.getByLabel('Corrected report').setInputFiles({ name: 'corrected.csv', mimeType: 'text/csv', buffer: Buffer.from(csv('12.30')) });
  await page.getByRole('button', { name: 'Preview corrected report' }).click();
  const previous = page.getByRole('link', { name: 'View previous batch and its errors' });
  await expect(previous).toBeVisible();
  const correctionId = new URL(page.url()).searchParams.get('rid');
  expect(correctionId).not.toBe(original.id);
  const corrected = (await (await page.request.get(`${api}/imports/${correctionId}`)).json()).data;
  expect(corrected.supersedes_batch_id).toBe(original.id);
  expect(corrected.stats.valid).toBe(1);
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
  const reviewed = page.getByRole('checkbox', { name: 'I reviewed the preview. Invalid and duplicate rows will be skipped.' });
  await reviewed.check();
  await reviewed.locator('xpath=ancestor::form').getByRole('button', { name: 'Confirm import', exact: true }).click();
  await expect.poll(products).toMatchObject([{ title: 'Hat', store_id: store.id }]);
  await previous.click();
  await expect(page.getByRole('row').filter({ hasText: /invalid/i })).toContainText('2');
  const error = (await (await page.request.get(`${api}/imports/${original.id}/error-file`)).json()).data;
  expect(error.csv).toContain('wrong');
});
