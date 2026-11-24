// §10.1 S9: laptop Agent mode — the owner alert stream and its reconnection (Last-Event-ID), shown as OS notifications.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AlertStream, ALERT_STREAM_PATH, shouldNotify, SseParser } from '../../../apps/connector-desktop/src/app/alerts.ts';
import { Notifier } from '../../../apps/connector-desktop/src/app/notify.ts';

const TOKEN = `ss_command_${'a'.repeat(64)}`;
const alert = (id: string, title: string, at = new Date().toISOString()) => ({
  id, kind: 'worker_blocker', severity: 'urgent', title, body: `Mac-B 的 X @makemylure 出現驗證碼，已停止。(${id})`, at,
  machine: { id: 'm1', label: 'Mac-B', web_url: 'https://hub.tail1234.ts.net/app/w/machines/m1' }, channel: null, post: null,
  web_url: `https://hub.tail1234.ts.net/app/w/posts/${id}`, read_at: null,
});

async function sseServer(handler: (req: IncomingMessage, res: ServerResponse, n: number) => void) {
  let n = 0;
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => { requests.push(req); handler(req, res, ++n); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const waitFor = async (predicate: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > ms) throw new Error('timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('SSE parser: id, event, multi-line data, retry, comments and CRLF', () => {
  const parser = new SseParser();
  const events = [...parser.push(': connected\r\nretry: 2000\r\nid: 41\r\n\r\nid: 42\nevent: owner_alert\ndata: {"a":\ndata: 1}\n'), ...parser.push('\n: heartbeat\n\n')];
  assert.deepEqual(events, [{ id: '41', event: 'message', data: '', retry: 2000 }, { id: '42', event: 'owner_alert', data: '{"a":\n1}', retry: null }]);
});

test('stream: shows each owner_alert as an OS notification, opens web_url on click, reconnects with Last-Event-ID', async t => {
  const hub = await sseServer((req, res, n) => {
    assert.equal(req.url, ALERT_STREAM_PATH);
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    if (n === 1) {
      // A fresh subscription: the hub sends the current cursor first (no history), then one alert, then restarts.
      res.write(': connected\nretry: 50\nid: 10\n\n');
      res.write(`id: 11\nevent: owner_alert\ndata: ${JSON.stringify(alert('a11', '驗證碼'))}\n\n`);
      setTimeout(() => res.end(), 20);
    } else {
      res.write(`: connected\nretry: 50\n\nid: 12\nevent: owner_alert\ndata: ${JSON.stringify(alert('a12', '登入過期'))}\n\n`);
    }
  });
  t.after(hub.close);
  const shown: { title: string; clicked?: () => void }[] = [];
  const opened: string[] = [];
  const notifier = new Notifier({ supported: () => true, open: url => opened.push(url),
    create: options => { const item: { title: string; clicked?: () => void } = { title: options.title }; shown.push(item); return { show() {}, on(_event, fn) { item.clicked = fn; } }; } });
  const saved: string[] = [];
  const stream = new AlertStream({ hubOrigin: hub.origin, token: TOKEN, saveLastEventId: id => saved.push(id), random: () => 0.5,
    onAlert: value => notifier.notify({ title: value.title, body: value.body, url: value.web_url, urgent: value.severity === 'urgent', key: `alert:${value.id}` }) });
  void stream.start();
  await waitFor(() => shown.length === 2);
  await stream.stop();
  assert.equal(hub.requests[0].headers['last-event-id'], undefined, 'a fresh subscription starts at the newest alert');
  assert.equal(hub.requests[1].headers['last-event-id'], '11', 'the reconnect resumes after the last delivered id');
  assert.deepEqual(shown.map(item => item.title), ['驗證碼', '登入過期']);
  assert.deepEqual(saved, ['10', '11', '12']);
  shown[0].clicked!();
  assert.deepEqual(opened, ['https://hub.tail1234.ts.net/app/w/posts/a11']);
  assert.equal(stream.recent()[0].id, 'a12');
});

test('stream: a stored cursor resumes after an App restart; 5xx backs off and retries', async t => {
  const hub = await sseServer((req, res, n) => {
    if (n === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`id: 31\nevent: owner_alert\ndata: ${JSON.stringify(alert('a31', 'missed'))}\n\n`);
  });
  t.after(hub.close);
  const delays: number[] = [];
  const got: string[] = [];
  const stream = new AlertStream({ hubOrigin: hub.origin, token: TOKEN, lastEventId: '30', onAlert: value => got.push(value.id),
    sleep: async ms => { delays.push(ms); }, random: () => 0.5 });
  void stream.start();
  await waitFor(() => got.length === 1);
  await stream.stop();
  assert.equal(hub.requests[0].headers['last-event-id'], '30');
  assert.equal(hub.requests[1].headers['last-event-id'], '30');
  assert.equal(delays[0], 2000, 'first failure waits 2 s (±20% jitter, here 0)');
});

test('stream: 401 stops reconnecting and reports unauthorized (connection revoked)', async t => {
  const hub = await sseServer((_req, res) => { res.writeHead(401, { 'www-authenticate': 'Bearer' }); res.end(); });
  t.after(hub.close);
  const states: string[] = [];
  const stream = new AlertStream({ hubOrigin: hub.origin, token: TOKEN, onAlert: () => assert.fail('no alerts'), onState: state => states.push(state) });
  await stream.start();
  assert.equal(stream.state, 'unauthorized');
  assert.equal(hub.requests.length, 1);
  assert.ok(states.includes('unauthorized'));
});

test('old alerts replayed after a long shutdown are listed but not popped up', () => {
  const now = Date.parse('2026-11-24T10:00:00Z');
  assert.equal(shouldNotify(alert('x', 'a', '2026-11-24T09:30:00Z') as never, now), true);
  assert.equal(shouldNotify(alert('x', 'a', '2026-11-24T08:00:00Z') as never, now), false);
});
