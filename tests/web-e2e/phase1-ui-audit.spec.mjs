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
