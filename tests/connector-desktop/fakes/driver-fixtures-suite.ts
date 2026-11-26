// X and TikTok driver suites against the fixture platform pages (§8.15), for either transport: headless stock Chrome over the
// CDP pipe (skipped when Google Chrome is not installed) and the owner's own Chrome through the SmartSell extension
// (core-automation-proposal §3.2; Playwright Chromium with the real extension). Only 127.0.0.1 fixture origins are
// reachable (navigation allowlist).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TikTokDriver } from '../../../apps/connector-desktop/src/drivers/tiktok.ts';
import type { CdpPage, DriverBlocker, DriverContext, PublishOptions } from '../../../apps/connector-desktop/src/drivers/types.ts';
import { XDriver } from '../../../apps/connector-desktop/src/drivers/x.ts';
import type { ProfileLease } from '../../../apps/connector-desktop/src/runtime/profiles.ts';
import { startPlatformFixtures, type PlatformFixtures, type Scenario } from '../../fixtures/platforms/server.ts';
import { chromePathSync, ChromeHarness, makeClip, publishJob, type Transport } from './driver-harness.ts';
import { ownChromeUnavailable } from '../own-chrome-browser.ts';

const executable = chromePathSync();
const skipFor: Record<Transport, string | false> = {
  pipe: executable ? false : 'Google Chrome is not installed',
  own_chrome: ownChromeUnavailable() ?? false,
};

function opts(overrides: Partial<PublishOptions> = {}) {
  const state = { clicks: 0, ownerWaits: [] as DriverBlocker[] };
  const value: PublishOptions = {
    dryRun: false, mode: 'auto', revoked: () => false, ownerWaitUntil: Date.now() + 60_000,
    onBeforeClick: async () => { state.clicks += 1; return true; }, onOwnerWait: async blocker => { state.ownerWaits.push(blocker); }, ...overrides,
  };
  return Object.assign(value, { state });
}

/** Registers the X and TikTok fixture suites for one transport (drivers-fixtures*.test.ts). */
export function driverFixtureSuites(transport: Transport) {
for (const provider of ['x', 'tiktok'] as const) {
  describe(`${provider} driver on fixture pages${transport === 'own_chrome' ? ' (own Chrome via the extension)' : ''}`, { skip: skipFor[transport], concurrency: false }, () => {
    let fixtures: PlatformFixtures;
    let harness: ChromeHarness;
    let lease: ProfileLease;
    let clip: ReturnType<typeof makeClip>;
    const driver = provider === 'x' ? new XDriver() : new TikTokDriver();
    const expected = provider === 'x' ? 'fixture_x' : '7234567890123456789';
    const profile = provider === 'x' ? 'ch-aaaaaaaaaaaa' : 'ch-bbbbbbbbbbbb';

    before(async () => {
      fixtures = await startPlatformFixtures({ slowUploadMs: 7000, uploadMs: 800, xProcessingMs: 800 });
      harness = await ChromeHarness.create(transport, fixtures, executable);
      clip = makeClip(harness.dir);
      lease = await harness.profiles.acquire(profile);
    });
    after(async () => { lease?.release(); await harness?.close(); await fixtures?.close(); });

    async function fresh(scenario: Scenario) {
      fixtures.reset();
      fixtures.setScenario(provider, scenario);
      await lease.page.goto('about:blank');
      return { ctx: harness.context(provider, lease.page as CdpPage, expected, [clip.path], { readyTimeoutMs: 8000 }) as DriverContext, job: publishJob(provider, clip) };
    }
    const own = () => fixtures.posts().filter(post => post.platform === provider);

    test('ok: login, prepare, one click, read-back finds the URL, media hash matches', async () => {
      const { ctx, job } = await fresh('ok');
      assert.equal((await driver.checkLogin(ctx)).state, 'verified');
      assert.equal((await driver.prepare(ctx, job)).ok, true);
      const o = opts();
      const outcome = await driver.publish(ctx, job, o);
      assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
      assert.equal(o.state.clicks, 1);
      const found = await driver.readBack(ctx, job, { ...(outcome.kind === 'submitted' ? outcome.hint : {}), submittedAt: Date.now() - 5000, captionPrefix: 'New lure test' });
      assert.equal(found.kind, 'found', JSON.stringify(found));
      assert.match(found.kind === 'found' ? found.url : '', provider === 'x' ? /^https:\/\/x\.com\/fixture_x\/status\/\d+$/ : /^https:\/\/www\.tiktok\.com\/@fixture_tt\/video\/\d+$/);
      assert.equal(own().length, 1);
      assert.equal(own()[0].media_sha256, clip.sha256);
      assert.equal(own()[0].text.trim(), 'New lure test 🎣 #fishing #lure');
      if (provider === 'tiktok') assert.deepEqual([own()[0].options?.privacy_level, own()[0].options?.allow_comment, own()[0].options?.allow_reuse], ['SELF_ONLY', true, false]);
      assert.ok(ctx.trace.every(step => step.matched !== 'none'), JSON.stringify(ctx.trace));
    });

    test('zh_hant: Traditional Chinese labels still publish', async () => {
      const { ctx, job } = await fresh('zh_hant');
      assert.equal((await driver.prepare(ctx, job)).ok, true);
      const outcome = await driver.publish(ctx, job, opts());
      assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
      assert.equal(own().length, 1);
    });

    test('dry run: no post, draft discarded', async () => {
      const { ctx, job } = await fresh('ok');
      const o = opts({ dryRun: true });
      const outcome = await driver.publish(ctx, job, o);
      assert.equal(outcome.kind, 'dry_run_done', JSON.stringify(outcome));
      assert.equal(o.state.clicks, 0);
      assert.equal(own().length, 0);
      // The page reports the discard asynchronously.
      for (let wait = 0; wait < 20 && !fixtures.events().some(event => event.event === 'discarded'); wait++) await new Promise(done => setTimeout(done, 100));
      assert.ok(fixtures.events().some(event => event.event === 'discarded'));
    });

    test('login_expired: stops, then continues once the owner signed in (no navigation by the driver while waiting)', async () => {
      const { ctx, job } = await fresh('login_expired');
      assert.equal((await driver.checkLogin(ctx)).state, 'login_required');
      const prepared = await driver.prepare(ctx, job);
      assert.equal(!prepared.ok && prepared.blocker.code, 'login_expired');
      assert.match(!prepared.ok ? prepared.blocker.message : '', /登入已過期/);
      const loads = fixtures.pageLoads();
      assert.equal(await driver.awaitBlockerCleared(ctx, (prepared as { blocker: DriverBlocker }).blocker, Date.now() + 1500), false);
      assert.deepEqual(fixtures.pageLoads(), loads, 'no reload while waiting');
      fixtures.setScenario(provider, 'ok');
      assert.equal(await driver.awaitBlockerCleared(ctx, (prepared as { blocker: DriverBlocker }).blocker, Date.now() + 8000), true);
      assert.equal((await driver.prepare(ctx, job)).ok, true);
    });

    test('captcha: stops, never touches it, continues without a reload when it disappears', async () => {
      const { ctx, job } = await fresh('captcha');
      const prepared = await driver.prepare(ctx, job);
      assert.equal(!prepared.ok && prepared.blocker.code, 'captcha');
      assert.ok((prepared as { blocker: DriverBlocker }).blocker.evidence_sha256?.length, 'screenshot first');
      const loads = fixtures.pageLoads();
      assert.equal(await driver.awaitBlockerCleared(ctx, (prepared as { blocker: DriverBlocker }).blocker, Date.now() + 1500), false);
      fixtures.setScenario(provider, 'ok');
      assert.equal(await driver.awaitBlockerCleared(ctx, (prepared as { blocker: DriverBlocker }).blocker, Date.now() + 8000), true);
      assert.deepEqual(fixtures.pageLoads(), loads, 'the challenge page was never reloaded');
      if (provider === 'x') {
        assert.equal((await driver.prepare(ctx, job)).ok, true);
        assert.deepEqual(fixtures.pageLoads(), loads, 'X continues on the same compose page');
      }
    });

    test('two_factor: stops and continues after verification', async () => {
      const { ctx, job } = await fresh('two_factor');
      const prepared = await driver.prepare(ctx, job);
      assert.equal(!prepared.ok && prepared.blocker.code, 'two_factor');
      fixtures.setScenario(provider, 'ok');
      assert.equal(await driver.awaitBlockerCleared(ctx, (prepared as { blocker: DriverBlocker }).blocker, Date.now() + 8000), true);
    });

    test('outdated: driver_outdated with the failing step, nothing posted', async () => {
      const { ctx, job } = await fresh('outdated');
      const prepared = await driver.prepare(ctx, job);
      if (provider === 'x') {
        assert.deepEqual(!prepared.ok && [prepared.blocker.code, prepared.blocker.step], ['driver_outdated', 'x.ready']);
        assert.ok(!prepared.ok && prepared.blocker.ax_hash);
        return;
      }
      assert.equal(prepared.ok, true);
      const outcome = await driver.publish(ctx, job, opts());
      assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.step, outcome.blocker.phase], ['driver_outdated', 'tt.visibility', 'before_submit']);
      assert.equal(own().length, 0);
    });

    test('slow_upload: waits for processing instead of trusting the enabled button', async () => {
      const { ctx, job } = await fresh('slow_upload');
      const started = Date.now();
      const outcome = await driver.publish(ctx, job, opts());
      assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
      assert.ok(Date.now() - started >= 7000);
      assert.equal(own().length, 1);
    });

    test('no_toast: created without a confirmation, found by read-back', async () => {
      const { ctx, job } = await fresh('no_toast');
      const outcome = await driver.publish(ctx, job, opts());
      assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
      const found = await driver.readBack(ctx, job, { ...(outcome.kind === 'submitted' ? outcome.hint : {}), submittedAt: Date.now() - 10_000, captionPrefix: 'New lure test' });
      assert.equal(found.kind, 'found', JSON.stringify(found));
    });

    test('created_hidden: submitted but not readable → not_yet (the runner later reports outcome_unknown); only one post exists', async () => {
      const { ctx, job } = await fresh('created_hidden');
      const outcome = await driver.publish(ctx, job, opts());
      assert.equal(outcome.kind, 'submitted');
      assert.deepEqual(await driver.readBack(ctx, job, { submittedAt: Date.now() - 10_000, captionPrefix: 'New lure test' }), { kind: 'not_yet' });
      assert.equal(fixtures.posts().length, 1);
    });

    test('post_error_not_created: stops after submit, no retry, nothing created', async () => {
      const { ctx, job } = await fresh('post_error_not_created');
      const o = opts();
      const outcome = await driver.publish(ctx, job, o);
      assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.phase], ['platform_error', 'after_submit']);
      assert.equal(o.state.clicks, 1);
      assert.equal(own().length, 0);
      if (provider === 'tiktok') assert.equal(fixtures.events().filter(event => event.event === 'post_clicked').length, 1);
    });

    test('handle_changed: identity follows the platform rule', async () => {
      const { ctx, job } = await fresh('handle_changed');
      const login = await driver.checkLogin(ctx);
      if (provider === 'x') {
        assert.equal(login.state, 'identity_mismatch');
        const prepared = await driver.prepare(ctx, job);
        assert.equal(!prepared.ok && prepared.blocker.code, 'identity_mismatch');
      } else {
        // TikTok identity is the numeric User ID; a new @handle is only reported.
        assert.deepEqual([login.state, login.handle], ['verified', 'fixture_tt2']);
      }
    });

    test('assist: the owner clicks Post on this machine', async () => {
      const { ctx, job } = await fresh('ok');
      const o = opts({ mode: 'assist', onOwnerWait: async blocker => { o.state.ownerWaits.push(blocker); fixtures.ownerClick(provider); } });
      const outcome = await driver.publish(ctx, job, o);
      assert.deepEqual(outcome.kind === 'submitted' && outcome.submitted_by, 'owner', JSON.stringify(outcome));
      assert.equal(o.state.ownerWaits[0]?.code, 'owner_click_required');
      assert.equal(o.state.clicks, 0);
      assert.equal(own().length, 1);
    });

    test('challenge_after_post: a captcha after the click stops the driver (after_submit, never touched, no retry, no navigation)', async () => {
      const { ctx, job } = await fresh('challenge_after_post');
      const o = opts();
      const outcome = await driver.publish(ctx, job, o);
      assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.phase], ['captcha', 'after_submit'], JSON.stringify(outcome));
      assert.match(outcome.kind === 'blocked' ? outcome.blocker.message : '', /按下發布後出現驗證碼.*不會自動重發.*可能已經發出/, 'no promise to continue on its own');
      assert.equal(o.state.clicks, 1);
      assert.equal(fixtures.events().filter(event => event.event === 'post_clicked').length, 1, 'Post was clicked once and never again');
      assert.equal(own().length, 0);
      const loads = fixtures.pageLoads();
      assert.equal(await driver.awaitBlockerCleared(ctx, (outcome as { blocker: DriverBlocker }).blocker, Date.now() + 1200), false);
      assert.deepEqual(fixtures.pageLoads(), loads, 'observation never reloads or navigates');
    });

    if (provider === 'x') {
      test('grok_overlay: a panel over the composer is closed with one Escape (no discard), then the post goes out once', async () => {
        const { ctx, job } = await fresh('grok_overlay');
        const o = opts();
        const outcome = await driver.publish(ctx, job, o);
        assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
        assert.equal(o.state.clicks, 1);
        assert.equal(fixtures.events().filter(event => event.event === 'grok_closed').length, 1);
        assert.ok(!fixtures.events().some(event => event.event === 'discarded'), 'Escape closed the panel, not the draft');
        assert.equal(own().length, 1);
        assert.equal(own()[0].media_sha256, clip.sha256, 'media attached after the panel closed');
      });

      test('E40: "Who can reply" is set in the composer and the post carries it (English and zh-Hant labels)', async () => {
        for (const [scenario, reply] of [['ok', 'following'], ['zh_hant', 'mentioned']] as const) {
          const { ctx } = await fresh(scenario);
          const job = publishJob('x', clip, { options: { x: { reply_settings: reply } } });
          const o = opts();
          const outcome = await driver.publish(ctx, job, o);
          assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
          assert.equal(o.state.clicks, 1);
          assert.equal(own()[0]?.options?.reply_settings, reply, scenario);
        }
      });

      test('E40: a composer without the "Who can reply" control stops as driver_outdated before the click; nothing posted', async () => {
        const { ctx } = await fresh('reply_control_missing');
        const o = opts();
        const outcome = await driver.publish(ctx, publishJob('x', clip, { options: { x: { reply_settings: 'verified' } } }), o);
        assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.step, outcome.blocker.phase], ['driver_outdated', 'x.reply_settings', 'before_submit']);
        assert.equal(o.state.clicks, 0);
        assert.equal(own().length, 0);
      });

      test('WA-10: assist — the owner clicked Post and X refused it → after_submit platform_error, not "not clicked"; the draft is kept', async () => {
        const { ctx, job } = await fresh('post_error_not_created');
        // The wait ends 8 s after it began: long enough for the owner's click and X's answer, and well before not_after.
        const o = opts({ mode: 'assist', onOwnerWait: async blocker => { o.state.ownerWaits.push(blocker); o.ownerWaitUntil = Date.now() + 8000; fixtures.ownerClick('x'); } });
        const outcome = await driver.publish(ctx, job, o);
        assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.phase], ['platform_error', 'after_submit'], JSON.stringify(outcome));
        assert.ok(!fixtures.events().some(event => event.event === 'discarded'));
        assert.equal(own().length, 0);
      });

      test('WA-10: assist — a refused first click does not hide the owner\'s second, successful click', async () => {
        const { ctx, job } = await fresh('post_error_once');
        const o = opts({ mode: 'assist', ownerWaitUntil: Date.now() + 20_000, onOwnerWait: async () => { fixtures.ownerClick('x'); fixtures.ownerClick('x'); } });
        const outcome = await driver.publish(ctx, job, o);
        assert.deepEqual(outcome.kind === 'submitted' && [outcome.submitted_by, outcome.hint.external_post_id], ['owner', own()[0]?.id], JSON.stringify(outcome));
        assert.equal(own().length, 1);
      });

      test('text_rejected: editor refuses program input → handed to the owner, never clicked by the driver', async () => {
        const { ctx, job } = await fresh('text_rejected');
        const o = opts({ ownerWaitUntil: Date.now() + 3000 });
        const outcome = await driver.publish(ctx, job, o);
        assert.equal(o.state.ownerWaits[0]?.code, 'caption_rejected');
        assert.equal(outcome.kind === 'blocked' && outcome.blocker.code, 'caption_rejected');
        assert.equal(o.state.clicks, 0);
        assert.equal(own().length, 0);
      });
    } else {
      test('popups: dismissed without changing account settings', async () => {
        const { ctx, job } = await fresh('popups');
        const outcome = await driver.publish(ctx, job, opts());
        assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
        assert.ok(!fixtures.events().some(event => event.event === 'account_setting_changed'));
      });
      test('cookie_banner: only optional cookies are declined (shadow-DOM banner), never "Allow all"', async () => {
        const { ctx, job } = await fresh('cookie_banner');
        const outcome = await driver.publish(ctx, job, opts());
        assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
        assert.deepEqual(fixtures.events().filter(event => event.event.startsWith('cookies_')).map(event => event.event), ['cookies_essential_only']);
        assert.equal(own().length, 1);
      });

      test('legacy_iframe: the older iframe layout is recognised (fallback) and stops as driver_outdated before any upload', async () => {
        const { ctx, job } = await fresh('legacy_iframe');
        const prepared = await driver.prepare(ctx, job);
        assert.deepEqual(!prepared.ok && [prepared.blocker.code, prepared.blocker.step], ['driver_outdated', 'tt.ready']);
        const o = opts();
        const outcome = await driver.publish(ctx, job, o);
        assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.step, outcome.blocker.phase], ['driver_outdated', 'tt.ready', 'before_submit']);
        assert.ok(ctx.trace.some(step => step.step === 'tt.ready' && step.matched === 'fallback'), JSON.stringify(ctx.trace));
        assert.ok(!fixtures.events().some(event => event.event === 'legacy_upload_started'), 'no video is put into a form the driver cannot finish');
        assert.equal(o.state.clicks, 0);
        assert.equal(own().length, 0);
      });

      test('disclosure and AI label: Show more, "Your brand" on, "Branded content" off, AI switch confirmed with Turn on; privacy and comments read back', async () => {
        const { ctx } = await fresh('ok');
        const job = publishJob('tiktok', clip, { options: { tiktok: { privacy_level: 'MUTUAL_FOLLOW_FRIENDS', allow_comment: false, allow_duet: true, allow_stitch: true,
          commercial_disclosure: 'your_brand', ai_generated: true } } });
        const outcome = await driver.publish(ctx, job, opts());
        assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
        const options = own()[0]?.options ?? {};
        assert.deepEqual([options.privacy_level, options.allow_comment, options.allow_reuse, options.brand, options.branded, options.ai_generated],
          ['MUTUAL_FOLLOW_FRIENDS', false, true, true, false, true]);
        for (const step of ['tt.visibility', 'tt.allow_comment', 'tt.allow_reuse', 'tt.disclosure', 'tt.disclosure_your_brand', 'tt.disclosure_branded']) {
          assert.ok(ctx.trace.some(item => item.step === step && item.matched !== 'none'), `${step}: ${JSON.stringify(ctx.trace)}`);
        }
      });

      test('post_error_not_created: the owner is told the video is uploaded and to click Post; the window is not navigated away', async () => {
        const { ctx, job } = await fresh('post_error_not_created');
        const outcome = await driver.publish(ctx, job, opts());
        assert.equal(outcome.kind === 'blocked' && outcome.blocker.code, 'platform_error');
        assert.match(outcome.kind === 'blocked' ? outcome.blocker.message : '', /影片已上傳.*TikTok Studio.*自己按「發布」.*不會自動重發/);
        assert.match(outcome.kind === 'blocked' ? outcome.blocker.message : '', /Permission Denied/);
        assert.match(await lease.page.url(), /\/tiktokstudio\/upload/);
      });

      test('WA-1: read-back never claims an older video with the same caption (Studio rows without a readable time)', async () => {
        const { ctx, job } = await fresh('created_hidden');
        fixtures.setContentRowTimes(false);
        const older = fixtures.seedPost({ platform: 'tiktok', text: 'New lure test 🎣 #fishing #lure' });
        const outcome = await driver.publish(ctx, job, opts());
        assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
        assert.deepEqual(outcome.kind === 'submitted' && outcome.hint.known_ids, [older.id], 'the list was read before the upload');
        const seen = await driver.readBack(ctx, job, { ...(outcome.kind === 'submitted' ? outcome.hint : {}), submittedAt: Date.now() - 5000, captionPrefix: 'New lure test' });
        assert.deepEqual(seen, { kind: 'not_yet' });
      });

      test('WA-1: with rows that carry no time, the new video is found by its new id', async () => {
        const { ctx, job } = await fresh('ok');
        fixtures.setContentRowTimes(false);
        const older = fixtures.seedPost({ platform: 'tiktok', text: 'New lure test 🎣 #fishing #lure' });
        const outcome = await driver.publish(ctx, job, opts());
        assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
        const seen = await driver.readBack(ctx, job, { ...(outcome.kind === 'submitted' ? outcome.hint : {}), submittedAt: Date.now() - 5000, captionPrefix: 'New lure test' });
        const created = own().find(post => post.id !== older.id)!;
        assert.equal(seen.kind === 'found' && seen.external_post_id, created.id, JSON.stringify(seen));
      });

      test('WA-1: an empty caption never matches an older captionless video', async () => {
        const { ctx } = await fresh('created_hidden');
        fixtures.setContentRowTimes(false);
        fixtures.seedPost({ platform: 'tiktok', text: '' });
        const job = publishJob('tiktok', clip, { caption: { text: '', title: null } });
        const outcome = await driver.publish(ctx, job, opts());
        assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
        const seen = await driver.readBack(ctx, job, { ...(outcome.kind === 'submitted' ? outcome.hint : {}), submittedAt: Date.now() - 5000, captionPrefix: '' });
        assert.deepEqual(seen, { kind: 'not_yet' });
      });

      test('WA-5: a rejected caption is handed over only after privacy and comments are set; the owner\'s post is Only me', async () => {
        const { ctx, job } = await fresh('text_rejected');
        const o = opts({ ownerWaitUntil: Date.now() + 20_000, onOwnerWait: async blocker => { o.state.ownerWaits.push(blocker); fixtures.ownerClick('tiktok'); } });
        const outcome = await driver.publish(ctx, job, o);
        assert.equal(o.state.ownerWaits[0]?.code, 'caption_rejected');
        assert.deepEqual(outcome.kind === 'submitted' && outcome.submitted_by, 'owner', JSON.stringify(outcome));
        assert.equal(o.state.clicks, 0, 'the driver never clicked Post');
        assert.deepEqual([own()[0]?.options?.privacy_level, own()[0]?.options?.allow_comment], ['SELF_ONLY', true], 'not TikTok\'s carried-over Everyone');
      });

      test('WA-10: assist — the owner clicked Post and TikTok refused it → after_submit, not "not clicked"; the video stays', async () => {
        const { ctx, job } = await fresh('post_error_not_created');
        const o = opts({ mode: 'assist', onOwnerWait: async () => { o.ownerWaitUntil = Date.now() + 8000; fixtures.ownerClick('tiktok'); } });
        const outcome = await driver.publish(ctx, job, o);
        assert.deepEqual(outcome.kind === 'blocked' && [outcome.blocker.code, outcome.blocker.phase], ['platform_error', 'after_submit'], JSON.stringify(outcome));
        assert.ok(!fixtures.events().some(event => event.event === 'discarded'));
        assert.match(await lease.page.url(), /\/tiktokstudio\/upload/);
      });

      test('continue_dialog: "Post now" confirms the same publish; one post', async () => {
        const { ctx, job } = await fresh('continue_dialog');
        const o = opts();
        const outcome = await driver.publish(ctx, job, o);
        assert.equal(outcome.kind, 'submitted', JSON.stringify(outcome));
        assert.equal(o.state.clicks, 1);
        assert.equal(own().length, 1);
      });
    }
  });
}
}
