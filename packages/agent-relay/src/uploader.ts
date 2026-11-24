import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { fileChanged } from './hash.ts';
import { HubApiError, NETWORK_ERROR, transientHubError, type HubApi } from './hub-api.ts';

/** Part sizing and retry rules (§6.3 step 7). Every value is injectable for tests. */
export interface UploadTuning {
  /** Chunks per request at the start (2), doubled when a part takes < fastMs, halved when > slowMs, within 1..maxChunksPerPart. */
  initialChunksPerPart: number;
  maxChunksPerPart: number;
  fastMs: number;
  slowMs: number;
  /** Requests in flight at once. */
  concurrency: number;
  /** Waits before each retry of a failed part (1, 2, 4, 8, 16 s: five retries). Read on every failure, so it can grow once in background. */
  retryDelaysMs: () => readonly number[];
  clock: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const FOREGROUND_RETRY_MS: readonly number[] = [1000, 2000, 4000, 8000, 16_000];
/** In the background the hub may be restarting (§5.1: 8:55–9:10); keep trying every 30 s for 30 minutes after the quick retries. */
export const BACKGROUND_RETRY_MS: readonly number[] = [...FOREGROUND_RETRY_MS, ...Array.from({ length: 60 }, () => 30_000)];

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

export const defaultTuning = (): UploadTuning => ({
  initialChunksPerPart: 2, maxChunksPerPart: 8, fastMs: 5000, slowMs: 30_000, concurrency: 2,
  retryDelaysMs: () => FOREGROUND_RETRY_MS, clock: () => performance.now(), sleep,
});

export interface UploadTarget { uploadId: string; path: string; bytes: number; mtimeMs: number; chunkBytes: number; chunks: number }
export interface UploadProgress {
  /** Bytes the hub holds (already received before this run plus parts accepted in it). */
  uploadedBytes: number;
  /** Bytes sent and accepted during this run, and the time spent (for the ETA). */
  sentBytes: number;
  sendingMs: number;
}
export interface PartRecord { n: number; k: number; ms: number }

/** Thrown when the hub no longer accepts parts (session failed, expired or already assembling). */
export class UploadStopped extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'UploadStopped'; this.code = code; }
}

const retryable = (error: unknown) => transientHubError(error) || (error instanceof HubApiError && error.code === 'UPLOAD_PART_HASH_MISMATCH');

function chunkLength(target: UploadTarget, index: number) {
  return index === target.chunks - 1 ? target.bytes - index * target.chunkBytes : target.chunkBytes;
}

/**
 * Send every chunk the hub is missing, 1–8 contiguous chunks per PUT, two at a time, each with x-part-sha256.
 * The file is re-checked (size and mtime) before every read; a change stops with FILE_CHANGED.
 */
export async function uploadMissing(api: HubApi, target: UploadTarget, received: readonly number[], options: {
  tuning?: Partial<UploadTuning>; signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void; parts?: PartRecord[];
} = {}) {
  const tuning = { ...defaultTuning(), ...options.tuning };
  const have = new Set(received);
  const missing = Array.from({ length: target.chunks }, (_, index) => index).filter(index => !have.has(index));
  let uploadedBytes = [...have].reduce((sum, index) => sum + chunkLength(target, index), 0);
  let sentBytes = 0;
  let sendingMs = 0;
  let k = Math.max(1, Math.min(tuning.maxChunksPerPart, tuning.initialChunksPerPart));
  let latest = [...have];
  const file = await open(target.path, 'r');
  const check = async () => {
    const info = await stat(target.path);
    if (info.size !== target.bytes || info.mtimeMs !== target.mtimeMs) throw fileChanged();
  };
  async function send(n: number, count: number) {
    const start = n * target.chunkBytes;
    const length = Math.min(target.bytes, (n + count) * target.chunkBytes) - start;
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      await check();
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(bytes, 0, length, start);
      if (bytesRead !== length) throw fileChanged();
      const digest = createHash('sha256').update(bytes).digest('hex');
      const began = tuning.clock();
      try {
        const result = await api.putPart(target.uploadId, n, bytes, digest, options.signal);
        const ms = tuning.clock() - began;
        latest = result.received;
        sentBytes += length;
        sendingMs += ms;
        uploadedBytes += length;
        options.parts?.push({ n, k: count, ms });
        // Adapt the part size to the measured link: fast parts grow, slow parts shrink (down to one 1 MiB chunk).
        if (ms < tuning.fastMs) k = Math.min(tuning.maxChunksPerPart, k * 2);
        else if (ms > tuning.slowMs) k = Math.max(1, Math.floor(k / 2));
        options.onProgress?.({ uploadedBytes, sentBytes, sendingMs });
        return;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (error instanceof HubApiError && (error.status === 404 || error.status === 409 || error.status === 410)) {
          throw new UploadStopped(error.code, error.message);
        }
        const delays = tuning.retryDelaysMs();
        if (!retryable(error) || attempt >= delays.length) throw error;
        // A slow link that timed out also gets smaller parts on the next try.
        if (error instanceof HubApiError && error.code === NETWORK_ERROR) k = Math.max(1, Math.floor(k / 2));
        await tuning.sleep(delays[attempt], options.signal);
      }
    }
  }
  try {
    const inflight = new Set<Promise<void>>();
    let failure: unknown;
    let cursor = 0;
    while ((cursor < missing.length || inflight.size) && failure === undefined) {
      while (cursor < missing.length && inflight.size < tuning.concurrency && failure === undefined) {
        const n = missing[cursor];
        let count = 1;
        while (count < k && cursor + count < missing.length && missing[cursor + count] === n + count) count++;
        cursor += count;
        const task: Promise<void> = send(n, count).catch(error => { failure ??= error; }).finally(() => inflight.delete(task));
        inflight.add(task);
      }
      if (inflight.size) await Promise.race(inflight);
    }
    await Promise.allSettled(inflight);
    if (failure !== undefined) throw failure;
    return { received: latest, uploadedBytes, sentBytes, sendingMs };
  } finally { await file.close(); }
}
