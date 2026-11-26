// Remote-control broker (design E50): an Agent's command waits here for the machine's Worker, which long-polls
// POST /api/v1/device/remote/next and answers on /remote/result. In memory only: a command is useful for seconds, and
// the hub is one process (§2). Nothing here holds a database transaction while waiting (§0 rule 8).
import { randomUUID } from 'node:crypto';
import { Problem, type RemoteCapabilities, type RemoteCommandEnvelope, type RemoteResultRequest, type RemoteTarget } from '@smartsell/contracts';

type Outcome = Extract<RemoteResultRequest, { ok: true }>['result'];
interface Pending { envelope: RemoteCommandEnvelope; resolve(value: Outcome): void; reject(error: Error): void; timer: NodeJS.Timeout; device: string }
interface Device { queue: Pending[]; waiters: Set<(pending: Pending | null) => void>; capabilities: RemoteCapabilities | null; lastPollAt: number }

const key = (workspaceId: string, deviceId: string) => `${workspaceId}:${deviceId}`;

export interface RemoteBrokerOptions { now?(): number }

export class RemoteBroker {
  readonly #devices = new Map<string, Device>();
  readonly #pending = new Map<string, Pending>();
  /** Browser session → the machine it lives on, so browser_act needs only the session id. */
  readonly #sessions = new Map<string, { workspaceId: string; deviceId: string }>();
  constructor(private readonly options: RemoteBrokerOptions = {}) {}

  #now() { return this.options.now?.() ?? Date.now(); }
  #device(workspaceId: string, deviceId: string) {
    const id = key(workspaceId, deviceId);
    let device = this.#devices.get(id);
    if (!device) { device = { queue: [], waiters: new Set(), capabilities: null, lastPollAt: 0 }; this.#devices.set(id, device); }
    return device;
  }

  /** The Worker is listening when it polled within the last 40 s (a poll waits up to 25 s). */
  listening(workspaceId: string, deviceId: string) {
    const device = this.#devices.get(key(workspaceId, deviceId));
    return !!device && (device.waiters.size > 0 || this.#now() - device.lastPollAt < 40_000);
  }

  capabilities(workspaceId: string, deviceId: string) { return this.#devices.get(key(workspaceId, deviceId))?.capabilities ?? null; }

  /**
   * Queues a command for the machine and resolves with the Worker's result. Rejects with a Problem when the Worker is not
   * listening, refuses, or does not answer in time.
   */
  submit(workspaceId: string, deviceId: string, target: RemoteTarget, command: Record<string, unknown>, options: { serial?: string; timeoutMs?: number } = {}): Promise<Outcome> {
    if (!this.listening(workspaceId, deviceId)) {
      return Promise.reject(new Problem(409, 'MACHINE_NOT_LISTENING', 'That machine\'s SmartSell Worker is not connected for remote control right now (it may be off, offline, or remote control is off on that machine).'));
    }
    const timeoutMs = options.timeoutMs ?? 45_000;
    const device = this.#device(workspaceId, deviceId);
    return new Promise<Outcome>((resolve, reject) => {
      const envelope: RemoteCommandEnvelope = { command_id: randomUUID(), target, ...(options.serial && { serial: options.serial }), command,
        expires_at: new Date(this.#now() + timeoutMs).toISOString() };
      const timer = setTimeout(() => {
        this.#pending.delete(envelope.command_id);
        device.queue = device.queue.filter(item => item.envelope.command_id !== envelope.command_id);
        reject(new Problem(504, 'MACHINE_TIMEOUT', 'The machine did not answer in time. Take a new snapshot before acting again.'));
      }, timeoutMs);
      timer.unref?.();
      const pending: Pending = { envelope, resolve, reject, timer, device: key(workspaceId, deviceId) };
      this.#pending.set(envelope.command_id, pending);
      const [waiter] = device.waiters;
      if (waiter) { device.waiters.delete(waiter); waiter(pending); }
      else device.queue.push(pending);
    });
  }

  /** The Worker's long poll: the next command for this machine, or null after `waitMs`. */
  next(workspaceId: string, deviceId: string, capabilities: RemoteCapabilities, waitMs: number, signal?: AbortSignal): Promise<RemoteCommandEnvelope | null> {
    const device = this.#device(workspaceId, deviceId);
    device.capabilities = capabilities;
    device.lastPollAt = this.#now();
    const queued = device.queue.shift();
    if (queued) return Promise.resolve(queued.envelope);
    return new Promise(resolve => {
      const done = (pending: Pending | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        device.lastPollAt = this.#now();
        resolve(pending?.envelope ?? null);
      };
      const abort = () => { device.waiters.delete(done); done(null); };
      const timer = setTimeout(() => { device.waiters.delete(done); done(null); }, Math.max(0, Math.min(waitMs, 25_000)));
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      device.waiters.add(done);
    });
  }

  /** The Worker's answer. Only the machine the command was sent to can answer it. */
  resolve(workspaceId: string, deviceId: string, result: RemoteResultRequest) {
    const pending = this.#pending.get(result.command_id);
    if (!pending || pending.device !== key(workspaceId, deviceId)) return false;
    this.#pending.delete(result.command_id);
    clearTimeout(pending.timer);
    if (result.ok) {
      const session = result.result.session_id;
      if (pending.envelope.target === 'browser' && typeof session === 'string') this.#sessions.set(session, { workspaceId, deviceId });
      if (pending.envelope.command.op === 'close' && typeof pending.envelope.command.session_id === 'string') this.#sessions.delete(pending.envelope.command.session_id);
      pending.resolve(result.result);
    } else {
      pending.reject(new Problem(422, result.error.code.replace(/[^A-Z0-9_]/g, '').slice(0, 64) || 'REMOTE_FAILED', result.error.message.slice(0, 500)));
    }
    return true;
  }

  sessionMachine(sessionId: string) { return this.#sessions.get(sessionId); }
}

let shared: RemoteBroker | undefined;
/** The hub's one broker (device routes and MCP tools share it). */
export function remoteBroker() { return (shared ??= new RemoteBroker()); }
export function setRemoteBrokerForTests(broker: RemoteBroker | undefined) { shared = broker; }
