import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeContext } from '../../apps/server/src/context.ts';
import { attachMediaEvidence, createMediaFiles, registerMediaFiles } from '../../apps/server/src/extensions/media-files.ts';
import { fileStore } from '../../packages/db/src/index.ts';
import { INLINE_BYTES, localStorage, makeThumbnail, ObjectMissing, s3Storage } from '../../packages/media-store/src/index.ts';

const Fastify = createRequire(new URL('../../apps/server/package.json', import.meta.url))('fastify');
const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const spec = (bytes, purpose = 'asset', mime_type = 'text/plain') => ({ size_bytes: bytes.length, sha256: sha(bytes), purpose, mime_type });
const workspacePath = '/api/v1/workspaces';
const actor = { workspaceId: 'shop', tenantId: 'tenant-a', actorId: 'owner-1', role: 'owner' };
const members = {
  owner: actor,
  editor: { ...actor, actorId: 'editor-1', role: 'editor' },
  viewer: { ...actor, actorId: 'viewer-1', role: 'viewer' },
  other: { ...actor, tenantId: 'tenant-b' },
  'other-workspace': { ...actor, workspaceId: 'other-shop' },
};

async function fixture(t, adapter = storage => storage) {
  const root = await mkdtemp(join(tmpdir(), 'smartsell-media-tests-'));
  const store = await fileStore(join(root, 'db.json'));
  const storage = adapter(localStorage(join(root, 'objects')));
  const media = createMediaFiles({ storage, signingKey: randomBytes(32) });
  const app = Fastify({ disableRequestLogging: true });
  let offset = 0;
  function run(scope, write, fn) {
    return store.transaction({ readOnly: !write }, async tx => {
      const ctx = makeContext(await tx.workspace(scope), scope, scope.role);
      ctx.now = new Date(Date.now() + offset).toISOString();
      return fn(ctx);
    });
  }
  registerMediaFiles(app, media, { workspace(request, ws, write, fn) {
    const scope = members[request.headers['x-test-member']];
    if (!scope || scope.workspaceId !== ws) throw Object.assign(new Error(), { status: 404 });
    if (write && request.headers['x-test-csrf'] !== 'yes') throw Object.assign(new Error(), { status: 403 });
    return run(scope, write, fn);
  } }, { mountOperations: true });
  t.after(async () => { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  function call(method, path, { member = 'owner', body, bytes, headers, ws = 'shop', csrf = true } = {}) {
    const target = path.startsWith(workspacePath) ? path : `${workspacePath}/${ws}/files${path}`;
    return fetch(`${origin}${target}`, { method, headers: { 'x-test-member': member, ...(csrf && { 'x-test-csrf': 'yes' }),
      ...(body && { 'content-type': 'application/json' }), ...(bytes && { 'content-type': 'application/octet-stream' }), ...headers },
    body: bytes ?? (body && JSON.stringify(body)) });
  }
  async function json(response, expected = 200) {
    const res = await response;
    const out = await res.json();
    assert.equal(res.status, expected, out.error?.message);
    return out.data;
  }
  async function upload(bytes, purpose = 'asset', mime, member = 'owner') {
    const ticket = await json(call('POST', '/uploads', { body: spec(bytes, purpose, mime), member }));
    return json(call('POST', `/uploads/${ticket.id}/complete`, { body: { base64: bytes.toString('base64') }, member }));
  }
  return { root, run, call, json, upload, media, storage, advance(ms) { offset += ms; } };
}

test('real HTTP checks integrity before create, binds downloads to scope and actor, supports byte ranges, meters once', async t => {
  const { call, json, run, advance } = await fixture(t);
  const bytes = Buffer.from('verified bytes\n');
  await json(call('POST', '/uploads', { body: spec(bytes), csrf: false }), 403);
  await json(call('POST', '/uploads', { body: spec(bytes), member: 'viewer' }), 403);
  const ticket = await json(call('POST', '/uploads', { body: { ...spec(bytes), storage_key: 'ignored' } }));
  await json(call('PUT', `/uploads/${ticket.id}/bytes`, { bytes: bytes.subarray(1) }), 422);
  await json(call('POST', `/uploads/${ticket.id}/complete`, { body: { base64: Buffer.alloc(bytes.length).toString('base64') } }), 422);
  await run(actor, false, ctx => { assert.equal(ctx.list('file_object').length, 0); assert.equal(ctx.list('usage_event').length, 0); });
  await json(call('PUT', `/uploads/${ticket.id}/bytes`, { bytes, member: 'editor' }), 404);
  await json(call('PUT', `/uploads/${ticket.id}/bytes`, { bytes }));
  const file = await json(call('POST', `/uploads/${ticket.id}/complete`, { body: {} }));
  assert.equal(file.sha256, sha(bytes));
  assert.equal(file.storage_key, undefined);
  assert.equal((await json(call('POST', `/uploads/${ticket.id}/complete`, { body: {} }))).id, file.id);
  const link = await json(call('GET', `/${file.id}/download?inline=true`, { member: 'viewer' }));
  await json(call('GET', link.url, { member: 'unrecognized' }), 404);
  await json(call('GET', link.url, { member: 'owner' }), 404);
  await json(call('GET', `/${file.id}/download`, { member: 'other' }), 404);
  await json(call('GET', `/${file.id}/download`, { member: 'other-workspace', ws: 'other-shop' }), 404);
  const full = await call('GET', link.url, { member: 'viewer' });
  assert.equal(full.status, 200);
  assert.match(full.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const partial = await call('GET', link.url, { member: 'viewer', headers: { range: 'bytes=1-4' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 1-4/${bytes.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(1, 5));
  const badRange = await call('GET', link.url, { member: 'viewer', headers: { range: 'bytes=300-400' } });
  assert.equal(badRange.status, 416);
  assert.equal(badRange.headers.get('content-range'), `bytes */${bytes.length}`);
  await badRange.json();
  advance(121_000);
  await json(call('GET', link.url, { member: 'viewer' }), 404);
  await json(call('DELETE', `/${file.id}`, { member: 'editor' }), 403);
  const next = await json(call('GET', `/${file.id}/download`));
  await json(call('DELETE', `/${file.id}`));
  await json(call('DELETE', `/${file.id}`));
  await json(call('GET', next.url), 404);
  await run(actor, false, ctx => assert.deepEqual(ctx.list('usage_event').map(row => row.quantity), [bytes.length, -bytes.length]));
});

test('a file above the inline limit can be streamed to local storage', async t => {
  const { call, json } = await fixture(t);
  const bytes = Buffer.alloc(2 * INLINE_BYTES + 1, 0x61);
  const ticket = await json(call('POST', '/uploads', { body: spec(bytes) }));
  await json(call('POST', `/uploads/${ticket.id}/complete`, { body: { base64: 'YQ==' } }), 413);
  await json(call('PUT', `/uploads/${ticket.id}/bytes`, { bytes: bytes.subarray(0, 1), csrf: false }), 403);
  await json(call('PUT', `/uploads/${ticket.id}/bytes`, { bytes }));
  const file = await json(call('POST', `/uploads/${ticket.id}/complete`, { body: {} }));
  assert.equal(file.size_bytes, bytes.length);
  const { url } = await json(call('GET', `/${file.id}/download`));
  const suffix = await call('GET', url, { headers: { range: 'bytes=-8' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-8));
});

test('retention rechecks references and cleanup retries adapter failures', async t => {
  let fail = true;
  const { run, call, json, upload, advance, storage } = await fixture(t, local => ({ ...local, async remove(key) {
    if (fail) throw new Error('backend offline');
    await local.remove(key);
  } }));
  const bytes = Buffer.from('evidence bytes');
  const file = await upload(bytes, 'evidence', undefined, 'editor');
  await json(call('GET', `/${file.id}/download`, { member: 'viewer' }), 404);
  const ids = await run(members.editor, true, ctx => {
    const post = ctx.create('platform_post', {});
    const evidence = attachMediaEvidence(ctx, file.id, { kind: 'platform_post', id: post.id });
    assert.equal(evidence.content_hash, sha(bytes));
    assert.equal(attachMediaEvidence(ctx, file.id, { kind: 'platform_post', id: post.id }).id, evidence.id);
    return { post: post.id, evidence: evidence.id };
  });
  await json(call('DELETE', `/${file.id}`), 409);
  assert.deepEqual((await json(call('GET', '/retention/preview'))).candidates, []);
  await run(actor, true, ctx => {
    ctx.remove('platform_post', ids.post);
    ctx.create('rights_grant', { evidence_id: ids.evidence });
  });
  const { candidates: [blocked] } = await json(call('GET', '/retention/preview'));
  assert.deepEqual(blocked.blocked_by, ['rights_grant']);
  assert.deepEqual((await json(call('POST', '/retention/purge', { body: { files: [blocked] } }))).skipped, [file.id]);
  const key = await run(actor, true, ctx => {
    ctx.remove('rights_grant', ctx.list('rights_grant')[0].id);
    return ctx.get('file_object', file.id).storage_key;
  });
  const { candidates: [preview] } = await json(call('GET', '/retention/preview'));
  assert.deepEqual((await json(call('POST', '/retention/purge', { body: { files: [preview] } }))).deleted, [file.id]);
  assert.equal((await json(call('POST', '/cleanup', { body: {} }))).failed, 1);
  const object = await storage.read(key);
  assert.equal(object.size, bytes.length);
  object.stream.destroy();
  fail = false;
  advance(21 * 60_000);
  assert.equal((await json(call('POST', '/cleanup', { body: {} }))).cleaned, 2);
  await assert.rejects(storage.read(key));
  await run(actor, false, ctx => {
    assert.equal(ctx.list('file_upload').length, 0);
    assert.ok(ctx.get('file_object', file.id).storage_deleted_at);
    assert.ok(ctx.get('evidence', ids.evidence).deleted_at);
  });
});

test('a failed database transaction leaves an expired upload recoverable without charging storage', async t => {
  const { run, call, json, media, storage, advance } = await fixture(t, local => ({ ...local, async remove(key) {
    if (key.includes('/staging/')) throw new ObjectMissing();
    await local.remove(key);
  } }));
  const bytes = Buffer.from('recoverable snapshot');
  const ticket = await json(call('POST', '/uploads', { body: spec(bytes) }));
  const key = await run(actor, false, ctx => ctx.get('file_upload', ticket.id).storage_key);
  await assert.rejects(run(actor, true, async ctx => {
    await media.complete(ctx, ticket.id, bytes.toString('base64'));
    throw new Error('simulated transaction rollback');
  }), { message: 'simulated transaction rollback' });
  await run(actor, false, ctx => {
    assert.equal(ctx.list('file_object').length, 0);
    assert.equal(ctx.list('usage_event').length, 0);
  });
  (await storage.read(key)).stream.destroy();
  advance(21 * 60_000);
  assert.equal((await json(call('POST', '/cleanup', { body: {} }))).cleaned, 1);
  await assert.rejects(storage.read(key));
});

test('bounded snapshots reject forged MIME and support real video metadata, playback ranges and worker thumbnails', { skip: !ffmpeg }, async t => {
  const { root, run, media, call, json, upload } = await fixture(t);
  const videoPath = join(root, 'video.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:d=2', '-c:v', 'libx264', '-movflags', '+faststart', videoPath]);
  const video = await readFile(videoPath);
  const bad = await json(call('POST', '/uploads', { body: spec(video, 'asset', 'image/png') }));
  await json(call('POST', `/uploads/${bad.id}/complete`, { body: { base64: video.toString('base64') } }), 422);
  const file = await upload(video, 'asset', 'video/mp4');
  assert.deepEqual(file.meta, { width: 96, height: 64, video_codec: 'h264', duration_seconds: 2 });
  const { url } = await json(call('GET', `/${file.id}/download?inline=true`));
  const end = Math.floor(video.length / 2) - 1;
  const first = await call('GET', url, { headers: { range: `bytes=0-${end}` } });
  const rest = await call('GET', url, { headers: { range: `bytes=${end + 1}-` } });
  assert.equal(first.status, 206);
  assert.equal(rest.status, 206);
  assert.equal(first.headers.get('content-type'), 'video/mp4');
  assert.match(first.headers.get('content-disposition'), /^inline/);
  const played = Buffer.concat([Buffer.from(await first.arrayBuffer()), Buffer.from(await rest.arrayBuffer())]);
  assert.deepEqual(played, video);
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', 'pipe:0', '-f', 'null', '-'], { input: played });
  const jpeg = await run(actor, false, ctx => media.withMediaSource(ctx, file.id, makeThumbnail));
  const thumb = await upload(jpeg, 'asset', 'image/jpeg');
  assert.equal(thumb.meta.width, 320);
});

test('S3 transport can be substituted and rejects a malformed range response', async () => {
  const storage = s3Storage({ endpoint: 'http://localhost:9000', bucket: 'test-media', accessKey: 'offline', secretKey: 'offline',
    transport: async (url, request) => {
      assert.equal(url.pathname.split('/')[1], 'test-media');
      assert.equal(request.headers.range, 'bytes=1-2');
      assert.ok(request.headers.authorization.startsWith('AWS4-HMAC-SHA256'));
      return new Response('xx', { status: 206, headers: { 'content-length': '2', 'content-range': 'bytes 2-3/4' } });
    } });
  assert.throws(() => storage.presignUpload('t/t/w/staging/objects/11111111-1111-1111-1111-111111111111', 4, 60), { message: 'Invalid S3 upload signature parameters' });
  await assert.rejects(storage.read('t/t/w/w/objects/11111111-1111-1111-1111-111111111111', { start: 1, end: 2 }), { message: 'Invalid S3 response' });
});

test('isolated MinIO presigned staging verifies exact length and cannot overwrite a published object', { skip: !process.env.MEDIA_TEST_S3_ENDPOINT }, async t => {
  const { call, json, advance } = await fixture(t, () => s3Storage({ endpoint: process.env.MEDIA_TEST_S3_ENDPOINT,
    bucket: process.env.MEDIA_TEST_S3_BUCKET, accessKey: process.env.MEDIA_TEST_S3_ACCESS_KEY, secretKey: process.env.MEDIA_TEST_S3_SECRET_KEY }));
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const ticket = await json(call('POST', '/uploads', { body: spec(bytes) }));
  const signed = await json(call('GET', `/uploads/${ticket.id}/direct`));
  const put = body => fetch(signed.url, { method: signed.method, headers: signed.headers, body, redirect: 'error' });
  const oversized = await put(bytes.subarray(1));
  assert.equal(oversized.status >= 400, true);
  await oversized.body?.cancel();
  const wrongHash = await put(Buffer.alloc(bytes.length, 0x62));
  assert.equal(wrongHash.status, 200);
  await json(call('POST', `/uploads/${ticket.id}/complete`, { body: {} }), 422);
  const staged = await put(bytes);
  assert.equal(staged.status, 200);
  const file = await json(call('POST', `/uploads/${ticket.id}/complete`, { body: {} }));
  const replay = await put(Buffer.alloc(bytes.length, 0x62));
  assert.equal(replay.status, 200);
  const { url } = await json(call('GET', `/${file.id}/download`));
  const result = await call('GET', url, { headers: { range: 'bytes=0-7' } });
  assert.equal(result.status, 206);
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes.subarray(0, 8));
  await json(call('DELETE', `/${file.id}`));
  advance(21 * 60_000);
  assert.equal((await json(call('POST', '/cleanup', { body: {} }))).cleaned, 2);
});
