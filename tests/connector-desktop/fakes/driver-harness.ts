// Shared harness for running the real drivers against the fixture pages in
// headless Chrome (only when Google Chrome is installed).
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from '../../../apps/connector-desktop/src/chrome.ts';
import { bridgeSocketPath, BrowserBridge } from '../../../apps/connector-desktop/src/browser-bridge/bridge.ts';
import { BrowserBindings, ownChromeLauncher } from '../../../apps/connector-desktop/src/browser-bridge/launcher.ts';
import { chromeLauncher, Profiles, type BrowserLauncher } from '../../../apps/connector-desktop/src/runtime/profiles.ts';
import { launchOwnerChrome, type OwnerChrome } from '../own-chrome-browser.ts';
import { allowUrlFactory, platformUrlFactory } from '../../../apps/connector-desktop/src/runtime/worker.ts';
import { defaultSelectors } from '../../../apps/connector-desktop/src/drivers/selectors.ts';
import type { DriverContext, CdpPage } from '../../../apps/connector-desktop/src/drivers/types.ts';
import type { ClaimedJob, PublishPostPayload } from '../../../apps/connector-desktop/src/runtime/contracts.ts';
import type { PlatformFixtures } from '../../fixtures/platforms/server.ts';

export async function chromePath() { return findChrome(); }

/** Synchronous lookup (test files decide skip at load time). */
export function chromePathSync(): string | undefined {
  const candidates = [process.env.SMARTSELL_CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe')];
  return candidates.find((path): path is string => !!path && existsSync(path));
}

/** A small file with an MP4 header; the fixture pages only hash it. */
export function makeClip(dir: string, name = 'video.mp4', size = 64 * 1024) {
  const bytes = Buffer.alloc(size);
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(bytes);
  for (let index = 16; index < size; index++) bytes[index] = (index * 31) & 0xff;
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: size };
}

export function publishJob(provider: 'x' | 'tiktok', clip: { sha256: string; bytes: number }, overrides: Partial<PublishPostPayload> = {}, job: Partial<ClaimedJob> = {}): ClaimedJob {
  const now = Date.now();
  const payload: PublishPostPayload = {
    schema: 'smartsell.worker.publish.v1', provider,
    channel: provider === 'x'
      ? { social_account_id: 'acct-x', handle: 'fixture_x', display_name: 'Fixture X', profile_key: 'ch-aaaaaaaaaaaa', expected_identity: 'fixture_x' }
      : { social_account_id: 'acct-tt', handle: 'fixture_tt', display_name: 'Fixture TT', profile_key: 'ch-bbbbbbbbbbbb', expected_identity: '7234567890123456789' },
    caption: { text: 'New lure test 🎣 #fishing #lure', title: null },
    media: [{ file_id: 'file-1', sha256: clip.sha256, bytes: clip.bytes, mime: 'video/mp4', filename: 'video.mp4', kind: 'video', duration_ms: 21000, width: 1080, height: 1920 }],
    options: provider === 'x' ? { x: { reply_settings: 'everyone' } }
      : { tiktok: { privacy_level: 'SELF_ONLY', allow_comment: true, allow_duet: false, allow_stitch: false, commercial_disclosure: 'none', ai_generated: false } },
    publish_target_id: 'target-1', execution_task_id: 'task-1', approval_request_id: null, frozen_hash: 'hash',
    scheduled_at: new Date(now).toISOString(), timezone: 'Asia/Shanghai', limits: { window: null, daily_cap: 10 }, ...overrides,
  };
  return {
    job_id: `job-${Math.random().toString(16).slice(2, 10)}`, kind: 'publish_post', fencing_token: 1, mode: 'auto', dry_run: false,
    not_before: new Date(now).toISOString(), not_after: new Date(now + 30 * 60_000).toISOString(), lease_expires_at: new Date(now + 45 * 60_000).toISOString(),
    prepare_lead_min: 30, offline_go_max_staleness_min: 30, payload_hash: 'payload', payload, ...job,
  };
}

/** How the harness reaches Chrome: the Worker's own Chrome over the CDP pipe, or the owner's Chrome through the extension. */
export type Transport = 'pipe' | 'own_chrome';

export class ChromeHarness {
  readonly dir: string;
  readonly profiles: Profiles;
  readonly platformUrl: (provider: 'x' | 'tiktok', path: string) => string;
  evidence: { label: string; bytes: number }[] = [];
  bridge?: BrowserBridge;
  owner?: OwnerChrome;
  constructor(readonly fixtures: PlatformFixtures, readonly executable: string, launcher?: (allowUrl: (url: URL) => boolean, dir: string) => BrowserLauncher, dir?: string) {
    this.dir = dir ?? mkdtempSync(join(tmpdir(), 'smartsell-driver-'));
    const origins = fixtures.origins;
    this.platformUrl = platformUrlFactory(origins);
    const allowUrl = allowUrlFactory(origins);
    this.profiles = new Profiles({ root: join(this.dir, 'chrome-profiles'), launch: launcher?.(allowUrl, this.dir) ?? chromeLauncher({
      headless: true, allowUrl, sleep: ms => new Promise(done => setTimeout(done, ms)), executable: async () => executable,
    }) });
  }

  /** The same harness over the SmartSell extension in a stand-in for the owner's Chrome (Playwright Chromium). */
  static async ownChrome(fixtures: PlatformFixtures): Promise<ChromeHarness> {
    const dir = mkdtempSync(join(tmpdir(), 'ss-own-'));
    const bridge = new BrowserBridge({ socketPath: bridgeSocketPath(dir) });
    await bridge.listen();
    const harness = new ChromeHarness(fixtures, '', (allowUrl, root) => ownChromeLauncher({
      bridge, bindings: BrowserBindings.in(root), allowUrl, sleep: ms => new Promise(done => setTimeout(done, ms)), connectWaitMs: 30_000,
    }), dir);
    harness.bridge = bridge;
    harness.owner = await launchOwnerChrome(dir);
    if (!await bridge.waitForBrowser(30_000)) throw new Error('The SmartSell extension did not connect to the bridge');
    return harness;
  }

  static async create(transport: Transport, fixtures: PlatformFixtures, executable: string | undefined) {
    return transport === 'own_chrome' ? ChromeHarness.ownChrome(fixtures) : new ChromeHarness(fixtures, executable!);
  }

  context(provider: 'x' | 'tiktok', page: CdpPage, expected: string, mediaPaths: string[], extra: Partial<DriverContext> = {}): DriverContext {
    return {
      page, platformUrl: path => this.platformUrl(provider, path), expectedIdentity: expected, signal: new AbortController().signal,
      evidence: async label => { const shot = await page.screenshot({ quality: 70 }); this.evidence.push({ label, bytes: shot.length }); return createHash('sha256').update(shot).digest('hex'); },
      log: () => {}, now: () => Date.now(), sleep: ms => new Promise(done => setTimeout(done, ms)), selectors: defaultSelectors(), mediaPaths,
      blockerPollMs: 500, trace: [], messages: { machine: 'Mac-B', channel: provider === 'x' ? 'X @fixture_x' : 'TikTok @fixture_tt', deadline: '09:30' }, ...extra,
    };
  }

  async close() {
    this.profiles.closeAll();
    await this.owner?.close();
    await this.bridge?.close();
    // Chrome keeps writing to the profile for a moment after Browser.close.
    await new Promise(done => setTimeout(done, 800));
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
