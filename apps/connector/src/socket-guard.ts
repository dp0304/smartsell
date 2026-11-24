// Node 24's bundled undici (7.x before 7.30.2) calls `socket.setTypeOfService(0)` unguarded before every HTTP/1.1
// write. On macOS `setsockopt(IP_TOS)` fails with EINVAL when the peer reset the connection between connect and that
// write — a hub restart or a dropped tailnet path does exactly this — and `net.Socket#setTypeOfService` throws it
// synchronously inside undici's socket callback: an uncaught exception that kills the Worker instead of failing the
// request (nodejs/undici#5544, fixed upstream by #5547 / #6076 in undici 7.30.2 and 8.x). Found by E2E-2 (S8): both
// headless Workers died when the hub was killed. QoS marking is best-effort, so — like the fixed undici — a failed
// setsockopt is ignored here and the request then fails normally (ECONNRESET), which the supervisor already handles.
import { Socket } from 'node:net';

const GUARDED = Symbol.for('smartsell.socket.typeOfServiceGuarded');

type TypeOfServiceTarget = { setTypeOfService?: (tos: number) => unknown; [GUARDED]?: true };

/** Idempotent. Only errors raised by the setsockopt call itself are ignored; argument errors still throw. */
export function guardSocketTypeOfService(prototype: TypeOfServiceTarget = Socket.prototype as unknown as TypeOfServiceTarget) {
  const original = prototype.setTypeOfService;
  if (typeof original !== 'function' || prototype[GUARDED]) return false;
  prototype.setTypeOfService = function guardedSetTypeOfService(this: unknown, tos: number) {
    try { return original.call(this, tos); }
    catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.syscall === 'setTypeOfService') return this;
      throw error;
    }
  };
  prototype[GUARDED] = true;
  return true;
}

export const socketTypeOfServiceGuarded = (prototype: TypeOfServiceTarget = Socket.prototype as unknown as TypeOfServiceTarget) => prototype[GUARDED] === true;
