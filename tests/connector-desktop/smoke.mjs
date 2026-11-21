import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron, expect } from '@playwright/test';

const source = resolve(import.meta.dirname, '../../apps/connector-desktop');
const directory = process.env.SMARTSELL_CONNECTOR_SMOKE_APP || source;
const executablePath = join(source, 'node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe');
const profile = await mkdtemp(join(import.meta.dirname, '.smoke-'));
const launch = () => _electron.launch({ executablePath,
  args: [directory, `--user-data-dir=${profile}`, '--disable-background-networking', '--no-proxy-server'], timeout: 20_000 });
let electron;
try {
  electron = await launch();
  let page = await electron.firstWindow();
  await expect(page.locator('#language')).toBeEnabled();
  await page.locator('#language').selectOption('zh-Hans');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  await page.getByText('正式服务未配置').waitFor();
  assert.equal(page.url(), 'connector://desktop/index.html');
  await expect(page.locator('#connection')).toHaveText(/离线/);
  await expect(page.locator('#connection-next')).not.toBeEmpty();
  await expect(page.locator('#social-connection')).toContainText('账号接入状态未知');
  await expect(page.locator('#commerce-status')).toHaveText('店铺接入状态未知');
  await expect(page.locator('#activity-empty')).toBeVisible();
  await expect(page.getByText('设置服务地址', { exact: true })).toBeVisible();
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
  await page.screenshot({ path: join(directory, 'dist', 'smoke.png'), fullPage: true });
  console.log('Offline Electron window, sandbox, popup block and emergency stop verified');

  await page.locator('#service-settings summary').click();
  const serviceInput = page.locator('#service-form input');
  await serviceInput.fill('http://example.com/');
  await page.getByRole('button', { name: '保存服务地址' }).click();
  await expect(page.locator('#error')).toContainText('请填写工作台显示的 HTTPS 服务地址');
  await serviceInput.fill('用户输入-原样保留');
  await page.locator('#language').selectOption('zh-Hant');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant');
  await expect(page.locator('#service-form input')).toHaveValue('用户输入-原样保留');
  await expect(page.locator('#activity-list')).toContainText('本機操作已停止');
  await expect(page.locator('ul.platforms')).toHaveAttribute('aria-label', '桌面端支援的社媒');
  assert.equal(await electron.evaluate(({ Menu }) => Menu.getApplicationMenu().items[1].label), '編輯');
  await page.getByRole('button', { name: '保存服務地址' }).click();
  await expect.poll(() => serviceInput.evaluate(input => input.validationMessage)).toBe('請填寫有效的網址。');
  await serviceInput.fill('http://example.com/');
  await page.getByRole('button', { name: '保存服務地址' }).click();
  await expect(page.locator('#error')).toContainText('請填寫工作臺顯示的 HTTPS 服務地址');
  await electron.close();
  electron = await launch();
  page = await electron.firstWindow();
  await expect(page.locator('#language')).toHaveValue('zh-Hant');
  await expect(page.locator('#origin')).toHaveText('正式服務未設定');
  await page.locator('#language').selectOption('zh-Hans');
  await expect(page.locator('#origin')).toHaveText('正式服务未配置');
  console.log('Desktop language switching, localized errors and menus, intact input and restart persistence verified');

  // Exercise renderer states through the real preload with local fixtures only.
  await electron.evaluate(({ ipcMain }) => {
    const state = {
      origin: undefined, workbench: undefined, canSetOrigin: true,
      paired: false, serviceMatches: true, secureStorage: false, connected: false, online: false, message: '',
      updates: { enabled: true, ready: true, status: '签名已验证，可安装' },
      activity: [],
    };
    const handlers = {
      state: () => {},
      'set-origin': origin => {
        if (origin !== 'https://connector.invalid') throw new Error('Unexpected service origin');
        Object.assign(state, { origin, workbench: origin, secureStorage: true });
      },
      pair: ({ workspace, code, ownsDevice }) => {
        if (workspace !== 'smoke-workspace' || code !== '0'.repeat(32) || !ownsDevice) throw new Error('Pairing fields do not match');
        Object.assign(state, { paired: true, canSetOrigin: false, workspace, device: 'smoke-device' });
      },
      connect: () => Object.assign(state, { connected: true, online: true }),
      claim: () => {
        state.task = {
          id: 'smoke-task', kind: 'douyin.video.publish', app: 'douyin', channel: 'browser',
          identity: 'smoke-account', binding: 'smoke-binding', profile: 'smoke-profile', expires: Date.now() + 60_000, portal: false, media: [],
          revision: { title: '审批标题', body: '审批正文', tags: [], visibility: 'public', media: [{ id: 'smoke-media', sha256: 'a'.repeat(64) }] },
        };
      },
      creator: () => { state.task.portal = true; },
      media: () => { state.task.media = [{ name: 'smoke.mp4', hash: 'a'.repeat(64) }]; },
      confirm: ({ observed, confirmed }) => {
        if (observed !== state.task.identity || !confirmed) throw new Error('Account confirmation does not match');
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
      ipcMain.removeHandler(`connector:${name}`);
      ipcMain.handle(`connector:${name}`, (_event, body) => { handler(body); return { state }; });
    }
  });

  await page.getByText('设置服务地址', { exact: true }).click();
  await page.getByLabel('工作台显示的服务地址').fill('https://connector.invalid');
  await page.getByRole('button', { name: '保存服务地址' }).click();
  await expect(page.getByText('未配对', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开工作台' })).toBeVisible();
  assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
  await page.setViewportSize({ width: 640, height: 520 });
  assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
  await page.getByLabel('工作区 ID').fill('smoke-workspace');
  await page.getByLabel('工作台配对码').fill('0'.repeat(32));
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '配对设备' }).press('Enter');
  await expect(page.getByRole('heading', { name: '连接设备' })).toBeFocused();
  await page.getByRole('button', { name: '连接', exact: true }).press('Enter');
  await expect(page.getByText('在线', { exact: true })).toBeVisible();
  await expect(page.getByText('smoke-device', { exact: true })).toBeVisible();
  const claim = page.getByRole('button', { name: '领取社媒任务' });
  await expect(claim).toBeFocused();
  await claim.click();
  await expect(page.getByRole('button', { name: '安装已验证更新' })).toBeDisabled();
  await expect(page.locator('#douyin-status')).toHaveText('有任务绑定');
  await expect(page.locator('#xhs-status')).toHaveText('接入状态未知');
  await page.getByText('任务详情与审批版本').click();
  await expect(page.getByText('审批标题', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '打开官方创作者页面' }).click();
  await page.getByRole('button', { name: '选取本机媒体' }).click();
  await expect(page.getByText('smoke.mp4', { exact: false })).toBeVisible();
  await page.getByLabel('从官方页面读到的账号 ID').fill('smoke-account');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认账号及交接' }).click();
  await expect(page.getByRole('heading', { name: '回填结果' })).toBeVisible();
  await page.getByRole('button', { name: '结果未知' }).click();
  await expect(page.getByRole('heading', { name: '待回填工作台' })).toBeVisible();
  await page.getByRole('button', { name: '回填待发送的任务状态' }).click();
  const latest = page.locator('#activity-list li').first();
  await expect(latest).toContainText('抖音 · 发布视频');
  await expect(latest).toContainText('已回填，结果未知');
  await expect(page.locator('#social-connection')).toContainText('账号接入状态未知');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(directory, 'dist', 'smoke-connected.png'), fullPage: true });
  const stop = page.getByRole('button', { name: '紧急停止' });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(stop).toBeInViewport();
  await stop.click();
  await expect(page.getByText('已停止本机操作。', { exact: true })).toBeVisible();
  await electron.evaluate(({ ipcMain }) => {
    const state = { origin: 'https://connector.invalid', workbench: 'https://connector.invalid', paired: true,
      serviceMatches: true, connected: true, online: true, message: '', updates: { enabled: false, status: '签名更新未配置' } };
    const handlers = {
      state: () => {},
      'catalog-claim': () => {
        state.catalog = { id: 'smoke-catalog', provider: 'shopify', store: 'Smoke Store', externalId: 'smoke-store',
          expires: new Date(Date.now() + 60_000).toISOString(), canOpenPortal: true };
      },
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
  await page.getByRole('button', { name: '领取商品导入任务' }).click();
  await expect(page.locator('#commerce-status')).toHaveText('有商品任务绑定');
  await expect(page.locator('#commerce-connection')).toContainText('Shopify · Smoke Store');
  await expect(page.locator('#commerce-connection')).toContainText('登录状态请在官方卖家后台确认');
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
  await expect(claim).toBeVisible();
  await electron.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('connector:state');
    ipcMain.handle('connector:state', () => ({ state: {
      origin: 'https://connector.invalid', paired: true, serviceMatches: true, connected: true, online: true, message: '',
      updates: { enabled: false, status: '签名更新未配置' },
      bindings: { social: { douyin: 2 }, commerce: { shopify: 1, shopee: 1 } },
    } }));
  });
  await expect(page.locator('#douyin-status')).toHaveText('已绑定 2 个账号');
  await expect(page.locator('#xhs-status')).toHaveText('本机未绑定');
  await expect(page.locator('#commerce-status')).toHaveText('已绑定 2 家店铺');
  const shopifyRow = page.locator('#store-platforms li').filter({ hasText: 'Shopify' });
  await expect(shopifyRow.locator('strong')).toHaveText('Shopify');
  await expect(shopifyRow.locator('span')).toHaveText('1 家店铺');
  await page.setViewportSize({ width: 840, height: 760 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(directory, 'dist', 'smoke-bindings.png'), fullPage: true });
  await electron.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('connector:state');
    ipcMain.handle('connector:state', () => ({ state: {
      origin: 'https://connector.invalid', paired: true, serviceMatches: true, connected: true, online: true, message: '',
      updates: { enabled: false, status: '签名更新未配置' },
      bindings: { social: {}, commerce: {} },
    } }));
  });
  await expect(page.locator('#douyin-status')).toHaveText('本机未绑定');
  await expect(page.locator('#commerce-status')).toHaveText('本机未绑定店铺');
  await electron.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('connector:state');
    ipcMain.handle('connector:state', () => ({ state: {
      origin: 'https://connector.invalid', paired: true, serviceMatches: true, connected: false, online: false, message: '',
      connectionIssue: 'heartbeat', updates: { enabled: false, status: '签名更新未配置' },
      bindings: { social: { douyin: 2 }, commerce: { shopify: 1 } },
    } }));
  });
  await expect(page.locator('#connection')).toHaveText('离线 · 连线失败');
  await expect(page.locator('#douyin-status')).toHaveText('接入状态未知');
  await expect(page.locator('#commerce-status')).toHaveText('店铺接入状态未知');
  console.log('Pairing, connection, responsive layout, task handoff and binding states verified with local IPC fixtures');
} finally {
  if (electron) await electron.close();
  await rm(profile, { recursive: true, force: true });
}
