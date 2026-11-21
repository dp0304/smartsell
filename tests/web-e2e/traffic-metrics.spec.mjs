import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import { tsImport } from 'tsx/esm/api';

const publicHost = 'go.brand.co';
const shop = 'https://shop.brand.co';
const webRoot = new URL('../../apps/web/', import.meta.url);
const requireWeb = createRequire(new URL('package.json', webRoot));
const test = base.extend({
  traffic: async ({}, use) => {
    const { db, server, config, identity, context, traffic, commerce, analytics } =
      await tsImport('./traffic-host.ts', import.meta.url);
    const root = await mkdtemp(join(tmpdir(), 'smartsell-traffic-browser-'));
    const store = await db.fileStore(join(root, 'state.json'));
    const scope = { workspaceId: randomUUID(), tenantId: randomUUID(), actorId: randomUUID() };
    const token = identity.opaque();
    const csrf = identity.opaque();
    const settings = config.configuration({ PUBLIC_ORIGIN: 'https://admin.brand.co', SMARTSELL_TRAFFIC_PII_KEY: 'aa'.repeat(32),
      SMARTSELL_TRAFFIC_HOSTS: JSON.stringify({ [`http://${publicHost}`]: scope.workspaceId }) });
    const analyticsOperations = new Set(['links_performance_get', 'experiments_list', 'experiment_get',
      'experiments_create', 'experiment_start', 'experiment_record_result']);
    const operations = Object.entries({ traffic: traffic.operations,
      commerce: commerce.operations.filter(operation => operation.name === 'commerce_variant_update'),
      analytics: analytics.operations.filter(operation => analyticsOperations.has(operation.name)),
    }).flatMap(([module, operations]) => operations.map(operation => ({ ...operation, module })));
    const app = server.createServer({ config: settings, store, operations });
    let ingress;
    try {
      const inWorkspace = fn => store.transaction({}, async tx => fn(context.makeContext(await tx.workspace(scope), scope, 'owner')));
      await store.transaction({ identityWrite: true }, async tx => {
        tx.identity.put(`workspace/${scope.workspaceId}`, { id: scope.workspaceId, tenantId: scope.tenantId });
        tx.identity.put(`tenant/${scope.tenantId}`, { status: 'active' });
        tx.identity.put(`user/${scope.actorId}`, { id: scope.actorId });
        tx.identity.put(`member/${scope.actorId}/${scope.workspaceId}`, { userId: scope.actorId, workspaceId: scope.workspaceId, role: 'owner' });
        tx.identity.put(`session/${identity.digest(token)}`, { userId: scope.actorId, csrf, expires: Math.floor(Date.now() / 1000) + 600 });
      });
      const fixtures = await inWorkspace(ctx => {
        const domain = ctx.create('link_domain', { hostname: publicHost, verification_status: 'verified', tls_status: 'active' });
        const store = ctx.create('store', { provider: 'shopee', status: 'active' });
        const product = ctx.create('product', { store_id: store.id, status: 'active' });
        const variant = ctx.create('product_variant', { product_id: product.id, store_id: store.id, status: 'active', source: { kind: 'manual' } });
        const purchaseUrl = `${shop}/product/123/456`;
        ctx.create('listing_snapshot', { variant_id: variant.id, market_id: 'tw', is_current: true, purchase_url: purchaseUrl });
        return { domain, variant, purchaseUrl };
      });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const keyFile = join(root, 'key.pem');
      const certFile = join(root, 'cert.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${publicHost}`,
        '-days', '1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
      const tls = { key: await readFile(keyFile), cert: await readFile(certFile) };
      ingress = createHttpsServer(tls, (req, res) => {
        const upstream = httpRequest(`${address}${req.url}`, { method: req.method, headers: req.headers }, response => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        });
        upstream.on('error', () => res.writeHead(502).end());
        req.pipe(upstream);
      });
      ingress.listen(0, '127.0.0.1');
      await once(ingress, 'listening');
      const authority = `${publicHost}:${ingress.address().port}`;
      const origin = `https://${authority}`;
      settings.traffic.domains.set(authority, { origin, workspaceId: scope.workspaceId });
      const sessionFor = async role => {
        const userId = randomUUID();
        const token = identity.opaque();
        const csrf = identity.opaque();
        await store.transaction({ identityWrite: true }, async tx => {
          tx.identity.put(`user/${userId}`, { id: userId });
          tx.identity.put(`member/${userId}/${scope.workspaceId}`, { userId, workspaceId: scope.workspaceId, role });
          tx.identity.put(`session/${identity.digest(token)}`, { userId, csrf, expires: Math.floor(Date.now() / 1000) + 600 });
        });
        return { token, csrf };
      };
      const op = async (path, { body, method = body === undefined ? 'GET' : 'POST', version, status = 200, session = { token, csrf } } = {}) => {
        const response = await fetch(`${address}/api/v1/workspaces/${scope.workspaceId}${path}`, {
          method, body: body === undefined ? undefined : JSON.stringify(body),
          headers: { cookie: `__Host-smartsell_session=${session.token}`, origin: settings.origin, 'x-csrf-token': session.csrf,
            ...(body !== undefined && { 'content-type': 'application/json' }), ...(version !== undefined && { 'if-match': String(version) }) },
        });
        const text = await response.text();
        expect(response.status, text).toBe(status);
        return JSON.parse(text).data;
      };
      await op('/redirect-allowlist', { body: { hostname: new URL(shop).hostname } });
      await use({ address, authority, origin, op, inWorkspace, sessionFor, root, scope, token, tls, allowedOrigins: settings.origins, ...fixtures });
    } finally {
      if (ingress?.listening) await new Promise(resolve => ingress.close(resolve));
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  workbench: async ({ traffic }, use) => {
    const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href);
    const web = await createServer({
      root: fileURLToPath(webRoot), configLoader: 'runner', cacheDir: join(traffic.root, 'vite-cache'),
      server: { strictPort: false, https: traffic.tls, watch: null, proxy: { '/api': traffic.address } },
    });
    try {
      await web.listen();
      const [origin] = web.resolvedUrls.local;
      traffic.allowedOrigins.add(new URL(origin).origin);
      await use(async (page, section, token = traffic.token) => {
        await page.context().addCookies([{ name: '__Host-smartsell_session', value: token, url: origin, secure: true, httpOnly: true }]);
        await page.addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
        await page.goto(new URL(`/w/${traffic.scope.workspaceId}/${section}`, origin).href);
      });
    } finally {
      await web.close();
    }
  },
});

test.use({ ignoreHTTPSErrors: true, locale: 'en-US',
  launchOptions: { args: [`--host-resolver-rules=MAP ${publicHost} 127.0.0.1`, '--no-proxy-server'] } });

test('LP02 LP03 AN03 | HTTPS short-link revisions, Bio refresh, and workspace link performance', async ({ page, request, traffic, workbench }, testInfo) => {
  const { address, authority, origin, op, domain, variant, purchaseUrl } = traffic;
  const createLink = body => op('/short-links', { body: { domain_id: domain.id, brand_id: 'brand', ...body } });
  const oldUrl = `${shop}/sale`;
  const newUrl = `${shop}/new`;
  const tracked = url => `${url}?utm_source=bio`;
  const sale = await createLink({ code: 'sale', destination_url: oldUrl, utm_params: { utm_source: 'bio' } });
  const product = await createLink({ code: 'product', destination_url: purchaseUrl, product_variant_id: variant.id, market_id: 'tw' });
  const bio = await op('/bio-pages', { body: { handle: 'brand', brand_id: 'brand', title: 'Brand' } });
  const bioPath = `/bio-pages/${bio.id}`;
  const bioVersion = async () => (await op('/bio-pages')).find(row => row.id === bio.id).version;
  const addItem = async body => op(`${bioPath}/items`, { version: await bioVersion(), body });
  const offer = await addItem({ label: 'Sale', short_link_id: sale.id });
  await addItem({ label: 'Taiwan product', short_link_id: product.id, market_ids: ['tw'] });
  await op(`${bioPath}/publish`, { version: await bioVersion(), body: {} });

  const preview = await request.get(`${address}/sale`, {
    maxRedirects: 0, headers: { host: authority, 'user-agent': 'Twitterbot' },
  });
  expect(preview.status()).toBe(302);
  expect(preview.headers().location).toBe(tracked(oldUrl));
  const linkPath = `/short-links/${sale.id}`;
  const totals = async (revisionId) => {
    const query = revisionId ? `?revision_id=${revisionId}` : '';
    const { items } = await op(`${linkPath}/stats${query}`);
    const fields = ['redirects', 'human_likely', 'bot_filtered', 'unknown'];
    return Object.fromEntries(fields.map(field => [field, items.reduce((sum, row) => sum + row[field], 0)]));
  };
  expect(await totals()).toEqual({ redirects: 1, human_likely: 0, bot_filtered: 1, unknown: 0 });
  // The browser reaches SmartSell over TCP. Only outbound merchant pages use a fixture response.
  await page.route(`${shop}/**`, route => route.fulfill({ body: 'Merchant destination fixture' }));
  const bioUrl = `${origin}/b/brand`;
  await page.goto(bioUrl);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  await page.getByRole('link', { name: 'English' }).click();
  await expect(page.getByRole('link', { name: 'Taiwan product' })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Market' }).getByRole('link', { name: 'tw', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'Taiwan product' })).toBeVisible();
  const selectedBio = page.url();
  await page.getByRole('link', { name: 'Taiwan product' }).click();
  await expect(page).toHaveURL(purchaseUrl);
  await page.goto(selectedBio);
  await page.getByRole('link', { name: 'Sale' }).click();
  await expect(page).toHaveURL(tracked(oldUrl));
  expect(await totals()).toEqual({ redirects: 2, human_likely: 1, bot_filtered: 1, unknown: 0 });
  const revision = await op(`${linkPath}/destination`, { version: sale.version, body: { destination_url: newUrl, reason: 'Seasonal page' } });
  const detail = await op(linkPath);
  expect(detail.revisions.map(row => [row.id, row.destination_url])).toEqual([[sale.current_revision_id, oldUrl], [revision.id, newUrl]]);
  await page.goto(selectedBio);
  await page.getByRole('link', { name: 'Sale' }).click();
  await expect(page).toHaveURL(tracked(newUrl));
  const unclassified = await request.get(`${address}/sale`, { maxRedirects: 0, headers: { host: authority } });
  expect(unclassified.status()).toBe(302);
  expect(await totals(sale.current_revision_id)).toEqual({ redirects: 2, human_likely: 1, bot_filtered: 1, unknown: 0 });
  expect(await totals(revision.id)).toEqual({ redirects: 2, human_likely: 1, bot_filtered: 0, unknown: 1 });
  await page.goto(selectedBio);
  await expect(page.getByRole('link', { name: 'Sale' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Taiwan product' })).toBeVisible();
  await op(`/bio-items/${offer.id}`, { method: 'PATCH', version: offer.version, body: { valid_until: '2020-01-01T00:00:00Z' } });
  const archived = await op(`/variants/${variant.id}`, { method: 'PATCH', version: variant.version, body: { status: 'archived' } });
  expect(archived.status).toBe('archived');
  expect((await op(`/short-links/${product.id}`)).status).toBe('active');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'Sale' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Taiwan product' })).toHaveCount(0);
  await expect(page.getByText('Some links have expired.')).toBeVisible();
  await expect(page.getByText('Some products have been delisted.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('bio-availability.png') });

  const day = instant => new Date(instant).toISOString().slice(0, 10);
  const from = day(sale.created_at);
  const to = day(Date.now() + 86_400_000);
  const range = new URLSearchParams({ from, to, tz: 'UTC', short_link_id: sale.id });
  const { items } = await op(`/performance/links?${range}`);
  expect(items).toMatchObject([{ short_link_id: sale.id, redirects: 4, clicks_filtered: 3 }]);
  await workbench(page, 'reports');
  await page.getByRole('button', { name: 'Link performance', exact: true }).click();
  await page.getByLabel('Start date').fill(from);
  await page.getByLabel('End date (exclusive)').fill(to);
  await page.getByLabel('Short link ID (optional)').fill(sale.id);
  const reported = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/performance/links'));
  await page.getByRole('button', { name: 'Query link performance' }).click();
  const response = await reported;
  expect(response.ok()).toBe(true);
  expect(Object.fromEntries(new URL(response.url()).searchParams)).toEqual(Object.fromEntries(range));
  expect((await response.json()).data.items).toEqual(items);
  const table = page.getByRole('region', { name: 'Link performance results' }).getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Short link ID', 'Redirects', 'Filtered clicks']);
  await expect(table.getByRole('row').filter({ hasText: sale.id }).getByRole('cell')).toHaveText([sale.id, '4', '3']);
  await table.screenshot({ path: testInfo.outputPath('workspace-link-performance.png') });
});

test('LP06 | workspace keeps check history and withholds a conclusion for low traffic', async ({ page, traffic, workbench }, testInfo) => {
  const { op } = traffic;
  const { id, version, draft } = await op('/landing-pages', { body: {
    slug: 'experiment', brand_id: 'brand', title: 'Control', blocks: [{ type: 'text', text: 'Control content' }],
  } });
  const pagePath = `/landing-pages/${id}`;
  const alternate = await op(`${pagePath}/versions`, { version, body: {
    title: 'Alternate', blocks: [{ type: 'text', text: 'Alternate content' }],
  } });
  const checkVersion = (target_id, items) => op('/page-checks', { body: { target_type: 'landing_page_version', target_id, items } });
  const evidence = [{ check: 'http_status', result: 'pass', detail: 'Observed response in local fixture' }];
  await checkVersion(draft.id, evidence);
  const unknown = await checkVersion(alternate.id);
  expect(unknown.status).toBe('unknown');
  const [landing] = await op('/landing-pages');
  await op(`${pagePath}/publish`, { version: landing.version, body: { version_id: alternate.id }, status: 409 });
  const pass = await checkVersion(alternate.id, evidence);
  expect(pass.status).toBe('pass');
  expect(pass.id).not.toBe(unknown.id);

  const hypothesis = 'The alternate page improves conversion';
  const day = instant => new Date(instant).toISOString().slice(0, 10);
  const experiment = await op('/experiments', { body: {
    type: 'page', hypothesis, primary_metric: 'conversion', success_criteria: 'Higher conversion', minimum_sample_size: 5,
    period: { from: day(Date.now()), to: day(Date.now() + 86_400_000), tz: 'UTC' },
    variants: [{ ref_id: draft.id, allocation: 50 }, { ref_id: alternate.id, allocation: 50 }],
  } });
  await op(`${pagePath}/experiment`, { version: landing.version, method: 'PUT', body: {
    experiment_id: experiment.id, arms: [{ arm_key: 'control', version_id: draft.id, weight: 50 },
      { arm_key: 'alternate', version_id: alternate.id, weight: 50 }],
  } });
  await op(`/experiments/${experiment.id}/start`, { version: experiment.version, body: {} });
  await op(`/experiments/${experiment.id}/results`, { body: {
    source: 'page', source_ref: 'local-small-sample', as_of: new Date().toISOString(), limitations: ['Local fixture'],
    variants: [{ ref_id: draft.id, sample_size: 5, value: 0 }, { ref_id: alternate.id, sample_size: 2, value: 0 }],
  } });
  const reportPath = `${pagePath}/experiment?experiment_id=${experiment.id}`;
  const report = await op(reportPath);
  expect(report).toMatchObject({ coverage: 'insufficient_traffic', minimum_sample_size: 5,
    arms: [{ arm_key: 'control', sample_size: 5, value: 0 }, { arm_key: 'alternate', sample_size: 2, value: 0 }] });

  await workbench(page, 'traffic/checks');
  const checks = page.getByRole('table');
  const history = checks.getByRole('row').filter({ hasText: alternate.id });
  await expect(history).toHaveCount(2);
  await expect(history.getByRole('cell').filter({ hasText: /^(unknown|pass)$/ })).toHaveText(['unknown', 'pass']);
  await checks.screenshot({ path: testInfo.outputPath('workspace-url-checks.png') });

  await page.getByRole('link', { name: 'Analytics & reports' }).click();
  // Analytics has more tabs than fit on one row; the rest sit under "More".
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Experiments', exact: true }).click();
  const loaded = page.waitForResponse(response => response.url().endsWith(reportPath));
  await page.getByRole('button', { name: hypothesis }).click();
  const response = await loaded;
  expect(response.ok()).toBe(true);
  expect((await response.json()).data).toEqual(report);
  const results = page.getByRole('region', { name: 'Landing page experiment report' });
  await expect(results.getByRole('status')).toHaveText('Insufficient traffic to draw a conclusion.');
  await expect(results.getByText('Minimum sample size per arm · 5')).toBeVisible();
  await expect(results.getByRole('row').filter({ hasText: 'control' }).getByRole('cell')).toHaveText(['control', '5', '0']);
  await expect(results.getByRole('row').filter({ hasText: 'alternate' }).getByRole('cell')).toHaveText(['alternate', '2', '0']);
  await results.screenshot({ path: testInfo.outputPath('workspace-experiment.png') });
});

test('LP05 | public lead consent, workbench columns and manual CRM receipts', async ({ page, browser, traffic, workbench }, testInfo) => {
  const { op, origin, inWorkspace, sessionFor } = traffic;
  const editor = await sessionFor('editor');
  const copy = await inWorkspace(ctx => ctx.create('consent_text_version', {
    channel: 'email', purpose: 'service', text: 'Reply to my inquiry', effective_from: ctx.now,
  }));
  const form = await op('/forms', { body: { slug: 'contact', name: 'Contact', brand_id: 'brand' } });
  const formPath = `/forms/${form.id}`;
  const version = await op(`${formPath}/versions`, { version: form.version, body: {
    title: 'Contact', fields: [{ key: 'email', label: 'Email', required: true }],
    channel_options: [{ purpose: 'service', channel: 'email', consent_text_version_id: copy.id }],
  } });
  await op(`${formPath}/activate`, { version: (await op('/forms'))[0].version, body: { version_id: version.id } });
  const landing = await op('/landing-pages', { body: { slug: 'contact', title: 'Contact', brand_id: 'brand',
    blocks: [{ type: 'form', form_id: form.id }] } });
  await op('/page-checks', { body: { target_type: 'landing_page_version', target_id: landing.draft.id,
    items: [{ check: 'http_status', result: 'pass', detail: 'Observed local fixture' }] } });
  await op(`/landing-pages/${landing.id}/publish`, { version: landing.version, body: { version_id: landing.draft.id } });

  const submitted = new Set();
  const submitLead = async (name, permitsContact) => {
    await page.goto(`${origin}/p/contact`);
    const field = page.locator('input[name="consent"]');
    await expect(field).toHaveCount(1);
    await expect(field).not.toBeChecked();
    if (permitsContact) await field.check();
    await page.getByLabel('Email').fill(`${name}@example.test`);
    const posted = page.waitForResponse(res => res.url().endsWith(`/f/${form.id}/submit`));
    await page.getByRole('button', { name: '送出', exact: true }).click();
    expect((await posted).status()).toBe(200);
    await expect(page.getByRole('heading', { name: '已收到您的資料' })).toBeVisible();
    const leads = await op('/leads');
    expect(leads).toHaveLength(submitted.size + 1);
    const lead = leads.find(lead => !submitted.has(lead.id));
    submitted.add(lead.id);
    return lead;
  };
  const pending = await submitLead('no-consent', false);
  const continuing = await submitLead('service-only', true);
  const sale = await submitLead('fixture-sale', true);
  expect([pending, continuing, sale].map(lead => [lead.status, lead.contact])).toEqual([
    ['contact_not_permitted', 'masked'], ['contact_permitted', 'masked'], ['contact_permitted', 'masked'],
  ]);
  const path = `/leads/${sale.id}`;
  const readLead = () => op(path);
  const update = async (lead, body, status) => op(`/leads/${lead.id}`, { method: 'PATCH', version: lead.version, body, status });
  const marketing = { status: 'contacted', channel: 'email', purpose: 'marketing', outcome: 'Fixture only' };
  await update(pending, marketing, 409);
  await update(continuing, marketing, 409);
  await update(pending, { status: 'converted' }, 409);

  await workbench(page, 'traffic');
  await page.getByRole('button', { name: 'Leads', exact: true }).click();
  const board = page.getByRole('region', { name: 'Lead inbox' });
  const column = name => board.getByRole('region', { name, exact: true });
  await expect(column('Awaiting contact').getByRole('button', { name: pending.id })).toBeVisible();
  await expect(column('Contact permitted').getByRole('listitem')).toHaveCount(2);
  await expect(column('Converted').getByRole('listitem')).toHaveCount(0);
  await column('Awaiting contact').getByRole('button', { name: pending.id }).click();
  await expect(page.getByText('No active channel consent')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record contact', exact: true })).toHaveCount(0);
  await column('Contact permitted').getByRole('button', { name: sale.id }).click();

  const act = async (name, fields, endpoint, method = 'POST', confirm = false) => {
    await page.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name });
    for (const [label, value] of Object.entries(fields)) {
      const field = dialog.getByRole('combobox', { name: label, exact: true }).or(dialog.getByRole('textbox', { name: label, exact: true }));
      if (await field.evaluate(element => element.tagName === 'SELECT')) await field.selectOption(value);
      else await field.fill(value);
    }
    if (confirm) await dialog.getByRole('checkbox').check();
    const saved = page.waitForResponse(res => new URL(res.url()).pathname.endsWith(endpoint) && res.request().method() === method);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    await expect(dialog.getByRole('status')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  };
  await act('Record contact', { Channel: 'email', 'Contact purpose': 'service', 'Follow-up outcome': 'Synthetic service follow-up' }, path, 'PATCH');
  await act('Qualify lead', { 'Follow-up outcome': 'Synthetic need confirmed' }, path, 'PATCH');
  const handoff = { channel: 'email', destination: 'fixture-crm' };
  await op(`${path}/handoff`, { version: (await readLead()).version, body: handoff, status: 403, session: editor });
  await act('Request CRM handoff', { Channel: 'email', 'CRM destination': handoff.destination }, `${path}/handoff`, 'POST', true);
  await expect(page.getByText('Waiting for the CRM receipt.')).toBeVisible();
  const recordReceipt = (outcome, evidence, more = {}) => act('Record CRM readback', {
    'Receipt outcome': outcome, 'Receipt evidence': evidence, ...more,
  }, `${path}/handoff/receipt`);
  await recordReceipt('unknown', 'fixture-inconclusive');
  await expect(page.getByText('CRM result unknown. Verify the receipt first.')).toBeVisible();
  await expect(page.getByText(/CRM receipt · unknown · fixture-inconclusive/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark converted' })).toHaveCount(0);
  const unknown = await readLead();
  expect(unknown.status).toBe('qualified');
  await update(unknown, { status: 'converted' }, 409);
  await op(`${path}/handoff`, { version: unknown.version, body: handoff, status: 409 });
  const evidence = { handoff_id: unknown.handoff_id, outcome: 'confirmed', evidence_ref: 'fixture-confirmed', external_ref: 'fixture-reference' };
  await op(`${path}/handoff/receipt`, { version: unknown.version, body: evidence, status: 403, session: editor });
  await op(`${path}/handoff/receipt`, { version: unknown.version, body: { ...evidence, evidence_ref: '' }, status: 422 });

  const editorContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const editorPage = await editorContext.newPage();
    await workbench(editorPage, 'traffic', editor.token);
    await editorPage.getByRole('button', { name: 'Leads', exact: true }).click();
    await editorPage.getByRole('button', { name: sale.id, exact: true }).click();
    await expect(editorPage.getByText('CRM result unknown. Verify the receipt first.')).toBeVisible();
    await expect(editorPage.getByRole('button', { name: 'Record CRM readback' })).toHaveCount(0);
    await expect(editorPage.getByText(/fixture-inconclusive/)).toHaveCount(0);
    expect(await op(path, { session: editor })).not.toHaveProperty('handoff_receipts');
  } finally {
    await editorContext.close();
  }

  await recordReceipt('confirmed', evidence.evidence_ref, { 'CRM reference': evidence.external_ref });
  expect((await readLead()).status).toBe('handed_off');
  await act('Mark converted', { 'Follow-up outcome': 'Fixture sale' }, path, 'PATCH');
  await page.reload();
  await expect(column('Converted').getByRole('button', { name: sale.id })).toBeVisible();
  await expect(column('Awaiting contact').getByRole('listitem')).toHaveCount(1);
  await expect(column('Contact permitted').getByRole('listitem')).toHaveCount(1);
  await column('Converted').getByRole('button', { name: sale.id }).click();
  await expect(page.getByText(/CRM receipt · confirmed · fixture-confirmed/)).toBeVisible();
  await expect(page.getByText(/@example\.test/)).toHaveCount(0);
  expect(JSON.stringify(await op('/leads'))).not.toMatch(/@example\.test|contact_encrypted|evidence_ref/);
  expect(await readLead()).toMatchObject({ status: 'converted', handoff_receipts: [{ outcome: 'confirmed', evidence_ref: 'fixture-confirmed' }] });
  await inWorkspace(ctx => {
    expect(ctx.list('consent_record').map(row => row.purpose)).toEqual(['service', 'service']);
    expect(ctx.list('lead_activity').filter(row => row.type === 'contacted').map(row => row.purpose)).toEqual(['service']);
    expect(ctx.list('lead_handoff')).toHaveLength(1);
    expect(ctx.list('work_item').filter(row => row.resource_type === 'lead').map(row => row.status)).toEqual(['done']);
    expect(ctx.list('webhook_delivery')).toHaveLength(0);
  });
  await board.screenshot({ path: testInfo.outputPath('workspace-lead-columns.png') });
});

test('AN03 | consented Chromium sessions with identical browser signals stay separate', async ({ page, browser, traffic }) => {
  const { origin, op, inWorkspace } = traffic;
  const merchantUrl = `${shop}/campaign`;
  const { draft, id } = await op('/landing-pages', { body: { slug: 'campaign', brand_id: 'brand', title: 'Campaign', locale: 'en',
    blocks: [{ type: 'text', text: 'Analytics acceptance' }, { type: 'cta', label: 'Visit merchant', url: merchantUrl }] } });
  await op('/page-checks', { body: { target_type: 'landing_page_version', target_id: draft.id,
    items: [{ check: 'http_status', result: 'pass', detail: 'Local browser fixture' }] } });
  const [landing] = await op('/landing-pages');
  await op(`/landing-pages/${id}/publish`, { version: landing.version, body: { version_id: draft.id } });
  const path = `${origin}/p/campaign`;
  const touchpoints = () => inWorkspace(ctx => ctx.list('touchpoint_event'));
  const select = async (visitor, name) => {
    const posted = visitor.waitForResponse(response => response.url() === path && response.request().method() === 'POST');
    await visitor.getByRole('button', { name }).click();
    const response = await posted;
    const headers = await response.request().allHeaders();
    expect(response.status(), `Origin: ${headers.origin}; Fetch site: ${headers['sec-fetch-site']}`).toBe(303);
    await expect(visitor.getByRole('button', { name })).toBeDisabled();
  };
  const separate = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 800 } });
  try {
    const second = await separate.newPage();
    await page.goto(path);
    await second.goto(path);
    expect(await page.evaluate(() => navigator.userAgent)).toBe(await second.evaluate(() => navigator.userAgent));
    expect(await touchpoints()).toHaveLength(0);
    await select(page, 'Allow analytics');
    await page.reload();
    expect(await touchpoints()).toHaveLength(2);
    expect(await separate.cookies(origin)).toEqual([]);
    await select(second, 'Decline analytics');
    await second.reload();
    expect(await touchpoints()).toHaveLength(2);
    await select(second, 'Allow analytics');
    const events = await touchpoints();
    expect(events).toHaveLength(3);
    expect(events.every(row => row.event_type === 'page_view' && row.consent_state === 'opted_in' && Boolean(row.session_ref))).toBe(true);
    const sessions = Object.groupBy(events, row => row.session_ref);
    expect(Object.values(sessions).map(rows => rows.length).sort()).toEqual([1, 2]);
    expect(JSON.stringify(events)).not.toMatch(/user_agent|ip_address|fingerprint/i);
    const consentCookie = async context => (await context.cookies(origin)).find(cookie => cookie.name === '__Host-smartsell_traffic_consent');
    const firstCookie = await consentCookie(page.context());
    const secondCookie = await consentCookie(separate);
    expect(firstCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(secondCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(secondCookie.value).not.toBe(firstCookie.value);
    await select(page, 'Decline analytics');
    await page.reload();
    expect(await touchpoints()).toHaveLength(3);
    await second.reload();
    expect((await touchpoints()).slice(3).map(row => row.session_ref)).toEqual([events[2].session_ref]);
  } finally {
    await separate.close();
  }
});
