// Own-Chrome transport (core-automation-proposal §3.2, step 3): the real SmartSell extension in a stand-in for the
// owner's Chrome, the real native messaging host relay (nc -U) and the Worker's bridge. ChromeCdpPage — the class every
// driver uses — runs over it unchanged. Also checks the extension's own boundaries: it never touches tabs it did not
// open, refuses CDP domains the drivers do not use, and refuses file:/chrome: navigation.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { bridgeSocketPath, BrowserBridge, type BridgeBrowser } from '../../apps/connector-desktop/src/browser-bridge/bridge.ts';
import { BrowserBindings, ownChromeLauncher } from '../../apps/connector-desktop/src/browser-bridge/launcher.ts';
import { ExtensionCdpPipe } from '../../apps/connector-desktop/src/browser-bridge/pipe.ts';
import { CdpCallError } from '../../apps/connector-desktop/src/chrome.ts';
import { OffOriginError } from '../../apps/connector-desktop/src/drivers/cdp-page.ts';
import type { CdpPage } from '../../apps/connector-desktop/src/drivers/types.ts';
import { ProfileError, type BrowserHandle } from '../../apps/connector-desktop/src/runtime/profiles.ts';
import { launchOwnerChrome, ownChromeUnavailable, type OwnerChrome } from './own-chrome-browser.ts';

const PAGE = `<!doctype html><html><head><title>fixture</title></head><body>
<main><h1>Composer</h1>
<div id="box" role="textbox" aria-label="Post text" contenteditable="true" style="min-height:40px;border:1px solid #888"></div>
<button id="post" type="button" disabled>Post</button>
<input id="file" type="file"><p id="file-name"></p>
<p id="clicks">0</p><iframe src="/frame" title="frame"></iframe></main>
<script>
const box = document.getElementById('box'), post = document.getElementById('post');
box.addEventListener('input', () => { post.disabled = box.innerText.trim() === ''; });
post.addEventListener('click', event => { if (!event.isTrusted) return; document.getElementById('clicks').textContent = String(Number(document.getElementById('clicks').textContent) + 1); fetch('/api/posted', { method: 'POST', body: box.innerText }); });
document.getElementById('file').addEventListener('change', event => { document.getElementById('file-name').textContent = [...event.target.files].map(file => file.name + ':' + file.size).join(','); });
</script></body></html>`;

describe('own Chrome through the SmartSell extension', { skip: ownChromeUnavailable() ?? false, concurrency: false }, () => {
  let server: Server;
  let origin: string;
  let dataDir: string;
  let bridge: BrowserBridge;
  let owner: OwnerChrome;
  let browser: BridgeBrowser;
  let handle: BrowserHandle;
  let page: CdpPage;
  const posted: string[] = [];

  before(async () => {
    server = createServer((request, response) => {
      if (request.url === '/api/posted') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => { posted.push(body); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, id: posted.length })); });
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(request.url === '/frame' ? '<p>frame</p>' : PAGE);
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
    dataDir = mkdtempSync(join(tmpdir(), 'ss-own-'));
    bridge = new BrowserBridge({ socketPath: bridgeSocketPath(dataDir) });
    await bridge.listen();
    owner = await launchOwnerChrome(dataDir);
    const connected = await bridge.waitForBrowser(30_000);
    assert.ok(connected, 'the extension connected through the native host');
    browser = connected;
  });

  after(async () => {
    handle?.close();
    await owner?.close();
    await bridge?.close();
    server?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('hello: a stable install id and the extension version', () => {
    assert.match(browser.installId, /^[0-9a-f-]{36}$/);
    assert.equal(browser.hello.version, '0.3.0');
  });

  test('a channel gets a tab in the SmartSell window and the binding is remembered', async () => {
    const bindings = BrowserBindings.in(dataDir);
    const launcher = ownChromeLauncher({ bridge, bindings, allowUrl: url => url.origin === origin, sleep: ms => new Promise(done => setTimeout(done, ms)), connectWaitMs: 5000 });
    handle = launcher(join(dataDir, 'chrome-profiles', 'ch-aaaaaaaaaaaa'));
    page = await handle.openPage();
    assert.equal(bindings.get('ch-aaaaaaaaaaaa'), browser.installId);
    assert.equal(await page.goto(`${origin}/`), `${origin}/`);
  });

  test('reads: role and CSS queries, text, attributes, iframes, accessibility hash', async () => {
    const [button] = await page.queryRole('button', /^Post$/);
    assert.ok(button);
    assert.equal(button.disabled, true);
    assert.equal((await page.queryCss('#box')).length, 1);
    assert.match(await page.bodyText(), /Composer/);
    assert.equal(await page.attribute((await page.queryCss('#box'))[0], 'aria-label'), 'Post text');
    assert.deepEqual(await page.frameSources(), ['/frame']);
    assert.match(await page.axSnapshotHash(), /^[0-9a-f]{32}$/);
  });

  test('input: trusted click, typed text enables Post, the click is trusted and counted once', async () => {
    const [box] = await page.queryCss('#box');
    await page.click(box);
    await page.typeChars('Hello ', 5);
    await page.insertText('own Chrome 🎣');
    const [button] = await page.queryRole('button', /^Post$/);
    assert.equal(button.disabled, false);
    const watcher = page.watchResponses(/\/api\/posted$/);
    await page.click(button);
    const response = await watcher.next(() => true, 5000);
    watcher.stop();
    assert.equal(response?.status, 200);
    assert.deepEqual(JSON.parse(response!.body!), { ok: true, id: 1 });
    assert.equal(await page.innerText((await page.queryCss('#clicks'))[0]), '1');
    assert.deepEqual(posted, ['Hello own Chrome 🎣']);
  });

  test('files: setFiles attaches a local file to the file input', async () => {
    const file = join(dataDir, 'clip.mp4');
    writeFileSync(file, Buffer.alloc(2048, 7));
    await page.setFiles((await page.queryCss('#file', { visible: false }))[0], [file]);
    assert.equal(await page.innerText((await page.queryCss('#file-name'))[0]), 'clip.mp4:2048');
  });

  test('evidence: a JPEG screenshot', async () => {
    const shot = await page.screenshot({ quality: 60, maxWidth: 800 });
    assert.equal(shot.subarray(0, 2).toString('hex'), 'ffd8');
    assert.ok(shot.length > 1000);
  });

  test('navigation stays on allowed origins (Worker side)', async () => {
    await assert.rejects(page.goto('https://example.com/'), OffOriginError);
  });

  test('the extension refuses tabs it did not open, unused CDP domains and file: navigation', async () => {
    const ownerTab = await owner.context.newPage();
    await ownerTab.goto(`${origin}/`);
    const { tabs } = await browser.request<{ tabs: { tabId: number; url: string }[] }>('tabs');
    assert.equal(tabs.length, 1, 'only SmartSell\'s own tab is listed');
    const pipe = new ExtensionCdpPipe(browser);
    await assert.rejects(browser.request('attach', { tabId: tabs[0].tabId + 100_000 }), /Not a SmartSell tab/);
    const refused = (pattern: RegExp) => (error: unknown) => error instanceof CdpCallError && pattern.test(error.cdpMessage);
    await assert.rejects(pipe.send('Browser.getVersion', {}, `tab-${tabs[0].tabId}`), refused(/not allowed/));
    await assert.rejects(pipe.send('Page.navigate', { url: 'file:///etc/hosts' }, `tab-${tabs[0].tabId}`), refused(/URL not allowed/));
    await assert.rejects(browser.request('open', { url: 'chrome://settings' }), /URL not allowed/);
    await ownerTab.close();
  });

  test('closing the handle closes only SmartSell\'s tab; the owner\'s browser stays', async () => {
    const before = owner.context.pages().length;
    handle.close();
    await new Promise(done => setTimeout(done, 500));
    const { tabs } = await browser.request<{ tabs: unknown[] }>('tabs');
    assert.equal(tabs.length, 0);
    assert.ok(owner.context.pages().length >= before - 1);
    assert.ok(browser.connected);
  });

  test('a channel bound to a Chrome profile that is not connected waits, then says so', async () => {
    const bindings = BrowserBindings.in(dataDir);
    bindings.set('ch-bbbbbbbbbbbb', '00000000-0000-4000-8000-000000000000');
    const launcher = ownChromeLauncher({ bridge, bindings, allowUrl: () => true, sleep: async () => {}, connectWaitMs: 300 });
    await assert.rejects(launcher(join(dataDir, 'chrome-profiles', 'ch-bbbbbbbbbbbb')).openPage(),
      (error: unknown) => error instanceof ProfileError && error.ownChrome === 'extension_not_connected');
  });

  test('the Worker restarting: the extension reconnects to a new bridge on the same socket', async () => {
    await bridge.close();
    bridge = new BrowserBridge({ socketPath: bridgeSocketPath(dataDir) });
    await bridge.listen();
    const again = await bridge.waitForBrowser(30_000);
    assert.equal(again?.installId, browser.installId, 'same Chrome profile, same install id');
    browser = again!;
  });
});
