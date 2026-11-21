import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { workspacePagePatterns, resolveModuleRoute } from '../../apps/web/src/module-routes.ts';
import { localDev, localWorkspaceAccount } from './local-dev.mjs';

const test = base.extend({ dev: localDev });
const accountTest = test.extend({ dev: localWorkspaceAccount });
const language = page => page.getByRole('combobox', { name: /^(介面語言|Interface language)$/ });

test.beforeEach(async ({ context, dev }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === dev.origin ? route.continue() : route.abort());
});

async function workspaceSession(page, dev) {
  const setup = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { name: 'Workspace Owner', email: 'workspace@example.test', workspaceName: 'Workspace acceptance', password: dev.password() },
  });
  expect(setup.status(), await setup.text()).toBe(201);
  const result = await setup.json();
  const { workspaces: [workspace] } = result.data ?? result;
  const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
  expect(csrf.status()).toBe(200);
  const { csrf_token } = await csrf.json();
  const root = `/api/v1/workspaces/${workspace.id}`;
  async function op(method, path, data, version) {
    const response = await page.request.fetch(`${dev.origin}${root}${path}`, {
      method, data, headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID(),
        ...(version === undefined ? {} : { 'If-Match': String(version) }) },
    });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  }
  return { id: workspace.id, path: `/w/${workspace.id}`, get: path => op('GET', path), post: (path, data) => op('POST', path, data), op };
}

async function brandFixtures(session) {
  return Promise.all([
    ['North', 'JP', 'ja-JP', 'JPY', 'Asia/Tokyo', '春の新作'],
    ['South', 'FR', 'fr-FR', 'EUR', 'Europe/Paris', 'Nouveautés de printemps'],
  ].map(async ([name, country_code, locale, currency, timezone, title]) => {
    const brand = await session.post('/brands', { name, slug: name.toLowerCase() });
    const market = await session.post(`/brands/${brand.id}/markets`, { name: country_code, country_code, primary_language: locale, currency, timezone });
    const { item, variants: [variant] } = await session.post('/content-items', { brand_id: brand.id, title,
      variants: [{ platform: 'facebook', format: 'text', market_id: market.id, locale, body_markdown: title }] });
    return { brand, market, item, variant, title, locale };
  }));
}

test('WS01 default brand switcher filters real content and UI locale preserves market and variant data', async ({ page, dev }) => {
  const session = await workspaceSession(page, dev);
  const brands = await brandFixtures(session);
  const businessData = () => Promise.all(brands.map(async ({ market, variant }) => {
    const marketData = await session.get(`/markets/${market.id}`);
    const variantData = (await session.get(`/content-variants/${variant.id}`)).variant;
    return { language: marketData.primary_language, languages: marketData.languages, locale: variantData.locale, market: variantData.market_id };
  }));
  const before = await businessData();
  expect(before.map(data => [data.language, data.locale, data.market])).toEqual(brands.map(({ locale, market }) => [locale, locale, market.id]));
  await page.goto(`${dev.origin}${session.path}/content/library`);
  await expect(page.getByRole('heading', { name: '內容工作台' })).toBeVisible();
  const picker = page.getByRole('combobox', { name: /^(品牌範圍|Brand scope)$/ });
  const row = brand => page.getByRole('row').filter({ hasText: brand.title });
  for (const brand of brands) await expect(row(brand)).toBeVisible();
  for (const [index, current] of brands.entries()) {
    await picker.selectOption(current.brand.id);
    await expect(row(current)).toBeVisible();
    await expect(row(brands[1 - index])).toHaveCount(0);
  }
  await language(page).selectOption('en');
  await expect(page.getByRole('heading', { name: 'Content studio' })).toBeVisible();
  await expect(picker).toHaveValue(brands[1].brand.id);
  await expect(row(brands[1])).toBeVisible();
  await expect(row(brands[0])).toHaveCount(0);
  expect(await businessData()).toEqual(before);
});

accountTest('WS02 Today renders scheduled expiry, provider degradation and administrator terms renewal', async ({ page, dev }) => {
  const session = await workspaceSession(page, dev);
  const fixture = input => dev.workspaceAccountFixture({ workspaceId: session.id, ...input });
  const checkpoint = () => fixture({});
  await expect.poll(checkpoint).toBeGreaterThan(0);
  const previous = await checkpoint();
  const brand = await session.post('/brands', { name: 'Connector fixture', slug: 'connector-fixture' });
  const account = await session.post('/social-accounts', { provider: 'douyin', brand_id: brand.id,
    external_account_id: 'fixture-only', display_name: 'Local account', owned_account_confirmed: true });
  const { bindingId, connectionId } = await fixture({ accountId: account.id, expiresAt: new Date(previous + 30_000).toISOString() });
  const enablePath = `/social-accounts/${account.id}/execution-binding/auto-mode`;
  const limits = { max_per_hour: 1, min_interval_seconds: 120, daily_cap: 2, allowed_windows: [{ start: '09:00', end: '17:00' }] };
  await session.post(enablePath, { ...limits, terms_version: 'fixture-v1', risk_acknowledged: true });
  const items = async () => (await session.get('/overview/today')).items;
  expect((await items()).filter(item => item.kind === 'terms_outdated' || item.resource.id === connectionId)).toEqual([]);
  const updated = { version: 'fixture-v2', text: 'Updated local fixture terms' };
  await fixture({ terms: updated, outage: true });
  await dev.setTime(previous + 60_000);
  await expect.poll(checkpoint).toBe(previous + 60_000);
  await expect.poll(async () => (await session.get('/connections')).find(row => row.id === connectionId)?.status).toBe('reauthorization_required');
  await expect.poll(async () => (await session.get('/notifications')).items.filter(row => row.resource_id === bindingId).length).toBe(1);
  const { items: notifications } = await session.get('/notifications');
  const notification = notifications.find(row => row.resource_id === bindingId);
  const task = await session.get(`/work-items/${notification.work_item_id}`);
  expect(task.status).toBe('open');
  const termsTitle = 'Review the updated automatic mode terms and re-enable automatic mode';
  expect(task.title).toBe(termsTitle);
  expect(notification.title).toBe(termsTitle);
  await page.goto(`${dev.origin}${session.path}/settings/brands?tab=notifications`);
  const noticeRow = page.getByRole('row', { name: new RegExp(termsTitle) });
  await expect(noticeRow).toHaveCount(1);
  await expect(noticeRow).not.toContainText(/處理阻塞/);
  await page.goto(`${dev.origin}${session.path}/me`);
  const taskRow = page.getByRole('row', { name: new RegExp(termsTitle) });
  await expect(taskRow).toHaveCount(1);
  await expect(taskRow).not.toContainText(/處理阻塞/);

  await page.goto(`${dev.origin}${session.path}/home`);
  await expect(page.getByRole('row', { name: /帳號授權已過期/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /部分資料提供者暫不可用.*ingest.health/ })).toBeVisible();
  const row = page.getByRole('row', { name: /條款過期待重新確認/ });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText(/處理阻塞|受阻/);
  await row.getByRole('button', { name: '檢視新條款' }).click();
  await expect(row.getByText(`${updated.version} · ${updated.text}`)).toBeVisible();
  await row.getByRole('checkbox', { name: '我已閱讀條款並確認自動模式風險' }).check();
  const submitted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(enablePath));
  await row.getByRole('button', { name: '確認條款並重新開啟' }).click();
  const response = await submitted;
  expect(response.ok(), await response.text()).toBe(true);
  expect((await response.json()).data).toMatchObject({ connector_mode: 'auto', auto_ack_terms_version: updated.version, ...limits });
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await session.get(`/work-items/${task.id}`)).status).toBe('done');
  await expect(page.getByRole('row', { name: /帳號授權已過期/ })).toBeVisible();
});

async function measure(page, route, measurements) {
  const result = await page.evaluate(() => {
    const width = element => element && { client: element.clientWidth, scroll: element.scrollWidth,
      width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right };
    return { viewport: innerWidth, document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      nav: width(document.querySelector('.sidebar nav')), topbar: width(document.querySelector('.topbar')) };
  });
  measurements.push({ route, ...result });
  expect.soft(result.viewport, route).toBe(1280);
  expect.soft(result.document, `${route} document scroll width`).toBeLessThanOrEqual(result.viewport);
  for (const [name, width] of Object.entries({ nav: result.nav, topbar: result.topbar })) {
    if (!width) continue;
    expect.soft(width.scroll, `${route} ${name} scroll width`).toBeLessThanOrEqual(width.client);
    expect.soft(width.right, `${route} ${name} right edge`).toBeLessThanOrEqual(result.viewport);
  }
}

for (const locale of ['zh-Hant', 'en']) {
  test(`WS01 1280px document and navigation widths on primary pages (${locale})`, async ({ page, dev, browser }, info) => {
    test.setTimeout(150_000);
    const measurements = [];
    try {
      for (const route of ['/login', '/setup', '/invite']) {
        await page.goto(dev.origin + route);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await language(page).selectOption(locale);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await measure(page, route, measurements);
      }
      const session = await workspaceSession(page, dev);
      const [north] = await brandFixtures(session);
      const details = { brands: north.brand.id, content: north.item.id };
      const routes = ['/home', '/access', '/settings/access', '/settings/security', ...workspacePagePatterns.flatMap(pattern => {
        const path = `/${pattern}`;
        const prefix = pattern.startsWith('admin') ? '' : session.path;
        if (!pattern.includes(':')) return [prefix + path];
        const key = resolveModuleRoute(path.replace(':id', 'fixture').replace(':version', '1'))?.resource?.key;
        return details[key] ? [prefix + path.replace(':id', details[key])] : [];
      })].map(path => path.startsWith('/w/') || path.startsWith('/admin') ? path : session.path + path);
      await page.goto(dev.origin + session.path + '/home');
      await expect(page.getByRole('combobox', { name: /品牌範圍|Brand scope/ })).toBeVisible();
      await language(page).selectOption(locale);
      for (const [index, route] of [...new Set(routes)].entries()) {
        // WebKit limits repeated History API calls within a single document.
        if (index % 75 === 0) await page.goto(dev.origin + route);
        else await page.evaluate(path => {
          history.pushState(null, '', path);
          dispatchEvent(new PopStateEvent('popstate'));
        }, route);
        await expect(page, route).toHaveURL(dev.origin + route);
        const main = page.locator('.workspace-main');
        await expect(main.getByRole('heading').first(), route).toBeVisible();
        await expect(main.getByText(/^(載入中|Loading(?:…|\.\.\.)?)$/).first(), route).toBeHidden();
        await page.evaluate(async () => { await document.fonts.ready; });
        await measure(page, route.replace(session.path, '/w/:ws'), measurements);
      }
    } finally {
      const evidence = { engine: browser.browserType().name(), channel: info.project.use.channel, version: browser.version(), locale, measurements };
      await info.attach('workspace-widths', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      console.log(`${evidence.engine} ${evidence.channel ?? ''} ${evidence.version} ${locale}: ${measurements.length} measured pages`);
    }
  });
}
