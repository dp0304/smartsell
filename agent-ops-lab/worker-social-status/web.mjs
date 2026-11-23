import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

export async function openWeb({ base, cookie, temp, workspace }) {
  const src = new URL('../../apps/web/', import.meta.url);
  const require = createRequire(new URL('package.json', src));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const web = await createServer({ root: fileURLToPath(src), configLoader: 'runner', cacheDir: join(temp, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: true, watch: null, hmr: false, proxy: { '/api': base } } });
  let browser;
  const close = async () => { await browser?.close(); await web.close(); };
  try {
    await web.listen();
    const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: ['--proxy-server=http://127.0.0.1:1', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const separator = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    return {
      close,
      async confirm(task, reportRequest) {
        await page.goto(`${origin}/app/${workspace}/agent`);
        const audit = page.locator('section').filter({ has: page.getByRole('heading', { name: /MCP 工具審計|MCP tool audit/i }) });
        const row = audit.getByRole('listitem').filter({ has: page.getByText(reportRequest, { exact: true }) });
        const open = row.getByText(/Worker task & signed receipt|Worker 任務與簽名回執/);
        await expect(open).toBeVisible({ timeout: 15_000 });
        const receipt = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/workspaces/${workspace}/worker-social-status/${task.id}`);
        await open.click();
        const response = await receipt;
        assert.equal(response.status(), 200);
        assert.deepEqual((await response.json()).data, task);
        const details = row.locator('details');
        await expect(details.getByText(task.device_id, { exact: true })).toBeVisible();
        await expect(details.locator(`time[datetime="${task.reported_at}"]`)).toBeVisible();
        if (task.mode === 'recent_posts') {
          const posts = task.result.channels.find(channel => channel.platform === 'x' && channel.status === 'verified')?.posts;
          if (posts) {
            for (const post of posts) {
              await expect(details.getByRole('link', { name: new RegExp(`${post.id}$`) })).toHaveAttribute('href', post.url);
            }
            await expect(details.getByText(/有影片證據的貼文|Posts with video evidence/)).toContainText(String(posts.filter(post => post.has_video).length));
          } else {
            await expect(details.getByText(/有影片證據的貼文|Posts with video evidence/)).toHaveCount(0);
          }
        }
        if (task.result.channels.some(channel => channel.status === 'login_required')) {
          await expect(details.getByText(/請在這台 Worker 電腦的 Chrome 登入|Sign in to this platform in Chrome/)).toBeVisible();
        }
      },
    };
  } catch (error) { await close(); throw error; }
}
