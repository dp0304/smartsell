import { expect } from '@playwright/test';

// Shared assertions for the phase-1 owner dashboard (phase1-design §9.1, §2.9 and §9.8): the five-step first-run
// wizard, its "finish later" exit to Today, and the Settings switch that brings the hidden modules back.

/** The wizard steps in order (§2.9): workspace → machines → channels → notifications → Codex. */
export const wizardSteps = ['workspace', 'machines', 'channels', 'notifications', 'agent'];

const text = {
  'zh-Hant': {
    title: '開始設定', nav: '設定步驟', later: '稍後再設定', next: '下一步', back: '上一步', finish: '完成，前往今日',
    todo: '待設定', done: '已完成', optional: '選填', unread: '無法讀取', today: '今日', dashboard: '看板導覽',
    progress: number => `第 ${number} 步，共 5 步`,
    steps: { workspace: '工作區', machines: '連接機器', channels: '新增帳號', notifications: '通知', agent: '連接 Codex' },
  },
  en: {
    title: 'Get started', nav: 'Setup steps', later: 'Finish later', next: 'Next', back: 'Back', finish: 'Done, go to Today',
    todo: 'To do', done: 'Done', optional: 'Optional', unread: 'Could not read', today: 'Today', dashboard: 'Dashboard navigation',
    progress: number => `Step ${number} of 5`,
    steps: { workspace: 'Workspace', machines: 'Connect machines', channels: 'Add channels', notifications: 'Notifications', agent: 'Connect Codex' },
  },
};

export const wizardText = locale => text[locale === 'en' ? 'en' : 'zh-Hant'];

/** The progress list of the wizard. */
export const wizardNav = (page, locale = 'zh-Hant') => page.getByRole('main').getByRole('navigation', { name: wizardText(locale).nav, exact: true });

/** One step's entry in the progress list; its text carries the step name and its status (待設定／已完成／選填／無法讀取). */
export function wizardEntry(page, step, locale = 'zh-Hant') {
  return wizardNav(page, locale).getByRole('listitem').filter({ has: page.getByText(wizardText(locale).steps[step], { exact: true }) });
}

/** The panel of the active step: a region named by the step's level-2 heading. */
export function wizardPanel(page, step, locale = 'zh-Hant') {
  return page.getByRole('main').getByRole('region', { name: wizardText(locale).steps[step], exact: true });
}

/**
 * The wizard shows exactly the five §2.9 steps in order, `step` is the current one (aria-current and "Step N of 5"),
 * and no other step's panel is rendered.
 */
export async function expectWizardStep(page, step, { locale = 'zh-Hant' } = {}) {
  const words = wizardText(locale);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: words.title, exact: true })).toBeVisible();
  await expect(page).toHaveURL(url => /^\/app\/[^/]+\/get-started$/.test(url.pathname));
  const items = wizardNav(page, locale).getByRole('listitem');
  await expect(items).toHaveCount(wizardSteps.length);
  await expect(items.locator('strong')).toHaveText(wizardSteps.map(key => words.steps[key]));
  const buttons = wizardNav(page, locale).getByRole('button');
  const number = wizardSteps.indexOf(step) + 1;
  for (const [index, key] of wizardSteps.entries()) {
    if (key === step) await expect(buttons.nth(index)).toHaveAttribute('aria-current', 'step');
    else await expect(buttons.nth(index)).not.toHaveAttribute('aria-current', /.*/);
  }
  const panel = wizardPanel(page, step, locale);
  await expect(panel.getByRole('heading', { level: 2, name: words.steps[step], exact: true })).toBeVisible();
  await expect(panel.getByText(words.progress(number), { exact: true })).toBeVisible();
  await expect(main.getByRole('heading', { level: 2 })).toHaveCount(1);
  return panel;
}

/** The status the progress list shows for a step. */
export async function expectStepStatus(page, step, status, locale = 'zh-Hant') {
  const words = wizardText(locale);
  await expect(wizardEntry(page, step, locale).locator('small')).toHaveText(words[status]);
}

/**
 * Leaves the wizard with 「稍後再設定」: lands on the dashboard index, which is Today in phase 1 (§9.1, §9.2).
 * Returns the dashboard URL.
 */
export async function finishLater(page, locale = 'zh-Hant') {
  const words = wizardText(locale);
  const main = page.getByRole('main');
  const later = main.getByRole('link', { name: words.later, exact: true });
  const href = await later.getAttribute('href');
  expect(href).toMatch(/^\/app\/[^/?#]+$/);
  await later.click();
  const dashboard = new URL(href, page.url()).href;
  await expect(page).toHaveURL(dashboard);
  await expectToday(page, locale);
  return dashboard;
}

/** The phase-1 dashboard index: Today with its four sections (§9.2). */
export async function expectToday(page, locale = 'zh-Hant') {
  const english = locale === 'en';
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: english ? 'Today' : '今日', exact: true })).toBeVisible();
  for (const name of english ? ['Needs you', 'Next 48 hours', 'Machines', 'Published in the last 24 hours']
    : ['要你處理', '接下來 48 小時', '機器', '最近發出（24 小時內）']) {
    await expect(main.getByRole('heading', { level: 2, name, exact: false }).first()).toBeVisible();
  }
}

/**
 * The advanced workbench (/w/:ws/home) stays reachable in phase 1, but not from the core navigation (§9.1: the
 * sidebar link appears only with 顯示其他模組 or developer mode). Its entry is Settings → 進階工作台.
 */
export async function openAdvancedWorkbench(page, workspaceId, locale = 'zh-Hant') {
  const english = locale === 'en';
  const home = `/w/${workspaceId}/home`;
  const nav = page.getByRole('navigation', { name: wizardText(locale).dashboard });
  await expect(nav).toBeVisible();
  await expect(page.getByRole('link', { name: english ? 'Advanced workbench' : '進階工作台', exact: true })).toHaveCount(0);
  await nav.getByRole('link', { name: english ? 'Settings' : '設定', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { level: 2, name: english ? 'Advanced workbench' : '進階工作台', exact: true })).toBeVisible();
  const open = page.getByRole('main').getByRole('link', { name: english ? 'Open the advanced workbench' : '開啟進階工作台', exact: true });
  await expect(open).toHaveAttribute('href', home);
  await open.click();
  await expect(page).toHaveURL(url => url.pathname === home);
  return home;
}

/** Settings → 介面 → 顯示其他模組 (§9.1): brings the hidden modules back into the navigation for this browser. */
export async function showMoreModules(page, app, locale = 'zh-Hant') {
  const english = locale === 'en';
  await page.goto(`${app}/settings`);
  const toggle = page.getByRole('checkbox', { name: english ? /^Show other modules/ : /^顯示其他模組/ });
  await toggle.check();
  await expect(toggle).toBeChecked();
  const nav = page.getByRole('navigation', { name: wizardText(locale).dashboard });
  await expect(nav.getByRole('link', { name: english ? 'Overview' : '總覽', exact: true })).toBeVisible();
  return nav;
}
