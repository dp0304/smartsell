import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { runRelay } from '../src/relay.ts';

type Json = Record<string, any>;
const token = `ss_command_${'a'.repeat(64)}`;

/** A fake /mcp endpoint; `handle` decides each response. */
async function fakeMcp(t: TestContext, handle: (message: Json, request: IncomingMessage, response: ServerResponse) => void) {
  const seen: { message: Json; headers: IncomingMessage['headers'] }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    seen.push({ message, headers: request.headers });
    handle(message, request, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, seen };
}

const json = (response: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
};
const initialize = { protocolVersion: '2025-11-25', serverInfo: { name: 'smartsell', version: '0.1.0' }, capabilities: { tools: {} } };

/** Run the relay over in-memory stdio; send lines, collect parsed output lines. */
function relay(t: TestContext, origin: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output: Json[] = [];
  let buffer = '';
  const waiters: (() => void)[] = [];
  stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) { output.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); waiters.splice(0).forEach(fn => fn()); }
  });
  let errors = '';
  stderr.on('data', chunk => { errors += chunk; });
  const done = runRelay({ hubOrigin: origin, token, stdin, stdout, stderr });
  t.after(async () => { stdin.end(); await done; });
  const send = (message: unknown) => stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  async function reply(id: unknown) {
    for (;;) {
      const found = output.find(item => item.id === id && !item.method);
      if (found) return found;
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  }
  return { send, reply, output, stdin, done, errors: () => errors };
}

test('initialize is checked, the session id and protocol version are forwarded, JSON and SSE answers are relayed', async t => {
  const hub = await fakeMcp(t, (message, _request, response) => {
    if (message.method === 'initialize') return json(response, { jsonrpc: '2.0', id: message.id, result: initialize }, 200, { 'mcp-session-id': 'session-1' });
    if (message.method === 'notifications/initialized') { response.writeHead(202); return response.end(); }
    if (message.method === 'tools/list') {
      // SSE: a server notification first, then the result.
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } })}\n\n`);
      response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'media_upload' }] } })}\n\n`);
      return response.end();
    }
    if (message.method === 'tools/call') return json(response, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Invalid params' } }, 400);
    json(response, { jsonrpc: '2.0', id: message.id, result: {} });
  });
  const io = relay(t, hub.origin);
  io.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'codex', version: '1' }, capabilities: {} } });
  assert.equal((await io.reply(1)).result.serverInfo.name, 'smartsell');
  io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  io.send({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  assert.deepEqual((await io.reply('list')).result.tools, [{ name: 'media_upload' }]);
  assert.ok(io.output.some(item => item.method === 'notifications/message'), 'server notifications are relayed');
  io.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'posts_list', arguments: { x: 1 } } });
  assert.deepEqual((await io.reply(3)).error, { code: -32602, message: 'Invalid params' });
  const list = hub.seen.find(entry => entry.message.method === 'tools/list')!;
  assert.equal(list.headers.authorization, `Bearer ${token}`);
  assert.equal(list.headers['mcp-session-id'], 'session-1');
  assert.equal(list.headers['mcp-protocol-version'], '2025-11-25');
  assert.equal(hub.seen[0].headers['mcp-session-id'], undefined, 'initialize carries no session');
  assert.ok(hub.seen.some(entry => entry.message.method === 'notifications/initialized'));
});

test('a hub that is not SmartSell, a mismatched id, an HTTP error and invalid input all become JSON-RPC errors', async t => {
  let mode = 'wrong-server';
  const hub = await fakeMcp(t, (message, _request, response) => {
    if (mode === 'wrong-server') return json(response, { jsonrpc: '2.0', id: message.id, result: { ...initialize, serverInfo: { name: 'evil' } } });
    if (mode === 'wrong-id') return json(response, { jsonrpc: '2.0', id: 'other', result: {} });
    if (mode === '401') { response.writeHead(401, { 'www-authenticate': 'Bearer' }); return response.end(); }
    json(response, { jsonrpc: '2.0', id: message.id, result: {} });
  });
  const io = relay(t, hub.origin);
  io.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'c', version: '1' }, capabilities: {} } });
  assert.match((await io.reply(1)).error.message, /valid SmartSell MCP initialization/);
  mode = 'wrong-id';
  io.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.match((await io.reply(2)).error.message, /different JSON-RPC id/);
  mode = '401';
  io.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  const unauthorized = await io.reply(3);
  assert.equal(unauthorized.error.code, -32000);
  assert.match(unauthorized.error.message, /401/);
  assert.match(unauthorized.error.data.owner_message, /重新連接/);
  io.send('{not json');
  io.send({ jsonrpc: '1.0', id: 4, method: 'ping' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(io.output.filter(item => item.id === null && item.error?.code === -32600).length, 2);
});

test('after a hub restart forgets the session, the relay initializes again once and retries', async t => {
  let generation = 1;
  const hub = await fakeMcp(t, (message, request, response) => {
    if (message.method === 'initialize') return json(response, { jsonrpc: '2.0', id: message.id, result: initialize }, 200, { 'mcp-session-id': `session-${generation}` });
    if (message.method === 'notifications/initialized') { response.writeHead(202); return response.end(); }
    if (request.headers['mcp-session-id'] !== `session-${generation}`) { response.writeHead(404); return response.end(); }
    json(response, { jsonrpc: '2.0', id: message.id, result: { ok: generation } });
  });
  const io = relay(t, hub.origin);
  io.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'c', version: '1' }, capabilities: {} } });
  await io.reply(1);
  io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  io.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual((await io.reply(2)).result, { ok: 1 });
  generation = 2;
  io.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual((await io.reply(3)).result, { ok: 2 });
  assert.equal(hub.seen.filter(entry => entry.message.method === 'initialize').length, 2);
  // The client sees only its own initialize response.
  assert.equal(io.output.filter(item => item.result?.serverInfo).length, 1);
});

test('the relay refuses a plain-http hub that is not on this computer', async () => {
  await assert.rejects(runRelay({ hubOrigin: 'http://hub.example.com', token, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }), /https/);
  await assert.rejects(runRelay({ hubOrigin: 'https://hub.example.com/mcp', token, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }), /https/);
});
