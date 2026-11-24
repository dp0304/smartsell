// Small helpers shared by the X and TikTok drivers: state-based waits (never a
// fixed delay to "look human"), step tracing and text normalisation.
import { findStep, type Found } from './selectors.ts';
import { DriverAbort, type DriverContext, type NodeRef } from './types.ts';

export const POLL_MS = 250;
/**
 * WA-1: read-back accepts only posts created after the click. Platform times are compared with the hub-corrected click
 * time, so a minute-precision row time and a small clock difference must still pass; an older post must not.
 */
export const READBACK_CLICK_SKEW_MS = 60_000;

export function normalize(text: string) {
  return text.replace(/[ ​‌‍﻿]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function checkAbort(ctx: DriverContext) {
  if (ctx.signal.aborted) throw new DriverAbort();
}

/** Polls `probe` every 250 ms until it returns a value or the timeout passes. */
export async function pollUntil<T>(ctx: DriverContext, probe: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = POLL_MS): Promise<T | null> {
  const deadline = ctx.now() + timeoutMs;
  while (true) {
    checkAbort(ctx);
    const value = await probe();
    if (value) return value;
    if (ctx.now() >= deadline) return null;
    try { await ctx.sleep(Math.min(intervalMs, Math.max(1, deadline - ctx.now()))); } catch { throw new DriverAbort(); }
  }
}

export function record(ctx: DriverContext, step: string, startedAt: number, matched: 'primary' | 'fallback' | 'none') {
  ctx.trace.push({ step, ms: Math.max(0, Math.round(ctx.now() - startedAt)), matched });
}

/** Waits for a selector step and records which selector matched in driver_trace. */
export async function waitStep(ctx: DriverContext, provider: 'x' | 'tiktok', step: string, timeoutMs: number,
  options: { within?: NodeRef; accept?: (found: Found[]) => Promise<Found[] | null> | Found[] | null } = {}): Promise<Found[]> {
  const started = ctx.now();
  const found = await pollUntil(ctx, async () => {
    const result = await findStep(ctx.page, ctx.selectors, provider, step, options.within);
    if (!result.length) return null;
    const accepted = options.accept ? await options.accept(result) : result;
    return accepted && accepted.length ? accepted : null;
  }, timeoutMs);
  record(ctx, step, started, found ? found[0].matched : 'none');
  return found ?? [];
}

/** Types multi-line text: insertText per line, Enter between lines (§8.7). */
export async function insertLines(ctx: DriverContext, text: string) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    checkAbort(ctx);
    if (index > 0) await ctx.page.press('Enter');
    if (lines[index]) await ctx.page.insertText(lines[index]);
  }
}

export async function enabled(ctx: DriverContext, node: NodeRef) {
  const aria = await ctx.page.attribute(node, 'aria-disabled').catch(() => 'true');
  const data = await ctx.page.attribute(node, 'data-disabled').catch(() => null);
  const disabled = await ctx.page.attribute(node, 'disabled').catch(() => null);
  return aria !== 'true' && data !== 'true' && disabled === null;
}

export function selectAllModifier(): 'Meta' | 'Control' { return process.platform === 'darwin' ? 'Meta' : 'Control'; }

export function parseJson(body: string | null): Record<string, unknown> | null {
  if (!body) return null;
  try { const value = JSON.parse(body); return value && typeof value === 'object' ? value as Record<string, unknown> : null; } catch { return null; }
}
