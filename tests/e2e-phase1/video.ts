// Test media for the E2E stack. The 30 MB clip is the §10.2 ffmpeg command; it is generated once per machine and
// shared by the parallel test files (cached under the OS temp directory: Playwright empties test-results/ when it
// starts). The 1 GB file for E2E-11 is an MP4 header plus mdat padding (the §10.2 alternative), written on demand.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync, copyFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheDir = join(tmpdir(), 'smartsell-e2e-phase1-media');

export interface TestMedia { path: string; sha256: string; bytes: number }

const FFMPEG_CANDIDATES = [process.env.SMARTSELL_FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
export function ffmpegPath(): string | undefined {
  return FFMPEG_CANDIDATES.find((path): path is string => !!path && existsSync(path));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function sleepSync(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** The §10.2 clip: testsrc2 1080x1920 at 30 fps with a sine track, 20 s, H.264 12 Mbit/s, ≈ 30 MB. */
function ensureCachedClip(): string {
  const target = join(cacheDir, 'video-1080x1920-20s-12M.mp4');
  if (existsSync(target)) return target;
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw new Error('ffmpeg is required for the E2E clip (set SMARTSELL_FFMPEG_PATH)');
  mkdirSync(cacheDir, { recursive: true });
  const lock = `${target}.lock`;
  // Parallel test files: one generates, the others wait for the rename.
  for (let waited = 0; ; waited += 500) {
    try { closeSync(openSync(lock, 'wx')); break; } catch {
      if (existsSync(target)) return target;
      // A lock older than 3 minutes belongs to a dead process.
      try { if (Date.now() - statSync(lock).mtimeMs > 180_000) rmSync(lock, { force: true }); } catch { /* gone */ }
      if (waited > 240_000) throw new Error('timed out waiting for another process to generate the E2E clip');
      sleepSync(500);
    }
  }
  try {
    if (existsSync(target)) return target;
    const temp = `${target}.${process.pid}.tmp.mp4`;
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-f', 'lavfi', '-i', 'sine',
      '-t', '20', '-c:v', 'libx264', '-b:v', '12M', '-c:a', 'aac', temp], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000 });
    renameSync(temp, target);
    return target;
  } finally {
    rmSync(lock, { force: true });
  }
}

/** A private copy (hard link when possible) of the 30 MB clip under `dir`, named video.mp4. */
export async function e2eClip(dir: string, name = 'video.mp4'): Promise<TestMedia> {
  const cached = ensureCachedClip();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (!existsSync(path)) { try { linkSync(cached, path); } catch { copyFileSync(cached, path); } }
  return { path, sha256: await sha256File(path), bytes: statSync(path).size };
}

/** An MP4 header (ftyp) followed by an mdat box of deterministic filler, `size` bytes in all (E2E-11). */
export async function largeMp4(dir: string, size: number, name = 'large.mp4'): Promise<TestMedia> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const fd = openSync(path, 'w', 0o600);
  try {
    const ftyp = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0x02, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]);
    writeSync(fd, ftyp);
    const mdatSize = size - ftyp.length;
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write('mdat', 4, 'latin1');
    header.writeBigUInt64BE(BigInt(mdatSize), 8);
    writeSync(fd, header);
    const block = Buffer.alloc(8 * 1024 * 1024);
    for (let index = 0; index < block.length; index++) block[index] = (index * 131 + 7) & 0xff;
    let remaining = mdatSize - header.length;
    let round = 0;
    while (remaining > 0) {
      const length = Math.min(block.length, remaining);
      block.writeUInt32BE(round++, 0);   // every block differs, so chunk hashes differ
      writeSync(fd, block, 0, length);
      remaining -= length;
    }
  } finally { closeSync(fd); }
  return { path, sha256: await sha256File(path), bytes: statSync(path).size };
}

export function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }
