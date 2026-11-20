import { completedReportVersion } from '../acceptance/report-version.mjs';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import { tsImport } from 'tsx/esm/api';

const host = '127.0.0.1';
const portalRoot = new URL('../../apps/portal/', import.meta.url);
const staticFiles = new Map([
  ['/src/main.js', 'text/javascript'], ['/src/api.js', 'text/javascript'],
  ['/src/i18n.js', 'text/javascript'], ['/src/styles.css', 'text/css'],
]);
const secret = () => randomBytes(32).toString('hex');

const test = base.extend({
  databaseUrl: [undefined, { option: true }],
  customHosts: [[], { option: true }],
  async localPortal({ databaseUrl, customHosts }, use) {
    const directory = await mkdtemp(join(tmpdir(), 'smartsell-portal-e2e-'));
    const keyFile = join(directory, 'key.pem');
    const certFile = join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
      '-days', '1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
    let api, apiOrigin;
    const portal = createHttpsServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, async (req, res) => {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/v1/portal/')) {
        const upstream = httpRequest(`${apiOrigin}${req.url}`, { method: req.method, headers: req.headers }, response => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        });
        upstream.on('error', () => res.writeHead(502).end());
        req.pipe(upstream);
        return;
      }
      const page = pathname === '/' || /^\/(?:s|invite)\/[a-f0-9-]+$/.test(pathname);
      const type = page ? 'text/html' : staticFiles.get(pathname);
      if (req.method !== 'GET' || !type) return res.writeHead(404).end();
      try {
        const bytes = await readFile(new URL(page ? 'index.html' : pathname.slice(1), portalRoot));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }).end(bytes);
      } catch {
        res.writeHead(500).end();
      }
    });
    try {
      portal.listen(0, host);
      await once(portal, 'listening');
      const portalOrigin = `https://${host}:${portal.address().port}`;
      const setupToken = secret();
      const assertionKey = secret();
      // Keep the Operations server and its dependencies in one tsx loader scope.
      const { portalHost } = await tsImport('./portal-host.ts', import.meta.url);
      const customOrigins = customHosts.map(name => `https://${name}:${portal.address().port}`);
      const backend = await portalHost(join(directory, 'state.json'), setupToken, portalOrigin, assertionKey, databaseUrl, customOrigins);
      api = backend.api;
      apiOrigin = await api.listen({ host, port: 0 });
      await use({ apiOrigin, staffOrigin: backend.staffOrigin, portalOrigin, setupToken, assertionKey, customOrigins, store: backend.store });
    } finally {
      try {
        if (portal.listening) await new Promise(resolve => portal.close(resolve));
        await api?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
});

async function readData(response, label, status) {
  expect(response.status(), label).toBe(status);
  return (await response.json()).data;
}

function clientAssertion({ portalOrigin, assertionKey }, sub, email) {
  const payload = Buffer.from(JSON.stringify({ sub, email, audience: 'client', email_verified: true, origin: portalOrigin,
    jti: randomBytes(32).toString('base64url'), exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  return `${payload}.${createHmac('sha256', assertionKey).update(`smartsell:portal-session:v1:${payload}`).digest('base64url')}`;
}

test.use({ ignoreHTTPSErrors: true, databaseUrl: process.env.SMARTSELL_CLIENT_DELIVERY_PG_URL });

const exact = { exact: true };

async function staffOperations(request, { apiOrigin, staffOrigin, setupToken }) {
  const setup = await request.post(`${apiOrigin}/api/v1/setup`, {
    headers: { Origin: staffOrigin, 'X-Setup-Token': setupToken },
    data: { email: 'owner@example.test', name: 'Owner', workspaceName: 'Portal acceptance', password: secret() },
  });
  const { workspaces: [workspace], csrf_token } = await readData(setup, 'Owner setup', 201);
  const operation = async (method, path, data, version) => {
    const response = await request.fetch(`${apiOrigin}/api/v1/workspaces/${workspace.id}${path}`, {
      method, data, headers: { Origin: staffOrigin, 'X-CSRF-Token': csrf_token, ...(version && { 'If-Match': String(version) }) },
    });
    const result = await response.json();
    expect(response.ok(), `${method} ${path} returned HTTP ${response.status()}: ${JSON.stringify(result.error ?? result.detail ?? '')}`).toBe(true);
    return result.data;
  };
  return operation;
}

test('PL06 | the client portal keeps the pinned revision visible and rejects stale approval', async ({ page, request, localPortal }) => {
  const { portalOrigin } = localPortal;
  const operation = await staffOperations(request, localPortal);
  const post = (path, data) => operation('POST', path, data);
  const get = path => operation('GET', path);
  const clientId = randomUUID();
  const email = 'client@example.test';
  const title = 'Local client review';
  const oldCopy = 'First caption shared for client review';
  const newCopy = 'Replacement caption for a new share';
  const externalNote = 'Public feedback on the first caption';
  const internalNote = 'Internal note about the first caption';
  const brand = await post('/brands', { name: 'Review brand', slug: 'review-brand' });
  const account = await post('/social-accounts', {
    provider: 'meta_facebook', external_account_id: '1234', display_name: 'Local review page', brand_id: brand.id, owned_account_confirmed: true,
  });
  await post('/approval-policies', { name: 'Client review policy', conditions: { social_account_ids: [account.id] },
    steps: [{ order: 1, min_approvals: 1, approvers: { user_ids: [clientId] } }] });
  const { item } = await post('/content-items', { brand_id: brand.id, title });
  const { variant } = await post(`/content-items/${item.id}/variants`, { platform: 'facebook', market: 'TW', format: 'text', body_markdown: oldCopy });
  const revisions = `/content-variants/${variant.id}/revisions`;
  const first = await post(revisions, { expected_version: variant.version, base_revision_id: null });
  const target = await post('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString() });
  const targetPath = `/publish-targets/${target.id}`;
  const submitted = await post(`${targetPath}/submit`, {});
  expect(submitted).toMatchObject({ plan_status: 'awaiting_approval', variant_revision_id: first.revision.id });

  const ref = { resource_type: 'publish_target', resource_id: target.id, revision_id: first.revision.id, audience: 'client' };
  const thread = await post('/threads', ref);
  await post(`/threads/${thread.id}/comments`, { visibility: 'internal', text: internalNote });
  const feedback = await post(`/threads/${thread.id}/comments`, { visibility: 'client', text: externalNote });
  const expires_at = new Date(Date.now() + 3_600_000).toISOString();
  const shareInput = { ...ref, expires_at, grantee_type: 'email', grantee_id: email, permissions: ['view', 'comment', 'approve'], thread_ids: [thread.id] };
  const preview = await post('/shares/preview', shareInput);
  const share = await post('/shares', { ...shareInput, preview_hash: preview.preview_hash });
  const round = await post('/review-rounds', { target_ids: [target.id], share_ids: [share.id], due_at: expires_at });
  const plan = await post('/delivery-plans', { name: 'Client handoff', period: 'Current' });
  const itemPath = `/delivery-plans/${plan.id}/items`;
  const delivery = await post(itemPath, { ...ref, kind: 'content', title, due_at: expires_at });
  const deliveryPath = `/delivery-items/${delivery.id}`;
  const produced = await operation('POST', `${deliveryPath}/produce`, { share_id: share.id }, delivery.version);
  const sent = await operation('POST', `${deliveryPath}/mark-sent`, { receipt_reference: 'staff-recorded' }, produced.version);
  const reminded = await operation('POST', `${deliveryPath}/remind`, {}, sent.version);
  expect(await operation('POST', `${deliveryPath}/remind`, {}, reminded.version)).toEqual(reminded);
  const invite = await post('/portal-invitations', { email, audience: 'client', expires_at });
  const session = await page.request.post(`${portalOrigin}/api/v1/portal/session`, {
    headers: { Origin: portalOrigin }, data: { assertion: clientAssertion(localPortal, clientId, email) },
  });
  expect(session.status(), 'Client portal session exchange').toBe(204);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${portalOrigin}${invite.href}`);
  await page.getByRole('button', { name: '接受邀請', ...exact }).click();
  const search = page.getByRole('searchbox', { name: '搜尋共享項目標題' });
  const submitSearch = page.getByRole('button', { name: '搜尋', ...exact });
  await search.fill(internalNote);
  await submitSearch.click();
  await expect(page.getByRole('status')).toHaveText('找不到符合的共享項目。');
  await expect(page.getByRole('link', { name: title, ...exact })).toHaveCount(0);
  await search.fill('client review');
  await submitSearch.click();
  await page.getByRole('link', { name: title, ...exact }).click();
  await expect(page).toHaveURL(`${portalOrigin}/s/${share.id}`);
  const approve = page.getByRole('button', { name: '批准', ...exact });
  const staleNotice = page.getByRole('status').filter({ hasText: '已有新版本。等待團隊重新分享期間，仍可查看原版本。' });
  const expectPinnedCopy = async () => {
    await expect(page.getByRole('heading', { name: title, ...exact })).toBeVisible();
    await expect(page.getByText(oldCopy, exact)).toBeVisible();
    await expect(page.getByText(externalNote, exact)).toBeVisible();
    await expect(page.getByText(internalNote, exact)).toHaveCount(0);
    await expect(page.getByText(newCopy, exact)).toHaveCount(0);
  };
  await expectPinnedCopy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await expect(approve).toBeVisible();
  await expect(staleNotice).toHaveCount(0);
  const reminder = page.getByRole('status').filter({ hasText: '請確認是否已收到這項交付。' });
  await expect(reminder).toBeVisible();
  await page.getByRole('button', { name: '確認收到交付', ...exact }).click();
  await expect(reminder).toHaveCount(0);
  const [savedPlan] = await get('/delivery-plans');
  expect(savedPlan.items[0]).toMatchObject({ id: delivery.id, status: 'confirmed', produced_at: produced.produced_at,
    sent_at: sent.sent_at, confirmed_at: expect.any(String) });

  const second = await post(revisions, { expected_version: first.variant.version, base_revision_id: first.revision.id, body_markdown: newCopy });
  expect(second.revision.id).not.toBe(first.revision.id);
  expect(await get(`/content-variants/${variant.id}`)).toMatchObject({ variant: { current_revision_id: second.revision.id } });
  expect(await get(`/review-rounds/${round.id}`)).toMatchObject({ status: 'version_updated', revision_ids: [first.revision.id], share_ids: [share.id] });

  await page.reload();
  await expect(staleNotice).toBeVisible();
  await expectPinnedCopy();
  await expect(approve).toHaveCount(0);
  await expect(page.getByRole('button', { name: '要求修改', ...exact })).toHaveCount(0);

  const detailUrl = `${portalOrigin}/api/v1/portal/shares/${share.id}`;
  const detail = await readData(await page.request.get(detailUrl), 'Stale share detail', 200);
  expect(detail).toMatchObject({ id: share.id, kind: 'publish_target', title, status: 'stale', text: oldCopy, actions: { approve: false },
    threads: [{ id: thread.id, status: 'open', comments: [{ id: feedback.id, text: externalNote, at: expect.any(String) }] }] });
  expect(JSON.stringify(detail)).not.toContain(internalNote);
  const rejected = await page.request.post(`${detailUrl}/approve`, { headers: { Origin: portalOrigin }, data: {} });
  expect(rejected.status()).toBe(409);
  expect(await rejected.json()).toEqual({ error: { code: 'conflict', message: 'A newer revision requires a new share' } });
  expect(await get(targetPath)).toMatchObject({ plan_status: 'awaiting_approval', variant_revision_id: first.revision.id,
    approval: { id: submitted.approval_request_id, status: 'invalidated', invalidated_reason: 'content_revision_changed' } });
});

test.describe('Client delivery', () => {
  test('TE03 TE04 TE05 | named client searches, downloads and reopens the confirmed report after backfill', async ({ page, request, localPortal }) => {
    const operation = await staffOperations(request, localPortal);
    const post = (path, data, version) => operation('POST', path, data, version);
    const get = path => operation('GET', path);
    const { portalOrigin } = localPortal;
    const email = 'delivery@example.test';
    const expires_at = new Date(Date.now() + 3600_000).toISOString();
    const period = { from: '2025-01-01T00:00:00Z', to: '2025-01-06T00:00:00Z' };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMMkAAAAASUVORK5CYII=', 'base64');
    async function upload(name, purpose = 'asset') {
      const ticket = await post('/files/uploads', { purpose, mime_type: 'image/png', original_filename: name,
        size_bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
      return post(`/files/uploads/${ticket.id}/complete`, { base64: png.toString('base64') });
    }
    const brand = await post('/brands', { name: 'Delivery brand', slug: 'delivery-brand' });
    const account = await post('/social-accounts', { provider: 'meta_facebook', external_account_id: '9981',
      display_name: 'Delivery page', brand_id: brand.id, owned_account_confirmed: true });
    const evidence = await upload('Post evidence.png', 'evidence');
    const published = await post('/platform-posts/register', { social_account_id: account.id,
      permalink: 'https://www.facebook.com/9981/posts/42', external_post_id: '42', published_at: period.from, evidence_file_ids: [evidence.id] });
    const metric = 'norm.post.views';
    const observe = (value, observed_at) => post('/metrics/observations', { observations: [{
      metric_key: metric, subject_type: 'platform_post', subject_id: published.id, observed_at, value,
      availability: 'observed', source: { method: 'manual_import' },
    }] });
    await observe(0, '2025-01-01T23:00:00Z');
    const title = 'October client delivery report';
    const report = await post('/reports', { kind: 'client_monthly', title, period,
      sections: [{ key: 'views', type: 'table', query: { metrics: [metric], subject: { type: 'platform_post', filter: { subject_ids: [published.id] } },
        time: { basis: 'published_at' }, age_bucket: '24h' } }] });
    const publishReport = async text => {
      const draft = await completedReportVersion(get, await post(`/reports/${report.id}/versions`, {}));
      const revised = await operation('PATCH', `/report-versions/${draft.id}/narrative`, { narrative: [
        { section_key: 'views', blocks: [{ kind: 'fact', text, refs: ['views'] }] },
      ] }, draft.version);
      return post(`/report-versions/${draft.id}/finalize`, {}, revised.version);
    };
    const originalText = 'Original delivered snapshot: 0 views.';
    const correctedText = 'Backfilled snapshot: 7 views.';
    const first = await publishReport(originalText);
    const views = version => version.results[0].data.rows[0].values[metric].value;
    expect(views(first)).toBe(0);
    const privateReport = await post('/reports', { kind: 'client_monthly', title: 'October internal draft', period,
      sections: [{ key: 'overview', type: 'narrative' }] });
    await completedReportVersion(get, await post(`/reports/${privateReport.id}/versions`, {}));

    const shareFor = async (ref, permissions, extra = {}) => {
      const input = { ...ref, ...extra, audience: 'client', grantee_type: 'email', grantee_id: email, expires_at, permissions };
      const preview = await post('/shares/preview', input);
      return post('/shares', { ...input, preview_hash: preview.preview_hash });
    };
    const ref = { resource_type: 'report', resource_id: report.id, revision_id: first.id };
    const thread = await post('/threads', { ...ref, audience: 'client' });
    const internal = 'Internal review only';
    const external = 'Approved client feedback';
    await post(`/threads/${thread.id}/comments`, { visibility: 'internal', text: internal });
    await post(`/threads/${thread.id}/comments`, { visibility: 'client', text: external });
    const sharedReport = await shareFor(ref, ['view'], { thread_ids: [thread.id] });
    const file = await upload('October approved attachment.png');
    const privateFile = await upload('October internal asset.png');
    const sharedFile = await shareFor({ resource_type: 'file', resource_id: file.id, revision_id: file.id }, ['view', 'download']);
    const plan = await post('/delivery-plans', { name: 'October report handoff', period: 'October' });
    const delivery = await post(`/delivery-plans/${plan.id}/items`, { ...ref, kind: 'report', title, due_at: expires_at });
    const path = `/delivery-items/${delivery.id}`;
    const produced = await post(`${path}/produce`, { share_id: sharedReport.id }, delivery.version);
    expect(produced).toMatchObject({ status: 'produced', produced_at: expect.any(String) });
    expect(produced).not.toHaveProperty('sent_at');
    expect(produced).not.toHaveProperty('confirmed_at');
    const sent = await post(`${path}/mark-sent`, { receipt_reference: 'staff-recorded' }, produced.version);
    expect(sent).toMatchObject({ status: 'sent', produced_at: produced.produced_at, sent_at: expect.any(String), receipt_reference: 'staff-recorded' });
    expect(sent).not.toHaveProperty('confirmed_at');
    await post(`${path}/remind`, {}, sent.version);

    const invite = await post('/portal-invitations', { email, audience: 'client', expires_at });
    const clientApi = `${portalOrigin}/api/v1/portal/shares`;
    const session = await page.request.post(`${portalOrigin}/api/v1/portal/session`, {
      headers: { Origin: portalOrigin }, data: { assertion: clientAssertion(localPortal, randomUUID(), email) },
    });
    expect(session.status()).toBe(204);
    expect((await page.request.get(`${clientApi}/${sharedReport.id}`)).status()).toBe(404);
    const fitsDesktop = async () => {
      expect(await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth])).toEqual([1280, 1280]);
      await expect(page.locator('#desktop-notice')).toBeHidden();
    };
    await page.goto(`${portalOrigin}${invite.href}`);
    const accept = page.getByRole('button', { name: '接受邀請', ...exact });
    await expect(accept).toBeVisible();
    await fitsDesktop();
    await accept.click();
    const field = page.getByRole('searchbox', { name: '搜尋共享項目標題' });
    const search = async value => {
      await field.fill(value);
      await page.getByRole('button', { name: '搜尋', ...exact }).click();
    };
    await search('October internal');
    await expect(page.getByRole('status')).toHaveText('找不到符合的共享項目。');
    await search('October');
    await expect(page.locator('.shares a')).toHaveCount(2);
    await expect(page.getByRole('link', { name: title, ...exact })).toBeVisible();
    await expect(page.getByRole('link', { name: file.original_filename, ...exact })).toBeVisible();
    await fitsDesktop();
    await page.getByRole('link', { name: file.original_filename, ...exact }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: file.original_filename, ...exact }).click();
    expect(await readFile(await (await download).path())).toEqual(png);
    expect((await page.request.get(`${clientApi}/${sharedFile.id}/download?file_id=${privateFile.id}`)).status()).toBe(404);
    expect((await page.request.get(`${clientApi}/${privateReport.id}`)).status()).toBe(404);
    expect((await page.request.get(`${clientApi}/${privateFile.id}`)).status()).toBe(404);

    await page.getByRole('link', { name: '所有共享項目', ...exact }).click();
    await page.getByRole('link', { name: title, ...exact }).click();
    const reportUrl = `${portalOrigin}/s/${sharedReport.id}`;
    await expect(page).toHaveURL(reportUrl);
    await expect(page.getByText(originalText, exact)).toBeVisible();
    await expect(page.getByText(external, exact)).toBeVisible();
    await expect(page.getByText(internal, exact)).toHaveCount(0);
    const discussions = await readData(await page.request.get(`${clientApi}/${sharedReport.id}/threads`), 'Client threads', 200);
    expect(JSON.stringify(discussions)).not.toContain(internal);
    await expect(page.getByText('請確認是否已收到這項交付。', exact)).toBeVisible();
    await page.getByRole('button', { name: '確認收到交付', ...exact }).click();
    const timeline = page.locator('.delivery-times');
    await expect(timeline.locator('dt')).toHaveText(['產生', '送達', '確認']);
    const [savedPlan] = await get('/delivery-plans');
    const saved = savedPlan.items.find(item => item.id === delivery.id);
    expect(saved).toMatchObject({ status: 'confirmed', revision_id: first.id, share_id: sharedReport.id,
      produced_at: produced.produced_at, sent_at: sent.sent_at, confirmed_at: expect.any(String) });
    const times = [saved.produced_at, saved.sent_at, saved.confirmed_at];
    const [producedAt, sentAt, confirmedAt] = times.map(Date.parse);
    // Separate transitions may share a timestamp at millisecond precision.
    expect(producedAt).toBeLessThanOrEqual(sentAt);
    expect(sentAt).toBeLessThanOrEqual(confirmedAt);

    await observe(7, '2025-01-02T00:00:00Z');
    const corrected = await publishReport(correctedText);
    expect(corrected.supersedes_version_id).toBe(first.id);
    expect(views(corrected)).toBe(7);
    expect(views(await get(`/report-versions/${first.id}`))).toBe(0);
    await page.reload();
    await expect(page).toHaveURL(reportUrl);
    await expect(page.getByText(originalText, exact)).toBeVisible();
    await expect(page.getByText(correctedText, exact)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '確認收到交付', ...exact })).toHaveCount(0);
    await expect(timeline.locator('time')).toHaveCount(3);
    expect(await timeline.locator('time').evaluateAll(nodes => nodes.map(node => node.dateTime))).toEqual(times);
    await fitsDesktop();
    const detail = await readData(await page.request.get(`${clientApi}/${sharedReport.id}`), 'Pinned report', 200);
    expect(detail).toMatchObject({ id: sharedReport.id, text: originalText, status: 'stale', deliveries: [{ id: delivery.id,
      produced_at: times[0], sent_at: times[1], confirmed_at: times[2] }] });
    expect(JSON.stringify(detail)).not.toContain(internal);
  });
});

const customHosts = ['north-portal.example.test', 'south-portal.example.test'];
test.use({ launchOptions: { args: ['--no-proxy-server',
  `--host-resolver-rules=${customHosts.map(name => `MAP ${name} ${host}`).join(',')}`] } });

test.describe('custom portal hosts', () => {
  test.use({ customHosts });

  test('TE06 | custom hosts render their own branding and enforce tenant boundaries', async ({ page, request, localPortal }) => {
    const { apiOrigin, staffOrigin, setupToken, customOrigins: [northOrigin, southOrigin], store } = localPortal;
    const setup = await request.post(`${apiOrigin}/api/v1/setup`, {
      headers: { Origin: staffOrigin, 'X-Setup-Token': setupToken },
      data: { email: 'owner@example.test', name: 'Owner', workspaceName: 'North', password: secret() },
    });
    const { workspaces: [north], user, csrf_token } = await readData(setup, 'Owner setup', 201);
    const southId = randomUUID();
    const tenantId = randomUUID();
    await store.transaction({ identityWrite: true }, ({ identity }) => {
      identity.put(`tenant/${tenantId}`, { id: tenantId, status: 'active' });
      identity.put(`workspace/${southId}`, { id: southId, tenantId, name: 'South' });
      identity.put(`member/${user.id}/${southId}`, { userId: user.id, workspaceId: southId, role: 'owner' });
    });
    const staff = (workspaceId, method, path, data, version) => request.fetch(`${apiOrigin}/api/v1/workspaces/${workspaceId}${path}`, {
      method, data, headers: { Origin: staffOrigin, 'X-CSRF-Token': csrf_token, ...(version && { 'If-Match': String(version) }) },
    });
    const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6kAAAAASUVORK5CYII=';
    const northBrand = { label: 'North Studio', accent: '#286450', logo_data_url: logo, portal_origin: northOrigin };
    const southBrand = { label: 'South Studio', accent: '#314a80', portal_origin: southOrigin };
    await page.goto(northOrigin);
    const portalFetch = (path, options) => page.evaluate(async ({ path, options }) => {
      const response = await fetch(`/api/v1/portal${path}`, options);
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    }, { path, options });
    expect((await portalFetch('/branding')).status).toBe(404);
    await readData(await staff(north.id, 'PUT', '/branding', northBrand), 'Bind north host', 200);
    await readData(await staff(southId, 'PUT', '/branding', southBrand), 'Bind south host', 200);
    const conflict = await staff(southId, 'PUT', '/branding', { ...southBrand, label: 'Conflicting label', portal_origin: northOrigin });
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).error.code).toBe('PORTAL_DOMAIN_IN_USE');

    const brand = page.locator('.topbar .brand');
    await page.reload();
    await expect(brand).toHaveText(northBrand.label);
    await expect(brand).toHaveCSS('border-inline-start-color', 'rgb(40, 100, 80)');
    await expect(brand.locator('img')).toHaveAttribute('src', logo);
    await expect.poll(() => brand.locator('img').evaluate(image => image.naturalWidth)).toBe(1);
    const { portal_origin: _, ...northPublic } = northBrand;
    expect(await portalFetch('/branding')).toEqual({ status: 200, body: { data: northPublic } });

    const expires_at = new Date(Date.now() + 3600_000).toISOString();
    const email = 'branding-client@example.test';
    const clientId = randomUUID();
    const invite = await readData(await staff(north.id, 'POST', '/portal-invitations', { email, audience: 'client', expires_at }), 'North client invitation', 200);
    const jsonPost = data => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const assertion = clientAssertion({ ...localPortal, portalOrigin: northOrigin }, clientId, email);
    expect((await portalFetch('/session', jsonPost({ assertion }))).status).toBe(204);
    expect((await portalFetch(`/invitations/${invite.id}/accept`, jsonPost({ token: invite.href.split('#')[1] }))).status).toBe(200);
    expect(await portalFetch('/workspaces')).toEqual({ status: 200, body: { data: [{ id: north.id }] } });
    const [northCookie] = await page.context().cookies(northOrigin);
    expect(northCookie).toMatchObject({ name: '__Host-smartsell_portal', domain: customHosts[0], secure: true, httpOnly: true });

    const southPost = async (path, data, version) => readData(await staff(southId, 'POST', path, data, version), path, 200);
    const report = await southPost('/reports', { kind: 'client_monthly', title: 'South report',
      period: { from: '2026-10-01', to: '2026-11-01' }, sections: [{ key: 'overview', type: 'narrative' }] });
    const path = `/reports/${report.id}/versions`;
    const receipt = await readData(await staff(southId, 'POST', path, {}), path, 202);
    const draft = await completedReportVersion(async path => readData(await staff(southId, 'GET', path), path, 200), receipt);
    const revision = await southPost(`/report-versions/${draft.id}/finalize`, {}, draft.version);
    const input = { resource_type: 'report', resource_id: report.id, revision_id: revision.id, audience: 'client',
      grantee_type: 'link', permissions: ['view'], expires_at };
    const { preview_hash } = await southPost('/shares/preview', input);
    const share = await southPost('/shares', { ...input, preview_hash });
    const signed = { headers: { Authorization: `Share ${share.href.split('#')[1]}` } };
    expect((await portalFetch(`/shares/${share.id}`, signed)).status).toBe(404);

    await page.goto(southOrigin);
    await expect(brand).toHaveText(southBrand.label);
    await expect(brand).toHaveCSS('border-inline-start-color', 'rgb(49, 74, 128)');
    await expect(brand.locator('img')).toHaveCount(0);
    expect(await page.context().cookies(southOrigin)).toEqual([]);
    await page.context().addCookies([{ name: northCookie.name, value: northCookie.value, url: southOrigin, secure: true, httpOnly: true }]);
    expect((await portalFetch('/me')).status).toBe(401);
    await page.goto(`${southOrigin}${share.href}`);
    await expect(page.getByRole('heading', { name: report.title })).toBeVisible();
  });
});
