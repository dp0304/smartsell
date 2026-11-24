import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ToolError } from '../src/errors.ts';
import type { HubApi } from '../src/hub-api.ts';
import { createMediaUploadHandler } from '../src/media-upload.ts';
import { detectType } from '../src/media-type.ts';
import { deniedPath, PATH_NOT_ABSOLUTE_MESSAGE, resolveMediaPath } from '../src/paths.ts';

const png = Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR', 'latin1');
const mp4 = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2', 'latin1'), Buffer.alloc(64)]);

async function home(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'smartsell-relay-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['Movies', '.ssh', '.config/app', 'Library/Keychains', 'Projects/.cache', 'relay-data']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'Movies', 'video.mp4'), mp4);
  await writeFile(join(root, '.ssh', 'id.mp4'), mp4);
  await writeFile(join(root, 'Projects', '.cache', 'clip.mp4'), mp4);
  await writeFile(join(root, 'relay-data', 'clip.mp4'), mp4);
  await writeFile(join(root, 'Movies', 'notes.mp4'), 'this is a text file with a video extension');
  await writeFile(join(root, 'Movies', 'still.mp4'), png);
  await symlink(join(root, '.ssh', 'id.mp4'), join(root, 'Movies', 'link.mp4'));
  return root;
}

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { if (error instanceof ToolError) return error.code; throw error; }
  return 'ok';
};

test('only absolute or ~/ paths are accepted, with the exact guidance for relative ones', async t => {
  const root = await home(t);
  const policy = { homeDir: root, platform: process.platform };
  await assert.rejects(resolveMediaPath('video.mp4', policy), (error: ToolError) => error.code === 'PATH_NOT_ABSOLUTE' && error.message === PATH_NOT_ABSOLUTE_MESSAGE);
  assert.equal(await code(resolveMediaPath('./Movies/video.mp4', policy)), 'PATH_NOT_ABSOLUTE');
  assert.equal(await code(resolveMediaPath('~user/video.mp4', policy)), 'PATH_NOT_ABSOLUTE');
  const tilde = await resolveMediaPath('~/Movies/video.mp4', policy);
  assert.equal(tilde.lexical, join(root, 'Movies', 'video.mp4'));
  assert.equal((await resolveMediaPath(join(root, 'Movies', 'video.mp4'), policy)).stat.size, mp4.length);
  assert.equal(await code(resolveMediaPath(join(root, 'Movies', 'missing.mp4'), policy)), 'MEDIA_NOT_FOUND');
  assert.equal(await code(resolveMediaPath(join(root, 'Movies'), policy)), 'MEDIA_NOT_FOUND');
});

test('credential, system and hidden directories, the relay data directory and symlinks into them are refused', async t => {
  const root = await home(t);
  const policy = { homeDir: root, platform: process.platform, denyDirs: [join(root, 'relay-data')] };
  assert.equal(await code(resolveMediaPath('~/.ssh/id.mp4', policy)), 'PATH_NOT_ALLOWED');
  assert.equal(await code(resolveMediaPath(join(root, 'Projects', '.cache', 'clip.mp4'), policy)), 'PATH_NOT_ALLOWED');
  assert.equal(await code(resolveMediaPath(join(root, 'relay-data', 'clip.mp4'), policy)), 'PATH_NOT_ALLOWED');
  assert.equal(await code(resolveMediaPath(join(root, 'Movies', 'link.mp4'), policy)), 'PATH_NOT_ALLOWED', 'a symlink into ~/.ssh');
  assert.equal(await code(resolveMediaPath(join(root, 'Movies', '..', '.ssh', 'id.mp4'), policy)), 'PATH_NOT_ALLOWED');
  assert.equal(await code(resolveMediaPath('/etc/hosts', policy)), 'PATH_NOT_ALLOWED');
  const rule = { homeDir: '/Users/owner', platform: 'darwin' as const };
  assert.equal(deniedPath('/Users/owner/Library/Keychains/login.keychain-db', rule), true);
  assert.equal(deniedPath('/Users/owner/LIBRARY/keychains/x.mp4', rule), true, 'case-insensitive on macOS');
  assert.equal(deniedPath('/private/etc/passwd', rule), true);
  assert.equal(deniedPath('/Users/owner/.config/x.mp4', rule), true);
  assert.equal(deniedPath('/Users/owner/Movies/.hidden.mp4', rule), false, 'a hidden file name is not a hidden directory');
  assert.equal(deniedPath('/Users/owner/Movies/video.mp4', rule), false);
  const windows = { homeDir: 'C:\\Users\\owner', platform: 'win32' as const, denyDirs: ['C:\\Users\\owner\\AppData\\Roaming\\SmartSell Worker\\agent-relay'] };
  assert.equal(deniedPath('C:\\Windows\\System32\\x.mp4', windows), true);
  assert.equal(deniedPath('c:\\windows\\x.mp4', windows), true);
  assert.equal(deniedPath('C:\\Users\\owner\\.ssh\\x.mp4', windows), true);
  assert.equal(deniedPath('C:\\Users\\owner\\AppData\\Roaming\\SmartSell Worker\\agent-relay\\credential', windows), true);
  assert.equal(deniedPath('C:\\Users\\owner\\Videos\\video.mp4', windows), false);
});

test('the type comes from the first bytes, not the extension', async t => {
  assert.deepEqual(detectType(mp4), { mime: 'video/mp4', kind: 'video' });
  assert.deepEqual(detectType(Buffer.from('\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00', 'latin1')), { mime: 'video/quicktime', kind: 'video' });
  assert.deepEqual(detectType(Buffer.concat([Buffer.from('\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm', 'latin1'), Buffer.alloc(32)])), { mime: 'video/webm', kind: 'video' });
  assert.equal(detectType(Buffer.from('\x1a\x45\xdf\xa3\x9f\x42\x82\x88matroska', 'latin1')), undefined, 'mkv is not webm');
  assert.deepEqual(detectType(png), { mime: 'image/png', kind: 'image' });
  // Through the tool: a text file named .mp4 is refused, a PNG named .mp4 is an image. No hub call is made for refusals.
  const root = await home(t);
  const calls: string[] = [];
  const api = new Proxy({}, { get: (_target, name: string) => async (...args: unknown[]) => {
    calls.push(name);
    if (name === 'config') return { max_upload_bytes: 2 ** 31, chunk_bytes: 1024 * 1024, max_chunks_per_part: 8, accepted_mime: ['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'] };
    if (name === 'create') return { upload_id: null, media_id: 'm-1', status: 'ready', chunk_bytes: 1, chunks: 1, received: [], expires_at: null, deduplicated: true,
      media: { media_id: 'm-1', status: 'ready', kind: 'image', mime: (args[0] as { mime: string }).mime, bytes: png.length, sha256: 'x', filename: 'still.mp4', duration_ms: null, width: 1, height: 1 } };
    throw new Error(`unexpected ${name}`);
  } }) as unknown as HubApi;
  const handler = createMediaUploadHandler({ api, policy: { homeDir: root } });
  const call = { notify: () => undefined };
  const text = await handler.handle({ path: join(root, 'Movies', 'notes.mp4') }, call);
  assert.equal(text.isError, true);
  assert.equal((text.structuredContent.error as { code: string }).code, 'UPLOAD_TYPE_UNSUPPORTED');
  const image = await handler.handle({ path: join(root, 'Movies', 'still.mp4') }, call);
  assert.equal(image.isError, undefined);
  assert.equal(image.structuredContent.mime, 'image/png');
  assert.equal(image.structuredContent.kind, 'image');
  assert.equal(image.structuredContent.deduplicated, true);
  assert.deepEqual(JSON.parse(image.content[0].text), image.structuredContent);
  // Strict arguments (§7.2.5, additionalProperties false) and wait_seconds bounds.
  const unknown = await handler.handle({ path: '/x/y.mp4', file: 'z' }, call);
  assert.deepEqual(unknown.structuredContent, { error: { code: 'INVALID_ARGUMENTS', message: "media_upload has an unknown field 'file'. Allowed: path, title, wait_seconds.",
    issues: [{ path: 'file', code: 'unrecognized_keys', allowed: ['path', 'title', 'wait_seconds'] }] } });
  assert.equal(((await handler.handle({ path: '/x/y.mp4', wait_seconds: 51 }, call)).structuredContent.error as { code: string }).code, 'INVALID_ARGUMENTS');
  assert.equal(((await handler.handle({}, call)).structuredContent.error as { code: string }).code, 'INVALID_ARGUMENTS');
  const relative = await handler.handle({ path: 'video.mp4' }, call);
  assert.deepEqual(relative.structuredContent.error, { code: 'PATH_NOT_ABSOLUTE', message: PATH_NOT_ABSOLUTE_MESSAGE });
  assert.deepEqual(calls.filter(name => name !== 'config'), ['create']);
});
