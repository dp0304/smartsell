import { setTimeout as pause } from 'node:timers/promises';
import type { ZhihuStatsResult } from '../../connector/src/device-client.ts';
import type { VisibleZhihu, ZhihuLoginDiagnostic, ZhihuProfileStep } from './zhihu-dom.ts';

type Manual = 'manual' | ZhihuLoginDiagnostic;

export interface ZhihuBrowser {
  openLogin(signal: AbortSignal): Promise<void>;
  checkLogin(signal: AbortSignal): Promise<'login_required' | 'signed_in' | Manual>;
  read(expected: string, signal: AbortSignal): Promise<ZhihuStatsResult | Manual>;
}

// Local-only access to a single connector-owned Zhihu tab. No remote URL, selector or script.
export interface ZhihuTab {
  open(signal: AbortSignal): Promise<void>;
  observe(signal: AbortSignal, slug?: string, menuOpened?: boolean, loginCheck?: boolean): Promise<VisibleZhihu>;
  click(step: ZhihuProfileStep, signal: AbortSignal, menuOpened?: boolean): Promise<boolean>;
}

function manual(kind: VisibleZhihu['kind']): Manual {
  switch (kind) {
    case 'challenge': case 'sign-in-unrecognized': case 'off-origin': case 'page-error': return kind;
    default: return 'manual';
  }
}

export class ZhihuChrome implements ZhihuBrowser {
  constructor(private readonly tab: ZhihuTab) {}

  openLogin(signal: AbortSignal) { return this.tab.open(signal); }

  async #wait(signal: AbortSignal, slug?: string, menuOpened = false, loginCheck = false) {
    let seen: VisibleZhihu = { kind: 'waiting' };
    for (let i = 0; i < 12; i++) {
      signal.throwIfAborted();
      seen = await this.tab.observe(signal, slug, menuOpened, loginCheck);
      signal.throwIfAborted();
      if (seen.kind !== 'waiting' && seen.kind !== 'sign-in-unrecognized') return seen;
      await pause(300, undefined, { signal });
    }
    return seen;
  }

  async checkLogin(signal: AbortSignal) {
    const seen = await this.#wait(signal, undefined, false, true);
    if (seen.kind === 'login-required') return 'login_required';
    if (seen.kind === 'signed-in') return 'signed_in';
    return manual(seen.kind);
  }

  async read(expected: string, signal: AbortSignal): Promise<ZhihuStatsResult | Manual> {
    let seen = await this.#wait(signal);
    let menuOpened = false;
    if (seen.kind === 'menu') {
      if (!await this.tab.click(seen, signal)) return 'manual';
      menuOpened = true;
      await pause(200, undefined, { signal });
      seen = await this.#wait(signal, undefined, menuOpened);
    }
    if (seen.kind === 'login-required') return { status: 'blocked', reason: 'login_required' };
    if (seen.kind === 'ambiguous') return { status: 'blocked', reason: 'unavailable' };
    if (seen.kind !== 'profile') return manual(seen.kind);
    if (seen.slug !== expected) return { status: 'blocked', reason: 'identity_mismatch' };
    if (!await this.tab.click(seen, signal, menuOpened)) return 'manual';
    const result = await this.#wait(signal, expected);
    if (result.kind === 'login-required') return { status: 'blocked', reason: 'login_required' };
    if (result.kind === 'mismatch') return { status: 'blocked', reason: 'identity_mismatch' };
    if (result.kind === 'ambiguous') return { status: 'blocked', reason: 'unavailable' };
    if (result.kind !== 'stats') return manual(result.kind);
    return { status: 'completed', profile_slug: expected, followers_text: result.followers, upvotes_text: result.upvotes };
  }
}
