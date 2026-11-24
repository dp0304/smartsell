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
import { chromeLauncher, Profiles, type BrowserLauncher } from './profiles.ts';
import { HubProtocol, type HubApi } from './protocol.ts';
import { Supervisor } from './supervisor.ts';

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
  const profiles = new Profiles({
    root: join(options.dataDir, 'chrome-profiles'), now: () => clock.now(),
    launch: options.launcher ?? chromeLauncher({ headless: options.headless, allowUrl: allowUrlFactory(switches.platformOrigins), sleep: ms => clock.sleep(ms) }),
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
    events, clock, store, hub, selectors, drivers, media, profiles, runner, supervisor: sup, platformUrl, switches,
    start() { runner.start(); void sup.start(); },
    async stop() { await sup.stop(); await runner.stop(); profiles.closeAll(); },
    emergencyStop() { runner.emergencyStop(); },
    resume() { runner.resumeAfterStop(); },
    snapshot() { return sup.snapshot(); },
  };
}

export type WorkerRuntime = ReturnType<typeof createWorkerRuntime>;
