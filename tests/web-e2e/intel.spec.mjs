import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });
test.beforeEach(({ page }) => {
  page.on('pageerror', error => console.error(`Desktop page error: ${error.message}`));
});
const at = (day, hour = 0) => `2025-02-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

async function workspace(page, dev) {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { 'x-setup-token': dev.setupToken },
    data: { email: 'intel-owner@example.test', name: 'Research owner', workspaceName: 'Intel acceptance', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const session = (await setup.json()).data;
  const root = `/w/${session.workspaces[0].id}`;
  const api = `${dev.origin}/api/v1/workspaces/${session.workspaces[0].id}`;
  const csrf = (await (await page.request.get(`${dev.origin}/api/v1/session/csrf`)).json()).csrf_token;
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  async function rest(path, method = 'GET', data, version, expected = 200) {
    const response = await page.request.fetch(`${api}${path}`, { method, data,
      headers: { origin: dev.origin, 'x-csrf-token': csrf, 'idempotency-key': randomUUID(), ...(version && { 'if-match': String(version) }) } });
    expect(response.status(), await response.text()).toBe(expected);
    return (await response.json()).data;
  }
  return { root, rest, go: path => page.goto(`${dev.origin}${root}/${path}`) };
}

test('desktop shows source coverage, missing private metrics and the selected post age', async ({ page, dev }) => {
  const { go, rest } = await workspace(page, dev);
  await go('research');
  await page.getByText('New watch target', { exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Field coverage fixture');
  await page.getByLabel('Keywords (comma separated)').fill('refill');
  await page.getByLabel('Coverage note').fill('Public posts submitted by the workspace');
  await page.getByRole('button', { name: 'Create watch target' }).click();
  await page.getByRole('button', { name: 'Field coverage fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Acquisition and coverage' })).toBeVisible();
  await expect(page.getByText('Public posts submitted by the workspace', { exact: true })).toBeVisible();
  const [target] = await rest('/watch-targets');
  for (const [slug, published, likes] of [['fresh-post', at(9, 20), 0], ['older-post', at(6), 22]]) {
    await rest('/observations', 'POST', { watch_target_id: target.id, url: `https://example.test/${slug}`,
      external_id: slug, subject_type: 'post', observed_at: at(10), published_at: published, metrics: { likes: { availability: 'observed', value: likes } } });
  }
  await page.reload();
  await expect(page.getByRole('link', { name: 'older-post' })).toBeVisible();
  await page.getByLabel('Post age at observation').selectOption('0-24h');
  await page.getByRole('combobox', { name: 'Metric', exact: true }).selectOption('reach');
  await page.getByLabel('Availability').selectOption('source_not_provided');
  await page.getByRole('button', { name: 'Filter observations' }).click();
  await expect(page.getByRole('link', { name: 'older-post' })).toHaveCount(0);
  const row = page.getByRole('row').filter({ hasText: 'fresh-post' });
  await expect(row.getByRole('cell', { name: '0', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: 'Source did not provide', exact: true })).toHaveCount(3);
  await expect(row.getByText('Manual observation')).toBeVisible();
  await go('research/compare');
  await page.getByLabel('Watch targets (select multiple)').selectOption(target.id);
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Field coverage fixture' })).toContainText('0 (1)');
});

test('desktop resolves a saved evidence snapshot, displays periods and keeps creative links out of assets', async ({ page, dev }) => {
  const { go, rest } = await workspace(page, dev);
  const target = await rest('/watch-targets', 'POST', { name: 'Refill watch', target_type: 'keyword', query: { keywords: ['refill'] } });
  const snapshots = [];
  for (const [day, comments] of [[3, 1], [4, 2], [10, 3], [11, 7]]) {
    snapshots.push(await rest('/observations', 'POST', { watch_target_id: target.id, url: 'https://example.test/refill-evidence',
      subject_type: 'post', observed_at: at(day), published_at: at(1), attributes: { title: 'Refill details' }, metrics: { comments: { availability: 'observed', value: comments } } }));
  }
  const board = await rest('/research-boards', 'POST', { title: 'Refill board' });
  const citation = await rest(`/research-boards/${board.id}/items`, 'POST', { item_type: 'observation', ref_id: snapshots[2].id, title: 'Refill snapshot', stance: 'evidence' });
  await rest(`/research-boards/${board.id}/notes`, 'POST', { title: 'Refill finding', body: 'Evidence-backed finding', stance: 'demand', evidence_refs: [citation.id] });
  const topic = await rest('/topics', 'POST', { name: 'Refill trend', keywords: ['refill'] });
  await go(`research/boards/${board.id}`);
  await expect(page.getByText('Evidence-backed finding', { exact: true })).toBeVisible();
  await page.getByText('View exact citations').first().click();
  await expect(page.getByText(snapshots[2].id, { exact: true })).toBeVisible();
  await page.getByText('Export research digest', { exact: true }).click();
  await page.getByLabel('Start date (UTC)', { exact: true }).fill('2025-01-01');
  await page.getByLabel('End date (UTC, exclusive)', { exact: true }).fill('2100-01-01');
  await page.getByRole('button', { name: 'Generate research digest' }).click();
  const download = page.getByRole('link', { name: 'Download JSON' });
  await expect(download).toHaveAttribute('download', /research-digest-.+\.json/);
  expect(decodeURIComponent(await download.getAttribute('href'))).toContain(snapshots[2].id);
  await go(`research/trends/${topic.id}`);
  await page.locator('input[name="from"]').fill('2025-02-08T00:00');
  await page.locator('input[name="to"]').fill('2025-02-15T00:00');
  await page.getByRole('button', { name: /Compare|Calculate/i }).click();
  await expect(page.getByRole('columnheader', { name: /Current period/ }).locator('time').first()).toHaveAttribute('datetime', /2025-02-08/);
  await expect(page.getByRole('columnheader', { name: /Previous period/ }).locator('time').first()).toHaveAttribute('datetime', /2025-02-01/);
  const creative = await rest('/creative-references', 'POST', { url: 'https://example.test/research-only-creative', watch_target_id: target.id });
  await go('research/creatives');
  await expect(page.getByText('Reference only', { exact: true })).toBeVisible();
  await page.getByText('Annotate manually').first().click();
  await page.getByRole('article').getByLabel('Hook', { exact: true }).fill('Open with a refill demonstration');
  await page.getByRole('button', { name: 'Save annotation' }).click();
  await expect(page.getByText('Open with a refill demonstration', { exact: true })).toBeVisible();
  await expect(page.getByText('Annotation source · Human', { exact: true })).toBeVisible();
  const assets = await rest('/assets?usage=organic');
  expect(JSON.stringify(assets)).not.toContain(creative.id);
  expect(JSON.stringify(assets)).not.toContain('research-only-creative');
});

test('desktop retains separate costs and decision rationale and escalates manually without a model', async ({ page, dev }) => {
  const { go, rest } = await workspace(page, dev);
  let candidate = await rest('/product-candidates', 'POST', { name: 'Refill jar', estimated_cost: { amount_minor: 500, currency: 'USD' }, actual_quote: { amount_minor: 550, currency: 'USD' } });
  const board = await rest('/research-boards', 'POST', { title: 'Evaluation board' });
  const item = await rest(`/research-boards/${board.id}/notes`, 'POST', { body: 'Workspace-confirmed supplier observation', stance: 'hypothesis' });
  candidate = await rest(`/product-candidates/${candidate.id}`, 'PATCH', { status: 'researching' }, candidate.version);
  for (const dimension of ['demand_evidence', 'supply_feasibility']) {
    await rest(`/product-candidates/${candidate.id}/scores`, 'POST', { dimension, score: 4, uncertainty: 0.1, evidence_item_ids: [item.id] }, candidate.version);
    candidate = await rest(`/product-candidates/${candidate.id}`);
  }
  candidate = await rest(`/product-candidates/${candidate.id}`, 'PATCH', { status: 'validating' }, candidate.version);
  await rest(`/product-candidates/${candidate.id}/decide`, 'POST', { status: 'rejected' }, candidate.version, 400);
  await rest(`/product-candidates/${candidate.id}/decide`, 'POST', { status: 'rejected', decision_reason: 'Margin below target' }, candidate.version);
  await go(`research/candidates/${candidate.id}`);
  await expect(page.getByRole('columnheader', { name: 'Estimated cost' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Actual quote' })).toBeVisible();
  await expect(page.getByText('Margin below target', { exact: true })).toBeVisible();
  const target = await rest('/watch-targets', 'POST', { name: 'Listening source', platform: 'instagram', target_type: 'keyword', query: { keywords: ['refill'] } });
  const mention = await rest('/mentions', 'POST', { watch_target_id: target.id, url: 'https://example.test/refill-mention', text_excerpt: 'Refill conversation from a user import' });
  await go('research/listening');
  await expect(page.getByText('Refill conversation from a user import', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /classify/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manual label' }).click();
  await page.getByRole('combobox', { name: 'Label value', exact: true }).selectOption('negative');
  await page.getByRole('button', { name: /Save label|Apply label/i }).click();
  await expect.poll(async () => (await rest(`/mentions/${mention.id}/labels`)).items.length).toBe(1);
  await page.getByRole('button', { name: 'Escalate mention' }).click();
  const escalation = page.getByRole('button', { name: 'Create work item' });
  await page.getByLabel('Work item title').fill('Review the product concern');
  await escalation.click();
  await expect.poll(async () => (await rest('/mentions')).items[0]?.escalated_to).toBeTruthy();
});
