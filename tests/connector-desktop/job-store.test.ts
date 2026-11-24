import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JobStore, writeAtomic, type LocalJob } from '../../apps/connector-desktop/src/runtime/job-store.ts';
import { publishJob } from './fakes/driver-harness.ts';

function dir() { return mkdtempSync(join(tmpdir(), 'smartsell-store-')); }

function local(store: JobStore, overrides: Partial<LocalJob> = {}) {
  const claimed = publishJob('x', { sha256: 'a'.repeat(64), bytes: 10 });
  const job: LocalJob = {
    claimed, state: 'claimed', media_paths: {}, readback_attempts: 0, offline_go_disabled: false, revoked: false, fence: claimed.fencing_token, next_seq: 1,
    sync: { hold: false, hold_reason: null, mode: 'auto', resume_token: 0, machine_paused: false, pause_all: false, channel_paused: false, synced_at: new Date().toISOString() },
    last_sync_at: new Date().toISOString(), ...overrides,
  };
  store.put(job);
  return job;
}

test('atomic write leaves either the old or the new file, and stray temporaries are cleaned on load', () => {
  const root = dir();
  try {
    const store = new JobStore(root);
    const job = local(store);
    const path = join(root, 'jobs', `${job.claimed.job_id}.json`);
    const before = readFileSync(path, 'utf8');
    // A crash after writing the temporary file but before rename: the record is unchanged.
    writeFileSync(`${path}.123.abcd.tmp`, '{"partial":');
    const reopened = new JobStore(root);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(reopened.get(job.claimed.job_id)?.state, 'claimed');
    assert.deepEqual(readdirSync(join(root, 'jobs')).filter(name => name.endsWith('.tmp')), []);
    writeAtomic(path, JSON.stringify({ ...job, state: 'ready' }));
    assert.equal(new JobStore(root).get(job.claimed.job_id)?.state, 'ready');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('outbox entries keep file order, consecutive seq per fence, and classify facts and lease reports', () => {
  const root = dir();
  try {
    const store = new JobStore(root);
    const job = local(store);
    const id = job.claimed.job_id;
    store.enqueue(id, 'prepared', { event: 'prepared', stage: 'preflight', login: 'verified', identity: 'fixture_x', handle: 'fixture_x', media_ok: true, driver: { provider: 'x', version: 'x@t' } }, new Date().toISOString());
    store.enqueue(id, 'started', { event: 'started', go: 'hub', mode: 'auto' }, new Date().toISOString());
    store.enqueue(id, 'submitting', { event: 'submitting' }, new Date().toISOString());
    store.enqueue(id, 'blocked', { event: 'blocked', blocker: { code: 'platform_error', phase: 'after_submit', message: 'x', at: new Date().toISOString() } }, new Date().toISOString());
    const entries = new JobStore(root).outbox();
    assert.deepEqual(entries.map(entry => entry.seq), [1, 2, 3, 4]);
    assert.deepEqual(entries.map(entry => entry.kind), ['lease', 'fact', 'fact', 'fact']);
    assert.deepEqual(entries.map(entry => entry.report.event), ['prepared', 'started', 'submitting', 'blocked']);
    assert.equal(new Set(entries.map(entry => entry.event_id)).size, 4);
    assert.ok(entries.every((entry, index) => index === 0 || entry.file > entries[index - 1].file));
    assert.equal(new JobStore(root).get(id)?.next_seq, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a crash between the job write and the outbox write keeps the transition and leaves a seq gap the hub can report', () => {
  const root = dir();
  try {
    const store = new JobStore(root);
    const job = local(store);
    store.fault = operation => { if (operation === 'outbox') throw new Error('power loss'); };
    store.update(job.claimed.job_id, value => { value.state = 'submitting'; });
    assert.throws(() => store.enqueue(job.claimed.job_id, 'submitting', { event: 'submitting' }, new Date().toISOString()), /power loss/);
    const reopened = new JobStore(root);
    assert.equal(reopened.get(job.claimed.job_id)?.state, 'submitting', 'the state change reached disk before the outbox entry');
    assert.equal(reopened.outboxDepth(), 0);
    assert.equal(reopened.get(job.claimed.job_id)?.next_seq, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('evidence is stored once per sha256 and collected only after upload and seven days', () => {
  const root = dir();
  try {
    const store = new JobStore(root);
    const job = local(store);
    const id = job.claimed.job_id;
    const sha = store.addEvidence(id, 'before_submit', Buffer.from('jpeg-1'));
    assert.equal(store.addEvidence(id, 'again', Buffer.from('jpeg-1')), sha);
    store.addEvidence(id, 'after_submit', Buffer.from('jpeg-2'));
    assert.equal(store.evidence(id).length, 2);
    store.update(id, value => { value.state = 'done'; value.finished_at = new Date(Date.now() - 8 * 86_400_000).toISOString(); });
    store.collect(Date.now());
    assert.ok(existsSync(join(root, 'evidence', id)), 'not uploaded yet: kept');
    for (const record of store.evidence(id)) store.markEvidence(id, record.sha256, 'uploaded');
    store.collect(Date.now());
    assert.equal(existsSync(join(root, 'evidence', id)), false);
    assert.equal(store.get(id), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
