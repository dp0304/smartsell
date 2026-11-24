// Harness for JobRunner unit tests: manual clock, scripted driver and hub,
// real JobStore on disk.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubClock } from '../../../apps/connector-desktop/src/runtime/clock.ts';
import { RuntimeEventBus, type LocalAlertEvent } from '../../../apps/connector-desktop/src/runtime/events.ts';
import { JobRunner, type RunnerSettings } from '../../../apps/connector-desktop/src/runtime/job-runner.ts';
import { JobStore } from '../../../apps/connector-desktop/src/runtime/job-store.ts';
import { HubError } from '../../../apps/connector-desktop/src/runtime/protocol.ts';
import { defaultSelectors } from '../../../apps/connector-desktop/src/drivers/selectors.ts';
import type { DriverBlocker, DriverContext, LoginState, PrepareResult, PublishDriver, PublishOptions, PublishOutcome, ReadBackHint, ReadBackResult } from '../../../apps/connector-desktop/src/drivers/types.ts';
import type { ClaimedJob, GoResponse, JobReport } from '../../../apps/connector-desktop/src/runtime/contracts.ts';
import { FakeCdpPage } from './fake-cdp-page.ts';
import { FakeTime } from './fake-time.ts';
import { makeClip, publishJob } from './driver-harness.ts';

export const T0 = Date.parse('2026-11-25T00:00:00.000Z');
export const MIN = 60_000;

export class ScriptedDriver implements PublishDriver {
  readonly provider: 'x' | 'tiktok' = 'x';
  readonly version = 'x@test';
  calls: string[] = [];
  clicks = 0;
  login: { state: LoginState; identity: string | null; handle: string | null; evidence_sha256: string[] } = { state: 'verified', identity: 'fixture_x', handle: 'fixture_x', evidence_sha256: [] };
  prepares: PrepareResult[] = [];
  readBacks: ReadBackResult[] = [];
  /** Every read-back hint the runner passed (WA-1: click time and the pre-click known ids). */
  readBackHints: ReadBackHint[] = [];
  ownerClicked = false;
  cleared = false;
  /** Override the whole publish step. */
  publishImpl?: (ctx: DriverContext, job: ClaimedJob, opts: PublishOptions) => Promise<PublishOutcome>;
  beforeClick?: () => void;
  lastOptions?: PublishOptions;

  async checkLogin() { this.calls.push('checkLogin'); return this.login; }
  async prepare() { this.calls.push('prepare'); return this.prepares.shift() ?? { ok: true as const, identity: 'fixture_x', handle: 'fixture_x' }; }
  async publish(ctx: DriverContext, job: ClaimedJob, opts: PublishOptions): Promise<PublishOutcome> {
    this.calls.push(`publish:${opts.mode}${opts.dryRun ? ':dry' : ''}`);
    this.lastOptions = opts;
    if (this.publishImpl) return this.publishImpl(ctx, job, opts);
    if (opts.dryRun) return { kind: 'dry_run_done', evidence_sha256: [await ctx.evidence('before_submit')] };
    if (opts.mode === 'assist') {
      const blocker: DriverBlocker = { code: 'owner_click_required', phase: 'before_submit', message: '' };
      await opts.onOwnerWait?.(blocker);
      while (ctx.now() < opts.ownerWaitUntil) {
        if (this.ownerClicked) return { kind: 'submitted', submitted_by: 'owner', hint: { url: 'https://x.com/fixture_x/status/77', external_post_id: '77' }, evidence_sha256: [] };
        if (opts.revoked()) { this.calls.push('discard'); return { kind: 'aborted' }; }
        await ctx.sleep(2000);
      }
      this.calls.push('discard');
      return { kind: 'blocked', blocker };
    }
    this.beforeClick?.();
    if (!await opts.onBeforeClick()) { this.calls.push('discard'); return { kind: 'aborted' }; }
    this.clicks += 1;
    this.calls.push('click');
    return { kind: 'submitted', submitted_by: 'auto', hint: { url: 'https://x.com/fixture_x/status/42', external_post_id: '42' }, evidence_sha256: [await ctx.evidence('after_submit')] };
  }
  async readBack(_ctx: DriverContext, _job: ClaimedJob, hint: ReadBackHint) {
    this.calls.push('readBack');
    this.readBackHints.push(hint);
    return this.readBacks.shift() ?? { kind: 'found' as const, url: 'https://x.com/fixture_x/status/42', external_post_id: '42', published_at: new Date(T0).toISOString() };
  }
  async detectBlocker() { return null; }
  async awaitBlockerCleared(ctx: DriverContext, _blocker: DriverBlocker, until: number) {
    this.calls.push('observe');
    while (!ctx.signal.aborted) {
      if (this.cleared) return true;
      if (ctx.now() + ctx.blockerPollMs > until) return false;
      try { await ctx.sleep(ctx.blockerPollMs); } catch { return false; }
    }
    return false;
  }
}

export type GoScript = GoResponse | HubError | ((call: number, body: { job_id: string; fencing_token: number }) => GoResponse | HubError);

export function runnerHarness(options: { settings?: Partial<RunnerSettings>; clockTrusted?: boolean; driver?: PublishDriver; page?: FakeCdpPage; start?: number; root?: string } = {}) {
  const time = new FakeTime(options.start ?? T0);
  const clock = new HubClock(time, 0);
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'smartsell-runner-'));
  const store = new JobStore(root);
  const events = new RuntimeEventBus();
  const alerts: LocalAlertEvent[] = [];
  events.on('local_alert', event => alerts.push(event));
  const clip = makeClip(root);
  const driver = (options.driver ?? new ScriptedDriver()) as ScriptedDriver;
  const page = options.page ?? new FakeCdpPage();
  const goCalls: number[] = [];
  const goJobs: string[] = [];
  let goScript: GoScript[] = [];
  let goDefault: GoScript = { go: true, mode: 'auto', server_time: new Date(T0).toISOString() };
  const hub = {
    async go(body: { job_id: string; fencing_token: number }) {
      goCalls.push(time.now());
      goJobs.push(body.job_id);
      const next = goScript.length ? goScript.shift()! : goDefault;
      const value = typeof next === 'function' ? next(goCalls.length, body) : next;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  let mediaError: Error | null = null;
  const media = {
    dir: join(root, 'media-cache'),
    async ensureAll() { if (mediaError) throw mediaError; return { 'file-1': clip.path }; },
    release(_id: string) {},
  };
  const logs: { message: string; detail?: object }[] = [];
  const pins: boolean[] = [];
  const profiles = {
    async acquire(profileKey: string) { return { profileKey, dir: root, page, pin: (on: boolean) => { pins.push(on); }, release() {} }; },
    closeIdle() {},
  };
  const outdated: string[] = [];
  const drivers = { get: () => driver, markOutdated: (_p: string, step?: string) => { outdated.push(step ?? ''); }, markHealthy() {} };
  let flushes = 0;
  const settings: RunnerSettings = {
    machineId: 'dev-mac-b', machineName: 'Mac-B', readbackScheduleSec: [30, 60, 120], blockerPollMs: 10_000,
    platformUrl: (provider, path) => `http://127.0.0.1:1/${provider}${path}`, goRetryMs: 5_000, log: (message, detail) => { logs.push({ message, detail }); },
    ...options.settings,
  };
  const make = () => new JobRunner({ store, hub, media, profiles, drivers, selectors: { table: defaultSelectors() }, time: clock, events,
    flushSoon: () => { flushes += 1; }, clockTrusted: () => options.clockTrusted ?? true, settings });
  const runner = make();
  return {
    time, clock, root, store, events, alerts, clip, driver, page, hub, goCalls, goJobs, pins, outdated, runner, settings, media, make, logs,
    get flushes() { return flushes; },
    setGo(script: GoScript[], fallback?: GoScript) { goScript = [...script]; if (fallback) goDefault = fallback; },
    failMedia(error: Error | null) { mediaError = error; },
    job(overrides: Partial<ClaimedJob> = {}, payload: Parameters<typeof publishJob>[2] = {}) {
      const notBefore = T0 + 2 * 3600_000;
      return publishJob('x', clip, { ...payload }, {
        not_before: new Date(notBefore).toISOString(), not_after: new Date(notBefore + 30 * MIN).toISOString(),
        lease_expires_at: new Date(notBefore + 45 * MIN).toISOString(), ...overrides,
      });
    },
    reports(jobId?: string): JobReport[] { return store.outbox().filter(entry => !jobId || entry.job_id === jobId).map(entry => entry.report); },
    events_(jobId?: string) { return this.reports(jobId).map(report => report.event); },
    /** Marks the last successful sync as now (what a heartbeat would do). */
    synced(at = time.now()) { store.updateState(state => { state.last_sync_at = new Date(at).toISOString(); }); },
    async cleanup() { await runner.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

export { HubError };
