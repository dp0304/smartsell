// Adding a channel on this machine (§8.16): a new profile ch-<12 hex>, the
// platform page opened once, then a read-only identity probe every 3 s while
// the owner signs in (captcha and 2FA are the owner's). The caller shows
// "偵測到 X @handle，加入 SmartSell？" with the automation notice and only then
// calls registerEnrolledChannel().
import { randomBytes } from 'node:crypto';
import type { ChannelSelection } from '../../../connector/src/device-client.ts';
import { detectTikTok, detectX } from '../drivers/detect.ts';
import type { DriverRegistry } from '../drivers/registry.ts';
import type { SelectorStore } from '../drivers/selectors.ts';
import type { DriverContext } from '../drivers/types.ts';
import { AUTOMATION_NOTICE_VERSION, BLOCKER_POLL_MS } from './contracts.ts';
import type { Profiles } from './profiles.ts';
import type { HubApi } from './protocol.ts';

export interface EnrollDeps {
  profiles: Pick<Profiles, 'acquire'>;
  drivers: Pick<DriverRegistry, 'get'>;
  selectors: Pick<SelectorStore, 'table'>;
  platformUrl(provider: 'x' | 'tiktok', path: string): string;
  now?(): number;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface EnrolledChannel { provider: 'x' | 'tiktok'; profileKey: string; identity: string; handle: string | null; observedAt: string }

export const newProfileKey = () => `ch-${randomBytes(6).toString('hex')}`;

export async function enrollChannel(deps: EnrollDeps, provider: 'x' | 'tiktok', options: { signal?: AbortSignal; pollMs?: number; timeoutMs?: number; profileKey?: string; keepOpen?: boolean } = {}): Promise<EnrolledChannel> {
  const driver = deps.drivers.get(provider);
  if (!driver?.probeIdentity || !driver.enrollPath) throw new Error(`No enrollment for ${provider}`);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  const signal = options.signal ?? new AbortController().signal;
  const profileKey = options.profileKey ?? newProfileKey();
  const lease = await deps.profiles.acquire(profileKey, signal);
  lease.pin(true);
  try {
    const ctx: DriverContext = {
      page: lease.page, platformUrl: path => deps.platformUrl(provider, path), expectedIdentity: '', signal,
      evidence: async () => '', log: () => {}, now, sleep: ms => sleep(ms, signal), selectors: deps.selectors.table, mediaPaths: [],
      blockerPollMs: BLOCKER_POLL_MS, trace: [], messages: { machine: '', channel: provider, deadline: '' },
    };
    await lease.page.goto(ctx.platformUrl(driver.enrollPath));
    await lease.page.bringToFront();
    const deadline = now() + (options.timeoutMs ?? 10 * 60_000);
    let revisited = false;
    while (now() < deadline) {
      signal.throwIfAborted();
      const seen = await driver.probeIdentity(ctx);
      if (seen) return { provider, profileKey, identity: seen.identity, handle: seen.handle, observedAt: new Date(now()).toISOString() };
      // After the owner signed in, the platform may land elsewhere; open the identity page once more.
      if (!revisited && !(provider === 'x' ? await detectX(ctx) : await detectTikTok(ctx))) {
        const here = await lease.page.url();
        if (!here.includes(driver.enrollPath)) { revisited = true; await lease.page.goto(ctx.platformUrl(driver.enrollPath)); continue; }
      }
      await ctx.sleep(options.pollMs ?? 3000);
    }
    throw new Error('沒有在時限內偵測到登入的帳號。');
  } finally {
    lease.pin(!!options.keepOpen);
    lease.release();
  }
}

/** channels.register with the Phase 1 selection fields (§8.16 step 5). Call only after the owner pressed 加入. */
export async function registerEnrolledChannel(hub: Pick<HubApi, 'registerChannels'>, channel: EnrolledChannel, displayName?: string) {
  const selection: ChannelSelection = {
    kind: 'social', platform: channel.provider, external_id: channel.identity, observed_at: channel.observedAt,
    display_name: displayName ?? channel.handle ?? channel.identity, profile_key: channel.profileKey,
    ...(channel.handle && { handle: channel.handle }), automation_notice_version: AUTOMATION_NOTICE_VERSION,
  };
  return hub.registerChannels([selection]);
}
