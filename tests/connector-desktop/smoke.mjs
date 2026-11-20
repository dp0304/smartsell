import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron } from '@playwright/test';

const directory = resolve(import.meta.dirname, '../../apps/connector-desktop');
const executablePath = join(directory, 'node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe');
const profile = await mkdtemp(join(import.meta.dirname, '.smoke-'));
let electron;
try {
  electron = await _electron.launch({ executablePath, args: [directory, `--user-data-dir=${profile}`, '--disable-background-networking', '--no-proxy-server'], timeout: 20_000 });
  const page = await electron.firstWindow();
  await page.getByText('正式服务未配置').waitFor();
  assert.equal(page.url(), 'connector://desktop/index.html');
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
  await page.screenshot({ path: join(directory, 'dist', 'smoke.png') });
  console.log('Offline Electron window, sandbox, popup block and emergency stop verified');
} finally {
  if (electron) await electron.close();
  await rm(profile, { recursive: true, force: true });
}
