import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron, expect } from '@playwright/test';
import { runLifecycle } from './lifecycle.mjs';

const source = resolve(import.meta.dirname, '../../apps/connector-desktop');
const directory = process.env.SMARTSELL_CONNECTOR_SMOKE_APP || source;
const evidence = process.env.SMARTSELL_CONNECTOR_SMOKE_EVIDENCE || join(directory, 'dist');
const executablePath = join(source, 'node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe');
const profile = await mkdtemp(join(import.meta.dirname, '.smoke-'));
let electron;
try {
  electron = await _electron.launch({ executablePath, args: [directory, `--user-data-dir=${profile}`, '--disable-background-networking', '--no-proxy-server'], timeout: 20_000 });
  const page = await electron.firstWindow();
  await page.getByText('正式服务未配置').waitFor();
  assert.equal(page.url(), 'connector://desktop/index.html');
  await expect(page.locator('#connection')).toHaveText(/离线/);
  await expect(page.locator('#connection-next')).not.toBeEmpty();
  await expect(page.locator('#social-channels li')).toHaveCount(8);
  await expect(page.locator('#commerce-channels li')).toHaveCount(3);
  await expect(page.locator('#douyin-status')).toHaveText('未验证');
  await expect(page.locator('#shopify-status')).toHaveText('未验证');
  await expect(page.locator('#activity-empty')).toBeVisible();
  await expect(page.getByRole('button', { name: '检查系统安全存储' })).toBeVisible();
  await expect(page.getByLabel('工作台网址')).toBeHidden();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.connector.invoke), 'undefined');
  const options = await electron.evaluate(({ BrowserWindow }) => {
    const { contextIsolation, sandbox, nodeIntegration } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { contextIsolation, sandbox, nodeIntegration };
  });
  assert.deepEqual(options, { contextIsolation: true, sandbox: true, nodeIntegration: false });
  assert.equal(await page.evaluate(() => window.open('about:blank') === null), true);
  await page.getByRole('button', { name: '紧急停止' }).click();
  await page.getByRole('status').getByText('已停止本机操作。', { exact: false }).waitFor();
  await expect(page.locator('#error')).toBeEmpty();
  await expect(page.locator('#catalog-error')).toBeEmpty();
  const stopped = page.locator('#activity-list li').first();
  await expect(stopped).toContainText('紧急停止');
  await expect(stopped).toContainText('本机操作已停止');
  await expect(stopped.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await page.screenshot({ path: join(evidence, 'channels-offline.png'), fullPage: true });
  console.log('Offline Electron window, sandbox, popup block and emergency stop verified');

  const removed = ['领取社媒任务', '核验工作台中已绑定的浏览器账号', '工作台浏览器会话 ID', '领取商品导入任务', '业务 Skills'];
  for (const text of removed) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => ['claim', 'claimCatalog', 'verifySession', 'sessionCreator', 'exportSkills']
    .filter(action => Object.hasOwn(window.connector, action))), []);
  const project = join(profile, 'operations project');
  const installer = join(directory, 'dist', 'smartsell-install-skills.mjs');
  await mkdir(project);
  assert.equal((execFileSync(process.execPath, [installer, '.'], { cwd: project, encoding: 'utf8' }).match(/已安装：/g) || []).length, 6);
  assert.equal((execFileSync(process.execPath, [installer, '.'], { cwd: project, encoding: 'utf8' }).match(/已存在，保留：/g) || []).length, 6);
  console.log('Removed desktop controls are absent; the standalone installer installed and preserved both project skill layouts');

  if (process.env.SMARTSELL_CONNECTOR_REAL_CHROME === '1') {
    const row = page.locator('[data-channel="youtube"]');
    await row.getByRole('button', { name: '在 Chrome 打开 YouTube' }).click();
    await expect(row.locator('.channel-note')).toContainText('已打开专用 Chrome', { timeout: 25_000 });
    await expect(row.getByRole('status')).toHaveText('未验证');
    await row.getByRole('button', { name: '验证 YouTube' }).click();
    await expect(row.getByRole('status')).toHaveText('需登录', { timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(evidence, 'channels-chrome-login.png'), fullPage: true });
    console.log('Installed Google Chrome opened real YouTube Studio; clean Chrome session required sign-in');
  }

  // Exercise renderer states through the real preload with local fixtures only.
  await electron.evaluate(({ ipcMain }) => {
    const state = {
      origin: undefined, workbench: undefined, canPairWorkbench: true, machineName: 'Fixture Mac',
      paired: false, serviceMatches: true, secureStorage: true, connected: false, online: false, message: '',
      updates: { enabled: true, ready: true, status: '签名已验证，可安装' },
      activity: [],
    };
    const handlers = {
      state: () => {},
      pair: ({ url, ownsDevice }) => {
        if (url !== `https://connector.invalid/app/smoke-workspace/get-started?step=worker#worker-pair=${'0'.repeat(32)}` || !ownsDevice) throw new Error('Pairing fields do not match');
        Object.assign(state, { origin: 'https://connector.invalid', workbench: 'https://connector.invalid', secureStorage: true,
          paired: true, canPairWorkbench: false, workspace: 'smoke-workspace', device: 'smoke-device' });
      },
      connect: () => Object.assign(state, { connected: true, online: true }),
      dispatch: () => {
        state.task = {
          id: 'smoke-task', kind: 'douyin.video.publish', app: 'douyin', channel: 'browser',
          identity: 'smoke-account', binding: 'smoke-binding', profile: 'smoke-profile', expires: Date.now() + 60_000, portal: false, identityMatched: true, media: [],
          revision: { title: '审批标题', body: '审批正文', tags: [], visibility: 'public', media: [{ id: 'smoke-media', sha256: 'a'.repeat(64) }] },
        };
      },
      creator: () => { state.task.portal = true; },
      media: () => { state.task.media = [{ name: 'smoke.mp4', hash: 'a'.repeat(64) }]; },
      confirm: ({ confirmed }) => {
        if (!confirmed) throw new Error('Account confirmation does not match');
        state.task.until = Date.now() + 30_000;
      },
      finish: ({ result }) => {
        if (result !== 'unknown') throw new Error('Expected an unknown outcome');
        state.task.pending = 'outcome_unknown';
      },
      report: () => {
        state.task = undefined;
        state.activity = [{ id: 1, app: 'douyin', kind: 'douyin.video.publish', action: 'retry', tone: 'warning', result: '已回填，结果未知', time: new Date().toISOString() }];
      },
      stop: () => Object.assign(state, { connected: false, online: false, message: '已停止本机操作。' }),
    };
    for (const [name, handler] of Object.entries(handlers)) {
      if (name === 'dispatch') { globalThis.dispatchFixture = handler; continue; }
      ipcMain.removeHandler(`connector:${name}`);
      ipcMain.handle(`connector:${name}`, (_event, body) => { handler(body); return { state }; });
    }
  });

  assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
  await page.setViewportSize({ width: 640, height: 520 });
  assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
  await page.getByLabel('工作台网址').fill(`https://connector.invalid/app/smoke-workspace/get-started?step=worker#worker-pair=${'0'.repeat(32)}`);
  await page.locator('#pair [name=owns]').check();
  await page.getByRole('button', { name: '连接本机 Worker' }).press('Enter');
  await expect(page.getByRole('heading', { name: '首次设置' })).toBeFocused();
  await page.getByRole('button', { name: '连接', exact: true }).press('Enter');
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await expect(page.getByText('smoke-device', { exact: true })).toBeVisible();
  for (const text of removed) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await electron.evaluate(() => globalThis.dispatchFixture());
  await expect(page.getByRole('button', { name: '安装已验证更新' })).toBeDisabled();
  await expect(page.locator('#douyin-status')).toHaveText('未验证');
  await expect(page.locator('#xhs-status')).toHaveText('未验证');
  await page.getByText('任务详情与审批版本').click();
  await expect(page.getByText('审批标题', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '打开官方创作者页面' }).click();
  await page.getByRole('button', { name: '选取本机媒体' }).click();
  await expect(page.getByText('smoke.mp4', { exact: false })).toBeVisible();
  await expect(page.locator('#task-proof')).toHaveText('已从专用 Chrome 读取并核对账号。');
  await page.locator('#confirm').getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认账号及交接' }).click();
  await expect(page.getByRole('heading', { name: '回填结果' })).toBeVisible();
  await page.getByRole('button', { name: '结果未知' }).click();
  await expect(page.getByRole('heading', { name: '待回填工作台' })).toBeVisible();
  await page.getByRole('button', { name: '回填待发送的任务状态' }).click();
  const latest = page.locator('#activity-list li').first();
  await expect(latest).toContainText('抖音 · 发布视频');
  await expect(latest).toContainText('已回填，结果未知');
  await expect(page.locator('#douyin-status')).toHaveText('未验证');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidence, 'smoke-connected.png'), fullPage: true });
  const stop = page.getByRole('button', { name: '紧急停止' });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(stop).toBeInViewport();
  await stop.click();
  await expect(page.getByText('已停止本机操作。', { exact: true })).toBeVisible();
  await electron.evaluate(({ ipcMain }) => {
    const state = { origin: 'https://connector.invalid', workbench: 'https://connector.invalid', paired: true,
      serviceMatches: true, connected: true, online: true, message: '', updates: { enabled: false, status: '签名更新未配置' } };
    state.catalog = { id: 'smoke-catalog', provider: 'shopify', store: 'Smoke Store', externalId: 'smoke-store',
      expires: new Date(Date.now() + 60_000).toISOString(), canOpenPortal: true };
    const handlers = {
      state: () => {},
      'catalog-portal': () => { state.portalOpened = true; },
      'catalog-file': () => { if (state.portalOpened) state.catalog.file = { name: 'products.xlsx', size: 2400 }; },
      'catalog-upload': ({ observed, confirmed }) => {
        if (!confirmed || observed !== state.catalog.externalId) return '请核对实际店铺 ID。';
        state.catalog = undefined;
        state.catalogResult = { import_id: 'smoke-import', status: 'previewed' };
      },
    };
    for (const [name, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(`connector:${name}`);
      ipcMain.handle(`connector:${name}`, (_event, body) => ({ error: handler(body), state }));
    }
  });
  await expect(page.locator('#shopify-status')).toHaveText('未验证');
  await expect(page.getByRole('heading', { name: '当前商品任务' })).toBeVisible();
  await expect(page.locator('#catalog-store')).toHaveText('Smoke Store · Shopify');
  await expect(page.getByRole('button', { name: '发送到工作台预览' })).toBeHidden();
  await page.getByRole('button', { name: '打开官方卖家后台' }).click();
  await page.getByRole('button', { name: '选择商品导出表' }).click();
  await expect(page.locator('#catalog-picked')).toContainText('products.xlsx');
  const store = page.getByLabel('官方页面显示的实际店铺 ID');
  await store.fill('wrong-store');
  await page.locator('#catalog-upload-form').getByRole('checkbox').check();
  await page.getByRole('button', { name: '发送到工作台预览' }).click();
  await expect(page.locator('#catalog-error')).toContainText('请核对实际店铺 ID');
  await store.fill('smoke-store');
  await page.locator('#catalog-upload-form').getByRole('checkbox').check();
  await page.getByRole('button', { name: '发送到工作台预览' }).click();
  await expect(page.getByRole('heading', { name: '已送工作台预览' })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回工作台' })).toBeVisible();
  for (const text of removed) await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await electron.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('connector:state');
    ipcMain.handle('connector:state', () => ({ state: {
      origin: 'https://connector.invalid', paired: true, serviceMatches: true, connected: true, online: true, message: '',
      updates: { enabled: false, status: '签名更新未配置' },
      bindings: { social: { douyin: 2 }, commerce: { shopify: 1, shopee: 1 } }, pendingBrowserAccounts: 1,
    } }));
  });
  await expect(page.locator('#pending-browser-identity')).toContainText('1 个账号等待核对');
  await expect(page.getByText(/工作台为本机绑定/)).toHaveCount(0);
  await expect(page.locator('#douyin-status')).toHaveText('未验证');
  await expect(page.locator('#shopify-status')).toHaveText('未验证');
  await page.setViewportSize({ width: 840, height: 760 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidence, 'smoke-bindings.png'), fullPage: true });
  await electron.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('connector:state');
    ipcMain.handle('connector:state', () => ({ state: {
      origin: 'https://connector.invalid', paired: true, serviceMatches: true, connected: true, online: true, message: '',
      updates: { enabled: false, status: '签名更新未配置' },
      bindings: { social: {}, commerce: {} },
    } }));
  });
  await expect(page.locator('#pending-browser-identity')).toBeHidden();
  await expect(page.getByText(/工作台为本机绑定/)).toHaveCount(0);
  await electron.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('connector:state');
    ipcMain.handle('connector:state', () => ({ state: {
      origin: 'https://connector.invalid', paired: true, serviceMatches: true, connected: false, online: false, message: '',
      connectionIssue: 'heartbeat', updates: { enabled: false, status: '签名更新未配置' },
      bindings: { social: { douyin: 2 }, commerce: { shopify: 1 } },
      channelStates: {
        youtube: { status: 'verified', identity: 'UC_fixture_channel', checkedAt: '2026-11-21T12:00:00.000Z' },
        instagram: { status: 'changed', identity: 'new_fixture', previousIdentity: 'old_fixture', checkedAt: '2026-11-21T12:00:00.000Z' },
        shopify: { status: 'expired', identity: 'fixture-shop', checkedAt: '2026-11-21T12:00:00.000Z' },
        reddit: { status: 'unverified', unavailable: true, note: '找不到 Google Chrome。请安装 Chrome 后重试。' },
      },
    } }));
  });
  await expect(page.locator('#connection')).toHaveText('离线 · 连线失败');
  await expect(page.locator('#douyin-status')).toHaveText('未验证');
  await expect(page.locator('#youtube-status')).toHaveText('已验证');
  await expect(page.locator('[data-channel="youtube"] .channel-proof')).toContainText('UC_fixture_channel · 验证于');
  await expect(page.locator('#instagram-status')).toHaveText('身份已切换');
  await expect(page.locator('[data-channel="instagram"] .channel-proof')).toContainText('old_fixture → new_fixture');
  await expect(page.locator('#shopify-status')).toHaveText('已过期');
  await expect(page.locator('#reddit-status')).toHaveText('Chrome 未安装');
  await expect(page.locator('[data-channel="reddit"] .channel-note')).toContainText('请安装 Chrome 后重试');
  await page.screenshot({ path: join(evidence, 'channels-simulated-states.png'), fullPage: true });
  console.log('Pairing, catalog and social tasks, and simulated verified, switched, expired and missing Chrome states passed');
} finally {
  if (electron) await electron.close();
  await rm(profile, { recursive: true, force: true });
}
await runLifecycle({ directory, executablePath, evidence });
