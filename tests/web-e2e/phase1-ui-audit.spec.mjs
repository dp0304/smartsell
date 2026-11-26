import { expect, test as base } from '@playwright/test';
import { localDev } from './local-dev.mjs';
import { ownerWorkspace, pairMachine, postingFixture, schedulePost } from './phase1-fixture.mjs';
import { expectToday } from './phase1-shell.mjs';

// Fixes from the phase-1 web UI audit before launch (U2–U9), on real phase-1 data made by phase1-fixture.mjs.
const test = base.extend({ dev: localDev });
test.use({ viewport: { width: 1280, height: 800 }, timezoneId: 'UTC' });

async function horizontalOverflow(page) {
  return page.evaluate(() => document.scrollingElement.scrollWidth - document.documentElement.clientWidth);
}

test('U2: sign-in, first-run setup and the signed-out error page fit a phone, with no desktop-width notice', async ({ browser, dev }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    for (const path of ['/login', '/setup']) {
      await page.goto(`${dev.origin}${path}`);
      await expect(page.locator('.auth-card')).toBeVisible();
      await expect(page.locator('.narrow-notice')).toBeHidden();
      expect(await horizontalOverflow(page), path).toBeLessThanOrEqual(0);
      // One column: the form starts below the brand strip and uses the screen width.
      const card = await page.locator('.auth-card').boundingBox();
      expect(card.width, path).toBeGreaterThan(300);
      expect(card.x + card.width, path).toBeLessThanOrEqual(390);
    }
    // The page shown when the session cannot be read (the hub is unreachable).
    await page.route('**/api/v1/session', route => route.abort());
    await page.goto(`${dev.origin}/somewhere`);
    await expect(page.locator('.entry-error')).toBeVisible();
    await expect(page.locator('.narrow-notice')).toBeHidden();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

test('U8: a refused URL paste says which link is wanted; status and code stay folded under 詳細資料', async ({ page, dev }) => {
  const fixture = await postingFixture(page, dev);
  const { ws, machine, channelId } = fixture;
  const { settings } = await ws.rest('GET', `/views/channels/${channelId}`);
  await ws.rest('PATCH', `/hub/channels/${channelId}/settings`, { approval_mode: 'direct' }, { version: settings.version });
  const { post } = await schedulePost(fixture, { caption: '新魚餌實測' });
  const [job] = await machine.claim();
  await machine.report(job, 'started', { go: 'hub', mode: 'assist' });
  await machine.report(job, 'submitting', {});
  await machine.report(job, 'outcome_unknown', { reason: 'readback_timeout', evidence_sha256: [] });

  await page.goto(`${ws.app}/posts/${post.post_id}`);
  const main = page.getByRole('main');
  await main.getByRole('button', { name: /^貼上網址/ }).first().click();
  await main.getByLabel('貼文網址').fill('https://example.com/some/page');
  await main.getByRole('button', { name: '確認', exact: true }).click();
  const alert = main.getByRole('alert');
  await expect(alert).toContainText('中樞不接受這個網址（這不是 X 的網址）。請貼上 @fixture_x 在 X 上這則貼文的網址，例如 https://x.com/fixture_x/status/');
  await expect(alert.locator('strong')).toHaveText('無法完成請求');
  const folded = alert.locator('details');
  await expect(folded).not.toHaveAttribute('open', /.*/);
  await expect(folded.getByText('422 · INVALID_ARGUMENTS')).toBeHidden();
  await folded.locator('summary').click();
  await expect(folded.getByText('422 · INVALID_ARGUMENTS')).toBeVisible();

  // The hub unreachable: what to check, not 「請確認後端已啟動」.
  await page.route('**/api/v1/session', route => route.abort());
  await page.goto(`${dev.origin}/somewhere`);
  const down = page.locator('.entry-error').getByRole('alert');
  await expect(down).toContainText('中樞沒有回應。請確認中樞那台電腦開著、SmartSell 正在執行');
  await expect(down).not.toContainText('後端');
});

test('O6: under the dev server /agent/relay.mjs reaches the API, not the web page; /agent-connect stays the web page', async ({ page, dev }) => {
  const relay = await page.request.get(`${dev.origin}/agent/relay.mjs`);
  // The bundle, or 503 RELAY_BUNDLE_MISSING from the API when it has not been built; never the SPA's index.html.
  expect(relay.headers()['content-type'] ?? '').not.toMatch(/text\/html/);
  if (relay.status() === 200) expect(relay.headers()['content-type']).toMatch(/javascript/);
  else expect(JSON.stringify(await relay.json())).toContain('RELAY_BUNDLE_MISSING');
  const connect = await page.request.get(`${dev.origin}/agent-connect?client=codex`);
  expect(connect.headers()['content-type']).toMatch(/text\/html/);
});

test('O7: the first-run forms say where the setup token is; the hub:init link is the one path and offers no other form', async ({ page, dev }) => {
  await page.goto(`${dev.origin}/login`);
  await expect(page.getByRole('heading', { name: '註冊', exact: true })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('pnpm hub:init 時印出的設定網址');
  const token = page.getByLabel('部署初始設定權杖', { exact: true });
  await expect(token).toBeVisible();
  const hint = page.locator(`#${await token.getAttribute('aria-describedby')}`);
  await expect(hint).toContainText('hub.env 裡 SETUP_TOKEN=');
  await expect(hint).toContainText('pnpm hub:init');

  // The link pnpm hub:init prints: the token comes from the fragment, so no token field, no hint and no 「返回註冊」.
  await page.goto(`${dev.origin}/setup#setup-token=${dev.setupToken}`);
  await expect(page.getByRole('heading', { name: '首次設定', exact: true })).toBeVisible();
  await expect(page.getByLabel('部署初始設定權杖', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '返回註冊', exact: true })).toHaveCount(0);
});

test('U1: in English, Today\'s cards and the notifications read in English on real phase-1 data', async ({ page, dev }) => {
  const cjk = /[㐀-鿿]/;
  const fixture = await postingFixture(page, dev, { withoutDailySummary: true });
  const { ws, machine, channelId } = fixture;
  // A post stopped on a CAPTCHA.
  const { settings } = await ws.rest('GET', `/views/channels/${channelId}`);
  await ws.rest('PATCH', `/hub/channels/${channelId}/settings`, { approval_mode: 'direct' }, { version: settings.version });
  const { post } = await schedulePost(fixture, { at: '12:00', caption: 'Weekend sale' });
  const job = (await machine.claim()).find(item => item.payload?.publish_target_id === post.post_id);
  await machine.report(job, 'prepare_blocked', { stage: 'preflight', blocker: { code: 'captcha', phase: 'prepare', message: 'X asked for a CAPTCHA', at: new Date().toISOString(), step: 'login' } });
  // A second machine, paused by its owner with an English reason.
  const other = await pairMachine(dev, ws, 'Mac-C');
  await other.heartbeat();
  await ws.rest('POST', `/hub/machines/${other.id}/pause`, { reason: 'new router' });

  await page.context().addInitScript(() => localStorage.setItem('smartsell-language', 'en'));
  await page.goto(ws.app);
  await expectToday(page, 'en');
  const attention = page.getByRole('main').locator('section.hub-attention');
  await expect(attention.getByRole('article', { name: /: Captcha$/ })).toBeVisible();
  await expect(attention.getByRole('article', { name: 'Mac-C paused (new router)' })).toBeVisible();
  await expect(attention.getByRole('button', { name: 'Resume machine', exact: true })).toBeVisible();
  await attention.locator('details.hub-reminders > summary').click();
  expect(await attention.innerText()).not.toMatch(cjk);

  await page.goto(`${ws.app}/notifications`);
  const list = page.getByRole('main').locator('.hub-alert-list');
  await expect(list.locator('.hub-alert-title').filter({ hasText: 'X @fixture_x on Mac-B: captcha' })).toBeVisible();
  await expect(list).toContainText('Solve it in the SmartSell Chrome window on Mac-B');
  expect(await list.innerText()).not.toMatch(cjk);
});

test('U6: Settings and the error page hide the legacy modules until 顯示其他模組 is on', async ({ page, dev }) => {
  const ws = await ownerWorkspace(page, dev);
  await page.goto(`${ws.app}/settings`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: '設定', exact: true })).toBeVisible();
  await expect(main.getByRole('heading', { level: 2, name: '暫停發布' })).toBeVisible();
  for (const name of ['品牌與市場', '社群帳號']) await expect(main.getByRole('heading', { level: 2, name, exact: true })).toHaveCount(0);
  await expect(main.getByRole('link', { name: '發文帳號與機器', exact: true })).toHaveCount(0);
  await expect(main.getByRole('button', { name: '登記自有帳號' })).toHaveCount(0);
  const summary = main.getByRole('region', { name: '設定概況' });
  await expect(summary.getByRole('link')).toHaveText([/緊急暫停發布/, /Agent/]);
  await main.getByRole('checkbox', { name: /^顯示其他模組/ }).check();
  for (const name of ['品牌與市場', '社群帳號']) await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  await expect(main.getByRole('link', { name: '發文帳號與機器', exact: true })).toBeVisible();
  await main.getByRole('checkbox', { name: /^顯示其他模組/ }).uncheck();

  // The hub does not serve /compat/workbench, so the signed-out error page does not link to it.
  await page.route('**/api/v1/session', route => route.abort());
  await page.goto(`${dev.origin}/somewhere`);
  await expect(page.locator('.entry-error')).toBeVisible();
  await expect(page.getByRole('link', { name: '相容版工作台' })).toHaveCount(0);
});

test('E50: the owner turns remote control on from the machine page; the sites are kept and bad sites are refused', async ({ page, dev }) => {
  const ws = await ownerWorkspace(page, dev);
  const machine = await pairMachine(dev, ws, 'Mac-B');
  await page.goto(`${ws.app}/machines/${machine.id}`);
  const section = page.getByRole('form', { name: /遙控|Remote control/ });
  await expect(section).toBeVisible();
  await expect(section.getByText(/目前關閉|Off\./)).toBeVisible();
  await section.getByLabel(/允許操作這台機器的 Chrome|Allow this machine's Chrome/).check();
  await section.getByLabel(/允許的網站|Allowed sites/).fill('javascript:alert(1)');
  await section.getByRole('button', { name: /儲存|Save/ }).click();
  await expect(section.getByRole('alert').or(section.locator('.vs-notice.bad, .problem-notice, [role=alert]')).first()).toBeVisible();
  await section.getByLabel(/允許的網站|Allowed sites/).fill('https://Seller.Shopee.tw/portal\nshop.myshopify.com');
  await section.getByRole('button', { name: /儲存|Save/ }).click();
  await expect(section.getByRole('status')).toBeVisible();
  const detail = await ws.rest('GET', `/views/machines/${machine.id}`);
  expect(detail.remote_control.browser).toEqual({ enabled: true, sites: ['seller.shopee.tw', 'shop.myshopify.com'] });
  expect(detail.remote_control.phone.enabled).toBe(false);
});
