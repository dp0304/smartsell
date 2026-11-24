import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { InvalidMedia, localStorage, MAX_BYTES, MediaToolMissing, mediaTypes, probeMedia, probeTimeoutMs, sniffMime, snapshotTimeoutMs,
  withSnapshot } from '../src/index.ts';

const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function scratch(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'smartsell-media-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function generate(path: string, args: string[]) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '1', ...args, path]);
  assert.equal(result.status, 0, String(result.stderr));
}

test('QuickTime is an accepted type, told apart from mp4 by its ftyp brand', () => {
  assert.ok(mediaTypes.includes('video/quicktime'));
  const ftyp = (brand: string) => Buffer.from(`\x00\x00\x00\x14ftyp${brand}\x00\x00\x02\x00`, 'latin1');
  assert.equal(sniffMime(ftyp('qt  ')), 'video/quicktime');
  assert.equal(sniffMime(ftyp('isom')), 'video/mp4');
  assert.equal(sniffMime(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1')), 'image/png');
  assert.equal(sniffMime(Buffer.from('RIFF0000WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(sniffMime(Buffer.from('GIF89a', 'latin1')), 'image/gif');
  assert.equal(sniffMime(Buffer.from('\xff\xd8\xff\xe0', 'latin1')), 'image/jpeg');
  assert.equal(sniffMime(Buffer.from('hello world, not media', 'latin1')), undefined);
});

test('a .mov passes ffprobe with the mov demuxer; mp4 too', { skip: !ffmpeg && 'ffmpeg/ffprobe not installed' }, async t => {
  const root = await scratch(t);
  const mov = join(root, 'clip.mov');
  const mp4 = join(root, 'clip.mp4');
  generate(mov, ['-c:v', 'mpeg4']);
  generate(mp4, ['-c:v', 'mpeg4', '-f', 'mp4']);
  assert.equal(sniffMime((await readFile(mov)).subarray(0, 64)), 'video/quicktime');
  const movMeta = await probeMedia(mov, 'video/quicktime', { timeoutMs: probeTimeoutMs(1) });
  assert.deepEqual([movMeta.width, movMeta.height, Math.round(movMeta.duration_seconds!)], [320, 240, 1]);
  const mp4Meta = await probeMedia(mp4, 'video/mp4');
  assert.equal(mp4Meta.width, 320);
  // The mp4 signature check refuses a QuickTime file declared as mp4.
  await assert.rejects(probeMedia(mov, 'video/mp4'), InvalidMedia);
  // An absurdly short deadline kills ffprobe and reports the media as unprocessable, not as a success.
  await assert.rejects(probeMedia(mov, 'video/quicktime', { timeoutMs: 1 }), InvalidMedia);
});

test('a missing ffprobe is reported as MediaToolMissing so hosts can degrade', async t => {
  const root = await scratch(t);
  const path = join(root, 'tiny.png');
  await writeFile(path, Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR', 'latin1'));
  await assert.rejects(probeMedia(path, 'image/png', { ffprobe: join(root, 'no-such-ffprobe') }), MediaToolMissing);
});

test('deadlines scale with size: ffprobe 60 s + 30 s/GB, snapshots max(120 s, 30 s/100 MB)', () => {
  assert.equal(probeTimeoutMs(1), 60_000 + 1);
  assert.equal(probeTimeoutMs(1_000_000_000), 90_000);
  assert.equal(probeTimeoutMs(2_000_000_000), 120_000);
  assert.equal(snapshotTimeoutMs(10_000_000), 120_000);
  assert.equal(snapshotTimeoutMs(1_000_000_000), 300_000);
});

test('withSnapshot takes the host limit instead of a fixed 512 MiB', async () => {
  const bytes = Buffer.from('limit test');
  // Reported size above the old fixed ceiling is accepted when the host allows it (the stream is checked separately).
  await assert.rejects(withSnapshot(Readable.from([bytes]), MAX_BYTES + 1, sha(bytes), async () => 'never'), /Invalid object size/);
  await assert.rejects(withSnapshot(Readable.from([bytes]), MAX_BYTES + 1, sha(bytes), async () => 'never', { maxBytes: 2 * MAX_BYTES }), /does not match/);
  assert.equal(await withSnapshot(Readable.from([bytes]), bytes.length, sha(bytes), async path => (await readFile(path)).toString(), { maxBytes: 16 }), 'limit test');
  await assert.rejects(withSnapshot(Readable.from([bytes]), bytes.length, sha(bytes), async () => 'never', { maxBytes: 4 }), /Invalid object size/);
});

test('local storage moves an assembled file into place and serves inclusive byte ranges', async t => {
  const root = await scratch(t);
  const storage = localStorage(join(root, 'objects'));
  const source = join(root, 'assembled.bin');
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
  await writeFile(source, bytes);
  const key = 't/tenant-a/w/workspace-a/objects/00000000-0000-4000-8000-000000000001';
  await storage.move!(key, { path: source, size: bytes.length, sha256: sha(bytes), mime: 'video/mp4' });
  assert.equal(existsSync(source), false);
  const read = async (range?: { start: number; end: number }) => {
    const object = await storage.read(key, range);
    const parts: Buffer[] = [];
    for await (const chunk of object.stream) parts.push(chunk as Buffer);
    return { size: object.size, bytes: Buffer.concat(parts) };
  };
  assert.ok((await read()).bytes.equals(bytes));
  const slice = await read({ start: 100, end: 199 });
  assert.equal(slice.size, bytes.length);
  assert.ok(slice.bytes.equals(bytes.subarray(100, 200)));
});
