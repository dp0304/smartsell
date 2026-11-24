// socket-guard.ts (S8 ledger item 3, E29): the relay talks to the hub with global fetch; a failed setsockopt(IP_TOS) on a
// connection the hub reset must fail that request, not kill the relay process. The failure is simulated on a real socket.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer, Socket, type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { relayMain } from '../src/cli.ts';
import { guardSocketTypeOfService, socketTypeOfServiceGuarded } from '../src/socket-guard.ts';

test('relayMain installs the guard on net.Socket when the relay starts, once', async () => {
  // node:test runs each file in its own process, and nothing above installs it at import time.
  assert.equal(socketTypeOfServiceGuarded(), false, 'not installed by importing the relay');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  assert.equal(await relayMain({ argv: ['--version'], stdin: new PassThrough(), stdout, stderr }), 0);
  assert.equal(socketTypeOfServiceGuarded(), true);
  assert.equal(guardSocketTypeOfService(), false, 'idempotent: a second call changes nothing');
  // The connector's copy uses the same Symbol.for key, so a process that loads both installs it once.
  assert.equal((Socket.prototype as unknown as Record<symbol, unknown>)[Symbol.for('smartsell.socket.typeOfServiceGuarded')], true);
});

test('a setsockopt failure (EINVAL on a socket the peer reset) is ignored; argument errors still throw', async t => {
  guardSocketTypeOfService();
  const server = createServer(socket => socket.on('error', () => {}));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const socket = new Socket();
  socket.connect((server.address() as AddressInfo).port, '127.0.0.1');
  await once(socket, 'connect');
  t.after(() => socket.destroy());
  // What macOS answers after the peer reset the connection: the native call fails with UV_EINVAL.
  const handle = (socket as unknown as { _handle: { setTypeOfService: (tos: number) => number } })._handle;
  handle.setTypeOfService = () => -22;
  assert.doesNotThrow(() => socket.setTypeOfService(8));
  assert.throws(() => socket.setTypeOfService(Number.NaN), (error: NodeJS.ErrnoException) => error.code === 'ERR_INVALID_ARG_TYPE');
});

test('with the guard, global fetch to a hub that resets the connection rejects instead of crashing the process', async t => {
  guardSocketTypeOfService();
  // Every socket the client opens fails its setsockopt, as on macOS after the reset; the hub then drops the connection.
  const original = Socket.prototype.connect;
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    this.once('connect', () => {
      const handle = (this as unknown as { _handle?: { setTypeOfService?: (tos: number) => number } })._handle;
      if (handle) handle.setTypeOfService = () => -22;
    });
    return (original as (...rest: unknown[]) => Socket).apply(this, args);
  } as typeof Socket.prototype.connect;
  t.after(() => { Socket.prototype.connect = original; });
  const hub = createHttpServer((request) => request.socket.destroy());
  hub.listen(0, '127.0.0.1');
  await once(hub, 'listening');
  t.after(() => hub.close());
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  await assert.rejects(fetch(`http://127.0.0.1:${(hub.address() as AddressInfo).port}/mcp`, { method: 'POST', body: '{}' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uncaught, []);
});

test('without the guard the same failure is a synchronous throw (what would crash the relay inside undici\'s write path)', () => {
  const failing = { setTypeOfService(this: unknown) { throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' }); } };
  assert.throws(() => failing.setTypeOfService.call(failing), /EINVAL/);
  assert.equal(guardSocketTypeOfService(failing), true);
  assert.doesNotThrow(() => (failing.setTypeOfService as (tos: number) => unknown).call(failing, 0));
  const other = { setTypeOfService() { throw Object.assign(new Error('boom'), { syscall: 'write' }); } };
  guardSocketTypeOfService(other);
  assert.throws(() => (other.setTypeOfService as (tos: number) => unknown).call(other, 0), /boom/, 'unrelated errors are not swallowed');
});
