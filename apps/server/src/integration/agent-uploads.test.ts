import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { Row } from '@smartsell/contracts';
import { fakeMp4, sha256, startHub, type Hub } from '../../../../packages/agent-relay/test/fixtures/hub.ts';
import { localStorage, probeMedia, type Probe, type Storage } from '../../../../packages/media-store/src/index.ts';
import { openMediaRange, prepareAssembledObject, recordAssembledObject } from '../extensions/media-files.ts';
import { AGENT_UPLOAD_CHUNK_BYTES, expireAgentUploads, mediaUploadProgress, stagingDirectory } from './agent-uploads.ts';

const MiB = AGENT_UPLOAD_CHUNK_BYTES;
const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const noProbe: Probe = async () => ({ width: 1080, height: 1920, duration_seconds: 21, video_codec: 'h264', audio_codec: 'aac' });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function create(hub: Hub, bytes: Buffer, extra: Record<string, unknown> = {}) {
  const response = await hub.api('POST', '/api/v1/agent/uploads', { filename: 'video.mp4', bytes: bytes.length, sha256: sha256(bytes), mime: 'video/mp4', ...extra });
  assert.ok(response.status === 201 || response.status === 200, JSON.stringify(response.body));
  return response.body;
}

async function putPart(hub: Hub, id: string, bytes: Buffer, n: number, k: number, digest?: string) {
  const part = bytes.subarray(n * MiB, Math.min(bytes.length, (n + k) * MiB));
  return hub.api('PUT', `/api/v1/agent/uploads/${id}/parts/${n}`, new Uint8Array(part),
    { 'content-type': 'application/octet-stream', 'x-part-sha256': digest ?? sha256(part) });
}

async function sendAll(hub: Hub, id: string, bytes: Buffer, k = 4) {
  const chunks = Math.ceil(bytes.length / MiB);
  for (let n = 0; n < chunks; n += k) {
    const response = await putPart(hub, id, bytes, n, Math.min(k, chunks - n));
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
}

async function waitFor(hub: Hub, id: string, statuses: string[] = ['ready', 'failed']) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { body } = await hub.api('GET', `/api/v1/agent/uploads/${id}`);
    if (statuses.includes(body.status)) return body;
    await sleep(25);
  }
  throw new Error('upload did not settle');
}

const find = (rows: Row[], id: unknown) => rows.find(row => row.id === id)!;

test('config and every upload route require the agent token; JSON bodies are strict', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const anonymous = await fetch(`${hub.origin}/api/v1/agent/uploads/config`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await anonymous.json()).error.code, 'UNAUTHENTICATED');
  const config = await hub.api('GET', '/api/v1/agent/uploads/config');
  assert.deepEqual(config.body, { max_upload_bytes: 512 * MiB, chunk_bytes: MiB, max_chunks_per_part: 8,
    accepted_mime: ['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'] });
  const unknown = await hub.api('POST', '/api/v1/agent/uploads', { filename: 'a.mp4', bytes: 10, sha256: 'a'.repeat(64), mime: 'video/mp4', desc: 'x' });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error.code, 'INVALID_ARGUMENTS');
  assert.deepEqual(unknown.body.error.issues, [{ path: 'desc', code: 'unrecognized_keys', allowed: ['filename', 'bytes', 'sha256', 'mime', 'title'] }]);
  const large = await hub.api('POST', '/api/v1/agent/uploads', { filename: 'a.mp4', bytes: 513 * MiB, sha256: 'a'.repeat(64), mime: 'video/mp4' });
  assert.equal(large.body.error.code, 'UPLOAD_TOO_LARGE');
  const type = await hub.api('POST', '/api/v1/agent/uploads', { filename: 'a.txt', bytes: 10, sha256: 'a'.repeat(64), mime: 'text/plain' });
  assert.equal(type.body.error.code, 'UPLOAD_TYPE_UNSUPPORTED');
  // The root guard still rejects a non-JSON POST, but lets the octet-stream PUT through.
  const form = await fetch(`${hub.origin}/api/v1/agent/uploads`, { method: 'POST', headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(form.status, 415);
});

test('creating an upload gives a media_id at once; parts are hash-checked, stored outside the store, and assembled into a ready asset', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const bytes = fakeMp4(5 * MiB + 1234);
  const created = await create(hub, bytes, { title: 'Spring lure' });
  assert.equal(created.status, 'receiving');
  assert.equal(created.chunks, 6);
  assert.deepEqual(created.received, []);
  const [asset] = await hub.rows('asset');
  assert.equal(asset.id, created.media_id);
  assert.deepEqual([asset.status, asset.ownership, asset.origin, asset.brand_id, asset.title, asset.kind], ['uploading', 'owned', 'agent_upload', null, 'Spring lure', 'video']);
  const [version] = await hub.rows('asset_version');
  assert.deepEqual([version.file_object_id, version.sha256, version.mime_type], [null, sha256(bytes), 'video/mp4']);

  // Wrong part hash and wrong part length are refused without recording anything.
  const mismatch = await putPart(hub, created.upload_id, bytes, 0, 2, 'b'.repeat(64));
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.error.code, 'UPLOAD_PART_HASH_MISMATCH');
  const short = await hub.api('PUT', `/api/v1/agent/uploads/${created.upload_id}/parts/0`, new Uint8Array(bytes.subarray(0, MiB + 10)),
    { 'content-type': 'application/octet-stream', 'x-part-sha256': sha256(bytes.subarray(0, MiB + 10)) });
  assert.equal(short.status, 422);
  const nine = await hub.api('PUT', `/api/v1/agent/uploads/${created.upload_id}/parts/0`, new Uint8Array(9 * MiB), { 'content-type': 'application/octet-stream', 'x-part-sha256': 'c'.repeat(64) });
  assert.equal(nine.status, 413);
  assert.deepEqual((await hub.api('GET', `/api/v1/agent/uploads/${created.upload_id}`)).body.received, []);

  // Incomplete uploads cannot complete.
  assert.equal((await putPart(hub, created.upload_id, bytes, 0, 2)).status, 200);
  const early = await hub.api('POST', `/api/v1/agent/uploads/${created.upload_id}/complete`, {});
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'UPLOAD_INCOMPLETE');
  // Same upload again resumes with the received list.
  const resumed = await create(hub, bytes);
  assert.equal(resumed.upload_id, created.upload_id);
  assert.deepEqual(resumed.received, [0, 1]);
  assert.equal(resumed.bytes_received, 2 * MiB);
  const progress = await hub.principal.run(false, ctx => mediaUploadProgress(ctx, created.media_id));
  assert.deepEqual([progress?.status, progress?.bytes, progress?.bytes_received], ['receiving', bytes.length, 2 * MiB]);

  assert.equal((await putPart(hub, created.upload_id, bytes, 2, 3)).status, 200);
  const last = await putPart(hub, created.upload_id, bytes, 5, 1);
  assert.deepEqual(last.body.received, [0, 1, 2, 3, 4, 5]);
  const staged = await readdir(stagingDirectory(hub.mediaDirectory, created.upload_id));
  assert.deepEqual(staged.sort(), ['0-2.part', '2-3.part', '5-1.part']);

  const complete = await hub.api('POST', `/api/v1/agent/uploads/${created.upload_id}/complete`, {});
  assert.equal(complete.status, 202);
  assert.equal(complete.body.status, 'assembling');
  const done = await waitFor(hub, created.upload_id);
  assert.equal(done.status, 'ready', JSON.stringify(done));
  assert.equal(done.media.duration_ms, 21000);
  assert.equal(done.media.width, 1080);

  // asset_version gets file_object_id, mime_type and meta only at completion (§3.8).
  const [file] = await hub.rows('file_object');
  const [readyVersion] = await hub.rows('asset_version');
  const [readyAsset] = await hub.rows('asset');
  assert.equal(readyVersion.file_object_id, file.id);
  assert.equal(readyVersion.mime_type, 'video/mp4');
  assert.deepEqual(readyVersion.meta, { duration_ms: 21000, width: 1080, height: 1920, codec: 'h264', has_audio: true });
  assert.equal(readyAsset.status, 'ready');
  assert.deepEqual([file.sha256, file.size_bytes, file.purpose, file.scan_status], [sha256(bytes), bytes.length, 'asset', 'skipped']);
  const stored = await openMediaRange(hub.storage, { storage_key: String(file.storage_key), byte_size: bytes.length });
  const chunks: Buffer[] = [];
  for await (const chunk of stored.stream) chunks.push(chunk as Buffer);
  assert.equal(sha256(Buffer.concat(chunks)), sha256(bytes));
  assert.equal(existsSync(stagingDirectory(hub.mediaDirectory, created.upload_id)), false, 'staging is removed');
  const types = (await hub.events()).map(event => event.type);
  for (const type of ['media.upload.started', 'core.file_object.created', 'asset.version.created', 'asset.asset.ready', 'media.upload.ready']) assert.ok(types.includes(type), type);
  const versionEvent = (await hub.events()).find(event => event.type === 'asset.version.created')!;
  assert.deepEqual(versionEvent.payload, { asset_id: created.media_id, asset_version_id: readyVersion.id, version_no: 1, source: 'agent_upload' });
  // upload_done comes from S10's subscriber on asset.version.created, not from this transaction.
  assert.equal((await hub.alerts()).length, 0);
  // Parts after completion are refused.
  assert.equal((await putPart(hub, created.upload_id, bytes, 0, 1)).status, 409);
});

test('a whole-file SHA-256 mismatch fails the asset and tells the owner; abort marks the file changed', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const bytes = fakeMp4(3 * MiB);
  const other = fakeMp4(3 * MiB, 7);
  // Declare the hash of other bytes; every part hash is still correct.
  const created = (await hub.api('POST', '/api/v1/agent/uploads', { filename: 'clip.mp4', bytes: bytes.length, sha256: sha256(other), mime: 'video/mp4' })).body;
  await sendAll(hub, created.upload_id, bytes);
  await hub.api('POST', `/api/v1/agent/uploads/${created.upload_id}/complete`, {});
  const failed = await waitFor(hub, created.upload_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'UPLOAD_HASH_MISMATCH');
  assert.equal(find(await hub.rows('asset'), created.media_id).status, 'failed');
  assert.equal((await hub.rows('file_object')).length, 0);
  const hashAlert = (await hub.alerts()).at(-1)!;
  assert.deepEqual([hashAlert.kind, hashAlert.severity, hashAlert.dedupe_key], ['upload_failed', 'urgent', `upload_failed:${created.media_id}`]);
  assert.match(String(hashAlert.title), /clip\.mp4/);
  assert.equal(existsSync(stagingDirectory(hub.mediaDirectory, created.upload_id)), false);

  const second = await create(hub, other);
  await putPart(hub, second.upload_id, other, 0, 1);
  const aborted = await hub.api('POST', `/api/v1/agent/uploads/${second.upload_id}/abort`, { reason: 'file_changed' });
  assert.deepEqual(aborted.body, { status: 'failed' });
  const status = (await hub.api('GET', `/api/v1/agent/uploads/${second.upload_id}`)).body;
  assert.equal(status.error.code, 'FILE_CHANGED');
  assert.equal(find(await hub.rows('asset'), second.media_id).status, 'failed');
  const changedAlert = (await hub.alerts()).at(-1)!;
  assert.deepEqual([changedAlert.kind, changedAlert.dedupe_key], ['upload_failed', `upload_failed:${second.media_id}`]);
  assert.match(String(changedAlert.title), /改動/);
  assert.equal(existsSync(stagingDirectory(hub.mediaDirectory, second.upload_id)), false);
  const invalid = await hub.api('POST', `/api/v1/agent/uploads/${second.upload_id}/abort`, { reason: 'bored' });
  assert.equal(invalid.body.error.code, 'INVALID_ARGUMENTS');
});

test('expired sessions fail hourly with an owner alert and their staging is removed after the transaction', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const bytes = fakeMp4(2 * MiB);
  const created = await create(hub, bytes);
  await putPart(hub, created.upload_id, bytes, 0, 1);
  const directory = stagingDirectory(hub.mediaDirectory, created.upload_id);
  assert.equal(existsSync(directory), true);
  const early = await hub.write(ctx => expireAgentUploads(ctx, { mediaDirectory: hub.mediaDirectory }));
  assert.deepEqual(early.expired, []);
  const later = await hub.write(ctx => expireAgentUploads(ctx, { mediaDirectory: hub.mediaDirectory }, Date.now() + 25 * 3_600_000));
  assert.deepEqual(later.expired, [created.upload_id]);
  await sleep(50);
  assert.equal(existsSync(directory), false);
  const status = (await hub.api('GET', `/api/v1/agent/uploads/${created.upload_id}`)).body;
  assert.deepEqual([status.status, status.error.code], ['failed', 'UPLOAD_EXPIRED']);
  assert.equal(find(await hub.rows('asset'), created.media_id).status, 'failed');
  const expiredAlert = (await hub.alerts()).at(-1)!;
  assert.deepEqual([expiredAlert.kind, expiredAlert.severity, expiredAlert.dedupe_key], ['upload_failed', 'urgent', `upload_failed:${created.media_id}`]);
  assert.match(String(expiredAlert.title), /24 小時/);
});

test('SHA-256 dedupe returns only an owned, ready asset; a brand asset with the same bytes is not handed back', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const bytes = fakeMp4(MiB + 5);
  const digest = sha256(bytes);
  // A licensed brand asset with identical bytes (ownership not 'owned').
  await hub.write(ctx => {
    const file = ctx.create('file_object', { tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId, sha256: digest, size_bytes: bytes.length,
      mime_type: 'video/mp4', purpose: 'asset', scan_status: 'clean', deleted_at: null, storage_key: 'unused', object_nonce: 'unused', bucket: 'local' });
    const asset = ctx.create('asset', { kind: 'video', title: 'Brand clip', brand_id: 'brand-1', status: 'ready', origin: 'upload', current_version_id: null });
    const version = ctx.create('asset_version', { asset_id: asset.id, version_no: 1, file_object_id: file.id, sha256: digest, mime_type: 'video/mp4', meta: {} });
    ctx.update('asset', asset.id, { current_version_id: version.id });
  });
  const first = await create(hub, bytes);
  assert.equal(first.status, 'receiving', 'the brand asset is not reused');
  assert.equal(first.deduplicated, false);
  await sendAll(hub, first.upload_id, bytes);
  await hub.api('POST', `/api/v1/agent/uploads/${first.upload_id}/complete`, {});
  assert.equal((await waitFor(hub, first.upload_id)).status, 'ready');
  const again = await hub.api('POST', '/api/v1/agent/uploads', { filename: 'copy.mp4', bytes: bytes.length, sha256: digest, mime: 'video/mp4' });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.status, again.body.deduplicated, again.body.media_id, again.body.upload_id], ['ready', true, first.media_id, null]);
  assert.equal(again.body.media.duration_ms, 21000);
  assert.equal((await hub.rows('media_upload_session')).length, 1);
});

test('assembly, the storage write and ffprobe hold no store transaction: heartbeats stay under 1 s', async t => {
  // A slow ffprobe (2.5 s) and a slow storage write (1.5 s) stand in for a 1 GB file. SQLite-backed store as on the hub.
  const slowProbe: Probe = async () => { await sleep(2500); return { width: 720, height: 1280, duration_seconds: 9, video_codec: 'h264' }; };
  const slowStorage = (storage: Storage): Storage => ({ bucket: storage.bucket, read: storage.read, remove: storage.remove,
    async write(key, object) { await sleep(1500); await storage.write(key, object); } });
  const hub = await startHub(t, { store: 'local', prepare: { probe: slowProbe }, storage: slowStorage });
  const bytes = fakeMp4(48 * MiB);
  const created = await create(hub, bytes);
  await sendAll(hub, created.upload_id, bytes, 8);

  async function heartbeats(until: () => Promise<boolean>) {
    const latencies: number[] = [];
    while (!(await until())) {
      const started = performance.now();
      await hub.write(ctx => ctx.create('heartbeat_probe', { at: ctx.now }));
      latencies.push(performance.now() - started);
      await sleep(50);
    }
    return latencies;
  }
  const started = performance.now();
  await hub.api('POST', `/api/v1/agent/uploads/${created.upload_id}/complete`, {});
  let settled = false;
  const watcher = waitFor(hub, created.upload_id).then(value => { settled = true; return value; });
  const latencies = await heartbeats(async () => settled);
  const elapsed = performance.now() - started;
  assert.equal((await watcher).status, 'ready');
  assert.ok(elapsed >= 4000, `processing took ${elapsed} ms, long enough to matter`);
  assert.ok(latencies.length >= 20, `${latencies.length} heartbeats sampled`);
  assert.ok(Math.max(...latencies) < 1000, `slowest heartbeat ${Math.max(...latencies)} ms`);

  // Control: the same probe inside a transaction does stall a heartbeat, so the measurement can see it.
  const blocking = hub.principal.run(true, () => slowProbe('', 'video/mp4'));
  await sleep(50);
  const before = performance.now();
  await hub.write(ctx => ctx.create('heartbeat_probe', { at: ctx.now }));
  await blocking;
  assert.ok(performance.now() - before > 2000, 'a probe inside a transaction blocks heartbeats');
});

test('a missing ffprobe degrades to ready without metadata', async t => {
  const missing = await startHub(t, { prepare: { probe: (path, mime, options) => probeMedia(path, mime, { ...options, ffprobe: '/nonexistent/ffprobe' }) } });
  const bytes = fakeMp4(MiB + 77);
  const created = await create(missing, bytes);
  await sendAll(missing, created.upload_id, bytes);
  await missing.api('POST', `/api/v1/agent/uploads/${created.upload_id}/complete`, {});
  const done = await waitFor(missing, created.upload_id);
  assert.equal(done.status, 'ready');
  assert.equal(done.media.duration_ms, null);
  const [version] = await missing.rows('asset_version');
  assert.equal(version.meta, null);
  assert.ok(version.file_object_id);
  assert.equal((await missing.rows('media_upload_session'))[0].probe, 'unavailable');
});

test('a real QuickTime file passes ffprobe; the declared MIME is corrected from the bytes', { skip: !ffmpeg && 'ffmpeg/ffprobe not installed' }, async t => {
  const hub = await startHub(t);
  const path = join(hub.root, 'clip.mov');
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '1', '-c:v', 'mpeg4', path]);
  assert.equal(result.status, 0, String(result.stderr));
  const bytes = await readFile(path);
  // The relay sniffed wrongly on purpose: the hub reads the bytes again.
  const created = await create(hub, bytes, { filename: 'clip.mov', mime: 'video/mp4' });
  await sendAll(hub, created.upload_id, bytes);
  await hub.api('POST', `/api/v1/agent/uploads/${created.upload_id}/complete`, {});
  const done = await waitFor(hub, created.upload_id);
  assert.equal(done.status, 'ready', JSON.stringify(done));
  assert.deepEqual([done.media.mime, done.media.width, done.media.height, done.media.duration_ms], ['video/quicktime', 320, 240, 1000]);
  const [version] = await hub.rows('asset_version');
  assert.equal(version.mime_type, 'video/quicktime');
});

test('an accepted upload left assembling by a restart resumes on the next poll', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const bytes = fakeMp4(2 * MiB + 1);
  const created = await create(hub, bytes);
  await sendAll(hub, created.upload_id, bytes);
  // Simulate a hub that crashed after the "assembling" write and before its background job ran.
  await hub.write(ctx => ctx.update('media_upload_session', created.upload_id, { status: 'assembling' }));
  const done = await waitFor(hub, created.upload_id);
  assert.equal(done.status, 'ready');
});

test('prepareAssembledObject and recordAssembledObject split IO from the short write; openMediaRange serves byte ranges', async t => {
  const hub = await startHub(t);
  const bytes = fakeMp4(3 * MiB + 9);
  const created = await create(hub, bytes);
  const source = join(hub.root, 'assembled.bin');
  await writeFile(source, bytes);
  const ids = await hub.principal.run(false, ctx => ({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId }));
  const before = hub.transactions.count;
  const prepared = await prepareAssembledObject(hub.storage, { path: source, sha256: sha256(bytes), size: bytes.length, mime: 'video/mp4',
    filename: 'video.mp4', ...ids }, { probe: noProbe });
  assert.equal(hub.transactions.count, before, 'prepare opens no transaction');
  assert.equal(existsSync(source), false, 'local storage moved the file instead of copying');
  assert.equal(prepared.probe, 'ok');
  const [version] = await hub.rows('asset_version');
  const linked = await hub.write(ctx => recordAssembledObject(ctx, prepared, { asset_id: created.media_id, asset_version_id: version.id, createdBy: ctx.actorId }));
  assert.ok(linked.file_object_id);
  const again = await hub.write(ctx => recordAssembledObject(ctx, prepared, { asset_id: created.media_id, asset_version_id: version.id, createdBy: ctx.actorId }));
  assert.deepEqual([again.file_object_id, again.reused], [linked.file_object_id, true]);
  const object = { storage_key: prepared.storage_key, byte_size: bytes.length };
  const read = async (range?: { start: number; end: number }) => {
    const opened = await openMediaRange(hub.storage, object, range);
    const parts: Buffer[] = [];
    for await (const chunk of opened.stream) parts.push(chunk as Buffer);
    return { ...opened, bytes: Buffer.concat(parts) };
  };
  const middle = await read({ start: MiB - 3, end: 2 * MiB + 4 });
  assert.deepEqual([middle.start, middle.end, middle.size], [MiB - 3, 2 * MiB + 4, bytes.length]);
  assert.ok(middle.bytes.equals(bytes.subarray(MiB - 3, 2 * MiB + 5)));
  const tail = await read({ start: bytes.length - 10, end: bytes.length + 100 });
  assert.ok(tail.bytes.equals(bytes.subarray(bytes.length - 10)));
  assert.equal((await read()).bytes.length, bytes.length);
  await assert.rejects(read({ start: bytes.length, end: bytes.length + 1 }), { status: 416, code: 'RANGE_NOT_SATISFIABLE' });
  await assert.rejects(openMediaRange(hub.storage, { storage_key: prepared.storage_key, byte_size: bytes.length + 1 }), { code: 'MEDIA_UNAVAILABLE' });
  // Wrong workspace cannot link the prepared object.
  await assert.rejects(hub.write(ctx => recordAssembledObject({ ...ctx, workspaceId: 'other' }, prepared, { asset_id: created.media_id, asset_version_id: version.id, createdBy: 'x' })));
  // Bytes that are not an accepted type are refused before anything is stored.
  const text = join(hub.root, 'notes.bin');
  await writeFile(text, 'just some text that is not a video');
  await assert.rejects(prepareAssembledObject(localStorage(join(hub.root, 'x')), { path: text, sha256: sha256(Buffer.from('just some text that is not a video')),
    size: 34, mime: 'video/mp4', filename: 'notes.mp4', ...ids }, { probe: noProbe }), { code: 'UPLOAD_TYPE_UNSUPPORTED' });
});

test('GET /agent/relay.mjs serves the bundle with an ETag, or an explicit error when it is not built', async t => {
  const missing = await startHub(t, { relayBundlePath: '/nonexistent/smartsell-relay.mjs' });
  const absent = await fetch(`${missing.origin}/agent/relay.mjs`);
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).error.code, 'RELAY_BUNDLE_MISSING');
  const hub = await startHub(t);
  const path = join(hub.root, 'bundle', 'smartsell-relay.mjs');
  await mkdir(join(hub.root, 'bundle'));
  await writeFile(path, '#!/usr/bin/env node\nconsole.log("relay")\n');
  const served = await startHub(t, { relayBundlePath: path });
  const response = await fetch(`${served.origin}/agent/relay.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /javascript/);
  const etag = response.headers.get('etag')!;
  assert.equal(etag, `"${sha256(Buffer.from(await response.text()))}"`);
  const cached = await fetch(`${served.origin}/agent/relay.mjs`, { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);
});

test('part bodies stream to staging files; an aborted part leaves nothing recorded', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const bytes = fakeMp4(4 * MiB);
  const created = await create(hub, bytes);
  const controller = new AbortController();
  const slow = Readable.from((async function* () { yield bytes.subarray(0, MiB); await sleep(200); controller.abort(); yield bytes.subarray(MiB, 2 * MiB); })());
  await assert.rejects(fetch(`${hub.origin}/api/v1/agent/uploads/${created.upload_id}/parts/0`, { method: 'PUT', signal: controller.signal,
    headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/octet-stream', 'content-length': String(2 * MiB), 'x-part-sha256': sha256(bytes.subarray(0, 2 * MiB)) },
    body: Readable.toWeb(slow) as unknown as BodyInit, duplex: 'half' } as RequestInit));
  await sleep(200);
  const status = (await hub.api('GET', `/api/v1/agent/uploads/${created.upload_id}`)).body;
  assert.deepEqual(status.received, []);
  const leftovers = existsSync(stagingDirectory(hub.mediaDirectory, created.upload_id)) ? await readdir(stagingDirectory(hub.mediaDirectory, created.upload_id)) : [];
  assert.deepEqual(leftovers, []);
});
