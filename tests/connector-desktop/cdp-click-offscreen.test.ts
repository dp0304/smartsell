// Regression (S8 fix loop, found by E2E-1): a Post button that no mouse event can reach must never count as a click.
// CdpPage.#clickPoint used to swallow the failed hit test (DOM.getNodeForLocation errors for a point outside the
// viewport), so the X driver "clicked" a button below a fixed dialog, waited for a result that could not come and the
// hub ended at outcome_unknown. Now the driver stops before onBeforeClick with driver_outdated (before_submit).
// The second case runs the §10.2 portrait clip (1080x1920): the fixture composer scrolls like X's, and the post goes out.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { CdpPage, DriverBlocker, PublishOptions } from '../../apps/connector-desktop/src/drivers/types.ts';
import { XDriver } from '../../apps/connector-desktop/src/drivers/x.ts';
import type { ProfileLease } from '../../apps/connector-desktop/src/runtime/profiles.ts';
import { startPlatformFixtures, type PlatformFixtures } from '../fixtures/platforms/server.ts';
import { e2eClip, ffmpegPath } from '../e2e-phase1/video.ts';
import { chromePathSync, ChromeHarness, makeClip, publishJob } from './fakes/driver-harness.ts';

const executable = chromePathSync();

function options() {
  const state = { clicks: 0 };
  const value: PublishOptions = {
    dryRun: false, mode: 'auto', revoked: () => false, ownerWaitUntil: Date.now() + 60_000,
    onBeforeClick: async () => { state.clicks += 1; return true; }, onOwnerWait: async (_blocker: DriverBlocker) => {},
  };
  return Object.assign(value, { state });
}

describe('X driver: an unreachable Post button is never clicked', { skip: executable ? false : 'Google Chrome is not installed', concurrency: false }, () => {
  let fixtures: PlatformFixtures;
  let harness: ChromeHarness;
  let lease: ProfileLease;
  const driver = new XDriver();

  before(async () => {
    fixtures = await startPlatformFixtures({ uploadMs: 300, xProcessingMs: 300 });
    harness = new ChromeHarness(fixtures, executable!);
    lease = await harness.profiles.acquire('ch-cccccccccccc');
  });
  after(async () => { lease?.release(); await harness?.close(); await fixtures?.close(); });

  test('post_offscreen: blocked driver_outdated at x.post_button before onBeforeClick; nothing reaches the platform', async () => {
    fixtures.reset();
    fixtures.setScenario('x', 'post_offscreen');
    const clip = makeClip(harness.dir);
    await lease.page.goto('about:blank');
    const ctx = harness.context('x', lease.page as CdpPage, 'fixture_x', [clip.path], { readyTimeoutMs: 8000 });
    const o = options();
    const outcome = await driver.publish(ctx, publishJob('x', clip), o);
    assert.equal(outcome.kind, 'blocked', JSON.stringify(outcome));
    assert.equal(outcome.kind === 'blocked' && outcome.blocker.code, 'driver_outdated');
    assert.equal(outcome.kind === 'blocked' && outcome.blocker.phase, 'before_submit');
    assert.equal(outcome.kind === 'blocked' && outcome.blocker.step, 'x.post_button');
    assert.equal(o.state.clicks, 0, 'onBeforeClick was not reached, so the runner never wrote submitting');
    assert.equal(fixtures.events().filter(event => event.event === 'post_clicked').length, 0);
    assert.equal(fixtures.posts().length, 0);
  });

  test('a real 1080x1920 clip: the composer scrolls, the button is reached once and the post is created', { skip: ffmpegPath() ? false : 'ffmpeg is not installed' }, async () => {
    fixtures.reset();
    const clip = await e2eClip(harness.dir, 'portrait.mp4');
    await lease.page.goto('about:blank');
    const ctx = harness.context('x', lease.page as CdpPage, 'fixture_x', [clip.path], { readyTimeoutMs: 8000 });
    const o = options();
    const outcome = await driver.publish(ctx, publishJob('x', clip), o);
    assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
    assert.equal(o.state.clicks, 1);
    assert.ok(outcome.kind === 'submitted' && outcome.hint.external_post_id, 'the CreateTweet result was read');
    assert.equal(fixtures.posts().length, 1);
    assert.equal(fixtures.posts()[0].media_sha256, clip.sha256);
  });
});
