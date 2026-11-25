#!/usr/bin/env node
// SmartSell measurement runner (core-automation-proposal §3.5). Waits for the prototype extension in the owner's own Chrome,
// then measures, in new tabs it opens and closes itself:
//   1. navigator.webdriver before, while and after chrome.debugger is attached;
//   2. X: signed in? After a trusted click in the composer and Input.insertText, does "Post" become enabled? The text is
//      cleared again and Post is never clicked;
//   3. TikTok Studio: signed in? (no upload, no post).
// Writes the facts to measurements-<time>.json next to this file and prints them. No dependencies (Node 24).
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 47231;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- minimal WebSocket server (RFC 6455: text frames, client frames masked) ----------
function serve(onClient) {
  const server = createServer((_req, res) => res.writeHead(426).end('WebSocket only'));
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || !String(req.headers.origin ?? '').startsWith('chrome-extension://')) { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    const listeners = new Set();
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = (buffer[1] & 0x80) !== 0;
        const total = offset + (masked ? 4 : 0) + length;
        if (buffer.length < total) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
        if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        buffer = buffer.subarray(total);
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode === 0x1) for (const listener of listeners) listener(payload.toString('utf8'));
      }
    });
    const send = text => {
      const payload = Buffer.from(text, 'utf8');
      const header = payload.length < 126 ? Buffer.from([0x81, payload.length])
        : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
        : Buffer.concat([Buffer.from([0x81, 127]), (() => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(payload.length)); return size; })()]);
      socket.write(Buffer.concat([header, payload]));
    };
    onClient({ send, onMessage: listener => listeners.add(listener), socket });
  });
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function client(connection) {
  let next = 1;
  const pending = new Map();
  connection.onMessage(text => {
    const message = JSON.parse(text);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message); else waiter.reject(new Error(message.error));
  });
  return (cmd, args = {}) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    connection.send(JSON.stringify({ id, cmd, args }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${cmd} timed out`)); }, 60_000);
  });
}

async function measure(run) {
  const facts = { at: new Date().toISOString(), chrome: (await run('version')).chrome };
  const value = async (tabId, name) => (await run('read', { tabId, name })).value;
  const pageWebdriver = async tabId => (await run('cdp', { tabId, method: 'Runtime.evaluate', params: { expression: 'navigator.webdriver', returnByValue: true } })).value.result.value;

  // 1 + 2: X
  const { tabId: x } = await run('open', { url: 'https://x.com/home' });
  await sleep(4000);
  facts.x = { url: await value(x, 'url'), signed_in: await value(x, 'xLoggedIn'), webdriver_before_attach: await value(x, 'webdriver') };
  await run('attach', { tabId: x });
  facts.x.webdriver_attached_page = await value(x, 'webdriver');
  facts.x.webdriver_attached_cdp = await pageWebdriver(x);
  if (facts.x.signed_in) {
    await run('navigate', { tabId: x, url: 'https://x.com/compose/post' });
    await sleep(4000);
    const point = await value(x, 'xEditorPoint');
    facts.x.composer_found = !!point;
    if (point) {
      facts.x.post_button_before = await value(x, 'xPostButton');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await run('cdp', { tabId: x, method: 'Input.dispatchMouseEvent', params: { type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 } });
        await sleep(60 + Math.round(Math.random() * 60));
      }
      await sleep(500);
      await run('cdp', { tabId: x, method: 'Input.insertText', params: { text: 'SmartSell 量測（不會發出）' } });
      await sleep(1200);
      facts.x.editor_text_after_insert = await value(x, 'xEditorText');
      facts.x.post_button_after_insert = await value(x, 'xPostButton');
      // Clear the text again: select all, delete. Post is never clicked.
      const modifier = process.platform === 'darwin' ? 4 : 2;
      await run('cdp', { tabId: x, method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier, commands: ['selectAll'] } });
      await run('cdp', { tabId: x, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier } });
      await run('cdp', { tabId: x, method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 } });
      await run('cdp', { tabId: x, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 } });
      await sleep(600);
      facts.x.editor_text_after_clear = await value(x, 'xEditorText');
    }
  }
  await run('detach', { tabId: x });
  await sleep(300);
  facts.x.webdriver_after_detach = await value(x, 'webdriver');
  await run('close', { tabId: x });

  // 3: TikTok Studio (read only)
  const { tabId: tt } = await run('open', { url: 'https://www.tiktok.com/tiktokstudio/upload' });
  await sleep(5000);
  const page = await value(tt, 'tiktokUpload');
  facts.tiktok = { ...page, signed_in: !page.loginForm && /tiktokstudio/.test(page.url), webdriver: await value(tt, 'webdriver') };
  await run('close', { tabId: tt });
  return facts;
}

const server = await serve(async connection => {
  console.log('Extension connected. Measuring (tabs open and close by themselves; nothing is posted)…');
  try {
    const facts = await measure(client(connection));
    const file = join(dirname(fileURLToPath(import.meta.url)), `measurements-${facts.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, `${JSON.stringify(facts, null, 2)}\n`);
    console.log(JSON.stringify(facts, null, 2));
    console.log(`Saved ${file}`);
  } catch (error) {
    console.error('Measurement failed:', error.message);
    process.exitCode = 1;
  } finally {
    connection.socket.end();
    server.close();
  }
});
console.log(`Waiting for the SmartSell measurement extension on ws://127.0.0.1:${PORT} …
Load it once: chrome://extensions → Developer mode → Load unpacked → ${join(dirname(fileURLToPath(import.meta.url)), 'extension')}`);
