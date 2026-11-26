// Remote control engine (core-automation-proposal step 4) in the owner's Chrome through the SmartSell extension: the
// Agent opens an allowed page, reads elements with refs and a screenshot, types a stock value and clicks Save; the
// write is read back on the next snapshot. Sites the owner did not allow are refused, also when a link leads there.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { bridgeSocketPath, BrowserBridge } from '../../apps/connector-desktop/src/browser-bridge/bridge.ts';
import { BrowserBindings, ownChromeLauncher } from '../../apps/connector-desktop/src/browser-bridge/launcher.ts';
import type { ChromeCdpPage } from '../../apps/connector-desktop/src/drivers/cdp-page.ts';
import { RemoteError, RemoteSessions, siteAllowed, type RemoteSnapshot } from '../../apps/connector-desktop/src/remote/sessions.ts';
import { launchOwnerChrome, ownChromeUnavailable, type OwnerChrome } from './own-chrome-browser.ts';

function listen(handler: RequestListener) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  return new Promise<{ server: Server; origin: string }>(resolve => server.once('listening', () => {
    const address = server.address();
    resolve({ server, origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` });
  }));
}

test('siteAllowed: exact host or subdomain, https only, loopback http only when allowed', () => {
  const sites = ['seller.shopee.tw', '*.myshopify.com'];
  assert.equal(siteAllowed(new URL('https://seller.shopee.tw/portal'), sites), true);
  assert.equal(siteAllowed(new URL('https://a.seller.shopee.tw/'), sites), true);
  assert.equal(siteAllowed(new URL('https://shop.myshopify.com/admin'), sites), true);
  assert.equal(siteAllowed(new URL('https://evilseller.shopee.tw/'), sites), false);
  assert.equal(siteAllowed(new URL('https://shopee.tw/'), sites), false);
  assert.equal(siteAllowed(new URL('http://seller.shopee.tw/'), sites), false, 'http is refused');
  assert.equal(siteAllowed(new URL('http://127.0.0.1:4100/'), ['127.0.0.1:4100']), false);
  assert.equal(siteAllowed(new URL('http://127.0.0.1:4100/'), ['127.0.0.1:4100'], { allowLoopbackHttp: true }), true);
  assert.equal(siteAllowed(new URL('http://127.0.0.1:4101/'), ['127.0.0.1:4100'], { allowLoopbackHttp: true }), false);
});

describe('remote sessions in the owner\'s Chrome', { skip: ownChromeUnavailable() ?? false, concurrency: false }, () => {
  let store: { server: Server; origin: string };
  let elsewhere: { server: Server; origin: string };
  let dataDir: string;
  let bridge: BrowserBridge;
  let owner: OwnerChrome;
  let sessions: RemoteSessions;
  let stock = 7;
  let snap: RemoteSnapshot;

  before(async () => {
    elsewhere = await listen((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<h1>Somewhere else</h1>'); });
    store = await listen((request, response) => {
      if (request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => { stock = Number(new URLSearchParams(body).get('stock')); response.writeHead(303, { location: '/product' }); response.end(); });
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Store admin</title><h1>Lure 7cm</h1><p>Stock now: ${stock}</p>
        <form method="post" action="/product"><label>Stock <input name="stock" value="${stock}"></label><button type="submit">Save</button></form>
        <a href="${elsewhere.origin}/">Partner site</a><div style="height:3000px"></div><p>Bottom of page</p>`);
    });
    dataDir = mkdtempSync(join(tmpdir(), 'ss-remote-'));
    bridge = new BrowserBridge({ socketPath: bridgeSocketPath(dataDir) });
    await bridge.listen();
    owner = await launchOwnerChrome(dataDir);
    assert.ok(await bridge.waitForBrowser(30_000), 'extension connected');
    const sites = [new URL(store.origin).host];
    sessions = new RemoteSessions({
      sites: () => sites, allowLoopbackHttp: true, sleep: ms => new Promise(done => setTimeout(done, ms)),
      openPage: async () => {
        const launch = ownChromeLauncher({ bridge, bindings: BrowserBindings.in(dataDir), allowUrl: url => sessions.allowed(url), sleep: ms => new Promise(done => setTimeout(done, ms)), connectWaitMs: 5000 });
        return await launch(join(dataDir, 'chrome-profiles', 'remote-control')).openPage() as ChromeCdpPage;
      },
    });
  });

  after(async () => {
    await sessions?.closeAll();
    await owner?.close();
    await bridge?.close();
    store?.server.close();
    elsewhere?.server.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('a site the owner did not allow is refused before any tab opens', async () => {
    await assert.rejects(sessions.handle({ op: 'open', url: `${elsewhere.origin}/` }), (error: unknown) => error instanceof RemoteError && error.code === 'SITE_NOT_ALLOWED');
    assert.equal(sessions.open, 0);
  });

  test('open: screenshot, visible text and interactive elements with refs', async () => {
    snap = await sessions.handle({ op: 'open', url: `${store.origin}/product` }) as RemoteSnapshot;
    assert.equal(snap.title, 'Store admin');
    assert.match(snap.text, /Stock now: 7/);
    assert.equal(Buffer.from(snap.screenshot.base64, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
    const stockBox = snap.elements.find(element => element.role === 'textbox' && /Stock/.test(element.name));
    const save = snap.elements.find(element => element.role === 'button' && element.name === 'Save');
    assert.ok(stockBox && save, JSON.stringify(snap.elements));
    assert.equal(stockBox.value, '7');
    assert.ok(save.in_viewport && save.box && save.box[2] > 0);
  });

  test('act: select the field, type the new stock, click Save; the next snapshot reads the write back', async () => {
    const stockBox = snap.elements.find(element => element.role === 'textbox')!;
    snap = await sessions.handle({ op: 'act', session_id: snap.session_id, action: { kind: 'click', ref: stockBox.ref } }) as RemoteSnapshot;
    const field = snap.elements.find(element => element.role === 'textbox')!;
    await sessions.handle({ op: 'act', session_id: snap.session_id, action: { kind: 'press', key: 'End' } });
    for (let i = 0; i < 3; i++) await sessions.handle({ op: 'act', session_id: snap.session_id, action: { kind: 'press', key: 'Backspace' } });
    snap = await sessions.handle({ op: 'act', session_id: snap.session_id, action: { kind: 'type', text: '42' } }) as RemoteSnapshot;
    assert.equal(snap.elements.find(element => element.role === 'textbox')?.value, '42', field.ref);
    const save = snap.elements.find(element => element.role === 'button' && element.name === 'Save')!;
    snap = await sessions.handle({ op: 'act', session_id: snap.session_id, action: { kind: 'click', ref: save.ref } }) as RemoteSnapshot;
    assert.equal(stock, 42, 'the store received the new stock');
    assert.match(snap.text, /Stock now: 42/, 'read back on the page');
  });

  test('a ref from an older snapshot is refused, never guessed', async () => {
    await assert.rejects(sessions.handle({ op: 'act', session_id: snap.session_id, action: { kind: 'click', ref: 'e999' } }),
      (error: unknown) => error instanceof RemoteError && error.code === 'STALE_REF');
  });

  test('scroll and back work; a click that leads off the allowed sites is stopped', async () => {
    const scrolled = await sessions.handle({ op: 'act', session_id: snap.session_id, action: { kind: 'scroll', dy: 2500 } }) as RemoteSnapshot;
    assert.ok(scrolled.elements.some(element => element.role === 'link' && !element.in_viewport), 'the link scrolled out of view');
    const top = await sessions.handle({ op: 'act', session_id: snap.session_id, action: { kind: 'scroll', dy: -5000 } }) as RemoteSnapshot;
    const link = top.elements.find(element => element.role === 'link' && element.name === 'Partner site')!;
    await assert.rejects(sessions.handle({ op: 'act', session_id: snap.session_id, action: { kind: 'click', ref: link.ref } }),
      (error: unknown) => error instanceof RemoteError && error.code === 'SITE_NOT_ALLOWED');
  });

  test('close ends the session and its tab', async () => {
    assert.deepEqual(await sessions.handle({ op: 'close', session_id: snap.session_id }), { closed: true });
    await assert.rejects(sessions.handle({ op: 'snapshot', session_id: snap.session_id }), (error: unknown) => error instanceof RemoteError && error.code === 'SESSION_NOT_FOUND');
  });
});
