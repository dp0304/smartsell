import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DeviceHttpError, DeviceNetworkError, DeviceProtocolClient } from '../../apps/connector/src/device-client.ts';
import { HubClock } from '../../apps/connector-desktop/src/runtime/clock.ts';
import { MediaCache, MediaHashMismatch, MediaUnavailable } from '../../apps/connector-desktop/src/runtime/media-cache.ts';
import { classify, HubProtocol } from '../../apps/connector-desktop/src/runtime/protocol.ts';
import { publishJob } from './fakes/driver-harness.ts';
import { startFakeHub } from './fakes/fake-hub.ts';

async function setup() {
  const hub = await startFakeHub();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  hub.addDevice('dev-1', publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'));
  const clock = new HubClock();
  const client = new DeviceProtocolClient({ origin: hub.origin, workspaceId: hub.workspaceId, deviceId: 'dev-1', key: privateKey, now: () => clock.now() });
  const protocol = new HubProtocol(client, clock);
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-media-'));
  return { hub, client, protocol, dir, async close() { await hub.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function file(bytes = 300_000) {
  const data = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index++) data[index] = (index * 7 + 3) & 0xff;
  return { data, sha256: createHash('sha256').update(data).digest('hex') };
}

function job(sha256: string, bytes: number) {
  return publishJob('x', { sha256, bytes }, {}, { fencing_token: 1 });
}

test('signed media download resumes with Range after an interruption and lands as <sha256> (0600)', async () => {
  const s = await setup();
  try {
    const media = file();
    s.hub.media.set('file-1', { bytes: media.data, truncateOnceAt: 100_000 });
    const claimed = job(media.sha256, media.data.length);
    s.hub.addJob('dev-1', claimed, 'claimed');
    const cache = new MediaCache({ dir: join(s.dir, 'cache'), open: (...args) => s.protocol.openMedia(...args) });
    await assert.rejects(cache.ensureAll(claimed), 'the first transfer is cut at 100 kB');
    assert.ok(existsSync(join(s.dir, 'cache', `${media.sha256}.part`)));
    const paths = await cache.ensureAll(claimed);
    const path = paths['file-1'];
    assert.equal(path, join(s.dir, 'cache', media.sha256));
    assert.ok(readFileSync(path).equals(media.data));
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    const requests = s.hub.log.filter(entry => entry.action === 'media.read');
    assert.deepEqual(requests.map(entry => entry.status), [200, 206]);
    // Same hash: served from the cache, no request.
    await cache.ensureAll(job(media.sha256, media.data.length));
    assert.equal(s.hub.log.filter(entry => entry.action === 'media.read').length, 2);
  } finally { await s.close(); }
});

test('a hash mismatch is fetched again once, and a second mismatch is media_hash_mismatch', async () => {
  const s = await setup();
  try {
    const media = file(50_000);
    s.hub.media.set('file-1', { bytes: media.data, corruptOnce: true });
    const claimed = job(media.sha256, media.data.length);
    s.hub.addJob('dev-1', claimed, 'claimed');
    const cache = new MediaCache({ dir: join(s.dir, 'cache'), open: (...args) => s.protocol.openMedia(...args) });
    assert.ok((await cache.ensureAll(claimed))['file-1']);
    assert.equal(s.hub.log.filter(entry => entry.action === 'media.read').length, 2);

    const wrong = job('0'.repeat(64), media.data.length);
    wrong.job_id = 'job-wrong';
    s.hub.addJob('dev-1', wrong, 'claimed');
    await assert.rejects(new MediaCache({ dir: join(s.dir, 'cache2'), open: (...args) => s.protocol.openMedia(...args) }).ensureAll(wrong), MediaHashMismatch);
  } finally { await s.close(); }
});

test('a fence the hub no longer accepts is refused; a dry run uses the bundled clip and never downloads', async () => {
  const s = await setup();
  try {
    const media = file(1000);
    s.hub.media.set('file-1', { bytes: media.data });
    const claimed = job(media.sha256, media.data.length);
    s.hub.addJob('dev-1', claimed, 'claimed');
    s.hub.job(claimed.job_id).claimed.fencing_token = 3;
    const cache = new MediaCache({ dir: join(s.dir, 'cache'), open: (...args) => s.protocol.openMedia(...args) });
    await assert.rejects(cache.ensureAll(claimed), (error: unknown) => (error as { kind?: string }).kind === 'fence_lost');
    const clip = join(s.dir, 'test-clip.mp4');
    writeFileSync(clip, 'clip');
    const dry = publishJob('x', { sha256: media.sha256, bytes: 4 }, { media: [{ file_id: null, bundled: 'test-clip-v1', sha256: 'c'.repeat(64), bytes: 4, mime: 'video/mp4', filename: 'test-clip.mp4', kind: 'video', duration_ms: 4000, width: 720, height: 1280 }] });
    assert.deepEqual(await new MediaCache({ dir: join(s.dir, 'c3'), open: () => { throw new Error('no download'); }, bundledClip: clip }).ensureAll(dry), { 'test-clip-v1': clip });
    await assert.rejects(new MediaCache({ dir: join(s.dir, 'c4'), open: () => { throw new Error('no download'); }, bundledClip: null }).ensureAll(dry), MediaUnavailable);
  } finally { await s.close(); }
});

test('LRU eviction keeps files of live jobs and removes released ones over the cap', async () => {
  const s = await setup();
  try {
    let now = 1_000_000;
    const cache = new MediaCache({ dir: join(s.dir, 'cache'), open: (...args) => s.protocol.openMedia(...args), maxBytes: 2500, now: () => now });
    const files = [file(1000), file(1001), file(1002)];
    const jobs = files.map((media, index) => {
      s.hub.media.set(`file-${index}`, { bytes: media.data });
      const claimed = publishJob('x', { sha256: media.sha256, bytes: media.data.length }, { media: [{ file_id: `file-${index}`, sha256: media.sha256, bytes: media.data.length, mime: 'video/mp4', filename: 'v.mp4', kind: 'video', duration_ms: 1, width: 1, height: 1 }] }, { job_id: `job-${index}` });
      s.hub.addJob('dev-1', claimed, 'claimed');
      return claimed;
    });
    await cache.ensureAll(jobs[0]); now += 1000;
    await cache.ensureAll(jobs[1]); now += 1000;
    cache.release('job-0');
    await cache.ensureAll(jobs[2]);
    assert.equal(existsSync(cache.pathFor(files[0].sha256)), false, 'released and least recently used');
    assert.ok(existsSync(cache.pathFor(files[1].sha256)), 'still used by a live job');
    assert.ok(existsSync(cache.pathFor(files[2].sha256)));
  } finally { await s.close(); }
});

test('device client errors keep code, expected, Retry-After and Date; network and timeouts are classified as unreachable', async () => {
  const s = await setup();
  try {
    s.hub.inject({ action: 'jobs.report', status: 409, code: 'SEQ_GAP', details: { expected: 4 } });
    const report = { job_id: 'j', fencing_token: 1, seq: 9, event_id: 'e', worker_time: new Date().toISOString(), event: 'submitting' as const, data: { event: 'submitting' as const } };
    const gap = await s.client.report(report).catch(error => error);
    assert.ok(gap instanceof DeviceHttpError);
    assert.equal(gap.code, 'SEQ_GAP');
    assert.equal(classify(gap).kind, 'seq_gap');
    assert.equal(classify(gap).expected, 4);
    s.hub.inject({ action: 'heartbeat', status: 503, code: 'DEVICE_BUSY', retryAfter: '3' });
    const busy = await s.client.heartbeat({ client_version: '0.2.0', protocol: 2, drivers: [], jobs: [], outbox_depth: 0, worker_time: new Date().toISOString(), applied_sync_generation: 0 }).catch(error => error);
    assert.equal(busy.retryAfterMs, 3000);
    assert.ok(busy.serverDate);
    assert.equal(classify(busy).kind, 'busy');
    assert.equal(classify(busy).unreachable, false, 'DEVICE_BUSY is an answer, not an outage');
    s.hub.inject({ action: 'jobs.go', status: 504 });
    assert.equal(classify(await s.client.go({ job_id: 'j', fencing_token: 1 }).catch(error => error)).unreachable, true);
    s.hub.inject({ action: 'jobs.go', status: 500 });
    assert.equal(classify(await s.client.go({ job_id: 'j', fencing_token: 1 }).catch(error => error)).unreachable, false, '500 never counts toward offline go');
    s.hub.inject({ action: 'jobs.go', network: true });
    const dropped = await s.client.go({ job_id: 'j', fencing_token: 1 }).catch(error => error);
    assert.ok(dropped instanceof DeviceNetworkError);
    s.hub.inject({ action: 'jobs.go', delayMs: 1500 });
    const slow = await s.client.go({ job_id: 'j', fencing_token: 1 }, 300).catch(error => error);
    assert.ok(slow instanceof DeviceNetworkError && slow.kind === 'timeout');
    assert.equal(classify(slow).unreachable, true);
    // media.read of a job that ended or moved (hub 403 MEDIA_FORBIDDEN) is a job-level refusal, not a revoked device.
    assert.equal(classify(new DeviceHttpError(403, 'MEDIA_FORBIDDEN', {}, null, null)).kind, 'client');
    assert.equal(classify(new DeviceHttpError(403, 'DEVICE_INACTIVE', {}, null, null)).kind, 'device_revoked');
    assert.equal(classify(new DeviceHttpError(403, null, {}, null, null)).kind, 'device_revoked');
  } finally { await s.close(); }
});
