import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InvalidMedia } from './probe.js';
import { StorageFailure } from './storage.js';

export * from './storage.js';
export * from './s3.js';
export * from './probe.js';

/** Default upload ceiling outside the hub; hosts pass their own via createMediaFiles({ maxBytes }) (§6.5). */
export const MAX_BYTES = 512 * 1024 * 1024;
/** Hard ceiling for any configured limit (SMARTSELL_MAX_UPLOAD_BYTES, §6.8). */
export const MAX_UPLOAD_LIMIT = 4 * 1024 * 1024 * 1024;
export const INLINE_BYTES = 512 * 1024;
let snapshots = 0;

/** Copy deadline for a snapshot: max(120 s, 30 s per 100 MB) (§6.5). */
export const snapshotTimeoutMs = (size: number) => Math.max(120_000, Math.ceil(Math.max(0, size) / 100_000_000 * 30_000));

export interface SnapshotOptions { maxBytes?: number }

/** Check length and digest on the same private snapshot used for probing and publishing. */
export async function withSnapshot<T>(source: Readable, size: number, digest: string, use: (path: string) => Promise<T>, options: SnapshotOptions = {}) {
  const maxBytes = Math.min(options.maxBytes ?? MAX_BYTES, MAX_UPLOAD_LIMIT);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes || !/^[a-f0-9]{64}$/.test(digest)) {
    source.destroy();
    throw new InvalidMedia('Invalid object size or checksum');
  }
  if (snapshots >= 4) {
    source.destroy();
    throw new StorageFailure('Media snapshot capacity exceeded');
  }
  snapshots++;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'smartsell-media-'));
    const path = join(dir, 'bytes');
    const hash = createHash('sha256');
    let count = 0;
    const check = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      if (count > size) return callback(new InvalidMedia('File exceeds declared size'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(source, check, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(snapshotTimeoutMs(size)) });
    if (count !== size || hash.digest('hex') !== digest) throw new InvalidMedia('File size or SHA-256 does not match');
    return await use(path);
  } finally {
    source.destroy();
    try { if (dir) await rm(dir, { recursive: true, force: true }); } finally { snapshots--; }
  }
}
