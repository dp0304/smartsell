// §10.1 S9: upload hand-off IPC (C12) — only a path and SHA-256 that match an existing hub session are continued.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  continueUpload as relayContinueUpload, createHandoffClient, createHubApi, createMediaUploadHandler, type ContinueUploadOptions, type UploadSessionView,
} from '../../../packages/agent-relay/src/index.ts';
import { fakeMp4, sha256 as digest, startHub } from '../../../packages/agent-relay/test/fixtures/hub.ts';
import { UploadHandoff, type UploadHandoffOptions } from '../../../apps/connector-desktop/src/app/upload-handoff.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function setup(t: { after(fn: () => unknown): void }) {
  // Short path: unix socket paths are limited to ~104 bytes on macOS.
  const root = mkdtempSync(join(tmpdir(), 'ssh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const data = join(root, 'ar');
  mkdirSync(join(home, 'Movies'), { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(4096, 7)]);
  const video = join(home, 'Movies', 'video.mp4');
  writeFileSync(video, bytes);
  const secret = join(home, '.ssh', 'video.mp4');
  writeFileSync(secret, bytes);
  const uploadId = randomUUID();
  const sessions = new Map<string, UploadSessionView>([[uploadId, {
    upload_id: uploadId, media_id: randomUUID(), status: 'receiving', chunk_bytes: 1024 * 1024, chunks: 1, received: [], bytes_received: 0,
    expires_at: null, bytes: bytes.length, sha256: sha(bytes), mime: 'video/mp4', filename: 'video.mp4',
  }]]);
  const continued: ContinueUploadOptions[] = [];
  let finish!: (value: { status: 'ready' | 'processing' | 'failed'; error?: string }) => void;
  const holds: [string, boolean][] = [];
  const handoff = new UploadHandoff({
    socketPath: join(data, 'ipc.sock'), dataDir: data, homeDir: home,
    credentials: async () => ({ hubOrigin: 'https://hub.tail1234.ts.net', token: `ss_command_${'b'.repeat(64)}` }),
    session: async (_credentials, id) => { const found = sessions.get(id); if (!found) throw new Error('UPLOAD_NOT_FOUND'); return found; },
    continueUpload: async options => {
      continued.push(options);
      options.onProgress?.(2048);
      return new Promise(resolve => { finish = resolve; });
    },
    hold: (reason, on) => holds.push([reason, on]),
  });
  const info = statSync(video);
  const message = { type: 'handoff' as const, upload_id: uploadId, path: video, sha256: sha(bytes), bytes: bytes.length, mtime_ms: info.mtimeMs };
  return { handoff, message, continued, holds, sessions, secret, video, finish: (value: Parameters<typeof finish>[0]) => finish(value) };
}

test('IPC: the relay hands off over the socket; a matching session is continued once and holds the sleep blocker', async t => {
  const ctx = setup(t);
  await ctx.handoff.start();
  t.after(() => ctx.handoff.stop());
  const client = createHandoffClient(join(ctx.message.path, '..', '..', '..', 'ar', 'ipc.sock'));
  assert.equal(await client.handoff(ctx.message), true);
  assert.equal(ctx.continued.length, 1);
  assert.equal(ctx.continued[0].uploadId, ctx.message.upload_id);
  assert.equal(ctx.continued[0].sha256, ctx.message.sha256);
  assert.deepEqual(ctx.holds, [[`upload:${ctx.message.upload_id}`, true]]);
  assert.equal(ctx.handoff.uploads()[0].received, 2048);
  // The relay asks again before resuming the same upload: yes, without a second upload.
  assert.equal(await client.handoff(ctx.message), true);
  assert.equal(ctx.continued.length, 1);
  ctx.finish({ status: 'ready' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ctx.handoff.uploads()[0].status, 'ready');
  assert.deepEqual(ctx.holds.at(-1), [`upload:${ctx.message.upload_id}`, false], 'blocker released when the upload ends');
  // Malformed messages are refused by the server before accept() runs.
  assert.equal(await client.handoff({ ...ctx.message, extra: 1 } as never), false);
});

test('refuses: different SHA-256, different size, changed file, unknown session, finished session, forbidden path', async t => {
  const ctx = setup(t);
  assert.equal(await ctx.handoff.accept({ ...ctx.message, sha256: 'c'.repeat(64) }), false, 'SHA-256 differs from the session');
  assert.equal(await ctx.handoff.accept({ ...ctx.message, bytes: ctx.message.bytes + 1 }), false, 'size differs from the file');
  assert.equal(await ctx.handoff.accept({ ...ctx.message, mtime_ms: ctx.message.mtime_ms - 5000 }), false, 'file modified since the relay hashed it');
  assert.equal(await ctx.handoff.accept({ ...ctx.message, upload_id: randomUUID() }), false, 'no such session');
  assert.equal(await ctx.handoff.accept({ ...ctx.message, path: ctx.secret }), false, '~/.ssh is never read');
  assert.equal(await ctx.handoff.accept({ ...ctx.message, path: 'relative/video.mp4' }), false);
  ctx.sessions.set(ctx.message.upload_id, { ...ctx.sessions.get(ctx.message.upload_id)!, status: 'ready' });
  assert.equal(await ctx.handoff.accept(ctx.message), false, 'a ready session needs no hand-off');
  assert.equal(ctx.continued.length, 0, 'nothing was uploaded for any refused request');
});

test('a renamed file is accepted only when its bytes hash to the session SHA-256', async t => {
  const ctx = setup(t);
  ctx.sessions.set(ctx.message.upload_id, { ...ctx.sessions.get(ctx.message.upload_id)!, filename: 'renamed.mp4' });
  assert.equal(await ctx.handoff.accept(ctx.message), true, 'same bytes under another name');
  const other = setup(t);
  other.sessions.set(other.message.upload_id, { ...other.sessions.get(other.message.upload_id)!, filename: 'renamed.mp4', sha256: 'd'.repeat(64) });
  assert.equal(await other.handoff.accept({ ...other.message, sha256: 'd'.repeat(64) }), false, 'different bytes under another name');
  // keep the file's mtime stable for the assertion above
  utimesSync(other.video, new Date(), new Date(other.message.mtime_ms));
});

test('without a stored connection the App refuses every hand-off', async t => {
  const ctx = setup(t);
  const handoff = new UploadHandoff({ socketPath: join(tmpdir(), 'unused.sock'), dataDir: tmpdir(), credentials: async () => null });
  assert.equal(await handoff.accept(ctx.message), false);
});

// ---------- Wave 6 (G6): MCP-2 / MCP-3, the App side ----------
// §6.3 step 9: "App 放棄上傳時…呼叫 POST /api/v1/agent/uploads/:id/abort", so the hub marks the media failed and alerts the owner.
// Quitting or updating the App is not giving up: the session stays resumable and the relay's next media_upload asks again.

function failingSetup(t: { after(fn: () => unknown): void }, failure: () => Promise<never>) {
  const ctx = setup(t);
  const aborted: string[] = [];
  const attempts: ContinueUploadOptions[] = [];
  const handoff = new UploadHandoff({
    socketPath: join(tmpdir(), 'unused.sock'), dataDir: join(tmpdir(), 'unused-ar'), homeDir: join(ctx.video, '..', '..'),
    credentials: async () => ({ hubOrigin: 'https://hub.tail1234.ts.net', token: `ss_command_${'b'.repeat(64)}` }),
    session: async (_credentials, id) => { const found = ctx.sessions.get(id); if (!found) throw new Error('UPLOAD_NOT_FOUND'); return found; },
    continueUpload: async options => { attempts.push(options); return failure(); },
    abortUpload: async (_credentials, id) => { aborted.push(id); },
  });
  return { ...ctx, handoff, aborted, attempts };
}

const settled = () => new Promise(resolve => setTimeout(resolve, 20));

test('MCP-3: when the App gives up on a hand-off, it aborts the hub session; the next hand-off starts the upload again', async t => {
  const ctx = failingSetup(t, async () => { throw new Error('HUB_UNREACHABLE'); });
  assert.equal(await ctx.handoff.accept(ctx.message), true);
  await settled();
  assert.deepEqual(ctx.handoff.uploads().map(view => [view.status, view.error]), [['failed', 'HUB_UNREACHABLE']]);
  assert.deepEqual(ctx.aborted, [ctx.message.upload_id], 'the hub hears about it once: media failed, upload_failed alert');
  // A failed run never blocks the relay's next hand-off for the same upload (MCP-2): accept() starts it again.
  assert.equal(await ctx.handoff.accept(ctx.message), true);
  assert.equal(ctx.attempts.length, 2);
});

test('MCP-3: no abort when the App itself stopped the upload (quit, update), when the hub already assembles it, or for a foreign session', async t => {
  // The App quits while the upload runs: continueUpload sees the abort signal and rejects with it.
  const quitting = failingSetup(t, () => new Promise<never>(() => undefined));
  const app = new UploadHandoff({
    socketPath: join(tmpdir(), 'unused.sock'), dataDir: join(tmpdir(), 'unused-ar'), homeDir: join(quitting.video, '..', '..'),
    credentials: async () => ({ hubOrigin: 'https://hub.tail1234.ts.net', token: `ss_command_${'b'.repeat(64)}` }),
    session: async (_credentials, id) => quitting.sessions.get(id)!,
    continueUpload: options => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason))),
    abortUpload: async (_credentials, id) => { quitting.aborted.push(id); },
  });
  assert.equal(await app.accept(quitting.message), true);
  await app.stop();
  assert.deepEqual(quitting.aborted, [], 'quitting leaves the session receiving; the relay asks the next App instance');

  // The hub already assembles the file: it reports by itself, nothing to abort.
  const late = failingSetup(t, async () => { throw new Error('HUB_UNREACHABLE'); });
  late.sessions.set(late.message.upload_id, { ...late.sessions.get(late.message.upload_id)!, status: 'assembling' });
  assert.equal(await late.handoff.accept(late.message), true);
  await settled();
  assert.deepEqual(late.aborted, []);

  // continueUpload found a session for other bytes: never fail someone else's upload.
  const foreign = failingSetup(t, async () => { throw new Error('UPLOAD_SESSION_MISMATCH'); });
  assert.equal(await foreign.handoff.accept(foreign.message), true);
  await settled();
  assert.deepEqual(foreign.aborted, []);
});

// End to end with the real hub routes, the real relay media_upload handler and the real App hand-off server.
const MiB = 1024 * 1024;
const noProbe = async () => ({ width: 1080, height: 1920, duration_seconds: 12.5, video_codec: 'h264' });
const call = { notify: () => undefined };

async function stack(t: TestContext) {
  const hub = await startHub(t, { partDelayMs: 300, prepare: { probe: noProbe } });
  const root = mkdtempSync(join(tmpdir(), 'ssh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = fakeMp4(8 * MiB, 51);
  mkdirSync(join(root, 'media'));
  const path = join(root, 'media', 'video.mp4');
  writeFileSync(path, bytes);
  const data = join(root, 'ar');
  const socketPath = join(data, 'ipc.sock');
  const app = (continueUpload: NonNullable<UploadHandoffOptions['continueUpload']>) => {
    const handoff = new UploadHandoff({ socketPath, dataDir: data, credentials: async () => ({ hubOrigin: hub.origin, token: hub.token }), continueUpload });
    t.after(() => handoff.stop());
    return handoff;
  };
  const relay = createMediaUploadHandler({ api: createHubApi({ hubOrigin: hub.origin, token: hub.token }), pollMs: 50, handoffRecheckMs: 1000,
    handoff: createHandoffClient(socketPath), tuning: { initialChunksPerPart: 1, concurrency: 1, fastMs: 0 } });
  const session = async () => (await hub.rows('media_upload_session'))[0];
  return { hub, bytes, path, app, relay, session };
}

test('MCP-2: the App restarts (update) in the middle of an upload; the relay\'s next media_upload asks the new App, which finishes it', async t => {
  const { hub, bytes, path, app, relay, session } = await stack(t);
  const first = app(options => relayContinueUpload({ ...options, pollMs: 50 }));
  await first.start();
  const handed = await relay.handle({ path, wait_seconds: 1 }, call);
  assert.deepEqual([handed.structuredContent.status, handed.structuredContent.continues_in_background], ['uploading', true]);
  await first.stop(); // the update quits the App: its run is aborted, which is not giving up
  assert.equal((await session()).status, 'receiving');
  assert.deepEqual((await hub.alerts()).filter(alert => alert.kind === 'upload_failed'), []);

  const second = app(options => relayContinueUpload({ ...options, pollMs: 50 }));
  await second.start();
  const resumed = await relay.handle({ path, wait_seconds: 30 }, call);
  assert.equal(resumed.structuredContent.status, 'ready', JSON.stringify(resumed.structuredContent));
  assert.equal(resumed.structuredContent.media_id, handed.structuredContent.media_id);
  // The relay can see the hub's ready before the App's own poll does: wait for the App's run to settle.
  for (let attempt = 0; attempt < 100 && second.uploads()[0]?.status === 'uploading'; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(second.uploads().map(view => view.status), ['ready'], 'the new App instance uploaded the rest');
  assert.equal((await session()).sha256, digest(bytes));
});

test('MCP-3: the App gives up while the hub is reachable; the hub marks the media failed and alerts the owner', async t => {
  const { hub, path, app, relay, session } = await stack(t);
  const giving = app(async () => { throw new Error('HUB_UNREACHABLE'); }); // e.g. its 30 minutes of retries ran out
  await giving.start();
  const handed = await relay.handle({ path, wait_seconds: 1 }, call);
  assert.equal(handed.structuredContent.continues_in_background, true);
  // Deadlines, not attempt counts: on a loaded CI runner the App's give-up path can take seconds.
  for (const deadline = Date.now() + 10_000; Date.now() < deadline && (await session()).status === 'receiving';) await new Promise(resolve => setTimeout(resolve, 20));
  const failed = await session();
  assert.deepEqual([failed.status, (failed.error as { code: string }).code], ['failed', 'MEDIA_FAILED']);
  const [asset] = (await hub.rows('asset')).filter(row => row.id === handed.structuredContent.media_id);
  assert.equal(asset.status, 'failed');
  assert.equal((await hub.alerts()).at(-1)?.kind, 'upload_failed');
  // The hub can record the failure before the App's own run settles: wait for the App's view as well.
  for (const deadline = Date.now() + 10_000; Date.now() < deadline && giving.uploads()[0]?.status === 'uploading';) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(giving.uploads().map(view => view.status), ['failed']);
});
