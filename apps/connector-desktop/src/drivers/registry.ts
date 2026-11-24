// Driver registry (§8.1). Phase 1 ships browser drivers for X and TikTok only.
import type { DriverHealth } from '../runtime/contracts.ts';
import { TikTokDriver } from './tiktok.ts';
import type { DriverProvider, PublishDriver } from './types.ts';
import { XDriver } from './x.ts';

export class DriverRegistry {
  readonly #drivers = new Map<DriverProvider, PublishDriver>();
  readonly #health = new Map<DriverProvider, { health: DriverHealth['health']; step?: string }>();

  constructor(drivers: PublishDriver[] = [new XDriver(), new TikTokDriver()]) {
    for (const driver of drivers) this.#drivers.set(driver.provider, driver);
  }

  get(provider: string): PublishDriver | undefined {
    return this.#drivers.get(provider as DriverProvider);
  }

  /** driver_outdated marks the driver outdated until a later run of it succeeds (§8.11). */
  markOutdated(provider: DriverProvider, step?: string) { this.#health.set(provider, { health: 'outdated', step }); }
  markHealthy(provider: DriverProvider) { this.#health.set(provider, { health: 'ok' }); }

  /** Heartbeat drivers[]; a rejected selector download reports 'unknown' for every driver. */
  health(selectorHealth: 'ok' | 'unknown' = 'ok'): DriverHealth[] {
    return [...this.#drivers.values()].map(driver => {
      const state = this.#health.get(driver.provider) ?? { health: 'ok' as const };
      const health = state.health === 'outdated' ? 'outdated' : selectorHealth;
      return { provider: driver.provider, version: driver.version, health, ...(state.health === 'outdated' && state.step && { step: state.step }) };
    });
  }
}
