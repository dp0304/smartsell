// Manual clock for runner tests: sleep() resolves only when advance() passes its deadline.
import type { ClockSource } from '../../../apps/connector-desktop/src/runtime/clock.ts';

interface Timer { at: number; resolve(): void; reject(reason: unknown): void; signal?: AbortSignal; abort?: () => void }

export class FakeTime implements ClockSource {
  #now: number;
  #timers: Timer[] = [];
  constructor(start = Date.parse('2026-11-25T00:00:00.000Z')) { this.#now = start; }

  now() { return this.#now; }
  get pending() { return this.#timers.length; }

  sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer: Timer = { at: this.#now + Math.max(0, ms), resolve, reject, signal };
      timer.abort = () => { this.#timers = this.#timers.filter(item => item !== timer); reject(signal!.reason); };
      signal?.addEventListener('abort', timer.abort, { once: true });
      this.#timers.push(timer);
    });
  }

  /** Lets queued promise chains and synchronous file IO settle. */
  async settle(rounds = 30) {
    for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve));
  }

  /** Advances time, firing every timer due on the way in order. */
  async advance(ms: number) {
    const target = this.#now + ms;
    await this.settle();
    while (true) {
      const due = this.#timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#timers = this.#timers.filter(timer => timer !== due);
      due.signal?.removeEventListener('abort', due.abort!);
      this.#now = Math.max(this.#now, due.at);
      due.resolve();
      await this.settle();
    }
    this.#now = target;
    await this.settle();
  }

  /** Jumps the wall clock without firing timers (sleep / suspend). */
  jump(ms: number) { this.#now += ms; }

  /** Advances in steps until `done()` is true or `maxMs` passes. */
  async until(done: () => boolean, maxMs: number, stepMs = 1000) {
    for (let spent = 0; spent <= maxMs; spent += stepMs) {
      if (done()) return true;
      await this.advance(stepMs);
    }
    return done();
  }
}
