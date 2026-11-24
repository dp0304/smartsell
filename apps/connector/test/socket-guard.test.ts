// socket-guard.ts (S8 fix loop, found by E2E-2): a failed setsockopt(IP_TOS) on a reset hub connection must fail the
// request, not kill the Worker. The setsockopt failure is simulated on a real socket, deterministically.
import assert from 'node:assert/strict';
import { createServer, Socket, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { guardSocketTypeOfService, socketTypeOfServiceGuarded } from '../src/socket-guard.ts';
import '../src/device-client.ts';

test('the device client installs the guard on net.Socket when it loads (both the App and the headless runner import it)', () => {
  assert.equal(socketTypeOfServiceGuarded(), true);
  assert.equal(guardSocketTypeOfService(), false, 'idempotent: a second call changes nothing');
});

test('a setsockopt failure (EINVAL on a socket the peer reset) is ignored; argument errors still throw', async t => {
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

test('without the guard the same failure is a synchronous throw (what crashed the Worker inside undici\'s write path)', () => {
  const failing = { setTypeOfService(this: unknown) { throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' }); } };
  assert.throws(() => failing.setTypeOfService.call(failing), /EINVAL/);
  assert.equal(guardSocketTypeOfService(failing), true);
  assert.doesNotThrow(() => (failing.setTypeOfService as (tos: number) => unknown).call(failing, 0));
  const other = { setTypeOfService() { throw Object.assign(new Error('boom'), { syscall: 'write' }); } };
  guardSocketTypeOfService(other);
  assert.throws(() => (other.setTypeOfService as (tos: number) => unknown).call(other, 0), /boom/, 'unrelated errors are not swallowed');
});
