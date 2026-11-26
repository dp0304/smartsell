import { Problem } from '@smartsell/contracts';

/**
 * Device request nonces (phase1-design §2.10). The hub keeps them in memory so a heartbeat does not rewrite the snapshot;
 * Postgres deployments keep the device_nonce records ('records').
 */
export interface NonceStore {
  /** Throws 401 DEVICE_PROOF_REPLAYED / DEVICE_PROOF_EXPIRED or 503 DEVICE_BUSY; otherwise remembers the nonce. */
  use(deviceId: string, nonce: string, issuedAt: number, now: number): void;
}

export const NONCE_TTL_MS = 61_000;
export const NONCE_CAPACITY = 50_000;
/**
 * S10: unexpired nonces one machine may hold, so one machine flooding signed requests fills only its own share and the
 * others keep working. A Worker sends a few requests a minute; 2,000 within 61 s is about 33 a second.
 */
export const NONCE_PER_DEVICE = 2_000;

const busy = () => new Problem(503, 'DEVICE_BUSY', 'The hub is busy; retry in a second', { retry_after: 1 });

export class MemoryNonceStore implements NonceStore {
  /** device id → nonce → expiry. */
  readonly #seen = new Map<string, Map<string, number>>();
  readonly #startedAt: number;
  readonly #perDevice: number;
  #size = 0;
  constructor(private readonly capacity = NONCE_CAPACITY, startedAt = Date.now(), perDevice = NONCE_PER_DEVICE) {
    this.#startedAt = startedAt;
    this.#perDevice = Math.min(perDevice, capacity);
  }

  get size() { return this.#size; }

  #pruneDevice(deviceId: string, nonces: Map<string, number>, now: number) {
    for (const [nonce, expires] of nonces) if (expires <= now) { nonces.delete(nonce); this.#size--; }
    if (!nonces.size) this.#seen.delete(deviceId);
  }

  #prune(now: number) {
    for (const [deviceId, nonces] of this.#seen) this.#pruneDevice(deviceId, nonces, now);
  }

  use(deviceId: string, nonce: string, issuedAt: number, now: number) {
    // A request signed before this process started could be a replay of one the previous process accepted.
    if (issuedAt < this.#startedAt - 1_000) throw new Problem(401, 'DEVICE_PROOF_EXPIRED', 'The signed request predates the hub restart; sign it again');
    let nonces = this.#seen.get(deviceId);
    const expires = nonces?.get(nonce);
    if (expires !== undefined && expires > now) throw new Problem(401, 'DEVICE_PROOF_REPLAYED', 'The device request was already used');
    // Full of unexpired nonces: refuse instead of evicting one, which would make it replayable within its 61 s.
    if (nonces && nonces.size >= this.#perDevice) {
      this.#pruneDevice(deviceId, nonces, now);
      if (nonces.size >= this.#perDevice) throw busy();
    }
    if (this.#size >= this.capacity) this.#prune(now);
    if (this.#size >= this.capacity) throw busy();
    nonces = this.#seen.get(deviceId);
    if (!nonces) this.#seen.set(deviceId, nonces = new Map());
    if (!nonces.has(nonce)) this.#size++;
    nonces.set(nonce, issuedAt + NONCE_TTL_MS);
  }
}

let configured: NonceStore | 'records' = 'records';
/** bootstrap selects the memory store for the hub and the local/memory stores; Postgres keeps 'records'. */
export function configureDeviceNonces(store: NonceStore | 'records') { configured = store; }
export const deviceNonceStore = (): NonceStore | 'records' => configured;
