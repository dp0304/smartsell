import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { localWithoutWorker } from '../../../tests/web-e2e/local-dev.mjs';
import { showMoreModules } from '../../../tests/web-e2e/phase1-shell.mjs';

const test = base.extend({ dev: localWithoutWorker });
const reportedAt = '2026-01-15T10:30:00.000Z';
const videoUrl = 'https://x.com/fixture/status/123';
const disclosure = /Worker task & signed receipt|Worker 任務與簽名回執/;

function seedAudit(dev, wid) {
  const deviceId = randomUUID();
  const ids = {};
  dev.updateSnapshot(state => {
    const now = new Date().toISOString();
    const seed = (kind, id, data) => {
      const key = `row/${kind}/${id}`;
      state.records.push([JSON.stringify(['operation_runtime', 'record', key]), {
        id: key, module: 'operation_runtime', kind: 'record', version: 1,
        tenant_id: state.scope.tenantId, workspace_id: wid, created_at: now, updated_at: now,
        data: { value: JSON.stringify({ ...data, id, version: 1, created_at: now, updated_at: now }) },
      }]);
    };
    const ownerId = state.scope.actorId;
    const task = (name, status, result, owner = ownerId) => {
      const id = ids[name] = randomUUID();
      seed('worker_social_status_task', id, {
        owner_id: owner, device_id: deviceId, status,
        ...(status === 'blocked' ? { mode: 'account_status' } : { mode: 'recent_posts', platform: 'x' }),
        ...(result && { result: { channels: result }, reported_at: reportedAt }),
      });
      return id;
    };
    const audit = (name, tool, taskId, status) => {
      const id = ids[name] = randomUUID();
      seed('worker_social_status_audit', id, { data: {
        request_id: randomUUID(), actor_id: ownerId, tool, target: 'Worker fixture', outcome: 'success',
        task_id: taskId, device_id: deviceId, status,
      } });
    };
    const completed = task('completed', 'completed', [{ platform: 'x', status: 'verified', identity: 'fixture', posts: [
      { id: '123', url: videoUrl, text: 'Visible fixture video', has_video: true },
      { id: '124', url: 'https://x.com/fixture/status/124', text: 'Visible fixture text', has_video: false },
    ] }]);
    audit('report', 'worker_social_status_report', completed, 'completed');
    audit('get', 'worker_social_status_get', completed);
    audit('request', 'worker_social_status_request', task('queued', 'queued'));
    audit('claim', 'worker_social_status_get', task('claimed', 'claimed'));
    audit('missingReceipt', 'worker_social_status_get', task('missing', 'completed'));
    audit('empty', 'worker_social_status_get', task('emptyTask', 'completed', [{ platform: 'x', status: 'verified', identity: 'fixture', posts: [] }]));
    audit('blocked', 'worker_social_status_report', task('blockedTask', 'blocked', [
      { platform: 'x', status: 'login_required' }, { platform: 'youtube', status: 'unverified' },
      { platform: 'reddit', status: 'identity_mismatch' }, { platform: 'tiktok', status: 'unsupported' },
    ]), 'blocked');
    audit('foreign', 'worker_social_status_get', task('foreignTask', 'completed', undefined, randomUUID()));
    audit('forbidden', 'worker_social_status_get', task('forbiddenTask', 'queued'));
    audit('untrusted', 'worker_social_status_get', task('untrustedTask', 'queued'));
    audit('expired', 'worker_social_status_get', task('expiredTask', 'expired'));
    audit('unlinked', 'worker_social_status_request', undefined);
    const zhihuId = randomUUID();
    seed('zhihu_stats_task', zhihuId, { owner_id: ownerId, device_id: deviceId, status: 'blocked',
      result: { status: 'blocked', reason: 'login_required' }, reported_at: reportedAt });
    audit('zhihu', 'zhihu_stats_get', zhihuId, 'blocked');
  });
  return { ids, deviceId };
}

test('expands Worker social audit receipts by task ID and displays only observed evidence', async ({ page, dev }) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === dev.origin ? route.fallback() : route.abort());
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { email: 'worker-audit@example.test', name: 'Audit owner', workspaceName: 'Worker audit QA', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: { workspaces: [{ id: wid }] } } = await setup.json();
  const { ids, deviceId } = seedAudit(dev, wid);
  const root = `/api/v1/workspaces/${wid}`;
  const taskPath = id => `${root}/worker-social-status/${id}`;
  await page.route(`${dev.origin}${taskPath(ids.forbiddenTask)}`, route => route.fulfill({
    status: 403, json: { code: 'FORBIDDEN', detail: 'Private backend error fixture' },
  }));
  await page.route(`${dev.origin}${taskPath(ids.untrustedTask)}`, route => route.fulfill({ json: { data: {
    id: ids.untrustedTask, device_id: deviceId, status: 'completed', mode: 'recent_posts', platform: 'x', reported_at: reportedAt,
    raw_report: 'Private report fixture',
    result: { channels: [{ platform: 'x', status: 'verified', identity: 'fixture', posts: [
      { id: '123', url: 'https://x.com.untrusted.test/fixture/status/123', text: 'Fixture with an unknown URL', has_video: false },
      { id: '124', url: 'https://x.com/other/status/124', text: 'Fixture with a different account URL', has_video: false },
      { id: '125', url: 'https://x.com/fixture/status/126', text: 'Fixture with a different post URL', has_video: false },
    ] }] },
  } } }));
  const requests = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.includes('/worker-social-status/')) requests.push([request.method(), path]);
  });

  const app = `${dev.origin}/app/${wid}`;
  const audit = page.locator('section').filter({ has: page.getByRole('heading', { name: 'MCP 工具審計', exact: true }) });
  const zhihuIncident = page.getByText('需要使用者登入知乎');
  // Phase 1 (§9.1) hides the non-core Zhihu module: its sign-in incident is not on the core Agent page.
  await page.goto(`${app}/agent`);
  await expect(page.getByRole('heading', { level: 1, name: 'Agent', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '連線', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(zhihuIncident).toHaveCount(0);
  // The MCP audit moved to the 開發者 tab (§9.8, B29); it is not on the default tab.
  await expect(audit).toHaveCount(0);
  // Settings → 介面 → 顯示其他模組 brings the hidden module back, with the observed incident.
  await showMoreModules(page, app);
  await page.goto(`${app}/agent`);
  await expect(zhihuIncident).toBeVisible();
  await page.getByRole('tablist', { name: 'Agent', exact: true }).getByRole('tab', { name: '開發者', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/app/${wid}/agent` && url.searchParams.get('tab') === 'developer');
  await expect(page.getByRole('tab', { name: '開發者', exact: true })).toHaveAttribute('aria-selected', 'true');
  const row = id => audit.getByRole('listitem').filter({ has: page.getByText(id, { exact: true }) });
  const expand = id => row(id).getByText(disclosure).click();
  await expect(row(ids.request)).toBeVisible();
  expect(requests).toEqual([]);
  await expect(row(ids.zhihu).getByText(disclosure)).toHaveCount(0);
  await expect(row(ids.unlinked).getByText(disclosure)).toHaveCount(0);

  await expand(ids.request);
  await expect(row(ids.request).getByText('排隊中')).toBeVisible();
  await expect(row(ids.request).getByText('尚無 Worker 回執。')).toBeVisible();
  expect(requests).toEqual([['GET', taskPath(ids.queued)]]);
  await expand(ids.claim);
  await expect(row(ids.claim).getByText('Worker 已領取')).toBeVisible();
  await expand(ids.blocked);
  for (const label of ['請在這台 Worker 電腦的 Chrome 登入', '未觀測', '身分不符', '不支援']) {
    await expect(row(ids.blocked).getByText(label, { exact: true })).toBeVisible();
  }

  await page.getByRole('combobox', { name: '語言', exact: true }).selectOption('en');
  const englishAudit = page.locator('section').filter({ has: page.getByRole('heading', { name: 'MCP tool audit', exact: true }) });
  const englishRow = id => englishAudit.getByRole('listitem').filter({ has: page.getByText(id, { exact: true }) });
  const open = id => englishRow(id).getByText(disclosure).click();
  await open(ids.report);
  const report = englishRow(ids.report);
  await expect(report.getByText('Completed', { exact: true })).toBeVisible();
  await expect(report.getByText(deviceId, { exact: true })).toHaveCount(2);
  await expect(report.locator(`time[datetime="${reportedAt}"]`)).toBeVisible();
  await expect(report.getByText('Visible posts: 2')).toBeVisible();
  await expect(report.getByText('Posts with video evidence: 1')).toBeVisible();
  await expect(report.getByRole('link', { name: 'X post 123' })).toHaveAttribute('href', videoUrl);
  await expect(report.getByText('Visible fixture text')).toBeVisible();
  await open(ids.get);
  await expect(englishRow(ids.get).getByText('Visible posts: 2')).toBeVisible();
  expect(requests.filter(([, path]) => path === taskPath(ids.completed))).toEqual([['GET', taskPath(ids.completed)]]);

  await open(ids.missingReceipt);
  await expect(englishRow(ids.missingReceipt).getByText('No Worker receipt yet.')).toBeVisible();
  await expect(englishRow(ids.missingReceipt).getByText('Completed', { exact: true })).toHaveCount(0);
  await expect(englishRow(ids.missingReceipt).getByText('Visible posts: 0')).toHaveCount(0);
  await open(ids.empty);
  await expect(englishRow(ids.empty).getByText('Visible posts: 0')).toBeVisible();

  const denied = page.waitForResponse(response => new URL(response.url()).pathname === taskPath(ids.foreignTask));
  await open(ids.foreign);
  expect((await denied).status()).toBe(404);
  await expect(englishRow(ids.foreign).getByText('Task not found or you do not have permission to view its receipt.')).toBeVisible();
  await open(ids.forbidden);
  await expect(englishRow(ids.forbidden).getByText('You do not have permission to view this task’s receipt.')).toBeVisible();
  await expect(englishRow(ids.forbidden).getByText('Private backend error fixture')).toHaveCount(0);
  await open(ids.untrusted);
  await expect(englishRow(ids.untrusted).getByText('Fixture with an unknown URL')).toBeVisible();
  await expect(englishRow(ids.untrusted).getByRole('link')).toHaveCount(0);
  await expect(englishRow(ids.untrusted).getByText('Private report fixture')).toHaveCount(0);
  await open(ids.expired);
  await expect(englishRow(ids.expired).getByText('Expired', { exact: true })).toBeVisible();
  await expect(englishRow(ids.expired).getByText('No Worker receipt yet.')).toBeVisible();
});
