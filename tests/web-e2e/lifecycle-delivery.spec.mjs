import { fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from '@playwright/test';

const hash = value => createHash('sha256').update(value).digest('hex');
const exact = { exact: true };
const test = base.extend({
  async localEsp({}, use) {
    const submissions = [];
    const suppressions = [];
    const receipts = new Map();
    const cancellations = [];
    const mock = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      let result;
      switch (request.url) {
        case '/esp/members': result = { profile_refs: ['active', 'withdrawn'].map(hash) }; break;
        case '/esp/suppressions': result = { events: suppressions }; break;
        case '/esp/submit': submissions.push(body); break;
        case '/esp/cancel': cancellations.push(body); break;
        case '/esp/receipt': result = receipts.get(body.request_key); break;
        case '/esp/flow': result = { flow_ref: body.flow_ref, status: 'paused' }; break;
      }
      response.writeHead(result ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    });
    mock.listen(0, '127.0.0.1');
    await once(mock, 'listening');
    try {
      await use({ origin: `http://127.0.0.1:${mock.address().port}`, submissions, suppressions, receipts, cancellations });
    } finally {
      await new Promise(resolve => mock.close(resolve));
    }
  },
  async deliveryApp({ localEsp }, use) {
    const directory = await mkdtemp(join(tmpdir(), 'smartsell-lifecycle-e2e-'));
    const setupToken = randomUUID();
    const launcher = fileURLToPath(new URL('./dev-host.mjs', import.meta.url));
    const child = fork(launcher, { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: directory,
      NODE_ENV: 'development', ROLE: 'all', HOST: '127.0.0.1', APP_SECRET: randomBytes(32).toString('hex'), SETUP_TOKEN: setupToken,
      SMARTSELL_DATA_FILE: join(directory, 'state.sqlite'), MEDIA_DIRECTORY: join(directory, 'media'),
      SMARTSELL_VITE_CACHE_DIR: join(directory, 'vite-cache'), SMARTSELL_LOCAL_ESP_ORIGIN: localEsp.origin,
      SMARTSELL_E2E_PREVIEW: process.env.SMARTSELL_E2E_PREVIEW,
    } });
    let log = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-5000); });
    const closed = once(child, 'close');
    try {
      const [addresses] = await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(40_000) }),
        closed.then(([code]) => { throw new Error(`Workspace exited (${code})\n${log}`); }),
      ]);
      await use({ origin: addresses.origin, setupToken });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (!await Promise.race([closed.then(() => true), delay(4000, false, { ref: false })])) {
        child.kill('SIGKILL');
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function workspace(page, app) {
  const setup = await page.request.post(`${app.origin}/api/v1/setup`, {
    headers: { Origin: app.origin, 'X-Setup-Token': app.setupToken },
    data: { email: 'lifecycle-owner@example.test', name: 'Lifecycle owner', workspaceName: 'Lifecycle QA', password: randomUUID() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const { data: session } = await setup.json();
  const id = session.workspaces[0].id;
  const root = `/api/v1/workspaces/${id}`;
  const csrf = await page.request.get(`${app.origin}/api/v1/session/csrf`);
  const { csrf_token } = await csrf.json();
  async function call(method, path, data, version) {
    const response = await page.request.fetch(`${app.origin}${root}${path}`, { method, data, headers: {
      Origin: app.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
      ...(version != null && { 'If-Match': String(version) }),
    } });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  }
  await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  return { call, root, url: `${app.origin}/w/${id}/lifecycle` };
}

async function viaButton(page, api, path, button) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === api.root + path && response.request().method() === 'POST');
  await button.click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}

const button = (parent, name) => parent.getByRole('button', { name, ...exact });
const row = (parent, text) => parent.getByRole('row').filter({ hasText: text });
const checkReceipt = { name: 'Check ESP receipt', ...exact };
const panel = (page, name) => page.getByRole('heading', { name, ...exact }).locator('..');

async function cell(table, record, column, text) {
  const columns = await table.getByRole('columnheader').allTextContents();
  expect(columns).toContain(column);
  await expect(record.getByRole('cell').nth(columns.indexOf(column))).toHaveText(text);
}

test('EM01–EM05 | The lifecycle workspace shows independent ESP receipts, audiences and coverage', async ({ page, deliveryApp, localEsp }) => {
  const api = await workspace(page, deliveryApp);
  const post = (path, body, version) => api.call('POST', path, body, version);
  const brand = await post('/brands', { name: 'Lifecycle QA brand', slug: 'lifecycle-qa' });
  const account = await post('/esp-accounts', { provider: 'local-fixture', external_account_id: 'local-email', brand_id: brand.id, channel: 'email', is_sending_system_of_record: true });
  const addresses = ['active@mail.test', 'withdrawn@mail.test'];
  await api.call('PUT', `/esp-accounts/${account.id}/local-config`, { enable: true, address_allowlist: addresses }, account.version);
  const consent = {};
  for (const channel of ['email', 'sms']) {
    consent[channel] = await post('/consent-texts', { channel, purpose: 'marketing', locale: 'en', text: `Local ${channel} opt-in` });
  }
  const customers = {};
  for (const name of ['active', 'withdrawn']) {
    const customer = await post('/customers', { brand_id: brand.id });
    customers[name] = customer.id;
    for (const [kind, namespace, raw] of [['esp_profile', account.id, name], ['email', 'verified-email', `${name}@mail.test`]]) {
      await post(`/customers/${customer.id}/identities`, { kind, namespace, value_hash: hash(raw), verified: true,
        verification_method: 'manual_evidence', evidence_ids: ['synthetic-fixture'] }, customer.version);
    }
    for (const channel of ['email', 'sms']) {
      await post(`/customers/${customer.id}/consents`, { channel, purpose: 'marketing', action: 'opt_in', source: 'support_request',
        source_ref: `${name}-${channel}`, consent_text_version_id: consent[channel].id, evidence_ids: ['synthetic-fixture'] });
    }
  }
  const segment = await post('/segments', { name: 'Local subscribers', brand_id: brand.id, mode: 'esp_native', esp_segment_ref: 'local-members',
    required_consent: { channel: 'email', purpose: 'marketing' } });
  const makeCampaign = template_ref => post('/esp-campaigns', { esp_account_id: account.id, segment_version_id: segment.current_version_id,
    template_ref, planned_send_at: new Date(Date.now() + 86_400_000).toISOString() });
  const campaign = await makeCampaign('local-delivery');
  const cancellable = await makeCampaign('local-cancellation');
  const flow = await post('/esp-flows', { esp_account_id: account.id, kind: 'welcome', trigger: 'sign_up', exit_on_purchase: false });
  await post(`/esp-flows/${flow.id}/status`, { status: 'manual' }, flow.version);

  const open = (tab, id) => page.goto(`${api.url}?tab=${tab}${id ? `&id=${id}` : ''}`);
  await page.goto(api.url);
  await button(page, 'Customer segments').click();
  await button(page, 'Local subscribers').click();
  const preview = panel(page, 'Audience snapshots');
  await viaButton(page, api, `/segments/${segment.id}/preview`, button(preview, 'Preview current audience'));
  const previewTable = preview.getByRole('table');
  await cell(previewTable, row(previewTable, 'Audience preview'), 'Eligible audience', '2');
  localEsp.suppressions.push({ id: 'synthetic-unsubscribe', kind: 'unsubscribe', address_hash: hash(addresses[1]), at: new Date().toISOString() });

  await open('espCampaigns', campaign.id);
  const campaignPanel = panel(page, 'Campaign delivery');
  const campaignTable = campaignPanel.getByRole('table');
  const path = `/esp-campaigns/${campaign.id}`;
  const schedule = button(campaignPanel, 'Submit local ESP schedule');
  const status = row(campaignTable, 'Schedule');
  const reconcile = attempt => viaButton(page, api, `${path}/local-reconcile`, attempt.getByRole('button', checkReceipt));
  await expect(campaignPanel.getByText('Local planned time', exact)).toBeVisible();
  await expect(campaignPanel.getByText('Draft', exact)).toBeVisible();

  await campaignPanel.getByLabel('Allowlisted test address').fill(addresses[0]);
  const testSend = await viaButton(page, api, `${path}/local-submit`, button(campaignPanel, 'Submit local test send'));
  localEsp.receipts.set(testSend.request_key, { request_key: testSend.request_key, receipt_ref: 'test-accepted', status: 'accepted' });
  await reconcile(row(campaignTable, 'Test send'));
  await expect(campaignPanel.getByText('test-accepted', exact)).toBeVisible();
  const first = await viaButton(page, api, `${path}/local-submit`, schedule);
  expect(first.status).toBe('unknown');
  await expect(schedule).toHaveCount(0);
  expect(localEsp.submissions.map(entry => entry.recipients)).toEqual([
    [{ address: addresses[0], customer_id: customers.active }], [{ address: addresses[0], customer_id: customers.active }],
  ]);
  expect((await reconcile(status)).status).toBe('unknown');
  await expect(status.getByText('Latest ESP readback failed', exact)).toBeVisible();
  localEsp.receipts.set(first.request_key, { request_key: first.request_key, receipt_ref: 'failed-schedule', status: 'failed' });
  expect((await reconcile(status)).status).toBe('failed');
  await expect(status.getByText('Latest ESP readback failed', exact)).toHaveCount(0);
  const retry = await viaButton(page, api, `${path}/local-submit`, schedule);
  expect(retry.id).not.toBe(first.id);
  const current = status.filter({ has: page.getByRole('button', checkReceipt) });
  await expect(current.getByText(/^unknown$/i)).toBeVisible();
  localEsp.receipts.set(retry.request_key, { request_key: retry.request_key, receipt_ref: 'confirmed-schedule', status: 'scheduled' });
  expect((await reconcile(current)).status).toBe('scheduled');
  await expect(current.getByText('confirmed-schedule', exact)).toBeVisible();
  await cell(campaignTable, current, 'ESP readback status', /^scheduled$/i);
  const sentReceipt = { request_key: retry.request_key, receipt_ref: 'actual-send', status: 'sent', customer_ids: [customers.active], sent_at: new Date().toISOString() };
  localEsp.receipts.set(retry.request_key, sentReceipt);
  const sent = await reconcile(current);
  expect(sent.status).toBe('sent');
  await expect(current.getByText('actual-send', exact)).toBeVisible();
  await cell(campaignTable, current, 'Delivered per ESP report', '—');
  localEsp.receipts.set(retry.request_key, { ...sentReceipt, receipt_ref: 'delivery-report', delivered_count: 1 });
  expect((await reconcile(current)).send_snapshot_id).toBe(sent.send_snapshot_id);
  await cell(campaignTable, current, 'Delivered per ESP report', '1delivery-report');

  await open('segments', segment.id);
  await expect(previewTable.getByRole('columnheader', { name: 'ESP sent audience' })).toBeVisible();
  await cell(previewTable, row(previewTable, 'Audience preview'), 'Eligible audience', '2');
  await cell(previewTable, row(previewTable, 'ESP actual send'), 'ESP sent audience', '1');
  await expect(row(previewTable, 'Submission estimate').first()).toContainText('Withdrawn 1');
  await open('customers', customers.withdrawn);
  const ledger = panel(page, 'Channel marketing consent');
  await expect(row(ledger, /^email/i)).toContainText(/opted out/i);
  await expect(row(ledger, /^sms/i)).toContainText(/opted in/i);

  await open('espCampaigns', cancellable.id);
  const cancelPath = `/esp-campaigns/${cancellable.id}`;
  const attempt = await viaButton(page, api, `${cancelPath}/local-submit`, schedule);
  localEsp.receipts.set(attempt.request_key, { request_key: attempt.request_key, receipt_ref: 'schedule-to-cancel', status: 'scheduled' });
  const check = () => viaButton(page, api, `${cancelPath}/local-reconcile`, button(campaignPanel, 'Check ESP receipt'));
  await check();
  await viaButton(page, api, `${cancelPath}/local-cancel`, button(campaignPanel, 'Request ESP cancellation'));
  expect(localEsp.cancellations).toEqual([{ account: 'local-email', request_key: attempt.request_key }]);
  await expect(campaignPanel.getByText('Cancellation awaiting confirmation', exact)).toBeVisible();
  expect((await api.call('GET', cancelPath)).status).toBe('scheduled');
  localEsp.receipts.set(attempt.request_key, { request_key: attempt.request_key, receipt_ref: 'cancelled-by-esp', status: 'cancelled' });
  await check();
  await expect(campaignPanel.getByText('cancelled-by-esp', exact)).toBeVisible();
  await cell(campaignTable, row(campaignTable, 'Schedule'), 'ESP readback status', /^cancelled$/i);
  await expect(campaignPanel.getByText('Cancellation awaiting confirmation', exact)).toHaveCount(0);
  expect((await api.call('GET', cancelPath)).status).toBe('cancelled');

  await open('flows', flow.id);
  const flowPanel = panel(page, 'Flow state');
  await expect(flowPanel.getByText('Awaiting readback', exact)).toBeVisible();
  await flowPanel.getByLabel('ESP flow reference').fill('welcome-local');
  await viaButton(page, api, `/esp-flows/${flow.id}/local-readback`, button(flowPanel, 'Read ESP flow'));
  await expect(flowPanel.getByText(/^paused$/i)).toBeVisible();
  await expect(flowPanel.getByText(/^manual$/i)).toBeVisible();
  await expect(flowPanel.getByText('Draft', exact)).toBeVisible();
  expect((await api.call('GET', path)).status).toBe('sent');

  const now = Date.now();
  await post('/lifecycle/health', { esp_account_id: account.id, source_ref: 'local-engagement-report',
    period_from: new Date(now - 60_000).toISOString(), period_until: new Date(now - 1000).toISOString(), observed_at: new Date(now).toISOString(),
    sent: 10, opened: 7, clicked: 3, purchased: 0 });
  await open('health');
  await expect(page.getByRole('row', { name: /sms.*Not connected/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /email.*Imported ESP reports only/ })).toBeVisible();
  const report = row(page, 'local-engagement-report');
  await expect(report).toBeVisible();
  const reportTable = report.locator('xpath=ancestor::table');
  for (const [column, contents] of [['Opens', '7'], ['Clicks', '3'], ['Purchases', '0'], ['Bounces', '—']]) {
    await cell(reportTable, report, column, contents);
  }
});
