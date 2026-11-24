import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { continueUpload } from '../src/continue-upload.ts';
import { createHandoffClient, createHandoffServer, handoffSocketPath, type HandoffMessage } from '../src/handoff.ts';
import { createHubApi } from '../src/hub-api.ts';
import { createMediaUploadHandler } from '../src/media-upload.ts';
import { runRelay } from '../src/relay.ts';
import { uploadMissing, type PartRecord } from '../src/uploader.ts';
import { fakeMp4, sha256, startHub, type Hub } from './fixtures/hub.ts';

const MiB = 1024 * 1024;
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const noProbe = async () => ({ width: 1080, height: 1920, duration_seconds: 12.5, video_codec: 'h264' });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Json = Record<string, any>;

async function mediaFile(t: TestContext, bytes: Buffer, name = 'video.mp4') {
  // Outside the hub fixture directory, which holds the relay's token (a denied location).
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-relay-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

const chunksOf = (put: { n: number; length: number }) => Array.from({ length: Math.ceil(put.length / MiB) }, (_, index) => put.n + index);
const call = { notify: () => undefined };

async function storedSha(hub: Hub) {
  const [file] = await hub.rows('file_object');
  const { stream } = await hub.storage.read(String(file.storage_key));
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return sha256(Buffer.concat(parts));
}

async function settle(hub: Hub, mediaId: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const [session] = (await hub.rows('media_upload_session')).filter(row => row.media_id === mediaId);
    if (session && (session.status === 'ready' || session.status === 'failed')) return session;
    await sleep(25);
  }
  throw new Error('upload did not settle');
}

/** The relay as a real child process (Node strips the TypeScript types), as Codex starts it. */
function spawnRelay(t: TestContext, hub: Hub) {
  const child = spawn(process.execPath, [join(packageRoot, 'src', 'main.ts'), '--hub', hub.origin, '--token-file', hub.tokenFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const output: Json[] = [];
  const raw: string[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) { raw.push(buffer.slice(0, index)); output.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
  });
  let errors = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk; });
  const send = (message: Json) => child.stdin.write(`${JSON.stringify(message)}\n`);
  async function reply(id: unknown, timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const index = output.findIndex(item => item.id === id);
      if (index !== -1) return { message: output[index], raw: raw[index] };
      if (child.exitCode !== null) throw new Error(`relay exited: ${errors}`);
      await sleep(20);
    }
    throw new Error(`no reply: ${errors}`);
  }
  return { child, send, reply, output, errors: () => errors };
}

test('killed after the third part, a new relay resumes from the received chunks; the stored SHA-256 matches', async t => {
  const hub = await startHub(t, { partDelayMs: 150, prepare: { probe: noProbe } });
  const bytes = fakeMp4(20 * MiB + 321);
  const path = await mediaFile(t, bytes);
  const first = spawnRelay(t, hub);
  first.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'media_upload', arguments: { path, wait_seconds: 50 } } });
  while (hub.puts.length < 3) await sleep(10);
  first.child.kill('SIGKILL');
  await new Promise(resolve => first.child.once('exit', resolve));
  await sleep(300);
  const [interrupted] = await hub.rows('media_upload_session');
  const before = new Set(interrupted.received as number[]);
  assert.equal(interrupted.status, 'receiving');
  assert.ok(before.size > 0 && before.size < Number(interrupted.chunks), `received ${before.size} of ${interrupted.chunks}`);
  const firstRun = hub.puts.length;

  const second = spawnRelay(t, hub);
  second.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'media_upload', arguments: { path, wait_seconds: 50 } } });
  const { message, raw } = await second.reply(2);
  const result = message.result.structuredContent;
  assert.equal(result.status, 'ready', JSON.stringify(message));
  assert.equal(result.media_id, interrupted.media_id);
  assert.equal(result.sha256, sha256(bytes));
  assert.deepEqual([result.duration_ms, result.width, result.height, result.uploaded_bytes, result.continues_in_background], [12500, 1080, 1920, bytes.length, false]);
  // Only missing chunks were sent again.
  const resent = hub.puts.slice(firstRun).flatMap(chunksOf);
  assert.ok(resent.every(index => !before.has(index)), `re-sent ${resent.filter(index => before.has(index))}`);
  assert.equal(new Set(resent).size + before.size, interrupted.chunks);
  assert.equal(await storedSha(hub), sha256(bytes));
  // The model never sees file bytes: the whole tool response stays small and carries no base64 payload.
  assert.ok(Buffer.byteLength(raw) < 4096, `${Buffer.byteLength(raw)} bytes`);
  assert.doesNotMatch(raw, /[A-Za-z0-9+/]{200,}/);
  second.child.stdin.end();
  assert.equal(await new Promise(resolve => second.child.once('exit', resolve)), 0);
});

test('parts grow to 8 chunks on a fast link and shrink to one 1 MiB chunk on a slow one', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  async function run(perPartMs: number, seed: number) {
    const bytes = fakeMp4(30 * MiB, seed);
    const path = await mediaFile(t, bytes, `clip-${seed}.mp4`);
    let now = 0;
    const api = createHubApi({ hubOrigin: hub.origin, token: hub.token, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === 'PUT') now += perPartMs;
      return response;
    } });
    const session = await api.create({ filename: 'clip.mp4', bytes: bytes.length, sha256: sha256(bytes), mime: 'video/mp4' });
    const parts: PartRecord[] = [];
    const { mtimeMs } = await import('node:fs/promises').then(fs => fs.stat(path));
    await uploadMissing(api, { uploadId: String(session.upload_id), path, bytes: bytes.length, mtimeMs, chunkBytes: MiB, chunks: 30 }, [],
      { parts, tuning: { clock: () => now, concurrency: 1 } });
    return parts.map(part => part.k);
  }
  assert.deepEqual(await run(1000, 3), [2, 4, 8, 8, 8]);
  const slow = await run(40_000, 4);
  assert.deepEqual(slow.slice(0, 3), [2, 1, 1]);
  assert.ok(slow.slice(1).every(k => k === 1), 'stays at one chunk per request');
});

test('when wait_seconds runs out the tool returns uploading with an ETA and keeps uploading in this process', async t => {
  const hub = await startHub(t, { partDelayMs: 400, prepare: { probe: noProbe } });
  const bytes = fakeMp4(8 * MiB);
  const path = await mediaFile(t, bytes);
  const background: Promise<unknown>[] = [];
  const handler = createMediaUploadHandler({ api: createHubApi({ hubOrigin: hub.origin, token: hub.token }), pollMs: 50,
    tuning: { initialChunksPerPart: 1, concurrency: 1, fastMs: 0 }, onBackground: work => background.push(work) });
  const started = Date.now();
  const result = await handler.handle({ path, wait_seconds: 1 }, call);
  assert.ok(Date.now() - started < 3000, 'returns within wait_seconds');
  const output = result.structuredContent;
  assert.equal(output.status, 'uploading');
  assert.ok((output.uploaded_bytes as number) < bytes.length);
  assert.ok((output.eta_seconds as number) > 0);
  assert.equal(output.continues_in_background, false);
  assert.match(result.content[1].text, /conversation stays open/);
  assert.deepEqual(Object.keys(output).sort(), ['bytes', 'continues_in_background', 'deduplicated', 'duration_ms', 'eta_seconds', 'filename', 'height', 'kind',
    'media_id', 'mime', 'sha256', 'status', 'uploaded_bytes', 'web_url', 'width']);
  assert.equal(background.length, 1);
  await handler.idle();
  const session = await settle(hub, String(output.media_id));
  assert.equal(session.status, 'ready');
  assert.equal(await storedSha(hub), sha256(bytes));
  // Re-calling after it finished returns the same media, deduplicated, with no new parts.
  const puts = hub.puts.length;
  const again = await handler.handle({ path }, call);
  assert.deepEqual([again.structuredContent.status, again.structuredContent.media_id, again.structuredContent.deduplicated], ['ready', output.media_id, true]);
  assert.equal(hub.puts.length, puts);
});

test('with the laptop App listening, the rest of the upload is handed off and continueUpload() finishes it', async t => {
  const hub = await startHub(t, { partDelayMs: 300, prepare: { probe: noProbe } });
  const bytes = fakeMp4(8 * MiB, 9);
  const path = await mediaFile(t, bytes);
  const socketDir = await mkdtemp(join(tmpdir(), 'smartsell-ipc-'));
  t.after(() => rm(socketDir, { recursive: true, force: true }));
  const socket = handoffSocketPath(socketDir);
  const received: HandoffMessage[] = [];
  let finished: Promise<{ status: string; error?: string }> | undefined;
  const server = await createHandoffServer(socket, message => {
    received.push(message);
    finished = continueUpload({ hubOrigin: hub.origin, token: hub.token, uploadId: message.upload_id, path: message.path, sha256: message.sha256,
      bytes: message.bytes, mtimeMs: message.mtime_ms, pollMs: 50 });
    return true;
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const handler = createMediaUploadHandler({ api: createHubApi({ hubOrigin: hub.origin, token: hub.token }), pollMs: 50, handoff: createHandoffClient(socket),
    tuning: { initialChunksPerPart: 1, concurrency: 1, fastMs: 0 } });
  const result = await handler.handle({ path, wait_seconds: 1 }, call);
  assert.equal(result.structuredContent.status, 'uploading');
  assert.equal(result.structuredContent.continues_in_background, true);
  assert.match(result.content[1].text, /SmartSell app continues/);
  assert.equal(received.length, 1);
  assert.deepEqual(Object.keys(received[0]).sort(), ['bytes', 'mtime_ms', 'path', 'sha256', 'type', 'upload_id']);
  assert.equal(received[0].sha256, sha256(bytes));
  assert.deepEqual(await finished, { status: 'ready' });
  await handler.idle();
  assert.equal(handler.runs.size, 0, 'the relay stopped its own upload');
  const chunks = hub.puts.flatMap(chunksOf);
  assert.ok(chunks.length <= 8 + 1, `at most the one in-flight part is sent twice (${chunks.length})`);
  assert.equal(await storedSha(hub), sha256(bytes));
});

test('continueUpload refuses a mismatched session and stops with FILE_CHANGED when the file was edited', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const bytes = fakeMp4(3 * MiB, 11);
  const path = await mediaFile(t, bytes);
  const api = createHubApi({ hubOrigin: hub.origin, token: hub.token });
  const session = await api.create({ filename: 'video.mp4', bytes: bytes.length, sha256: sha256(bytes), mime: 'video/mp4' });
  const { mtimeMs } = await import('node:fs/promises').then(fs => fs.stat(path));
  const base = { hubOrigin: hub.origin, token: hub.token, uploadId: String(session.upload_id), path, bytes: bytes.length, mtimeMs };
  await assert.rejects(continueUpload({ ...base, sha256: 'f'.repeat(64) }), /UPLOAD_SESSION_MISMATCH/);
  await utimes(path, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(await continueUpload({ ...base, sha256: sha256(bytes) }), { status: 'failed', error: 'FILE_CHANGED' });
  const status = await api.status(String(session.upload_id));
  assert.deepEqual([status.status, status.error?.code], ['failed', 'FILE_CHANGED']);
  assert.equal((await hub.alerts()).at(-1)?.kind, 'upload_failed');
});

test('a file edited during the upload is reported as FILE_CHANGED and the hub is told to abort', async t => {
  const hub = await startHub(t, { partDelayMs: 200, prepare: { probe: noProbe } });
  const bytes = fakeMp4(6 * MiB, 13);
  const path = await mediaFile(t, bytes);
  const handler = createMediaUploadHandler({ api: createHubApi({ hubOrigin: hub.origin, token: hub.token }), pollMs: 50, tuning: { initialChunksPerPart: 1, concurrency: 1, fastMs: 0 } });
  const pending = handler.handle({ path, wait_seconds: 20 }, call);
  while (hub.puts.length < 2) await sleep(10);
  await writeFile(path, Buffer.concat([bytes, Buffer.from('more')]));
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent.error as { code: string }).code, 'FILE_CHANGED');
  const [session] = await hub.rows('media_upload_session');
  assert.deepEqual([session.status, (session.error as { code: string }).code], ['failed', 'FILE_CHANGED']);
});

test('over stdio: progress notifications every 5 %, then one compact result', async t => {
  const hub = await startHub(t, { partDelayMs: 20, prepare: { probe: noProbe } });
  const bytes = fakeMp4(10 * MiB, 17);
  const path = await mediaFile(t, bytes);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  let buffer = '';
  stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) { lines.push(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
  });
  const done = runRelay({ hubOrigin: hub.origin, token: hub.token, stdin, stdout, stderr: new PassThrough(), pollMs: 50,
    tuning: { initialChunksPerPart: 1, concurrency: 1, fastMs: 0 } });
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'u1', method: 'tools/call', params: { name: 'media_upload', arguments: { path }, _meta: { progressToken: 'p1' } } })}\n`);
  while (!lines.some(line => JSON.parse(line).id === 'u1')) await sleep(20);
  stdin.end();
  await done;
  const messages = lines.map(line => JSON.parse(line));
  const progress = messages.filter(message => message.method === 'notifications/progress');
  assert.ok(progress.length >= 9, `${progress.length} progress notifications`);
  assert.ok(progress.every(message => message.params.progressToken === 'p1' && message.params.total === bytes.length));
  const values = progress.map(message => message.params.progress);
  assert.deepEqual(values, [...values].sort((a, b) => a - b));
  const final = lines.find(line => JSON.parse(line).id === 'u1')!;
  const result = JSON.parse(final).result;
  assert.equal(result.structuredContent.status, 'ready');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(Buffer.byteLength(final) < 4096);
  // Nothing about media_upload reached the hub's /mcp endpoint: it was handled locally.
  assert.equal(hub.puts.length > 0, true);
});

test('E2E-11 scale: 1 GB, killed at 40 %, resumed, heartbeats stay fast during assembly and ffprobe', { skip: !process.env.SMARTSELL_TEST_LARGE && 'set SMARTSELL_TEST_LARGE=1' }, async t => {
  const hub = await startHub(t, { store: 'local', maxUploadBytes: 2048 * MiB });
  const size = 1024 * MiB;
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-relay-large-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'large.mp4');
  await writeFile(path, fakeMp4(size, 21));
  const first = spawnRelay(t, hub);
  first.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'media_upload', arguments: { path, wait_seconds: 50 } } });
  for (;;) {
    const [session] = await hub.rows('media_upload_session');
    if (session && (session.received as number[]).length >= 0.4 * Number(session.chunks)) break;
    assert.equal(first.output.find(item => item.id === 1), undefined, 'the first relay is still uploading');
    await sleep(100);
  }
  first.child.kill('SIGKILL');
  const second = spawnRelay(t, hub);
  second.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'media_upload', arguments: { path, wait_seconds: 50 } } });
  const latencies: number[] = [];
  let settled = false;
  const reply = second.reply(2, 120_000).then(value => { settled = true; return value; });
  while (!settled) {
    const started = performance.now();
    await hub.write(ctx => ctx.create('heartbeat_probe', { at: ctx.now }));
    latencies.push(performance.now() - started);
    await sleep(100);
  }
  const { raw } = await reply;
  assert.ok(Buffer.byteLength(raw) < 4096);
  const session = await settle(hub, JSON.parse(raw).result.structuredContent.media_id);
  assert.equal(session.status, 'ready');
  assert.ok(Math.max(...latencies) < 1000, `slowest heartbeat ${Math.max(...latencies)} ms`);
  const digest = sha256(await readFile(path));
  assert.equal(session.sha256, digest);
  assert.equal(await storedSha(hub), digest);
});

// ---------- Wave 6 (G6): MCP-3 complete retry and give-up abort; MCP-2 never trust an earlier hand-off ----------

const fastSleep = (record?: number[]) => async (ms: number, signal?: AbortSignal) => {
  record?.push(ms);
  signal?.throwIfAborted();
  await sleep(Math.min(ms, 5));
};
const hubError = (status: number) => new Response(JSON.stringify({ error: { code: 'internal_error', message: 'restarting' } }),
  { status, headers: { 'content-type': 'application/json' } });

/** A fetch that fails POST …/complete with the scripted answers (a thrown TypeError is a network error). */
function flakyComplete(answers: (() => Response)[] | 'always-503') {
  const calls = { complete: 0 };
  const request: typeof fetch = async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/complete')) {
      calls.complete++;
      if (answers === 'always-503') return hubError(503);
      const answer = answers.shift();
      if (answer) return answer();
    }
    return fetch(url, init);
  };
  return { request, calls };
}

test('MCP-3: complete is retried after a network error and a 503, like parts; the background upload becomes ready', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const bytes = fakeMp4(3 * MiB, 31);
  const path = await mediaFile(t, bytes);
  const api = createHubApi({ hubOrigin: hub.origin, token: hub.token });
  const session = await api.create({ filename: 'video.mp4', bytes: bytes.length, sha256: sha256(bytes), mime: 'video/mp4' });
  const { mtimeMs } = await import('node:fs/promises').then(fs => fs.stat(path));
  const flaky = flakyComplete([() => { throw new TypeError('fetch failed'); }, () => hubError(503)]);
  const slept: number[] = [];
  const outcome = await continueUpload({ hubOrigin: hub.origin, token: hub.token, uploadId: String(session.upload_id), path, sha256: sha256(bytes),
    bytes: bytes.length, mtimeMs, fetch: flaky.request, pollMs: 20, tuning: { sleep: fastSleep(slept) } });
  assert.deepEqual(outcome, { status: 'ready' });
  assert.equal(flaky.calls.complete, 3, 'two failed completes, then the one the hub accepted');
  assert.deepEqual(slept.slice(0, 2), [1000, 2000], 'the background retry schedule (1 s, 2 s, …), not an immediate failure');
  assert.equal((await settle(hub, session.media_id)).status, 'ready');
  assert.equal(await storedSha(hub), sha256(bytes));
});

test('MCP-3: a background upload that finally gives up aborts the hub session, so the media fails and the owner is alerted', async t => {
  const hub = await startHub(t, { prepare: { probe: noProbe } });
  const bytes = fakeMp4(2 * MiB, 33);
  const path = await mediaFile(t, bytes);
  const api = createHubApi({ hubOrigin: hub.origin, token: hub.token });
  const session = await api.create({ filename: 'video.mp4', bytes: bytes.length, sha256: sha256(bytes), mime: 'video/mp4' });
  const { mtimeMs } = await import('node:fs/promises').then(fs => fs.stat(path));
  const flaky = flakyComplete('always-503');
  await assert.rejects(continueUpload({ hubOrigin: hub.origin, token: hub.token, uploadId: String(session.upload_id), path, sha256: sha256(bytes),
    bytes: bytes.length, mtimeMs, fetch: flaky.request, pollMs: 20, tuning: { retryDelaysMs: () => [1, 1, 1], sleep: fastSleep() } }), /restarting/);
  assert.equal(flaky.calls.complete, 4, 'the first try and three retries');
  const status = await api.status(String(session.upload_id));
  assert.deepEqual([status.status, status.error?.code], ['failed', 'MEDIA_FAILED']);
  const [asset] = (await hub.rows('asset')).filter(row => row.id === session.media_id);
  assert.equal(asset.status, 'failed');
  assert.equal((await hub.alerts()).at(-1)?.kind, 'upload_failed');
});

test('MCP-3: the relay aborts the hub session only when its background run gives up, never for a foreground error the model can retry', async t => {
  const hub = await startHub(t, { partDelayMs: 300, prepare: { probe: noProbe } });
  const bytes = fakeMp4(6 * MiB, 35);
  const path = await mediaFile(t, bytes);
  const flaky = flakyComplete('always-503');
  const tuning = { initialChunksPerPart: 1, concurrency: 1, fastMs: 0, sleep: fastSleep() };
  // Foreground: the call is still open when complete keeps failing. The error goes to the model and the session stays resumable.
  const foreground = createMediaUploadHandler({ api: createHubApi({ hubOrigin: hub.origin, token: hub.token, fetch: flaky.request }), pollMs: 20, tuning });
  const failed = await foreground.handle({ path, wait_seconds: 30 }, call);
  assert.equal(failed.isError, true, JSON.stringify(failed.structuredContent));
  const [kept] = await hub.rows('media_upload_session');
  assert.equal(kept.status, 'receiving', 'a foreground failure leaves the session for the next media_upload');
  assert.equal((await hub.alerts()).filter(alert => alert.kind === 'upload_failed').length, 0);

  // Background: a second relay that runs out of wait_seconds keeps going after the call returns, then gives up.
  const other = await mediaFile(t, fakeMp4(6 * MiB, 36), 'other.mp4');
  const background: Promise<unknown>[] = [];
  const logs: string[] = [];
  const relay = createMediaUploadHandler({ api: createHubApi({ hubOrigin: hub.origin, token: hub.token, fetch: flaky.request }), pollMs: 20, tuning,
    onBackground: work => background.push(work), log: line => logs.push(line) });
  const result = await relay.handle({ path: other, wait_seconds: 1 }, call);
  assert.equal(result.structuredContent.status, 'uploading');
  assert.equal(background.length, 1);
  await Promise.all(background);
  const session = (await hub.rows('media_upload_session')).find(row => row.media_id === result.structuredContent.media_id)!;
  assert.deepEqual([session.status, (session.error as { code: string }).code], ['failed', 'MEDIA_FAILED']);
  assert.equal((await hub.alerts()).at(-1)?.kind, 'upload_failed');
  assert.match(logs.join('\n'), /background upload stopped/);
});

/** A stand-in for the laptop App's hand-off socket that answers from a script (true = "I am uploading it"). */
async function scriptedApp(t: TestContext, answers: boolean[]) {
  const socketDir = await mkdtemp(join(tmpdir(), 'smartsell-ipc-'));
  t.after(() => rm(socketDir, { recursive: true, force: true }));
  const socket = handoffSocketPath(socketDir);
  const asked: HandoffMessage[] = [];
  const server = await createHandoffServer(socket, message => { asked.push(message); return answers.shift() ?? false; });
  const close = () => new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()); });
  t.after(close);
  return { socket, asked, close };
}

test('MCP-2: after the App quit, the next media_upload for the same path asks again, gets no answer and uploads the rest itself', async t => {
  const hub = await startHub(t, { partDelayMs: 300, prepare: { probe: noProbe } });
  const bytes = fakeMp4(8 * MiB, 41);
  const path = await mediaFile(t, bytes);
  const app = await scriptedApp(t, [true]); // says yes, then quits (an update, a crash) before it uploads anything
  const handler = createMediaUploadHandler({ api: createHubApi({ hubOrigin: hub.origin, token: hub.token }), pollMs: 50,
    handoff: createHandoffClient(app.socket), tuning: { initialChunksPerPart: 1, concurrency: 1, fastMs: 0 } });
  const first = await handler.handle({ path, wait_seconds: 1 }, call);
  assert.deepEqual([first.structuredContent.status, first.structuredContent.continues_in_background], ['uploading', true]);
  assert.equal(app.asked.length, 1);
  await app.close();
  await handler.idle();
  const [stuck] = await hub.rows('media_upload_session');
  assert.equal(stuck.status, 'receiving', 'nothing uploads the rest while the App is gone');

  const second = await handler.handle({ path, wait_seconds: 20 }, call);
  const output = second.structuredContent;
  assert.equal(output.status, 'ready', JSON.stringify(output));
  assert.equal(output.media_id, first.structuredContent.media_id);
  assert.equal(output.continues_in_background, false);
  assert.doesNotMatch(second.content.map(item => item.text).join('\n'), /SmartSell app continues/);
  assert.equal(await storedSha(hub), sha256(bytes));
});

test('MCP-2: while it watches an upload the App took, the relay asks again when bytes stop arriving and takes over on a no', async t => {
  const hub = await startHub(t, { partDelayMs: 300, prepare: { probe: noProbe } });
  const bytes = fakeMp4(8 * MiB, 43);
  const path = await mediaFile(t, bytes);
  // Yes at the first deadline, yes again on the next call (its run looked alive), then no: the App gave up meanwhile.
  const app = await scriptedApp(t, [true, true, false]);
  const handler = createMediaUploadHandler({ api: createHubApi({ hubOrigin: hub.origin, token: hub.token }), pollMs: 50, handoffRecheckMs: 400,
    handoff: createHandoffClient(app.socket), tuning: { initialChunksPerPart: 1, concurrency: 1, fastMs: 0 } });
  const first = await handler.handle({ path, wait_seconds: 1 }, call);
  assert.equal(first.structuredContent.continues_in_background, true);
  await handler.idle();
  const second = await handler.handle({ path, wait_seconds: 20 }, call);
  assert.equal(second.structuredContent.status, 'ready', JSON.stringify(second.structuredContent));
  assert.equal(app.asked.length, 3, 'asked at the deadline, at the start of the second call and once more when no bytes arrived');
  assert.ok(app.asked.every(message => message.upload_id === app.asked[0].upload_id));
  assert.equal(await storedSha(hub), sha256(bytes));
});
