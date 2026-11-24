import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type ByteRange = { start: number; end: number };
export type ObjectBytes = { stream: Readable; size: number };
export type WriteObject = { path: string; size: number; sha256: string; mime: string };
export interface Storage {
  readonly bucket: string;
  read(key: string, range?: ByteRange): Promise<ObjectBytes>;
  write(key: string, object: WriteObject): Promise<void>;
  /**
   * Optional: take ownership of `object.path` (the caller must not reuse it). Local storage renames instead of
   * copying, so a 1 GB assembled upload is not written twice. Callers fall back to write() when absent.
   */
  move?(key: string, object: WriteObject): Promise<void>;
  remove(key: string): Promise<void>;
  presignUpload?(key: string, size: number, expires: number): { url: string; method: 'PUT'; headers: Record<string, string> };
}

export class ObjectMissing extends Error {}
export class StorageFailure extends Error {}

export function objectKey(key: string) {
  if (!/^t\/[A-Za-z0-9_-]{1,128}\/w\/[A-Za-z0-9_-]{1,128}\/(staging|objects)\/[0-9a-f-]{36}$/.test(key)) {
    throw new StorageFailure('Invalid storage key');
  }
  return key;
}

export function localStorage(root: string): Storage {
  const pathFor = (key: string) => resolve(root, objectKey(key));
  async function write(key: string, object: WriteObject) {
    const path = pathFor(key);
    const temp = `${path}.part`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await rm(temp, { force: true });
    try {
      await pipeline(createReadStream(object.path), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const file = await open(temp, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  return {
    bucket: 'local',
    async read(key, range) {
      const file = await open(pathFor(key), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') throw new ObjectMissing();
        throw new StorageFailure('Could not open media object');
      });
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new StorageFailure('Invalid local media object');
        return { size: stat.size, stream: file.createReadStream(range) };
      } catch (error) {
        await file.close();
        throw error;
      }
    },
    write,
    async move(key, object) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        const file = await open(object.path, 'r+');
        try { await file.sync(); } finally { await file.close(); }
        await chmod(object.path, 0o600);
        await rename(object.path, path);
      } catch (error) {
        // Different volume: copy, then drop the source.
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await write(key, object);
        await rm(object.path, { force: true });
      }
    },
    async remove(key) {
      const path = pathFor(key);
      await rm(path, { force: true });
      await rm(`${path}.part`, { force: true });
    },
  };
}
