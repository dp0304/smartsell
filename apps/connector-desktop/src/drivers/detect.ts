// Shared blocker detection (§8.10). Strictly read-only: it reads the URL, the
// iframe sources, a few elements and the visible text. It never clicks,
// navigates, reloads or touches a captcha or challenge page.
import type { BlockerCode } from '../runtime/contracts.ts';
import { blockerMessage } from './messages.ts';
import { findStep, patternOf } from './selectors.ts';
import type { DriverBlocker, DriverContext } from './types.ts';

export interface Detection { code: BlockerCode; url: string }

function pathOfUrl(url: string) {
  try { const parsed = new URL(url); return parsed.pathname + parsed.search + parsed.hash; } catch { return url; }
}

export async function detectX(ctx: DriverContext): Promise<Detection | null> {
  const { page, selectors: table } = ctx;
  const url = await page.url().catch(() => '');
  const path = pathOfUrl(url);
  const frames = await page.frameSources();
  if (frames.some(src => patternOf(table, 'x', 'captcha_frame').test(src)) || (await findStep(page, table, 'x', 'x.arkose')).length) return { code: 'captcha', url };
  const text = await page.bodyText();
  if (patternOf(table, 'x', 'flow_url').test(path) && patternOf(table, 'x', 'two_factor_text').test(text)) return { code: 'two_factor', url };
  if (patternOf(table, 'x', 'login_url').test(path) || (await findStep(page, table, 'x', 'x.login_button')).length) return { code: 'login_expired', url };
  if (patternOf(table, 'x', 'risk_url').test(path) || patternOf(table, 'x', 'risk_text').test(text)) return { code: 'risk_prompt', url };
  if (patternOf(table, 'x', 'error_text').test(text)) return { code: 'platform_error', url };
  return null;
}

export async function detectTikTok(ctx: DriverContext): Promise<Detection | null> {
  const { page, selectors: table } = ctx;
  const url = await page.url().catch(() => '');
  const path = pathOfUrl(url);
  const frames = await page.frameSources();
  if (frames.some(src => patternOf(table, 'tiktok', 'captcha_frame').test(src)) || (await findStep(page, table, 'tiktok', 'tt.captcha')).length) return { code: 'captcha', url };
  if (patternOf(table, 'tiktok', 'two_factor_url').test(path)) return { code: 'two_factor', url };
  if (patternOf(table, 'tiktok', 'login_url').test(path)) return { code: 'login_expired', url };
  const text = await page.bodyText();
  if (patternOf(table, 'tiktok', 'risk_text').test(text)) return { code: 'risk_prompt', url };
  if (patternOf(table, 'tiktok', 'error_text').test(text)) return { code: 'platform_error', url };
  return null;
}

/** Screenshot first, then build the blocker with its zh-Hant message. */
export async function toBlocker(ctx: DriverContext, code: BlockerCode, phase: DriverBlocker['phase'], extra: { url?: string; step?: string; platform_message?: string; ax_hash?: string } = {}): Promise<DriverBlocker> {
  let evidence: string[] = [];
  try { evidence = [await ctx.evidence(`blocker_${code}`)]; } catch { /* A failed screenshot never hides the blocker. */ }
  return {
    code, phase, message: blockerMessage(code, { ...ctx.messages, step: extra.step, platform_message: extra.platform_message }, phase),
    ...(extra.step && { step: extra.step }), ...(extra.url && { url: extra.url }), ...(extra.ax_hash && { ax_hash: extra.ax_hash }),
    evidence_sha256: evidence,
  };
}

/**
 * Read-only observation of the same tab (§5.9): every `ctx.blockerPollMs` it re-runs
 * detection (and, for identity mismatches, the identity probe). No navigation,
 * no reload, no clicks. Resolves true once the blocker is gone.
 */
export async function observeUntilCleared(ctx: DriverContext, until: number, stillBlocked: () => Promise<boolean>): Promise<boolean> {
  while (!ctx.signal.aborted) {
    if (!await stillBlocked()) return true;
    if (ctx.now() + ctx.blockerPollMs > until) return false;
    try { await ctx.sleep(ctx.blockerPollMs); } catch { return false; }
  }
  return false;
}
