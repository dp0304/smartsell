// WA-8 (§8.17): a job whose filled draft waits for the owner's Post click (assist, or a caption handed over) stays in
// `running` on the Worker, but it needs the owner: the row gets 「開啟該 Chrome 處理」, the channel and the tray say so, and
// the OS notification opens that job's Chrome.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Notifier, type NotifyInput } from '../../../apps/connector-desktop/src/app/notify.ts';
import { needsOwner, WorkerShell, type WorkerShellDeps } from '../../../apps/connector-desktop/src/app/worker-mode.ts';
import type { LocalJobView } from '../../../apps/connector-desktop/src/runtime/events.ts';

const view = (state: string, code: string | null): LocalJobView => ({
  job_id: 'job-1', kind: 'publish_post', provider: 'tiktok', channel_label: 'TikTok @lurelab', state, not_before: '2026-11-25T01:00:00.000Z',
  not_after: '2026-11-25T01:30:00.000Z', blocker: code ? { code, message: 'm' } : null, dry_run: false, social_account_id: 'sa-1', profile_key: 'ch-aaaaaaaaaaaa',
});

test('WA-8: needs_owner follows the blocker, not only the blocked state', () => {
  assert.equal(needsOwner(view('running', 'owner_click_required')), true, 'assist draft waiting for the Post click');
  assert.equal(needsOwner(view('running', 'caption_rejected')), true, 'caption handed to the owner');
  assert.equal(needsOwner(view('blocked', 'captcha')), true);
  assert.equal(needsOwner(view('blocked', 'owner_stopped')), false, 'the emergency stop is answered with the App\'s 「恢復」');
  assert.equal(needsOwner(view('running', null)), false);
  assert.equal(needsOwner(view('ready', null)), false);
});

function shell(notified: NotifyInput[], log: string[]) {
  const deps = {
    power: { onJobsHeld() {}, release() {} }, notifier: { notify: (input: NotifyInput) => { notified.push(input); return true; } },
    onChange() {}, log: (message: string) => { log.push(message); },
    posture: { current: () => null, remote: () => null, start() {}, stop() {} }, autostart: { enabled: () => false, set: () => true },
    hostname: 'Mac-B.local',
  } as unknown as WorkerShellDeps;
  return new WorkerShell(deps);
}

test('WA-8: the shell marks an owner-click wait as needing the owner, and the channel row as blocked', () => {
  const notified: NotifyInput[] = [];
  const s = shell(notified, []);
  s.events.emit('jobs_changed', { jobs: [view('running', 'owner_click_required')] });
  const snap = s.snapshot();
  assert.equal(snap.jobs[0].needs_owner, true);
});

test('WA-8: an owner_click alert for a job opens that job\'s Chrome when clicked (no web_url needed)', async () => {
  const notified: NotifyInput[] = [];
  const log: string[] = [];
  const s = shell(notified, log);
  s.events.emit('local_alert', { kind: 'owner_click', title: 'TikTok @lurelab 需要你處理', body: '…', web_url: null, job_id: 'job-1' });
  s.events.emit('local_alert', { kind: 'missed', title: 'x', body: 'y', web_url: null, job_id: 'job-1' });
  assert.equal(typeof notified[0].action, 'function');
  assert.equal(notified[1].action, undefined, 'a missed post has nothing to open on this machine');
  notified[0].action!();
  await new Promise(done => setImmediate(done));
  assert.ok(log.includes('open job chrome failed'), 'not paired here: the failure is logged, never thrown into the notification');
});

test('WA-8: Notifier runs the click action when there is no web_url', () => {
  let clicked = 0;
  let listener: (() => void) | undefined;
  const notifier = new Notifier({ supported: () => true, open: () => { throw new Error('no url expected'); },
    create: () => ({ show() {}, on(_event: 'click', fn: () => void) { listener = fn; } }) });
  assert.equal(notifier.notify({ title: 't', body: 'b', action: () => { clicked += 1; } }), true);
  listener!();
  assert.equal(clicked, 1);
});
