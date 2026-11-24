import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hubFixture } from '../worker/fixtures.js';
import { updatePost } from './update.js';

const HOUR = 3_600_000;

// S3 ledger items 2 and 4 checked against the real job engine: post_update cancel of a claimed job answers 'cancelling'
// (target cancel_requested, job releasing) and becomes 'cancelled' once the machine releases it on its next heartbeat.
test('post_update cancel of a claimed Worker job shows cancelling, then cancelled after the release', async () => {
  const f = hubFixture();
  const target = await f.schedule(2 * HOUR);
  const job = f.jobOf(target.id);
  f.claim();
  assert.equal(f.job(job.id).status, 'claimed');
  const result = await updatePost(f.ctx, target.id, { action: 'cancel', reason: 'owner changed plans' });
  assert.equal(result.post.status, 'cancelling');
  assert.equal(f.ctx.get('publish_target', target.id).plan_status, 'cancel_requested');
  assert.equal(f.job(job.id).status, 'releasing');
  const beat = f.heartbeat([job.id]);
  assert.deepEqual(beat.revoked_jobs, [{ job_id: job.id, reason: 'cancelled' }]);
  f.heartbeat([], { released_jobs: [job.id] });
  assert.equal(f.job(job.id).status, 'cancelled');
  const after = await updatePost(f.ctx, target.id, { action: 'cancel' }).catch((error: { code?: string }) => error.code);
  assert.equal(after, 'POST_FINAL');
});

test('post_update cancel of a queued Worker job cancels at once', async () => {
  const f = hubFixture();
  const target = await f.schedule(30 * HOUR);
  const job = f.jobOf(target.id);
  const result = await updatePost(f.ctx, target.id, { action: 'cancel' });
  assert.equal(result.post.status, 'cancelled');
  assert.equal(f.job(job.id).status, 'cancelled');
});
