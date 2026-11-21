import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function readKey(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Commands identity key must be a 32-byte regular file accessible only to its owner');
    }
    const key = readFileSync(fd);
    if (key.length !== 32) throw new Error('Invalid Commands identity key');
    return key;
  } finally {
    closeSync(fd);
  }
}

/** Publish a complete preview key atomically, even if two previews start together. */
export function previewIdentityKey(statePath: string) {
  const path = `${statePath}.identity-key`;
  try { return readKey(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temp = mkdtempSync(`${path}.`);
  const keyFile = join(temp, 'key');
  try {
    writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600, flush: true });
    try { linkSync(keyFile, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return readKey(path);
  } finally {
    try { unlinkSync(keyFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { rmdirSync(temp); }
  }
}
