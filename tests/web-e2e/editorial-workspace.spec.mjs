import { randomUUID } from 'node:crypto';
import { expect, test as base } from '@playwright/test';
import { workspacePagePatterns } from '../../apps/web/src/module-routes.ts';
import { localDev } from './local-dev.mjs';

const test = base.extend({ dev: localDev });
const owner = 'editorial-owner@example.test';
const testId = randomUUID();

async function setup(page, dev, password = dev.password()) {
  const response = await page.request.post(`${dev.origin}/api/v1/setup`, {
    headers: { Origin: dev.origin, 'X-Setup-Token': dev.setupToken },
    data: { name: 'Editorial Owner', email: owner, workspaceName: 'Publishing and operations workspace', password },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { workspaces: [{ id }] } = await response.json();
  const root = `${dev.origin}/api/v1/workspaces/${id}`;
  const call = async (method, path, data) => {
    const csrf = await page.request.get(`${dev.origin}/api/v1/session/csrf`);
    const { csrf_token } = await csrf.json();
    const response = await page.request.fetch(root + path, { method, data,
      headers: { Origin: dev.origin, 'X-CSRF-Token': csrf_token, 'Idempotency-Key': randomUUID() } });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
    return (await response.json()).data;
  };
  return { url: `${dev.origin}/w/${id}`, call, post: (path, data) => call('POST', path, data), password };
}

async function signIn(page, dev, email, password) {
  await page.context().clearCookies();
  await page.goto(`${dev.origin}/login`);
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: /^(登入|Sign in)$/ }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/home$/);
  await expect(page.locator('.workspace-main').getByRole('heading').first()).toBeVisible();
}

async function fits(page) {
  const size = await page.evaluate(() => ({ viewport: innerWidth,
    scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  expect(size, page.url()).toEqual({ viewport: 1280, scroll: 1280 });
}

test('WS01 | Desktop route inventory fits 1280px in both interface languages', async ({ page, dev, browser }, info) => {
  test.setTimeout(180_000);
  for (const route of ['login', 'setup']) {
    await page.goto(`${dev.origin}/${route}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await fits(page);
  }
  const { url, post, password } = await setup(page, dev);
  await signIn(page, dev, owner, password);
  const brand = await post('/brands', { name: 'Primary fixture brand for desktop layouts', slug: 'desktop-layout' });
  const { item } = await post('/content-items', { brand_id: brand.id, title: 'Desktop fixture content' });
  const paths = [...new Set([...workspacePagePatterns.filter(path => !path.startsWith('admin')), 'home', 'home?tab=needs', 'home?tab=health', 'access', 'settings/access', 'settings/security', 'settings/brands?tab=notifications'])]
    .map(path => path.replace(':id', path.startsWith('content/items/') ? item.id : path === 'settings/brands/:id' ? brand.id : testId).replace(':version', '1'))
    .map(path => `${url}/${path}`).concat(workspacePagePatterns.filter(path => path === 'admin' || path.startsWith('admin/')).map(path => `${dev.origin}/${path}`));
  for (const locale of ['zh-Hant', 'en']) {
    await page.goto(`${url}/home`);
    await page.getByRole('combobox', { name: /^(介面語言|Interface language)$/ }).selectOption(locale);
    for (const [index, path] of paths.entries()) {
      if (index % 75 === 0) await page.goto(path);
      else try {
        await page.evaluate(value => { history.pushState(null, '', value); dispatchEvent(new PopStateEvent('popstate')); }, path);
      } catch (error) {
        if (!error.message.includes('Execution context was destroyed')) throw error;
        await page.goto(path);
      }
      await expect(page).toHaveURL(path);
      const main = page.locator('.workspace-main');
      await expect(main.getByRole('heading').first(), path).toBeVisible();
      await expect(main.getByText(/^(載入中|Loading(?:…|\.\.\.)?)$/).first()).toBeHidden();
      await fits(page);
    }
  }
  console.log(`${info.project.name} ${browser.version()}: ${paths.length} authenticated routes × 2 locales + 2 entry pages`);
});

test('OP02 | Private administration renders without SaaS SSO settings', async ({ page, dev }) => {
  const { url } = await setup(page, dev);
  const ssoLabel = /\b(?:SSO|OIDC|SAML|SCIM)\b|single sign[- ]on|單一登入|單點登入/i;
  const ssoLinks = 'a[href*="sso" i], a[href*="oidc" i], a[href*="saml" i], a[href*="scim" i]';
  for (const locale of ['zh-Hant', 'en']) {
    await page.goto(`${url}/home`);
    await page.getByRole('combobox', { name: /^(介面語言|Interface language)$/ }).selectOption(locale);
    for (const [path, heading] of [['health', /^(部署健康|Deployment health)$/],
      ['settings', /^(部署設定|Deployment settings)$/], ['members', /^(租戶成員|Tenant members)$/]]) {
      await page.goto(`${dev.origin}/admin/${path}`);
      const main = page.locator('.workspace-main');
      await expect(main.getByRole('heading', { level: 2, name: heading })).toBeVisible();
      await expect(main.getByText(/^(載入中|Loading(?:…|\.\.\.)?)$/).first()).toBeHidden();
      await expect(page.getByText(ssoLabel)).toHaveCount(0);
      await expect(page.locator(ssoLinks)).toHaveCount(0);
    }
  }
});

test('WS01 | Brand switch filters live content lists and preserves market and content language', async ({ page, dev }) => {
  const { url, post, call, password } = await setup(page, dev);
  await signIn(page, dev, owner, password);
  const north = await post('/brands', { name: 'North editorial', slug: 'north-editorial' });
  const south = await post('/brands', { name: 'South editorial', slug: 'south-editorial' });
  const market = await post(`/brands/${north.id}/markets`, { name: 'Japan', country_code: 'JP', primary_language: 'ja-JP', currency: 'JPY', timezone: 'Asia/Tokyo' });
  const { variants: [variant] } = await post('/content-items', { brand_id: north.id, title: 'North content only', variants: [{ platform: 'facebook', format: 'text', market_id: market.id, locale: 'ja-JP', body_markdown: '春季新品' }] });
  await post('/content-items', { brand_id: south.id, title: 'South content only' });
  await page.goto(`${url}/content`);
  const switcher = page.getByRole('combobox', { name: /^(品牌範圍|Brand scope)$/ });
  await expect(page.getByText('North content only', { exact: true })).toBeVisible();
  await expect(page.getByText('South content only', { exact: true })).toBeVisible();
  await switcher.selectOption(north.id);
  await expect(page.getByText('North content only', { exact: true })).toBeVisible();
  await expect(page.getByText('South content only', { exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: /^(介面語言|Interface language)$/ }).selectOption('en');
  await switcher.selectOption(south.id);
  await expect(page.getByText('South content only', { exact: true })).toBeVisible();
  await expect(page.getByText('North content only', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(switcher).toHaveValue(south.id);
  expect((await call('GET', `/content-variants/${variant.id}`)).variant.locale).toBe('ja-JP');
  expect((await call('GET', `/brands/${north.id}/markets`)).find(row => row.id === market.id).primary_language).toBe('ja-JP');
  await fits(page);
});

test('WS06 | A second administrator resumes and skips the shared step from the setup page', async ({ page, browser, dev }) => {
  const { url, password } = await setup(page, dev);
  await page.goto(`${url}/home`);
  await page.getByRole('link', { name: '首次設定', exact: true }).click();
  const history = page.getByRole('region', { name: '歷史資料同步' });
  await history.getByRole('button', { name: '檢查步驟' }).click();
  await expect(history.getByText('未完成', { exact: true })).toBeVisible();
  const email = 'editorial-admin@example.test';
  dev.switchIdentity({ email, name: 'Second administrator', role: 'admin' });
  const fresh = await browser.newContext();
  try {
    const second = await fresh.newPage();
    const login = await second.request.post(`${dev.origin}/api/v1/login`, { headers: { Origin: dev.origin }, data: { email, password } });
    expect(login.status(), await login.text()).toBe(200);
    await second.goto(`${url}/setup`);
    await expect(second.getByRole('link', { name: '繼續設定' })).toHaveAttribute('href', '#setup-history_sync');
    const resumed = second.getByRole('region', { name: '歷史資料同步' });
    await expect(resumed.getByText('未完成', { exact: true })).toBeVisible();
    await resumed.getByRole('button', { name: '略過步驟' }).click();
    await resumed.getByRole('textbox', { name: '略過原因' }).fill('Legacy export is pending');
    await resumed.getByRole('button', { name: '確認略過' }).click();
    await expect(resumed.getByText('已略過', { exact: true })).toBeVisible();
    await second.goto(`${url}/home`);
    await expect(second.getByRole('heading', { name: '已略過的設定步驟' })).toBeVisible();
    await expect(second.getByText(/Historical metrics and comparisons may be incomplete/)).toBeVisible();
  } finally {
    await fresh.close();
  }
});
