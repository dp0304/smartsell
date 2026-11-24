// §5.11 rule 5: property test of the no-repost invariants. A simulated Worker that follows the protocol (§5.7 offline
// rules, revocation before the click, outbox with per-fence seq) runs random event sequences against the real hub handlers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hubSawStart, possiblySent, type Data, type JobReportEvent, type Problem, type Row, type WorkerJobRecord } from '@smartsell/contracts';
import { cancel, updateTarget } from '../planning/index.js';
import { reportJob } from './device-jobs.js';
import { hubFixture } from './fixtures.js';
import { JOB } from './model.js';

const MIN = 60_000;
function prng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

interface Local { id: string; fence: number; state: 'held' | 'prepared' | 'running' | 'clicked' | 'released' | 'done'; revoked: boolean; hold: boolean; mode: 'auto' | 'assist';
  notBefore: number; notAfter: number; staleness: number; lastSync: number; denied: boolean }
interface Entry { job_id: string; fencing_token: number; seq: number; event_id: string; event: JobReportEvent; data: Data; fact: boolean; worker_time: string }

async function scenario(seed: number, allowForceRelease: boolean) {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const f = hubFixture({ riskAck: random() > 0.3 });
  const target = await f.schedule(20 * MIN, `seed ${seed}`);
  const local = new Map<string, Local>();
  const outbox: Entry[] = [];
  const sent: Entry[] = [];
  const nextSeq = new Map<string, number>();
  const released: string[] = [];
  let online = true;
  let lastSync = Date.parse(f.ctx.now);
  let clicks = 0;
  let forced = false;
  let pause: Row | undefined;
  const now = () => Date.parse(f.ctx.now);
  const enqueue = (job: Local, event: JobReportEvent, data: Data = {}, fact = true) => {
    const key = `${job.id}:${job.fence}`;
    const seq = (nextSeq.get(key) ?? 0) + 1;
    nextSeq.set(key, seq);
    outbox.push({ job_id: job.id, fencing_token: job.fence, seq, event_id: randomUUID(), event, data: { event, ...data }, fact, worker_time: f.ctx.now });
  };
  const flush = () => {
    if (!online) return;
    for (let guard = 0; outbox.length && guard < 50; guard++) {
      const entry = outbox[0];
      try {
        reportJob(f.ctx, f.ctx.get('connector_device', f.device.id), entry as unknown as Data);
        sent.push(entry);
        outbox.shift();
      } catch (error) {
        const code = (error as Problem).code;
        if (code === 'JOB_FENCE_LOST') {
          for (let index = outbox.length - 1; index >= 0; index--) if (outbox[index].job_id === entry.job_id && !outbox[index].fact) outbox.splice(index, 1);
          if (outbox[0] === entry) outbox.shift();
          const job = local.get(entry.job_id);
          if (job && ['held', 'prepared'].includes(job.state)) job.state = 'released';
        } else if (code === 'SEQ_GAP') {
          const expected = Number((error as Problem).details?.expected);
          const pending = outbox.filter(item => item.job_id === entry.job_id && item.fencing_token === entry.fencing_token);
          pending.forEach((item, index) => { item.seq = expected + index; });
          nextSeq.set(`${entry.job_id}:${entry.fencing_token}`, expected + pending.length - 1);
        } else if (code === 'SEQ_CONFLICT') outbox.shift();
        else throw error;
      }
    }
  };
  const sync = () => {
    if (!online) return;
    const held = [...local.values()].filter(job => !['released', 'done'].includes(job.state)).map(job => job.id);
    const response = f.heartbeat(held, released.length ? { released_jobs: released.splice(0) } : {});
    lastSync = now();
    for (const state of response.jobs) {
      const job = local.get(state.job_id);
      if (job) { job.hold = state.hold; job.mode = state.mode; job.lastSync = now(); }
    }
    for (const revoked of response.revoked_jobs) {
      const job = local.get(revoked.job_id);
      if (!job) continue;
      job.revoked = true;
      if (job.state === 'held' || job.state === 'prepared') { job.state = 'released'; released.push(job.id); }
    }
    flush();
    for (const claimed of f.claim(held).jobs) {
      if (local.has(claimed.job_id)) continue;
      local.set(claimed.job_id, { id: claimed.job_id, fence: claimed.fencing_token, state: 'held', revoked: false, hold: false, mode: claimed.mode,
        notBefore: Date.parse(claimed.not_before), notAfter: Date.parse(claimed.not_after), staleness: claimed.offline_go_max_staleness_min * MIN, lastSync: now(), denied: false });
    }
  };
  const live = () => [...local.values()].filter(job => !['released', 'done'].includes(job.state));
  const actions: Record<string, () => void | Promise<void>> = {
    tick: () => f.advance(Math.floor(random() * 6 * MIN) + 15_000),
    sync,
    toggle: () => { online = !online; if (online) sync(); },
    prepare: () => { const job = live().find(item => item.state === 'held'); if (job) { job.state = 'prepared'; enqueue(job, 'prepared', { stage: 'final', login: 'verified', identity: 'lurelab', handle: 'lurelab', media_ok: true, driver: {} }, false); flush(); } },
    go: () => {
      const job = live().find(item => item.state === 'prepared' && now() >= item.notBefore - MIN);
      if (!job) return;
      if (now() > job.notAfter) { job.state = 'done'; enqueue(job, 'missed', { reason: 'late' }, false); flush(); return; }
      if (online) {
        const answer = f.go(job.id, { fence: job.fence });
        if (answer.go) { job.state = 'running'; job.mode = answer.mode; enqueue(job, 'started', { go: 'hub', mode: answer.mode }); flush(); return; }
        if (answer.reason !== 'too_early') job.denied = true;
        if (answer.release) { job.state = 'released'; if (!['daily_cap_reached', 'outside_window'].includes(answer.reason)) enqueue(job, 'released', {}, false); flush(); }
        return;
      }
      // §5.7 offline rules: the last sync is fresh enough, in the window, last synced hold false, never denied, not revoked.
      if (now() >= job.notBefore && now() - lastSync <= job.staleness && !job.hold && !job.denied && !job.revoked) {
        job.state = 'running';
        enqueue(job, 'started', { go: 'offline', mode: job.mode });
      }
    },
    click: () => {
      const job = live().find(item => item.state === 'running');
      if (!job) return;
      if (job.revoked) { job.state = 'released'; enqueue(job, 'released', {}, false); flush(); return; }
      if (job.mode === 'assist' && random() < 0.5) return;   // waiting for the owner to click on the machine
      job.state = 'clicked';
      clicks++;
      enqueue(job, 'submitting');
      enqueue(job, 'submitted', {});
      if (random() < 0.8) enqueue(job, 'result', { url: `https://x.com/lurelab/status/${1000 + clicks}`, external_post_id: String(1000 + clicks), published_at: f.ctx.now,
        evidence_sha256: [], submitted_by: job.mode === 'assist' ? 'owner' : 'auto', go: 'hub' });
      else enqueue(job, 'outcome_unknown', { reason: 'readback_exhausted', evidence_sha256: [] });
      job.state = 'done';
      flush();
    },
    reschedule: () => {
      const row = f.ctx.get('publish_target', target.id);
      if (row.plan_status !== 'ready') return;
      try { updateTarget(f.ctx, row, { scheduled_at: new Date(Math.max(now() + MIN, Date.parse(String(row.scheduled_at)) + Math.floor(random() * 20 - 10) * MIN)).toISOString() }, true); }
      catch (error) { if (!['LEASE_HELD', 'INVALID_INPUT', 'INVALID_STATE'].includes((error as Problem).code)) throw error; }
    },
    cancel: () => {
      const row = f.ctx.get('publish_target', target.id);
      try { cancel(f.ctx, row); }
      catch (error) { if (!['POST_LOCKED', 'POST_RESULT_UNKNOWN', 'INVALID_STATE', 'CONFLICT'].includes((error as Problem).code)) throw error; }
    },
    pause: () => {
      try {
        if (pause) { f.run('publishing_release_pause', {}, { id: pause.id }); pause = undefined; }
        else pause = f.run('publishing_pause', { scope_type: 'social_account', scope_id: f.account.id, reason: 'property' }) as Row;
      } catch (error) { if ((error as Problem).status !== 409) throw error; }
    },
    lifecycle: () => f.lifecycle(),
    duplicate: () => {
      const entry = sent.length ? pick(sent) : undefined;
      if (!entry || !online) return;
      const before = JSON.stringify([f.ctx.list(JOB), f.ctx.list('worker_job_event').length, f.ctx.list('execution_task')]);
      const answer = reportJob(f.ctx, f.ctx.get('connector_device', f.device.id), entry as unknown as Data);
      assert.deepEqual(answer, { status: 'duplicate' }, `seed ${seed}: a resent event_id is a duplicate`);
      assert.equal(JSON.stringify([f.ctx.list(JOB), f.ctx.list('worker_job_event').length, f.ctx.list('execution_task')]), before, `seed ${seed}: processing an event_id twice equals once`);
    },
    force: () => {
      if (!allowForceRelease) return;
      // E36 (wave 6): only a job the hub never saw start can be force-released (others answer 409 POSSIBLY_SENT).
      const job = f.ctx.list(JOB).find(row => ['releasing', 'unreported'].includes(String(row.status)) && !hubSawStart(row));
      if (!job) return;
      f.run('hub_jobs_force_release', { confirm_text: '我確認 Mac-B 已關機或已斷網，不會發出這則貼文。' }, { id: job.id });
      forced = true;
    },
  };
  const weights: [string, number][] = [['tick', 5], ['sync', 4], ['toggle', 1.2], ['prepare', 3], ['go', 4], ['click', 3], ['reschedule', 1.5], ['cancel', 0.4],
    ['pause', 0.6], ['lifecycle', 2], ['duplicate', 1], ['force', allowForceRelease ? 1 : 0]];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (let step = 0; step < 120; step++) {
    let roll = random() * total;
    const name = weights.find(([, weight]) => (roll -= weight) < 0)?.[0] ?? 'tick';
    await actions[name]();
    if (!forced) {
      const sentJobs = f.ctx.list(JOB).filter(row => row.publish_target_id === target.id && possiblySent(row as unknown as WorkerJobRecord));
      assert.ok(sentJobs.length <= 1, `seed ${seed} step ${step} (${name}): two possibly-sent jobs ${sentJobs.map(row => `${row.id}:${row.status}`).join(', ')}`);
      assert.ok(clicks <= 1, `seed ${seed} step ${step} (${name}): the platform received ${clicks} posts`);
    }
  }
  // Drain: the machine comes back, delivers every fact, and the lifecycle settles.
  online = true;
  for (let round = 0; round < 6; round++) { sync(); f.advance(20 * MIN); f.lifecycle(); }
  if (!forced) {
    assert.ok(clicks <= 1, `seed ${seed}: at most one platform post`);
    const posts = f.ctx.list('platform_post').filter(row => row.publish_target_id === target.id);
    assert.ok(posts.length <= 1, `seed ${seed}: at most one platform_post`);
    // A predecessor that succeeded after its revoke never lets a successor post a second time.
    const succeeded = f.ctx.list(JOB).filter(row => row.publish_target_id === target.id && row.status === 'succeeded');
    assert.ok(succeeded.length <= 1, `seed ${seed}: one succeeded job`);
  }
  const events = f.ctx.list('worker_job_event').map(row => String(row.event));
  return { clicks, forced, jobs: f.ctx.list(JOB).length, events,
    offline: f.ctx.list('worker_job_event').some(row => row.event === 'started' && (row.detail as Data).go === 'offline') };
}

test('§5.11 no-repost invariants hold for random sequences of revokes, offline facts, late facts, pauses, reschedules and duplicate reports', async () => {
  const outcomes = { clicked: 0, multiJob: 0, offline: 0, released: 0, lateFact: 0, cancelledSuccessor: 0, duplicates: 0 };
  for (let seed = 1; seed <= 160; seed++) {
    const result = await scenario(seed, false);
    if (result.clicks) outcomes.clicked++;
    if (result.jobs > 1) outcomes.multiJob++;
    if (result.offline) outcomes.offline++;
    if (result.events.includes('successor_released')) outcomes.released++;
    if (result.events.includes('late_fact_after_release')) outcomes.lateFact++;
    if (result.events.includes('successor_cancelled_predecessor_posted')) outcomes.cancelledSuccessor++;
  }
  assert.ok(outcomes.offline > 10, `offline runs reached in ${outcomes.offline} runs`);
  assert.ok(outcomes.released > 10 && outcomes.cancelledSuccessor > 0, `successor release ${outcomes.released} / auto-cancel ${outcomes.cancelledSuccessor}`);
  // The generator must actually reach posting and successor jobs, or the property says nothing.
  assert.ok(outcomes.clicked > 20, `posting reached in ${outcomes.clicked} runs`);
  assert.ok(outcomes.multiJob > 20, `successor jobs reached in ${outcomes.multiJob} runs`);
});

test('§5.11: with force_release the owner takes the risk, and every later fact is still recorded (no crash, at most two posts)', async () => {
  let forced = 0;
  let late = 0;
  for (let seed = 500; seed < 620; seed++) {
    const result = await scenario(seed, true);
    assert.ok(result.clicks <= 2, `seed ${seed}: ${result.clicks}`);
    if (result.forced) forced++;
    if (result.events.includes('late_fact_after_release')) late++;
  }
  assert.ok(forced > 5, `force_release reached in ${forced} runs`);
  assert.ok(late > 0, `a late fact after a forced release reached in ${late} runs`);
});
