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

export const MAX_BYTES = 512 * 1024 * 1024;
export const INLINE_BYTES = 512 * 1024;
let snapshots = 0;

/** Check length and digest on the same private snapshot used for probing and publishing. */
export async function withSnapshot<T>(source: Readable, size: number, digest: string, use: (path: string) => Promise<T>) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES || !/^[a-f0-9]{64}$/.test(digest)) {
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
    await pipeline(source, check, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(120_000) });
    if (count !== size || hash.digest('hex') !== digest) throw new InvalidMedia('File size or SHA-256 does not match');
    return await use(path);
  } finally {
    source.destroy();
    try { if (dir) await rm(dir, { recursive: true, force: true }); } finally { snapshots--; }
  }
}
