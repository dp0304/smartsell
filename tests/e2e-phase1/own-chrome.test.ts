// E2E of own-Chrome mode (core-automation-proposal §8 step 3): the main loop of E2E-1 with each machine posting in the
// owner's own Chrome through the SmartSell extension. MCP → hub → Mac-B (X) and Win-C (TikTok) → fixture platforms →
// URL back; exactly one post per platform, the uploaded bytes intact, both views published and system-verified.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { ownChromeUnavailable } from '../connector-desktop/own-chrome-browser.ts';
import { fixturePosts, schedule, waitPostStatus } from './cases.ts';
import { marker, slotAfter, stackUnavailable, startStack, until, type Data, type Stack } from './stack.ts';

describe('E2E own Chrome: the loop through the SmartSell extension', { skip: stackUnavailable ?? ownChromeUnavailable() ?? false, concurrency: false, timeout: 12 * 60_000 }, () => {
  let stack: Stack;
  let store: Server;
  let storeOrigin: string;
  let stock = 7;
  before(async () => {
    stack = await startStack({ name: 'own-chrome', ownChrome: true });
    // A stand-in store backend for remote control (E50): one product with a stock field and Save.
    store = createServer((request, response) => {
      if (request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => { stock = Number(new URLSearchParams(body).get('stock')); response.writeHead(303, { location: '/product' }); response.end(); });
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Store admin</title><h1>Lure 7cm</h1><p>Stock now: ${stock}</p>
        <form method="post" action="/product"><label>Stock <input name="stock" value="${stock}"></label><button type="submit">Save</button></form>`);
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => store.once('listening', resolve));
    const address = store.address();
    storeOrigin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  after(async () => { await stack?.close(); store?.close(); });

  test('add-channel found each account in the owner\'s Chrome; one post_schedule posts on both machines at T', async () => {
    const overview = await stack.mcp<{ channels: { channel_id: string; provider: string; machine: string; can_schedule: boolean }[] }>('smartsell_overview', {});
    assert.ok(overview.ok);
    for (const provider of ['x', 'tiktok'] as const) {
      const channel = overview.data.channels.find(item => item.channel_id === stack.channels[provider].id);
      assert.ok(channel?.can_schedule, `${provider} can be scheduled: ${JSON.stringify(overview.data.channels)}`);
    }
    const upload = await stack.mcp<Data>('media_upload', { path: stack.video!.path });
    assert.ok(upload.ok, JSON.stringify(upload.error));
    const caption = marker('own Chrome loop');
    const at = slotAfter(90_000);
    const { posts } = await schedule(stack, { providers: ['x', 'tiktok'], at, caption, mediaId: String(upload.data.media_id) });
    await until(() => fixturePosts(stack, 'x', caption).length >= 1 && fixturePosts(stack, 'tiktok', caption).length >= 1, Math.max(0, at - Date.now()) + 90_000,
      'both fixture posts', 500);
    for (const provider of ['x', 'tiktok'] as const) {
      const made = fixturePosts(stack, provider, caption);
      assert.equal(made.length, 1, `${provider}: exactly one post`);
      assert.equal(made[0].media_sha256, stack.video!.sha256, `${provider}: media bytes intact`);
      const view = await waitPostStatus(stack, posts[provider].post_id, ['published'], 90_000);
      assert.equal(view.result?.verification, 'system_verified');
      assert.ok(view.result?.url, `${provider}: URL back at the hub`);
    }
  });

  test('E50 remote control: off until the owner turns it on; then the Agent operates an allowed site in the owner\'s Chrome and reads the write back', async () => {
    const machineId = stack.machines['Mac-B'].deviceId;
    const off = await stack.mcp<Data>('browser_open', { machine_id: machineId, url: `${storeOrigin}/product` });
    assert.equal(off.error?.code, 'REMOTE_CONTROL_OFF');
    // Only a person can turn it on (the Agent's token is refused).
    await stack.rest('PUT', `/hub/machines/${machineId}/remote-control`, { browser: { enabled: true, sites: [new URL(storeOrigin).host] } });
    await until(async () => {
      const machines = await stack.mcp<{ machines: { machine_id: string; remote: { browser: { ready: boolean } | null } }[] }>('machines_list', {});
      return machines.data.machines.find(machine => machine.machine_id === machineId)?.remote.browser?.ready;
    }, 90_000, 'Mac-B ready for browser remote control', 2000);

    const opened = await stack.mcp<{ session_id: string; title: string; text: string; elements: { ref: string; role: string; name: string; value?: string }[]; screenshot: { attached: boolean } }>(
      'browser_open', { machine_id: machineId, url: `${storeOrigin}/product` });
    assert.ok(opened.ok, JSON.stringify(opened.error));
    assert.equal(opened.data.title, 'Store admin');
    assert.match(opened.data.text, /Stock now: 7/);
    const image = ((opened.raw as { content: { type: string; mimeType?: string; data?: string }[] }).content).find(item => item.type === "image");
    assert.equal(image?.mimeType, 'image/jpeg', 'the screenshot is an MCP image block');
    assert.equal(Buffer.from(image!.data!, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
    assert.ok(opened.bytes < 2_000_000);

    const session = opened.data.session_id;
    const field = opened.data.elements.find(element => element.role === 'textbox')!;
    await stack.mcp('browser_act', { session_id: session, action: { kind: 'click', ref: field.ref } });
    for (let i = 0; i < 2; i++) await stack.mcp('browser_act', { session_id: session, action: { kind: 'press', key: i === 0 ? 'End' : 'Backspace' } });
    const typed = await stack.mcp<{ elements: { ref: string; role: string; name: string; value?: string }[] }>('browser_act', { session_id: session, action: { kind: 'type', text: '42' } });
    assert.equal(typed.data.elements.find(element => element.role === 'textbox')?.value, '42');
    const save = typed.data.elements.find(element => element.role === 'button' && element.name === 'Save')!;
    const saved = await stack.mcp<{ text: string }>('browser_act', { session_id: session, action: { kind: 'click', ref: save.ref } });
    assert.ok(saved.ok, JSON.stringify(saved.error));
    assert.equal(stock, 42, 'the store received the change');
    assert.match(saved.data.text, /Stock now: 42/, 'and the Agent read it back');

    const stale = await stack.mcp('browser_act', { session_id: session, action: { kind: 'click', ref: 'e999' } });
    assert.equal(stale.error?.code, 'STALE_REF');
    const elsewhere = await stack.mcp('browser_open', { machine_id: machineId, url: `${stack.origin}/` });
    assert.equal(elsewhere.error?.code, 'SITE_NOT_ALLOWED');
    const closed = await stack.mcp('browser_act', { session_id: session, action: { kind: 'close' } });
    assert.ok(closed.ok);
  });
});
