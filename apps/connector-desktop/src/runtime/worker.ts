// Composition root of the Worker runtime (S6). The Electron shell (S9) and the
// headless runner both call createWorkerRuntime(); nothing here imports
// Electron. Test-only switches are honoured only when SMARTSELL_TEST_MODE=1
// in an unpackaged build (§8.14).
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { DeviceProtocolClient } from '../../../connector/src/device-client.ts';
import { testModeEnabled } from '../chrome.ts';
import { DriverRegistry } from '../drivers/registry.ts';
import { SelectorStore } from '../drivers/selectors.ts';
import { BLOCKER_POLL_MS, READBACK_SCHEDULE_SEC, type DevicePosture, type RemoteAccess } from './contracts.ts';
import { HubClock, systemSource, type ClockSource } from './clock.ts';
import { RuntimeEventBus } from './events.ts';
import { JobRunner } from './job-runner.ts';
import { JobStore } from './job-store.ts';
import { MediaCache } from './media-cache.ts';
import { bridgeSocketPath, BrowserBridge } from '../browser-bridge/bridge.ts';
import { BrowserBindings, ownChromeLauncher } from '../browser-bridge/launcher.ts';
import type { ChromeCdpPage } from '../drivers/cdp-page.ts';
import { RemoteAgent } from '../remote/agent.ts';
import { systemAdb, type Adb } from '../remote/android.ts';
import { RemoteSessions } from '../remote/sessions.ts';
import { chromeLauncher, Profiles, type BrowserLauncher } from './profiles.ts';
import { HubProtocol, type HubApi } from './protocol.ts';
import { Supervisor } from './supervisor.ts';

export type BrowserMode = 'own_chrome' | 'profiles';

export interface WorkerIdentity { origin: string; workspaceId: string; deviceId: string; privateKey: string | KeyObject; machineName: string }

export interface TestSwitches {
  platformOrigins: Partial<Record<'x' | 'tiktok', string>> | null;
  prepareLeadMs?: number;
  readbackScheduleSec?: number[];
  offlineStalenessMs?: number;
  blockerPollMs?: number;
}

const PRODUCTION_ORIGINS: Record<'x' | 'tiktok', string> = { x: 'https://x.com', tiktok: 'https://www.tiktok.com' };
const PRODUCTION_HOSTS = new Set(['x.com', 'twitter.com', 'www.tiktok.com', 'tiktok.com']);

function seconds(value: string | undefined) {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid test duration ${value}`);
  return number * 1000;
}

/** Parses the SMARTSELL_TEST_* switches; returns empty switches outside test mode. */
export function testSwitches(env: NodeJS.ProcessEnv = process.env): TestSwitches {
  if (!testModeEnabled(env)) return { platformOrigins: null };
  let platformOrigins: TestSwitches['platformOrigins'] = null;
  if (env.SMARTSELL_TEST_PLATFORM_ORIGINS) {
    const parsed = JSON.parse(env.SMARTSELL_TEST_PLATFORM_ORIGINS) as Record<string, string>;
    platformOrigins = {};
    for (const provider of ['x', 'tiktok'] as const) {
      if (!parsed[provider]) continue;
      const url = new URL(parsed[provider]);
      // Fixture pages must be local: test mode can never reach a real platform.
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('SMARTSELL_TEST_PLATFORM_ORIGINS must point at loopback');
      platformOrigins[provider] = parsed[provider].replace(/\/$/, '');
    }
  }
  return {
    platformOrigins,
    prepareLeadMs: seconds(env.SMARTSELL_TEST_PREPARE_LEAD_SEC),
    readbackScheduleSec: env.SMARTSELL_TEST_READBACK_SCHEDULE_SEC ? env.SMARTSELL_TEST_READBACK_SCHEDULE_SEC.split(',').map(Number).filter(value => value > 0) : undefined,
    offlineStalenessMs: seconds(env.SMARTSELL_TEST_OFFLINE_STALENESS_SEC),
    blockerPollMs: seconds(env.SMARTSELL_TEST_BLOCKER_POLL_SEC),
  };
}

export function platformUrlFactory(origins: TestSwitches['platformOrigins']) {
  return (provider: 'x' | 'tiktok', path: string) => {
    const base = origins ? origins[provider] : PRODUCTION_ORIGINS[provider];
    if (!base) throw new Error(`No platform origin for ${provider} in test mode`);
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  };
}

/** Navigation allowlist: the real platforms in production, only the fixture origins in test mode. */
export function allowUrlFactory(origins: TestSwitches['platformOrigins']) {
  if (origins) {
    const allowed = Object.values(origins).map(origin => new URL(origin!).origin);
    return (url: URL) => allowed.includes(url.origin);
  }
  return (url: URL) => url.protocol === 'https:' && PRODUCTION_HOSTS.has(url.hostname);
}

export interface WorkerRuntimeOptions {
  dataDir: string;
  identity: WorkerIdentity;
  clientVersion: string;
  /** E9 heartbeat arch; defaults to process.arch. */
  arch?: string;
  headless?: boolean;
  env?: NodeJS.ProcessEnv;
  bundledClip?: string | null;
  localDryRun?: boolean;
  fetch?: typeof fetch;
  posture?: () => DevicePosture | null;
  remoteAccess?: () => RemoteAccess | null;
  events?: RuntimeEventBus;
  log?(message: string, detail?: object): void;
  /**
   * Where channels post (core-automation-proposal §3.2): 'own_chrome' works in the owner's own Chrome through the
   * SmartSell extension; 'profiles' (default) runs one separate Chrome profile per channel, as in phase 1.
   */
  browserMode?: BrowserMode;
  /** E50 phone remote control: scales and encodes phone screenshots (the App uses Electron's nativeImage). */
  encodePhone?(png: Buffer): Promise<{ mime: string; bytes: Buffer; width?: number }>;
  /** adb for phone remote control; default the `adb` on PATH. */
  adb?: Adb;
  /** Test seams. */
  hub?: HubApi;
  launcher?: BrowserLauncher;
  clockSource?: ClockSource;
  heartbeatMs?: number;
}

export function createWorkerRuntime(options: WorkerRuntimeOptions) {
  const env = options.env ?? process.env;
  const switches = testSwitches(env);
  const events = options.events ?? new RuntimeEventBus();
  const clock = new HubClock(options.clockSource ?? systemSource);
  const store = new JobStore(options.dataDir);
  const key = typeof options.identity.privateKey === 'string' ? createPrivateKey(options.identity.privateKey) : options.identity.privateKey;
  const hub: HubApi = options.hub ?? new HubProtocol(new DeviceProtocolClient({
    origin: options.identity.origin, workspaceId: options.identity.workspaceId, deviceId: options.identity.deviceId, key,
    now: () => clock.now(), localNow: () => clock.localNow(), fetch: options.fetch,
  }), clock);
  const selectors = new SelectorStore(join(options.dataDir, 'driver-config'));
  const drivers = new DriverRegistry();
  const media = new MediaCache({ dir: join(options.dataDir, 'media-cache'), open: (...args) => hub.openMedia(...args), now: () => clock.now(), bundledClip: options.bundledClip ?? null });
  const platformUrl = platformUrlFactory(switches.platformOrigins);
  const allowUrl = allowUrlFactory(switches.platformOrigins);
  const browserMode: BrowserMode = options.browserMode ?? 'profiles';
  const bridge = browserMode === 'own_chrome'
    ? new BrowserBridge({ socketPath: bridgeSocketPath(options.dataDir), now: () => clock.now(), log: options.log })
    : undefined;
  const profiles = new Profiles({
    root: join(options.dataDir, 'chrome-profiles'), now: () => clock.now(),
    launch: options.launcher ?? (bridge
      ? ownChromeLauncher({ bridge, bindings: BrowserBindings.in(options.dataDir), allowUrl, sleep: ms => clock.sleep(ms) })
      : chromeLauncher({ headless: options.headless, allowUrl, sleep: ms => clock.sleep(ms) })),
  });
  // E50 remote control: the owner's Agent looks at and acts on this machine's own Chrome (own-Chrome mode) or phone.
  let remoteSessions: RemoteSessions | undefined;
  const remote: RemoteAgent = new RemoteAgent({
    hub, adb: options.adb ?? systemAdb(), encodePhone: options.encodePhone, log: options.log, sleep: (ms, signal) => clock.sleep(ms, signal),
    browserReady: () => (bridge?.browsers().length ?? 0) > 0,
    browser: (settings): RemoteSessions | undefined => {
      if (!bridge) return undefined;
      remoteSessions ??= new RemoteSessions({
        sites: (): readonly string[] => remote.settings?.browser.sites ?? settings.browser.sites,
        // Fixture pages are plain http on loopback; only in test mode (§8.14).
        allowLoopbackHttp: switches.platformOrigins !== null, sleep: ms => clock.sleep(ms),
        openPage: async () => {
          const launch = ownChromeLauncher({ bridge, bindings: BrowserBindings.in(options.dataDir), allowUrl: url => remoteSessions!.allowed(url), sleep: ms => clock.sleep(ms) });
          return await launch(join(options.dataDir, 'chrome-profiles', 'remote-control')).openPage() as ChromeCdpPage;
        },
      });
      return remoteSessions;
    },
  });
  let supervisor: Supervisor | undefined;
  const runner = new JobRunner({
    store, hub, media, profiles, drivers, selectors, time: clock, events,
    flushSoon: () => supervisor?.flushSoon(),
    clockTrusted: () => clock.trustedForOffline(120_000),
    settings: {
      machineId: options.identity.deviceId, machineName: options.identity.machineName,
      prepareLeadMs: switches.prepareLeadMs, offlineStalenessMs: switches.offlineStalenessMs,
      readbackScheduleSec: switches.readbackScheduleSec ?? READBACK_SCHEDULE_SEC,
      blockerPollMs: switches.blockerPollMs ?? BLOCKER_POLL_MS,
      localDryRun: options.localDryRun, platformUrl, log: options.log,
    },
  });
  supervisor = new Supervisor({
    hub, store, runner, clock, events, drivers, selectors, profiles, clientVersion: options.clientVersion, arch: options.arch,
    heartbeatMs: options.heartbeatMs, posture: options.posture, remoteAccess: options.remoteAccess, log: options.log,
  });
  const sup = supervisor;
  return {
    events, clock, store, hub, selectors, drivers, media, profiles, runner, supervisor: sup, platformUrl, switches, browserMode, bridge, remote,
    /** Own-Chrome mode: open the socket the extension's native host connects to (idempotent). */
    async listenBridge() { await bridge?.listen(); },
    start() {
      void bridge?.listen().catch(error => options.log?.('browser bridge failed to start', { error: String(error) }));
      runner.start(); void sup.start(); remote.start();
    },
    async stop() { await remote.stop(); await remoteSessions?.closeAll(); await sup.stop(); await runner.stop(); profiles.closeAll(); await bridge?.close(); },
    emergencyStop() { runner.emergencyStop(); },
    resume() { runner.resumeAfterStop(); },
    snapshot() { return sup.snapshot(); },
  };
}

export type WorkerRuntime = ReturnType<typeof createWorkerRuntime>;
