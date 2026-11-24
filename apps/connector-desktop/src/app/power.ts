// Idle-sleep blocker (§8.2, §12.1 risk 9): while this Worker holds any
// non-terminal publish job, or the laptop App continues a handed-off upload
// (§6.3 step 9), keep the machine from idle sleep with
// powerSaveBlocker('prevent-app-suspension'). Closing the lid, manual sleep
// and power loss are not prevented; the machine page shows those risks.
import type { JobsHeldEvent } from '../runtime/events.ts';

export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export class PowerGuard {
  readonly #blocker: PowerSaveBlockerLike;
  readonly #reasons = new Set<string>();
  readonly #log?: (message: string, detail?: object) => void;
  #id: number | null = null;

  constructor(blocker: PowerSaveBlockerLike, log?: (message: string, detail?: object) => void) {
    this.#blocker = blocker;
    this.#log = log;
  }

  /** Adds or removes one reason; the blocker is held while at least one reason is active. */
  hold(reason: string, on: boolean) {
    if (on) this.#reasons.add(reason); else this.#reasons.delete(reason);
    this.#apply();
  }

  /** C11 `jobs_held`: hold while any publish job is not terminal. */
  onJobsHeld(event: JobsHeldEvent) { this.hold('publish_jobs', event.publish_jobs > 0); }

  active() { return this.#id !== null && this.#blocker.isStarted(this.#id); }

  reasons() { return [...this.#reasons].sort(); }

  release() { this.#reasons.clear(); this.#apply(); }

  #apply() {
    const want = this.#reasons.size > 0;
    if (want && (this.#id === null || !this.#blocker.isStarted(this.#id))) {
      this.#id = this.#blocker.start('prevent-app-suspension');
      this.#log?.('idle sleep blocked', { reasons: this.reasons() });
    } else if (!want && this.#id !== null) {
      if (this.#blocker.isStarted(this.#id)) this.#blocker.stop(this.#id);
      this.#id = null;
      this.#log?.('idle sleep allowed again');
    }
  }
}
